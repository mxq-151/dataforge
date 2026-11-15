/**
 * data-analysis 的类型常量：通道矩阵、分析类型路由、错误码、门槛与路径。
 *
 * 与 task-diag 的关系：通道身份/`channelKey` 的格式直接复用 `task-diag/lib/constants`
 * （同一套五层标识与幂等键），不在这里另造一份；本文件只声明「分析类型能用哪些通道」。
 */

export const KIT = "data-analysis"
export const STATE_DIR = ".analysisagent"
export const REPORT_DIR = "analysis"
export const REPORT_SUBDIR_PREFIX = "AN-"

/** 分析问题类型：按「分析问题」划分，不按表、不按引擎、不按阶段。 */
export const ANALYSIS_TYPES = [
  "runtime",
  "trend",
  "compare",
  "distribution",
  "integrity",
  "attribution",
  "reconcile",
] as const

export type AnalysisType = (typeof ANALYSIS_TYPES)[number]

/** 每个分析类型对应的子代理（与 agent/*.md 文件名一致）。 */
export const ANALYSIS_ROUTES: Record<AnalysisType, string> = {
  runtime: "ana-runtime",
  trend: "ana-trend",
  compare: "ana-compare",
  distribution: "ana-profile",
  integrity: "ana-profile",
  attribution: "ana-attribution",
  reconcile: "ana-indicator",
}

export type ChannelStatus = "available" | "unmanaged"

export type ChannelSpec = {
  id: string
  label: string
  /** 后端路径；工具不得自拼 URL。 */
  endpoint: string
  method: "GET" | "POST"
  transport: "telemetry" | "metadata"
  /**
   * 契约来源：决定「接口变动时缺口能否被看见」。
   * - `telemetry-v1`：受 telemetry v1 四态外壳约束；
   * - `metadata-readonly`：metadata 侧只读接口，不属于 v1 契约，失败语义按 HTTP 状态区分；
   * - `unmanaged-execution`：执行类端点，未纳管，禁止作为证据通道。
   */
  contract: "telemetry-v1" | "metadata-readonly" | "unmanaged-execution"
  status: ChannelStatus
  /** 不可用/未纳管时缺什么。 */
  requirements: string[]
  /** 允许调用该通道的子代理（所有权矩阵）。 */
  owners: string[]
}

/**
 * 通道清单。
 *
 * 前 8 条是现有 telemetry v1 七类端点（metrics/logs/discovery/snapshot/config/compare/metadata）
 * 与 metadata 侧只读接口；最后一条 `data.query` 是设计文档 B-01 的受控只读查询，
 * 服务端尚未落地，固定为 `unmanaged`：可以出现在能力表里，但不得作为证据通道。
 */
export const CHANNELS: ChannelSpec[] = [
  {
    id: "metrics",
    label: "指标序列",
    endpoint: "/api/telemetry/v1/metrics/query",
    method: "POST",
    transport: "telemetry",
    contract: "telemetry-v1",
    status: "available",
    requirements: [],
    owners: ["ana-runtime", "ana-trend", "ana-compare", "ana-attribution"],
  },
  {
    id: "logs",
    label: "日志",
    endpoint: "/api/telemetry/v1/logs/query",
    method: "POST",
    transport: "telemetry",
    contract: "telemetry-v1",
    status: "available",
    requirements: [],
    owners: ["ana-runtime", "ana-attribution"],
  },
  {
    id: "discovery",
    label: "运行态发现",
    endpoint: "/api/telemetry/v1/discovery/query",
    method: "POST",
    transport: "telemetry",
    contract: "telemetry-v1",
    status: "available",
    requirements: [],
    owners: ["ana-runtime"],
  },
  {
    id: "runtime.snapshot",
    label: "运行态快照",
    endpoint: "/api/telemetry/v1/runtime/snapshot",
    method: "POST",
    transport: "telemetry",
    contract: "telemetry-v1",
    status: "available",
    requirements: [],
    owners: ["ana-runtime", "ana-trend"],
  },
  {
    id: "runtime.config",
    label: "运行态配置",
    endpoint: "/api/telemetry/v1/runtime/config",
    method: "POST",
    transport: "telemetry",
    contract: "telemetry-v1",
    status: "available",
    requirements: [],
    owners: ["ana-runtime", "ana-attribution"],
  },
  {
    id: "runtime.compare",
    label: "运行态差分",
    endpoint: "/api/telemetry/v1/runtime/compare",
    method: "POST",
    transport: "telemetry",
    contract: "telemetry-v1",
    status: "available",
    requirements: [],
    owners: ["ana-trend", "ana-compare"],
  },
  {
    id: "metadata.service",
    label: "服务版本与配置",
    endpoint: "/api/telemetry/v1/metadata/query",
    method: "POST",
    transport: "telemetry",
    contract: "telemetry-v1",
    status: "available",
    requirements: [],
    owners: ["ana-runtime", "ana-attribution"],
  },
  {
    id: "metadata.indicator",
    label: "指标口径",
    endpoint: "/api/metadata/indicators",
    method: "GET",
    transport: "metadata",
    contract: "metadata-readonly",
    status: "available",
    requirements: [],
    owners: ["ana-indicator", "ana-attribution", "ana-profile"],
  },
  {
    id: "metadata.table",
    label: "表详情（列权限/脱敏）",
    endpoint: "/api/metadata/agent/table-detail",
    method: "GET",
    transport: "metadata",
    contract: "metadata-readonly",
    status: "available",
    requirements: [],
    owners: ["ana-profile", "ana-trend", "ana-compare", "ana-attribution", "ana-indicator"],
  },
  {
    id: "metadata.retrieval",
    label: "库表检索",
    endpoint: "/api/agent/retrieval/tables",
    method: "POST",
    transport: "metadata",
    contract: "metadata-readonly",
    status: "available",
    requirements: [],
    owners: ["ana-orchestrator"],
  },
  {
    id: "data.query",
    label: "受控只读查询（B-01）",
    endpoint: "/api/development/execution/execute",
    method: "POST",
    transport: "metadata",
    contract: "unmanaged-execution",
    status: "unmanaged",
    requirements: [
      "B-01: 服务端只读白名单化（单语句 SELECT/WITH、拒绝 DDL/DML/多语句）",
      "B-01: 强制 LIMIT 与最大返回行数",
      "B-01: 查询超时与扫描量上限",
      "B-01: 按表/列鉴权与审计字段",
    ],
    owners: ["ana-profile", "ana-trend", "ana-compare", "ana-attribution"],
  },
]

