/**
 * 常量与路径：章节清单、指标列、外部引用、规则表 R01–R18、目录路径。
 *
 * 本文件被 .opencode/tool/* 与 .opencode/plugin/guard.ts 以相对路径导入。
 * .opencode/lib/** 不会被 opencode 自动注册为 tool（注册扫描只匹配
 * .opencode/{tool,tools}/*.{ts,js}），因此这里的导出不会污染工具列表。
 */
import path from "node:path"
import { readJson } from "../../shared/lib/io"

export { nowIso, readJson, updateJson, writeJsonAtomic, writeTextAtomic } from "../../shared/lib/io"

// ── 路径 ────────────────────────────────────────────────────────────────
export const WORK_DIR = ".work"
export const DOCS_DIR = "docs"
export const DOC_SUFFIX = "_开发需求.md"
export const REVIEW_SUFFIX = "_审查报告.md"

/** 外部引用缺失时的统一占位文本（用户规范：不得虚构枚举）。 */
export const PLACEHOLDER_NEED_INPUT = "需用户提供该章节内容"

// ── 章节 ────────────────────────────────────────────────────────────────
export type ChapterId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
export const CHAPTER_IDS: ChapterId[] = [1, 2, 3, 4, 5, 6, 7, 8, 9]

export type ChapterOwner = "chapter-writer" | "metrics-writer"

export type ChapterDef = {
  id: ChapterId
  /** 渲染用正式标题（不含编号） */
  title: string
  /** 解析用的标题包含词（不含编号，兼容无编号写法） */
  match: string
  /** 是否强制带编号：仅第 3 章为 true */
  numbered: boolean
  owner: ChapterOwner
}

export const CHAPTERS: ChapterDef[] = [
  { id: 1, title: "需求背景", match: "需求背景", numbered: false, owner: "chapter-writer" },
  { id: 2, title: "可分析场景梳理", match: "可分析场景", numbered: false, owner: "chapter-writer" },
  { id: 3, title: "数据指标", match: "数据指标", numbered: true, owner: "metrics-writer" },
  { id: 4, title: "数据范围与加工逻辑", match: "数据范围", numbered: false, owner: "chapter-writer" },
  { id: 5, title: "数据时效要求", match: "数据时效", numbered: false, owner: "chapter-writer" },
  { id: 6, title: "数据输出方式", match: "数据输出方式", numbered: false, owner: "chapter-writer" },
  { id: 7, title: "质量检查要求", match: "质量检查要求", numbered: false, owner: "chapter-writer" },
  { id: 8, title: "优先级与验收标准", match: "优先级与验收标准", numbered: false, owner: "chapter-writer" },
  { id: 9, title: "待确认问题", match: "待确认问题", numbered: false, owner: "chapter-writer" },
]

export function chapterDef(id: ChapterId): ChapterDef {
  const def = CHAPTERS.find((c) => c.id === id)
  if (!def) throw new Error(`未知章节：${id}`)
  return def
}

// ── 指标表 ──────────────────────────────────────────────────────────────
/** 第 3 章指标表：必须且仅这 7 列，顺序固定。 */
export const METRIC_FIELDS = [
  { key: "name", label: "指标名称", required: true },
  { key: "domain", label: "主题域", required: true },
  { key: "definition", label: "业务定义", required: true },
  { key: "caliber", label: "计算口径", required: true },
  { key: "filter", label: "过滤条件", required: false },
  { key: "dimensions", label: "下钻维度", required: true },
  { key: "scenario", label: "应用场景", required: true },
] as const

export const METRIC_COLUMNS: string[] = METRIC_FIELDS.map((f) => f.label)
export const METRIC_KEYS: string[] = METRIC_FIELDS.map((f) => f.key)

/** 每批提交的指标上限（跨批由 .work/sec3.json 累积去重）。 */
export const METRIC_BATCH_LIMIT = 5

/** 计算口径五项要素（用户规范已展开，属「已解析」的外部引用）。 */
export const CALIBER_PARTS = [
  { key: "objectScope", label: "统计对象与粒度" },
  { key: "counting", label: "计数与去重" },
  { key: "timeBasis", label: "时间口径" },
  { key: "validity", label: "有效性限定" },
  { key: "attribution", label: "归属与分摊" },
] as const

export const DIMENSION_NONE = "无"
export const OUTPUT_TYPES = ["报表", "看板", "接口", "导出文件", "下游系统"] as const
export const PRIORITIES = ["P0", "P1", "P2"] as const

// ── 外部引用（未给出枚举的严格按用户原文标注，不得自造取值） ──────────
export type ExternalReference = {
  key: string
  label: string
  chapter: ChapterId
  resolved: boolean
  hint: string
}

