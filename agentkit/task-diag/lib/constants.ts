/**
 * task-diag 套件的常量、九引擎画像、预算与错误码。
 * 与其他两套 agentkit 的约定保持一致：
 * - tool / agent / command 前缀统一 `diag-`，错误码用 D 前缀（req-doc 用 E、dw-dev 用 W）；
 * - 运行态放 `.diag/`（req-doc 用 `.work/`、dw-dev 用 `.dw/`），用户级状态由构建清单写到 `.diagagent/`；
 * - 本目录不会被 opencode 注册成工具（扫描只匹配 `{tool,tools}/*.{ts,js}`，非递归）。
 *
 * 事实基线（不得凭印象改）：
 * - 日志与指标统一走 telemetry v1：`/api/telemetry/v1/logs|metrics|discovery|runtime/*`。
 *   不存在 ds / file 服务类型，也不存在 logs.sources 配置。
 * - 数据标识是「四元组 + 数据类型」：serviceType → componentId → hostId → dataTypeId，
 *   dataTypeId 只有 `log.service`（服务自身日志，local-disk / ES）与 `log.task`（任务日志，YARN 聚合）。
 * - 运行态只有 spark / flink 有指标族（RuntimeEngine）；其它七个引擎只能依赖
 *   「local-disk / ES 的进程日志」，属于**条件能力**，默认取不到。
 */
import path from "node:path"
import { channelIdentityOf } from "../../shared/lib/channel"

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
 * 一个通道 = 后端五层模型的四元组（serviceType → componentId → hostId → dataTypeId）
 * + 日志流（stream）+ 必需的业务引用（ref）。
 *
 * `dataTypeId` 与后端 `LogDataType` 逐字一致：
 * - `log.service`：服务自身运行日志，后端只允许 local-disk / elasticsearch；
 * - `log.task`：在服务上运行的任务日志，后端只允许 yarn，且要求 jobName / jobId 至少一个。
 *
 * `hostId` 默认 `cluster`：Phase 1 没有 host 清单，cluster 表示不绑定单台主机；
 * local-disk 命中多个 host 源时后端返回 HOST_REQUIRED，需要调用方显式指定 hostId。
 *
 * `id` 是逻辑名，只用于「降级链」与提示词引用；去重键由四元组 + stream + ref 组成。
 */
export type LogDataTypeId = "log.service" | "log.task"
export type LogStream = "stdout" | "stderr" | "slowquery"

