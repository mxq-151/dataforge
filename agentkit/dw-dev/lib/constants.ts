/**
 * 数仓开发套件（dw-dev）的常量、契约与规则表。
 *
 * 与 req-doc 套件共用用户级目录，因此：
 * - tool / agent / command 全部 `dw-` 前缀，错误码用 W 前缀（kit1 用 E）；
 * - 运行时状态放 `.dw/`（kit1 用 `.work/`），用户级状态由构建清单写到 `.dwagent/`。
 *
 * 规范来源（逐字对齐仓库既有实现，不自行发明）：
 * - 设计文档：src/hooks/opencode/prompts/dataArchitect.ts（8 章、指标表 9 列、稽核规则表 5 列）
 * - 代码规范：docs/guide/code.md（目录、文件命名、代码头 7 字段、SQL 规范）
 * - 质量规则：src/types/quality.ts QUALITY_RULE_TYPES（7 类）
 */
import path from "node:path"
import { readJson } from "../../shared/lib/io"

export { nowIso, readJson, readText, updateJson, writeJsonAtomic, writeTextAtomic } from "../../shared/lib/io"

// ── 路径与状态 ──────────────────────────────────────────────────────────
export const DW_DIR = ".dw"
export const DOCS_DIR = "docs"
export const DDL_DIR = "ddls"
export const STAGING_DIR = ".dw/staging"
export const DESIGN_SUFFIX = "_数仓设计.md"
export const REVIEW_SUFFIX = "_审查报告.md"

export const PROGRAM_DIRS = { sql: "sql", java: "code", scala: "code" } as const

export function workPath(root: string, ...parts: string[]): string {
  return path.join(root, DW_DIR, ...parts)
}

export function reqPath(root: string): string {
  return workPath(root, "req.json")
}
export function metaPath(root: string): string {
  return workPath(root, "meta.json")
}
export function tablesPath(root: string): string {
  return workPath(root, "tables.json")
}
export function metricsPath(root: string): string {
  return workPath(root, "metrics.json")
}
export function qualityPath(root: string): string {
  return workPath(root, "quality.json")
}
export function designErrorsPath(root: string): string {
  return workPath(root, "design-errors.json")
}
export function reviewPath(root: string): string {
  return workPath(root, "review.json")
}
export function tracePath(root: string): string {
  return workPath(root, "trace.json")
}
export function designStatePath(root: string): string {
  return workPath(root, "design.json")
}
export function jobsPath(root: string): string {
  return workPath(root, "jobs.json")
}
export function codeErrorsPath(root: string): string {
  return workPath(root, "code-errors.json")
}
export function codeManifestPath(root: string): string {
  return workPath(root, "code-manifest.json")
}
export function designDocPath(root: string, businessName: string): string {
  return path.join(root, DOCS_DIR, `${businessName}${DESIGN_SUFFIX}`)
}
/** 上游需求文档（由 req-doc 套件产出，只读）。 */
export function docPathForRequirement(root: string, businessName: string): string {
  return path.join(root, DOCS_DIR, `${businessName}_开发需求.md`)
}
export function reviewReportPath(root: string, businessName: string): string {
  return path.join(root, DOCS_DIR, `${businessName}${REVIEW_SUFFIX}`)
}
export function reviewReportPathFor(root: string, businessName: string, suffix: string): string {
  return path.join(root, DOCS_DIR, `${businessName}${suffix}`)
}
export function ddlFilePath(root: string, layer: string): string {
  return path.join(root, DDL_DIR, `${layer}_ddl.sql`)
}
export function programFilePath(root: string, kind: "sql" | "java" | "scala", layer: string, name: string): string {
  const ext = kind === "sql" ? ".sql" : kind === "java" ? ".java" : ".scala"
  return path.join(root, PROGRAM_DIRS[kind], layer, `${name}${ext}`)
}

// ── 设计文档章节（8 章，顺序固定） ────────────────────────────────────
export type DesignChapterId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8
export const DESIGN_CHAPTER_IDS: DesignChapterId[] = [1, 2, 3, 4, 5, 6, 7, 8]

export type DesignChapterDef = {
  id: DesignChapterId
  title: string
  match: string
  /** 章节内是否必须恰有一张机器解析表 */
  table?: "metrics" | "quality"
}

export const DESIGN_CHAPTERS: DesignChapterDef[] = [
  { id: 1, title: "需求概述", match: "需求概述" },
  { id: 2, title: "技术架构说明", match: "技术架构" },
  { id: 3, title: "分层库表设计", match: "分层库表设计" },
  { id: 4, title: "数据ETL逻辑", match: "ETL逻辑" },
  { id: 5, title: "数据指标", match: "数据指标", table: "metrics" },
  { id: 6, title: "数据质量稽核设计", match: "质量", table: "quality" },
  { id: 7, title: "依赖与调度说明", match: "依赖与调度" },
  { id: 8, title: "待确认问题", match: "待确认问题" },
]

export function designChapterDef(id: DesignChapterId): DesignChapterDef {
  const def = DESIGN_CHAPTERS.find((chapter) => chapter.id === id)
  if (!def) throw new Error(`未知设计章节：${id}`)
  return def
}

// ── 机器解析表 ──────────────────────────────────────────────────────────
/** 设计文档第 5 章：9 列，顺序固定。 */
export const METRIC_DESIGN_COLUMNS = [
  "指标编码",
  "指标名称",
  "主题域",
  "指标含义",
  "计算表达式",
  "过滤条件",
  "下钻维度",
  "字段来源",
  "数据源",
] as const

