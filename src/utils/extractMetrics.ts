import type { IndicatorDTO, IndicatorFieldDTO } from '../types/indicator';

/**
 * 指标提取器
 *
 * 从 Markdown 文档的"## 数据指标"章节中解析指标表格，转换为 IndicatorDTO。
 *
 * 支持两种提示词规范的表格格式（见 src/hooks/opencode/opencodeInstructions.ts）：
 *
 * 1. 数仓设计文档（数据架构师，8 列）：
 *    | 指标编码 | 指标名称 | 主题域 | 指标含义 | 计算表达式 | 过滤条件 | 字段来源 | 数据源 |
 *    注：提示词表头为"指标含义"；历史文档曾写作"指定含义"，两种写法均按业务含义列解析。
 * - 指标编码 → code（全局唯一 ID，如 {xxx}_0001）
 *    - 指标名称 → name
 *    - 主题域 → topic
 *    - 指标含义（历史写法：指定含义）→ businessDefinition
 *    - 计算表达式 → calcExpr
 *    - 过滤条件 → defaultFilter
 *    - 字段来源 → fields（格式 A.B:C,D;E.F:G,H，解析为 IndicatorFieldDTO[]）
 *    - 数据源   → 写入每个 IndicatorFieldDTO.datasourceName（兼容无此列的旧文档，缺省为空串）
 *
 * 2. 业务需求文档（业务需求方，6 列）：
 *    | 指标名称 | 主题域 | 业务定义 | 计算口径 | 过滤条件 | 应用场景 |
 *    - 指标名称 → name（业务语言，无需截断）
 *    - 主题域   → topic（缺省"未分类"）
 *    - 业务定义 → businessDefinition
 *    - 计算口径 → calcExpr
 *    - 过滤条件 → defaultFilter
 *    - 应用场景 → 以 "应用场景: xxx" 形式拼入 businessDefinition
 *
 * 兼容旧版 4 列业务需求文档：| 业务定义 | 计算口径 | 过滤条件 | 应用场景 |
 * 无"指标名称"列时以"业务定义"作为指标名（截断防止过长），无"主题域"列时 topic 为"未分类"。
 */

export interface MarkdownTable {
  headers: string[];
  rows: string[][];
}

/** 名称最大长度（超出按字符截断并补省略号），避免业务定义过长导致列表展示失衡 */
const NAME_MAX_LENGTH = 60;

