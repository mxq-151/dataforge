export interface DolphinSchedulerConfig {
  apiUrl: string;
  token: string;
}

export interface DolphinSchedulerResponse<T> {
  code: number;
  msg: string;
  data: T;
}

export interface PageResult<T> {
  totalList: T[];
  total: number;
  totalPage: number;
  pageSize: number;
  currentPage: number;
}

export interface DSProject {
  id: number;
  code: number;
  name: string;
  description: string;
  userId: number;
  userName: string;
  createTime: string;
  updateTime: string;
}

export interface DSProjectCreateParams {
  projectName: string;
  description?: string;
}

export interface DSWorkflowDefinition {
  id: number;
  code: number;
  name: string;
  version: number;
  description: string;
  projectCode: number;
  projectName: string;
  releaseState: ReleaseState | string;
  userId: number;
  userName: string;
  globalParams: string;
  locations: string;
  warningGroupId: number;
  timeout: number;
  executionType: ExecutionType;
  createTime: string;
  updateTime: string;
}

export enum ReleaseState {
  OFFLINE = 0,
  ONLINE = 1,
}

export function parseReleaseState(value: unknown): ReleaseState {
  if (typeof value === 'number') return value === 1 ? ReleaseState.ONLINE : ReleaseState.OFFLINE;
  const str = String(value).toUpperCase();
  return str === 'ONLINE' || str === '1' ? ReleaseState.ONLINE : ReleaseState.OFFLINE;
}

export function releaseStateToString(state: ReleaseState): string {
  return state === ReleaseState.ONLINE ? 'ONLINE' : 'OFFLINE';
}

export enum ExecutionType {
  PARALLEL = 0,
  SERIAL_WAIT = 1,
  SERIAL_DISCARD = 2,
  SERIAL_PRIORITY = 3,
}

export enum WorkflowExecutionStatus {
  SUBMITTED_SUCCESS = 0,
  RUNNING_EXECUTION = 1,
  READY_PAUSE = 2,
  PAUSE = 3,
  READY_STOP = 4,
  STOP = 5,
  FAILURE = 6,
  SUCCESS = 7,
}

export enum TaskExecutionStatus {
  SUBMITTED_SUCCESS = 0,
  RUNNING_EXECUTION = 1,
  READY_PAUSE = 2,
  PAUSE = 3,
  READY_STOP = 4,
  STOP = 5,
  FAILURE = 6,
  SUCCESS = 7,
  NEED_FAULT_TOLERANCE = 8,
  KILL = 9,
  WAITTING_THREAD = 10,
  WAITTING_DEPEND = 11,
  DELAY_EXECUTION = 12,
}

export enum FailureStrategy {
  END = 'END',
  CONTINUE = 'CONTINUE',
}

export enum WarningType {
  NONE = 'NONE',
  SUCCESS = 'SUCCESS',
  FAILURE = 'FAILURE',
  ALL = 'ALL',
}

export enum Priority {
  HIGHEST = 'HIGHEST',
  HIGH = 'HIGH',
  MEDIUM = 'MEDIUM',
  LOW = 'LOW',
  LOWEST = 'LOWEST',
}

export interface DSWorkflowInstance {
  id: number;
  name: string;
  processDefinitionCode: number;
  processDefinitionName: string;
  state: WorkflowExecutionStatus;
  runTimes: number;
  host: string;
  startTime: string;
  endTime: string;
  duration: string;
  userId: number;
  userName: string;
  projectCode: number;
  projectName: string;
  commandType: number;
  commandParams: string;
  globalParams: string;
  warningType: WarningType;
  warningGroupId: number;
  scheduleTime: string;
  commandOp: number;
  executorId: number;
  executorName: string;
  dryRun: number;
  processInstancePriority: Priority;
  workerGroup: string;
  environmentCode: number;
  createTime: string;
  updateTime: string;
}

export interface DSTaskInstance {
  id: number;
  name: string;
  taskType: string;
  taskCode: number;
  taskDefinitionVersion: number;
  processInstanceId: number;
  processInstanceName: string;
  processDefinitionCode: number;
  processDefinitionName: string;
  projectCode: number;
  projectName: string;
  state: TaskExecutionStatus;
  startTime: string;
  endTime: string;
  duration: string;
  host: string;
  logPath: string;
  executePath: string;
  retryTimes: number;
  pid: number;
  appIds: string;
  userId: number;
  userName: string;
  executorId: number;
  executorName: string;
  dryRun: number;
  taskInstancePriority: Priority;
  workerGroup: string;
  environmentCode: number;
  environmentConfig: string;
  delayTime: number;
  taskParams: string;
  createTime: string;
  updateTime: string;
}

export interface DSStartParam {
  key: string;
  value: string;
}

export interface DSTriggerWorkflowParams {
  processDefinitionCode: number;
  failureStrategy?: FailureStrategy;
  warningType?: WarningType;
  warningGroupId?: number;
  scheduleTime?: string;
  execType?: string;
  startNodeList?: string;
  runMode?: string;
  processInstancePriority?: Priority;
  workerGroup?: string;
  environmentCode?: number;
  tenantCode?: string;
  dryRun?: number;
  startParams?: DSStartParam[];
  complementRun?: boolean;
}

