/**
 * S2 数仓设计文档「数据质量稽核设计」规则清单 → 平台规则草稿 解析器
 *
 * ── 为什么需要它 ────────────────────────────────────────────
 * 平台规则（dq_rule）与智能体产物（设计文档）此前只有「术语同源」，规则本身要靠人工
 * 逐条录入：设计文档改了规则、平台里没跟着改，S3 回传的 ruleName 就对不上平台规则。
 * 这里把设计文档第 6 章的规则清单解析成可直接落库的草稿，使
 * 「设计文档 → 平台规则 → 校验结果回传」用同一个规则名串起来。
 *
 * ── 解析契约（与 opencodeInstructions.ts 的 QUALITY_RULE_SPEC 逐条对应）──
 * 提示词要求 S2 的规则清单为固定 5 列表格：
 *   | 规则名 | 规则类型 | 校验对象（库.表.字段） | 阈值 | 处置方式 |
 * 但历史文档可能只写「表.字段」（缺库名）、字段列用 / 并列多个字段，或把枚举取值、
 * 对照表写进单元格。因此解析策略是「能解析就解析，解析不到就降级为告警」——
 * 绝不猜测：无法确定的部分原样保留并标记，落库前由人工在界面上确认。
 *
 * 解析结果是**草稿**，调用方必须让用户确认（尤其阈值与处置方式）后再调 /quality/rule。
 */

import { QUALITY_RULE_TYPES, getQualityRuleTypeByLabel } from '../types/quality';
import type { QualityRuleScope, QualityDisposeMode, QualityCompareMode } from '../types/quality';

/** 一行解析结果（= 一条待落库的规则草稿） */
export interface ParsedQualityRule {
  /** 规则名：逐字保留。平台规则名与 S3 回传 ruleName 都以此为准，不得改写 */
  ruleName: string;
  /** 规则类型中文名（原文） */
  ruleTypeLabel: string;
  /** 规则类型编码；未识别为 ''，需人工选择 */
  ruleType: string;
  /** 校验对象范围，取自规则类型元信息；类型未识别时按字段级兜底 */
  scope: QualityRuleScope;
  /** 主表所在库；设计文档缺库名时为空，由 matchQualityTable 反查 */
  databaseName: string;
  /** 主表 */
  tableName: string;
  /** 字段级规则的字段；表级/跨表规则为空 */
  columnName: string;
  /** 跨表规则的对照表 */
  refDatabaseName: string;
  refTableName: string;
  refColumnName: string;
  /** 比较方式与期望值（由阈值文本解析） */
  compareMode: QualityCompareMode;
  expectedValue: string;
  /** 阈值原文，供界面核对 */
  thresholdRaw: string;
  /** 处置方式原文 */
  disposeRaw: string;
  disposeMode: QualityDisposeMode;
  /** 该行的解析告警；非空表示需人工确认 */
  warnings: string[];
}

export interface QualityRuleParseResult {
  rules: ParsedQualityRule[];
  /** 文档级问题（未找到章节 / 未找到表格 / 缺列），与行级告警区分 */
  warnings: string[];
}

/** 元数据缓存中的候选表（由调用方从 DataSourceProvider 拍平后传入，保持本模块纯函数） */
export interface QualityTableCandidate {
  datasourceId: number;
  datasourceName: string;
  databaseName: string;
  tableName: string;
}

// ── 表格解析 ──────────────────────────────────────────────────

/** 按未转义的 | 切分表格行并去掉首尾空单元 */
function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(c => c.trim());
}

const isSeparatorRow = (cells: string[]): boolean =>
  cells.every(c => c === '' || /^:?-+:?$/.test(c.replace(/\s/g, '')));

/**
 * 定位「数据质量稽核设计」章节：标题同时含「质量」与（「稽核」或「规则」）。
 * 返回章节正文的行区间 [start, end)，章节结束于同级或更高级标题。
 */
function findQualitySection(lines: string[]): { start: number; end: number } | null {
  const headingRe = /^(#{1,6})\s+(.*)$/;
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = headingRe.exec(lines[i].trim());
    if (!m) continue;
    const text = m[2];
    if (start < 0) {
      if (text.includes('质量') && (text.includes('稽核') || text.includes('规则'))) {
        start = i + 1;
        level = m[1].length;
      }
      continue;
    }
    if (m[1].length <= level) return { start, end: i };
  }
  return start < 0 ? null : { start, end: lines.length };
}

/** 在章节内找规则清单表头：同一行同时含「规则名」与「规则类型」 */
function findRuleTable(lines: string[], start: number, end: number): { headerIdx: number; header: string[] } | null {
  for (let i = start; i < end; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('|')) continue;
    const cells = splitRow(line);
    if (cells.some(c => c.includes('规则名')) && cells.some(c => c.includes('规则类型'))) {
      return { headerIdx: i, header: cells };
    }
  }
  return null;
}

