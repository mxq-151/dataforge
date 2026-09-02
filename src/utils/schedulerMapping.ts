import type { DSTaskType, DSWorkflowTaskNode, DSWorkflowEdge, DSWorkflowGlobalParam, DSLocalParam, DSDependentTaskParams } from '../types/dolphinscheduler';
import { getDefaultTaskParams, ExecutionType, Priority, TASK_CATEGORIES, TASK_TYPE_LABELS } from '../types/dolphinscheduler';
import { parseFileHeader } from './index';
import { toRelativePath } from './pathUtils';

function extractCodePackage(code: string): string {
  const match = code.match(/^\s*package\s+([\w.]+)\s*;?\s*$/m);
  return match ? match[1] : '';
}

function extractCodeClassName(code: string, ext: string): string {
  if (ext === 'scala') {
    const match = code.match(/^\s*(?:object|class)\s+(\w+)/m);
    return match ? match[1] : '';
  } else {
    const match = code.match(/^\s*(?:public\s+)?(?:class|interface|enum)\s+(\w+)/m);
    return match ? match[1] : '';
  }
}

function inferMainClass(code: string, ext: string): string {
  const pkg = extractCodePackage(code);
  const cls = extractCodeClassName(code, ext);
  if (cls) return pkg ? `${pkg}.${cls}` : cls;
  return '';
}

/** 从代码正文中提取 YARN 作业名称（Spark/Flink/SQL/Hive/MR 等提交到 YARN 的任务）。
 * 支持的常见写法：
 *  - Spark/Scala/Java: SparkSession.builder.appName("xxx") / .setAppName("xxx")
 *  - PySpark: .appName("xxx") / spark.appName = "xxx"
 *  - spark-submit 参数: --conf spark.app.name=xxx / --name xxx
 *  - Flink/Scala/Java/PyFlink: env.execute("xxx") / env.executeAsync("xxx") / .setJobName("xxx")
 *  - Flink 配置/CLI: pipeline.name=xxx / -Dyarn.application.name=xxx / -ynm xxx
 *  - SQL/Hive/Spark-SQL/MR: set mapreduce.job.name=xxx / set tez.job.name=xxx
 *                           / set hive.query.name=xxx / set spark.app.name=xxx / set yarn.application.name=xxx
 * 返回 null 表示代码中未显式设置 YARN 作业名称。
 */