/** 设计文档第 6 章：5 列，顺序固定。 */
export const QUALITY_COLUMNS = ["规则名", "规则类型", "校验对象（库.表.字段）", "阈值", "处置方式"] as const

/** 设计文档第 3 章每张表的字段清单列。 */
export const FIELD_COLUMNS = [
  "字段名",
  "中文名",
  "数据类型",
  "是否必填",
  "默认值",
  "来源",
  "计算逻辑",
  "个人信息",
  "数据级别",
  "脱敏要求",
] as const

/** 设计文档第 3 章表清单列。 */
export const TABLE_LIST_COLUMNS = [
  "表英文名",
  "中文名",
  "类型",
  "分层",
  "主题域",
  "粒度",
  "主键",
  "分区",
  "更新方式",
  "分类路径",
  "数据级别",
  "生命周期",
  "负责人",
] as const

/** 设计文档第 7 章程序与任务命名列。 */
export const JOB_LIST_COLUMNS = ["程序文件", "调度任务名", "目录", "依赖任务"] as const

// ── 分层与建模枚举 ──────────────────────────────────────────────────────
export type Layer = "ods" | "dwd" | "dws" | "ads" | "dim"
export const LAYERS: Layer[] = ["ods", "dwd", "dws", "ads", "dim"]
export const LAYER_RANK: Record<Layer, number> = { ods: 0, dwd: 1, dim: 1, dws: 2, ads: 3 }

export type LayerSpec = {
  /** 该层定位 */
  purpose: string
  /** 该层存什么 */
  stores: string
  /** 该层不存什么 */
  excludes: string
  /** 允许的上游分层；空数组表示只能接源系统 */
  upstream: Layer[]
}

/**
 * 分层规范（默认口径）。
 *
 * 这是本套件对「每层该放什么」的默认约定，W22 用它校验依赖方向；
 * 若平台已有分层标准，以平台为准，改这里即可整体生效。
 */
export const LAYER_SPEC: Record<Layer, LayerSpec> = {
  ods: {
    purpose: "贴源层",
    stores: "源系统原始表结构与按周期落地的原始数据，只做字段名/类型统一",
    excludes: "不做跨表关联、不做业务计算、不承载指标口径",
    upstream: [],
  },
  dwd: {
    purpose: "明细层",
    stores: "按业务过程建模的明细事实、退化维度，保持最细粒度",
    excludes: "不做跨主题汇总、不承载 ADS 场景口径",
    upstream: ["ods", "dwd", "dim"],
  },
  dws: {
    purpose: "汇总层",
    stores: "按主题与统计维度轻度汇总的宽表，指标口径在此统一",
    excludes: "不直连 ODS、不存明细流水",
    upstream: ["dwd", "dws", "dim"],
  },
  ads: {
    purpose: "应用层",
    stores: "面向报表/接口/分析场景的结果表，一层一场景",
    excludes: "不回写明细、不跨场景复用口径",
    upstream: ["dwd", "dws", "ads", "dim"],
  },
  dim: {
    purpose: "维度层",
    stores: "公共维度与缓慢变化维（scd2）",
    excludes: "不存事实度量",
    upstream: ["ods", "dwd", "dim"],
  },
}

// ── 数据分类分级（GB/T 43697-2024） ────────────────────────────────────
/** 依据：GB/T 43697-2024《数据安全技术 数据分类分级规则》6.1，仅三级。 */
export const DATA_TIERS = ["一般数据", "重要数据", "核心数据"] as const
export type DataTier = (typeof DATA_TIERS)[number]
export const TIER_RANK: Record<DataTier, number> = { 一般数据: 1, 重要数据: 2, 核心数据: 3 }

/** GB/T 43697-2024 6.4.1 影响对象。 */
export const IMPACT_OBJECTS = ["国家安全", "经济运行", "社会秩序", "公共利益", "组织权益", "个人权益"] as const
export type ImpactObject = (typeof IMPACT_OBJECTS)[number]

/** GB/T 43697-2024 6.4.2 影响程度。 */
export const IMPACT_DEGREES = ["特别严重危害", "严重危害", "一般危害"] as const
export type ImpactDegree = (typeof IMPACT_DEGREES)[number]

/** GB/T 43697-2024 表 1「数据分级确定规则」：影响对象 × 影响程度 → 级别。 */
export const TIER_BY_IMPACT: Record<ImpactObject, Record<ImpactDegree, DataTier>> = {
  国家安全: { 特别严重危害: "核心数据", 严重危害: "核心数据", 一般危害: "重要数据" },
  经济运行: { 特别严重危害: "核心数据", 严重危害: "重要数据", 一般危害: "一般数据" },
  社会秩序: { 特别严重危害: "核心数据", 严重危害: "重要数据", 一般危害: "一般数据" },
  公共利益: { 特别严重危害: "核心数据", 严重危害: "重要数据", 一般危害: "一般数据" },
  组织权益: { 特别严重危害: "一般数据", 严重危害: "一般数据", 一般危害: "一般数据" },
  个人权益: { 特别严重危害: "一般数据", 严重危害: "一般数据", 一般危害: "一般数据" },
}

