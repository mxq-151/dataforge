import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { X, Send, Loader2, FolderKanban, GitBranch, CheckCircle, AlertTriangle, Shield, Database, Info } from 'lucide-react';
import type { DolphinSchedulerApi, DSProject, DSWorkflowDefinition, DSTaskType, DSDataSource, DSWorkerGroup, DSEnvironment, DSWorkflowTaskNode } from '../../types/dolphinscheduler';
import { TASK_TYPE_LABELS, ReleaseState, Priority, parseReleaseState } from '../../types/dolphinscheduler';
import type { CodeFileMapping, SavedConfig, ValidationError } from '../../utils/schedulerMapping';
import { buildWorkflowFromCodeFile, validateSubmission, getAvailableTaskTypes, mapCodeFileToTask, sanitizeDsName, validateYarnJobName, buildDependentTaskNode, buildJarsArg, type ResolvedDependency } from '../../utils/schedulerMapping';
import { type CompileResult } from '../../services/compileService';
import { unifiedCompile } from '../../services/unifiedCompile';
import { validateFileHeader } from '../../utils/index';
import { splitPath, getBaseName } from '../../utils/pathUtils';
import { useToast } from '../../components/Toast';
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

interface DependencyResolution {
  found: boolean;
  projectCode: number | null;
  definitionCode: number | null;
  taskCode: number | null;
  /** 前置任务名称（原始值，未净化） */
  taskName: string;
  /** label：{调度项目}.{前置任务名称} */
  label: string;
}

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
  const toast = useToast();
  const [step, setStep] = useState<SubmitStep>('config');
  const [projects, setProjects] = useState<DSProject[]>([]);
  const [selectedProjectCode, setSelectedProjectCode] = useState<number | null>(null);
  const [selectedWorkflowCode, setSelectedWorkflowCode] = useState<number | null>(null);
  const [workflowName, setWorkflowName] = useState('');
  const [taskName, setTaskName] = useState('');
  const [workflowDesc, setWorkflowDesc] = useState('');
  const [autoOnline, setAutoOnline] = useState(false);
  const [autoTrigger, setAutoTrigger] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successInfo, setSuccessInfo] = useState<{ projectName: string; workflowName: string } | null>(null);
  const [selectedTaskType, setSelectedTaskType] = useState<DSTaskType | null>(null);
  const [validationErrors, setValidationErrors] = useState<ValidationError[]>([]);
  const [showValidation, setShowValidation] = useState(false);
  const [validationPassed, setValidationPassed] = useState(false);
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
      // 除「其他参数(others)」外，所有输入项均以当前文件的推导值 + 默认值重建，不记忆上一次的编辑值；
      // 每次点开「提交调度」都会重新填充。others 单独保留上一次的取值，方便跨会话沿用。
      setTaskTypeParams(prev => {
        const preservedOthers = (prev && typeof prev.others === 'string' && prev.others.trim())
          ? prev.others
          : '';
        const merged: Record<string, string | boolean> = { ...defaults, ...fromMapping };
        if (preservedOthers) merged.others = preservedOthers;
        return merged;
      });
    } else {
      setTaskTypeParams({});
    }
  }, [currentMapping?.taskType, fileName, filePath, visible]);

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
      // 主Jar包每次关闭/重开时置空，须在本次校验（编译）通过后再生成，避免沿用上一次编译残留
      setTaskTypeParams(prev => ({ ...prev, mainJar: '' }));
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
      // 工作流/任务名称中的斜杠、反斜杠统一替换为下划线，保证 DS 名称合法
      setWorkflowName(initialMapping.workflowName.replace(/[/\\]/g, '_'));
      setTaskName(initialMapping.taskName.replace(/[/\\]/g, '_') || fileName.replace(/\.[^.]+$/, ''));
      setWorkflowDesc(initialMapping.description);
    }
  }, [visible, initialMapping]);

  useEffect(() => {
    if (!visible || !dsApi) return;

    const loadProjects = async () => {
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
      }
    };

    loadProjects();
  }, [visible, dsApi, projectCode]);

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
          // 工作流已存在：记录其 code，触发任务存在性检测，并在提交时走「更新工作流」路径
          setSelectedWorkflowCode(exactMatch.code);
        } else {
          setWorkflowNameCheck({ exists: false, isOnline: false });
          setSelectedWorkflowCode(null);
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

  /**
   * 扫描指定调度项目中所有工作流的任务节点，确认代码头 @依赖 声明的每个前置任务是否存在。
   * 返回 Map，key 为 {调度项目}.{前置任务名称}，value 为解析结果；找不到的 found=false。
   * 仅当代码头声明了 @依赖 时才真正发起查询，否则返回空 Map。
   */
  const scanHeaderDependencyTasks = useCallback(
    async (projectCodeNum: number | null): Promise<Map<string, DependencyResolution>> => {
      const declaredDeps = currentMapping?.headerDependencies || [];
      const resultMap = new Map<string, DependencyResolution>();
      if (!dsApi || !projectCodeNum || declaredDeps.length === 0) return resultMap;

      try {
        const wfRes = await dsApi.workflowDefinition.list(projectCodeNum, { pageNo: 1, pageSize: 100 });
        const defs = wfRes.code === 0 && wfRes.data?.totalList ? wfRes.data.totalList : [];
        // taskName(净化后) -> { 项目code, 工作流code, 任务code }（同名只取首个）
        const byName = new Map<string, { projectCode: number; definitionCode: number; taskCode: number }>();
        for (const def of defs) {
          try {
            const dRes = await dsApi.workflowDefinition.detail(projectCodeNum, def.code);
            if (dRes.code === 0 && dRes.data) {
              for (const node of dRes.data.taskNodes) {
                const san = sanitizeDsName(node.name);
                if (san && !byName.has(san)) {
                  byName.set(san, { projectCode: projectCodeNum, definitionCode: def.code, taskCode: node.code });
                }
              }
            }
          } catch { /* 单个工作流查询失败则跳过 */ }
        }

        for (const dep of declaredDeps) {
          const label = [dep.projectCode, dep.taskName].filter(Boolean).join('.');
          const hit = byName.get(sanitizeDsName(dep.taskName));
          resultMap.set(label, hit
            ? { found: true, projectCode: hit.projectCode, definitionCode: hit.definitionCode, taskCode: hit.taskCode, taskName: dep.taskName, label }
            : { found: false, projectCode: null, definitionCode: null, taskCode: null, taskName: dep.taskName, label });
        }
      } catch {
        // 查询失败时视为全部未解析，交由上层按"前置任务不存在"处理
      }
      return resultMap;
    },
    [dsApi, currentMapping],
  );

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

    // 代码头 @依赖 声明的前置任务存在性校验：前置任务不存在时提示用户
    if ((currentMapping?.headerDependencies?.length || 0) > 0 && selectedProjectCode) {
      const depRes = await scanHeaderDependencyTasks(selectedProjectCode);
      for (const [label, r] of depRes) {
        if (!r.found) {
          errors.push({
            field: 'dependency',
            message: `代码头 @依赖 声明的前置任务「${label}」在调度项目中不存在，请先在调度系统中创建该前置任务后再提交`,
          });
        }
      }
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
          // 拼接资源中心根目录 baseDir，与实际提交时上传返回的资源路径保持一致
          let baseDir = '/';
          try {
            if (dsApi) {
              const baseDirRes = await dsApi.resource.queryBaseDir('FILE');
              if (baseDirRes.code === 0 && baseDirRes.data) {
                baseDir = baseDirRes.data;
              }
            }
          } catch { /* use default */ }
          const mainJarPreview = [baseDir.replace(/\/+$/, ''), ...previewSegments].join('/');
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
    setValidationPassed(passed);
    return errors;
  }, [effectiveMapping, currentMapping, selectedProjectCode, workflowName, selectedWorkflowCode, isRealApi, projectCode, projects, projectMismatch, needsDatasource, selectedDatasourceId, codeDatasourceName, datasourceMismatch, isCompilableTask, compileConfig, fileName, codeContent, filePath, rootPath, savedConfig, scanHeaderDependencyTasks]);

  const handleSubmit = useCallback(async () => {

    if (!effectiveMapping || !selectedProjectCode || !dsApi) return;

    // 提交前通过接口校验代码头 @依赖 声明的前置任务是否存在；存在缺失时不允许提交并提示用户先创建前置任务
    const dependencyMap = (currentMapping?.headerDependencies?.length || 0) > 0
      ? await scanHeaderDependencyTasks(selectedProjectCode)
      : new Map<string, DependencyResolution>();
    const resolvedDeps: ResolvedDependency[] = [];
    const missingDepLabels: string[] = [];
    dependencyMap.forEach(r => {
      if (!r.found) {
        missingDepLabels.push(r.label);
        return;
      }
      if (r.projectCode != null && r.definitionCode != null && r.taskCode != null) {
        resolvedDeps.push({
          projectCode: r.projectCode,
          definitionCode: r.definitionCode,
          taskCode: r.taskCode,
          taskName: r.taskName,
          label: r.label,
        });
      }
    });
    if (missingDepLabels.length > 0) {
      const depMsg = missingDepLabels.length === 1
        ? `代码头 @依赖 声明的前置任务「${missingDepLabels[0]}」在调度项目中不存在`
        : `代码头 @依赖 声明的前置任务「${missingDepLabels.join('」、『')}」在调度项目中不存在`;
      toast.error(`${depMsg}，请先在调度系统中创建前置依赖后再提交`);
      setShowValidation(true);
      setStep('config');
      return;
    }

    setStep('submitting');
    setErrorMsg(null);

    const mappingWithDatasource = { ...effectiveMapping };
    // 以用户在「任务名称」输入框填写的值为准（净化掉反斜杠、斜杠等非法字符）
    mappingWithDatasource.taskName = sanitizeDsName(taskName) || mappingWithDatasource.taskName;
    // 任务描述以用户填写值为准（新建/更新任务节点时均使用该描述）
    mappingWithDatasource.description = workflowDesc;
    if (needsDatasource && selectedDatasourceId) {
      const updatedParams = { ...mappingWithDatasource.taskParams };
      updatedParams.datasource = selectedDatasourceId;
      const selectedDs = dsDataSources.find(ds => ds.id === selectedDatasourceId);
      if (selectedDs) {
        updatedParams.type = selectedDs.type;
      }
      mappingWithDatasource.taskParams = updatedParams;
    }

    // 为 Spark 任务注入 OpenLineage 固定参数（支持文件级血缘管理配置覆盖/关闭全局设置）
    if (mappingWithDatasource.taskType === 'SPARK') {
      // 从文件配置（savedConfig.taskParams）读取血缘管理保留参数 lineage.*
      const lineageCfg: Record<string, string> = {};
      (savedConfig?.taskParams || []).forEach(p => {
        if (p.key && p.key.startsWith('lineage.')) lineageCfg[p.key] = p.value;
      });
      const lineageConfigured = Object.prototype.hasOwnProperty.call(lineageCfg, 'lineage.enabled');
      const lineageEnabled = lineageCfg['lineage.enabled'] !== 'false';
      // 未显式配置血缘时保持默认注入行为（向后兼容）；显式关闭则跳过注入
      if (!lineageConfigured || lineageEnabled) {
        const updatedParams = { ...mappingWithDatasource.taskParams };
        const openlineageConfs: string[] = [
          '--conf spark.extraListeners=io.openlineage.spark.agent.OpenLineageSparkListener',
          '--conf spark.openlineage.transport.type=http',
        ];
        const transportUrl = lineageCfg['lineage.transportUrl'] || openlineageTransportUrl;
        if (transportUrl) {
          openlineageConfs.push(`--conf spark.openlineage.transport.url=${transportUrl}`);
        }
        const namespace = lineageCfg['lineage.namespace'] || projectCode;
        if (namespace) {
          openlineageConfs.push(`--conf spark.openlineage.namespace=${namespace}`);
        }
        const existingOthers = ((updatedParams.others as string) || '').replace(/\r?\n/g, ' ').trim();
        // 自定义 jar 通过 --jars 跟随提交（仅 SPARK）：路径为 {basePath}/{jarPath}。
        // 在提交时动态拼接，避免 --jars 污染弹窗「其他参数」输入框（该输入框仅承载用户手填命令）
        const jarsArg = buildJarsArg((savedConfig?.dependencies || []).filter(d => d.source === 'custom'));
        const segments: string[] = [];
        if (jarsArg) segments.push(`--jars ${jarsArg}`);
        if (existingOthers) segments.push(existingOthers);
        segments.push(openlineageConfs.join(' '));
        // 所有 spark-submit 执行命令拼成单行（用空格连接，不做换行），避免提交后执行命令被拆成多行
        updatedParams.others = segments.join(' ');
        mappingWithDatasource.taskParams = updatedParams;
      }
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

    // 前置依赖已在上方开头解析（resolvedDeps），缺失时已阻止提交

    try {
      const targetProject = projects.find(p => p.code === selectedProjectCode);
      const projectName = targetProject?.name || '';

      if (selectedWorkflowCode) {
        const detailRes = await dsApi.workflowDefinition.detail(selectedProjectCode, selectedWorkflowCode);
        if (detailRes.code === 0 && detailRes.data) {
          const { taskNodes, edges, globalParams, workflowDefinition } = detailRes.data;

          // 判断工作流中是否已存在同名任务：存在则原地更新内容（保留原 code 以维持既有边关系），
          // 不再新增重复节点，也不在任务之间建立前后依赖
          const sanitizedTaskName = sanitizeDsName(mappingWithDatasource.taskName);
          const existingIndex = taskNodes.findIndex(node => sanitizeDsName(node.name) === sanitizedTaskName);
          const existingCodes = taskNodes.map(n => n.code);
          const taskCode = existingIndex >= 0
            ? taskNodes[existingIndex].code
            : (Date.now() > Math.max(0, ...existingCodes) ? Date.now() : Math.max(0, ...existingCodes) + 1);
          const depCode = Math.max(taskCode, 0, ...existingCodes) + 1;

          console.log('[SubmitToSchedulerModal] 提交前 taskParams=', mappingWithDatasource.taskParams);
          console.log('[SubmitToSchedulerModal] taskParams.others=', mappingWithDatasource.taskParams?.others);

          const newNode: import('../../types/dolphinscheduler').DSWorkflowTaskNode = {
            code: taskCode,
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
            x: existingIndex >= 0 ? taskNodes[existingIndex].x : 200 + taskNodes.length * 200,
            y: existingIndex >= 0 ? taskNodes[existingIndex].y : 100 + (taskNodes.length % 3) * 100,
          };

          let updatedNodes: import('../../types/dolphinscheduler').DSWorkflowTaskNode[];
          let updatedEdges: import('../../types/dolphinscheduler').DSWorkflowEdge[] = [...edges];

          if (existingIndex >= 0) {
            // 同名任务已存在：用新内容替换该节点，保持其 code 与既有边，不新增串行边
            updatedNodes = taskNodes.map((n, i) => (i === existingIndex ? newNode : n));
          } else {
            // 不存在同名任务：追加新节点，并与原最后一个任务串行连接
            updatedNodes = [...taskNodes, newNode];
            if (taskNodes.length > 0) {
              const lastNode = taskNodes[taskNodes.length - 1];
              updatedEdges.push({
                id: `e_${lastNode.code}_${taskCode}`,
                sourceCode: lastNode.code,
                targetCode: taskCode,
              });
            }
          }

          // 根据代码头 @依赖 配置前置任务依赖：构建 DEPENDENT 任务节点作为主任务（新建或更新）的前置
          if (resolvedDeps.length > 0) {
            const depNode = buildDependentTaskNode(resolvedDeps, depCode);
            updatedNodes.push(depNode);
            updatedEdges.push({
              id: `e_${depCode}_${taskCode}`,
              sourceCode: depCode,
              targetCode: taskCode,
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

        // 根据代码头 @依赖 配置前置任务依赖：在新建工作流中插入 DEPENDENT 前置节点并建立边关系
        if (resolvedDeps.length > 0) {
          const mainNode = workflowData.nodes[0];
          const depCode = mainNode.code + 1;
          const depNode = buildDependentTaskNode(resolvedDeps, depCode);
          workflowData.nodes = [depNode, mainNode];
          workflowData.edges = [{
            id: `e_${depCode}_${mainNode.code}`,
            sourceCode: depCode,
            targetCode: mainNode.code,
          }];
        }

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
    currentMapping, scanHeaderDependencyTasks,
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

              {currentMapping && currentMapping.headerDependencies.length > 0 && (
                <div className="submit-scheduler__section">
                  <div className="submit-scheduler__section-title">
                    <GitBranch size={14} />
                    前置依赖
                  </div>
                  <div className="submit-scheduler__deps-list">
                    {currentMapping.headerDependencies.map((dep, idx) => (
                      <span key={idx} className="submit-scheduler__dep-tag">
                        {[dep.projectCode, dep.taskName].filter(Boolean).join('.')}
                      </span>
                    ))}
                  </div>
                  <div className="submit-scheduler__deps-hint">
                    提交时将根据代码头 @依赖 创建前置依赖任务，等待以上任务完成后运行
                  </div>
                </div>
              )}

              <div className="submit-scheduler__section">
                <div className="submit-scheduler__section-title">
                  <FolderKanban size={14} />
                  目标项目
                </div>

                <div className="submit-scheduler__field">
                  <div className="submit-scheduler__field-row">
                    <label className="submit-scheduler__label">调度项目</label>
                    {matchedProject ? (
                      <div className="submit-scheduler__name-check-hint submit-scheduler__name-check-hint--ok">
                        <CheckCircle size={12} />
                        <span>调度项目「{projectCode}」已存在，提交后将使用该调度项目</span>
                      </div>
                    ) : projectCode ? (
                      <div className="submit-scheduler__name-check-hint submit-scheduler__name-check-hint--warning">
                        <AlertTriangle size={12} />
                        <span>调度系统中不存在项目「{projectCode}」，必须先在调度管理中创建该调度项目后才能提交</span>
                      </div>
                    ) : null}
                  </div>
                  <input
                    className="submit-scheduler__input"
                    value={matchedProject ? `${matchedProject.name}（${projectCode}）` : (projectCode ? `未匹配项目编码：${projectCode}` : '未识别到项目编码')}
                    readOnly
                    disabled
                  />
                </div>

                <div className="submit-scheduler__field">
                  <div className="submit-scheduler__field-row">
                    <label className="submit-scheduler__label">工作流名称</label>
                    {isCheckingName ? (
                      <div className="submit-scheduler__name-check-hint submit-scheduler__name-check-hint--loading">
                        <Loader2 size={12} className="submit-scheduler__spin" />
                        <span>正在检查工作流名称...</span>
                      </div>
                    ) : (selectedWorkflowCode || workflowNameCheck?.exists) ? (
                      <div className="submit-scheduler__name-check-hint submit-scheduler__name-check-hint--warning">
                        <AlertTriangle size={12} />
                        <span>工作流「{workflowName}」已存在，提交后将更新该工作流</span>
                      </div>
                    ) : workflowNameCheck && !workflowNameCheck.exists ? (
                      <div className="submit-scheduler__name-check-hint submit-scheduler__name-check-hint--ok">
                        <CheckCircle size={12} />
                        <span>工作流「{workflowName}」不存在，提交后将自动创建</span>
                      </div>
                    ) : null}
                  </div>
                  <input className="submit-scheduler__input" value={workflowName} readOnly disabled placeholder="由文件目录自动生成" />
                </div>

                <div className="submit-scheduler__field">
                  <div className="submit-scheduler__field-row">
                    <label className="submit-scheduler__label">任务名称</label>
                    {(selectedWorkflowCode || workflowNameCheck?.exists) && taskNameCheck?.exists ? (
                      <div className="submit-scheduler__name-check-hint submit-scheduler__name-check-hint--warning">
                        <AlertTriangle size={12} />
                        <span>工作流中已存在任务「{taskName}」，提交后将更新该任务内容</span>
                      </div>
                    ) : (selectedWorkflowCode || workflowNameCheck?.exists) ? (
                      <div className="submit-scheduler__name-check-hint submit-scheduler__name-check-hint--ok">
                        <CheckCircle size={12} />
                        <span>工作流中将自动创建任务「{taskName}」</span>
                      </div>
                    ) : (
                      <div className="submit-scheduler__name-check-hint submit-scheduler__name-check-hint--ok">
                        <CheckCircle size={12} />
                        <span>提交后将随新工作流自动创建任务「{taskName}」</span>
                      </div>
                    )}
                  </div>
                  <input className="submit-scheduler__input" value={taskName} readOnly disabled placeholder="由文件名自动生成" />
                </div>

                <div className="submit-scheduler__field">
                  <label className="submit-scheduler__label">任务描述</label>
                  <input
                    className="submit-scheduler__input"
                    value={workflowDesc}
                    onChange={e => setWorkflowDesc(e.target.value)}
                    placeholder="工作流描述（可选）"
                  />
                </div>
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
              disabled={!validationPassed}
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
