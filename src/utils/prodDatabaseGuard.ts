/**
 * 生产环境提交调度的「库环境」闸门。
 *
 * 库按环境拆分（`{分层}_{业务域}_{环境}`，见 opencodeInstructions.ts 的「库环境区分」）：
 * `_test` / `_gray` 的库只应出现在对应环境的调度里，生产环境的工作流一旦引用非生产库，
 * 上线后就会在生产集群上读写错库。因此提交调度时若环境选的是**生产**，就把代码中引用的库
 * 逐个查一遍，凡不以 `_prod` 结尾的一律拦截。
 *
 * 单文件（SubmitToSchedulerModal）与文件夹（FolderSubmitScheduleModal）两个提交入口共用本实现，
 * 与 utils/lineageParams.ts 的共用方式一致，避免两个入口的闸门口径漂移。
 *
 * 识别口径（宁可漏判也不误拦，闸门不允许把正常的生产提交堵死）：
 * - 只认 SQL 语境下的「库.表」限定名：`from` / `join` / `into` / `table` / … 之后、
 *   写表 API（`saveAsTable` / `insertInto`）之后，以及 `use 库名`
 * - 库名还须形如分层库（ods_/dwd_/dws_/ads_/dim_/dqc_/tmp_）或以 `_test` / `_gray` 结尾，
 *   避免把 `System.out`、`package TEST.java.ods` 这类代码里的点号误判成库名
 * - 扫描前先剥掉注释（换行保留，行号不变），代码头与注释里的示例库名不算真实引用
 */

/** 库名分层前缀：与提示词「表名命名规范」同一套口径 */
const LAYER_PREFIXES = ['ods', 'dwd', 'dws', 'ads', 'dim', 'dqc', 'tmp'];

/** 非生产环境后缀：出现即说明这是测试库 / 灰度库 */
const NON_PROD_SUFFIXES = ['_test', '_gray'];

/** 生产库后缀（与 deployEnv.ts 的 prod 环境后缀同源） */
export const PROD_DB_SUFFIX = '_prod';

/** 限定名（`库.表`）前的语境关键字；只有这些关键字之后的点号才可能是库名 */
const REF_KEYWORDS = new Set([
  'from', 'join', 'into', 'overwrite', 'table', 'exists', 'update', 'delete', 'truncate',
  'describe', 'analyze', 'insert', 'saveastable', 'insertinto', 'load',
]);

/** 标识符：裸名 / 反引号 / 双引号包裹 */
const IDENT = '(?:`[^`\\n]+`|"[^"\\n]+"|[A-Za-z_][\\w$]*)';
const QUALIFIED = new RegExp(`(${IDENT})\\s*\\.\\s*${IDENT}`, 'g');
/** `use 库名`：Hive/Spark SQL 里把后续非限定表挂到该库下，同样是库引用 */
const USE_DB = new RegExp(`\\buse\\s+(${IDENT})`, 'gi');

export interface DatabaseRef {
  /** 库名（原文大小写；比较时统一小写） */
  database: string;
  /** 1 基行号 */
  line: number;
}

export interface ProdDatabaseViolation extends DatabaseRef {
  /** 引用所在文件（文件名或路径，仅用于提示） */
  file: string;
}

/** 是否生产库：必须以 `_prod` 结尾 */
export function isProdDatabase(name: string): boolean {
  return (name || '').toLowerCase().endsWith(PROD_DB_SUFFIX);
}

/** 是否为「库名候选」：分层库或带环境后缀的库，避免把代码里的普通点号误判成库 */
function isDatabaseCandidate(name: string): boolean {
  const lower = (name || '').toLowerCase();
  return LAYER_PREFIXES.some(p => lower.startsWith(`${p}_`))
    || NON_PROD_SUFFIXES.some(s => lower.endsWith(s));
}

/** 去掉包裹标识符的反引号 / 双引号 */
function unquote(name: string): string {
  const raw = (name || '').trim();
  if (raw.length >= 2 && ((raw[0] === '`' && raw.endsWith('`')) || (raw[0] === '"' && raw.endsWith('"')))) {
    return raw.slice(1, -1);
  }
  return raw;
}