/** GB/T 43697-2024 5.1 c) 与附录 B：个人信息的字段级标记。 */
export const PERSONAL_INFO_TYPES = ["否", "个人信息", "敏感个人信息"] as const
export type PersonalInfoType = (typeof PERSONAL_INFO_TYPES)[number]

export const MASKING_METHODS = ["无需脱敏", "掩码脱敏", "哈希脱敏", "加密存储"] as const
export type MaskingMethod = (typeof MASKING_METHODS)[number]

/**
 * 企业口径（非 GB/T 43697-2024 强制）：级别 → 允许的最小管控方式。
 * 标准只规定「对不同级别数据采取相应保护措施」（4 b)），未规定脱敏方法与级别的强制对应。
 */
export const LEVEL_MASKING: Record<DataTier, MaskingMethod[]> = {
  一般数据: ["无需脱敏", "掩码脱敏", "哈希脱敏", "加密存储"],
  重要数据: ["哈希脱敏", "加密存储"],
  核心数据: ["加密存储"],
}

/**
 * 企业口径（非标准强制）：默认允许落离线仓的级别。
 * 核心数据默认禁止；确需落仓时在此显式加入，并在第 8 章记录审批依据。
 */
export const OFFLINE_ALLOWED_TIERS: DataTier[] = ["一般数据", "重要数据"]

/** 分类分级口径来源，供文档与报错引用。 */
export const CLASSIFICATION_STANDARD = "GB/T 43697-2024《数据安全技术 数据分类分级规则》"

// ── 表名与中文名约定 ────────────────────────────────────────────────────
export const TABLE_NAME_MAX = 64
export const TABLE_NAME_RESERVED = [
  "select",
  "from",
  "where",
  "group",
  "order",
  "by",
  "having",
  "join",
  "union",
  "insert",
  "update",
  "delete",
  "create",
  "drop",
  "alter",
  "table",
  "index",
  "key",
  "primary",
  "foreign",
  "partition",
  "user",
  "values",
  "into",
  "on",
  "as",
  "and",
  "or",
  "not",
  "null",
  "case",
  "when",
  "then",
  "else",
  "end",
  "distinct",
  "limit",
  "between",
  "like",
  "in",
  "is",
  "desc",
  "asc",
  "database",
  "schema",
] as const

/** 周期 → 表中文名后缀用字（「日表」「小时表」…）。 */
export const CYCLE_CN_SUFFIX: Record<string, string> = {
  d: "日",
  h: "小时",
  w: "周",
  m: "月",
  y: "年",
  r: "实时",
  f: "快照",
}

/** 表中文名可确定性判定的后缀：拉链表固定「拉链表」，其余按周期。 */
export function expectedCnNameSuffix(table: Pick<TableDesign, "enName" | "updateMode">): string {
  if (table.updateMode === "scd2") return "拉链表"
  const cycle = table.enName.split("_")[3] ?? "d"
  return `${CYCLE_CN_SUFFIX[cycle] ?? cycle}表`
}


export const UPDATE_MODES = ["full", "incremental", "scd2", "snapshot"] as const
export type UpdateMode = (typeof UPDATE_MODES)[number]

export const STORAGE_FORMATS = ["orc", "parquet", "text", "mergeTree", "olap"] as const
export const COMPRESSIONS = ["none", "snappy", "zstd", "gzip", "lz4"] as const

export const CYCLE_CODES: Record<string, string> = {
  d: "日",
  h: "小时",
  w: "周",
  m: "月",
  y: "年",
  r: "实时流式",
  f: "全量快照",
}
export const CYCLES = Object.keys(CYCLE_CODES)

export const OP_TYPES: Record<string, string> = {
  load: "加载",
  etl: "转换清洗",
  sync: "同步",
  calc: "计算聚合",
  check: "质量校验",
  export: "导出",
}
export const OPS = Object.keys(OP_TYPES)

export const ENVS = ["_test", "_gray", "_prod"] as const
export type EnvSuffix = (typeof ENVS)[number]

// ── 引擎 ────────────────────────────────────────────────────────────────
/** DDL 代码头 @引擎 的合法取值（dataArchitect.ts 原文，10 个）。 */
export const DDL_ENGINES = [
  "spark",
  "flink",
  "kyuubi",
  "hive",
  "doris",
  "clickhouse",
  "starrocks",
  "mysql",
  "postgresql",
  "presto",
] as const

/** 程序代码头 @引擎 的合法取值（docs/guide/code.md 原文，22 个）。 */
export const CODE_ENGINES = [
  "spark",
  "flink",
  "flink_stream",
  "kyuubi",
  "hive",
  "hivecli",
  "doris",
  "clickhouse",
  "starrocks",
  "mysql",
  "postgresql",
  "presto",
  "trino",
  "python",
  "shell",
  "mr",
  "mapreduce",
  "datax",
  "sqoop",
  "seatunnel",
  "dinky",
  "linkis",
  "java",
  "procedure",
  "http",
] as const

/** DDL 生成支持的方言；不在表内的引擎显式失败，不猜语法。 */
export const DIALECTS = ["hive", "spark", "doris", "starrocks", "clickhouse", "mysql", "postgresql"] as const
export type Dialect = (typeof DIALECTS)[number]

export const ENGINE_DIALECT: Record<string, Dialect> = {
  hive: "hive",
  kyuubi: "hive",
  spark: "spark",
  doris: "doris",
  starrocks: "starrocks",
  clickhouse: "clickhouse",
  mysql: "mysql",
  postgresql: "postgresql",
}