export type ScheduleSubTab = 'projects' | 'workflowDefinitions' | 'workflowInstances' | 'taskInstances';

export type DSTaskType =
  | 'SHELL'
  | 'SUB_PROCESS'
  | 'PROCEDURE'
  | 'SQL'
  | 'SPARK'
  | 'FLINK'
  | 'FLINK_STREAM'
  | 'MR'
  | 'PYTHON'
  | 'DEPENDENT'
  | 'HTTP'
  | 'DATAX'
  | 'SQOOP'
  | 'CONDITIONS'
  | 'SWITCH'
  | 'SEATUNNEL'
  | 'K8S'
  | 'JAVA'
  | 'GRPC'
  | 'EMR'
  | 'ZEPPELIN'
  | 'JUPYTER'
  | 'MLFLOW'
  | 'OPENMLDB'
  | 'DVC'
  | 'DINKY'
  | 'SAGEMAKER'
  | 'CHUNJUN'
  | 'HIVECLI'
  | 'DMS'
  | 'DATASYNC'
  | 'KUBEFLOW'
  | 'LINKIS'
  | 'DATA_FACTORY'
  | 'REMOTESHELL'
  | 'ALIYUN_SERVERLESS_SPARK';

export interface DSTaskCategory {
  id: string;
  label: string;
  tasks: DSTaskType[];
}

export const TASK_CATEGORIES: DSTaskCategory[] = [
  {
    id: 'universal',
    label: '通用任务',
    tasks: ['SHELL', 'SUB_PROCESS', 'PROCEDURE', 'SQL', 'SPARK', 'FLINK', 'FLINK_STREAM', 'MR', 'PYTHON', 'HTTP', 'JAVA'],
  },
  {
    id: 'logic',
    label: '逻辑控制',
    tasks: ['CONDITIONS', 'SWITCH', 'DEPENDENT'],
  },
  {
    id: 'dataIntegration',
    label: '数据集成',
    tasks: ['DATAX', 'SEATUNNEL', 'SQOOP', 'CHUNJUN', 'DATASYNC'],
  },
  {
    id: 'compute',
    label: '计算引擎',
    tasks: ['HIVECLI', 'LINKIS', 'DINKY', 'GRPC'],
  },
  {
    id: 'cloud',
    label: '云服务',
    tasks: ['EMR', 'K8S', 'KUBEFLOW', 'SAGEMAKER', 'ALIYUN_SERVERLESS_SPARK'],
  },
  {
    id: 'ml',
    label: '机器学习',
    tasks: ['MLFLOW', 'JUPYTER', 'OPENMLDB', 'DVC'],
  },
  {
    id: 'other',
    label: '其他',
    tasks: ['ZEPPELIN', 'DMS', 'DATA_FACTORY', 'REMOTESHELL'],
  },
];

export const TASK_TYPE_LABELS: Record<DSTaskType, string> = {
  SHELL: 'Shell',
  SUB_PROCESS: '子流程',
  PROCEDURE: '存储过程',
  SQL: 'SQL',
  SPARK: 'Spark',
  FLINK: 'Flink',
  FLINK_STREAM: 'Flink Stream',
  MR: 'MapReduce',
  PYTHON: 'Python',
  DEPENDENT: '依赖',
  HTTP: 'HTTP',
  DATAX: 'DataX',
  SQOOP: 'Sqoop',
  CONDITIONS: '条件分支',
  SWITCH: '开关分支',
  SEATUNNEL: 'SeaTunnel',
  K8S: 'Kubernetes',
  JAVA: 'Java',
  GRPC: 'gRPC',
  EMR: 'Amazon EMR',
  ZEPPELIN: 'Zeppelin',
  JUPYTER: 'Jupyter',
  MLFLOW: 'MLflow',
  OPENMLDB: 'OpenMLDB',
  DVC: 'DVC',
  DINKY: 'Dinky',
  SAGEMAKER: 'SageMaker',
  CHUNJUN: 'ChunJun',
  HIVECLI: 'HiveCLI',
  DMS: 'DMS',
  DATASYNC: 'DataSync',
  KUBEFLOW: 'Kubeflow',
  LINKIS: 'Linkis',
  DATA_FACTORY: 'DataFactory',
  REMOTESHELL: 'RemoteShell',
  ALIYUN_SERVERLESS_SPARK: 'Aliyun Serverless Spark',
};

export interface DSWorkflowTaskNode {
  code: number;
  name: string;
  taskType: DSTaskType;
  description: string;
  taskParams: string;
  flag: 'YES' | 'NO';
  taskPriority: Priority;
  workerGroup: string;
  environmentCode: number;
  failRetryTimes: number;
  failRetryInterval: number;
  timeoutFlag: 'OPEN' | 'CLOSE';
  timeout: number;
  delayTime: number;
  x: number;
  y: number;
  id?: number;
  version?: number;
  taskExecuteType?: string;
  cpuQuota?: number;
  memoryMax?: number;
  timeoutNotifyStrategy?: string;
  taskGroupId?: number | null;
  taskGroupPriority?: number | null;
}

export interface DSWorkflowEdge {
  id: string;
  sourceCode: number;
  targetCode: number;
  conditionType?: string;
  conditionParams?: string;
}

