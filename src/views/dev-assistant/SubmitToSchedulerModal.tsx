import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { X, Send, Loader2, FolderKanban, GitBranch, CheckCircle, AlertTriangle, Shield, Database, Info } from 'lucide-react';
import type { DolphinSchedulerApi, DSProject, DSWorkflowDefinition, DSTaskType, DSDataSource, DSWorkerGroup, DSEnvironment, DSWorkflowTaskNode } from '../../types/dolphinscheduler';
import { TASK_TYPE_LABELS, ReleaseState, Priority, parseReleaseState } from '../../types/dolphinscheduler';
import type { CodeFileMapping, SavedConfig, ValidationError } from '../../utils/schedulerMapping';
import { buildWorkflowFromCodeFile, validateSubmission, getAvailableTaskTypes, mapCodeFileToTask, sanitizeDsName, validateYarnJobName, buildDependentTaskNode, buildJarsArg, parseDependencyHeader, reconcileWorkflowDependencies, findDependencyCycle, dependentNodeName, layoutWorkflowByDependency, type ResolvedDependency, type HeaderDependency } from '../../utils/schedulerMapping';
import { type CompileResult } from '../../services/compileService';
import { unifiedCompile } from '../../services/unifiedCompile';
import { validateFileHeader, parseFileHeader } from '../../utils/fileHeader';
import { splitPath, getBaseName } from '../../utils/pathUtils';
import { useToast } from '../../components/Toast';
import DeployEnvRadio from './DeployEnvRadio';
import { DEFAULT_DEPLOY_ENV, withDeployEnvSuffix, shouldInjectLineage, type DeployEnv } from '../../utils/deployEnv';
import { buildOpenLineageArgs, extractLineageParams } from '../../utils/lineageParams';
import { buildTaskAppName, taskTypeHasAppName } from '../../utils/appName';
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

// 数值型任务参数非负校验：默认值为负数的参数（如 cpuQuota/memoryMax 的 -1 表示不限制）除外。
// 提取为独立函数，供校验（不重复触发编译）与提交（轻量再校验）两处复用。
interface TaskTypeParamDef {
  key: string;
  label: string;
  type: string;
  default?: string | number | boolean;
}

function collectNegativeNumericErrors(
  params: TaskTypeParamDef[],
  values: Record<string, string | boolean>,
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const param of params) {
    if (param.type !== 'number' || Number(param.default ?? 0) < 0) continue;
    const raw = values[param.key];
    if (raw !== undefined && raw !== '' && Number(raw) < 0) {
      errors.push({ field: `taskParam.${param.key}`, message: `${param.label}不能为负数` });
    }
  }
  return errors;
}

// 工作流 DAG 节点网格布局常量：节点间距需大于节点尺寸（约 270 x 110），避免节点过近紧挨。
// 采用每行 3 列的网格排布，横向间距 450、纵向间距 260，整体更均匀美观。
const GRID_COLS = 3;
const GRID_GAP_X = 450;
const GRID_GAP_Y = 260;
const GRID_START_X = 300;
const GRID_START_Y = 140;

/** 根据顺序索引计算网格中的节点坐标（每 COL 个换一行） */
function gridPos(index: number): { x: number; y: number } {
  const col = index % GRID_COLS;
  const row = Math.floor(index / GRID_COLS);
  return {
    x: GRID_START_X + col * GRID_GAP_X,
    y: GRID_START_Y + row * GRID_GAP_Y,
  };
}

/**
 * 对提交前的工作流节点做最小间距强制：凡是在横向(GRID_GAP_X)与纵向(GRID_GAP_Y)两个方向
 * 上都与其它节点过近（紧挨/重叠）的节点，统一向右推至保持最小间距。
 * 这样即便旧工作流中已存在坐标过近的节点，重新提交时也会被自动拉开。
 */
function enforceMinSpacing(nodes: import('../../types/dolphinscheduler').DSWorkflowTaskNode[]): void {
  if (nodes.length < 2) return;
  // 稳定顺序：先按 x 再按 y，保证结果可复现
  const order = nodes
    .map((n, i) => ({ n, i }))
    .sort((a, b) => (a.n.x - b.n.x) || (a.n.y - b.n.y) || (a.i - b.i));
  const placed = new Map<number, { x: number; y: number }>();

  for (const { n } of order) {
    let x = n.x;
    let y = n.y;
    let guard = 0;
    const maxGuard = Math.max(nodes.length * 4, 8);
    let moved = true;

    while (moved && guard++ < maxGuard) {
      moved = false;
      for (const [code, p] of placed) {
        if (code === n.code) continue;
        const dx = x - p.x;
        const dy = y - p.y;
        // 仅当横向与纵向都过近时才视为紧挨，向右错开一列间距
        if (Math.abs(dx) < GRID_GAP_X && Math.abs(dy) < GRID_GAP_Y) {
          x = p.x + GRID_GAP_X;
          moved = true;
        }
      }
    }
    placed.set(n.code, { x, y });
  }

  for (const n of nodes) {
    const p = placed.get(n.code);
    if (p) {
      n.x = p.x;
      n.y = p.y;
    }
  }
}