/** 按关键字定位列下标，取首个命中；-1 表示缺列 */
function columnIndex(header: string[], keywords: string[]): number {
  return header.findIndex(h => keywords.some(k => h.includes(k)));
}

// ── 单元格解析 ────────────────────────────────────────────────

/** 限定名 token：库.表.字段 / 表.字段 / 表 */
const TOKEN_RE = /[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/;

interface QualifiedName {
  databaseName: string;
  tableName: string;
  columnName: string;
}

/**
 * 拆分限定名。三段以上按「库.表.字段」，两段按「表.字段」（历史文档主流写法，缺库名），
 * 一段只有表名 —— 缺库名时 databaseName 为空，由 matchQualityTable 反查。
 */
function splitQualified(token: string): QualifiedName {
  const parts = token.split('.');
  if (parts.length >= 3) {
    return { databaseName: parts[0], tableName: parts[1], columnName: parts.slice(2).join('.') };
  }
  if (parts.length === 2) {
    return { databaseName: '', tableName: parts[0], columnName: parts[1] };
  }
  return { databaseName: '', tableName: parts[0], columnName: '' };
}

/** 规则类型名反查：容忍括号后缀（如「行数波动（装载基线）」）与多余描述 */
function resolveRuleType(label: string) {
  const exact = getQualityRuleTypeByLabel(label);
  if (exact) return exact;
  const stripped = label.replace(/[（(][^）)]*[）)]/g, '').trim();
  const byStripped = getQualityRuleTypeByLabel(stripped);
  if (byStripped) return byStripped;
  return QUALITY_RULE_TYPES.find(t => label.includes(t.label));
}

/** 阈值文本 → 比较方式 + 期望值。比较符后的数值/百分比取出，百分号去掉 */
function parseThreshold(raw: string): { compareMode: QualityCompareMode; expectedValue: string; warning?: string } {
  const text = raw.trim();
  if (!text) return { compareMode: 'GTE', expectedValue: '', warning: '阈值为空，需人工补充' };

  const m = /(≥|>=|≤|<=|≠|!=|==|=|>|<)/.exec(text);
  if (!m) {
    return { compareMode: 'EQ', expectedValue: text, warning: `阈值「${text}」未含比较符，已按原文存入期望值，请人工确认` };
  }
  const op = m[1];
  const compareMode: QualityCompareMode =
    op === '≥' || op === '>=' ? 'GTE'
      : op === '≤' || op === '<=' ? 'LTE'
        : op === '≠' || op === '!=' ? 'NE'
          : op === '>' ? 'GT'
            : op === '<' ? 'LT'
              : 'EQ';
  const rest = text.slice(m.index + op.length).trim();
  const numeric = /^[0-9]+(?:\.[0-9]+)?%?/.exec(rest)?.[0];
  if (!numeric) {
    return { compareMode, expectedValue: rest, warning: `阈值「${text}」比较符后不是数值，请人工确认` };
  }
  return { compareMode, expectedValue: numeric.replace(/%$/, '') };
}

/** 处置方式：含「阻断」即为阻断下游，否则告警 */
function parseDispose(raw: string): QualityDisposeMode {
  return /阻断|BLOCK/i.test(raw) ? 'BLOCK' : 'ALERT';
}

/** 解析校验对象单元格（可能含枚举取值、对照表、多字段并列） */
function parseCheckObject(raw: string, scope: QualityRuleScope) {
  const warnings: string[] = [];
  const normalized = raw
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/↔/g, ' <-> ')
    .replace(/＝/g, '=');
  // 对照表分隔符：↔ / = （跨表规则的「A 表 = B 表」写法）
  const parts = normalized.split(/\s*(?:<->|=)\s*/);
  const leftRaw = parts[0] ?? '';
  const rightRaw = parts.length > 1 ? parts.slice(1).join(' = ') : '';

  const leftToken = TOKEN_RE.exec(leftRaw)?.[0] ?? '';
  if (!leftToken) {
    warnings.push('未能从校验对象中解析出表名，需人工指定');
    return { databaseName: '', tableName: '', columnName: '', refDatabaseName: '', refTableName: '', refColumnName: '', warnings };
  }
  const main = splitQualified(leftToken);

  // 多字段并列（表.字段/字段/字段）：平台规则一条只落一个字段，其余需拆条
  const rest = leftRaw.slice(leftRaw.indexOf(leftToken) + leftToken.length);
  if (rest.startsWith('/')) {
    const extra = rest.split('/').slice(1).filter(s => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s.trim()));
    if (extra.length > 0) {
      warnings.push(`校验对象含 ${extra.length + 1} 个字段，已取第一个「${main.columnName}」，其余需拆成独立规则`);
    }
  }

  const refToken = rightRaw ? (TOKEN_RE.exec(rightRaw)?.[0] ?? '') : '';
  const ref = refToken ? splitQualified(refToken) : null;

  if (scope === 'COLUMN' && !main.columnName) warnings.push('字段级规则未解析到字段名，需人工指定');
  if (scope === 'PAIR' && !ref) warnings.push('跨表规则未解析到对照表，需人工指定');

  return {
    databaseName: main.databaseName,
    tableName: main.tableName,
    columnName: main.columnName,
    refDatabaseName: ref?.databaseName ?? '',
    refTableName: ref?.tableName ?? '',
    refColumnName: ref?.columnName ?? '',
    warnings,
  };
}