export interface DSWorkflowGlobalParam {
  key: string;
  direct: 'IN' | 'OUT';
  type: 'VARCHAR' | 'INTEGER' | 'LONG' | 'FLOAT' | 'DOUBLE' | 'DATE' | 'TIME' | 'BOOLEAN' | 'LIST' | 'FILE';
  value: string;
}

export interface DSWorkflowSaveForm {
  name: string;
  description: string;
  executionType: ExecutionType;
  timeoutFlag: boolean;
  timeout: number;
  globalParams: DSWorkflowGlobalParam[];
  release: boolean;
}

export interface DSWorkflowTriggerForm {
  failureStrategy: FailureStrategy;
  warningType: WarningType;
  warningGroupId: number | null;
  processInstancePriority: Priority;
  workerGroup: string;
  environmentCode: number | null;
  tenantCode: string | null;
  dryRun: number;
  complementRun: boolean;
  startParams: DSStartParam[];
}

export const EXECUTION_TYPE_OPTIONS = [
  { value: ExecutionType.PARALLEL, label: '并行' },
  { value: ExecutionType.SERIAL_WAIT, label: '串行等待' },
  { value: ExecutionType.SERIAL_DISCARD, label: '串行丢弃' },
  { value: ExecutionType.SERIAL_PRIORITY, label: '串行优先' },
];

export const GLOBAL_PARAM_TYPE_OPTIONS = [
  { value: 'VARCHAR', label: 'VARCHAR' },
  { value: 'INTEGER', label: 'INTEGER' },
  { value: 'LONG', label: 'LONG' },
  { value: 'FLOAT', label: 'FLOAT' },
  { value: 'DOUBLE', label: 'DOUBLE' },
  { value: 'DATE', label: 'DATE' },
  { value: 'TIME', label: 'TIME' },
  { value: 'BOOLEAN', label: 'BOOLEAN' },
  { value: 'LIST', label: 'LIST' },
  { value: 'FILE', label: 'FILE' },
];

export const GLOBAL_PARAM_DIRECT_OPTIONS = [
  { value: 'IN', label: 'IN' },
  { value: 'OUT', label: 'OUT' },
];

export interface DSLocalParam {
  prop: string;
  direct: 'IN' | 'OUT';
  type: 'VARCHAR' | 'INTEGER' | 'LONG' | 'FLOAT' | 'DOUBLE' | 'DATE' | 'TIME' | 'BOOLEAN' | 'LIST' | 'FILE';
  value: string;
}

export interface DSHttpParam {
  prop: string;
  httpParametersType: 'PARAMETER' | 'BODY' | 'HEADERS';
  value: string;
}

export interface DSDatasource {
  id: number;
  code: number;
  name: string;
  type: string;
}

export const DATASOURCE_TYPES = [
  'MYSQL', 'POSTGRESQL', 'HIVE', 'SPARK', 'CLICKHOUSE',
  'ORACLE', 'SQLSERVER', 'DB2', 'PRESTO', 'H2',
];

export const MOCK_DATASOURCES: DSDatasource[] = [
  { id: 1, code: 400001, name: '业务MySQL库', type: 'MYSQL' },
  { id: 2, code: 400002, name: '数仓Hive库', type: 'HIVE' },
  { id: 3, code: 400003, name: '报表PostgreSQL库', type: 'POSTGRESQL' },
  { id: 4, code: 400004, name: '实时ClickHouse库', type: 'CLICKHOUSE' },
  { id: 5, code: 400005, name: '风控MySQL库', type: 'MYSQL' },
  { id: 6, code: 400006, name: 'Oracle生产库', type: 'ORACLE' },
];

export interface DSShellTaskParams {
  rawScript: string;
  localParams: DSLocalParam[];
  resourceList: string[];
  environmentCode: number;
  cpuQuota: number;
  memoryMax: number;
}

export interface DSSqlTaskParams {
  type: string;
  datasource: number;
  sql: string;
  sqlType: '0' | '1';
  displayRows: number;
  preStatements: string[];
  postStatements: string[];
  connParams: string;
  localParams: DSLocalParam[];
}

export interface DSPythonTaskParams {
  rawScript: string;
  localParams: DSLocalParam[];
  resourceList: string[];
  environmentCode: number;
  cpuQuota: number;
  memoryMax: number;
}

export interface DSDataXTaskParams {
  customConfig: boolean;
  dsType: string;
  dtType: string;
  datasource: number;
  dtDatasource: number;
  sql: string;
  targetTable: string;
  jobSpeedByte: number;
  jobSpeedRecord: number;
  xms: number;
  xmx: number;
  preStatements: string[];
  postStatements: string[];
  json: string;
  localParams: DSLocalParam[];
  resourceList: string[];
}

export interface DSSparkTaskParams {
  programType: 'JAVA' | 'SCALA' | 'PYTHON' | 'SQL';
  mainClass: string;
  mainJar: string;
  rawScript: string;
  master: string;
  deployMode: string;
  driverCores: number;
  driverMemory: string;
  numExecutors: number;
  executorMemory: string;
  executorCores: number;
  appName: string;
  mainArgs: string;
  others: string;
  yarnQueue: string;
  sqlExecutionType: 'SCRIPT' | 'FILE';
  localParams: DSLocalParam[];
  resourceList: string[];
}

