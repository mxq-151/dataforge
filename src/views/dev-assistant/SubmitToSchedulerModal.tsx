import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { X, Send, Loader2, FolderKanban, GitBranch, CheckCircle, AlertTriangle, Shield, Database, Info } from 'lucide-react';
import type { DolphinSchedulerApi, DSProject, DSWorkflowDefinition, DSTaskType, DSDataSource, DSWorkerGroup, DSEnvironment, DSWorkflowTaskNode } from '../../types/dolphinscheduler';
import { TASK_TYPE_LABELS, ReleaseState, Priority, parseReleaseState } from '../../types/dolphinscheduler';
import type { CodeFileMapping, SavedConfig, ValidationError } from '../../utils/schedulerMapping';
import { buildWorkflowFromCodeFile, validateSubmission, getAvailableTaskTypes, mapCodeFileToTask, sanitizeDsName, validateYarnJobName } from '../../utils/schedulerMapping';
import { type CompileResult } from '../../services/compileService';
import { unifiedCompile } from '../../services/unifiedCompile';
import { validateFileHeader } from '../../utils/index';
import { splitPath, getBaseName } from '../../utils/pathUtils';
import './SubmitToSchedulerModal.css';

interface CompileConfig {
  javaHome: string;
  scalaHome: string;
  mavenHome: string;
  scalaVersion?: string;
  pomTemplate?: string;
  workspace?: string;
  mavenGroupId?: string;
  mavenArtifactId?: string;
}

interface SubmitToSchedulerModalProps {
  visible: boolean;
  fileName: string;
  codeContent: string;
  mapping: CodeFileMapping | null;
  savedConfig: SavedConfig | null;
  filePath?: string;
  rootPath?: string;
  projectCode?: string;
  devProjectId?: number;
  dsApi: DolphinSchedulerApi | null;
  isRealApi: boolean;
  compileConfig?: CompileConfig | null;
  openlineageTransportUrl?: string;
  onClose: () => void;
  onSuccess: (projectName: string, workflowName: string) => void;
}

type SubmitStep = 'config' | 'validating' | 'submitting' | 'success' | 'error';

