/**
 * task-diag 套件的常量、九引擎画像、预算与错误码。
 *
 * 与其他两套 agentkit 的约定保持一致：
 * - tool / agent / command 前缀统一 `diag-`，错误码用 D 前缀（req-doc 用 E、dw-dev 用 W）；
 * - 运行态放 `.diag/`（req-doc 用 `.work/`、dw-dev 用 `.dw/`），用户级状态由构建清单写到 `.diagagent/`；
 * - 本目录不会被 opencode 注册成工具（扫描只匹配 `{tool,tools}/*.{ts,js}`，非递归）。
 *
 * 事实基线（不得凭印象改）：
 * - 服务端日志层只实现 5 个 serviceType：ds / yarn / spark / flink / file
 *   （modules/logs/model/ServiceType.java），且 file 适配器 supports() 只看 serviceType，
 *   任何 logKind 都接受，但必须命中 logs.sources[file].root-dirs 且默认 enabled=false。
 * - 服务端运行态只实现 spark / flink（modules/runtime/model/MetricFamily.java + application.yml）。
 * - 因此除 spark / flink 外的七个引擎没有专属日志适配器与指标；
 *   它们的通道只能是「file + 运维挂载的进程日志」，属于**条件能力**，默认取不到。
 */
import path from "node:path"

export { nowIso, readJson, readText, updateJson, writeJsonAtomic, writeTextAtomic } from "../../shared/lib/io"

// ── 目录 ────────────────────────────────────────────────────────────────
/** 运行态（目标、能力表、作用域票据、证据包、findings） */
export const DIAG_DIR = ".diag"
/** 产物：给人看的诊断报告 */
export const REPORT_DIR = "diagnosis"
export const REPORT_SUFFIX = "_诊断报告.md"

// ── 引擎 ────────────────────────────────────────────────────────────────
export const ALL_ENGINES = [
  "spark",
  "flink",
  "doris",
  "starrocks",
  "clickhouse",
  "hbase",
  "hudi",
  "kafka",
  "pulsar",
] as const

export type Engine = (typeof ALL_ENGINES)[number]

export function isKnownEngine(engine: string): engine is Engine {
  return (ALL_ENGINES as readonly string[]).includes(engine)
}

export type DiagMode = "FAILED" | "SLOW"
export const DIAG_MODES: readonly DiagMode[] = ["FAILED", "SLOW"]

// ── 结论分级 ────────────────────────────────────────────────────────────
export type Level = "L1" | "L2" | "L3" | "L4"

export const LEVELS: { id: Level; label: string; allowedWording: string; minEvidence: number }[] = [
  { id: "L1", label: "确定", allowedWording: "原因是 …", minEvidence: 1 },
  { id: "L2", label: "高置信", allowedWording: "最可能是 …（证据：A、B）", minEvidence: 2 },
  { id: "L3", label: "推测", allowedWording: "推测 …，依据是 …，未验证 …", minEvidence: 1 },
  { id: "L4", label: "无法定位", allowedWording: "无法定位", minEvidence: 0 },
]

export const LEVEL_RANK: Record<Level, number> = { L1: 1, L2: 2, L3: 3, L4: 4 }

/** 是否允许用该级别下结论：数值越小越确定。 */
export function levelAtMost(level: Level, ceiling: Level): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[ceiling]
}

export type ClampResult = { level: Level; notes: string[] }

/**
 * 结论级别钳制（确定性策略，不交给模型）：
 * 1. category=UNRESOLVED → 强制 L4（调用方还必须把 rootCause 置 null、confidence 置 0）；
 * 2. 比引擎上限更确定 → 降到上限；
 * 3. confidence<0.5 却停在 L1/L2 → 降到 L3。
 */