export interface DSFlinkTaskParams {
  programType: 'JAVA' | 'SCALA' | 'PYTHON' | 'SQL';
  mainClass: string;
  mainJar: string;
  deployMode: string;
  flinkVersion: string;
  jobManagerMemory: string;
  taskManagerMemory: string;
  slot: number;
  taskManager: number;
  parallelism: number;
  appName: string;
  mainArgs: string;
  others: string;
  yarnQueue: string;
  rawScript: string;
  initScript: string;
  localParams: DSLocalParam[];
  resourceList: string[];
}

export interface DSHttpTaskParams {
  url: string;
  httpMethod: 'GET' | 'POST' | 'PUT' | 'DELETE';
  httpParams: DSHttpParam[];
  httpBody: string;
  httpCheckCondition: 'STATUS_CODE_DEFAULT' | 'STATUS_CODE_CUSTOM' | 'BODY_CONTAINS' | 'BODY_NOT_CONTAINS';
  condition: string;
  connectTimeout: number;
  socketTimeout: number;
  localParams: DSLocalParam[];
}

export interface DSSubProcessTaskParams {
  workflowDefinitionCode: number;
}

export interface DSProcedureTaskParams {
  type: string;
  datasource: number;
  method: string;
  localParams: DSLocalParam[];
}

export interface DSMrTaskParams {
  programType: 'JAVA' | 'SCALA' | 'PYTHON';
  mainClass: string;
  mainJar: string;
  appName: string;
  mainArgs: string;
  others: string;
  yarnQueue: string;
  localParams: DSLocalParam[];
  resourceList: string[];
}

export interface DSDependentTaskItem {
  dependentType?: 'DEPENDENT_ON_WORKFLOW' | 'DEPENDENT_ON_TASK';
  projectCode: number;
  definitionCode: number;
  depTaskCode: number;
  cycle: 'day' | 'hour' | 'week' | 'month';
  dateValue: string;
  parameterPassing?: boolean;
}

/**
 * DEPENDENT 任务中的一个依赖组。DolphinScheduler 的 DEPENDENT 任务参数结构为：
 * dependTaskList 是 List<DependentTaskModel>，每个模型包含 dependItemList（该组内的依赖项）
 * 和组内关系 relation；最外层是任务级 relation。注意不能写成「列表嵌套列表」。
 * DS 3.4.x 起，全部参数统一包裹在 dependence 对象下（DependentParameters.dependence）。
 */
export interface DSDependentTaskModel {
  dependItemList: DSDependentTaskItem[];
  relation: 'AND' | 'OR';
}

export interface DSDependentTaskParams {
  dependence: {
    relation: 'AND' | 'OR';
    dependTaskList: DSDependentTaskModel[];
    failurePolicy: 'DEPENDENT_FAILURE_FAILURE' | 'DEPENDENT_FAILURE_WAITING';
    checkInterval: number;
    failureWaitingTime: number;
  };
}

export interface DSConditionsTaskParams {
  relation: 'AND' | 'OR';
  dependTaskList: { depTaskCode: number; status: 'SUCCESS' | 'FAILURE' }[];
  successBranch: number | null;
  failedBranch: number | null;
}

export interface DSSwitchTaskParams {
  switchResult: {
    dependTaskList: { condition: string; nextNode: number | null }[];
    nextNode: number | null;
  };
}

export interface DSSeaTunnelTaskParams {
  startupScript: string;
  runMode: 'NONE' | 'RUN' | 'RUN_APPLICATION';
  useCustom: boolean;
  deployMode: string;
  master: string;
  masterUrl: string;
  rawScript: string;
  resourceList: string[];
}

export interface DSK8sTaskParams {
  namespace: string;
  image: string;
  imagePullPolicy: 'IfNotPresent' | 'Always' | 'Never';
  pullSecret: string;
  command: string;
  args: string;
  minCpuCores: number;
  minMemorySpace: string;
  customizedLabels: { key: string; value: string }[];
  nodeSelectors: { key: string; operator: string; values: string }[];
}

export interface DSJavaTaskParams {
  runType: 'FAT_JAR' | 'NORMAL_JAR';
  isModulePath: boolean;
  mainClass: string;
  mainJar: string;
  mainArgs: string;
  jvmArgs: string;
  localParams: DSLocalParam[];
  resourceList: string[];
}

export interface DSFlinkStreamTaskParams {
  programType: 'JAVA' | 'SCALA' | 'PYTHON';
  deployMode: string;
  flinkVersion: string;
  jobManagerMemory: string;
  taskManagerMemory: string;
  slot: number;
  taskManager: number;
  parallelism: number;
  yarnQueue: string;
  rawScript: string;
  initScript: string;
  localParams: DSLocalParam[];
  resourceList: string[];
}

export interface DSSqoopTaskParams {
  isCustomTask: boolean;
  modelType: 'import' | 'export';
  sourceType: string;
  targetType: string;
  sourceMysqlType: string;
  targetMysqlType: string;
  targetHdfsDeleteTargetDir: boolean;
  targetHdfsCompressionCodec: string;
  targetHdfsFileType: string;
  targetHiveCreateTable: boolean;
  targetHiveOverWrite: boolean;
  targetMysqlUpdateMode: string;
  concurrency: number;
  splitBy: string;
  srcQueryType: '1' | '0';
  srcColumnType: '0' | '1';
  hadoopCustomParams: DSLocalParam[];
  sqoopAdvancedParams: DSLocalParam[];
  mapColumnHive: { key: string; value: string }[];
  mapColumnJava: { key: string; value: string }[];
  localParams: DSLocalParam[];
  resourceList: string[];
}