// ── 数据质量规则类型（src/types/quality.ts 逐字） ─────────────────────
export const QUALITY_RULE_TYPES = [
  { label: "主键唯一性", code: "PRIMARY_KEY_UNIQUE", desc: "主键/唯一键重复检测" },
  { label: "非空", code: "NOT_NULL", desc: "关键字段空值与空串检测" },
  { label: "值域", code: "VALUE_RANGE", desc: "枚举字典取值与数值区间合法性" },
  { label: "行数波动", code: "ROW_COUNT_FLUCTUATION", desc: "当日行数相对历史基线的涨跌幅" },
  { label: "行数环比", code: "ROW_COUNT_MOM", desc: "当期行数与上期行数的对比" },
  { label: "上下游对账", code: "UPSTREAM_DOWNSTREAM_RECON", desc: "上下游同口径记录数/金额一致性" },
  { label: "口径一致性", code: "METRIC_CONSISTENCY", desc: "同一指标在不同表、不同层之间的计算结果一致性" },
] as const

export const QUALITY_TYPE_LABELS = QUALITY_RULE_TYPES.map((item) => item.label)
export const QUALITY_DISPOSITIONS = ["阻断下游", "告警", "阻断下游+告警"] as const

// ── 代码头 ──────────────────────────────────────────────────────────────
export const HEADER_KEYS = ["备注", "引擎", "依赖", "程序参数", "资源参数", "任务参数", "数据源"] as const
export const HEADER_REQUIRED = ["备注", "引擎", "依赖", "程序参数", "资源参数", "任务参数", "数据源"] as const

/** 代码头各字段的填写口径（agent、规则文案、规范文档共用同一套措辞）。 */
export const HEADER_DETAILS: Record<(typeof HEADER_KEYS)[number], string> = {
  备注: "非空，说明作业目的与产出。",
  引擎: "必须取 CODE_ENGINES 中的值，并与作业声明的 engine 一致。",
  依赖: "前置作业名，逗号分隔；无依赖写「无」；必须与 dependencies 完全一致，不写调度项目前缀。",
  程序参数: "业务入参（这次要算什么），写真实值，无则填「无」；代码中每个 ${变量} 都必须在此同名声明。",
  资源参数:
    "算力与资源归属（这次给多少资源）：并行度、内存、核数、slot、队列等数量类；无则填「无」；由调度平台填入任务节点资源字段，不下发程序入参。",
  任务参数:
    "提交形态与引擎侧配置（这个任务怎么提交）：master、deploy-mode、application.name 等；无则填「无」；由调度平台填提交字段或原样进「其他参数」。",
  数据源: "与作业声明的 datasource 一致，多个用逗号分隔。",
}

/** 三个参数字段的判定顺序：业务入参 → 程序参数；数量类资源 → 资源参数；其余提交/引擎侧配置 → 任务参数。 */
export const RESOURCE_PARAM_KEYS = [
  "driver-memory",
  "executor-memory",
  "executor-cores",
  "num-executors",
  "memory",
  "cores",
  "parallelism",
  "slots",
  "queue",
  "pool",
  "conf",
] as const
export const TASK_PARAM_KEYS = [
  "master",
  "deploy-mode",
  "application-name",
  "name",
  "driver-class",
  "jars",
  "files",
  "archives",
  "principal",
  "keytab",
  "properties",
] as const

export const PARTITION_FORMATS = ["yyyy-MM-dd", "yyyyMMdd"] as const

// ── 规则表 W01–W42 ─────────────────────────────────────────────────────
export type Severity = "error" | "warning" | "info"
export type RuleOwner =
  | "dw-extract-req"
  | "dw-submit-meta"
  | "dw-submit-tables"
  | "dw-submit-metrics"
  | "dw-submit-quality"
  | "dw-validate-design"
  | "dw-submit-review"
  | "dw-finalize-design"
  | "dw-trace-metric"
  | "dw-extract-design"
  | "dw-submit-job"
  | "dw-check-code"
  | "dw-finalize-code"
  | "agent-permission"

export type RuleDef = {
  id: string
  title: string
  owner: RuleOwner
  severity: Severity
  code: string
  detail: string
  /** D=确定性代码判定，M=模型判定且强制带证据 */
  mode: "D" | "M"
}