export type ChannelSpec = {
  id: string
  serviceType: string
  componentId: string
  hostId: string
  dataTypeId: LogDataTypeId
  stream: LogStream
  /** ref 里必须出现的键：applicationId / jobId / taskInstanceId */
  refKey?: string
  /** 多选一必填：log.task 为 jobName / jobId */
  requiredAnyRefs?: string[]
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

/** Phase 1 的 host 占位值，与后端 `Target.CLUSTER_HOST` 逐字一致。 */
export const CLUSTER_HOST = "cluster"

const SERVICE_LOG_REQUIRES =
  "运维配置 telemetry.backends.local-disk[].sources 或 elasticsearch 索引，并挂载/采集对应日志"
const TASK_LOG_REQUIRES =
  "开启 YARN 日志聚合并配置 telemetry.backends.yarn[]（rm-base-url / command）"

/** 服务自身运行日志（log.service）：local-disk / elasticsearch。 */
function serviceChannel(input: {
  id: string
  serviceType: string
  componentId: string
  stream: LogStream
  label: string
  refKey?: string
  caveat?: string
  requires?: string
}): ChannelSpec {
  return {
    ...input,
    hostId: CLUSTER_HOST,
    dataTypeId: "log.service",
    requires: input.requires ?? SERVICE_LOG_REQUIRES,
    defaultAvailable: false,
  }
}

/** 任务日志（log.task）：YARN 聚合日志，要求 jobName / jobId 至少一个。 */
function taskChannel(input: {
  id: string
  serviceType: string
  componentId: string
  stream: "stdout" | "stderr"
  label: string
  refKey?: string
  caveat?: string
  requires?: string
}): ChannelSpec {
  return {
    ...input,
    hostId: CLUSTER_HOST,
    dataTypeId: "log.task",
    requiredAnyRefs: ["jobName", "jobId"],
    requires: input.requires ?? TASK_LOG_REQUIRES,
    defaultAvailable: false,
  }
}

export const ENGINE_PROFILES: Record<Engine, EngineProfile> = {
  spark: {
    engine: "spark",
    label: "Spark",
    agent: "diag-spark",
    channels: [
      taskChannel({
        id: "yarn-am",
        serviceType: "spark",
        componentId: "spark.driver",
        stream: "stdout",
        refKey: "applicationId",
        label: "YARN 聚合日志 / stdout（AM + executor）",
        caveat: "需要 YARN 日志聚合已开启，且服务端主机可执行 yarn CLI",
      }),
      taskChannel({
        id: "yarn-generic",
        serviceType: "spark",
        componentId: "spark.driver",
        stream: "stderr",
        refKey: "applicationId",
        label: "YARN 聚合日志 / stderr（AM + executor）",
        caveat: "同上",
      }),
      serviceChannel({
        id: "spark-driver-log",
        serviceType: "spark",
        componentId: "spark.driver",
        stream: "stdout",
        refKey: "applicationId",
        label: "Spark driver 服务日志（local-disk / ES）",
        caveat: "需要把 driver 文本日志接入 local-disk 或 Elasticsearch",
      }),
      serviceChannel({
        id: "spark-executor-log",
        serviceType: "spark",
        componentId: "spark.executor",
        stream: "stderr",
        refKey: "applicationId",
        label: "Spark executor 服务日志（local-disk / ES）",
        caveat: "需要把 executor 文本日志接入 local-disk 或 Elasticsearch",
      }),
    ],
    families: ["jvm_gc", "throughput", "shuffle", "failures"],
    ceiling: "L1",
    ceilingReason: "拿到 YARN 聚合日志时可按异常类名 + 行号给出 L1；只有指标时上限 L2（stage 级瓶颈）",
    evidenceTier: "job-executor",
    degradeChain: [
      "yarn-am",
      "yarn-generic",
      "runtime:compare",
      "runtime:snapshot",
      "spark-driver-log",
      "spark-executor-log",
    ],
    gaps: [
      {
        signal: "Spark UI SQL 执行计划",
        reason: "v1 runtime 未覆盖 SQL 执行计划",
        neededInterface: "需要后端新增 SQL 执行计划查询接口（v1 runtime 未覆盖）",
      },
      {
        signal: "运行中容器日志（未聚合）",
        reason: "v1 的 yarn 后端只读聚合日志，NodeManager 本地未聚合文件没有 HTTP 接口",
        neededInterface: "开启 YARN 日志聚合，或把容器日志接入 telemetry.backends.local-disk / elasticsearch",
      },
      {
        signal: "Spark SHS 文本日志",
        reason: "SHS 的 /logs 返回事件日志 zip（二进制），v1 明确不作为 stdout/stderr",
        neededInterface: "用 local-disk / elasticsearch 采集 driver/executor 文本日志",
      },
    ],
  },

  flink: {
    engine: "flink",
    label: "Flink",
    agent: "diag-flink",
    channels: [
      serviceChannel({
        id: "flink-jm-log",
        serviceType: "flink",
        componentId: "flink.jobmanager",
        stream: "stdout",
        refKey: "jobId",
        label: "Flink JobManager 服务日志（local-disk / ES）",
        caveat: "需要把 JM 文本日志接入 local-disk 或 Elasticsearch",
      }),
      serviceChannel({
        id: "flink-tm-log",
        serviceType: "flink",
        componentId: "flink.taskmanager",
        stream: "stderr",
        refKey: "jobId",
        label: "Flink TaskManager stderr（local-disk / ES）",
        caveat: "需要把 TM 文本日志接入 local-disk 或 Elasticsearch",
      }),
      serviceChannel({
        id: "flink-tm-stdout",
        serviceType: "flink",
        componentId: "flink.taskmanager",
        stream: "stdout",
        refKey: "jobId",
        label: "Flink TaskManager stdout（local-disk / ES）",
        caveat: "同上",
      }),
      taskChannel({
        id: "flink-task-log",
        serviceType: "flink",
        componentId: "flink.jobmanager",
        stream: "stdout",
        label: "YARN 聚合日志 / Flink 任务 stdout",
        caveat: "YARN 聚合日志没有统一行首时间戳，不支持时间范围过滤",
      }),
    ],
    families: ["jvm_gc", "checkpoint", "throughput", "backpressure", "failures"],
    ceiling: "L1",
    ceilingReason:
      "checkpoint / 背压 / 失败任务等结构化快照可到 L1/L2；异常摘要在 v1 只有目录声明（engineEvidence），原始日志未配置时不具备行级证据",
    evidenceTier: "job-vertex-tm",
    degradeChain: [
      "runtime:snapshot",
      "runtime:compare",
      "flink-jm-log",
      "flink-tm-log",
      "flink-tm-stdout",
      "flink-task-log",
    ],
    gaps: [
      {
        signal: "作业结束后的事后指标",
        reason: "Flink 仅支持 live 指标，JM 停止后不再提供",
        neededInterface: "需 Flink 指标仓库（如 Prometheus 只读查询）接口",
      },
      {
        signal: "Savepoint / 重启历史",
        reason: "v1 runtime 未覆盖 savepoint",
        neededInterface: "需要后端新增 savepoint 查询接口（v1 runtime 未覆盖）",
      },
      {
        signal: "Flink 异常摘要",
        reason: "v1 只在目录 engineEvidence 声明 exception_summary，没有查询端点",
        neededInterface: "新增 engineEvidence 查询接口，或把异常摘要并入 runtime/snapshot",
      },
    ],
  },

  doris: {
    engine: "doris",
    label: "Doris",
    agent: "diag-doris",
    channels: [
      serviceChannel({
        id: "doris-fe-log",
        serviceType: "doris",
        componentId: "doris.fe",
        stream: "stdout",
        label: "Doris FE 服务日志",
        caveat: "需挂载/采集 FE 日志；无 job/query 级结构化证据",
      }),
      serviceChannel({
        id: "doris-be-log",
        serviceType: "doris",
        componentId: "doris.be",
        stream: "stdout",
        label: "Doris BE 服务日志",
        caveat: "需挂载/采集 BE 日志目录",
      }),
      serviceChannel({
        id: "doris-audit",
        serviceType: "doris",
        componentId: "doris.fe",
        stream: "slowquery",
        label: "Doris 审计日志（audit_log / slowquery）",
        caveat: "目录已声明 declared_not_implemented，查询返回 NOT_IMPLEMENTED + requirements",
        requires: "开启 Doris 审计插件、配置慢查询阈值与审计日志路径",
      }),
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
        reason: "audit_log 未接入，local-disk / ES 也需额外配置 slowquery 源",
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
      serviceChannel({
        id: "sr-fe-log",
        serviceType: "starrocks",
        componentId: "starrocks.fe",
        stream: "stdout",
        label: "StarRocks FE 服务日志",
        caveat: "环境未部署，仅保留配置层验证路径",
      }),
      serviceChannel({
        id: "sr-be-log",
        serviceType: "starrocks",
        componentId: "starrocks.be",
        stream: "stdout",
        label: "StarRocks BE 服务日志",
        caveat: "环境未部署，仅保留配置层验证路径",
      }),
      serviceChannel({
        id: "sr-audit",
        serviceType: "starrocks",
        componentId: "starrocks.fe",
        stream: "slowquery",
        label: "StarRocks 审计日志（slowquery）",
        caveat: "目录已声明 declared_not_implemented；环境未部署",
        requires: "开启 StarRocks 审计日志、配置慢查询阈值与审计日志路径",
      }),
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
        neededInterface:
          "部署后配置 telemetry.backends.local-disk[].sources 或 elasticsearch；其余同 Doris（probe + runtime adapter）",
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
      serviceChannel({
        id: "ck-server-log",
        serviceType: "clickhouse",
        componentId: "clickhouse.server",
        stream: "stdout",
        label: "ClickHouse server 日志",
        caveat: "需挂载 /var/log/clickhouse-server/；无查询级证据",
      }),
      serviceChannel({
        id: "ck-error-log",
        serviceType: "clickhouse",
        componentId: "clickhouse.server",
        stream: "stderr",
        label: "ClickHouse server 错误日志",
        caveat: "同上",
      }),
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
      serviceChannel({
        id: "hbase-master-log",
        serviceType: "hbase",
        componentId: "hbase.master",
        stream: "stdout",
        label: "HBase Master 服务日志",
        caveat: "需挂载/采集 Master 日志；无 Region/JMX 证据",
      }),
      serviceChannel({
        id: "hbase-rs-log",
        serviceType: "hbase",
        componentId: "hbase.regionserver",
        stream: "stdout",
        label: "HBase RegionServer 服务日志",
        caveat: "需挂载/采集 RegionServer 日志",
      }),
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
      serviceChannel({
        id: "kafka-broker-log",
        serviceType: "kafka",
        componentId: "kafka.broker",
        stream: "stdout",
        label: "Kafka broker server.log",
        caveat: "需挂载/采集 broker 日志；无 lag/ISR 证据",
      }),
      serviceChannel({
        id: "kafka-controller-log",
        serviceType: "kafka",
        componentId: "kafka.controller",
        stream: "stdout",
        label: "Kafka controller 日志",
        caveat: "需挂载/采集 controller 日志",
      }),
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
      serviceChannel({
        id: "pulsar-broker-log",
        serviceType: "pulsar",
        componentId: "pulsar.broker",
        stream: "stdout",
        label: "Pulsar broker 服务日志",
        caveat: "需挂载/采集 broker 日志；v1 未提供 Pulsar 管理接口",
      }),
      serviceChannel({
        id: "pulsar-bk-log",
        serviceType: "pulsar",
        componentId: "pulsar.bookkeeper",
        stream: "stdout",
        label: "BookKeeper 服务日志",
        caveat: "需挂载/采集 BK 日志",
      }),
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

/**
 * 通道身份与幂等键已下沉到 shared：task-diag 与 data-analysis 必须使用同一份格式。
 * 这里保留 re-export，保证既有 import 路径与行为不变。
 */
export { channelKeyOf, channelIdentityOf, type ChannelIdentity } from "../../shared/lib/channel"

/** 某通道身份是否属于其它引擎（用于区分「越权」与「不可用」）。 */
export function ownerEngineOfChannel(identity: string): Engine | null {
  for (const engine of ALL_ENGINES) {
    if (ENGINE_PROFILES[engine].channels.some((channel) => channelIdentityOf(channel) === identity)) return engine
  }
  return null
}

/** 更新目标默认组件：运行态端点只覆盖 spark / flink。 */
export const RUNTIME_COMPONENTS: Record<string, string> = {
  spark: "spark.driver",
  flink: "flink.jobmanager",
}

/** 构造后端 `Target` 四层身份；hostId 缺省用通道默认值。 */
export function backendTargetOf(channel: ChannelIdentity, hostId?: string) {
  return {
    serviceType: channel.serviceType,
    componentId: channel.componentId,
    hostId: hostId?.trim() || channel.hostId || CLUSTER_HOST,
  }
}

export function runtimeTargetOf(engine: string, hostId = CLUSTER_HOST) {
  const componentId = RUNTIME_COMPONENTS[engine]
  if (!componentId) return null
  return { serviceType: engine, componentId, hostId }
}

/**
 * ref 是否满足通道要求。
 *
 * `jobId` 允许由 applicationId / appId 代偿（Spark 的作业标识就是 YARN application id）；
 * `jobName` 允许由 target.taskName 代偿。log.task 要求两者至少一个。
 */
export function channelRefStatus(
  channel: Pick<ChannelSpec, "refKey" | "requiredAnyRefs">,
  refs: Record<string, string>,
  taskName?: string,
): { ok: boolean; missing: string[] } {
  const missing: string[] = []
  const has = (key: string): boolean => {
    if (key === "jobId") return Boolean(refs.jobId || refs.applicationId || refs.appId)
    if (key === "jobName") return Boolean(refs.jobName || taskName)
    return Boolean(refs[key])
  }

  if (channel.refKey && !has(channel.refKey)) missing.push(`ref.${channel.refKey}`)
  if (channel.requiredAnyRefs && channel.requiredAnyRefs.length > 0) {
    if (!channel.requiredAnyRefs.some(has)) {
      missing.push(channel.requiredAnyRefs.map((key) => `ref.${key}`).join(" / "))
    }
  }
  return { ok: missing.length === 0, missing }
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