export function clampVerdict(input: {
  category: string
  level: Level
  confidence: number
  ceiling: Level
}): ClampResult {
  const notes: string[] = []
  let level = input.level

  if (input.category === "UNRESOLVED") {
    if (level !== "L4") notes.push("category=UNRESOLVED，级别强制为 L4")
    return { level: "L4", notes }
  }

  if (LEVEL_RANK[level] < LEVEL_RANK[input.ceiling]) {
    notes.push(`结论级别 ${level} 超过该引擎上限 ${input.ceiling}，已下调为 ${input.ceiling}`)
    level = input.ceiling
  }

  if (input.confidence < 0.5 && (level === "L1" || level === "L2")) {
    notes.push(`置信度 ${input.confidence} < 0.5，不允许使用确定性措辞，已下调为 L3`)
    level = "L3"
  }

  return { level, notes }
}

export const VERDICT_CATEGORIES = [
  "CODE",
  "RESOURCE",
  "DATA",
  "CONFIG",
  "UPSTREAM",
  "ENV",
  "UNRESOLVED",
] as const

export type VerdictCategory = (typeof VERDICT_CATEGORIES)[number]

// ── 通道与引擎画像 ──────────────────────────────────────────────────────
/**
 * 一个通道 = 服务端的 (serviceType, logKind, componentRole) 三元组 + 必需的业务引用键。
 * 字段名与 `LogQueryDTO` 逐字对应，不要改写。
 *
 * `id` 是逻辑名，只用于「降级链」与提示词引用；同一引擎内两个 file 通道三元组可能相同，
 * 靠 ref.path 区分，去重键里包含 ref，因此不会互相覆盖。
 */
export type ChannelSpec = {
  id: string
  serviceType: string
  logKind: string
  componentRole: string
  /** ref 里必须出现的键：applicationId / jobId / taskInstanceId / containerId / appId / path */
  refKey: string
  label: string
  /** 已知限制，必须原样进入能力自述 */
  caveat?: string
  /** 该通道要可用所依赖的配置/运维动作 */
  requires?: string
  /** 默认是否可用（不依赖额外配置） */
  defaultAvailable: boolean
}

export type EngineGap = {
  signal: string
  reason: string
  neededInterface: string
}

/** 证据层级：决定"能下什么结论"，避免假装有作业/执行器级证据。 */
export type EvidenceTier = "job-executor" | "job-vertex-tm" | "process-log" | "none"

export type EngineProfile = {
  engine: Engine
  label: string
  /** 引擎诊断 agent 名 */
  agent: string
  channels: ChannelSpec[]
  /** 服务端可提供的指标族（空表示没有运行态指标） */
  families: string[]
  /** 结论能力上限：任何情况下不得给出比它更确定的级别 */
  ceiling: Level
  /** 上限原因，必须原样写进报告 */
  ceilingReason: string
  evidenceTier: EvidenceTier
  /** 取不到主证据时的降级顺序（元素是通道 id 或 runtime:snapshot / runtime:compare / handoff:spark） */
  degradeChain: string[]
  /** 该引擎的结构性缺口；能力表与 UNRESOLVED 的 neededInterface 都取自这里 */
  gaps: EngineGap[]
  /** 复用其它引擎的证据交接（Hudi 复用 Spark） */
  handoffFrom?: Engine
  /** 环境未部署，仅保留配置层验证路径（StarRocks） */
  configOnly?: boolean
}

const FILE_SOURCE_REQUIRES = "运维配置 logs.sources 中 file 源的 root-dirs 并挂载对应日志目录"

function fileChannel(id: string, label: string, logKind: string, caveat?: string): ChannelSpec {
  return {
    id,
    serviceType: "file",
    logKind,
    componentRole: "generic",
    refKey: "path",
    label,
    caveat,
    requires: FILE_SOURCE_REQUIRES,
    defaultAvailable: false,
  }
}