export function extractYarnJobName(code: string): string | null {
  const patterns: RegExp[] = [
    // 1. .setAppName("x") / .appName("x")（Spark builder）
    /\.(?:setAppName|appName)\s*\(\s*["']([^"']+)["']\s*\)/,
    // 2. spark.conf.set("spark.app.name", "x") / .set("spark.app.name","x")
    /\.(?:conf\.)?set\s*\(\s*["']spark\.app\.name["']\s*,\s*["']([^"']+)["']\s*\)/,
    // 3. Flink 作业名: env.execute("x") / env.executeAsync("x") / .setJobName("x")
    //    仅匹配环境对象（env/tEnv/tableEnv/...），避免命中 jdbc statement.execute("SELECT...") 等
    /\b(?:env|tEnv|tableEnv|streamEnv|executionEnv|tableEnvironment|sEnv|senv)\s*\.\s*(?:execute(?:Async)?|setJobName)\s*\(\s*["']([^"']+)["']\s*\)/,
    // 4. spark-submit 参数: --conf spark.app.name=x
    /--conf\s+spark\.app\.name\s*=\s*["']?([^"'\s]+)/,
    // 5. spark-submit / flink run 参数: --name x
    /(?:^|\s)--name\s+["']?([^"'\s]+)/,
    // 6. Flink on YARN: -Dyarn.application.name=x / -ynm x
    /-Dyarn\.application\.name\s*=\s*["']?([^"'\s]+)/,
    /(?:^|\s)-ynm\s+["']?([^"'\s]+)/,
    // 7. 配置式赋值: spark.app.name = "x"
    /spark\.app\.name\s*[:=]\s*["']([^"']+)["']/,
    // 8. PySpark 属性式: spark.appName = "x" / .appName = "x"
    /\.?\bappName\s*[:=]\s*["']([^"']+)["']/,
    // 9. SQL/Hive/Spark-SQL/MR 中以 set 形式声明作业名（行首 set）
    /(?:^|\n)\s*set\s+(?:spark\.app\.name|mapreduce\.job\.name|mapred\.job\.name|tez\.job\.name|hive\.query\.name|yarn\.application\.name|pipeline\.name)\s*=\s*["']?([^"';]+)\s*["']?\s*;?/i,
    // 10. Flink pipeline.name 赋值（属性/配置）
    /pipeline\.name\s*[:=]\s*["']?([^"'\s]+)/,
  ];
  for (const re of patterns) {
    const m = code.match(re);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

export interface YarnJobNameValidation {
  valid: boolean;
  message: string;
  yarnJobName: string | null;
  fileName: string;
}

/** 校验代码中设置的 YARN 作业名称是否与文件名（不含扩展名）一致。
 * 仅当代码显式设置了 YARN 作业名称时才进行比对；未设置则视为无需校验（valid=true）。
 */
export function validateYarnJobName(
  code: string,
  fileName: string,
): YarnJobNameValidation {
  const fileStem = fileName.replace(/\.[^.]+$/, '');
  const yarnJobName = extractYarnJobName(code);

  if (!yarnJobName) {
    return { valid: true, message: '', yarnJobName: null, fileName: fileStem };
  }

  if (yarnJobName === fileStem) {
    return { valid: true, message: '', yarnJobName, fileName: fileStem };
  }

  return {
    valid: false,
    message: `代码中设置的 YARN 作业名称「${yarnJobName}」与文件名「${fileStem}」不一致，请修改其中之一使两者保持一致后再运行/提交`,
    yarnJobName,
    fileName: fileStem,
  };
}

export interface CodeFileMapping {
  recommendedTaskType: DSTaskType;
  recommendationReason: string;
  taskType: DSTaskType;
  taskName: string;
  workflowName: string;
  taskParams: Record<string, unknown>;
  description: string;
  filePath: string;
  relativePath: string;
  dirPath: string;
  dataSource: string | null;
  dataDependencies: string[];
  /** 代码头 @依赖 声明的前置任务依赖（{调度项目}.{前置任务名称}，前置任务名称不含文件扩展名） */
  headerDependencies: HeaderDependency[];
}

/**
 * 代码头 @依赖 的前置任务引用。
 * 格式：{调度项目}.{前置任务名称}，多个用英文逗号分隔。
 */
export interface HeaderDependency {
  /** 调度项目（也即项目编码） */
  projectCode: string;
  /** 前置任务名称（不含文件扩展名） */
  taskName: string;
}

/**
 * 解析代码头 @依赖 的值（逗号分隔的 {调度项目}.{前置任务名称}）。
 * - 空值、"无"、非法项会被忽略；同一 {调度项目}.{任务名称} 只保留一次。
 */
export function parseDependencyHeader(value: string | null | undefined): HeaderDependency[] {
  if (!value) return [];
  const trimmed = value.trim();
  if (!trimmed || trimmed === '无') return [];
  const deps: HeaderDependency[] = [];
  const seen = new Set<string>();
  for (const raw of trimmed.split(',')) {
    const token = raw.trim();
    if (!token || token === '无') continue;
    const dotIdx = token.indexOf('.');
    const projectCode = dotIdx >= 0 ? token.slice(0, dotIdx).trim() : '';
    const taskName = dotIdx >= 0 ? token.slice(dotIdx + 1).trim() : token.trim();
    if (!taskName) continue;
    const key = `${projectCode}.${taskName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deps.push({ projectCode, taskName });
  }
  return deps;
}

/** 已解析并确认存在的前置任务（对应调度项目内的某个工作流任务） */
export interface ResolvedDependency {
  /** 调度项目 code（数值） */
  projectCode: number;
  /** 前置任务所在工作流定义 code */
  definitionCode: number;
  /** 前置任务节点 code */
  taskCode: number;
  /** 前置任务名称 */
  taskName: string;
  /** 展示用 label：{调度项目}.{前置任务名称} */
  label: string;
}

/**
 * 将自定义 jar 依赖拼接为 --jars 参数值（多个以逗号连接）。
 * - 有 basePath：`basePath(尾斜杠判断) + jarPath(去前导斜杠)`（后端 SparkExecutionStrategy 语义）。
 * - 无 basePath（旧兼容）：jarPath 以 .jar 结尾视为完整文件路径直接使用；否则 jarPath(去尾斜杠) + '/' + (jarName||name)。
 * - 忽略无 jarPath 或无处名的条目。
 */
export function buildJarsArg(
  deps: { jarPath?: string; basePath?: string; jarName?: string; name?: string }[],
): string {
  const args: string[] = [];
  for (const d of deps) {
    if (!d.jarPath || !d.jarPath.trim()) continue;

    if (d.basePath) {
      const base = d.basePath.endsWith('/') ? d.basePath : `${d.basePath}/`;
      const path = d.jarPath.replace(/^\/+/, '');
      args.push(`${base}${path}`);
      continue;
    }

    if (d.jarPath.toLowerCase().endsWith('.jar')) {
      args.push(d.jarPath);
      continue;
    }
    const file = (d.jarName || d.name || '').trim();
    if (!file) continue;
    const dir = d.jarPath.endsWith('/') ? d.jarPath.replace(/\/+$/, '') : d.jarPath;
    args.push(`${dir}/${file}`);
  }
  return args.join(',');
}

/**
 * 根据已解析的前置任务构建一个 DEPENDENT 任务节点，用于设置跨工作流的前置依赖。
 * 生成的节点参数为 AND 关系、任一前置失败则失败、每 10s 轮询。DolphinScheduler 据此
 * 在运行前等待所有引用任务成功完成。
 */
export function buildDependentTaskNode(
  deps: ResolvedDependency[],
  code: number,
  x?: number,
  y?: number,
): DSWorkflowTaskNode {
  const taskParams: DSDependentTaskParams = {
    dependence: {
      relation: 'AND',
      dependTaskList: [
        {
          relation: 'AND',
          dependItemList: deps.map(d => ({
            projectCode: d.projectCode,
            definitionCode: d.definitionCode,
            depTaskCode: d.taskCode,
            cycle: 'day',
            dateValue: 'today',
          })),
        },
      ],
      failurePolicy: 'DEPENDENT_FAILURE_FAILURE',
      // 扩展字段（DS 允许额外字段）
      checkInterval: 10,
      failureWaitingTime: 0,
    },
  };
  return {
    code,
    name: '前置依赖',
    taskType: 'DEPENDENT',
    description: `等待前置任务完成: ${deps.map(d => d.label).join(', ')}`,
    taskParams: JSON.stringify(taskParams),
    flag: 'YES',
    taskPriority: Priority.MEDIUM,
    workerGroup: 'default',
    environmentCode: -1,
    failRetryTimes: 0,
    failRetryInterval: 1,
    timeoutFlag: 'CLOSE',
    timeout: 0,
    delayTime: 0,
    x: x ?? 100,
    y: y ?? 100,
  };
}

export interface SavedConfig {
  dependencies: { id: string; name: string; version: string; source?: string; jarPath?: string; groupId?: string; scope?: string; autoChoose?: number | null; basePath?: string }[];
  programParams: { id: string; key: string; value: string }[];
  taskParams: { id: string; key: string; value: string }[];
}

const EXT_TO_TASK_TYPE: Record<string, DSTaskType> = {
  sql: 'SQL',
  py: 'PYTHON',
  sh: 'SHELL',
  bash: 'SHELL',
};

const ENGINE_REQUIRED_EXTS = new Set(['java', 'scala']);

const ENGINE_TO_TASK_TYPE: Record<string, DSTaskType> = {
  mysql: 'SQL',
  postgresql: 'SQL',
  hive: 'SQL',
  kyuubi: 'SQL',
  clickhouse: 'SQL',
  doris: 'SQL',
  starrocks: 'SQL',
  presto: 'SQL',
  trino: 'SQL',
  spark: 'SPARK',
  flink: 'FLINK',
  flink_stream: 'FLINK_STREAM',
  mr: 'MR',
  mapreduce: 'MR',
  python: 'PYTHON',
  shell: 'SHELL',
  java: 'JAVA',
  procedure: 'PROCEDURE',
  http: 'HTTP',
  datax: 'DATAX',
  sqoop: 'SQOOP',
  seatunnel: 'SEATUNNEL',
  hivecli: 'HIVECLI',
  dinky: 'DINKY',
  linkis: 'LINKIS',
};

export interface TaskTypeRecommendation {
  taskType: DSTaskType;
  reason: string;
}

function getRecommendedTaskType(fileName: string, codeContent: string): TaskTypeRecommendation {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  const header = parseFileHeader(codeContent);

  if (ENGINE_REQUIRED_EXTS.has(ext)) {
    if (header?.engine) {
      const engineLower = header.engine.toLowerCase();
      if (ENGINE_TO_TASK_TYPE[engineLower]) {
        return {
          taskType: ENGINE_TO_TASK_TYPE[engineLower],
          reason: `根据 @引擎:${header.engine} 推荐`,
        };
      }
    }
    return {
      taskType: 'SPARK',
      reason: `${ext.toUpperCase()} 文件未声明 @引擎，默认推荐 SPARK（请在代码头添加 @引擎: spark/flink/mr 等指定运行引擎）`,
    };
  }

  const extTaskType: DSTaskType = EXT_TO_TASK_TYPE[ext] || 'SHELL';

  if (header?.engine) {
    const engineLower = header.engine.toLowerCase();
    if (ENGINE_TO_TASK_TYPE[engineLower]) {
      return {
        taskType: ENGINE_TO_TASK_TYPE[engineLower],
        reason: `根据 @引擎:${header.engine} 推荐`,
      };
    }
  }

  return {
    taskType: extTaskType,
    reason: `根据文件扩展名 .${ext} 推荐`,
  };
}

export function getAvailableTaskTypes(): { value: DSTaskType; label: string; category: string }[] {
  const result: { value: DSTaskType; label: string; category: string }[] = [];
  for (const cat of TASK_CATEGORIES) {
    for (const t of cat.tasks) {
      result.push({ value: t, label: TASK_TYPE_LABELS[t], category: cat.label });
    }
  }
  return result;
}

export function mapCodeFileToTask(
  fileName: string,
  codeContent: string,
  filePath?: string,
  rootPath?: string,
  savedConfig?: SavedConfig | null,
  overrideTaskType?: DSTaskType,
): CodeFileMapping {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  const header = parseFileHeader(codeContent);
  const recommendation = getRecommendedTaskType(fileName, codeContent);
  const recommendedTaskType = recommendation.taskType;
  const taskType = overrideTaskType || recommendedTaskType;

  const relativePath = getRelativePath(filePath, rootPath);
  const dirPath = getDirectoryPath(relativePath);
  // 任务名称只取文件名部分（不含目录、不含扩展名），作为调度任务节点名；
  // 工作流名称取目录路径，斜杠/反斜杠统一替换为下划线，保证 DS 名称合法
  const taskName = fileName.replace(/\.[^.]+$/, '');
  const workflowName = (dirPath || fileName.replace(/\.[^.]+$/, '')).replace(/[/\\]/g, '_');

  const baseParams = getDefaultTaskParams(taskType);
  const codeBody = stripFileHeader(codeContent);

  switch (taskType) {
    case 'SQL': {
      const sqlType = detectSqlType(codeBody);
      baseParams.sql = codeBody;
      baseParams.sqlType = sqlType;
      baseParams.type = mapEngineToDatasourceType(header?.engine || '');
      break;
    }
    case 'PYTHON': {
      baseParams.rawScript = codeBody;
      applyRuntimeParams(baseParams, savedConfig, 'PYTHON');
      break;
    }
    case 'SHELL': {
      baseParams.rawScript = codeBody;
      applyRuntimeParams(baseParams, savedConfig, 'SHELL');
      break;
    }
    case 'SPARK': {
      baseParams.rawScript = codeBody;
      const inferredMainClass = inferMainClass(codeContent, ext);
      if (inferredMainClass) {
        baseParams.mainClass = inferredMainClass;
        baseParams.appName = inferredMainClass;
      }
      if (ext === 'scala') {
        baseParams.programType = 'SCALA';
        baseParams.sqlExecutionType = 'SCRIPT';
      } else if (ext === 'py') {
        baseParams.programType = 'PYTHON';
      } else if (ext === 'sql') {
        baseParams.programType = 'SQL';
        baseParams.sqlExecutionType = 'SCRIPT';
      } else if (ext === 'java') {
        baseParams.programType = 'JAVA';
      } else {
        baseParams.programType = 'SCALA';
      }
      applyRuntimeParams(baseParams, savedConfig, 'SPARK');
      break;
    }
    case 'FLINK': {
      baseParams.rawScript = codeBody;
      const inferredMainClass = inferMainClass(codeContent, ext);
      if (inferredMainClass) {
        baseParams.mainClass = inferredMainClass;
        baseParams.appName = inferredMainClass;
      }
      if (ext === 'java') {
        baseParams.programType = 'JAVA';
      } else if (ext === 'py') {
        baseParams.programType = 'PYTHON';
      } else if (ext === 'sql') {
        baseParams.programType = 'SQL';
      } else if (ext === 'scala') {
        baseParams.programType = 'SCALA';
      } else {
        baseParams.programType = 'JAVA';
      }
      applyRuntimeParams(baseParams, savedConfig, 'FLINK');
      break;
    }
    case 'FLINK_STREAM': {
      baseParams.rawScript = codeBody;
      const inferredMainClass = inferMainClass(codeContent, ext);
      if (inferredMainClass) {
        baseParams.mainClass = inferredMainClass;
        baseParams.appName = inferredMainClass;
      }
      if (ext === 'java') {
        baseParams.programType = 'JAVA';
      } else if (ext === 'py') {
        baseParams.programType = 'PYTHON';
      } else if (ext === 'scala') {
        baseParams.programType = 'SCALA';
      } else {
        baseParams.programType = 'JAVA';
      }
      applyRuntimeParams(baseParams, savedConfig, 'FLINK_STREAM');
      break;
    }
    case 'MR': {
      const inferredMainClass = inferMainClass(codeContent, ext);
      if (inferredMainClass) {
        baseParams.mainClass = inferredMainClass;
        baseParams.appName = inferredMainClass;
      }
      if (ext === 'java') {
        baseParams.programType = 'JAVA';
      } else if (ext === 'scala') {
        baseParams.programType = 'SCALA';
      } else if (ext === 'py') {
        baseParams.programType = 'PYTHON';
      } else {
        baseParams.programType = 'JAVA';
      }
      applyRuntimeParams(baseParams, savedConfig, 'MR');
      break;
    }
    case 'JAVA': {
      const inferredMainClass = inferMainClass(codeContent, ext);
      if (inferredMainClass) baseParams.mainClass = inferredMainClass;
      applyRuntimeParams(baseParams, savedConfig, 'JAVA');
      break;
    }
    case 'HIVECLI': {
      baseParams.hiveSql = codeBody;
      baseParams.hiveCliTaskExecutionType = 'SCRIPT';
      break;
    }
    default: {
      if ('rawScript' in baseParams) {
        (baseParams as Record<string, unknown>).rawScript = codeBody;
      }
      applyRuntimeParams(baseParams, savedConfig, taskType);
      break;
    }
  }

  const dataDependencies = extractDataDependencies(codeContent, header);
  const headerDependencies = parseDependencyHeader(header?.dependency);

  return {
    recommendedTaskType,
    recommendationReason: recommendation.reason,
    taskType,
    taskName,
    workflowName,
    taskParams: baseParams,
    description: header?.remark || `从开发助手提交: ${relativePath || fileName}`,
    filePath: filePath || fileName,
    relativePath,
    dirPath,
    dataSource: header?.dataSource || null,
    dataDependencies,
    headerDependencies,
  };
}

function applyRuntimeParams(
  taskParams: Record<string, unknown>,
  savedConfig: SavedConfig | null | undefined,
  taskType: DSTaskType | string,
) {
  if (!savedConfig) return;

  const localParams: DSLocalParam[] = [];
  for (const p of savedConfig.programParams) {
    if (p.key) {
      localParams.push({
        prop: p.key,
        direct: 'IN',
        type: 'VARCHAR',
        value: p.value,
      });
    }
  }

  if (localParams.length > 0) {
    const existing = (taskParams.localParams as DSLocalParam[]) || [];
    taskParams.localParams = [...existing, ...localParams];
  }

  if (taskType === 'SPARK' || taskType === 'FLINK') {
    for (const p of savedConfig.taskParams) {
      if (!p.key) continue;
      const keyLower = p.key.toLowerCase();
      if (keyLower.includes('driver') && keyLower.includes('memory') && taskType === 'SPARK') {
        taskParams.driverMemory = p.value;
      } else if (keyLower.includes('executor') && keyLower.includes('memory') && taskType === 'SPARK') {
        taskParams.executorMemory = p.value;
      } else if (keyLower.includes('executor') && keyLower.includes('cores') && taskType === 'SPARK') {
        taskParams.executorCores = Number(p.value) || 2;
      } else if (keyLower.includes('num') && keyLower.includes('executor') && taskType === 'SPARK') {
        taskParams.numExecutors = Number(p.value) || 2;
      } else if (keyLower.includes('parallelism') && taskType === 'FLINK') {
        taskParams.parallelism = Number(p.value) || 1;
      } else if (keyLower.includes('jobmanager') && keyLower.includes('memory') && taskType === 'FLINK') {
        taskParams.jobManagerMemory = p.value;
      } else if (keyLower.includes('taskmanager') && keyLower.includes('memory') && taskType === 'FLINK') {
        taskParams.taskManagerMemory = p.value;
      } else if (keyLower.includes('deploy') && keyLower.includes('mode')) {
        taskParams.deployMode = p.value;
      } else if (keyLower.includes('queue') || keyLower.includes('yarnqueue')) {
        if (taskType === 'SPARK') taskParams.yarnQueue = p.value;
        else if (taskType === 'FLINK') taskParams.yarnQueue = p.value;
      }
    }
  }

  // --jars 不在本函数注入：避免进入提交弹窗「其他参数」输入框，改由 SubmitToSchedulerModal 提交时 buildJarsArg 动态拼接。
  // 依赖（jarDependencyCatalogs）也不应回填到 Spark 任务的 resourceList，提交时仅由 buildJarsArg 生成 --jars 与 classpath 相关参数。
}

function extractDataDependencies(codeContent: string, header: ReturnType<typeof parseFileHeader>): string[] {
  const deps = new Set<string>();

  if (header?.dataSource) {
    deps.add(header.dataSource);
  }

  const dsMatch = codeContent.match(/(?:--|\/\/|#)\s*@数据源[:\s=]+(\S+)/i);
  if (dsMatch) deps.add(dsMatch[1]);

  const useMatches = codeContent.matchAll(/(?:use|@use)\s+(\w+)/gi);
  for (const m of useMatches) {
    if (m[1]) deps.add(m[1]);
  }

  const fromMatches = codeContent.matchAll(/\bfrom\s+(\w+)/gi);
  for (const m of fromMatches) {
    if (m[1] && !['select', 'where', 'dual'].includes(m[1].toLowerCase())) {
      deps.add(m[1]);
    }
  }

  const insertMatches = codeContent.matchAll(/\binsert\s+into\s+(\w+)/gi);
  for (const m of insertMatches) {
    if (m[1]) deps.add(m[1]);
  }

  return Array.from(deps);
}

function getRelativePath(filePath?: string, rootPath?: string): string {
  if (!filePath) return '';
  if (!rootPath) return filePath.split(/[/\\]/).pop() || filePath;
  // 忽略分隔符差异：跳转打开的 Tab 路径是 Windows 本地形式（C:\a\b.java），
  // 而 rootPath 由 joinPath 拼成（C:/a）。直接 startsWith 会取不到相对路径。
  return toRelativePath(filePath, rootPath);
}

function getDirectoryPath(relativePath: string): string {
  if (!relativePath) return '';
  const lastSlash = Math.max(relativePath.lastIndexOf('/'), relativePath.lastIndexOf('\\'));
  if (lastSlash <= 0) return '';
  return relativePath.substring(0, lastSlash);
}

function stripFileHeader(content: string): string {
  const lines = content.split('\n');
  const codeLines: string[] = [];
  let headerEnded = false;

  for (const line of lines) {
    if (!headerEnded) {
      const trimmed = line.trim();
      if (
        trimmed.startsWith('--') ||
        trimmed.startsWith('//') ||
        trimmed.startsWith('#')
      ) {
        if (trimmed.match(/@\S+:/)) {
          continue;
        }
      }
      headerEnded = true;
    }
    if (headerEnded) {
      codeLines.push(line);
    }
  }

  return codeLines.join('\n').trim();
}

function detectSqlType(sql: string): '0' | '1' {
  const upper = sql.trim().toUpperCase();
  if (
    upper.startsWith('SELECT') ||
    upper.startsWith('WITH') ||
    upper.startsWith('SHOW') ||
    upper.startsWith('DESC') ||
    upper.startsWith('EXPLAIN')
  ) {
    return '0';
  }
  return '1';
}

function mapEngineToDatasourceType(engine: string): string {
  const map: Record<string, string> = {
    mysql: 'MYSQL',
    postgresql: 'POSTGRESQL',
    hive: 'HIVE',
    kyuubi: 'HIVE',
    clickhouse: 'CLICKHOUSE',
    doris: 'MYSQL',
    starrocks: 'MYSQL',
    presto: 'PRESTO',
    trino: 'PRESTO',
    oracle: 'ORACLE',
    sqlserver: 'SQLSERVER',
    db2: 'DB2',
  };
  return map[engine.toLowerCase()] || 'MYSQL';
}

export function buildWorkflowFromCodeFile(
  mapping: CodeFileMapping,
  workflowDescription: string,
): {
  name: string;
  description: string;
  executionType: ExecutionType;
  timeout: number;
  globalParams: DSWorkflowGlobalParam[];
  nodes: DSWorkflowTaskNode[];
  edges: DSWorkflowEdge[];
} {
  const taskCode = Date.now();

  const node: DSWorkflowTaskNode = {
    code: taskCode,
    name: sanitizeDsName(mapping.taskName),
    taskType: mapping.taskType,
    description: mapping.description,
    taskParams: JSON.stringify(mapping.taskParams),
    flag: 'YES',
    taskPriority: Priority.MEDIUM,
    workerGroup: 'default',
    environmentCode: -1,
    failRetryTimes: 0,
    failRetryInterval: 1,
    timeoutFlag: 'CLOSE',
    timeout: 0,
    delayTime: 0,
    x: 200,
    y: 100,
  };

  return {
    name: sanitizeDsName(mapping.workflowName),
    description: workflowDescription,
    executionType: ExecutionType.PARALLEL,
    timeout: 0,
    globalParams: [],
    nodes: [node],
    edges: [],
  };
}

export function sanitizeDsName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_\u4e00-\u9fa5\-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .substring(0, 200);
}

export interface ValidationError {
  field: string;
  message: string;
}

export function validateSubmission(
  mapping: CodeFileMapping | null,
  selectedProjectCode: number | null,
  workflowName: string,
  selectedWorkflowCode: number | null,
  isRealApi: boolean,
): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!isRealApi) {
    errors.push({ field: 'api', message: '当前使用 Mock API，请在设置中配置 DolphinScheduler 连接信息' });
  }

  if (!mapping) {
    errors.push({ field: 'mapping', message: '无法解析代码文件映射' });
    return errors;
  }

  if (!selectedProjectCode) {
    errors.push({ field: 'project', message: '请选择目标项目' });
  }

  if (!selectedWorkflowCode && !workflowName.trim()) {
    errors.push({ field: 'workflowName', message: '请输入工作流名称' });
  }

  if (workflowName.length > 200) {
    errors.push({ field: 'workflowName', message: '工作流名称不能超过200个字符' });
  }

  if (!mapping.taskName.trim()) {
    errors.push({ field: 'taskName', message: '任务名称不能为空' });
  }

  if (mapping.taskName.length > 200) {
    errors.push({ field: 'taskName', message: '任务名称不能超过200个字符' });
  }

  const taskParams = mapping.taskParams;

  switch (mapping.taskType) {
    case 'SQL': {
      if (!taskParams.sql || !(taskParams.sql as string).trim()) {
        errors.push({ field: 'taskParams', message: 'SQL 任务必须有 SQL 内容' });
      }
      if (!taskParams.type) {
        errors.push({ field: 'taskParams', message: 'SQL 任务必须指定数据源类型' });
      }
      break;
    }
    case 'PYTHON':
    case 'SHELL': {
      if (!taskParams.rawScript || !(taskParams.rawScript as string).trim()) {
        errors.push({ field: 'taskParams', message: `${mapping.taskType} 任务必须有脚本内容` });
      }
      break;
    }
    case 'SPARK': {
      if (!taskParams.rawScript || !(taskParams.rawScript as string).trim()) {
        errors.push({ field: 'taskParams', message: 'Spark 任务必须有脚本内容' });
      }
      if (!taskParams.programType) {
        errors.push({ field: 'taskParams', message: 'Spark 任务必须指定程序类型' });
      }
      break;
    }
    case 'FLINK': {
      if (!taskParams.rawScript || !(taskParams.rawScript as string).trim()) {
        errors.push({ field: 'taskParams', message: 'Flink 任务必须有脚本内容' });
      }
      if (!taskParams.programType) {
        errors.push({ field: 'taskParams', message: 'Flink 任务必须指定程序类型' });
      }
      break;
    }
    case 'JAVA': {
      if (!taskParams.mainClass) {
        errors.push({ field: 'taskParams', message: 'Java 任务必须指定主类' });
      }
      break;
    }
    case 'HTTP': {
      if (!taskParams.url) {
        errors.push({ field: 'taskParams', message: 'HTTP 任务必须指定 URL' });
      }
      break;
    }
    case 'DATAX': {
      if (!taskParams.customConfig && !taskParams.json) {
        if (!taskParams.sql) {
          errors.push({ field: 'taskParams', message: 'DataX 任务必须配置 SQL 或自定义 JSON' });
        }
      }
      break;
    }
  }

  return errors;
}