export const EXTERNAL_REFERENCES: ExternalReference[] = [
  {
    key: "refreshCycle",
    label: "刷新周期与时效口径",
    chapter: 5,
    resolved: false,
    hint: "用户规范未给出可选取值；不得自造 d/h/w/m/y/r/f 之类周期枚举。缺失处写占位引用并标注「需用户提供该章节内容」。",
  },
  {
    key: "qualityRuleType",
    label: "数据质量规则类型",
    chapter: 7,
    resolved: false,
    hint: "用户规范未给出规则类型枚举；不得自造 7 类质量规则。缺失处写占位引用并标注「需用户提供该章节内容」。",
  },
  {
    key: "caliberFive",
    label: "计算口径五项要素",
    chapter: 3,
    resolved: true,
    hint: "五项已在本文件 CALIBER_PARTS 展开，属于可完整落地的规则。",
  },
]

export const UNRESOLVED_REFERENCES = EXTERNAL_REFERENCES.filter((r) => !r.resolved)

// ── R15：文档中禁止出现的技术术语（业务语言约束） ──────────────────────
export const TECH_TERMS: { term: string; pattern: RegExp }[] = [
  { term: "SQL", pattern: /\bSQL\b/i },
  { term: "库表", pattern: /库表/ },
  { term: "字段名", pattern: /字段名/ },
  { term: "表名", pattern: /表名/ },
  { term: "数仓分层", pattern: /\b(ODS|DWD|DWS|ADS)\b/ },
  { term: "引擎/存储名", pattern: /\b(Hive|Spark|Flink|Kafka|Doris|ClickHouse|MySQL|PostgreSQL)\b/i },
]

// ── 规则表 R01–R18 ──────────────────────────────────────────────────────
export type Severity = "error" | "warning" | "info"
export type RuleOwner =
  | "md-validator"
  | "submit-chapter"
  | "submit-metrics-batch"
  | "validate-json"
  | "check-logic-graph"
  | "finalize-doc"
  | "guard"

export type RuleDef = {
  id: string
  title: string
  owner: RuleOwner
  severity: Severity
  code: string
  detail: string
}

/**
 * 每条规则在系统内只有一个权威执行点（owner）。
 * 下游工具不得重复实现同一规则，只允许消费上一步产出的错误码。
 */