// ── 对外入口 ──────────────────────────────────────────────────

/** 解析设计文档 markdown，产出规则草稿与告警 */
export function parseQualityRulesFromDesignDoc(markdown: string): QualityRuleParseResult {
  const lines = (markdown ?? '').split(/\r?\n/);
  const section = findQualitySection(lines);
  if (!section) {
    return { rules: [], warnings: ['未找到「数据质量稽核设计」章节（标题需同时含「质量」与「稽核」或「规则」）'] };
  }
  const table = findRuleTable(lines, section.start, section.end);
  if (!table) {
    return { rules: [], warnings: ['该章节内未找到同时含「规则名」「规则类型」表头的规则清单表格'] };
  }

  const header = table.header;
  const nameIdx = columnIndex(header, ['规则名']);
  const typeIdx = columnIndex(header, ['规则类型']);
  const objIdx = columnIndex(header, ['校验对象', '所属表', '对象']);
  const thresholdIdx = columnIndex(header, ['阈值']);
  const disposeIdx = columnIndex(header, ['处置']);

  if (nameIdx < 0 || typeIdx < 0 || objIdx < 0) {
    return { rules: [], warnings: ['规则清单表头缺少必需列：规则名 / 规则类型 / 校验对象'] };
  }
  const warnings: string[] = [];
  if (thresholdIdx < 0) warnings.push('规则清单缺少「阈值」列，阈值需在落库后人工补充');
  if (disposeIdx < 0) warnings.push('规则清单缺少「处置方式」列，将统一按「告警」落库');

  const rules: ParsedQualityRule[] = [];
  for (let i = table.headerIdx + 1; i < section.end; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('|')) break;
    const cells = splitRow(line);
    if (isSeparatorRow(cells)) continue;
    const ruleName = (cells[nameIdx] ?? '').trim();
    if (!ruleName || ruleName === '规则名') continue;

    const ruleTypeLabel = (cells[typeIdx] ?? '').trim();
    const objRaw = (cells[objIdx] ?? '').trim();
    const thresholdRaw = thresholdIdx >= 0 ? (cells[thresholdIdx] ?? '').trim() : '';
    const disposeRaw = disposeIdx >= 0 ? (cells[disposeIdx] ?? '').trim() : '';

    const rowWarnings: string[] = [];
    const meta = resolveRuleType(ruleTypeLabel);
    if (!meta) rowWarnings.push(`规则类型「${ruleTypeLabel}」不在 7 类统一术语内，需人工选择`);
    const scope = meta?.scope ?? 'COLUMN';

    const obj = parseCheckObject(objRaw, scope);
    rowWarnings.push(...obj.warnings);

    const threshold = parseThreshold(thresholdRaw);
    if (threshold.warning) rowWarnings.push(threshold.warning);
    if (!disposeRaw) rowWarnings.push('处置方式为空，已按「告警」落库');

    rules.push({
      ruleName,
      ruleTypeLabel,
      ruleType: meta?.code ?? '',
      scope,
      databaseName: obj.databaseName,
      tableName: obj.tableName,
      columnName: obj.columnName,
      refDatabaseName: obj.refDatabaseName,
      refTableName: obj.refTableName,
      refColumnName: obj.refColumnName,
      compareMode: threshold.compareMode,
      expectedValue: threshold.expectedValue,
      thresholdRaw,
      disposeRaw,
      disposeMode: parseDispose(disposeRaw),
      warnings: rowWarnings,
    });
  }

  if (rules.length === 0) warnings.push('规则清单表格中没有可解析的数据行');
  return { rules, warnings };
}

/**
 * 在候选表（元数据缓存）中匹配规则的目标表。
 * 匹配顺序：库+表 → 仅表名 → 把「字段」位当表名再试（历史文档写「库.表」时的兜底）。
 * 兜底命中时字段名已被当作表名消费，返回的 columnName 置空，交由人工补字段。
 */
export function matchQualityTable(
  candidates: readonly QualityTableCandidate[],
  databaseName: string,
  tableName: string,
  columnName: string,
): { target: QualityTableCandidate; columnName: string } | undefined {
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const byTable = candidates.find(c => eq(c.tableName, tableName) && (!databaseName || eq(c.databaseName, databaseName)));
  if (byTable) return { target: byTable, columnName };
  if (columnName) {
    const swapped = candidates.find(c => eq(c.tableName, columnName) && (!databaseName || eq(c.databaseName, databaseName)));
    if (swapped) return { target: swapped, columnName: '' };
  }
  return undefined;
}