export const RULES: RuleDef[] = [
  {
    id: "W01",
    title: "上游需求文档可解析",
    owner: "dw-extract-req",
    severity: "error",
    code: "W01_REQ_MISSING / W01_REQ_CHAPTER",
    detail: "docs/{业务}_开发需求.md 必须存在，9 章标题齐全且顺序正确。",
    mode: "D",
  },
  {
    id: "W02",
    title: "需求指标表 7 列",
    owner: "dw-extract-req",
    severity: "error",
    code: "W02_REQ_METRIC_TABLE",
    detail: "第 3 章有且仅有一张表，表头为 7 列固定顺序，行以 | 开头结尾。",
    mode: "D",
  },
  {
    id: "W03",
    title: "需求指标必填项",
    owner: "dw-extract-req",
    severity: "error",
    code: "W03_REQ_METRIC_REQUIRED",
    detail: "指标名称/主题域/业务定义/计算口径/下钻维度/应用场景非空，名称全局唯一。",
    mode: "D",
  },
  {
    id: "W04",
    title: "metadata 证据形状",
    owner: "dw-submit-meta",
    severity: "error",
    code: "W04_META_EVIDENCE_SHAPE",
    detail: "证据必须含 database/table/datasource/sourceTool/query/total/hit/snippet；sourceTool 只能是 metadata_search 或 metadata_detail。",
    mode: "D",
  },
  {
    id: "W05",
    title: "引用对象有 metadata 证据",
    owner: "dw-submit-tables",
    severity: "error",
    code: "W05_META_UNVERIFIED",
    detail: "设计里出现的每个库.表.字段，必须在证据登记表命中（hit=true 且 total>0）；查不到即失败，不允许猜近似名。",
    mode: "D",
  },
  {
    id: "W06",
    title: "表名与库名规范",
    owner: "dw-submit-tables",
    severity: "error",
    code: "W06_TABLE_NAME",
    detail:
      "表名严格四段 {分层}_{业务域}_{实体}_{周期}：全小写、每段 [a-z][a-z0-9]*、实体非空、长度 ≤64、不得命中 SQL 保留字黑名单；库名 {分层}_{业务域}{环境}，环境后缀 _test/_gray/_prod。",
    mode: "D",
  },
  {
    id: "W07",
    title: "粒度声明",
    owner: "dw-submit-tables",
    severity: "error",
    code: "W07_GRAIN_MISSING",
    detail: "每张表必须显式声明一行数据代表什么，且不能是「一行数据」这类同义反复。",
    mode: "D",
  },
  {
    id: "W08",
    title: "主键/唯一键",
    owner: "dw-submit-tables",
    severity: "error",
    code: "W08_KEY_INVALID",
    detail: "主键或唯一键非空，且每个键字段都在字段清单中。",
    mode: "D",
  },
  {
    id: "W09",
    title: "分区策略",
    owner: "dw-submit-tables",
    severity: "error",
    code: "W09_PARTITION",
    detail: "分区字段、格式（yyyy-MM-dd/yyyyMMdd）、策略必须声明；分区字段必须在字段清单中。",
    mode: "D",
  },
  {
    id: "W10",
    title: "存储与生命周期",
    owner: "dw-submit-tables",
    severity: "error",
    code: "W10_STORAGE_LIFECYCLE",
    detail: "存储格式/压缩已声明，lifecycleDays 为正整数。",
    mode: "D",
  },
  {
    id: "W11",
    title: "更新方式",
    owner: "dw-submit-tables",
    severity: "error",
    code: "W11_UPDATE_MODE",
    detail: "更新方式取 full/incremental/scd2/snapshot；scd2 必含 start_date、end_date、is_current。",
    mode: "D",
  },
  {
    id: "W12",
    title: "引擎方言可生成",
    owner: "dw-submit-tables",
    severity: "error",
    code: "W12_DIALECT_UNSUPPORTED",
    detail: "字段逻辑类型必须在该 @引擎 方言下有确定映射；不支持的引擎或类型显式失败，不猜。",
    mode: "D",
  },
  {
    id: "W13",
    title: "字段来源可解析",
    owner: "dw-submit-tables",
    severity: "error",
    code: "W13_FIELD_SOURCE",
    detail: "来源写成 库.表:字段，且指向本设计字段或已登记证据。",
    mode: "D",
  },
  {
    id: "W14",
    title: "指标名称逐字继承与覆盖",
    owner: "dw-submit-metrics",
    severity: "error",
    code: "W14_METRIC_NAME_MISMATCH / W14_METRIC_COVERAGE",
    detail: "设计指标名称必须与需求逐字一致；需求里每个指标都必须被设计覆盖。",
    mode: "D",
  },
  {
    id: "W15",
    title: "指标编码",
    owner: "dw-submit-metrics",
    severity: "error",
    code: "W15_METRIC_CODE",
    detail: "编码格式 {项目编码}_NNNN（4 位序号），全局唯一。",
    mode: "D",
  },
  {
    id: "W16",
    title: "指标字段绑定",
    owner: "dw-submit-metrics",
    severity: "error",
    code: "W16_METRIC_BINDING",
    detail: "字段来源必须绑定到本设计表字段或已登记证据，不接受占位表名/字段名。",
    mode: "D",
  },
  {
    id: "W17",
    title: "数据源一致",
    owner: "dw-submit-metrics",
    severity: "error",
    code: "W17_DATASOURCE",
    detail: "指标数据源与证据登记的数据源逐字一致，全链路同一名称。",
    mode: "D",
  },
  {
    id: "W18",
    title: "下钻维度可落地",
    owner: "dw-submit-metrics",
    severity: "error",
    code: "W18_DIMENSION",
    detail: "格式 维度名(库.表:字段→字段)；字段必须存在，层级用 →。",
    mode: "D",
  },
  {
    id: "W19",
    title: "稽核规则表形状与类型",
    owner: "dw-submit-quality",
    severity: "error",
    code: "W19_QUALITY_SHAPE / W19_QUALITY_TYPE",
    detail: "5 列固定顺序；规则类型逐字取自 7 类；处置方式取 阻断下游/告警/阻断下游+告警。",
    mode: "D",
  },
  {
    id: "W20",
    title: "规则对象与阈值",
    owner: "dw-submit-quality",
    severity: "error",
    code: "W20_QUALITY_TARGET / W20_QUALITY_THRESHOLD",
    detail: "校验对象为 库.表 或 库.表.字段 且真实存在；阈值为 比较符+数值。",
    mode: "D",
  },
  {
    id: "W21",
    title: "规则覆盖与命名",
    owner: "dw-submit-quality",
    severity: "error",
    code: "W21_QUALITY_COVERAGE",
    detail: "每张新建表至少 1 条规则；规则名唯一且符合 {前缀}_{业务域}_{序号} {中文描述}。",
    mode: "D",
  },
  {
    id: "W22",
    title: "分层依赖单向可解析",
    owner: "dw-validate-design",
    severity: "error",
    code: "W22_LINEAGE",
    detail:
      "依赖必须符合 LAYER_SPEC 允许上游且无环：ODS 无上游；DWD←ODS/DWD/DIM；DWS←DWD/DWS/DIM；ADS←DWD/DWS/ADS/DIM；DIM←ODS/DWD/DIM；非 ODS 表必须有上游。",
    mode: "D",
  },
  {
    id: "W23",
    title: "产出覆盖",
    owner: "dw-validate-design",
    severity: "error",
    code: "W23_ADS_COVERAGE",
    detail: "需求第 6 章有输出时必须有 ADS 表；需求场景必须被指标应用场景覆盖。",
    mode: "D",
  },
  {
    id: "W24",
    title: "设计文档机器形状",
    owner: "dw-validate-design",
    severity: "error",
    code: "W24_DESIGN_DOC_SHAPE",
    detail: "8 章齐全且唯一；第 5 章仅一张 9 列表，第 6 章仅一张 5 列表；DDL 文件头 @数据源/@引擎 与设计一致。",
    mode: "D",
  },
  {
    id: "W25",
    title: "反向可追溯",
    owner: "dw-validate-design",
    severity: "error",
    code: "W25_TRACE_MISSING",
    detail: "需求每个指标 → 设计指标 → 表/字段，任一环缺失即失败，不静默跳过。",
    mode: "D",
  },
  {
    id: "W26",
    title: "指标反查非空",
    owner: "dw-trace-metric",
    severity: "error",
    code: "W26_TRACE_MISSING",
    detail: "dw-trace-metric 未命中时返回失败，不返回空结果让调用方猜。",
    mode: "D",
  },
  {
    id: "W27",
    title: "设计落盘门禁",
    owner: "dw-finalize-design",
    severity: "error",
    code: "W27_FINALIZE_DESIGN_BLOCKED",
    detail: "W01–W26 无 error、无 open blocker、增量合并无冲突，才允许写设计文档与 DDL。",
    mode: "D",
  },
  {
    id: "W28",
    title: "设计已定稿",
    owner: "dw-extract-design",
    severity: "error",
    code: "W28_DESIGN_NOT_FINALIZED",
    detail: "docs/{业务}_数仓设计.md 存在且与 trace 记录的 sha256 一致，ETL 章节可解析出作业。",
    mode: "D",
  },
  {
    id: "W29",
    title: "作业命名与路径",
    owner: "dw-submit-job",
    severity: "error",
    code: "W29_JOB_NAME_PATH",
    detail:
      "作业名必须等于由目标表推导的五段名 {分层}_{业务域}_{实体}_{操作}_{周期}；目录只能是 sql|code/{分层}；依赖写前置作业名（^[A-Za-z0-9_]+$）且必须存在于作业清单。",
    mode: "D",
  },
  {
    id: "W30",
    title: "代码头合规",
    owner: "dw-submit-job",
    severity: "error",
    code: "W30_CODE_HEADER",
    detail:
      "块注释在文件开头、连续、7 字段齐全；@引擎 在 CODE_ENGINES 内；@依赖 与 dependencies 一致；@资源参数 只写数量类资源、@任务参数 只写提交与引擎侧配置，跨字段即错。",
    mode: "D",
  },
  {
    id: "W31",
    title: "SQL 静态规范",
    owner: "dw-submit-job",
    severity: "error",
    code: "W31_SQL_STATIC",
    detail: "禁止 select *；insert 的 select 输出列顺序必须与设计字段一致；必须带分区过滤。",
    mode: "D",
  },
  {
    id: "W32",
    title: "参数与硬编码",
    owner: "dw-submit-job",
    severity: "error",
    code: "W32_PARAM",
    detail: "不得硬编码业务日期；${变量} 合法且已在 @程序参数 同名声明。",
    mode: "D",
  },
  {
    id: "W33",
    title: "引用对象存在",
    owner: "dw-submit-job",
    severity: "error",
    code: "W33_UNKNOWN_OBJECT",
    detail: "代码引用的库/表必须在本设计 DDL 或证据登记表中存在。",
    mode: "D",
  },
  {
    id: "W34",
    title: "代码头与作业声明一致",
    owner: "dw-submit-job",
    severity: "error",
    code: "W34_HEADER_CONSISTENCY",
    detail: "@依赖/@数据源/@引擎 与 JobSpec 声明及上游表一致。",
    mode: "D",
  },
  {
    id: "W35",
    title: "指标标注与字段顺序",
    owner: "dw-submit-job",
    severity: "error",
    code: "W35_METRIC_ANNOTATION / W35_FIELD_ORDER",
    detail: "产出指标的作业必须带 `-- 指标: {编码} {名称}`；insert 列顺序与设计字段顺序一致。",
    mode: "D",
  },
  {
    id: "W36",
    title: "语法校验通过",
    owner: "dw-check-code",
    severity: "error",
    code: "W36_SYNTAX_FAILED / W36_SYNTAX_UNAVAILABLE",
    detail: "SQL 走 /sql-validate，Java/Scala 走 /compile；服务不可用即失败，不伪造通过。",
    mode: "D",
  },
  {
    id: "W37",
    title: "代码落盘门禁",
    owner: "dw-finalize-code",
    severity: "error",
    code: "W37_FINALIZE_CODE_BLOCKED",
    detail: "W28–W36 全绿、无 open blocker、目标文件无冲突，才允许把 staging 移到产物目录。",
    mode: "D",
  },
  {
    id: "W38",
    title: "语义等价审查",
    owner: "dw-submit-review",
    severity: "error",
    code: "W38_REVIEW_EVIDENCE",
    detail: "口径等价、聚合层级、join 正确、幂等、指标编码一致，由模型判定且每条必须带原文证据。",
    mode: "M",
  },
  {
    id: "W39",
    title: "非工具写入拦截",
    owner: "agent-permission",
    severity: "error",
    code: "W39_WRITE_FORBIDDEN",
    detail: "dw-* agent 不得用 edit/bash 写 docs/ddls/sql/code，写盘只能由 finalize 工具完成。",
    mode: "D",
  },
  {
    id: "W40",
    title: "分类分级（GB/T 43697-2024）",
    owner: "dw-submit-tables",
    severity: "error",
    code: "W40_DATA_CLASSIFICATION",
    detail:
      "分类必填行业领域、业务属性、分类路径（行业目录缺失进待确认）；分级仅取核心/重要/一般数据，tier 必须等于由影响对象×影响程度按标准表 1 推出的级别；定级依据必填；表级不低于字段最高级；核心数据默认禁止落离线仓，需在 OFFLINE_ALLOWED_TIERS 显式放行。",
    mode: "D",
  },
  {
    id: "W41",
    title: "级别与最小必要管控",
    owner: "dw-submit-tables",
    severity: "error",
    code: "W41_MASKING_MATCH",
    detail:
      "按企业口径校验字段级别与脱敏方式：一般数据→无需/掩码/哈希/加密；重要数据→哈希/加密；核心数据→加密存储。GB/T 43697-2024 未规定级别与脱敏方式的强制对应，此映射不是标准强制。",
    mode: "D",
  },
  {
    id: "W42",
    title: "表中文名约定",
    owner: "dw-submit-tables",
    severity: "error",
    code: "W42_TABLE_CNNAME",
    detail:
      "表中文名必须以周期后缀结尾（日表/小时表/周表/月表/年表/实时表/快照表）；updateMode=scd2 必须以「拉链表」结尾。仅校验可确定性判定的后缀。",
    mode: "D",
  },
  {
    id: "W43",
    title: "Java/Scala 包与类名",
    owner: "dw-submit-job",
    severity: "error",
    code: "W43_PACKAGE_CLASS",
    detail:
      "package 必须为 {项目编码}.{相对工作空间的目录路径}（项目编码取工作空间目录名，如工作空间 /tmp/warehouse/TEST 下 code/ods/test.java → TEST.code.ods）；主类名/对象名必须与文件名逐字一致（大小写以文件名为准）。",
    mode: "D",
  },
  {
    id: "W44",
    title: "公共逻辑复用",
    owner: "dw-check-code",
    severity: "error",
    code: "W44_DUPLICATE_LOGIC",
    detail:
      "Java/Scala 作业之间不得复制同一段实现：去除注释与空行后，任意两个作业存在连续 ≥20 行完全相同的逻辑块即报错，要求抽取到公共逻辑目录复用。",
    mode: "D",
  },
  {
    id: "W45",
    title: "临时表命名与清理",
    owner: "dw-submit-tables",
    severity: "error",
    code: "W45_TEMP_TABLE",
    detail:
      "临时表名 tmp_{业务域}_{实体}_{周期}，tableType=临时表；tempTtlDays 必填且 ≤7，生命周期 ≤7 天；正式表不得填 tempTtlDays。",
    mode: "D",
  },
  {
    id: "W46",
    title: "质量回传契约",
    owner: "dw-submit-job",
    severity: "error",
    code: "W46_QUALITY_REPORT",
    detail:
      "质检作业必须回传 datasourceName/batchNo/ruleName/ruleType/passed/checkTime 等字段，并通过 DATAFORGE_QUALITY_REPORT_URL/TOKEN 环境变量注入地址与令牌，禁止硬编码回传地址。",
    mode: "D",
  },
  {
    id: "W47",
    title: "禁止破坏性语句",
    owner: "dw-submit-job",
    severity: "error",
    code: "W47_DESTRUCTIVE_SQL",
    detail: "SQL 作业与 DDL 禁止 DROP TABLE / TRUNCATE TABLE / DELETE FROM 等破坏性语句。",
    mode: "D",
  },
  {
    id: "W48",
    title: "金额字段使用 decimal",
    owner: "dw-submit-tables",
    severity: "error",
    code: "W48_AMOUNT_DECIMAL",
    detail: "字段名或中文名表示金额/价格/费用/成本时，逻辑类型必须是 decimal(p,s)，禁止 float/double/string。",
    mode: "D",
  },
  {
    id: "W49",
    title: "指标一处产出",
    owner: "dw-check-code",
    severity: "error",
    code: "W49_METRIC_OWNERSHIP",
    detail: "同一指标编码只能出现在一个作业的 metricCodes 中；其他作业引用指标须标注编码，不得重算。",
    mode: "D",
  },
  {
    id: "W50",
    title: "设计新增指标标注",
    owner: "dw-submit-metrics",
    severity: "error",
    code: "W50_METRIC_NEW_FLAG",
    detail:
      "需求文档第 3 章已有的指标不得标 isNew=true；需求文档未列出、由设计阶段补充的指标必须标 isNew=true，并在设计文档第 5 章单独列出待需求方确认。",
    mode: "D",
  },
]