export interface DSGrpcTaskParams {
  url: string;
  grpcCredentialType: 'INSECURE' | 'TLS' | 'TOKEN';
  grpcCheckCondition: 'STATUS_CODE_DEFAULT' | 'STATUS_CODE_CUSTOM' | 'BODY_CONTAINS' | 'BODY_NOT_CONTAINS';
  grpcServiceDefinitionJSON: string;
  condition: string;
  grpcConnectTimeoutMs: number;
  socketTimeout: number;
  localParams: DSLocalParam[];
}

export interface DSEmrTaskParams {
  programType: 'ADD_JOB_FLOW_STEPS' | 'RUN_JOB_FLOW' | 'TERMINATE_JOB_FLOW' | 'TERMINATE_CLUSTER';
  jobFlowDefinitionJSON: string;
  localParams: DSLocalParam[];
}

export interface DSZeppelinTaskParams {
  restEndpoint: string;
  username: string;
  password: string;
  noteId: string;
  paragraphId: string;
  localParams: DSLocalParam[];
}

export interface DSJupyterTaskParams {
  rawScript: string;
  localParams: DSLocalParam[];
  resourceList: string[];
  environmentCode: number;
  cpuQuota: number;
  memoryMax: number;
}

export interface DSMlflowTaskParams {
  mlflowTaskType: 'MLflow Projects' | 'MLflow Models' | 'MLflow AutoML';
  mlflowTrackingUri: string;
  algorithm: string;
  mlflowJobType: 'CustomProject' | 'GitHubProject';
  automlTool: 'flaml';
  deployType: 'MLFLOW' | 'DOCKER';
  deployPort: string;
  mlflowCustomProjectParameters: DSLocalParam[];
  localParams: DSLocalParam[];
  resourceList: string[];
}

export interface DSOpenmldbTaskParams {
  zk: string;
  zkPath: string;
  executeMode: 'offline' | 'online';
  sql: string;
  localParams: DSLocalParam[];
}

export interface DSDvcTaskParams {
  dvcTaskType: 'Upload' | 'Download';
  dvcRepository: string;
  dvcVersion: string;
  dvcDataPath: string;
  dvcStoreUrl: string;
  localParams: DSLocalParam[];
}

export interface DSDinkyTaskParams {
  dinkyTaskId: number;
  dinkyUrl: string;
  dinkyTaskType: string;
  localParams: DSLocalParam[];
}

export interface DSSagemakerTaskParams {
  awsRegion: string;
  sagemakerJobType: 'TrainingJob' | 'TransformJob' | 'Endpoint';
  sagemakerJobConfigJSON: string;
  localParams: DSLocalParam[];
}

export interface DSChunjunTaskParams {
  customConfig: boolean;
  deployMode: 'local' | 'standalone' | 'yarn-session' | 'yarn-per-job';
  json: string;
  dsType: string;
  dtType: string;
  datasource: number;
  dtDatasource: number;
  preStatements: string[];
  postStatements: string[];
  localParams: DSLocalParam[];
  resourceList: string[];
}

export interface DSHiveCliTaskParams {
  hiveCliTaskExecutionType: 'SCRIPT' | 'FILE';
  hiveSql: string;
  hiveCliArgs: string;
  localParams: DSLocalParam[];
  resourceList: string[];
}

export interface DSDmsTaskParams {
  isRestartTask: boolean;
  dmsTaskId: string;
  localParams: DSLocalParam[];
}

export interface DSDatasyncTaskParams {
  datasyncTaskId: string;
  datasyncConfigJSON: string;
  localParams: DSLocalParam[];
  resourceList: string[];
}

export interface DSKubeflowTaskParams {
  kubeflowNamespace: string;
  kubeflowPipelineYaml: string;
  kubeflowParameters: DSLocalParam[];
  localParams: DSLocalParam[];
}

export interface DSLinkisTaskParams {
  useCustom: boolean;
  rawScript: string;
  paramScript: DSLocalParam[];
  linkisJobContent: string;
  localParams: DSLocalParam[];
  resourceList: string[];
  environmentCode: number;
  cpuQuota: number;
  memoryMax: number;
}

export interface DSDataFactoryTaskParams {
  factoryName: string;
  resourceGroupName: string;
  pipelineName: string;
  localParams: DSLocalParam[];
}

export interface DSRemoteShellTaskParams {
  type: 'SSH';
  datasource: number;
  rawScript: string;
  localParams: DSLocalParam[];
  resourceList: string[];
  environmentCode: number;
  cpuQuota: number;
  memoryMax: number;
}

export interface DSAliyunServerlessSparkTaskParams {
  restEndpoint: string;
  username: string;
  password: string;
  jobId: string;
  sparkJobConfigJSON: string;
  localParams: DSLocalParam[];
}