export function channelById(id: string): ChannelSpec | undefined {
  return CHANNELS.find((channel) => channel.id === id)
}

/** 分析类型需要的通道（决定 scope 授权与能力表）。 */
export const REQUIRED_CHANNELS: Record<AnalysisType, string[]> = {
  runtime: ["logs", "metrics", "discovery", "runtime.snapshot", "runtime.config", "metadata.service"],
  trend: ["metrics", "runtime.snapshot", "runtime.compare", "data.query"],
  compare: ["metrics", "runtime.compare", "data.query"],
  distribution: ["data.query"],
  integrity: ["data.query", "metadata.table"],
  attribution: ["metrics", "logs", "runtime.config", "metadata.indicator", "data.query"],
  reconcile: ["metadata.indicator", "data.query"],
}

/** typed code（A 段，与 D/E/W 段不复用）。 */
export const CODES = {
  TARGET_UNRESOLVED: "A01_TARGET_UNRESOLVED",
  TARGET_AMBIGUOUS: "A02_TARGET_AMBIGUOUS",
  ANALYSIS_TYPE_UNKNOWN: "A03_ANALYSIS_TYPE_UNKNOWN",
  CHANNEL_FORBIDDEN: "A04_CHANNEL_FORBIDDEN",
  BUDGET_EXHAUSTED: "A05_BUDGET_EXHAUSTED",
  SCHEMA_INVALID: "A06_SCHEMA_INVALID",
  WRITE_FORBIDDEN: "A07_WRITE_FORBIDDEN",
  API_UNAVAILABLE: "A08_API_UNAVAILABLE",
  CHANNEL_UNAVAILABLE: "A09_CHANNEL_UNAVAILABLE",
  CHANNEL_UNMANAGED: "A10_CHANNEL_UNMANAGED",
  NOT_IMPLEMENTED: "A11_NOT_IMPLEMENTED",
  VERDICT_INVALID: "A12_VERDICT_INVALID",
  AUTH_DENIED: "A13_AUTH_DENIED",
  INDICATOR_UNAVAILABLE: "A14_INDICATOR_UNAVAILABLE",
  HANDOFF_UNAVAILABLE: "A15_HANDOFF_UNAVAILABLE",
} as const

export const LIMITS = {
  /** 单轮分析最多查询次数（含元数据与遥测调用）。 */
  maxQueries: 12,
  /** 默认返回行数上限。 */
  maxRows: 2_000,
  /** 硬上限：超过直接拒绝，不静默改写。 */
  hardMaxRows: 10_000,
  /** 单次后端调用超时。 */
  apiTimeoutMs: 30_000,
  /** 证据包保留的样本行数上限。 */
  sampleRows: 50,
  /** 工具返回给模型的日志条数上限。 */
  logEntriesReturned: 20,
  /** handoff 文件大小上限。 */
  handoffBytes: 64 * 1024,
} as const

export const LEVELS = ["L1", "L2", "L3", "L4"] as const
export type Level = (typeof LEVELS)[number]

export function levelRank(level: Level): number {
  return LEVELS.indexOf(level)
}

/** 状态目录：`<cwd>/.analysisagent/runs/<runId>/`。 */
export function runDir(root: string, runId: string): string {
  return `${root}/${STATE_DIR}/runs/${runId}`
}

export function scopePath(root: string, runId: string): string {
  return `${runDir(root, runId)}/scope.json`
}

export function capabilitiesPath(root: string, runId: string): string {
  return `${runDir(root, runId)}/capabilities.json`
}

export function budgetPath(root: string, runId: string): string {
  return `${runDir(root, runId)}/budget.json`
}

export function findingsPath(root: string, runId: string): string {
  return `${runDir(root, runId)}/findings.json`
}

/** 产物目录：`<cwd>/analysis/AN-<runId>/`。 */
export function reportDir(root: string, runId: string): string {
  return `${root}/${REPORT_DIR}/${REPORT_SUBDIR_PREFIX}${runId}`
}

export function reportPath(root: string, runId: string): string {
  return `${reportDir(root, runId)}/report.md`
}

export function evidenceDir(root: string, runId: string): string {
  return `${reportDir(root, runId)}/evidence`
}

/**
 * 绑定到某个分析类型的运行必须显式给出类型；未登记类型直接拒绝，不做「按默认值猜」。
 * 这是 A03 的唯一来源。
 */
export function isAnalysisType(value: string): value is AnalysisType {
  return (ANALYSIS_TYPES as readonly string[]).includes(value)
}