export function ruleOf(id: string): RuleDef {
  const rule = RULES.find((item) => item.id === id)
  if (!rule) throw new Error(`未知规则：${id}`)
  return rule
}

// ── 状态读写 ────────────────────────────────────────────────────────────
export type EvidenceRecord = {
  database: string
  table: string
  column?: string
  datasource: string
  sourceTool: "metadata_search" | "metadata_detail"
  query: string
  total: number
  hit: boolean
  snippet: string
  submittedAt?: string
}

export type TableDesign = {
  enName: string
  cnName: string
  tableType?: "正式表" | "临时表"
  tempTtlDays?: number
  layer: Layer
  domain: string
  env: EnvSuffix
  grain: string
  businessDefinition: string
  drillDimensions: string[]
  etlSteps: string[]
  primaryKey: string[]
  uniqueKey?: string[]
  partition: { field: string; format: string; strategy: "single" | "range" | "list"; buckets?: number }
  storage: { format: string; compression: string }
  lifecycleDays: number
  updateMode: UpdateMode
  rerunnable: boolean
  engine: string
  datasource: string
  classification: {
    industry: string
    businessAttribute: string
    categoryPath: string
    industryCatalog?: string
  }
  level: {
    tier: DataTier
    impactObject: ImpactObject
    impactDegree: ImpactDegree
    basis: string
  }
  owner?: string
  consumer?: string
  upstream: string[]
  fields: FieldDesign[]
  submittedAt?: string
}