export type DSTaskParamsMap = {
  SHELL: DSShellTaskParams;
  SUB_PROCESS: DSSubProcessTaskParams;
  PROCEDURE: DSProcedureTaskParams;
  SQL: DSSqlTaskParams;
  SPARK: DSSparkTaskParams;
  FLINK: DSFlinkTaskParams;
  FLINK_STREAM: DSFlinkStreamTaskParams;
  MR: DSMrTaskParams;
  PYTHON: DSPythonTaskParams;
  DEPENDENT: DSDependentTaskParams;
  HTTP: DSHttpTaskParams;
  DATAX: DSDataXTaskParams;
  SQOOP: DSSqoopTaskParams;
  CONDITIONS: DSConditionsTaskParams;
  SWITCH: DSSwitchTaskParams;
  SEATUNNEL: DSSeaTunnelTaskParams;
  K8S: DSK8sTaskParams;
  JAVA: DSJavaTaskParams;
  GRPC: DSGrpcTaskParams;
  EMR: DSEmrTaskParams;
  ZEPPELIN: DSZeppelinTaskParams;
  JUPYTER: DSJupyterTaskParams;
  MLFLOW: DSMlflowTaskParams;
  OPENMLDB: DSOpenmldbTaskParams;
  DVC: DSDvcTaskParams;
  DINKY: DSDinkyTaskParams;
  SAGEMAKER: DSSagemakerTaskParams;
  CHUNJUN: DSChunjunTaskParams;
  HIVECLI: DSHiveCliTaskParams;
  DMS: DSDmsTaskParams;
  DATASYNC: DSDatasyncTaskParams;
  KUBEFLOW: DSKubeflowTaskParams;
  LINKIS: DSLinkisTaskParams;
  DATA_FACTORY: DSDataFactoryTaskParams;
  REMOTESHELL: DSRemoteShellTaskParams;
  ALIYUN_SERVERLESS_SPARK: DSAliyunServerlessSparkTaskParams;
};