export const ENGINE_PROFILES: Record<Engine, EngineProfile> = {
  spark: {
    engine: "spark",
    label: "Spark",
    agent: "diag-spark",
    channels: [
      {
        id: "yarn-am",
        serviceType: "yarn",
        logKind: "aggregate",
        componentRole: "application_master",
        refKey: "applicationId",
        label: "YARN 聚合日志 / ApplicationMaster（driver 日志）",
        caveat: "需要 YARN 日志聚合已开启，且服务端主机可执行 yarn CLI",
        requires: "yarn.log-aggregation-enable=true + 服务端可执行 yarn CLI",
        defaultAvailable: true,
      },
      {
        id: "yarn-generic",
        serviceType: "yarn",
        logKind: "aggregate",
        componentRole: "generic",
        refKey: "applicationId",
        label: "YARN 聚合日志 / 通用",
        caveat: "同上",
        requires: "同上",
        defaultAvailable: true,
      },
      {
        id: "yarn-nm",
        serviceType: "yarn",
        logKind: "runtime",
        componentRole: "node_manager",
        refKey: "containerId",
        label: "YARN 运行中容器日志",
        caveat: "容器结束后不可读，只能覆盖正在运行的任务",
        defaultAvailable: true,
      },
      {
        id: "shs-driver",
        serviceType: "spark",
        logKind: "runtime",
        componentRole: "driver",
        refKey: "appId",
        label: "Spark History Server / driver",
        caveat: "SHS 该接口返回事件日志压缩包（二进制），application.yml 中默认 enabled=false",
        requires: "SHS base-url + 该源启用（当前实现仍不适合当日志用）",
        defaultAvailable: false,
      },
      {
        id: "shs-executor",
        serviceType: "spark",
        logKind: "runtime",
        componentRole: "executor",
        refKey: "appId",
        label: "Spark History Server / executor",
        caveat: "同上",
        requires: "同上",
        defaultAvailable: false,
      },
    ],
    families: ["jvm_gc", "throughput", "shuffle", "failures"],
    ceiling: "L1",
    ceilingReason: "拿到 YARN 聚合日志时可按异常类名 + 行号给出 L1；只有指标时上限 L2（stage 级瓶颈）",
    evidenceTier: "job-executor",
    degradeChain: ["yarn-am", "yarn-generic", "runtime:compare", "runtime:snapshot", "yarn-nm", "shs-driver", "shs-executor"],
    gaps: [
      {
        signal: "Spark UI SQL 执行计划",
        reason: "服务端无对应接口",
        neededInterface: "GET /api/runtime/jobs/{appId}/sql-plan（需确认是否必要）",
      },
    ],
  },

  flink: {
    engine: "flink",
    label: "Flink",
    agent: "diag-flink",
    channels: [
      {
        id: "flink-exception",
        serviceType: "flink",
        logKind: "exception",
        componentRole: "job_manager",
        refKey: "jobId",
        label: "Flink 异常摘要（结构化，非原始日志）",
        caveat: "返回作业状态、tasks.failed、numRestarts、checkpoint 摘要与异常列表，不含原始日志行",
        defaultAvailable: true,
      },
      {
        id: "flink-jm-log",
        serviceType: "flink",
        logKind: "runtime",
        componentRole: "job_manager",
        refKey: "jobId",
        label: "Flink JobManager 原始日志",
        caveat: "需要配置 jobmanager-log-dirs，当前默认未配置",
        requires: "logs.sources 中配置 jobmanager-log-dirs",
        defaultAvailable: false,
      },
      {
        id: "flink-tm-log",
        serviceType: "flink",
        logKind: "runtime",
        componentRole: "task_manager",
        refKey: "jobId",
        label: "Flink TaskManager 原始日志",
        caveat: "需要配置 taskmanager-log-dirs，当前默认未配置",
        requires: "logs.sources 中配置 taskmanager-log-dirs",
        defaultAvailable: false,
      },
      {
        id: "flink-tm-stdout",
        serviceType: "flink",
        logKind: "stdout",
        componentRole: "task_manager",
        refKey: "jobId",
        label: "Flink TaskManager stdout",
        caveat: "同上",
        requires: "同上",
        defaultAvailable: false,
      },
    ],
    families: ["jvm_gc", "checkpoint", "throughput", "backpressure", "failures"],
    ceiling: "L1",
    ceilingReason: "异常摘要含作业状态与异常列表时可到 L1/L2；原始日志未配置时不具备行级证据，措辞须注明证据来源是摘要",
    evidenceTier: "job-vertex-tm",
    degradeChain: ["flink-exception", "runtime:snapshot", "runtime:compare", "flink-jm-log", "flink-tm-log", "flink-tm-stdout"],
    gaps: [
      {
        signal: "作业结束后的事后指标",
        reason: "Flink 仅支持 live 指标，JM 停止后不再提供",
        neededInterface: "需 Flink 指标仓库（如 Prometheus 只读查询）接口",
      },
      {
        signal: "Savepoint / 重启历史",
        reason: "服务端无对应接口",
        neededInterface: "GET /api/runtime/jobs/{jobId}/savepoints（需确认）",
      },
    ],
  },

  doris: {
    engine: "doris",
    label: "Doris",
    agent: "diag-doris",
    channels: [
      fileChannel("doris-fe-log", "Doris FE 日志", "runtime", "需挂载 FE 日志目录；无 job/query 级结构化证据"),
      fileChannel("doris-be-log", "Doris BE 日志", "runtime", "需挂载 BE 日志目录"),
      fileChannel("doris-audit", "Doris 审计日志（audit_log）", "audit", "需开启审计插件并挂载输出文件"),
    ],
    families: [],
    ceiling: "L3",
    ceilingReason: "只有进程文本日志，没有作业/查询级结构化证据（无 job、executor、慢查询表），最多 L3 且需注明未验证",
    evidenceTier: "process-log",
    degradeChain: ["doris-fe-log", "doris-be-log", "doris-audit"],
    gaps: [
      {
        signal: "导入失败明细",
        reason: "服务端无 Doris 系统表只读探针",
        neededInterface: "POST /api/diagnosis/probe {probeId:'doris.load_error'}（方案 D4）",
      },
      {
        signal: "慢查询",
        reason: "audit_log 未接入，file 源也需额外挂载",
        neededInterface: "POST /api/diagnosis/probe {probeId:'doris.audit_slow'}（方案 D4）",
      },
      {
        signal: "FE/BE 运行指标",
        reason: "服务端无 Doris 运行态适配器",
        neededInterface: "新增 runtime adapter + MetricCatalog（方案 D1）",
      },
    ],
  },

  starrocks: {
    engine: "starrocks",
    label: "StarRocks",
    agent: "diag-starrocks",
    channels: [
      fileChannel("sr-fe-log", "StarRocks FE 日志", "runtime", "环境未部署，仅保留配置层验证路径"),
      fileChannel("sr-be-log", "StarRocks BE 日志", "runtime", "环境未部署，仅保留配置层验证路径"),
      fileChannel("sr-audit", "StarRocks 审计日志", "audit", "需审计插件；环境未部署"),
    ],
    families: [],
    ceiling: "L4",
    ceilingReason: "环境未部署：没有任何可验证证据，只能给出「无法定位 + 配置层验证路径」",
    evidenceTier: "none",
    degradeChain: ["sr-fe-log", "sr-be-log", "sr-audit"],
    configOnly: true,
    gaps: [
      {
        signal: "全部诊断证据",
        reason: "StarRocks 环境尚未部署，通道定义与 agent 已就绪但无法验证",
        neededInterface: "部署后配置 logs.sources[file] root-dirs；其余同 Doris（probe + runtime adapter）",
      },
      {
        signal: "慢查询 / 导入失败",
        reason: "服务端无 StarRocks 系统表只读探针",
        neededInterface: "POST /api/diagnosis/probe {probeId:'sr.load_error'|'sr.audit_slow'}（方案 D4）",
      },
    ],
  },

  clickhouse: {
    engine: "clickhouse",
    label: "ClickHouse",
    agent: "diag-clickhouse",
    channels: [
      fileChannel("ck-server-log", "ClickHouse server 日志", "runtime", "需挂载 /var/log/clickhouse-server/；无查询级证据"),
      fileChannel("ck-error-log", "ClickHouse server 错误日志", "runtime", "同上"),
    ],
    families: [],
    ceiling: "L3",
    ceilingReason: "只有 server 文本日志；system.query_log / system.parts 未接入，无法给出查询级或分区级确定结论",
    evidenceTier: "process-log",
    degradeChain: ["ck-server-log", "ck-error-log"],
    gaps: [
      {
        signal: "慢查询",
        reason: "system.query_log 未接入（服务端已有 JDBC 系统表读取先例）",
        neededInterface: "POST /api/diagnosis/probe {probeId:'ck.slow_queries'}（方案 D4）",
      },
      {
        signal: "分区/分片体积偏斜",
        reason: "system.parts 未接入诊断接口",
        neededInterface: "POST /api/diagnosis/probe {probeId:'ck.parts_skew'}（方案 D4）",
      },
      {
        signal: "报错增量",
        reason: "system.errors 未接入",
        neededInterface: "POST /api/diagnosis/probe {probeId:'ck.errors'}（方案 D4）",
      },
    ],
  },

  hbase: {
    engine: "hbase",
    label: "HBase",
    agent: "diag-hbase",
    channels: [
      fileChannel("hbase-master-log", "HBase Master 日志", "runtime", "需挂载 Master 日志目录；无 Region/JMX 证据"),
      fileChannel("hbase-rs-log", "HBase RegionServer 日志", "runtime", "需挂载 RS 日志目录"),
    ],
    families: [],
    ceiling: "L3",
    ceilingReason: "只有 Master/RS 文本日志；没有 Region 状态与 JMX 指标，无法断言热点或分裂异常",
    evidenceTier: "process-log",
    degradeChain: ["hbase-rs-log", "hbase-master-log"],
    gaps: [
      {
        signal: "Region 状态与分布",
        reason: "服务端无 HBase Admin 通道（现有 Calcite 查询路径不提供诊断信息）",
        neededInterface: "POST /api/diagnosis/probe {probeId:'hbase.region_state'}（方案 D4）",
      },
      {
        signal: "JMX 运行指标",
        reason: "服务端无 HBase 运行态适配器",
        neededInterface: "新增 runtime adapter + MetricCatalog",
      },
    ],
  },

  hudi: {
    engine: "hudi",
    label: "Hudi",
    agent: "diag-hudi",
    channels: [],
    families: [],
    ceiling: "L3",
    ceilingReason: "Hudi 表域证据（timeline/commit/compaction）无接口；只能借上游 Spark 作业的交接结论，且不得把作业侧结论直接当成 Hudi 侧结论",
    evidenceTier: "none",
    degradeChain: ["handoff:spark"],
    handoffFrom: "spark",
    gaps: [
      {
        signal: "Hudi timeline / commit 元数据",
        reason: "服务端无 Hudi 元数据读取接口",
        neededInterface: "POST /api/diagnosis/probe {probeId:'hudi.timeline'}（方案 D4）",
      },
      {
        signal: "小文件与 compaction 状态",
        reason: "同上",
        neededInterface: "POST /api/diagnosis/probe {probeId:'hudi.compaction_state'}（方案 D4）",
      },
    ],
  },

  kafka: {
    engine: "kafka",
    label: "Kafka",
    agent: "diag-kafka",
    channels: [
      fileChannel("kafka-broker-log", "Kafka broker server.log", "runtime", "需挂载 broker 日志；无 lag/ISR 证据"),
      fileChannel("kafka-controller-log", "Kafka controller 日志", "runtime", "需挂载 controller 日志"),
    ],
    families: [],
    ceiling: "L3",
    ceilingReason: "只有 broker 文本日志；consumer lag、ISR、分区状态都拿不到，无法判断积压类问题",
    evidenceTier: "process-log",
    degradeChain: ["kafka-broker-log", "kafka-controller-log"],
    gaps: [
      {
        signal: "consumer lag",
        reason: "服务端无 Kafka AdminClient（仓库内无 kafka 客户端依赖）",
        neededInterface: "POST /api/diagnosis/stream/probe {probeId:'kafka.consumer_lag'}（方案 D5）",
      },
      {
        signal: "ISR / 副本状态",
        reason: "同上",
        neededInterface: "POST /api/diagnosis/stream/probe {probeId:'kafka.under_replicated'}（方案 D5）",
      },
    ],
  },

  pulsar: {
    engine: "pulsar",
    label: "Pulsar",
    agent: "diag-pulsar",
    channels: [
      fileChannel("pulsar-broker-log", "Pulsar broker 日志", "runtime", "需挂载 broker 日志；服务端对 Pulsar 零支持"),
      fileChannel("pulsar-bk-log", "BookKeeper 日志", "runtime", "需挂载 BK 日志"),
    ],
    families: [],
    ceiling: "L3",
    ceilingReason: "只有进程日志；订阅 backlog、topic stats 全缺，仓库内对 Pulsar 无任何可复用资产",
    evidenceTier: "process-log",
    degradeChain: ["pulsar-broker-log", "pulsar-bk-log"],
    gaps: [
      {
        signal: "订阅 backlog",
        reason: "服务端无 Pulsar Admin 客户端（grep 全仓库零命中）",
        neededInterface: "POST /api/diagnosis/stream/probe {probeId:'pulsar.subscription_backlog'}（方案 D5）",
      },
      {
        signal: "topic 统计",
        reason: "同上",
        neededInterface: "POST /api/diagnosis/stream/probe {probeId:'pulsar.topic_stats'}（方案 D5）",
      },
    ],
  },
}

