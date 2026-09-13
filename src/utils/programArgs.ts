/**
 * 「程序运行参数」的唯一换算口径。
 *
 * 背景：后端远程执行接口（submitCode / submitCodeWithJar）只接受
 * `runParams: Record<string, unknown>`（键值对），所以「运行程序」前的确认框也用
 * 键值对逐行编辑（与「配置参数 → 配置程序参数」同一形态），本模块集中定义
 * 「行数据 → runParams」的换算与校验规则，供弹窗与运行钩子共用：
 *
 *   - 参数名首尾空白会被去掉；**参数名为空的行整行丢弃**（连值一起丢，不产生匿名参数）
 *   - 参数名重复时**后出现的取值生效**（弹窗会显式提示，不静默覆盖）
 *   - 值一律按字符串下发（`true` / `1` 也是字符串，后端按字符串处理）
 *
 * 与「本地运行配置」的文本参数无关：本地执行传的是 args 数组、不经 shell，
 * 那条链路仍按空格拆分（见 useProgramRunner 的 splitArgs）。
 */

import { parseFileHeader } from './fileHeader';

export interface ProgramParamItem {
  id?: string;
  key: string;
  value: string;
}

/** 行 id 只用于 React key 与行定位，同一会话内单调递增即可（无需全局唯一） */
let rowSeq = 0;

/** 生成一行参数（key/value 可给初值），供弹窗「添加参数」与预填复用 */
export function createParamRow(key = '', value = ''): ProgramParamItem {
  rowSeq += 1;
  return { id: `program-param-${rowSeq}`, key, value };
}

/**
 * 把已保存的参数复制成带新 id 的可编辑行。
 * 新 id 保证「重新打开弹窗」时行元素被重新挂载，不会残留上一次的行内 DOM 状态。
 */
export function toParamRows(items: readonly ProgramParamItem[] | null | undefined): ProgramParamItem[] {
  return (items || []).map(item => createParamRow(item.key ?? '', item.value ?? ''));
}

/** 行数据 → runParams（参数名去首尾空白；空参数名的行整行丢弃；同名后者覆盖前者） */
export function paramsFromItems(items: readonly ProgramParamItem[] | null | undefined): Record<string, string> {
  const params: Record<string, string> = {};
  for (const item of items || []) {
    const key = (item.key ?? '').trim();
    if (!key) continue;
    params[key] = item.value ?? '';
  }
  return params;
}

/**
 * 需要提示「被忽略」的行下标：填了值却没填参数名。
 * 这类行会被整行丢掉，不提示的话用户会以为参数生效了。
 */
export function findRowsMissingKey(items: readonly ProgramParamItem[] | null | undefined): number[] {
  const indexes: number[] = [];
  (items || []).forEach((item, index) => {
    if (!(item.key ?? '').trim() && (item.value ?? '') !== '') indexes.push(index);
  });
  return indexes;
}

/** 重复的参数名（保持首次出现的顺序，已去重），供弹窗提示「后者生效」 */
export function findDuplicateKeys(items: readonly ProgramParamItem[] | null | undefined): string[] {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const item of items || []) {
    const key = (item.key ?? '').trim();
    if (!key) continue;
    if (seen.has(key)) {
      if (!duplicates.includes(key)) duplicates.push(key);
    } else {
      seen.add(key);
    }
  }
  return duplicates;
}

/** 合法参数名：字母/下划线开头，允许字母数字、下划线、点、连字符（与代码头参数声明的写法一致） */
const PARAM_KEY_PATTERN = /^[A-Za-z_][\w.\-]*$/;

/** SQL 变量占位符：`${day}` / `${dt}` */
const SQL_VAR_PATTERN = /\$\{([^{}]+)\}/g;

/**
 * 去掉 SQL 注释（`-- 行注释` 与 `/* … *\/ 块注释`），返回仅含有效语句的文本。
 *
 * 目的是避免注释里的示例变量被当成真参数：代码头本身是块注释，`@备注` 里若举例写了
 * `${day}`，不该因此多出一个参数（代码头 @程序参数 / @资源参数 / @任务参数 另行解析，不受影响）。
 */