/**
 * 把注释替换成等长空白（换行原样保留），使行号与偏移不变。
 *
 * 注释里的示例库名（如代码头 @备注、`-- 从 ods_x_test.t 读取`）不是真实引用，
 * 必须在扫描前抹掉；字符串字面量里的 SQL 反而要保留（Java/Scala/Python 的 SQL 就写在字符串里）。
 */
function blankComments(code: string): string {
  const text = code ?? '';
  const out = text.split('');
  const blankTo = (from: number, to: number) => {
    for (let k = from; k <= to && k < text.length; k++) {
      if (text[k] !== '\n') out[k] = ' ';
    }
  };

  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quote) {
      if (ch === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }

    // 行注释：// 、# （python/shell/mysql），以及前面不是标识符字符的 -- （SQL）
    if ((ch === '/' && text[i + 1] === '/') || ch === '#' ||
        (ch === '-' && text[i + 1] === '-' && !/[\w$]/.test(text[i - 1] ?? ' '))) {
      let end = i;
      while (end < text.length && text[end] !== '\n') end++;
      blankTo(i, end - 1);
      i = end - 1;
      continue;
    }

    // 块注释
    if (ch === '/' && text[i + 1] === '*') {
      let end = i + 2;
      while (end < text.length && !(text[end] === '*' && text[end + 1] === '/')) end++;
      blankTo(i, end + 1);
      i = Math.min(end + 1, text.length - 1);
      continue;
    }
  }
  return out.join('');
}

/** 取匹配位置之前最近的一个单词（跳过空白与括号、引号等分隔符），用于判断 SQL 语境 */
function precedingWord(text: string, index: number): string {
  let i = index - 1;
  while (i >= 0 && /[\s(\['"`,]/.test(text[i])) i--;
  let word = '';
  while (i >= 0 && /[\w$]/.test(text[i])) {
    word = text[i] + word;
    i--;
  }
  return word.toLowerCase();
}

/** 缓存每行起始偏移，按偏移换算 1 基行号 */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function lineAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

/** 从代码中提取被引用的库名（按行去重，按出现顺序返回） */
export function collectDatabaseRefs(code: string): DatabaseRef[] {
  const text = blankComments(code);
  const hits: Array<{ offset: number; database: string }> = [];

  QUALIFIED.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = QUALIFIED.exec(text)) !== null) {
    if (!REF_KEYWORDS.has(precedingWord(text, m.index))) continue;
    const database = unquote(m[1]);
    if (!isDatabaseCandidate(database)) continue;
    hits.push({ offset: m.index, database });
  }

  USE_DB.lastIndex = 0;
  while ((m = USE_DB.exec(text)) !== null) {
    const database = unquote(m[1]);
    if (!isDatabaseCandidate(database)) continue;
    hits.push({ offset: m.index, database });
  }

  hits.sort((a, b) => a.offset - b.offset);
  const starts = lineStarts(text);
  const seen = new Set<string>();
  const refs: DatabaseRef[] = [];
  for (const hit of hits) {
    const line = lineAt(starts, hit.offset);
    const key = `${line}|${hit.database.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ database: hit.database, line });
  }
  return refs;
}

/** 逐个文件找出非生产库引用（环境为生产时调用；无引用则返回空数组，即放行） */
export function findNonProdDatabases(
  files: ReadonlyArray<{ file: string; content: string }>,
): ProdDatabaseViolation[] {
  const violations: ProdDatabaseViolation[] = [];
  for (const f of files) {
    for (const ref of collectDatabaseRefs(f.content)) {
      if (!isProdDatabase(ref.database)) {
        violations.push({ ...ref, file: f.file });
      }
    }
  }
  return violations;
}

/** 违规提示文案（单文件与文件夹两个入口共用，避免口径漂移） */
export function prodDatabaseViolationMessage(v: ProdDatabaseViolation, includeFile = false): string {
  const where = includeFile ? `「${v.file}」第 ${v.line} 行` : `第 ${v.line} 行`;
  return `生产环境提交要求代码中引用的库均为生产库（${PROD_DB_SUFFIX} 结尾）：${where}引用了非生产库「${v.database}」，请改用生产库或切换提交环境`;
}