export type FieldDesign = {
  name: string
  cnName: string
  logicalType: string
  nullable: boolean
  defaultValue?: string
  source?: string
  expression?: string
  level: { tier: DataTier }
  personalInfo: PersonalInfoType
  masking: MaskingMethod
}

export type UtilSpec = {
  kind: "util"
  name: string
  filePath: string
  code: string
  note?: string
  submittedAt?: string
}

export type MetricDesign = {
  code: string
  name: string
  domain: string
  meaning: string
  expression: string
  filter: string
  dimensions: string
  sources: string
  datasource: string
  /** true 表示设计阶段新增、需求文档未列出的指标，需需求方确认 */
  isNew?: boolean
  submittedAt?: string
}

export type QualityRuleDesign = {
  name: string
  ruleType: string
  target: string
  threshold: string
  disposition: string
  table: string
  submittedAt?: string
}

export type JobSpec = {
  name: string
  kind: "sql" | "java" | "scala"
  engine: string
  layer: Layer
  domain: string
  entity: string
  op: string
  cycle: string
  filePath: string
  code: string
  dependencies: string[]
  programParams: string
  resourceParams?: string
  taskParams?: string
  datasource: string[]
  targetTable: string
  sourceTables: string[]
  metricCodes: string[]
  submittedAt?: string
}