export function getDefaultTaskParams(taskType: DSTaskType): Record<string, unknown> {
  switch (taskType) {
    case 'SHELL':
      return { rawScript: '', localParams: [], resourceList: [], environmentCode: -1, cpuQuota: -1, memoryMax: -1 };
    case 'SQL':
      return { type: 'MYSQL', datasource: 0, sql: '', sqlType: '0', displayRows: 10, preStatements: [], postStatements: [], connParams: '', localParams: [] };
    case 'PYTHON':
      return { rawScript: '', localParams: [], resourceList: [], environmentCode: -1, cpuQuota: -1, memoryMax: -1 };
    case 'DATAX':
      return { customConfig: false, dsType: 'MYSQL', dtType: 'MYSQL', datasource: 0, dtDatasource: 0, sql: '', targetTable: '', jobSpeedByte: 0, jobSpeedRecord: 1000, xms: 1, xmx: 1, preStatements: [], postStatements: [], json: '', localParams: [], resourceList: [] };
    case 'SPARK':
      return { programType: 'SCALA', mainClass: '', mainJar: '', rawScript: '', master: '', deployMode: 'cluster', driverCores: 1, driverMemory: '512M', numExecutors: 2, executorMemory: '2G', executorCores: 2, appName: '', mainArgs: '', others: '', yarnQueue: '', sqlExecutionType: 'SCRIPT', localParams: [], resourceList: [] };
    case 'FLINK':
      return { programType: 'SCALA', mainClass: '', mainJar: '', deployMode: 'cluster', flinkVersion: '<1.10', jobManagerMemory: '1G', taskManagerMemory: '2G', slot: 1, taskManager: 2, parallelism: 1, appName: '', mainArgs: '', others: '', yarnQueue: '', rawScript: '', initScript: '', localParams: [], resourceList: [] };
    case 'FLINK_STREAM':
      return { programType: 'SCALA', deployMode: 'cluster', flinkVersion: '<1.10', jobManagerMemory: '1G', taskManagerMemory: '2G', slot: 1, taskManager: 2, parallelism: 1, yarnQueue: '', rawScript: '', initScript: '', localParams: [], resourceList: [] };
    case 'HTTP':
      return { url: '', httpMethod: 'GET', httpParams: [], httpBody: '', httpCheckCondition: 'STATUS_CODE_DEFAULT', condition: '', connectTimeout: 60000, socketTimeout: 60000, localParams: [] };
    case 'SUB_PROCESS':
      return { workflowDefinitionCode: 0 };
    case 'PROCEDURE':
      return { type: 'MYSQL', datasource: 0, method: '', localParams: [] };
    case 'MR':
      return { programType: 'SCALA', mainClass: '', mainJar: '', appName: '', mainArgs: '', others: '', yarnQueue: '', localParams: [], resourceList: [] };
    case 'DEPENDENT':
      return { dependence: { relation: 'AND', dependTaskList: [], failurePolicy: 'DEPENDENT_FAILURE_FAILURE', checkInterval: 10, failureWaitingTime: 0 } };
    case 'CONDITIONS':
      return { relation: 'AND', dependTaskList: [], successBranch: null, failedBranch: null };
    case 'SWITCH':
      return { switchResult: { dependTaskList: [], nextNode: null } };
    case 'SEATUNNEL':
      return { startupScript: 'seatunnel.sh', runMode: 'RUN', useCustom: true, deployMode: 'client', master: 'YARN', masterUrl: '', rawScript: '', resourceList: [] };
    case 'K8S':
      return { namespace: '', image: '', imagePullPolicy: 'IfNotPresent', pullSecret: '', command: '', args: '', minCpuCores: 0, minMemorySpace: '', customizedLabels: [], nodeSelectors: [] };
    case 'JAVA':
      return { runType: 'FAT_JAR', isModulePath: false, mainClass: '', mainJar: '', mainArgs: '', jvmArgs: '', localParams: [], resourceList: [] };
    case 'SQOOP':
      return { isCustomTask: false, modelType: 'import', sourceType: 'MYSQL', targetType: 'HIVE', sourceMysqlType: 'MYSQL', targetMysqlType: 'MYSQL', targetHdfsDeleteTargetDir: true, targetHdfsCompressionCodec: 'snappy', targetHdfsFileType: '--as-avrodatafile', targetHiveCreateTable: false, targetHiveOverWrite: true, targetMysqlUpdateMode: 'allowinsert', concurrency: 1, splitBy: '', srcQueryType: '1', srcColumnType: '0', hadoopCustomParams: [], sqoopAdvancedParams: [], mapColumnHive: [], mapColumnJava: [], localParams: [], resourceList: [] };
    case 'GRPC':
      return { url: '', grpcCredentialType: 'INSECURE', grpcCheckCondition: 'STATUS_CODE_DEFAULT', grpcServiceDefinitionJSON: '', condition: '', grpcConnectTimeoutMs: 60000, socketTimeout: 60000, localParams: [] };
    case 'EMR':
      return { programType: 'ADD_JOB_FLOW_STEPS', jobFlowDefinitionJSON: '', localParams: [] };
    case 'ZEPPELIN':
      return { restEndpoint: '', username: '', password: '', noteId: '', paragraphId: '', localParams: [] };
    case 'JUPYTER':
      return { rawScript: '', localParams: [], resourceList: [], environmentCode: -1, cpuQuota: -1, memoryMax: -1 };
    case 'MLFLOW':
      return { mlflowTaskType: 'MLflow Projects', mlflowTrackingUri: 'http://127.0.0.1:5000', algorithm: 'svm', mlflowJobType: 'CustomProject', automlTool: 'flaml', deployType: 'MLFLOW', deployPort: '7000', mlflowCustomProjectParameters: [], localParams: [], resourceList: [] };
    case 'OPENMLDB':
      return { zk: '', zkPath: '', executeMode: 'offline', sql: '', localParams: [] };
    case 'DVC':
      return { dvcTaskType: 'Upload', dvcRepository: '', dvcVersion: '', dvcDataPath: '', dvcStoreUrl: '', localParams: [] };
    case 'DINKY':
      return { dinkyTaskId: 0, dinkyUrl: '', dinkyTaskType: '', localParams: [] };
    case 'SAGEMAKER':
      return { awsRegion: '', sagemakerJobType: 'TrainingJob', sagemakerJobConfigJSON: '', localParams: [] };
    case 'CHUNJUN':
      return { customConfig: true, deployMode: 'local', json: '', dsType: 'MYSQL', dtType: 'MYSQL', datasource: 0, dtDatasource: 0, preStatements: [], postStatements: [], localParams: [], resourceList: [] };
    case 'HIVECLI':
      return { hiveCliTaskExecutionType: 'SCRIPT', hiveSql: '', hiveCliArgs: '', localParams: [], resourceList: [] };
    case 'DMS':
      return { isRestartTask: false, dmsTaskId: '', localParams: [] };
    case 'DATASYNC':
      return { datasyncTaskId: '', datasyncConfigJSON: '', localParams: [], resourceList: [] };
    case 'KUBEFLOW':
      return { kubeflowNamespace: '', kubeflowPipelineYaml: '', kubeflowParameters: [], localParams: [] };
    case 'LINKIS':
      return { useCustom: false, rawScript: '', paramScript: [], linkisJobContent: '', localParams: [], resourceList: [], environmentCode: -1, cpuQuota: -1, memoryMax: -1 };
    case 'DATA_FACTORY':
      return { factoryName: '', resourceGroupName: '', pipelineName: '', localParams: [] };
    case 'REMOTESHELL':
      return { type: 'SSH', datasource: 0, rawScript: '', localParams: [], resourceList: [], environmentCode: -1, cpuQuota: -1, memoryMax: -1 };
    case 'ALIYUN_SERVERLESS_SPARK':
      return { restEndpoint: '', username: '', password: '', jobId: '', sparkJobConfigJSON: '', localParams: [] };
    default:
      return {};
  }
}