// —— 提交调度「记住上一次配置」——
// 通过 localStorage 按任务类型记住常用的运行参数（内存/CPU/运行模式/实例数等），
// 以及全局的调度运行环境（worker 组 / 环境），下次打开时自动回填。
const DS_REMEMBER_KEY = 'ds-submit-remember-v1';

/** 记忆对象：taskTypes 按任务类型存常用运行参数；workerGroup/environmentCode 为调度运行环境 */
interface DSRememberState {
  taskTypes: Record<string, Record<string, string | boolean>>;
  workerGroup?: string;
  environmentCode?: number;
}

function loadRemember(): DSRememberState {
  try {
    const raw = localStorage.getItem(DS_REMEMBER_KEY);
    if (!raw) return { taskTypes: {} };
    const parsed = JSON.parse(raw);
    return {
      taskTypes: parsed && typeof parsed.taskTypes === 'object' ? parsed.taskTypes : {},
      workerGroup: typeof parsed?.workerGroup === 'string' ? parsed.workerGroup : undefined,
      environmentCode: typeof parsed?.environmentCode === 'number' ? parsed.environmentCode : undefined,
    };
  } catch {
    return { taskTypes: {} };
  }
}

/** 程序/文件推导类字段不参与记忆，避免跨文件串值（mainArgs/others 属于用户填写，可记忆） */
const REMEMBER_EXCLUDE_KEYS = new Set([
  'mainJar', 'mainClass', 'appName', 'connParams',
  'displayRows', 'sqlType', 'programType',
]);

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
  /** 由文件目录推导的基础工作流名称（未加环境后缀） */
  const [baseWorkflowName, setBaseWorkflowName] = useState('');
  /** 部署环境（生产/灰度/测试，默认测试）：拼在基础名末尾构成最终工作流名称 */
  const [deployEnv, setDeployEnv] = useState<DeployEnv>(DEFAULT_DEPLOY_ENV);
  /**
   * 实际提交给调度系统的工作流名称 = 基础名 + 环境后缀（如 `olist_code_ods_test`）。
   * 由基础名与环境派生，不再用 state——避免「改环境后忘记同步名称」这类不同步 bug。
   *
   * 历史：这里原先按「同前缀工作流的定时调度状态」自动生成 `_v{N}` 版本后缀（每次提交一个新版本，
   * 避免覆盖已定时调度的版本）。现改为按环境区分同名工作流：环境不同→名称不同→各自独立，
   * 同一环境重复提交则原地更新，版本链已整体移除（`computeVersionedWorkflowName` 一并删除）。
   */
  const workflowName = useMemo(
    () => withDeployEnvSuffix(baseWorkflowName, deployEnv),
    [baseWorkflowName, deployEnv],
  );
  const [taskName, setTaskName] = useState('');
  const [workflowDesc, setWorkflowDesc] = useState('');
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

  /**
   * 任务节点的「应用名称」= `{项目}.{工作流}.{任务}`（见 utils/appName.ts）。
   *
   * 三段都与界面上的基本信息同源：项目 = 调度项目名称（= 项目编码，未匹配到列表时用编码兜底）、
   * 工作流 = **含环境后缀的最终工作流名称**、任务 = 与提交时同口径的任务名（sanitizeDsName）。
   * 因此改环境 / 改工作流名 / 改任务名，应用名称都会跟着变，且不允许手改。
   * 仅对带「应用名称」项的任务类型（SPARK / FLINK / MR）生成。
   */
  const appNameAuto = useMemo(() => {
    if (!currentMapping || !taskTypeHasAppName(currentMapping.taskType)) return undefined;
    return buildTaskAppName({
      project: matchedProject?.name || projectCode || '',
      workflow: workflowName,
      task: sanitizeDsName(taskName) || taskName,
    }) || undefined;
  }, [currentMapping?.taskType, matchedProject, projectCode, workflowName, taskName]);

  // 用户可编辑的任务参数签名（排除 mainJar）：mainJar 是校验成功时由编译结果回填的派生值，
  // 若按整对象监听，则校验通过后 setTaskTypeParams(mainJar) 会再次触发重置，导致提交按钮仍不可用。
  const userTaskParamsSignature = useMemo(
    () => Object.entries(taskTypeParams)
      .filter(([k]) => k !== 'mainJar')
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join('|'),
    [taskTypeParams],
  );

  useEffect(() => {
    setValidationPassed(false);
  }, [selectedProjectCode, selectedWorkflowCode, workflowName, selectedTaskType, selectedDatasourceId, selectedWorkerGroup, selectedEnvironmentCode, userTaskParamsSignature]);

  const needsDatasource = currentMapping ? DATASOURCE_REQUIRED_TYPES.includes(currentMapping.taskType) : false;

  const codeDatasourceName = currentMapping?.dataSource || null;

  const currentTaskTypeConfig = useMemo(() => {
    if (!currentMapping) return null;
    return TASK_TYPE_PARAMS_CONFIG[currentMapping.taskType] || null;
  }, [currentMapping?.taskType]);

  /**
   * 代码头声明的节点参数签名（见 utils/headerTaskParams.ts）。
   *
   * 用途：把「代码头改了」精确地变成回填 effect 的依赖 —— 直接依赖 headerTaskParams 对象会每次
   * 重算都换引用、反复重置用户手填值；用签名字符串则只在代码头取值真的变了才重跑。
   */
  const headerParamsSignature = useMemo(
    () => Object.entries(currentMapping?.headerTaskParams || {})
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join('|'),
    [currentMapping?.headerTaskParams],
  );

  /** 代码头声明的节点参数提示（已写入的项 + 未能落到字段的项），无内容时为 null */
  const headerParamNotice = useMemo(() => {
    if (!currentMapping) return null;
    const applied = currentMapping.headerParamHits || [];
    const unmapped = currentMapping.headerParamUnmapped || [];
    if (applied.length === 0 && unmapped.length === 0) return null;
    const keys: string[] = [];
    for (const hit of applied) {
      if (hit.key && !keys.includes(hit.key)) keys.push(hit.key);
    }
    return { keys, unmapped };
  }, [currentMapping]);

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
      // 除「其他参数(others)」外，输入项以 默认值 + 文件推导值 为基础，再叠加 localStorage 中
      // 记住的上一次运行参数（内存/CPU/运行模式/实例数等），使重复提交沿用之前的取值。
      const remembered = loadRemember().taskTypes[currentMapping.taskType] || {};
      setTaskTypeParams(prev => {
        const preservedOthers = (prev && typeof prev.others === 'string' && prev.others.trim())
          ? prev.others
          : '';
        const merged: Record<string, string | boolean> = { ...defaults, ...fromMapping };
        for (const [k, v] of Object.entries(remembered)) {
          if (REMEMBER_EXCLUDE_KEYS.has(k)) continue;
          merged[k] = typeof v === 'boolean' ? v : String(v);
        }
        // 代码头声明优先级最高：压过默认值、文件推导值与「上次记住的取值」。
        // 唯一让位给用户的是本次已在弹窗里手改的「其他参数」（preservedOthers，见下）。
        // 只接受本任务类型确实存在的配置项：别名表与本表一旦不一致，宁可不写，
        // 也不让脏键混进 taskParams 一起提交给调度（submitOrderSimulation 会校验参数名）。
        const knownKeys = new Set(currentTaskTypeConfig.params.map(param => param.key));
        for (const [k, v] of Object.entries(currentMapping.headerTaskParams || {})) {
          if (!knownKeys.has(k)) continue;
          if (v === undefined || v === null || v === '') continue;
          merged[k] = typeof v === 'boolean' ? v : String(v);
        }
        if (preservedOthers) merged.others = preservedOthers;
        return merged;
      });
    } else {
      setTaskTypeParams({});
    }
  }, [currentMapping?.taskType, fileName, filePath, visible, headerParamsSignature]);

  const applyTaskTypeParamsToMapping = useCallback((mapping: CodeFileMapping | null): CodeFileMapping | null => {
    if (!mapping) return mapping;
    // 即便没有任何可编辑的运行参数，也要把派生的应用名称写进去
    if (Object.keys(taskTypeParams).length === 0) {
      return appNameAuto ? { ...mapping, taskParams: { ...mapping.taskParams, appName: appNameAuto } } : mapping;
    }

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

    // 应用名称是派生值（不在 taskTypeParams 里，字段只读），这里显式覆盖，
    // 保证「用户没动过这个字段」时提交的也是 {项目}.{工作流}.{任务}
    if (appNameAuto) updatedParams.appName = appNameAuto;

    return { ...mapping, taskParams: updatedParams };
  }, [taskTypeParams, appNameAuto]);

  const effectiveMapping = useMemo(() => {
    return applyTaskTypeParamsToMapping(currentMapping);
  }, [currentMapping, applyTaskTypeParamsToMapping]);

  // 将当前的常用运行参数（按任务类型）与调度运行环境（worker 组 / 环境）写入 localStorage，
  // 供下次打开「提交调度」时自动回填。
  const persistRememberNow = useCallback(() => {
    const taskType = currentMapping?.taskType;
    if (!taskType) return;
    try {
      const state = loadRemember();
      const taskMap = { ...(state.taskTypes[taskType] || {}) };
      for (const [k, v] of Object.entries(taskTypeParams)) {
        if (REMEMBER_EXCLUDE_KEYS.has(k)) continue;
        if (v !== undefined && v !== null && v !== '') taskMap[k] = v;
      }
      state.taskTypes[taskType] = taskMap;
      if (selectedWorkerGroup) state.workerGroup = selectedWorkerGroup;
      if (selectedEnvironmentCode !== -1) state.environmentCode = selectedEnvironmentCode;
      localStorage.setItem(DS_REMEMBER_KEY, JSON.stringify(state));
    } catch { /* 忽略写入失败 */ }
  }, [currentMapping?.taskType, taskTypeParams, selectedWorkerGroup, selectedEnvironmentCode]);

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
      setBaseWorkflowName('');
      // 环境每次打开都回到默认「测试」，不做记忆（避免上次选了生产、这次没注意直接提交）
      setDeployEnv(DEFAULT_DEPLOY_ENV);
      setWorkflowDesc('');
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
      // 工作流/任务名称中的斜杠、反斜杠统一替换为下划线，保证 DS 名称合法。
      // 只存基础名：最终名称由 baseWorkflowName + 环境后缀派生（见 workflowName），
      // 因此内容编辑导致 mapping 重算时，环境后缀不会丢。
      setBaseWorkflowName(initialMapping.workflowName.replace(/[/\\]/g, '_'));
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
            // 优先回填上次记忆的 worker 组；若已不在当前项目可用列表中则退回 default
            const rememberWg = loadRemember().workerGroup;
            if (rememberWg && list.some((wg: DSWorkerGroup) => wg.workerGroup === rememberWg)) {
              setSelectedWorkerGroup(rememberWg);
            } else if (defaultWg) {
              setSelectedWorkerGroup(defaultWg.workerGroup);
            }
          } else {
            console.warn('[SubmitModal] Worker groups response:', wgRes);
          }
        }
        const envRes = results[idx];
        if (envRes.code === 0 && envRes.data) {
          const list = Array.isArray(envRes.data) ? envRes.data : (envRes.data.totalList || []);
          console.log('[SubmitModal] Environments loaded:', list.length, list);
          setEnvList(list);
          // 优先回填上次记忆的运行环境；不在可用列表中则保持未选择
          const rememberEnv = loadRemember().environmentCode;
          if (rememberEnv != null && list.some((e: DSEnvironment) => e.code === rememberEnv)) {
            setSelectedEnvironmentCode(rememberEnv);
          }
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
   * 扫描指定项目集合中的全部工作流任务节点，建立 taskName(净化后) -> { 项目code, 工作流code, 任务code } 索引
   * （同名只取首个）。供 @依赖 存在性校验与依赖关系重建时的跨工作流解析共用。
   */
  const buildProjectTaskIndex = useCallback(
    async (scanProjectCodes: Set<number>): Promise<Map<string, { projectCode: number; definitionCode: number; taskCode: number }>> => {
      const byName = new Map<string, { projectCode: number; definitionCode: number; taskCode: number }>();
      if (!dsApi) return byName;
      for (const scanCode of scanProjectCodes) {
        try {
          // 分页拉取项目内全部工作流，避免目标任务所在工作流在第一页之外被漏检
          const pageSize = 100;
          for (let page = 1; ; page++) {
            const wfRes = await dsApi.workflowDefinition.list(scanCode, { pageNo: page, pageSize });
            const defs = wfRes.code === 0 && wfRes.data?.totalList ? wfRes.data.totalList : [];
            for (const def of defs) {
              try {
                const dRes = await dsApi.workflowDefinition.detail(scanCode, def.code);
                if (dRes.code === 0 && dRes.data) {
                  for (const node of dRes.data.taskNodes) {
                    const san = sanitizeDsName(node.name);
                    if (san && !byName.has(san)) {
                      byName.set(san, { projectCode: scanCode, definitionCode: def.code, taskCode: node.code });
                    }
                  }
                }
              } catch { /* 单个工作流查询失败则跳过 */ }
            }
            // 当一页返回数不足 pageSize 时说明已是最后一页
            if (defs.length < pageSize) break;
          }
        } catch { /* 项目扫描失败则跳过 */ }
      }
      return byName;
    },
    [dsApi],
  );

  /**
   * 扫描提交目标项目及各依赖声明指定项目中的所有工作流任务节点，确认代码头 @依赖 声明的每个前置任务是否存在。
   * 返回 Map，key 为 {调度项目}.{前置任务名称}，value 为解析结果；找不到的 found=false。
   * 仅当代码头声明了 @依赖 时才真正发起查询，否则返回空 Map。
   */
  const scanHeaderDependencyTasks = useCallback(
    async (projectCodeNum: number | null): Promise<Map<string, DependencyResolution>> => {
      const declaredDeps = currentMapping?.headerDependencies || [];
      const resultMap = new Map<string, DependencyResolution>();
      if (!dsApi || declaredDeps.length === 0) return resultMap;

      // 需要扫描的项目集合：提交目标项目 + 各依赖声明中指定的 {调度项目}
      const scanProjectCodes = new Set<number>();
      if (projectCodeNum != null) scanProjectCodes.add(projectCodeNum);
      for (const dep of declaredDeps) {
        const matched = dep.projectCode ? projects.find(p => p.name === dep.projectCode) : null;
        if (matched?.code != null) scanProjectCodes.add(matched.code);
      }

      const byName = await buildProjectTaskIndex(scanProjectCodes);

      for (const dep of declaredDeps) {
        const label = [dep.projectCode, dep.taskName].filter(Boolean).join('.');
        const hit = byName.get(sanitizeDsName(dep.taskName));
        resultMap.set(label, hit
          ? { found: true, projectCode: hit.projectCode, definitionCode: hit.definitionCode, taskCode: hit.taskCode, taskName: dep.taskName, label }
          : { found: false, projectCode: null, definitionCode: null, taskCode: null, taskName: dep.taskName, label });
      }
      return resultMap;
    },
    [dsApi, currentMapping, projects, buildProjectTaskIndex],
  );

  /**
   * 按需解析跨工作流/跨项目前置任务（供依赖关系重建使用）：
   * 输入待解析的 @依赖 label 集合（{调度项目}.{前置任务名称}），返回 label -> 解析结果。
   */
  const resolveExternalDeps = useCallback(
    async (labels: Set<string>): Promise<Map<string, ResolvedDependency>> => {
      const result = new Map<string, ResolvedDependency>();
      if (!dsApi || labels.size === 0) return result;

      const deps: HeaderDependency[] = [...labels].map(label => {
        const dotIdx = label.indexOf('.');
        return dotIdx >= 0
          ? { projectCode: label.slice(0, dotIdx), taskName: label.slice(dotIdx + 1) }
          : { projectCode: '', taskName: label };
      });

      // 需要扫描的项目集合：提交目标项目 + 各依赖声明中指定的 {调度项目}
      const scanProjectCodes = new Set<number>();
      if (selectedProjectCode != null) scanProjectCodes.add(selectedProjectCode);
      for (const dep of deps) {
        const matched = dep.projectCode ? projects.find(p => p.name === dep.projectCode) : null;
        if (matched?.code != null) scanProjectCodes.add(matched.code);
      }

      const byName = await buildProjectTaskIndex(scanProjectCodes);
      for (const dep of deps) {
        const label = [dep.projectCode, dep.taskName].filter(Boolean).join('.');
        const hit = byName.get(sanitizeDsName(dep.taskName));
        if (hit) {
          result.set(label, { projectCode: hit.projectCode, definitionCode: hit.definitionCode, taskCode: hit.taskCode, taskName: dep.taskName, label });
        }
      }
      return result;
    },
    [dsApi, selectedProjectCode, projects, buildProjectTaskIndex],
  );

  /**
   * 递归扫描本地项目目录下全部代码文件的代码头 @依赖 声明，
   * 返回 sanitizeDsName(任务名) -> 依赖声明列表。本地文件是依赖关系的唯一事实来源，
   * 供提交时与工作流全量节点/边对比后整体重建依赖关系（任务逐个提交也能得到正确的全局依赖图）。
   */
  const scanLocalHeaderDependencies = useCallback(
    async (): Promise<Map<string, HeaderDependency[]>> => {
      const result = new Map<string, HeaderDependency[]>();
      if (!rootPath) return result;
      try {
        const { readDir, readFile } = await import('../../bridge/fs');
        const CODE_EXTS = new Set(['sql', 'hql', 'py', 'sh', 'bash', 'java', 'scala']);
        const walk = async (dir: string, depth: number): Promise<void> => {
          if (depth > 10) return;
          let entries;
          try {
            entries = await readDir(dir);
          } catch {
            return;
          }
          for (const entry of entries) {
            const child = dir.endsWith('/') ? `${dir}${entry.name}` : `${dir}/${entry.name}`;
            if (entry.isDirectory) {
              // 跳过隐藏目录（.git 等）与构建产物目录
              if (entry.name.startsWith('.') || ['node_modules', 'target', 'dist', 'build'].includes(entry.name)) continue;
              await walk(child, depth + 1);
            } else if (entry.isFile) {
              const ext = entry.name.includes('.') ? (entry.name.split('.').pop() || '').toLowerCase() : '';
              if (!CODE_EXTS.has(ext)) continue;
              try {
                const bytes = await readFile(child);
                const text = new TextDecoder('utf-8').decode(bytes);
                const header = parseFileHeader(text);
                const deps = parseDependencyHeader(header?.dependency);
                const taskName = sanitizeDsName(entry.name.replace(/\.[^.]+$/, ''));
                if (taskName && !result.has(taskName)) result.set(taskName, deps);
              } catch { /* 跳过不可读文件 */ }
            }
          }
        };
        await walk(rootPath, 0);
      } catch (e) {
        console.warn('[SubmitToSchedulerModal] 本地代码头依赖扫描失败，仅按当前文件重建:', e);
      }
      return result;
    },
    [rootPath],
  );

  useEffect(() => {
    if (workflowCheckTimerRef.current) {
      clearTimeout(workflowCheckTimerRef.current);
    }

    // 名称（含环境后缀）本身已是最终提交名，可直接查重；
    // 切换环境会改名，进而重新查重，据此提示「将更新已有工作流」或「将自动创建」
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

    // 数值型任务参数非负校验：默认值为负数的参数（如 cpuQuota/memoryMax 的 -1 表示不限制）除外
    if (currentTaskTypeConfig) {
      errors.push(...collectNegativeNumericErrors(currentTaskTypeConfig.params, taskTypeParams));
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
  }, [effectiveMapping, currentMapping, selectedProjectCode, workflowName, selectedWorkflowCode, isRealApi, projectCode, projects, projectMismatch, needsDatasource, selectedDatasourceId, codeDatasourceName, datasourceMismatch, isCompilableTask, compileConfig, fileName, codeContent, filePath, rootPath, savedConfig, scanHeaderDependencyTasks, currentTaskTypeConfig, taskTypeParams]);

  const handleSubmit = useCallback(async () => {

    if (!effectiveMapping || !selectedProjectCode || !dsApi) return;

    // 提交前仅做数值参数非负的轻量校验（不做完整校验，避免重复编译），
    // 防止校验通过后将参数改成负数再直接提交
    const numParamErrors = currentTaskTypeConfig
      ? collectNegativeNumericErrors(currentTaskTypeConfig.params, taskTypeParams)
      : [];
    if (numParamErrors.length > 0) {
      setValidationErrors(numParamErrors);
      setShowValidation(true);
      setStep('config');
      return;
    }

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

    // 拼装 Spark 提交命令的「其他参数(others)」：--jars（依赖） + 用户手填命令 +（仅生产）OpenLineage 参数。
    // 注意 --jars 与血缘参数同处一个字段，所以环境闸门**只掐血缘那一段**，
    // 不能把整块跳过 —— 否则非生产环境提交会连自定义 jar 一起丢掉。
    if (mappingWithDatasource.taskType === 'SPARK') {
      const updatedParams = { ...mappingWithDatasource.taskParams };
      const existingOthers = ((updatedParams.others as string) || '').replace(/\r?\n/g, ' ').trim();
      // 自定义 jar 通过 --jars 跟随提交（仅 SPARK）：路径为 {basePath}/{jarPath}。
      // 在提交时动态拼接，避免 --jars 污染弹窗「其他参数」输入框（该输入框仅承载用户手填命令）
      const jarsArg = buildJarsArg((savedConfig?.dependencies || []).filter(d => d.source === 'custom'));
      const segments: string[] = [];
      if (jarsArg) segments.push(`--jars ${jarsArg}`);
      if (existingOthers) segments.push(existingOthers);

      // OpenLineage 血缘参数：拼装与两道闸门（环境硬闸门 + 文件级 lineage.enabled）都在
      // utils/lineageParams.ts 里，与文件夹批量提交共用同一份实现。
      // 返回空数组即本次不注入 —— 此时不改写 others，用户原有内容原样保留。
      const openlineageConfs = buildOpenLineageArgs({
        env: deployEnv,
        projectCode,
        globalTransportUrl: openlineageTransportUrl,
        fileLineage: extractLineageParams(savedConfig?.taskParams),
      });
      if (openlineageConfs.length > 0) {
        segments.push(openlineageConfs.join(' '));
      }

      // 所有 spark-submit 执行命令拼成单行（用空格连接，不做换行），避免提交后执行命令被拆成多行
      updatedParams.others = segments.join(' ');
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

    // 前置依赖已在上方开头解析（resolvedDeps），缺失时已阻止提交

    try {
      const targetProject = projects.find(p => p.code === selectedProjectCode);
      const projectName = targetProject?.name || '';

      // 提交前记住本次填写的运行参数与调度运行环境，供下次自动回填
      persistRememberNow();

      if (selectedWorkflowCode) {
        const detailRes = await dsApi.workflowDefinition.detail(selectedProjectCode, selectedWorkflowCode);
        if (detailRes.code === 0 && detailRes.data) {
          const { taskNodes, edges, globalParams, workflowDefinition } = detailRes.data;

          // 判断工作流中是否已存在同名任务：存在则原地更新内容（保留原 code），
          // 不再新增重复节点；新任务也不再与最后任务串行连接，依赖关系完全由代码头 @依赖 重建
          const sanitizedTaskName = sanitizeDsName(mappingWithDatasource.taskName);
          const existingIndex = taskNodes.findIndex(node => sanitizeDsName(node.name) === sanitizedTaskName);
          const existingCodes = taskNodes.map(n => n.code);
          const taskCode = existingIndex >= 0
            ? taskNodes[existingIndex].code
            : (Date.now() > Math.max(0, ...existingCodes) ? Date.now() : Math.max(0, ...existingCodes) + 1);
          let nextCode = Math.max(taskCode, 0, ...existingCodes) + 1;

          console.log('[SubmitToSchedulerModal] 提交前 taskParams=', mappingWithDatasource.taskParams);
          console.log('[SubmitToSchedulerModal] taskParams.others=', mappingWithDatasource.taskParams?.others);

          // 网格坐标：新增主任务占一个槽位；若本次提交将新建专属前置依赖节点（跨工作流依赖），
          // 主任务顺延一位，使前置依赖节点落在主任务的左/上方；已存在的节点保留原坐标
          const willHaveOwnDepNode = existingIndex < 0 && resolvedDeps.some(r =>
            sanitizedTaskName !== sanitizeDsName(r.taskName)
            && !taskNodes.some(n => n.taskType !== 'DEPENDENT' && sanitizeDsName(n.name) === sanitizeDsName(r.taskName)),
          );
          const mainSlot = existingIndex < 0 ? taskNodes.length + (willHaveOwnDepNode ? 1 : 0) : -1;
          const usedSlots = new Set<number>(mainSlot >= 0 ? [mainSlot] : []);
          let slotCursor = taskNodes.length;
          const nextSlot = () => {
            while (usedSlots.has(slotCursor)) slotCursor++;
            const slot = slotCursor;
            usedSlots.add(slot);
            slotCursor++;
            return gridPos(slot);
          };

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
            x: existingIndex >= 0 ? taskNodes[existingIndex].x : gridPos(mainSlot).x,
            y: existingIndex >= 0 ? taskNodes[existingIndex].y : gridPos(mainSlot).y,
          };

          // 同名任务：原地替换内容；新任务：追加节点（不串行连接，依赖关系见下方重建）
          const nodesAfterMain = existingIndex >= 0
            ? taskNodes.map((n, i) => (i === existingIndex ? newNode : n))
            : [...taskNodes, newNode];

          // ====== 依赖关系重建 ======
          // 任务是一个个提交的、没有全局视角：每次提交拉取工作流全量节点与依赖边，
          // 与本地文件代码头 @依赖 对比后整体重建，确保 A->B、C->D 不会被串成 A->B->C->D，
          // 且各任务的跨工作流前置依赖使用专属 DEPENDENT 节点（前置依赖_{任务名}）互不覆盖
          const localHeaderDeps = await scanLocalHeaderDependencies();
          // 本次提交文件以编辑器实时内容为准（磁盘内容可能未保存）
          localHeaderDeps.set(sanitizedTaskName, currentMapping?.headerDependencies || []);

          const resolvedLabels = new Map<string, ResolvedDependency>();
          resolvedDeps.forEach(r => resolvedLabels.set(r.label, r));

          const recon = await reconcileWorkflowDependencies({
            nodes: nodesAfterMain,
            edges,
            localHeaderDeps,
            mainTaskName: sanitizedTaskName,
            resolvedLabels,
            resolveExternalDeps,
            allocateCode: () => nextCode++,
            nextSlot,
          });
          if (recon.warnings.length > 0) {
            recon.warnings.forEach(w => console.warn('[SubmitToSchedulerModal] 依赖重建:', w));
          }
          console.log('[SubmitToSchedulerModal] 依赖重建摘要:', recon.rebuilt);

          // 重建后校验依赖图无环，避免代码头声明了循环依赖导致整次更新失败
          const cycle = findDependencyCycle(recon.nodes, recon.edges);
          if (cycle) {
            throw new Error(`重建后的依赖关系存在环（${cycle.join(' -> ')}），请检查代码头 @依赖 声明`);
          }

          const updatedNodes = recon.nodes;
          const updatedEdges = recon.edges;

          // 提交前按依赖关系分层布局：前置节点（含 DEPENDENT 前置依赖节点）总在依赖节点左侧，
          // 数据流自左向右，并自动拉开历史遗留的过近/重叠节点
          layoutWorkflowByDependency(updatedNodes, updatedEdges);

          await dsApi.workflowDefinition.update(selectedProjectCode, selectedWorkflowCode, {
            name: workflowDefinition.name,
            // 工作流 description 不填写（description 是任务属性，非工作流属性），置空避免写入残留的任务描述
            description: '',
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

          if (autoTrigger) {
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
        // 工作流 description 不应填写任务描述（description 是任务属性，非工作流属性），保持为空
        const workflowData = buildWorkflowFromCodeFile(mappingWithDatasource, '');
        // 工作流名称以「环境后缀名」为准（`{目录推导名}_{prod|gray|test}`），而非 mapping 中的基础名
        workflowData.name = sanitizeDsName(workflowName) || workflowData.name;

        // 根据代码头 @依赖 配置前置任务依赖：新建工作流内只有主任务，@依赖 均为跨工作流依赖，
        // 为主任务创建专属 DEPENDENT 前置节点（前置依赖_{任务名}），不再使用共享节点。
        // 前置依赖位于主任务左侧相邻网格槽位，间隔足够且不重叠。
        if (resolvedDeps.length > 0) {
          const mainNode = workflowData.nodes[0];
          const depCode = mainNode.code + 1;
          const depPos0 = gridPos(0);
          const mainPos0 = gridPos(1);
          mainNode.x = mainPos0.x;
          mainNode.y = mainPos0.y;
          const depNode = buildDependentTaskNode(
            resolvedDeps,
            depCode,
            depPos0.x,
            depPos0.y,
            dependentNodeName(mainNode.name),
          );
          workflowData.nodes = [depNode, mainNode];
          workflowData.edges = [{
            id: `e_${depCode}_${mainNode.code}`,
            sourceCode: depCode,
            targetCode: mainNode.code,
          }];
        }

        // 提交前强制节点最小间距，保证新建工作流初始布局疏朗
        enforceMinSpacing(workflowData.nodes);

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

        if (autoTrigger && createdWorkflowCode) {
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
    effectiveMapping, selectedProjectCode, selectedWorkflowCode,
    projects, workflowDesc, workflowName, autoTrigger, dsApi, onSuccess,
    compiledJarPath, needsDatasource, selectedDatasourceId, dsDataSources,
    selectedWorkerGroup, selectedEnvironmentCode, openlineageTransportUrl, projectCode,
    deployEnv,
    currentMapping, scanHeaderDependencyTasks, persistRememberNow,
    resolveExternalDeps, scanLocalHeaderDependencies,
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
                    <label className="submit-scheduler__label">环境</label>
                    <div className="submit-scheduler__name-check-hint submit-scheduler__name-check-hint--info">
                      <Info size={12} />
                      <span>环境作为工作流名称后缀，用于区分同名工作流（不同环境互不影响）</span>
                    </div>
                  </div>
                  <DeployEnvRadio
                    value={deployEnv}
                    onChange={setDeployEnv}
                    hint={
                      shouldInjectLineage(deployEnv)
                        ? `工作流名称将以 _${deployEnv} 结尾，提交时注入数据血缘参数`
                        : `工作流名称将以 _${deployEnv} 结尾，不注入数据血缘参数`
                    }
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
                  <input
                    className="submit-scheduler__input"
                    data-testid="submit-scheduler-workflow-name"
                    value={workflowName}
                    readOnly
                    disabled
                    placeholder="由文件目录自动生成"
                  />
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
                            {param.key === 'appName' && appNameAuto !== undefined ? (
                              <>
                                <input
                                  className="submit-scheduler__input"
                                  type="text"
                                  value={appNameAuto}
                                  readOnly
                                  disabled
                                  title={appNameAuto}
                                  data-testid="submit-scheduler-app-name"
                                />
                                <div className="submit-scheduler__name-check-hint submit-scheduler__name-check-hint--info">
                                  <Info size={12} />
                                  <span>由「项目.工作流.任务」自动生成</span>
                                </div>
                              </>
                            ) : param.type === 'select' ? (
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

              {headerParamNotice && (
                <div className="submit-scheduler__header-params" data-testid="submit-scheduler-header-params">
                  <Info size={13} />
                  <div className="submit-scheduler__header-params-body">
                    {headerParamNotice.keys.length > 0 && (
                      <div data-testid="submit-scheduler-header-params-applied">
                        已按代码头填充 {headerParamNotice.keys.length} 项节点参数：{headerParamNotice.keys.join('、')}
                        （取值即代码头声明值，可在上方直接改）
                      </div>
                    )}
                    {headerParamNotice.unmapped.map((hit, index) => (
                      <div key={`${hit.from}-${hit.raw}-${index}`} data-testid="submit-scheduler-header-params-unmapped">
                        {hit.raw} —— {hit.note}
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