export const RULES: RuleDef[] = [
  {
    id: "R01",
    title: "章节完整性",
    owner: "md-validator",
    severity: "error",
    code: "E01_CHAPTER_MISSING",
    detail: "9 个章节标题必须全部存在；按标题包含词匹配，兼容无编号写法。",
  },
  {
    id: "R02",
    title: "章节顺序与唯一性",
    owner: "md-validator",
    severity: "error",
    code: "E02_CHAPTER_ORDER",
    detail: "同一章节标题只能出现一次，且出现顺序必须按 1→9 递增。",
  },
  {
    id: "R03",
    title: "第 3 章仅一张表",
    owner: "md-validator",
    severity: "error",
    code: "E03_CHAPTER3_TABLE_COUNT",
    detail: "「数据指标」章节内除指标表外不得出现任何其他表格。",
  },
  {
    id: "R04",
    title: "指标表 7 列表头",
    owner: "md-validator",
    severity: "error",
    code: "E04_METRIC_HEADER",
    detail: "表头必须等于「指标名称|主题域|业务定义|计算口径|过滤条件|下钻维度|应用场景」，顺序固定。",
  },
  {
    id: "R05",
    title: "表格行结构",
    owner: "md-validator",
    severity: "error",
    code: "E05_TABLE_ROW_SHAPE",
    detail: "每行（含表头行与分隔行）以 | 开头并以 | 结尾，单元格数恰为 7。",
  },
  {
    id: "R06",
    title: "单元格单行、无竖线",
    owner: "md-validator",
    severity: "error",
    code: "E06_CELL_ESCAPE",
    detail: "单元格内不得出现转义竖线 \\|、<br>、&nbsp; 等换行/竖线变通写法。",
  },
  {
    id: "R07",
    title: "第 3 章表格隔离",
    owner: "md-validator",
    severity: "error",
    code: "E07_CHAPTER3_INTRUSION",
    detail: "指标表上下除空行外不得有其他内容，说明性文字须写在标题之前。",
  },
  {
    id: "R08",
    title: "指标名称全局唯一",
    owner: "submit-metrics-batch",
    severity: "error",
    code: "E08_METRIC_DUPLICATE",
    detail: "同一批内、跨批累积、以及与目标文档已有指标之间，名称均不得重复（名称即全链路主键）。",
  },
  {
    id: "R09",
    title: "计算口径五项齐全",
    owner: "submit-metrics-batch",
    severity: "error",
    code: "E09_CALIBER_INCOMPLETE",
    detail: "统计对象与粒度、计数与去重、时间口径、有效性限定、归属与分摊五项缺一即拒收。",
  },
  {
    id: "R10",
    title: "外部引用占位合规",
    owner: "md-validator",
    severity: "error",
    code: "E10_EXTERNAL_REF_FABRICATED",
    detail:
      "引用「刷新周期与时效口径」「数据质量规则类型」而用户未提供取值时，必须同时出现「需用户提供该章节内容」；且不得把刷新周期写成 d/h/w/m/y/r/f 单字母枚举。",
  },
  {
    id: "R11",
    title: "下钻维度声明合法",
    owner: "submit-metrics-batch",
    severity: "error",
    code: "E11_DIMENSION_INVALID",
    detail: "多维度用「、」分隔，层级用「→」由粗到细，无下钻填「无」，不得混用逗号/分号或写库表字段名。",
  },
  {
    id: "R12",
    title: "单章 JSON schema 校验",
    owner: "submit-chapter",
    severity: "error",
    code: "E12_SCHEMA",
    detail: "按 schema.ts 中该章节的 zod schema 校验；失败不落盘，返回字段路径级错误。",
  },
  {
    id: "R13",
    title: "JSON 完整性与一致性",
    owner: "validate-json",
    severity: "error",
    code: "E13_JSON_INTEGRITY",
    detail: "sec1–sec9 齐全、chapter 字段与文件编号一致、第 3 章指标数组非空。",
  },
  {
    id: "R14",
    title: "逻辑图一致性（A/B 类）",
    owner: "check-logic-graph",
    severity: "error",
    code: "E14A_* / E14B_*",
    detail: "A 类跨章节引用一致性 + B 类结构化矛盾，全部由代码判定；子码见 check-logic-graph.ts。",
  },
  {
    id: "R15",
    title: "业务语言约束",
    owner: "md-validator",
    severity: "error",
    code: "E15_TECH_TERM",
    detail: "全文不得出现 SQL、库表、字段名、表名、数仓分层、引擎/存储名等技术术语。",
  },
  {
    id: "R16",
    title: "落盘最终门禁",
    owner: "finalize-doc",
    severity: "error",
    code: "E16_FINALIZE_BLOCKED",
    detail: "渲染后必须：MD 校验全绿、无 error 级逻辑问题、无 open 的 blocker 级审查结论、增量合并无冲突。",
  },
  {
    id: "R17",
    title: "非授权写入拦截",
    owner: "guard",
    severity: "error",
    code: "E17_WRITE_FORBIDDEN",
    detail: "对 docs/*_开发需求.md 的 write/edit/apply_patch/shell 重定向一律拦截，唯一写盘路径是 finalize-doc。",
  },
  {
    id: "R18",
    title: "指标对象字段形状",
    owner: "submit-metrics-batch",
    severity: "error",
    code: "E18_METRIC_SHAPE",
    detail:
      "每条指标必须恰好 7 个字段、缺一或多一均拒收、顺序与 METRIC_KEYS 一致；必填字段为空或含竖线/换行同样拒收。",
  },
]

export function ruleOf(id: string): RuleDef {
  const rule = RULES.find((r) => r.id === id)
  if (!rule) throw new Error(`未知规则：${id}`)
  return rule
}

// ── 状态目录与路径 ──────────────────────────────────────────────────────
export function workPath(root: string, ...parts: string[]): string {
  return path.join(root, WORK_DIR, ...parts)
}

export function secPath(root: string, id: ChapterId): string {
  return workPath(root, `sec${id}.json`)
}

export function docPath(root: string, businessName: string): string {
  return path.join(root, DOCS_DIR, `${businessName}${DOC_SUFFIX}`)
}

export function reviewReportPath(root: string, businessName: string): string {
  return path.join(root, DOCS_DIR, `${businessName}${REVIEW_SUFFIX}`)
}

export type SectionState = { chapter: ChapterId; payload: any; submittedAt: string; revision: number }

/** 读取已提交的全部章节中间态；缺失的章节返回 undefined。 */
export function loadSections(root: string): Partial<Record<ChapterId, any>> {
  const result: Partial<Record<ChapterId, any>> = {}
  for (const id of CHAPTER_IDS) {
    const state = readJson<SectionState>(secPath(root, id))
    if (state && state.payload !== undefined) result[id] = state.payload
  }
  return result
}