export function stripSqlComments(sql: string): string {
  const text = sql ?? '';
  let out = '';
  let i = 0;
  let quote: "'" | '"' | '`' | null = null;

  while (i < text.length) {
    const ch = text[i];

    // 字符串字面量内的 `--` / `/*` 不是注释（如 where note = 'a -- b'）
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
      i++;
      continue;
    }

    if (ch === '-' && text[i + 1] === '-') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

/** 剥掉 `-` / `--` 前缀与 `=取值`，得到参数名：`--day` → `day`、`--env=prod` → `env`、`-p` → `p` */
export function paramFlagName(token: string): string {
  const body = (token ?? '').replace(/^--?/, '');
  const eq = body.indexOf('=');
  return (eq >= 0 ? body.slice(0, eq) : body).trim();
}

/**
 * 从代码头参数声明文本（`@程序参数` / `@资源参数` / `@任务参数`，旧格式 `@用法`）里取出**原始 flag**
 * （保持出现顺序与去重）：
 *   `--day 20260501 -checkpoint 60000` → ['--day', '-checkpoint']
 *   `--env=prod`                       → ['--env=prod']
 *   `无` / 空                          → []
 *
 * 只认以 `-` 开头的 token，取值（`20260501`、`60000`）自然被跳过；值里带空格时写成引号即可。
 * `--offset -1` 里的 `-1` 不是参数名（首字符非字母/下划线），同样被跳过。
 */
export function parseParamFlags(declaration: string | null | undefined): string[] {
  const flags: string[] = [];
  for (const token of (declaration ?? '').split(/\s+/).filter(Boolean)) {
    if (!token.startsWith('-') || token === '-' || token === '--') continue;
    if (!PARAM_KEY_PATTERN.test(paramFlagName(token))) continue;
    flags.push(token);
  }
  // 同一 flag 只保留一次（`--day 1 --day 2` 只给一行预填）
  return flags.filter((flag, index) => flags.indexOf(flag) === index);
}

/** 参数声明文本里出现的参数名（裸名，去重）：`--day 20260501 -checkpoint 60000` → ['day', 'checkpoint'] */
export function parseParamKeys(declaration: string | null | undefined): string[] {
  const keys: string[] = [];
  for (const flag of parseParamFlags(declaration)) {
    const key = paramFlagName(flag);
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

// ══════════════════════════════════════════════════════════════
// 引擎（框架）参数识别 —— 仅用于**旧格式** `@用法` 的兼容拆分
// ══════════════════════════════════════════════════════════════
//
// 代码头把参数拆成了三个字段（见 opencodeInstructions.ts「代码头格式规范」）：
//   @程序参数: --day 20260501 -checkpoint 60000      → 业务入参（→ runParams）
//   @资源参数: --num-executors 4 --driver-memory 2g  → 算力/资源归属（调度侧任务的资源配置）
//   @任务参数: --master yarn --deploy-mode cluster   → 提交与引擎侧参数（调度侧任务配置）
// 显式声明即分类结果，**不再**按引擎类型二次推断。
//
// 下面的表只服务于 v2 老文件：那时只有一个 `@用法`，spark / flink 的提交命令和业务入参
// 混写在一起，例如
//   @用法: --master yarn --deploy-mode cluster --class com.x.Y --num-executors 4 --driver-memory 2g app.jar --day 20260501
//   @用法: -m yarn-cluster -p 4 -yjm 1024 -c com.x.Y app.jar --day 20260501
// 其中 `--master` / `-c` / `-yjm` 这些是**引擎与资源参数**，落库后属于调度侧的
// 「任务参数」（见 utils/schedulerMapping.ts::applyRuntimeParams 把它们映射到
// driverMemory / executorCores / parallelism / jobManagerMemory 等字段），
// 只有 jar 之后跟着的 `--day` 才是业务入参（→ runParams）。
// 不拆分的话，弹窗里会莫名多出 --master、-c 这类行，用户还得自己删。

/** 走 spark 提交形态的引擎（@引擎 取值） */
const SPARK_ENGINE_NAMES = new Set(['spark']);

/** 走 flink 提交形态的引擎（@引擎 取值） */
const FLINK_ENGINE_NAMES = new Set(['flink', 'flink_stream']);

/** spark-submit / spark-sql 的选项名（小写比对） */
const SPARK_ENGINE_FLAGS = new Set([
  'master', 'deploy-mode', 'class', 'name', 'jars', 'packages', 'exclude-packages',
  'repositories', 'files', 'archives', 'conf', 'properties-file',
  'driver-memory', 'driver-cores', 'driver-java-options', 'driver-library-path',
  'driver-class-path', 'executor-memory', 'executor-cores', 'num-executors',
  'total-executor-cores', 'queue', 'principal', 'keytab', 'proxy-user',
  'supervise', 'verbose', 'py-files', 'spark-home', 'status', 'kill',
  'version', 'help',
]);

/**
 * flink run / flink run-application 的选项名（小写比对）。
 * 含单字母短选项（`-p` 并行度、`-c` 主类、`-m` JobManager、`-d` 分离提交……）与
 * YARN 简写（`-yjm` JobManager 内存、`-ytm` TaskManager 内存、`-ys` slot 数……）。
 * `-checkpoint` 之类**不在**此列 —— 那些是程序自己的入参，必须保留。
 */
const FLINK_ENGINE_FLAGS = new Set([
  'class', 'classpath', 'jobmanager', 'parallelism', 'detached', 'jarfile',
  'fromsavepoint', 'savepointpath', 'allownonrestoredstate', 'job-classname',
  'python', 'pyfiles', 'pymodule', 'pyexecutable', 'target', 'application-type',
  'config', 'yarnname', 'yarnship', 'yarnapplicationid', 'queue', 'help', 'version',
  // 单字母短选项
  'c', 'd', 'j', 'm', 'p', 's',
  // YARN 简写
  'yjm', 'ytm', 'ys', 'yn', 'ynm', 'yqu', 'yd', 'yid', 'yt', 'yz', 'qu',
]);

/**
 * 该 flag 是否属于 spark / flink 的**提交框架参数**（不是业务入参）。
 *
 * 只服务于**旧格式** `@用法` 的兼容拆分（见本文件上方说明）：新代码头用 `@资源参数` /
 * `@任务参数` 显式声明，不再走这个判定。旧格式下只在代码头 `@引擎` 明确声明为 spark / flink /
 * flink_stream 时才判定 —— 其它引擎（kyuubi、hive、python……）的 `@用法` 全是业务入参，
 * 不做剔除，避免误伤同名参数；未声明 @引擎 时同样不判定（@引擎 必填，缺了会被代码头校验拦下）。
 *
 * @param token 参数声明里的原始 token，如 `--driver-memory`、`-p`、`-Dyarn.x=y`
 * @param engine 代码头 `@引擎` 的值
 */
export function isEngineParamFlag(token: string, engine: string | null | undefined): boolean {
  const eng = (engine ?? '').trim().toLowerCase();
  if (!eng) return false;

  if (SPARK_ENGINE_NAMES.has(eng)) {
    return SPARK_ENGINE_FLAGS.has(paramFlagName(token).toLowerCase());
  }
  if (FLINK_ENGINE_NAMES.has(eng)) {
    // flink 的动态配置写法：`-D key=value` / `-Dkey=value`（如 -Dyarn.application.name=x）
    if (/^-D[A-Za-z]/.test(token) || token === '-D') return true;
    return FLINK_ENGINE_FLAGS.has(paramFlagName(token).toLowerCase());
  }
  return false;
}

/**
 * 从 SQL 正文里取 `${var}` 变量名（保持首次出现顺序、去重）。
 * 只认「纯标识符」形式的变量名：`${fn(a, b)}` 这类模板表达式不是参数，直接跳过；
 * DolphinScheduler 内置日期参数写的是 `$[yyyyMMdd]`，形式不同，也不会被误判。
 */
export function parseSqlVarKeys(sql: string): string[] {
  const keys: string[] = [];
  const text = stripSqlComments(sql ?? '');

  SQL_VAR_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SQL_VAR_PATTERN.exec(text)) !== null) {
    const key = match[1].trim();
    if (!PARAM_KEY_PATTERN.test(key)) continue;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

export interface ExtractedProgramParams {
  /** 识别出的**程序（业务）**参数名：代码头 @程序参数 在前、SQL 正文变量在后，各自保持出现顺序并去重 */
  keys: string[];
  /**
   * 识别出的**任务参数**原始 flag —— 来自代码头 `@任务参数`；旧格式下由引擎参数表
   * 从 `@用法` 里识别（见 isEngineParamFlag）。
   * 弹窗只把它们列出来告诉用户「该去哪配」，不进预填行、不随程序参数下发。
   */
  taskParamKeys: string[];
  /**
   * 识别出的**资源参数**原始 flag —— 来自代码头 `@资源参数`（v4 起从 `@任务参数` 中单列）。
   * 与 taskParamKeys 同理：只告知、不进预填行、不随程序参数下发。
   */
  resourceParamKeys: string[];
  /** 代码头 `@程序参数` 原文（空串=未声明），弹窗里作为填写提示展示 */
  programArgs: string;
  /** 代码头 `@资源参数` 原文（空串=未声明） */
  resourceArgs: string;
  /** 代码头 `@任务参数` 原文（空串=未声明） */
  taskArgs: string;
  /** 旧格式代码头 `@用法` 原文（空串=未用旧格式），非空时弹窗提示迁移到新字段 */
  usage: string;
}

/**
 * 按语言提取「运行程序」的程序参数名 —— 弹窗打开时用它们预填空白行，用户只需填取值。
 *
 * 代码头三个字段各自产出一种结果，**显式声明即分类结果**，不再按引擎二次推断：
 *   - `@程序参数`：程序自身的业务入参（`--day 20260501 -checkpoint 60000`）→ `keys`
 *     写法为 `--参数名 取值`，只认以 `-` 开头的 token；写「无」或留空表示没有程序参数
 *   - `@资源参数`：任务运行所需的资源（`--num-executors 4 -yjm 1024`）→ `resourceParamKeys`
 *   - `@任务参数`：除资源外的提交与引擎侧参数（`--master yarn --deploy-mode cluster`）→ `taskParamKeys`
 *
 * 旧格式（v2）只有一个 `@用法`，各类参数混写，此时按 `@引擎` 查表把提交框架参数（含资源类参数）
 * 一律剔进 `taskParamKeys`（isEngineParamFlag），行为与拆分前一致 —— 老文件无从区分资源参数与
 * 提交参数；若同一文件既有 `@用法` 又有新字段，四者一并解析（迁移期不丢参数）。
 *
 * 语言差异：
 *   - SQL：代码头 `@程序参数` + 正文里的 `${day}` 变量（正文是实际占位、代码头是声明，两者都取）
 *   - Java / Scala / Python：只看代码头。正文不扫 `${}`：Java 字符串里出现 `${...}` 通常是日志/模板
 *     而不是运行参数，这些语言的运行参数是命令行入参，只有代码头是可靠来源。
 *
 * 只提取**参数名**，不提取取值：`@程序参数` 在规范里的 `20260501` 是示例值（原文「如 --day 20260501」），
 * 当作默认值下发反而会覆盖掉用户真正想传的值，所以一律留空由用户填写。
 *
 * @param codeType `getFileInfo().codeType`（'sql' | 'java' | 'scala' | 'python'）；省略按 sql 处理
 */
export function extractProgramParams(content: string, codeType?: string): ExtractedProgramParams {
  const text = content ?? '';
  const header = parseFileHeader(text);
  const programArgs = (header?.programArgs || '').trim();
  const resourceArgs = (header?.resourceArgs || '').trim();
  const taskArgs = (header?.taskArgs || '').trim();
  // 旧格式 @用法：仅在老文件里出现（新模板不再生成）
  const usage = (header?.usage || '').trim();
  const engine = header?.engine || '';

  const keys: string[] = [];
  const taskParamKeys: string[] = [];
  const resourceParamKeys: string[] = [];

  const pushKey = (flag: string) => {
    const key = paramFlagName(flag);
    if (!keys.includes(key)) keys.push(key);
  };
  const pushTaskParamKey = (flag: string) => {
    if (!taskParamKeys.includes(flag)) taskParamKeys.push(flag);
  };
  const pushResourceParamKey = (flag: string) => {
    if (!resourceParamKeys.includes(flag)) resourceParamKeys.push(flag);
  };

  // v3：@程序参数 是显式声明的业务入参，原样预填
  for (const flag of parseParamFlags(programArgs)) pushKey(flag);

  // v4：@资源参数 是显式声明的资源（算力/资源归属），只告知不预填
  for (const flag of parseParamFlags(resourceArgs)) pushResourceParamKey(flag);

  // v3：@任务参数 是显式声明的提交/引擎侧参数，只告知不预填
  for (const flag of parseParamFlags(taskArgs)) pushTaskParamKey(flag);

  // v2 兼容：@用法 里各类参数混写，按 @引擎 查表把提交框架参数剔进 taskParamKeys
  for (const flag of parseParamFlags(usage)) {
    if (isEngineParamFlag(flag, engine)) pushTaskParamKey(flag);
    else pushKey(flag);
  }

  if (!codeType || codeType === 'sql') {
    for (const key of parseSqlVarKeys(text)) {
      if (!keys.includes(key)) keys.push(key);
    }
  }

  return { keys, taskParamKeys, resourceParamKeys, programArgs, resourceArgs, taskArgs, usage };
}

/**
 * 把提取出的参数名并入现有行：已存在的（按参数名比对）保持原样，缺少的追加为空白行。
 * 供弹窗「打开时预填」与「从代码提取」按钮共用，保证丢失的行能被一键补回。
 */
export function mergeExtractedKeys(
  items: readonly ProgramParamItem[] | null | undefined,
  keys: readonly string[] | null | undefined,
): ProgramParamItem[] {
  const current = [...(items || [])];
  const seen = new Set(current.map(item => (item.key ?? '').trim()).filter(Boolean));
  // seen 边判重边登记：keys 自身重复时也只补一行
  const missing = (keys || []).filter(key => {
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 没有要补的行时返回原数组引用：调用方（弹窗）据此避免一次无意义的状态更新
  if (missing.length === 0) return items ? (items as ProgramParamItem[]) : current;

  const merged = [...current];
  for (const key of missing) merged.push(createParamRow(key, ''));
  return merged;
}

/** 引擎侧默认任务参数：@任务参数 表单打开时按引擎预填的基础行 */
const ENGINE_DEFAULT_TASK_PARAMS: Record<string, ProgramParamItem[]> = {
  kyuubi: [
    { id: '_eng_ky_1', key: 'engine', value: 'kyuubi' },
    { id: '_eng_ky_2', key: 'kyuubi.url', value: '' },
    { id: '_eng_ky_3', key: 'kyuubi.user', value: '' },
    { id: '_eng_ky_4', key: 'queue.name', value: 'default' },
    { id: '_eng_ky_5', key: 'spark.executor.cores', value: '2' },
    { id: '_eng_ky_6', key: 'spark.executor.memory', value: '4g' },
    { id: '_eng_ky_7', key: 'spark.executor.instances', value: '2' },
    { id: '_eng_ky_8', key: 'spark.driver.memory', value: '2g' },
  ],
  spark: [
    { id: '_eng_sp_2', key: 'deploy.mode', value: 'client' },
    { id: '_eng_sp_3', key: 'spark.executor.cores', value: '1' },
    { id: '_eng_sp_4', key: 'spark.executor.memory', value: '4g' },
    { id: '_eng_sp_5', key: 'spark.executor.instances', value: '2' },
    { id: '_eng_sp_6', key: 'spark.driver.memory', value: '2g' },
    { id: '_eng_sp_7', key: 'spark.sql.shuffle.partitions', value: '200' },
    { id: '_eng_sp_8', key: 'spark.dynamicAllocation.enabled', value: 'true' },
  ],
  flink: [
    { id: '_eng_fl_1', key: 'parallelism.default', value: '4' },
    { id: '_eng_fl_2', key: 'jobmanager.memory.process.size', value: '1600m' },
    { id: '_eng_fl_3', key: 'taskmanager.memory.process.size', value: '1728m' },
    { id: '_eng_fl_4', key: 'taskmanager.numberOfTaskSlots', value: '1' },
    { id: '_eng_fl_5', key: 'restart-strategy.type', value: 'fixed-delay' },
    { id: '_eng_fl_6', key: 'restart-strategy.fixed-delay.attempts', value: '3' },
  ],
};

export const getEngineDefaultTaskParams = (engine: string): ProgramParamItem[] | null => {
  return ENGINE_DEFAULT_TASK_PARAMS[engine.trim().toLowerCase()] || null;
};