const SubmitToSchedulerModal: React.FC<SubmitToSchedulerModalProps> = ({
  visible,
  fileName,
  codeContent,
  mapping: initialMapping,
  savedConfig,
  filePath,
  rootPath,
  projectCode,
  devProjectId,
  dsApi,
  isRealApi,
  compileConfig,
  openlineageTransportUrl,
  onClose,
  onSuccess,
}) => {
  const [step, setStep] = useState<SubmitStep>('config');
  const [projects, setProjects] = useState<DSProject[]>([]);
  const [selectedProjectCode, setSelectedProjectCode] = useState<number | null>(null);
  const [workflows, setWorkflows] = useState<DSWorkflowDefinition[]>([]);
  const [selectedWorkflowCode, setSelectedWorkflowCode] = useState<number | null>(null);
  const [workflowName, setWorkflowName] = useState('');
  const [workflowDesc, setWorkflowDesc] = useState('');
  const [autoOnline, setAutoOnline] = useState(false);
  const [autoTrigger, setAutoTrigger] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successInfo, setSuccessInfo] = useState<{ projectName: string; workflowName: string } | null>(null);
  const [selectedTaskType, setSelectedTaskType] = useState<DSTaskType | null>(null);
  const [validationErrors, setValidationErrors] = useState<ValidationError[]>([]);
  const [showValidation, setShowValidation] = useState(false);
  const [validationPassed, setValidationPassed] = useState(false);
  void validationPassed;
  const [compiledJarPath, setCompiledJarPath] = useState<string | null>(null);
  const [isCompiling, setIsCompiling] = useState(false);
  const [compileResult, setCompileResult] = useState<CompileResult | null>(null);
  const [dsDataSources, setDsDataSources] = useState<DSDataSource[]>([]);
  const [selectedDatasourceId, setSelectedDatasourceId] = useState<number | null>(null);
  const [workerGroups, setWorkerGroups] = useState<DSWorkerGroup[]>([]);
  const [selectedWorkerGroup, setSelectedWorkerGroup] = useState<string>('default');
  const [envList, setEnvList] = useState<DSEnvironment[]>([]);
  const [selectedEnvironmentCode, setSelectedEnvironmentCode] = useState<number>(-1);
  const [workflowNameCheck, setWorkflowNameCheck] = useState<{ exists: boolean; isOnline: boolean; workflowCode?: number } | null>(null);
  const [taskNameCheck, setTaskNameCheck] = useState<{ exists: boolean; workflowName: string } | null>(null);
  const [isCheckingName, setIsCheckingName] = useState(false);
  const workflowCheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const TASK_TYPE_PARAMS_CONFIG: Record<string, {
    label: string;
    params: { key: string; label: string; type: 'text' | 'number' | 'select' | 'checkbox' | 'textarea'; default?: string | number | boolean; options?: { value: string; label: string }[]; unit?: string; placeholder?: string }[];
  }> = {
    SQL: {
      label: 'SQL 配置',
      params: [
        { key: 'type', label: '数据源类型', type: 'select', default: 'MYSQL', options: [
          { value: 'MYSQL', label: 'MYSQL' }, { value: 'POSTGRESQL', label: 'POSTGRESQL' },
          { value: 'HIVE', label: 'HIVE' }, { value: 'SPARK', label: 'SPARK' },
          { value: 'CLICKHOUSE', label: 'CLICKHOUSE' }, { value: 'ORACLE', label: 'ORACLE' },
          { value: 'SQLSERVER', label: 'SQLSERVER' }, { value: 'DB2', label: 'DB2' },
          { value: 'PRESTO', label: 'PRESTO' },
        ]},
        { key: 'sqlType', label: 'SQL类型', type: 'select', default: '0', options: [
          { value: '0', label: '查询' }, { value: '1', label: '非查询' },
        ]},
        { key: 'displayRows', label: '显示行数', type: 'number', default: 10 },
        { key: 'connParams', label: '连接参数', type: 'text', placeholder: 'Hive连接参数' },
      ],
    },
    SPARK: {
      label: 'Spark 配置',
      params: [
        { key: 'programType', label: '程序类型', type: 'select', default: 'SCALA', options: [
          { value: 'JAVA', label: 'JAVA' }, { value: 'SCALA', label: 'SCALA' },
          { value: 'PYTHON', label: 'PYTHON' }, { value: 'SQL', label: 'SQL' },
        ]},
        { key: 'mainClass', label: '主Class', type: 'text', placeholder: 'com.example.MainClass' },
        { key: 'mainJar', label: '主Jar包', type: 'text', placeholder: '编译后自动填入' },
        { key: 'deployMode', label: '部署模式', type: 'select', default: 'cluster', options: [
          { value: 'cluster', label: 'cluster' }, { value: 'client', label: 'client' }, { value: 'local', label: 'local' },
        ]},
        { key: 'driverCores', label: 'Driver核心数', type: 'number', default: 1 },
        { key: 'driverMemory', label: 'Driver内存', type: 'text', default: '1G', unit: '如: 512M, 1G, 2G' },
        { key: 'numExecutors', label: 'Executor数量', type: 'number', default: 2 },
        { key: 'executorMemory', label: 'Executor内存', type: 'text', default: '2G', unit: '如: 1G, 2G, 4G' },
        { key: 'executorCores', label: 'Executor核心数', type: 'number', default: 2 },
        { key: 'appName', label: '应用名称', type: 'text', placeholder: 'Spark Application' },
        { key: 'mainArgs', label: '主参数', type: 'textarea', placeholder: '程序运行参数' },
        { key: 'yarnQueue', label: 'YARN队列', type: 'text', default: 'default' },
        { key: 'others', label: '其他参数', type: 'textarea', placeholder: '--conf spark.xxx=yyy' },
      ],
    },
    FLINK: {
      label: 'Flink 配置',
      params: [
        { key: 'programType', label: '程序类型', type: 'select', default: 'SCALA', options: [
          { value: 'JAVA', label: 'JAVA' }, { value: 'SCALA', label: 'SCALA' },
          { value: 'PYTHON', label: 'PYTHON' }, { value: 'SQL', label: 'SQL' },
        ]},
        { key: 'mainClass', label: '主Class', type: 'text', placeholder: 'com.example.MainClass' },
        { key: 'mainJar', label: '主Jar包', type: 'text', placeholder: '编译后自动填入' },
        { key: 'flinkVersion', label: 'Flink版本', type: 'select', default: '<1.10', options: [
          { value: '<1.10', label: '<1.10' }, { value: '1.10-1.12', label: '1.10-1.12' }, { value: '>=1.12', label: '>=1.12' },
        ]},
        { key: 'deployMode', label: '部署模式', type: 'select', default: 'cluster', options: [
          { value: 'cluster', label: 'cluster' }, { value: 'application', label: 'application' }, { value: 'local', label: 'local' },
        ]},
        { key: 'jobManagerMemory', label: 'JobManager内存', type: 'text', default: '1G' },
        { key: 'taskManagerMemory', label: 'TaskManager内存', type: 'text', default: '2G' },
        { key: 'slot', label: 'Slot数', type: 'number', default: 1 },
        { key: 'taskManager', label: 'TaskManager数', type: 'number', default: 2 },
        { key: 'parallelism', label: '并行度', type: 'number', default: 1 },
        { key: 'appName', label: '应用名称', type: 'text', placeholder: 'Flink Application' },
        { key: 'mainArgs', label: '主参数', type: 'textarea', placeholder: '程序运行参数' },
        { key: 'yarnQueue', label: 'YARN队列', type: 'text', default: 'default' },
        { key: 'others', label: '其他参数', type: 'textarea', placeholder: '-Dkey=value' },
      ],
    },
    FLINK_STREAM: {
      label: 'Flink Stream 配置',
      params: [
        { key: 'programType', label: '程序类型', type: 'select', default: 'SCALA', options: [
          { value: 'JAVA', label: 'JAVA' }, { value: 'SCALA', label: 'SCALA' }, { value: 'PYTHON', label: 'PYTHON' },
        ]},
        { key: 'flinkVersion', label: 'Flink版本', type: 'select', default: '<1.10', options: [
          { value: '<1.10', label: '<1.10' }, { value: '1.10-1.12', label: '1.10-1.12' }, { value: '>=1.12', label: '>=1.12' },
        ]},
        { key: 'deployMode', label: '部署模式', type: 'select', default: 'cluster', options: [
          { value: 'cluster', label: 'cluster' }, { value: 'local', label: 'local' }, { value: 'standalone', label: 'standalone' },
        ]},
        { key: 'jobManagerMemory', label: 'JobManager内存', type: 'text', default: '1G' },
        { key: 'taskManagerMemory', label: 'TaskManager内存', type: 'text', default: '2G' },
        { key: 'slot', label: 'Slot数', type: 'number', default: 1 },
        { key: 'taskManager', label: 'TaskManager数', type: 'number', default: 2 },
        { key: 'parallelism', label: '并行度', type: 'number', default: 1 },
        { key: 'yarnQueue', label: 'YARN队列', type: 'text', default: 'default' },
      ],
    },
    MR: {
      label: 'MapReduce 配置',
      params: [
        { key: 'programType', label: '程序类型', type: 'select', default: 'JAVA', options: [
          { value: 'JAVA', label: 'JAVA' }, { value: 'SCALA', label: 'SCALA' }, { value: 'PYTHON', label: 'PYTHON' },
        ]},
        { key: 'mainClass', label: '主Class', type: 'text', placeholder: 'com.example.MainClass' },
        { key: 'mainJar', label: '主Jar包', type: 'text', placeholder: '编译后自动填入' },
        { key: 'appName', label: '应用名称', type: 'text', placeholder: 'MapReduce Application' },
        { key: 'mainArgs', label: '主参数', type: 'textarea', placeholder: '程序运行参数' },
        { key: 'yarnQueue', label: 'YARN队列', type: 'text', default: 'default' },
        { key: 'others', label: '其他参数', type: 'textarea', placeholder: '-Dmapred.xxx=yyy' },
      ],
    },
    PYTHON: {
      label: 'Python 运行时参数',
      params: [
        { key: 'cpuQuota', label: 'CPU配额', type: 'number', default: -1, unit: '-1表示不限制' },
        { key: 'memoryMax', label: '最大内存(MB)', type: 'number', default: -1, unit: '-1表示不限制' },
      ],
    },
    SHELL: {
      label: 'Shell 运行时参数',
      params: [
        { key: 'cpuQuota', label: 'CPU配额', type: 'number', default: -1, unit: '-1表示不限制' },
        { key: 'memoryMax', label: '最大内存(MB)', type: 'number', default: -1, unit: '-1表示不限制' },
      ],
    },
    JAVA: {
      label: 'Java 配置',
      params: [
        { key: 'runType', label: '运行类型', type: 'select', default: 'FAT_JAR', options: [
          { value: 'FAT_JAR', label: 'FAT_JAR' }, { value: 'NORMAL_JAR', label: 'NORMAL_JAR' },
        ]},
        { key: 'mainClass', label: '主Class', type: 'text', placeholder: 'com.example.MainClass' },
        { key: 'mainJar', label: '主Jar包', type: 'text', placeholder: '编译后自动填入' },
        { key: 'mainArgs', label: '主参数', type: 'textarea', placeholder: '程序运行参数' },
        { key: 'jvmArgs', label: 'JVM参数', type: 'textarea', placeholder: '-Xmx4g -Xms1g' },
      ],
    },
    HTTP: {
      label: 'HTTP 配置',
      params: [
        { key: 'url', label: '请求地址', type: 'text', placeholder: 'http://example.com/api' },
        { key: 'httpMethod', label: '请求类型', type: 'select', default: 'GET', options: [
          { value: 'GET', label: 'GET' }, { value: 'POST', label: 'POST' }, { value: 'PUT', label: 'PUT' }, { value: 'DELETE', label: 'DELETE' },
        ]},
        { key: 'httpCheckCondition', label: '校验条件', type: 'select', default: 'STATUS_CODE_DEFAULT', options: [
          { value: 'STATUS_CODE_DEFAULT', label: '状态码默认(200)' }, { value: 'STATUS_CODE_CUSTOM', label: '状态码自定义' },
          { value: 'BODY_CONTAINS', label: 'Body包含' }, { value: 'BODY_NOT_CONTAINS', label: 'Body不包含' },
        ]},
        { key: 'condition', label: '校验内容', type: 'text', placeholder: '校验条件值' },
        { key: 'connectTimeout', label: '连接超时(ms)', type: 'number', default: 60000 },
        { key: 'socketTimeout', label: 'Socket超时(ms)', type: 'number', default: 60000 },
      ],
    },
    DATAX: {
      label: 'DataX 配置',
      params: [
        { key: 'customConfig', label: '使用自定义JSON模板', type: 'checkbox', default: false },
        { key: 'dsType', label: '源数据源类型', type: 'select', default: 'MYSQL', options: [
          { value: 'MYSQL', label: 'MYSQL' }, { value: 'POSTGRESQL', label: 'POSTGRESQL' }, { value: 'HIVE', label: 'HIVE' },
        ]},
        { key: 'dtType', label: '目标数据源类型', type: 'select', default: 'MYSQL', options: [
          { value: 'MYSQL', label: 'MYSQL' }, { value: 'POSTGRESQL', label: 'POSTGRESQL' }, { value: 'HIVE', label: 'HIVE' },
        ]},
        { key: 'targetTable', label: '目标表名', type: 'text', placeholder: 'target_table' },
        { key: 'jobSpeedByte', label: '限流(字节)', type: 'number', default: 0 },
        { key: 'jobSpeedRecord', label: '限流(记录数)', type: 'number', default: 1000 },
        { key: 'xms', label: 'JVM最小内存(GB)', type: 'number', default: 1 },
        { key: 'xmx', label: 'JVM最大内存(GB)', type: 'number', default: 1 },
      ],
    },
    HIVECLI: {
      label: 'HiveCLI 配置',
      params: [
        { key: 'hiveCliTaskExecutionType', label: '执行类型', type: 'select', default: 'SCRIPT', options: [
          { value: 'SCRIPT', label: '脚本' }, { value: 'FILE', label: '文件' },
        ]},
        { key: 'hiveCliArgs', label: 'HiveCLI参数', type: 'text', placeholder: '--hivevar key=value' },
      ],
    },
    PROCEDURE: {
      label: '存储过程配置',
      params: [
        { key: 'type', label: '数据源类型', type: 'select', default: 'MYSQL', options: [
          { value: 'MYSQL', label: 'MYSQL' }, { value: 'POSTGRESQL', label: 'POSTGRESQL' }, { value: 'HIVE', label: 'HIVE' },
        ]},
        { key: 'method', label: '存储过程语句', type: 'textarea', placeholder: 'CALL procedure_name(param1, param2)' },
      ],
    },
    SEATUNNEL: {
      label: 'SeaTunnel 配置',
      params: [
        { key: 'startupScript', label: '启动脚本', type: 'select', default: 'seatunnel.sh', options: [
          { value: 'seatunnel.sh', label: 'seatunnel.sh (Spark)' }, { value: 'seatunnel-flink.sh', label: 'seatunnel-flink.sh (Flink)' },
        ]},
        { key: 'runMode', label: '运行模式', type: 'select', default: 'RUN', options: [
          { value: 'NONE', label: 'NONE' }, { value: 'RUN', label: 'RUN' }, { value: 'RUN_APPLICATION', label: 'RUN_APPLICATION' },
        ]},
        { key: 'useCustom', label: '使用自定义配置', type: 'checkbox', default: true },
        { key: 'deployMode', label: '部署模式', type: 'select', default: 'client', options: [
          { value: 'client', label: 'client' }, { value: 'cluster', label: 'cluster' }, { value: 'local', label: 'local' },
        ]},
      ],
    },
    SQOOP: {
      label: 'Sqoop 配置',
      params: [
        { key: 'isCustomTask', label: '自定义任务', type: 'checkbox', default: false },
        { key: 'modelType', label: '方向', type: 'select', default: 'import', options: [
          { value: 'import', label: '导入(import)' }, { value: 'export', label: '导出(export)' },
        ]},
        { key: 'concurrency', label: '并发数', type: 'number', default: 1 },
      ],
    },
  };

  const [taskTypeParams, setTaskTypeParams] = useState<Record<string, string | boolean>>({});

  const DATASOURCE_REQUIRED_TYPES: DSTaskType[] = ['SQL', 'DATAX', 'SEATUNNEL', 'SQOOP', 'CHUNJUN', 'DATASYNC', 'HIVECLI'];

  const matchedProject = useMemo(() => {
    if (!projectCode || projects.length === 0) return null;
    return projects.find(p => p.name === projectCode) || null;
  }, [projectCode, projects]);

  const projectMismatch = useMemo(() => {
    if (!projectCode || projects.length === 0) return false;
    return !matchedProject;
  }, [projectCode, projects, matchedProject]);

  const availableTaskTypes = useMemo(() => getAvailableTaskTypes(), []);

  const currentMapping: CodeFileMapping | null = useMemo(() => {
    if (!initialMapping) return null;
    if (!selectedTaskType || selectedTaskType === initialMapping.taskType) return initialMapping;
    return mapCodeFileToTask(fileName, codeContent, filePath, rootPath, savedConfig, selectedTaskType);
  }, [initialMapping, selectedTaskType, fileName, codeContent, filePath, rootPath, savedConfig]);

  useEffect(() => {
    setValidationPassed(false);
  }, [selectedProjectCode, selectedWorkflowCode, workflowName, selectedTaskType, selectedDatasourceId, selectedWorkerGroup, selectedEnvironmentCode, taskTypeParams]);

  const needsDatasource = currentMapping ? DATASOURCE_REQUIRED_TYPES.includes(currentMapping.taskType) : false;

  const codeDatasourceName = currentMapping?.dataSource || null;

  const currentTaskTypeConfig = useMemo(() => {
    if (!currentMapping) return null;
    return TASK_TYPE_PARAMS_CONFIG[currentMapping.taskType] || null;
  }, [currentMapping?.taskType]);

  useEffect(() => {
    if (currentMapping && currentTaskTypeConfig) {
      const defaults: Record<string, string | boolean> = {};
      for (const param of currentTaskTypeConfig.params) {
        if (param.default !== undefined) {
          defaults[param.key] = typeof param.default === 'boolean' ? param.default : String(param.default);
        }
      }
      const fromMapping: Record<string, string | boolean> = {};
      for (const param of currentTaskTypeConfig.params) {
        const mappingVal = currentMapping.taskParams[param.key];
        if (mappingVal !== undefined && mappingVal !== null && mappingVal !== '') {
          fromMapping[param.key] = typeof mappingVal === 'boolean' ? mappingVal : String(mappingVal);
        }
      }
      setTaskTypeParams(prev => ({ ...defaults, ...fromMapping, ...prev }));
    } else {
      setTaskTypeParams({});
    }
  }, [currentMapping?.taskType]);

  const applyTaskTypeParamsToMapping = useCallback((mapping: CodeFileMapping | null): CodeFileMapping | null => {
    if (!mapping || Object.keys(taskTypeParams).length === 0) return mapping;

    const updatedParams = { ...mapping.taskParams };
    for (const [key, value] of Object.entries(taskTypeParams)) {
      if (value !== undefined && value !== '') {
        if (typeof value === 'boolean') {
          updatedParams[key] = value;
        } else if (key.includes('Memory') || key.includes('memory')) {
          updatedParams[key] = value;
        } else if (key.includes('Cores') || key === 'parallelism' || key === 'numExecutors' ||
                   key === 'slot' || key === 'taskManager' || key === 'displayRows' ||
                   key === 'jobSpeedByte' || key === 'jobSpeedRecord' || key === 'xms' || key === 'xmx' ||
                   key === 'concurrency' || key === 'connectTimeout' || key === 'socketTimeout' ||
                   key === 'cpuQuota' || key === 'memoryMax' || key === 'driverCores') {
          updatedParams[key] = Number(value) || 0;
        } else {
          updatedParams[key] = value;
        }
      }
    }

    return { ...mapping, taskParams: updatedParams };
  }, [taskTypeParams]);

  const effectiveMapping = useMemo(() => {
    return applyTaskTypeParamsToMapping(currentMapping);
  }, [currentMapping, applyTaskTypeParamsToMapping]);

  const matchedDatasource = useMemo(() => {
    if (!codeDatasourceName || dsDataSources.length === 0) return null;
    return dsDataSources.find(ds => ds.name === codeDatasourceName) || null;
  }, [codeDatasourceName, dsDataSources]);

  const datasourceMismatch = useMemo(() => {
    if (!codeDatasourceName || dsDataSources.length === 0) return false;
    return !matchedDatasource;
  }, [codeDatasourceName, dsDataSources, matchedDatasource]);

  useEffect(() => {
    if (!visible) {
      setStep('config');
      setSelectedProjectCode(null);
      setSelectedWorkflowCode(null);
      setWorkflowName('');
      setWorkflowDesc('');
      setAutoOnline(true);
      setAutoTrigger(false);
      setErrorMsg(null);
      setSuccessInfo(null);
      setSelectedTaskType(null);
      setValidationErrors([]);
      setShowValidation(false);
      setValidationPassed(false);
      setCompiledJarPath(null);
      setIsCompiling(false);
      setCompileResult(null);
      setSelectedDatasourceId(null);
      setSelectedWorkerGroup('default');
      setSelectedEnvironmentCode(-1);
      setWorkflowNameCheck(null);
      setTaskNameCheck(null);
      setIsCheckingName(false);
      if (workflowCheckTimerRef.current) {
        clearTimeout(workflowCheckTimerRef.current);
        workflowCheckTimerRef.current = null;
      }
      return;
    }

    if (initialMapping) {
      setSelectedTaskType(initialMapping.taskType);
      setWorkflowName(initialMapping.workflowName);
      setWorkflowDesc(initialMapping.description);
    }
  }, [visible, initialMapping]);

  useEffect(() => {
    if (!visible || !dsApi) return;

    const loadProjects = async () => {
      setLoading(true);
      try {
        const res = await dsApi.project.list({ pageNo: 1, pageSize: 100 });
        if (res.code === 0 && res.data?.totalList) {
          const list = res.data.totalList;
          setProjects(list);
          if (projectCode) {
            const matched = list.find((p: DSProject) => p.name === projectCode);
            if (matched) {
              setSelectedProjectCode(matched.code);
            }
          } else if (list.length > 0 && !selectedProjectCode) {
            setSelectedProjectCode(list[0].code);
          }
        }
      } catch {
        setProjects([]);
      } finally {
        setLoading(false);
      }
    };

    loadProjects();
  }, [visible, dsApi, projectCode]);

  useEffect(() => {
    if (!visible || !selectedProjectCode || !dsApi) {
      setWorkflows([]);
      return;
    }

    const loadWorkflows = async () => {
      try {
        const res = await dsApi.workflowDefinition.list(selectedProjectCode, {
          pageNo: 1,
          pageSize: 100,
        });
        if (res.code === 0 && res.data?.totalList) {
          setWorkflows(res.data.totalList);
        }
      } catch {
        setWorkflows([]);
      }
    };

    loadWorkflows();
  }, [visible, selectedProjectCode, dsApi]);

  useEffect(() => {
    if (!visible || !needsDatasource || !dsApi) {
      setDsDataSources([]);
      return;
    }

    const loadDataSources = async () => {
      try {
        const res = await dsApi.datasource.list({ pageNo: 1, pageSize: 100 });
        if (res.code === 0 && res.data?.totalList) {
          const list = res.data.totalList;
          setDsDataSources(list);
          if (codeDatasourceName) {
            const matched = list.find((ds: DSDataSource) => ds.name === codeDatasourceName);
            if (matched) {
              setSelectedDatasourceId(matched.id);
            }
          } else if (list.length > 0 && !selectedDatasourceId) {
            setSelectedDatasourceId(list[0].id);
          }
        }
      } catch {
        setDsDataSources([]);
      }
    };

    loadDataSources();
  }, [visible, needsDatasource, dsApi, codeDatasourceName]);

  useEffect(() => {
    if (!visible || !dsApi) return;

    const loadConfigData = async () => {
      try {
        const promises: Promise<any>[] = [];
        if (selectedProjectCode) {
          promises.push(dsApi.workerGroup.list(selectedProjectCode, { pageNo: 1, pageSize: 100 }));
        }
        promises.push(dsApi.environment.list({ pageNo: 1, pageSize: 100 }));
        const results = await Promise.all(promises);
        let idx = 0;
        if (selectedProjectCode) {
          const wgRes = results[idx++];
          const wgSuccess = wgRes.code === 0 || wgRes.status === 'SUCCESS';
          if (wgSuccess && wgRes.data) {
            const list = Array.isArray(wgRes.data) ? wgRes.data : (wgRes.data.totalList || []);
            console.log('[SubmitModal] Worker groups loaded:', list.length, list);
            setWorkerGroups(list);
            const defaultWg = list.find((wg: DSWorkerGroup) => wg.workerGroup === 'default');
            if (defaultWg) setSelectedWorkerGroup(defaultWg.workerGroup);
          } else {
            console.warn('[SubmitModal] Worker groups response:', wgRes);
          }
        }
        const envRes = results[idx];
        if (envRes.code === 0 && envRes.data) {
          const list = Array.isArray(envRes.data) ? envRes.data : (envRes.data.totalList || []);
          console.log('[SubmitModal] Environments loaded:', list.length, list);
          setEnvList(list);
        } else {
          console.warn('[SubmitModal] Environments response:', envRes);
        }
      } catch (err) {
        console.error('[SubmitModal] Failed to load config data:', err);
      }
    };

    loadConfigData();
  }, [visible, dsApi, selectedProjectCode]);

  const checkWorkflowNameExists = useCallback(async (name: string, projectCode: number | null) => {
    if (!name.trim() || !projectCode || !dsApi) {
      setWorkflowNameCheck(null);
      return;
    }

    setIsCheckingName(true);
    try {
      const sanitizedName = sanitizeDsName(name);
      const res = await dsApi.workflowDefinition.list(projectCode, {
        pageNo: 1,
        pageSize: 100,
        searchVal: sanitizedName,
      });

      if (res.code === 0 && res.data?.totalList) {
        const exactMatch = res.data.totalList.find(
          (w: DSWorkflowDefinition) => w.name === sanitizedName
        );
        if (exactMatch) {
          const isOnline = parseReleaseState(exactMatch.releaseState) === ReleaseState.ONLINE;
          setWorkflowNameCheck({
            exists: true,
            isOnline,
            workflowCode: exactMatch.code,
          });
        } else {
          setWorkflowNameCheck({ exists: false, isOnline: false });
        }
      } else {
        setWorkflowNameCheck(null);
      }
    } catch {
      setWorkflowNameCheck(null);
    } finally {
      setIsCheckingName(false);
    }
  }, [dsApi]);

  const checkTaskNameInWorkflow = useCallback(async (taskName: string, workflowCode: number | null) => {
    if (!taskName.trim() || !workflowCode || !selectedProjectCode || !dsApi) {
      setTaskNameCheck(null);
      return;
    }

    try {
      const res = await dsApi.workflowDefinition.detail(selectedProjectCode, workflowCode);
      if (res.code === 0 && res.data) {
        const { taskNodes } = res.data;
        const sanitizedName = sanitizeDsName(taskName);
        const exists = taskNodes.some((node: DSWorkflowTaskNode) => node.name === sanitizedName);
        if (exists) {
          setTaskNameCheck({ exists: true, workflowName: res.data.workflowDefinition.name });
        } else {
          setTaskNameCheck(null);
        }
      }
    } catch {
      setTaskNameCheck(null);
    }
  }, [dsApi, selectedProjectCode]);

  useEffect(() => {
    if (workflowCheckTimerRef.current) {
      clearTimeout(workflowCheckTimerRef.current);
    }

    if (!selectedWorkflowCode && workflowName.trim() && selectedProjectCode) {
      workflowCheckTimerRef.current = setTimeout(() => {
        checkWorkflowNameExists(workflowName, selectedProjectCode);
      }, 500);
    } else {
      setWorkflowNameCheck(null);
    }

    return () => {
      if (workflowCheckTimerRef.current) {
        clearTimeout(workflowCheckTimerRef.current);
      }
    };
  }, [workflowName, selectedProjectCode, selectedWorkflowCode, checkWorkflowNameExists]);

  useEffect(() => {
    if (selectedWorkflowCode && currentMapping?.taskName) {
      checkTaskNameInWorkflow(currentMapping.taskName, selectedWorkflowCode);
    } else {
      setTaskNameCheck(null);
    }
  }, [selectedWorkflowCode, currentMapping?.taskName, checkTaskNameInWorkflow]);

  const isCompilableTask = useMemo(() => {
    if (!currentMapping) return false;
    const ext = fileName.split('.').pop()?.toLowerCase() || '';
    return ['java', 'scala'].includes(ext) && ['SPARK', 'FLINK', 'FLINK_STREAM', 'MR', 'JAVA'].includes(currentMapping.taskType);
  }, [currentMapping, fileName]);

  const handleValidate = useCallback(async (): Promise<ValidationError[]> => {
    if (isCompiling) return [];
    const errors = validateSubmission(
      effectiveMapping,
      selectedProjectCode,
      workflowName,
      selectedWorkflowCode,
      isRealApi,
    );

    if (projectCode && projects.length > 0 && projectMismatch) {
      errors.push({
        field: 'project',
        message: `调度系统中不存在名称为「${projectCode}」的项目，请联系管理员创建该调度项目后再提交`,
      });
    }

    if (needsDatasource && !selectedDatasourceId) {
      errors.push({
        field: 'datasource',
        message: `${currentMapping?.taskType || '该类型'}任务必须选择数据源，请在调度系统数据源管理中创建数据源`,
      });
    }

    if (needsDatasource && codeDatasourceName && datasourceMismatch) {
      errors.push({
        field: 'datasource',
        message: `代码中引用的数据源「${codeDatasourceName}」在调度系统中不存在，请联系管理员在调度系统数据源管理中创建该数据源`,
      });
    }

    const ext = fileName.split('.').pop()?.toLowerCase() || '';
    if (ext === 'java' || ext === 'scala') {
      const headerValidation = validateFileHeader(
        codeContent,
        fileName,
        currentMapping?.relativePath || undefined,
        projectCode || undefined,
      );
      if (!headerValidation.valid) {
        for (const pkgErr of headerValidation.packageErrors) {
          errors.push({ field: 'fileSpec', message: pkgErr });
        }
      }
    }

    // YARN 作业名称校验：代码中若显式设置了 yarn 作业名称（如 Spark 的 .setAppName("xxx")、
    // Flink 的 env.execute("xxx")/pipeline.name、SQL/Hive 的 set mapreduce.job.name=xxx 等），
    // 必须与文件名一致，否则提交到 YARN 后难以定位作业。未显式设置时视为无需校验（不拦截）。
    if (['java', 'scala', 'py', 'sql', 'hql', 'sh', 'bash'].includes(ext)) {
      const yarnCheck = validateYarnJobName(codeContent, fileName);
      if (!yarnCheck.valid) {
        errors.push({ field: 'yarnJobName', message: yarnCheck.message });
      }
    }


    if (isCompilableTask && compileConfig?.javaHome) {
      setIsCompiling(true);
      setCompileResult(null);
      try {
        const result = await unifiedCompile({
          projectId: devProjectId || 0,
          projectCode: projectCode || undefined,
          filePath: filePath || '',
          codeContent,
          rootPath: rootPath || undefined,
          envConfig: {
            javaHome: compileConfig.javaHome,
            scalaHome: compileConfig.scalaHome,
            mavenHome: compileConfig.mavenHome,
            scalaVersion: compileConfig.scalaVersion || undefined,
            pomTemplate: compileConfig.pomTemplate || undefined,
            workspace: compileConfig.workspace || undefined,
            mavenGroupId: compileConfig.mavenGroupId || undefined,
            mavenArtifactId: compileConfig.mavenArtifactId || undefined,
          },
          savedConfig: savedConfig || null,
        });

        setCompileResult(result);

        if (result.success) {
          setCompiledJarPath(result.jarPath);
          const previewSegments: string[] = [];
          if (projectCode) {
            previewSegments.push(projectCode);
          }
          const codeDirPath = currentMapping?.dirPath || '';
          if (codeDirPath) {
            previewSegments.push(codeDirPath);
          }
          const codeFileBaseName = fileName.replace(/\.[^.]+$/, '');
          const now = new Date();
          const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
          previewSegments.push(`${codeFileBaseName}_${timestamp}.jar`);
          const mainJarPreview = "/"+previewSegments.join('/');
          setTaskTypeParams(prev => ({ ...prev, mainJar: mainJarPreview }));
        } else {
          setCompiledJarPath(null);
          const compileError = result.error || result.output || '未知错误';
          console.error('[SubmitModal] 编译失败详情:', { success: result.success, jarPath: result.jarPath, error: result.error, output: result.output?.slice(0, 500) });
          errors.push({
            field: 'compile',
            message: `编译失败: ${compileError}`,
          });
        }
      } catch (e) {
        setCompiledJarPath(null);
        errors.push({
          field: 'compile',
          message: `编译异常: ${e instanceof Error ? e.message : String(e)}`,
        });
      } finally {
        setIsCompiling(false);
      }
    } else if (isCompilableTask && !compileConfig?.javaHome) {
      errors.push({
        field: 'compile',
        message: 'JAVA_HOME 未配置，无法编译 Java/Scala 代码，请在设置中配置',
      });
    }

    setValidationErrors(errors);
    setShowValidation(true);
    const passed = errors.length === 0;
    console.log(passed)
    setValidationPassed(passed);
    return errors;
  }, [effectiveMapping, currentMapping, selectedProjectCode, workflowName, selectedWorkflowCode, isRealApi, projectCode, projects, projectMismatch, needsDatasource, selectedDatasourceId, codeDatasourceName, datasourceMismatch, isCompilableTask, compileConfig, fileName, codeContent, filePath, rootPath, savedConfig, projectCode]);

  const handleSubmit = useCallback(async () => {

    if (!effectiveMapping || !selectedProjectCode || !dsApi) return;

    setStep('submitting');
    setErrorMsg(null);

    const mappingWithDatasource = { ...effectiveMapping };
    if (needsDatasource && selectedDatasourceId) {
      const updatedParams = { ...mappingWithDatasource.taskParams };
      updatedParams.datasource = selectedDatasourceId;
      const selectedDs = dsDataSources.find(ds => ds.id === selectedDatasourceId);
      if (selectedDs) {
        updatedParams.type = selectedDs.type;
      }
      mappingWithDatasource.taskParams = updatedParams;
    }

    // 为 Spark 任务注入 OpenLineage 固定参数
    if (mappingWithDatasource.taskType === 'SPARK') {
      const updatedParams = { ...mappingWithDatasource.taskParams };
      const openlineageConfs: string[] = [
        '--conf spark.extraListeners=io.openlineage.spark.agent.OpenLineageSparkListener',
        '--conf spark.openlineage.transport.type=http',
      ];
      if (openlineageTransportUrl) {
        openlineageConfs.push(`--conf spark.openlineage.transport.url=${openlineageTransportUrl}`);
      }
      if (projectCode) {
        openlineageConfs.push(`--conf spark.openlineage.namespace=${projectCode}`);
      }
      const existingOthers = (updatedParams.others as string) || '';
      updatedParams.others = existingOthers
        ? `${existingOthers}\n${openlineageConfs.join('\n')}`
        : openlineageConfs.join('\n');
      mappingWithDatasource.taskParams = updatedParams;
    }

    let uploadedJarResourcePath: string | null = null;
    if (compiledJarPath && dsApi) {
      try {
        const { readFile: fsReadFile } = await import('../../bridge/fs');
        const jarUint8Array = await fsReadFile(compiledJarPath);
        // readFile 返回的类型是 Uint8Array<ArrayBufferLike>，直接传入 Blob 会导致 TS 报错
        // （BlobPart 仅接受由 ArrayBuffer 支持的视图）。复制一份即可保证底层为 ArrayBuffer。
        const jarBytes = new Uint8Array(jarUint8Array);
        const jarBlob = new Blob([jarBytes], { type: 'application/java-archive' });

        const codeFileBaseName = fileName.replace(/\.[^.]+$/, '');
        const jarExt = '.jar';
        const now = new Date();
        const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
        const uploadFileName = `${codeFileBaseName}_${timestamp}${jarExt}`;

        let baseDir = '/';
        try {
          const baseDirRes = await dsApi.resource.queryBaseDir('FILE');
          if (baseDirRes.code === 0 && baseDirRes.data) {
            baseDir = baseDirRes.data;
          }
        } catch { /* use default */ }

        const dirSegments: string[] = [];
        if (projectCode) {
          dirSegments.push(projectCode);
        }
        const codeDirPath = currentMapping?.dirPath || '';
        if (codeDirPath) {
          dirSegments.push(...splitPath(codeDirPath));
        }

        
        let currentDir = baseDir;
        
        let p="/"+dirSegments.join('/');
        try {
            await dsApi.resource.createDir({
              type: 'FILE',
              name: p,
              currentDir: currentDir,
              description: `Auto-created for project ${projectCode || ''}`,
            });
          } catch (e) {
            console.log('[SubmitModal] Directory may already exist:', p, e);
          }

        const jarFile = new File([jarBlob], uploadFileName, { type: 'application/java-archive' });

        const uploadRes = await dsApi.resource.upload({
          type: 'FILE',
          name: uploadFileName,
          file: jarFile,
          currentDir: currentDir+p,
        });

        if (uploadRes.code === 0) {
          const mainJarSegments: string[] = [];
          if (projectCode) {
            mainJarSegments.push(projectCode);
          }
          if (codeDirPath) {
            mainJarSegments.push(codeDirPath);
          }
          mainJarSegments.push(uploadFileName);
          uploadedJarResourcePath = [baseDir.replace(/\/+$/, ''), ...mainJarSegments].join('/');
          const updatedParams = { ...mappingWithDatasource.taskParams };
          updatedParams.mainJar = uploadedJarResourcePath;
          mappingWithDatasource.taskParams = updatedParams;
        } else {
          console.warn('[SubmitModal] JAR upload failed:', uploadRes.msg);
        }
      } catch (e) {
        console.warn('[SubmitModal] JAR upload error:', e);
      }
    }

    try {
      const targetProject = projects.find(p => p.code === selectedProjectCode);
      const projectName = targetProject?.name || '';

      if (selectedWorkflowCode) {
        const detailRes = await dsApi.workflowDefinition.detail(selectedProjectCode, selectedWorkflowCode);
        if (detailRes.code === 0 && detailRes.data) {
          const { taskNodes, edges, globalParams, workflowDefinition } = detailRes.data;
          const newTaskCode = Date.now();

          const newNode: import('../../types/dolphinscheduler').DSWorkflowTaskNode = {
            code: newTaskCode,
            name: mappingWithDatasource.taskName,
            taskType: mappingWithDatasource.taskType,
            description: mappingWithDatasource.description,
            taskParams: JSON.stringify(mappingWithDatasource.taskParams),
            flag: 'YES',
            taskPriority: Priority.MEDIUM,
            workerGroup: selectedWorkerGroup,
            environmentCode: selectedEnvironmentCode,
            failRetryTimes: 0,
            failRetryInterval: 1,
            timeoutFlag: 'CLOSE',
            timeout: 0,
            delayTime: 0,
            x: 200 + taskNodes.length * 200,
            y: 100 + (taskNodes.length % 3) * 100,
          };

          const updatedNodes = [...taskNodes, newNode];
          const updatedEdges = [...edges];

          if (taskNodes.length > 0) {
            const lastNode = taskNodes[taskNodes.length - 1];
            updatedEdges.push({
              id: `e_${lastNode.code}_${newTaskCode}`,
              sourceCode: lastNode.code,
              targetCode: newTaskCode,
            });
          }

          await dsApi.workflowDefinition.update(selectedProjectCode, selectedWorkflowCode, {
            name: workflowDefinition.name,
            description: workflowDefinition.description,
            executionType: workflowDefinition.executionType,
            timeout: workflowDefinition.timeout,
            globalParams,
            nodes: updatedNodes,
            edges: updatedEdges,
            release: false,
          }).then(res => {
            if (res && res.code !== 0) {
              throw new Error(`更新工作流失败: ${res.msg || `错误码 ${res.code}`}`);
            }
          });

          if (autoOnline) {
            await dsApi.workflowDefinition.release(selectedProjectCode, selectedWorkflowCode, ReleaseState.ONLINE);
          }

          if (autoTrigger && autoOnline) {
            await dsApi.workflowDefinition.trigger(selectedProjectCode, {
              processDefinitionCode: selectedWorkflowCode,
            });
          }

          setSuccessInfo({ projectName, workflowName: workflowDefinition.name });
          setStep('success');
          onSuccess(projectName, workflowDefinition.name);
        } else {
          throw new Error('获取工作流详情失败');
        }
      } else {
        const workflowData = buildWorkflowFromCodeFile(
          mappingWithDatasource,
          workflowDesc || mappingWithDatasource.description,
        );

        const createRes = await dsApi.workflowDefinition.createWithTasks(selectedProjectCode, workflowData);

        if (createRes && createRes.code !== 0) {
          throw new Error(`创建工作流失败: ${createRes.msg || `错误码 ${createRes.code}`}`);
        }

        const listRes = await dsApi.workflowDefinition.list(selectedProjectCode, {
          pageNo: 1,
          pageSize: 1,
          searchVal: workflowData.name,
        });

        let createdWorkflowCode: number | null = null;
        if (listRes.code === 0 && listRes.data?.totalList?.length) {
          createdWorkflowCode = listRes.data.totalList[0].code;
        }

        if (autoOnline && createdWorkflowCode) {
          await dsApi.workflowDefinition.release(selectedProjectCode, createdWorkflowCode, ReleaseState.ONLINE);
        }

        if (autoTrigger && autoOnline && createdWorkflowCode) {
          await dsApi.workflowDefinition.trigger(selectedProjectCode, {
            processDefinitionCode: createdWorkflowCode,
          });
        }

        setSuccessInfo({ projectName, workflowName: workflowData.name });
        setStep('success');
        onSuccess(projectName, workflowData.name);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '提交失败');
      setStep('error');
    }
  }, [
    handleValidate, effectiveMapping, selectedProjectCode, selectedWorkflowCode,
    projects, workflowDesc, autoOnline, autoTrigger, dsApi, onSuccess,
    compiledJarPath, needsDatasource, selectedDatasourceId, dsDataSources,
    selectedWorkerGroup, selectedEnvironmentCode, openlineageTransportUrl, projectCode,
  ]);

  if (!visible) return null;

  if (!dsApi) {
    return (
      <div className="submit-scheduler__overlay" onClick={onClose}>
        <div className="submit-scheduler" onClick={e => e.stopPropagation()}>
          <div className="submit-scheduler__header">
            <div className="submit-scheduler__title">
              <Send size={16} />
              <span>提交到调度系统</span>
            </div>
            <button className="submit-scheduler__close" onMouseDown={(e) => { e.preventDefault(); onClose(); }}>
              <X size={16} />
            </button>
          </div>
          <div style={{ padding: 24, textAlign: 'center', color: '#e74c3c' }}>
            未配置调度系统API地址，请在设置中配置DolphinScheduler API地址和Token后再试。
          </div>
        </div>
      </div>
    );
  }

  const isRecommended = currentMapping && selectedTaskType === currentMapping.recommendedTaskType;

  return (
    <div className="submit-scheduler__overlay" onClick={onClose}>
      <div className="submit-scheduler" onClick={e => e.stopPropagation()}>
        <div className="submit-scheduler__header">
          <div className="submit-scheduler__title">
            <Send size={16} />
            <span>提交到调度系统</span>
          </div>
          <button className="submit-scheduler__close" onMouseDown={(e) => { e.preventDefault(); onClose(); }}>
            <X size={16} />
          </button>
        </div>

        <div className="submit-scheduler__body">
          {!isRealApi && (
            <div className="submit-scheduler__warning">
              <AlertTriangle size={14} />
              <span>当前使用 Mock API，提交结果仅为模拟。请在设置中配置 DolphinScheduler 连接信息。</span>
            </div>
          )}

          {showValidation && validationErrors.length > 0 && step === 'config' && (
            <div className="submit-scheduler__validation-errors">
              <div className="submit-scheduler__validation-title">
                <Shield size={14} />
                <span>校验未通过 ({validationErrors.length})</span>
              </div>
              {validationErrors.map((err, idx) => (
                <div key={idx} className="submit-scheduler__validation-item">
                  <AlertTriangle size={12} />
                  <span>{err.message}</span>
                </div>
              ))}
            </div>
          )}

          {showValidation && validationErrors.length === 0 && step === 'config' && (
            <div className="submit-scheduler__validation-pass">
              <CheckCircle size={14} />
              <span>校验通过，可以提交</span>
              {compiledJarPath && (
                <span style={{ marginLeft: 8, fontSize: 11, color: '#888' }}>
                  JAR: {getBaseName(compiledJarPath)}
                </span>
              )}
            </div>
          )}

          {isCompiling && step === 'config' && (
            <div className="submit-scheduler__validation-errors" style={{ borderColor: '#e6a817' }}>
              <div className="submit-scheduler__validation-title" style={{ color: '#e6a817' }}>
                <Loader2 size={14} className="submit-scheduler__spin" />
                <span>正在编译代码...</span>
              </div>
            </div>
          )}

          {!isCompiling && compileResult && !compileResult.success && step === 'config' && (
            <div className="submit-scheduler__validation-errors">
              <div className="submit-scheduler__validation-title">
                <AlertTriangle size={14} />
                <span>编译失败</span>
              </div>
              {compileResult.error && (
                <div className="submit-scheduler__validation-item">
                  <AlertTriangle size={12} />
                  <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{compileResult.error}</span>
                </div>
              )}
              {compileResult.output && (
                <details style={{ marginTop: 4 }}>
                  <summary style={{ fontSize: 11, color: '#858585', cursor: 'pointer' }}>编译输出</summary>
                  <pre style={{ fontSize: 11, color: '#858585', maxHeight: 120, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{compileResult.output}</pre>
                </details>
              )}
            </div>
          )}

          {step === 'config' && (
            <>
              <div className="submit-scheduler__section">
                <div className="submit-scheduler__section-title">文件信息</div>
                <div className="submit-scheduler__info-grid">
                  <div className="submit-scheduler__info-item">
                    <span className="submit-scheduler__info-label">文件名</span>
                    <span className="submit-scheduler__info-value">{fileName}</span>
                  </div>
                  {currentMapping && (
                    <>
                      <div className="submit-scheduler__info-item">
                        <span className="submit-scheduler__info-label">任务路径</span>
                        <span className="submit-scheduler__info-value submit-scheduler__path">{currentMapping.relativePath || fileName}</span>
                      </div>
                      <div className="submit-scheduler__info-item">
                        <span className="submit-scheduler__info-label">所属工作流</span>
                        <span className="submit-scheduler__info-value submit-scheduler__path">{currentMapping.workflowName}</span>
                      </div>
                    </>
                  )}
                </div>
              </div>

              {needsDatasource && (
                <div className="submit-scheduler__section">
                  <div className="submit-scheduler__section-title">
                    <Database size={14} />
                    数据源
                  </div>
                  {codeDatasourceName && (
                    <div className="submit-scheduler__project-code-hint">
                      代码中数据源: <strong>{codeDatasourceName}</strong>
                      {matchedDatasource ? (
                        <span className="submit-scheduler__project-code-match">
                          <CheckCircle size={12} /> 已匹配调度数据源
                        </span>
                      ) : dsDataSources.length > 0 ? (
                        <span className="submit-scheduler__project-code-mismatch">
                          <AlertTriangle size={12} /> 未找到匹配的数据源
                        </span>
                      ) : null}
                    </div>
                  )}
                  <select
                    className="submit-scheduler__select"
                    value={selectedDatasourceId || ''}
                    onChange={e => setSelectedDatasourceId(Number(e.target.value) || null)}
                  >
                    <option value="">选择数据源...</option>
                    {dsDataSources.map(ds => (
                      <option key={ds.id} value={ds.id}>
                        {ds.name === codeDatasourceName ? '✓ ' : ''}{ds.name}（{ds.type}）
                      </option>
                    ))}
                  </select>
                  {datasourceMismatch && dsDataSources.length > 0 && (
                    <div className="submit-scheduler__project-mismatch-warning">
                      <AlertTriangle size={14} />
                      <span>调度系统中不存在名称为「{codeDatasourceName}」的数据源，请联系管理员在调度系统数据源管理中创建该数据源</span>
                    </div>
                  )}
                  {dsDataSources.length === 0 && (
                    <div className="submit-scheduler__empty-hint">
                      暂无数据源，请先在调度系统数据源管理中创建数据源
                    </div>
                  )}
                </div>
              )}

              <div className="submit-scheduler__section">
                <div className="submit-scheduler__section-title">任务类型</div>
                <div className="submit-scheduler__task-type-row">
                  <select
                    className="submit-scheduler__select submit-scheduler__task-type-select"
                    value={selectedTaskType || ''}
                    onChange={e => setSelectedTaskType(e.target.value as DSTaskType || null)}
                  >
                    {availableTaskTypes.map(t => (
                      <option key={t.value} value={t.value}>
                        [{t.category}] {t.label}
                        {currentMapping && t.value === currentMapping.recommendedTaskType ? ' ★ 推荐' : ''}
                      </option>
                    ))}
                  </select>
                  {currentMapping && !isRecommended && (
                    <div className="submit-scheduler__recommend-hint">
                      <AlertTriangle size={12} />
                      <span>推荐类型: {TASK_TYPE_LABELS[currentMapping.recommendedTaskType]}（{currentMapping.recommendationReason}）</span>
                    </div>
                  )}
                  {isRecommended && (
                    <div className="submit-scheduler__recommend-hint submit-scheduler__recommend-hint--ok">
                      <CheckCircle size={12} />
                      <span>已选择推荐类型</span>
                    </div>
                  )}
                </div>
              </div>

              {currentMapping && currentMapping.dataDependencies.length > 0 && (
                <div className="submit-scheduler__section">
                  <div className="submit-scheduler__section-title">
                    <Database size={14} />
                    数据依赖
                  </div>
                  <div className="submit-scheduler__deps-list">
                    {currentMapping.dataDependencies.map((dep, idx) => (
                      <span key={idx} className="submit-scheduler__dep-tag">{dep}</span>
                    ))}
                  </div>
                  <div className="submit-scheduler__deps-hint">
                    提交时将根据数据依赖关系设置前置任务依赖
                  </div>
                </div>
              )}

              <div className="submit-scheduler__section">
                <div className="submit-scheduler__section-title">
                  <FolderKanban size={14} />
                  目标项目
                </div>
                {projectCode && (
                  <div className="submit-scheduler__project-code-hint">
                    当前项目编码: <strong>{projectCode}</strong>
                    {matchedProject ? (
                      <span className="submit-scheduler__project-code-match">
                        <CheckCircle size={12} /> 已匹配调度项目
                      </span>
                    ) : projects.length > 0 ? (
                      <span className="submit-scheduler__project-code-mismatch">
                        <AlertTriangle size={12} /> 未找到匹配的调度项目
                      </span>
                    ) : null}
                  </div>
                )}
                <select
                  className="submit-scheduler__select"
                  value={selectedProjectCode || ''}
                  onChange={e => setSelectedProjectCode(Number(e.target.value) || null)}
                >
                  <option value="">选择项目...</option>
                  {projects.map(p => (
                    <option key={p.code} value={p.code}>
                      {p.name === projectCode ? '✓ ' : ''}{p.name}（{p.code}）
                    </option>
                  ))}
                </select>
                {projectMismatch && projects.length > 0 && (
                  <div className="submit-scheduler__project-mismatch-warning">
                    <AlertTriangle size={14} />
                    <span>调度系统中不存在名称为「{projectCode}」的项目，请联系管理员创建该调度项目后再提交工作流定义</span>
                  </div>
                )}
                {projects.length === 0 && !loading && (
                  <div className="submit-scheduler__empty-hint">暂无项目，请先在调度管理中创建项目</div>
                )}
              </div>

              {currentTaskTypeConfig && currentTaskTypeConfig.params.length > 0 && (
                <div className="submit-scheduler__section">
                  <div className="submit-scheduler__section-title">
                    <Info size={14} />
                    {currentTaskTypeConfig.label}
                  </div>
                  <div className="submit-scheduler__params-grid">
                    {currentTaskTypeConfig.params.map(param => (
                      <div key={param.key} className="submit-scheduler__param-item">
                        {param.type === 'checkbox' ? (
                          <label className="submit-scheduler__checkbox">
                            <input
                              type="checkbox"
                              checked={taskTypeParams[param.key] !== undefined ? !!taskTypeParams[param.key] : !!param.default}
                              onChange={e => setTaskTypeParams(prev => ({ ...prev, [param.key]: e.target.checked }))}
                            />
                            <span>{param.label}</span>
                          </label>
                        ) : (
                          <>
                            <label className="submit-scheduler__label submit-scheduler__param-label">
                              {param.label}
                              {param.unit && <span className="submit-scheduler__param-unit">({param.unit})</span>}
                            </label>
                            {param.type === 'select' ? (
                              <select
                                className="submit-scheduler__select"
                                value={String(taskTypeParams[param.key] ?? param.default ?? '')}
                                onChange={e => setTaskTypeParams(prev => ({ ...prev, [param.key]: e.target.value }))}
                              >
                                {param.options?.map(opt => (
                                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                                ))}
                              </select>
                            ) : param.type === 'number' ? (
                              <input
                                className="submit-scheduler__input"
                                type="number"
                                value={String(taskTypeParams[param.key] ?? param.default ?? '')}
                                onChange={e => setTaskTypeParams(prev => ({ ...prev, [param.key]: e.target.value }))}
                              />
                            ) : param.type === 'textarea' ? (
                              <textarea
                                className="submit-scheduler__input"
                                value={String(taskTypeParams[param.key] ?? param.default ?? '')}
                                onChange={e => setTaskTypeParams(prev => ({ ...prev, [param.key]: e.target.value }))}
                                placeholder={param.placeholder || ''}
                                rows={2}
                              />
                            ) : (
                              <input
                                className="submit-scheduler__input"
                                type="text"
                                value={String(taskTypeParams[param.key] ?? param.default ?? '')}
                                onChange={e => setTaskTypeParams(prev => ({ ...prev, [param.key]: e.target.value }))}
                                placeholder={param.placeholder || param.unit || ''}
                              />
                            )}
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="submit-scheduler__section">
                <div className="submit-scheduler__section-title">
                  <GitBranch size={14} />
                  工作流
                </div>
                <div className="submit-scheduler__radio-group">
                  <label className="submit-scheduler__radio">
                    <input
                      type="radio"
                      name="workflowMode"
                      checked={!selectedWorkflowCode}
                      onChange={() => setSelectedWorkflowCode(null)}
                    />
                    <span>创建新工作流</span>
                  </label>
                  <label className="submit-scheduler__radio">
                    <input
                      type="radio"
                      name="workflowMode"
                      checked={!!selectedWorkflowCode}
                      onChange={() => {
                        if (workflows.length > 0) {
                          setSelectedWorkflowCode(workflows[0].code);
                        }
                      }}
                      disabled={workflows.length === 0}
                    />
                    <span>添加到已有工作流</span>
                  </label>
                </div>

                {!selectedWorkflowCode ? (
                  <div className="submit-scheduler__field-group">
                    <div className="submit-scheduler__field">
                      <label className="submit-scheduler__label">工作流名称（目录路径）</label>
                      <input
                        className="submit-scheduler__input"
                        value={workflowName}
                        onChange={e => setWorkflowName(e.target.value)}
                        placeholder="如: etl/ods/dwd_layer"
                      />
                    </div>
                    {isCheckingName && (
                      <div className="submit-scheduler__name-check-hint submit-scheduler__name-check-hint--loading">
                        <Loader2 size={12} className="submit-scheduler__spin" />
                        <span>正在检查工作流名称...</span>
                      </div>
                    )}
                    {workflowNameCheck?.exists && !selectedWorkflowCode && (
                      <div className={`submit-scheduler__name-check-hint ${workflowNameCheck.isOnline ? 'submit-scheduler__name-check-hint--warning' : 'submit-scheduler__name-check-hint--info'}`}>
                        <AlertTriangle size={12} />
                        <span>
                          调度系统中已存在同名工作流「{workflowName}」
                          {workflowNameCheck.isOnline ? '，且该工作流已上线，创建新工作流可能会影响现有调度任务' : '（未上线状态）'}
                          {workflowNameCheck.isOnline && (
                            <button
                              className="submit-scheduler__link-btn"
                              onMouseDown={(e) => {
                                e.preventDefault();
                                setSelectedWorkflowCode(workflowNameCheck.workflowCode || null);
                                setWorkflowNameCheck(null);
                              }}
                            >
                              改为添加到该工作流 →
                            </button>
                          )}
                        </span>
                      </div>
                    )}
                    {workflowNameCheck && !workflowNameCheck.exists && !isCheckingName && workflowName.trim() && (
                      <div className="submit-scheduler__name-check-hint submit-scheduler__name-check-hint--ok">
                        <CheckCircle size={12} />
                        <span>工作流名称可用</span>
                      </div>
                    )}
                    <div className="submit-scheduler__field">
                      <label className="submit-scheduler__label">描述</label>
                      <input
                        className="submit-scheduler__input"
                        value={workflowDesc}
                        onChange={e => setWorkflowDesc(e.target.value)}
                        placeholder="工作流描述（可选）"
                      />
                    </div>
                  </div>
                ) : (
                  <>
                    <select
                      className="submit-scheduler__select"
                      value={selectedWorkflowCode || ''}
                      onChange={e => setSelectedWorkflowCode(Number(e.target.value) || null)}
                    >
                      <option value="">选择工作流...</option>
                      {workflows.map(w => (
                        <option key={w.code} value={w.code}>
                          {w.name} {parseReleaseState(w.releaseState) === ReleaseState.ONLINE ? '(已上线)' : '(未上线)'}
                        </option>
                      ))}
                    </select>
                    {taskNameCheck?.exists && (
                      <div className="submit-scheduler__name-check-hint submit-scheduler__name-check-hint--warning">
                        <AlertTriangle size={12} />
                        <span>
                          工作流「{taskNameCheck.workflowName}」中已存在同名任务「{currentMapping?.taskName}」
                          ，提交后将创建同名任务节点，可能产生冲突
                        </span>
                      </div>
                    )}
                  </>
                )}
              </div>

              <div className="submit-scheduler__section">
                <div className="submit-scheduler__section-title">执行配置</div>
                <div className="submit-scheduler__field">
                  <label className="submit-scheduler__label">Worker组</label>
                  <select
                    className="submit-scheduler__select"
                    value={selectedWorkerGroup}
                    onChange={e => setSelectedWorkerGroup(e.target.value)}
                  >
                    {workerGroups.length > 0 ? (
                      workerGroups.map(wg => (
                        <option key={wg.workerGroup} value={wg.workerGroup}>{wg.workerGroup}</option>
                      ))
                    ) : (
                      <option value="default">default</option>
                    )}
                  </select>
                </div>
                <div className="submit-scheduler__field">
                  <label className="submit-scheduler__label">执行环境</label>
                  <select
                    className="submit-scheduler__select"
                    value={selectedEnvironmentCode}
                    onChange={e => setSelectedEnvironmentCode(parseInt(e.target.value))}
                  >
                    <option value={-1}>默认环境</option>
                    {envList
                      .filter(env => !selectedWorkerGroup || !env.workerGroups || env.workerGroups.length === 0 || env.workerGroups.includes(selectedWorkerGroup))
                      .map(env => (
                        <option key={env.code} value={env.code}>{env.name}{env.description ? ` (${env.description})` : ''}</option>
                      ))}
                  </select>
                </div>
              </div>
            </>
          )}

          {step === 'submitting' && (
            <div className="submit-scheduler__status">
              <Loader2 size={32} className="submit-scheduler__spin" />
              <span>正在提交到调度系统...</span>
            </div>
          )}

          {step === 'success' && successInfo && (
            <div className="submit-scheduler__status submit-scheduler__status--success">
              <CheckCircle size={32} />
              <span>提交成功！</span>
              <div className="submit-scheduler__success-detail">
                <div>项目: {successInfo.projectName}</div>
                <div>工作流: {successInfo.workflowName}</div>
              </div>
            </div>
          )}

          {step === 'error' && errorMsg && (
            <div className="submit-scheduler__status submit-scheduler__status--error">
              <AlertTriangle size={32} />
              <span>提交失败</span>
              <div className="submit-scheduler__error-detail">{errorMsg}</div>
              <button
                className="submit-scheduler__retry-btn"
                onMouseDown={(e) => { e.preventDefault(); setStep('config'); setErrorMsg(null); }}
              >
                重试
              </button>
            </div>
          )}
        </div>

        {step === 'config' && (
          <div className="submit-scheduler__footer">
            <button
              className="submit-scheduler__cancel-btn"
              onMouseDown={(e) => { e.preventDefault(); onClose(); }}
            >
              取消
            </button>
            <button
              className="submit-scheduler__validate-btn"
              onMouseDown={(e) => {
                e.preventDefault();
                handleValidate();
              }}
            >
              {isCompiling ? <Loader2 size={14} className="submit-scheduler__spin" /> : <Shield size={14} />}
              <span>{isCompiling ? '编译校验中...' : '校验'}</span>
            </button>
            <button
              className="submit-scheduler__submit-btn"
              onMouseDown={(e) => {
                e.preventDefault();
                handleSubmit();
              }}
            >
              <Send size={14} />
              <span>提交</span>
            </button>
          </div>
        )}

        {(step === 'success' || step === 'error') && (
          <div className="submit-scheduler__footer">
            <button
              className="submit-scheduler__cancel-btn"
              onMouseDown={(e) => { e.preventDefault(); onClose(); }}
            >
              关闭
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default SubmitToSchedulerModal;