/** 引擎 → 诊断 subagent。未登记的类型走兜底报告，不参与路由。 */
export const ENGINE_AGENT: Record<string, string> = Object.fromEntries(
  ALL_ENGINES.map((engine) => [engine, ENGINE_PROFILES[engine].agent]),
)

/** 是否已登记引擎画像（决定是否路由到引擎 agent）。 */
export function hasEngineAgent(engine: string): boolean {
  return isKnownEngine(engine) && Boolean(ENGINE_PROFILES[engine])
}

export function profileOf(engine: string): EngineProfile | null {
  return isKnownEngine(engine) ? ENGINE_PROFILES[engine] : null
}

export function channelsOf(engine: string): ChannelSpec[] {
  return profileOf(engine)?.channels ?? []
}

export function channelById(engine: string, id: string): ChannelSpec | null {
  return channelsOf(engine).find((channel) => channel.id === id) ?? null
}

export function channelKeyOf(channel: {
  serviceType: string
  logKind: string
  componentRole: string
  ref?: Record<string, string>
}): string {
  const refPart = Object.entries(channel.ref ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(",")
  return [channel.serviceType, channel.logKind, channel.componentRole, refPart].join("|")
}

/** 通道三元组（不含 ref），用于作用域白名单。 */
export function channelTripleOf(channel: {
  serviceType: string
  logKind: string
  componentRole: string
}): string {
  return [channel.serviceType, channel.logKind, channel.componentRole].join("|")
}

/** 某三元组是否属于其它引擎的通道（用于区分「越权」与「不可用」）。 */
export function ownerEngineOfChannel(triple: string): Engine | null {
  for (const engine of ALL_ENGINES) {
    if (ENGINE_PROFILES[engine].channels.some((channel) => channelTripleOf(channel) === triple)) return engine
  }
  return null
}

// ── 运行态指标族（与服务端 MetricFamily 枚举逐字一致）─────────────────
export const RUNTIME_FAMILIES: Record<string, string[]> = Object.fromEntries(
  ALL_ENGINES.map((engine) => [engine, ENGINE_PROFILES[engine].families]),
)

// ── 预算 ────────────────────────────────────────────────────────────────
/**
 * 所有上限都是硬约束，工具内部自行截断并回报 truncated，不依赖模型自觉。
 * scanBytes / pageBytes 对齐服务端 `logs.access.limits`（256KB / 2000 行）。
 */
export const BUDGET = {
  totalCalls: 20,
  engineCalls: 10,
  collectLogCalls: 6,
  supplementCalls: 4,
  scanBytes: 4 * 1024 * 1024,
  pageBytes: 256 * 1024,
  pageLines: 2000,
  /** 单次工具返回给模型的字节上限 */
  returnBytes: 8 * 1024,
  maxSignatures: 20,
  samplesPerSignature: 3,
  evidenceMaxBytes: 256 * 1024,
  apiTimeoutMs: 8_000,
  resolveScanBytes: 64 * 1024,
} as const

// ── 错误码 ──────────────────────────────────────────────────────────────
export const CODES = {
  TARGET_UNRESOLVED: "D01_TARGET_UNRESOLVED",
  TARGET_AMBIGUOUS: "D02_TARGET_AMBIGUOUS",
  ENGINE_UNSUPPORTED: "D03_ENGINE_UNSUPPORTED",
  SCOPE_DENIED: "D04_SCOPE_DENIED",
  BUDGET_EXHAUSTED: "D05_BUDGET_EXHAUSTED",
  SOURCE_DEGRADED: "D06_SOURCE_DEGRADED",
  SCHEMA: "D07_SCHEMA",
  WRITE_FORBIDDEN: "D08_WRITE_FORBIDDEN",
  API_UNAVAILABLE: "D09_API_UNAVAILABLE",
  CHANNEL_UNAVAILABLE: "D10_CHANNEL_UNAVAILABLE",
  LEVEL_EXCEEDED: "D11_LEVEL_EXCEEDED",
} as const

export type Code = (typeof CODES)[keyof typeof CODES]

// ── 路径 ────────────────────────────────────────────────────────────────
export function runDir(root: string, runId: string): string {
  return path.join(root, DIAG_DIR, "runs", runId)
}

export function runPath(root: string, runId: string, ...parts: string[]): string {
  return path.join(runDir(root, runId), ...parts)
}

export function scopePath(root: string, runId: string): string {
  return runPath(root, runId, "scope.json")
}

export function targetPath(root: string, runId: string): string {
  return runPath(root, runId, "target.json")
}

export function capabilitiesPath(root: string, runId: string): string {
  return runPath(root, runId, "capabilities.json")
}

export function upstreamPath(root: string, runId: string): string {
  return runPath(root, runId, "s0-upstream.json")
}

export function budgetPath(root: string, runId: string): string {
  return runPath(root, runId, "budget.json")
}

export function evidenceDir(root: string, runId: string): string {
  return runPath(root, runId, "evidence")
}

export function findingsPath(root: string, runId: string): string {
  return runPath(root, runId, "findings.json")
}

/** Hudi 等复用型引擎的交接包目录（由上游引擎 agent 产出）。 */
export function handoffDir(root: string, runId: string): string {
  return runPath(root, runId, "handoff")
}

export function handoffPath(root: string, runId: string, fromEngine: string): string {
  return path.join(handoffDir(root, runId), `${fromEngine}.json`)
}

/** 报告文件名：`diagnosis/{yyyy-MM-dd}_{taskName}_{engine}_{mode}`。 */
export function reportBaseName(target: { taskName?: string; engine: string; mode: string }): string {
  const day = new Date().toISOString().slice(0, 10)
  const name = sanitizeName(target.taskName || "未命名任务")
  return `${day}_${name}_${target.engine}_${target.mode}`
}

export function reportPath(root: string, target: { taskName?: string; engine: string; mode: string }): string {
  return path.join(root, REPORT_DIR, `${reportBaseName(target)}${REPORT_SUFFIX}`)
}

/** 文件名安全化：去路径分隔符与控制字符，限长 60。 */
export function sanitizeName(raw: string): string {
  const cleaned = raw
    .replace(/[\\/:*?"<>|\r\n\t]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^_+|_+$/g, "")
  return (cleaned || "未命名任务").slice(0, 60)
}

/** runId：`yyyyMMddTHHmmss-{engine}-{4位随机}`，文件系统安全、可按时间排序。 */
export function newRunId(engine: string): string {
  const iso = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "")
  const rand = Math.random().toString(36).slice(2, 6)
  return `${iso}-${sanitizeName(engine)}-${rand}`
}

/** 判断 runId 是否安全（防止 `..` 穿越到工作区外）。 */
export function isSafeRunId(runId: string): boolean {
  return /^[0-9A-Za-z_-]{6,64}$/.test(runId)
}
