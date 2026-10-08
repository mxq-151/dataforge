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
 * 代码头已不再承载运行参数（历史 @程序参数 / @资源参数 / @任务参数 / @用法 均已废弃），
 * 因此这里只保留 SQL 正文的 `${day}` 变量提取作为弹窗预填来源；Java / Scala / Python 的
 * 运行参数是命令行入参，正文不扫 `${}`，只能由用户在弹窗里填。
 *
 * 与「本地运行配置」的文本参数无关：本地执行传的是 args 数组、不经 shell，
 * 那条链路仍按空格拆分（见 useProgramRunner 的 splitArgs）。
 */

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

/** 合法参数名：字母/下划线开头，允许字母数字、下划线、点、连字符（与 runParams 的口径一致） */
const PARAM_KEY_PATTERN = /^[A-Za-z_][\w.\-]*$/;

/** SQL 变量占位符：`${day}` / `${dt}` */
const SQL_VAR_PATTERN = /\$\{([^{}]+)\}/g;

/**
 * 去掉 SQL 注释（`-- 行注释` 与 `/* … *\/ 块注释`），返回仅含有效语句的文本。
 *
 * 目的是避免注释里的示例变量被当成真参数：`@备注` 里若举例写了 `${day}`，
 * 不该因此多出一个参数。
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
  /** 识别出的**程序（业务）**参数名：来自 SQL 正文变量，保持出现顺序并去重 */
  keys: string[];
}

/**
 * 提取「运行程序」弹窗预填用的参数名（打开时并成空白行，用户只填取值）。
 *
 * 代码头不再声明参数，唯一来源是 SQL 正文的 `${day}` 变量；Java / Scala / Python 的运行参数
 * 是命令行入参，正文里的 `${...}` 通常是日志/模板而非运行参数，故不扫描，返回空。
 *
 * 只提取**参数名**，不提取取值：取值一律留空由用户填写。
 *
 * @param codeType `getFileInfo().codeType`（'sql' | 'java' | 'scala' | 'python'）；省略按 sql 处理
 */
export function extractProgramParams(content: string, codeType?: string): ExtractedProgramParams {
  const keys = !codeType || codeType === 'sql' ? parseSqlVarKeys(content ?? '') : [];
  return { keys };
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

/** 引擎侧默认任务参数：配置任务参数表单打开时按引擎预填的基础行 */
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