export interface DolphinSchedulerApi {
  project: {
    list(params: { pageNo: number; pageSize: number; searchVal?: string }): Promise<DolphinSchedulerResponse<PageResult<DSProject>>>;
    create(data: { projectName: string; description?: string }): Promise<DolphinSchedulerResponse<DSProject>>;
    update(projectCode: number, data: { projectName?: string; description?: string }): Promise<DolphinSchedulerResponse<null>>;
    delete(projectCode: number): Promise<DolphinSchedulerResponse<null>>;
  };
  workflowDefinition: {
    list(projectCode: number, params: { pageNo: number; pageSize: number; searchVal?: string; releaseState?: string }): Promise<DolphinSchedulerResponse<PageResult<DSWorkflowDefinition>>>;
    detail(projectCode: number, code: number): Promise<DolphinSchedulerResponse<{
      workflowDefinition: DSWorkflowDefinition;
      taskNodes: DSWorkflowTaskNode[];
      edges: DSWorkflowEdge[];
      globalParams: DSWorkflowGlobalParam[];
    }>>;
    create(projectCode: number, data: { name: string; description: string }): Promise<DolphinSchedulerResponse<null>>;
    createWithTasks(projectCode: number, data: {
      name: string;
      description: string;
      executionType: ExecutionType;
      timeout: number;
      globalParams: DSWorkflowGlobalParam[];
      nodes: DSWorkflowTaskNode[];
      edges: DSWorkflowEdge[];
    }): Promise<DolphinSchedulerResponse<null>>;
    update(projectCode: number, code: number, data: {
      name: string;
      description: string;
      executionType: ExecutionType;
      timeout: number;
      globalParams: DSWorkflowGlobalParam[];
      nodes: DSWorkflowTaskNode[];
      edges: DSWorkflowEdge[];
      release: boolean;
    }): Promise<DolphinSchedulerResponse<null>>;
    release(projectCode: number, code: number, releaseState: ReleaseState): Promise<DolphinSchedulerResponse<null>>;
    delete(projectCode: number, code: number): Promise<DolphinSchedulerResponse<null>>;
    trigger(projectCode: number, params: DSTriggerWorkflowParams): Promise<DolphinSchedulerResponse<number[]>>;
  };
  workflowInstance: {
    list(params: { pageNo: number; pageSize: number; searchVal?: string; projectCode?: string; executionStatus?: string }): Promise<DolphinSchedulerResponse<PageResult<DSWorkflowInstance>>>;
    detail(id: number, projectCode: number): Promise<DolphinSchedulerResponse<DSWorkflowInstance>>;
    tasks(id: number, projectCode: number): Promise<DolphinSchedulerResponse<DSTaskInstance[]>>;
    execute(id: number, executeType: string, projectCode?: number): Promise<DolphinSchedulerResponse<null>>;
  };
  taskInstance: {
    list(params: { pageNo: number; pageSize: number; projectCode?: string; processInstanceId?: string; searchVal?: string; executionStatus?: string }): Promise<DolphinSchedulerResponse<PageResult<DSTaskInstance>>>;
    log(projectCode: number, taskInstanceId: number): Promise<DolphinSchedulerResponse<string>>;
    forceSuccess(taskInstanceId: number, projectCode?: number): Promise<DolphinSchedulerResponse<null>>;
  };
  datasource: {
    list(params: { pageNo: number; pageSize: number; searchVal?: string }): Promise<DolphinSchedulerResponse<PageResult<DSDataSource>>>;
  };
  workerGroup: {
    list(projectCode: number, params: { pageNo: number; pageSize: number; searchVal?: string }): Promise<DolphinSchedulerResponse<PageResult<DSWorkerGroup>>>;
  };
  tenant: {
    list(params: { pageNo: number; pageSize: number; searchVal?: string }): Promise<DolphinSchedulerResponse<PageResult<DSTenant>>>;
  };
  alertGroup: {
    list(params: { pageNo: number; pageSize: number; searchVal?: string }): Promise<DolphinSchedulerResponse<PageResult<DSAlertGroup>>>;
  };
  environment: {
    list(params: { pageNo: number; pageSize: number; searchVal?: string }): Promise<DolphinSchedulerResponse<PageResult<DSEnvironment>>>;
  };
  resource: {
    upload(data: { type: string; name: string; file: File; currentDir: string }): Promise<DolphinSchedulerResponse<null>>;
    list(type: string): Promise<DolphinSchedulerResponse<DSResourceItem[]>>;
    queryBaseDir(type: string): Promise<DolphinSchedulerResponse<string>>;
    createDir(data: { type: string; name: string; currentDir: string; description?: string }): Promise<DolphinSchedulerResponse<null>>;
  };
}

export interface DSDataSource {
  id: number;
  name: string;
  type: string;
  host: string;
  port: number;
  database: string;
  userName: string;
  connectionParams: string;
  note: string;
  other: Record<string, unknown>;
}

export interface DSWorkerGroup {
  id: number | null;
  projectCode: number;
  workerGroup: string;
  createTime: string | null;
  updateTime: string | null;
}

export interface DSTenant {
  id: number;
  tenantCode: string;
  description: string;
  queueId: number;
  queueName: string | null;
  createTime: string;
  updateTime: string;
}

export interface DSAlertGroup {
  id: number;
  groupName: string;
  alertInstanceIds: string | null;
  description: string;
  createTime: string;
  updateTime: string;
}

export interface DSEnvironment {
  id: number;
  code: number;
  name: string;
  config: string;
  description: string;
  workerGroups: string[];
  createTime: string;
  updateTime: string;
}

export interface DSResourceItem {
  id: number;
  code: number;
  name: string;
  fullName: string;
  type: string;
  directory: boolean;
  fileName: string;
  description: string;
  size: number;
}