/** 标题行正则：# 后的空格可省略（兼容 "##数据指标" 写法） */
const HEADER_LINE_RE = /^(#{1,6})[ \t]*(.+?)[ \t]*$/;

/** 围栏代码块起始行（``` 或 ~~~） */
const FENCE_LINE_RE = /^(```|~~~)/;

/**
 * 提取指定关键词命中的首个章节内容（从标题下一行到下一个同级或更高级标题为止）。
 * 代码围栏内的 "#" 行不视为标题，避免 shell 注释等伪标题截断章节。
 */
export function extractSection(text: string, keyword: string): string {
  const allLines = text.split('\n');
  let startIdx = -1;
  let startLevel = 0;
  let inFence = false;
  const headings: { level: number; title: string; lineIdx: number }[] = [];
  for (let i = 0; i < allLines.length; i++) {
    const t = allLines[i].trim();
    if (FENCE_LINE_RE.test(t)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = t.match(HEADER_LINE_RE);
    if (m) headings.push({ level: m[1].length, title: m[2], lineIdx: i });
  }
  const start = headings.find(h => h.title.includes(keyword));
  if (!start) return '';
  startIdx = start.lineIdx + 1;
  startLevel = start.level;
  let endIdx = allLines.length;
  for (const h of headings) {
    if (h.lineIdx >= startIdx && h.level <= startLevel) {
      endIdx = h.lineIdx;
      break;
    }
  }
  return allLines.slice(startIdx, endIdx).join('\n');
}

/**
 * 切分表格行的单元格：
 * - 行首/行尾的边缘竖线剥离（缺失时不影响切分）
 * - 仅按未转义的竖线切分，单元格内的 "\|" 还原为 "|"
 */
function splitCells(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
}

/** 统计行内未转义竖线数量 */
function countPipes(line: string): number {
  return (line.match(/(?<!\\)\|/g) || []).length;
}

/** 判断是否为表格行：以 | 开头或结尾，或含多个 |（无边缘竖线的表行） */
function isTableLine(line: string): boolean {
  return line.startsWith('|') || line.endsWith('|') || countPipes(line) >= 2;
}

/** 判断是否为表头下的分隔行（如 |---|---|） */
function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every(c => /^[-:\s]+$/.test(c));
}

/**
 * 解析文本中的所有 markdown 表格。
 * 表格由连续的含 `|` 行组成；表头后紧跟一行分隔符（`---`）。
 * 健壮性处理（实际生成文档的常见偏差）：
 * - 数据行缺失行首/行尾竖线时仍按行解析，且不会截断后续行
 * - 单元格内的转义竖线 "\|" 不会拆出额外单元格
 * - 单元格数少于表头时右侧补空，避免索引越界导致整行丢失
 * - 围栏代码块（```/~~~）内的竖线不参与表格解析
 * - 仅含单个 | 的说明文字不终止表格（跳过但不 flush）
 */
export function parseMarkdownTables(text: string): MarkdownTable[] {
  const lines = text.split('\n');
  const tables: MarkdownTable[] = [];
  let curHeaders: string[] | null = null;
  let curRows: string[][] = [];
  let inFence = false;
  const flush = () => {
    if (curHeaders) {
      tables.push({ headers: curHeaders, rows: curRows });
      curHeaders = null;
      curRows = [];
    }
  };
  for (const raw of lines) {
    const t = raw.trim();
    if (FENCE_LINE_RE.test(t)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!t.includes('|')) {
      flush();
      continue;
    }
    if (!curHeaders) {
      // 表格起始行须形似表格行，避免把含单个 | 的普通文本误当表头
      if (isTableLine(t)) curHeaders = splitCells(t);
      continue;
    }
    const cells = splitCells(t);
    if (curRows.length === 0 && isSeparatorRow(cells)) {
      continue; // 表头与数据之间的分隔行
    }
    if (isTableLine(t)) {
      // 短行右侧补空对齐表头，防止列索引越界
      while (cells.length < curHeaders.length) cells.push('');
      curRows.push(cells);
    }
    // 其余含 | 的行（如说明文字）跳过但不终止表格
  }
  flush();
  return tables;
}

/**
 * 列查找：先精确匹配，再模糊匹配；已用列不再参与后续匹配。
 * 按规范顺序识别、每列命中后标记为已用，避免不同语义列相互冲突
 * （如「计算表达式」既被业务定义列又被计算表达式列命中，导致内容重复拼接）。
 */
export function findColumn(
  headers: string[],
  exactKeys: string[],
  fuzzyKeys: string[],
  used: Set<number>,
): number {
  // 精确匹配（提示词规范要求列名固定，不得改名）
  for (let i = 0; i < headers.length; i++) {
    if (used.has(i)) continue;
    if (exactKeys.includes(headers[i].trim())) return i;
  }
  // 模糊匹配（兼容非标准文档）
  for (let i = 0; i < headers.length; i++) {
    if (used.has(i)) continue;
    const h = headers[i].toLowerCase();
    if (fuzzyKeys.some(k => h.includes(k.toLowerCase()))) return i;
  }
  return -1;
}

/** 截断过长的名称 */
function truncateName(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= NAME_MAX_LENGTH) return trimmed;
  return trimmed.slice(0, NAME_MAX_LENGTH) + '...';
}

/**
 * 解析"字段来源"列的值为 IndicatorFieldDTO[]。
 *
 * 格式：A.B:C,D;E.F:G,H
 *   - `;` 分隔多个库表引用
 *   - `A.B` 为库名.表名，`:` 后为字段名列表
 *   - `,` 分隔同表下的多个字段
 *
 * @param datasourceName 数据源名称（来自"数据源"列），写入每个字段的 datasourceName
 *
 * 例：parseFieldSource("ods_user.login:user_id,login_time;dws_order.order:order_id,amount", "test_dbs")
 *   → [
 *       { datasourceName:'test_dbs', dbName:'ods_user', tblName:'login', fieldName:'user_id', fieldType:'' },
 *       { datasourceName:'test_dbs', dbName:'ods_user', tblName:'login', fieldName:'login_time', fieldType:'' },
 *       { datasourceName:'test_dbs', dbName:'dws_order', tblName:'order', fieldName:'order_id', fieldType:'' },
 *       { datasourceName:'test_dbs', dbName:'dws_order', tblName:'order', fieldName:'amount', fieldType:'' },
 *     ]
 */
export function parseFieldSource(
  value: string | undefined,
  datasourceName: string = '',
): IndicatorFieldDTO[] | undefined {
  if (!value || !value.trim()) return undefined;
  // 归一化全角标点：模型生成文档时可能用中文标点替代格式中的半角分隔符
  const trimmed = value.trim()
    .replace(/：/g, ':')
    .replace(/；/g, ';')
    .replace(/，/g, ',')
    .replace(/、/g, ',');
  const fields: IndicatorFieldDTO[] = [];
  const dsName = datasourceName.trim();

  const groups = trimmed.split(';');
  for (const group of groups) {
    const g = group.trim();
    if (!g) continue;
    const colonIdx = g.indexOf(':');
    if (colonIdx < 0) continue;
    const tablePart = g.slice(0, colonIdx).trim();
    const fieldsPart = g.slice(colonIdx + 1).trim();
    if (!tablePart || !fieldsPart) continue;

    const dotIdx = tablePart.indexOf('.');
    const dbName = dotIdx >= 0 ? tablePart.slice(0, dotIdx).trim() : '';
    const tblName = dotIdx >= 0 ? tablePart.slice(dotIdx + 1).trim() : tablePart;

    const fieldNames = fieldsPart.split(',').map(f => f.trim()).filter(Boolean);
    for (const fieldName of fieldNames) {
      fields.push({ datasourceName: dsName, dbName, tblName, fieldName, fieldType: '' });
    }
  }

  return fields.length > 0 ? fields : undefined;
}

/**
 * 从 Markdown 文档全文中提取指标。
 * @param content 文档全文
 * @param projectCode 项目编码（写入 IndicatorDTO.projectCode）
 * @returns 提取出的指标列表；若无"数据指标"章节或无可识别表格则返回空数组
 */
export function extractMetricsFromMarkdown(
  content: string,
  projectCode: string,
): IndicatorDTO[] {
  const sectionContent = extractSection(content, '数据指标');
  if (!sectionContent.trim()) return [];

  const tables = parseMarkdownTables(sectionContent);
  const indicators: IndicatorDTO[] = [];

  for (const table of tables) {
    const used = new Set<number>();

    // 指标编码 → code（数仓设计文档 8 列格式中的全局唯一 ID）
    const codeIdx = findColumn(
      table.headers,
      ['指标编码', '编码'],
      ['指标编码', '编码', 'code'],
      used,
    );
    if (codeIdx >= 0) used.add(codeIdx);

    // 别名 → code（兼容非标准文档；与指标编码同写 code，优先取指标编码）
    const aliasIdx = findColumn(
      table.headers,
      ['别名'],
      ['别名', '英文名', 'alias'],
      used,
    );
    if (aliasIdx >= 0) used.add(aliasIdx);

    // 指标名称 → name（8 列格式）
    const nameIdx = findColumn(
      table.headers,
      ['指标名', '指标名称', '名称'],
      ['指标名', '指标名称', '名称', 'name'],
      used,
    );
    if (nameIdx >= 0) used.add(nameIdx);

    // 业务定义 / 指标含义 → businessDefinition（旧版 4 列格式下兼作 name）
    // 注意：fuzzy 增加 "含义"/"指定含义"/"指标含义" 以识别数仓设计文档表头中的"指定含义"
    //       （提示词表头为"指标含义"；兼容历史文档表头"指定含义"，两者均命中同一列）
    const defIdx = findColumn(
      table.headers,
      ['业务定义', '指定含义', '指标含义'],
      [
        '业务定义', '业务说明', '业务描述', '业务含义',
        '指定含义', '指标含义', '含义', '定义', 'definition',
      ],
      used,
    );
    if (defIdx >= 0) used.add(defIdx);

    const topicIdx = findColumn(
      table.headers,
      ['主题域'],
      ['主题域', '所属主题', '主题分类', '主题', 'topic'],
      used,
    );
    if (topicIdx >= 0) used.add(topicIdx);

    const exprIdx = findColumn(
      table.headers,
      ['计算表达式', '计算口径'],
      ['计算表达式', '计算公式', '计算口径', '表达式', 'expression'],
      used,
    );
    if (exprIdx >= 0) used.add(exprIdx);

    const filterIdx = findColumn(
      table.headers,
      ['过滤条件'],
      ['过滤条件', '默认过滤', '筛选条件', 'defaultFilter'],
      used,
    );
    if (filterIdx >= 0) used.add(filterIdx);

    const sceneIdx = findColumn(
      table.headers,
      ['应用场景'],
      ['应用场景', '使用场景', '场景', 'scene'],
      used,
    );
    if (sceneIdx >= 0) used.add(sceneIdx);

    // 字段来源 → fields（8 列格式，格式如 A.B:C,D;E.F:G,H）
    const sourceIdx = findColumn(
      table.headers,
      ['字段来源'],
      ['字段来源', '来源字段', '来源', 'source'],
      used,
    );
    if (sourceIdx >= 0) used.add(sourceIdx);

    // 数据源 → 填充到每个 field 的 datasourceName（8 列格式新增列；旧文档无此列时缺省为空串）
    // 模糊匹配仅用"数据源"/"datasource"，避免与"字段来源"列的 '来源'/'source' 冲突
    const datasourceIdx = findColumn(
      table.headers,
      ['数据源'],
      ['数据源', 'datasource'],
      used,
    );
    if (datasourceIdx >= 0) used.add(datasourceIdx);

    // 判定是否为指标表格：
    // - 8 列格式：含"指标名/指标名称"列
    // - 旧版 4 列格式：无"指标名"列但含"业务定义"列（业务定义兼作 name）
    const isFormatA = nameIdx >= 0;
    const isFormatB = nameIdx < 0 && defIdx >= 0;
    if (!isFormatA && !isFormatB) continue;

    for (const row of table.rows) {
      // 确定 name 来源：8 列与 6 列格式取"指标名称"，旧版 4 列格式取"业务定义"（截断）
      const nameRaw = isFormatA ? (row[nameIdx] || '') : (row[defIdx] || '');
      const name = isFormatA ? nameRaw.trim() : truncateName(nameRaw);
      if (!name) continue;

      // 业务定义拼接：业务定义 + 应用场景 + 其他未识别列兜底
      // 计算表达式/口径单独提取到 calcExpr，不再拼入 businessDefinition
      const parts: string[] = [];
      if (defIdx >= 0 && row[defIdx]) parts.push(row[defIdx].trim());
      if (sceneIdx >= 0 && row[sceneIdx]) {
        parts.push(`${table.headers[sceneIdx]}: ${row[sceneIdx].trim()}`);
      }
      // 兜底：未被识别的列按 "列名: 值" 格式拼到业务定义，确保信息不丢
      for (let i = 0; i < table.headers.length; i++) {
        if (used.has(i)) continue;
        const val = row[i];
        if (val && val.trim()) parts.push(`${table.headers[i]}: ${val.trim()}`);
      }
      const businessDefinition = parts.filter(Boolean).join('\n') || undefined;
      const calcExpr = exprIdx >= 0 && row[exprIdx] ? row[exprIdx].trim() : undefined;

      // code：优先取指标编码，其次别名
      const codeSource = codeIdx >= 0
        ? row[codeIdx]
        : (aliasIdx >= 0 ? row[aliasIdx] : '');
      const code = codeSource ? codeSource.trim() : undefined;

      // 数据源列的值（8 列格式），写入每个字段的 datasourceName
      const datasourceName = datasourceIdx >= 0 && row[datasourceIdx]
        ? row[datasourceIdx].trim()
        : '';

      indicators.push({
        projectCode,
        topic: topicIdx >= 0 && row[topicIdx] ? row[topicIdx].trim() : '未分类',
        name,
        code,
        calcExpr,
        businessDefinition,
        defaultFilter: filterIdx >= 0 && row[filterIdx] ? row[filterIdx].trim() : undefined,
        fields: parseFieldSource(
          sourceIdx >= 0 ? row[sourceIdx] : undefined,
          datasourceName,
        ),
      });
    }
  }

  return indicators;
}

// ── calcExpr 展开：将指标编码引用替换为实际计算公式 ──────────────

/** 指标编码正则：大写字母+下划线+数字，如 TEST_0001、USR_0002 */
const INDICATOR_CODE_RE = /[A-Z]+_\d{4,}/g;

/**
 * 展开 calcExpr 中引用的其他指标编码，替换为其实际计算公式。
 *
 * 例：calcExpr = "TEST_0002 / TEST_0001 * 100%"
 *     lookup  = { TEST_0002: "count(distinct user_id)", TEST_0001: "sum(order_amount)" }
 *     结果    = "count(distinct user_id) / sum(order_amount) * 100%"
 *
 * @param calcExpr 原始计算表达式
 * @param lookup 指标编码 → calcExpr 的映射表
 * @param maxDepth 最大展开深度（防止循环引用），默认 5
 * @returns 展开后的计算表达式
 */
export function expandCalcExpr(
  calcExpr: string | undefined,
  lookup: Map<string, string>,
  maxDepth: number = 5,
): string | undefined {
  if (!calcExpr || maxDepth <= 0) return calcExpr;

  let result = calcExpr;
  let changed = false;

  result = result.replace(INDICATOR_CODE_RE, (match) => {
    const target = lookup.get(match);
    if (target) {
      changed = true;
      return target;
    }
    return match; // 未找到则保留原编码
  });

  // 若有替换且结果中仍含指标编码，继续展开（处理嵌套引用）
  if (changed && INDICATOR_CODE_RE.test(result)) {
    return expandCalcExpr(result, lookup, maxDepth - 1);
  }

  return result;
}

/**
 * 批量展开一组指标的 calcExpr。
 * 优先用待提交指标自身构建查找表（同批次指标互相引用），
 * 再叠加已有指标查找表。
 *
 * @param indicators 待提交的指标列表
 * @param existingLookup 已有指标的 code → calcExpr 映射
 * @returns 展开后的指标列表（浅拷贝，仅替换 calcExpr）
 */
export function expandCalcExprBatch(
  indicators: IndicatorDTO[],
  existingLookup: Map<string, string>,
): IndicatorDTO[] {
  // 构建查找表：已有指标 + 当前批次指标（当前批次优先，因其可能为新增）
  const lookup = new Map(existingLookup);
  for (const ind of indicators) {
    if (ind.code && ind.calcExpr) {
      lookup.set(ind.code, ind.calcExpr);
    }
  }

  return indicators.map(ind => {
    const expanded = expandCalcExpr(ind.calcExpr, lookup);
    if (expanded === ind.calcExpr) return ind;
    return { ...ind, calcExpr: expanded };
  });
}