export function loadReq(root: string): any | null {
  return readJson<any>(reqPath(root))
}
export function loadMeta(root: string): EvidenceRecord[] {
  return readJson<{ records: EvidenceRecord[] }>(metaPath(root))?.records ?? []
}
export function loadTables(root: string): TableDesign[] {
  return readJson<{ tables: TableDesign[] }>(tablesPath(root))?.tables ?? []
}
export function loadMetrics(root: string): MetricDesign[] {
  return readJson<{ metrics: MetricDesign[] }>(metricsPath(root))?.metrics ?? []
}
export function loadQuality(root: string): QualityRuleDesign[] {
  return readJson<{ rules: QualityRuleDesign[] }>(qualityPath(root))?.rules ?? []
}
export function loadJobs(root: string): JobSpec[] {
  return readJson<{ jobs: JobSpec[] }>(jobsPath(root))?.jobs ?? []
}
export type ReviewFinding = {
  id: string
  category: string
  severity: "blocker" | "major" | "minor"
  target: string
  claim: string
  evidence: string
  suggestion: string
  status: "open" | "fixed" | "accepted"
}
export function loadReview(root: string, phase: "design" | "code"): ReviewFinding[] {
  return readJson<{ phases: Record<string, ReviewFinding[]> }>(reviewPath(root))?.phases?.[phase] ?? []
}

/** 表完整名：库名由 分层_业务域_环境 推导。 */
export function tableDb(table: Pick<TableDesign, "layer" | "domain" | "env">): string {
  return `${table.layer}_${table.domain}${table.env}`
}
export function tableFullName(table: Pick<TableDesign, "layer" | "domain" | "env" | "enName">): string {
  return `${tableDb(table)}.${table.enName}`
}

/** 统一解析 库.表:字段 形式。 */
export function parseObjectRef(value: string): { db: string; table: string; column?: string } | null {
  const m = /^([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z][A-Za-z0-9_]*)(?::([A-Za-z][A-Za-z0-9_]*))?$/.exec(value.trim())
  if (!m) return null
  return { db: m[1], table: m[2], column: m[3] }
}
