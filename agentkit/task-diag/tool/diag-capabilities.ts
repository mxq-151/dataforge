/**
 * S1 能力画像 + S1.8 建立运行作用域（写 scope 票据）。
 *
 * 唯一事实源改为 telemetry v1：
 * - `POST /api/telemetry/v1/metrics/query`（mode=catalog）给出「数据类型 × 支持的后端」；
 * - `POST /api/telemetry/v1/discovery/query`（scope=sources）给出运行态实例是否配置了 base-url。
 *
 * 能力判定必须返回 typed code + `requirements[]`：不可用时只写「缺少能力」不算完成，
 * 必须给出要补的配置键或接口。目录里的 local-disk / elasticsearch / yarn 是 host 无关的
 * 后端声明，这里不拿诊断目标的 cluster 去比较，否则各引擎会被永久判成不可用。
 */
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import {
  BUDGET,
  CODES,
  ENGINE_PROFILES,
  backendTargetOf,
  channelRefStatus,
  newRunId,
  profileOf,
  runtimeTargetOf,
  targetPath,
  capabilitiesPath,
  type ChannelSpec,
} from "../lib/constants"
import { toolError, toolFail, toolOk } from "../lib/http"
import {
  failureOf,
  requirementTexts,
  telemetryQuery,
  type CatalogData,
  type ComponentCatalogEntryView,
  type DiscoveryData,
  type LogData,
  type LogStreamDefinitionView,
} from "../lib/telemetry"
import { initBudget } from "../lib/budget"
import { buildScope, saveScope, assertWorkspace } from "../lib/scope"
import { writeJsonAtomic, nowIso } from "../lib/constants"
import { CapabilityReportSchema, TargetSchema, type EngineCapability, type Signal, type Target } from "../lib/schema"

const CATALOG_PATH = "/api/telemetry/v1/metrics/query"
const DISCOVERY_PATH = "/api/telemetry/v1/discovery/query"

function runtimeConfigKey(engine: string): string {
  return engine === "spark" ? "telemetry.backends.spark-rest[]" : "telemetry.backends.flink-rest[]"
}

export default tool({
  description:
    "S1：生成引擎能力画像并建立本次运行的作用域票据（scope.json）。一次调用完成：读 v1 目录 → 判断每条通道可用性（typed code + requirements[]）→ 落 capabilities.json / target.json / scope.json / budget.json → 返回 runId。编排器必须先把 runId 交给对应引擎 agent。",
  args: {
    engine: z.string().min(1).describe("引擎类型：spark / flink / doris / starrocks / clickhouse / hbase / hudi / kafka / pulsar"),
    mode: z.enum(["FAILED", "SLOW"]).describe("诊断类型"),
    cluster: z.string().optional().describe("集群名，默认 default"),
    runId: z.string().optional().describe("已存在的 runId；不传则新建"),
    target: z
      .object({
        taskInstanceId: z.string().optional(),
        applicationId: z.string().optional(),
        jobId: z.string().optional(),
        taskName: z.string().optional(),
        deployMode: z.enum(["cluster", "client", "unknown"]).optional(),
        timeRange: z.object({ start: z.string().optional(), end: z.string().optional() }).optional(),
      })
      .optional()
      .describe("S0 解析出的目标；缺省时从 refs 推导"),
  },
  async execute(args, context) {
    try {
      assertWorkspace(context.directory)
      const root = context.directory
      const cluster = args.cluster || "default"
      const profile = profileOf(args.engine)
      if (!profile) {
        return toolFail(CODES.ENGINE_UNSUPPORTED, `未登记的引擎类型：${args.engine}。请走兜底报告（diag_unsupported_report）。`)
      }

      const refs: Record<string, string> = {
        ...(args.target?.applicationId ? { applicationId: args.target.applicationId, appId: args.target.applicationId } : {}),
        ...(args.target?.jobId ? { jobId: args.target.jobId } : {}),
        ...(args.target?.taskInstanceId ? { taskInstanceId: args.target.taskInstanceId } : {}),
      }
      const taskName = args.target?.taskName

      const problems: string[] = []
      let components: ComponentCatalogEntryView[] = []
      let catalogVersion = ""
      let catalogFailure: ReturnType<typeof failureOf> = null

      try {
        const response = await telemetryQuery<CatalogData>(
          CATALOG_PATH,
          { mode: "catalog", target: { serviceType: args.engine } },
          BUDGET.apiTimeoutMs,
        )
        catalogFailure = failureOf(response)
        if (catalogFailure) {
          problems.push(`v1 目录读取失败：${catalogFailure.code} ${catalogFailure.message}`)
        } else {
          components = response.data?.components ?? []
          catalogVersion = response.data?.catalogVersion ?? ""
        }
      } catch (error) {
        problems.push(`v1 目录调用失败：${error instanceof Error ? error.message : String(error)}`)
      }

      const signals: Signal[] = []
      const availableChannelIds: string[] = []
      const unavailable: { id: string; reason: string }[] = []

      for (const channel of profile.channels) {
        const evaluated = await evaluateLogChannel(channel, components, refs, taskName, catalogFailure)
        signals.push(evaluated.signal)
        if (evaluated.signal.status === "available") availableChannelIds.push(channel.id)
        else unavailable.push({ id: channel.id, reason: evaluated.signal.reason ?? "能力表判定不可用" })
      }

      // 运行态：只有画像里声明了指标族才有意义（当前为 spark / flink）。
      let runtimeAvailable = false
      if (profile.families.length > 0) {
        const target = runtimeTargetOf(args.engine)
        if (!target) {
          signals.push({
            signal: "runtime.snapshot",
            status: "unavailable",
            via: "/api/telemetry/v1/runtime/snapshot",
            reason: `v1 runtime 只覆盖 spark / flink，不支持 ${args.engine}`,
            code: "NOT_SUPPORTED",
            requirements: ["需要后端新增该引擎的 RuntimeEngine 实现"],
          })
        } else {
          const discovery = await readDiscovery(args.engine, target, problems)
          const source = discovery?.sources?.[0]
          if (!source) {
            signals.push({
              signal: "runtime.snapshot",
              status: "unavailable",
              via: "/api/telemetry/v1/runtime/snapshot",
              reason: discovery ? `未配置 ${args.engine} 运行时引擎` : "运行态发现接口不可用",
              code: discovery ? "NOT_CONFIGURED" : "SOURCE_DEGRADED",
              requirements: discovery
                ? [`${runtimeConfigKey(args.engine)}: 配置引擎 REST 地址`]
                : ["确认 dataforge-server 已启动且 /api/telemetry/v1/discovery/query 可访问"],
            })
          } else if (source.baseUrlConfigured === false) {
            signals.push({
              signal: "runtime.snapshot",
              status: "unavailable",
              via: "/api/telemetry/v1/runtime/snapshot",
              reason: `运行时实例 ${source.backendId ?? ""} 未配置 base-url`,
              code: "NOT_CONFIGURED",
              detail: `backendId=${source.backendId ?? ""}`,
              requirements: [`${runtimeConfigKey(args.engine)}: 配置 base-url 与认证`],
            })
          } else {
            runtimeAvailable = true
            const supported = new Set(source.supportedFamilies ?? [])
            const unavailableFamilies = source.unavailableFamilies ?? {}
            signals.push({
              signal: "runtime.snapshot",
              status: "available",
              via: "/api/telemetry/v1/runtime/snapshot",
              detail: `backendId=${source.backendId ?? ""} mode=${source.mode ?? ""}`,
              requirements: [],
            })
            for (const family of profile.families) {
              const unsupported = unavailableFamilies[family]
              const definitions = components
                .filter((entry) => entry.serviceType === args.engine)
                .flatMap((entry) => entry.metrics ?? [])
                .filter((metric) => familyOfMetric(metric.name) === family)
              if (unsupported) {
                signals.push({
                  signal: `runtime.${family}`,
                  status: "unavailable",
                  via: "/api/telemetry/v1/runtime/snapshot",
                  reason: unsupported,
                  code: "NOT_SUPPORTED",
                  requirements: [`该引擎不提供 ${family} 指标族；不要用其他族的指标替代`],
                })
                continue
              }
              const familySupported = supported.size === 0 || supported.has(family)
              signals.push({
                signal: `runtime.${family}`,
                status: !familySupported ? "unavailable" : definitions.length === 0 ? "unverified" : "available",
                via: "/api/telemetry/v1/runtime/snapshot",
                verified: definitions.length > 0 && definitions.every((metric) => metric.verified !== false),
                code: familySupported ? undefined : "NOT_SUPPORTED",
                detail:
                  definitions.length === 0
                    ? "目录里没有该族的指标定义，取数时可能缺席（不等于 0）"
                    : `${definitions.length} 个指标定义`,
                requirements: familySupported
                  ? []
                  : [`${runtimeConfigKey(args.engine)}: 开启 ${family} 指标族或升级引擎版本`],
              })
            }
          }
        }
      }

      const availableSignals = signals.filter((signal) => signal.status === "available").length
      let diagnosable: EngineCapability["diagnosable"]
      if (availableSignals === 0) diagnosable = "none"
      else if (runtimeAvailable && availableChannelIds.length > 0) diagnosable = "full"
      else diagnosable = "partial"

      const runId = args.runId || newRunId(args.engine)

      const targetCandidate: Partial<Target> = {
        engine: args.engine,
        cluster,
        taskName,
        deployMode: args.target?.deployMode ?? "unknown",
        taskInstanceId: args.target?.taskInstanceId,
        applicationId: args.target?.applicationId,
        appId: args.target?.applicationId,
        jobId: args.target?.jobId,
        ref: refs,
        timeRange: args.target?.timeRange,
      }
      const target = TargetSchema.parse(targetCandidate)

      const scope = buildScope({
        runId,
        engine: args.engine,
        mode: args.mode,
        target,
        availableChannelIds,
        unavailable,
        calls: BUDGET.engineCalls,
      })

      const capability: EngineCapability = {
        engine: args.engine,
        cluster,
        diagnosable,
        signals,
        diagnosisTypes: ["FAILED", "SLOW"],
        limits: { maxLines: BUDGET.pageLines, maxBytes: BUDGET.pageBytes, maxComponents: 100, maxVertices: 20 },
      }

      const report = CapabilityReportSchema.parse({
        runId,
        generatedAt: nowIso(),
        engines: [capability],
        degraded: problems.length > 0,
      })

      writeJsonAtomic(targetPath(root, runId), target)
      writeJsonAtomic(capabilitiesPath(root, runId), report)
      saveScope(root, scope)
      initBudget(root, runId, { calls: BUDGET.engineCalls, bytes: BUDGET.scanBytes })

      return toolOk({
        runId,
        engine: args.engine,
        engineLabel: profile.label,
        catalogVersion,
        diagnosable,
        scopeNote:
          diagnosable === "none"
            ? "没有任何可用通道：引擎 agent 只能输出 UNRESOLVED 与缺口清单，不得给出归因。"
            : availableChannelIds.length === 0
              ? "没有可用的日志通道；只能使用 runtime:snapshot / runtime:compare，禁止编造日志证据。"
              : "允许通道已写入 scope.json；引擎 agent 只能调用已授权的通道。",
        ceiling: profile.ceiling,
        ceilingReason: profile.ceilingReason,
        evidenceTier: profile.evidenceTier,
        degradeChain: profile.degradeChain,
        configOnly: profile.configOnly ?? false,
        handoffFrom: profile.handoffFrom ?? null,
        allowedChannelIds: availableChannelIds,
        unavailableChannels: unavailable,
        signals: signals.slice(0, 30),
        gaps: profile.gaps,
        problems,
        nextAction:
          diagnosable === "none" || availableChannelIds.length === 0
            ? profile.configOnly
              ? "该引擎环境未部署：只输出「无法定位 + 配置层验证路径」。"
              : runtimeAvailable
                ? "派发引擎 agent：只使用 runtime:snapshot / runtime:compare；日志缺口写进 gaps，不得编造。"
                : "无可用通道：输出 UNRESOLVED + neededInterface，不要假装有作业级证据。"
            : "派发引擎 agent（runId 必传）。",
        scopeChannels: scope.allowedChannels.map((item) =>
          [item.serviceType, item.componentId, item.hostId, item.dataTypeId, item.stream].join("|"),
        ),
        agent: ENGINE_PROFILES[args.engine as keyof typeof ENGINE_PROFILES]?.agent ?? null,
      })
    } catch (error) {
      return toolError(error)
    }
  },
})

type LogChannelEvaluation = {
  signal: Signal
}

async function evaluateLogChannel(
  channel: ChannelSpec,
  components: ComponentCatalogEntryView[],
  refs: Record<string, string>,
  taskName: string | undefined,
  catalogFailure: ReturnType<typeof failureOf>,
): Promise<LogChannelEvaluation> {
  const base = {
    signal: channel.id,
    dataTypeId: channel.dataTypeId,
    stream: channel.stream,
    need: channel.caveat,
  }

  if (catalogFailure) {
    return {
      signal: {
        ...base,
        status: "unavailable",
        reason: `v1 目录不可用：${catalogFailure.code}`,
        code: "SOURCE_DEGRADED",
        requirements: ["确认 dataforge-server 已启动且 /api/telemetry/v1/metrics/query（mode=catalog）可访问"],
      },
    }
  }

  const entry = components.find(
    (item) => item.serviceType === channel.serviceType && item.componentId === channel.componentId,
  )
  if (!entry) {
    return {
      signal: {
        ...base,
        status: "unavailable",
        reason: `目录未纳入 ${channel.serviceType}/${channel.componentId}`,
        code: "NOT_CONFIGURED",
        requirements: [`在 SeedCatalogContributor / 自定义目录中声明 ${channel.serviceType}/${channel.componentId}`],
      },
    }
  }

  const definition = findStream(entry, channel)
  if (!definition) {
    return {
      signal: {
        ...base,
        status: "unavailable",
        reason: `目录未声明 ${channel.dataTypeId}/${channel.stream}`,
        code: "DATA_TYPE_NOT_IMPLEMENTED",
        requirements: [`目录补充 ${channel.componentId} 的 ${channel.dataTypeId}/${channel.stream} 定义`],
      },
    }
  }

  const backends = definition.supportedBackends ?? []
  const implemented = backends.filter((backend) => backend.status === "implemented")
  const declared = backends.filter((backend) => backend.status === "declared_not_implemented")
  if (implemented.length === 0) {
    const requirements = [
      ...requirementTexts({ requirements: definition.requirements }),
      ...declared.map((backend) => `${backend.backendType ?? backend.backendId}: ${backend.notes ?? "尚未实现"}`),
    ]
    return {
      signal: {
        ...base,
        status: "unavailable",
        reason:
          declared.length > 0
            ? `${channel.dataTypeId}/${channel.stream} 已声明但尚未实现`
            : `没有可用的日志后端：${channel.dataTypeId}/${channel.stream}`,
        code: declared.length > 0 ? "DATA_TYPE_NOT_IMPLEMENTED" : "NOT_CONFIGURED",
        detail: `backends=${backends.map((backend) => `${backend.backendType ?? backend.backendId}:${backend.status ?? ""}`).join(",")}`,
        requirements: requirements.length > 0 ? requirements : ["配置 telemetry.backends 中对应的日志后端"],
      },
    }
  }

  const refStatus = channelRefStatus(channel, refs, taskName)
  if (!refStatus.ok) {
    return {
      signal: {
        ...base,
        status: "unavailable",
        reason: `缺少业务引用：${refStatus.missing.join("、")}`,
        code: "INVALID_ARGUMENT",
        requirements: refStatus.missing.map((item) => `${item}: 从任务详情或 S0 解析结果补齐`),
      },
    }
  }

  // v1 目录只声明「哪些后端类型支持该数据类型」，不暴露实例是否真的配置。
  // 用一次 64 字节、哨兵关键词的最小查询做配置探测：配置了 → ok（通常 empty），
  // 没配置 → NOT_CONFIGURED + 配置键。这样能力表不会把「目录支持」误报成「本环境可用」。
  const probe = await probeBackend(channel, refs, taskName, base)
  if (probe) return probe

  return {
    signal: {
      ...base,
      status: "available",
      via: "/api/telemetry/v1/logs/query",
      detail: `backends=${implemented.map((backend) => backend.backendType ?? backend.backendId).join(",")}（配置探测通过）`,
      requirements: [],
    },
  }
}

async function probeBackend(
  channel: ChannelSpec,
  refs: Record<string, string>,
  taskName: string | undefined,
  base: { signal: string; dataTypeId: string; stream: string; need: string | undefined },
): Promise<LogChannelEvaluation | null> {
  const probeRef = probeRefOf(channel, refs, taskName)
  if (channel.dataTypeId === "log.task" && !probeRef.taskId && !probeRef.jobName) return null

  try {
    const response = await telemetryQuery<LogData>(
      "/api/telemetry/v1/logs/query",
      {
        mode: "data",
        dataType: channel.dataTypeId,
        stream: channel.stream,
        target: backendTargetOf(channel),
        ref: probeRef,
        keywords: ["__df_capability_probe__"],
        limit: 1,
        maxBytes: 64,
        includeBackendCandidates: true,
      },
      BUDGET.apiTimeoutMs,
    )
    const failure = failureOf(response)
    if (!failure) return null
    return {
      signal: {
        ...base,
        status: failure.outcome === "failed" ? "unverified" : "unavailable",
        reason: `${failure.code}: ${failure.message}`,
        code: failure.code,
        detail: `跳过：${(failure.backend?.skipped ?? []).map((item) => `${item.backendType ?? item.backendId}:${item.code ?? ""}`).join(",") || "无"}`,
        requirements: failure.requirements,
      },
    }
  } catch (error) {
    return {
      signal: {
        ...base,
        status: "unverified",
        reason: `配置探测失败：${error instanceof Error ? error.message : String(error)}`,
        code: "PROBE_FAILED",
        requirements: ["确认 dataforge-server 已启动且 /api/telemetry/v1/logs/query 可访问"],
      },
    }
  }
}

/** log.task 的探测 ref 按后端语义映射：Spark 用 applicationId 当 taskId，Flink 用任务名当 jobName。 */
function probeRefOf(
  channel: ChannelSpec,
  refs: Record<string, string>,
  taskName?: string,
): Record<string, string> {
  if (channel.dataTypeId !== "log.task") return { ...refs }
  const applicationId = refs.applicationId || refs.appId
  const jobIdAsApp = refs.jobId && /^application_\d+_\d+$/.test(refs.jobId) ? refs.jobId : undefined
  const taskId = refs.taskId || applicationId || jobIdAsApp
  const jobName = refs.jobName || taskName
  return {
    ...(taskId ? { taskId } : {}),
    ...(jobName ? { jobName } : {}),
  }
}

/** 与后端 RuntimeFamilies.familyOf 逐字对齐：目录不提供 family 字段，只能按指标名前缀/关键词归类。 */
function familyOfMetric(metricName: string): string {
  const lower = metricName.toLowerCase()
  if (lower.startsWith("jvm_") || lower.startsWith("jvm.")) return "jvm_gc"
  if (lower.includes("checkpoint")) return "checkpoint"
  if (lower.includes("backpressure")) return "backpressure"
  if (lower.includes("shuffle")) return "shuffle"
  if (/restart|failed|killed|attempt/.test(lower)) return "failures"
  return "throughput"
}

function findStream(entry: ComponentCatalogEntryView, channel: ChannelSpec): LogStreamDefinitionView | null {
  return (
    (entry.logStreams ?? []).find(
      (item) => item.dataType === channel.dataTypeId && item.stream === channel.stream,
    ) ?? null
  )
}

async function readDiscovery(
  engine: string,
  target: { serviceType: string; componentId: string; hostId: string },
  problems: string[],
): Promise<DiscoveryData | null> {
  try {
    const response = await telemetryQuery<DiscoveryData>(
      DISCOVERY_PATH,
      { scope: "sources", target },
      BUDGET.apiTimeoutMs,
    )
    const failure = failureOf(response)
    if (failure) {
      problems.push(`运行态源发现失败：${engine} ${failure.code} ${failure.message}`)
      return null
    }
    return response.data ?? null
  } catch (error) {
    problems.push(`运行态源发现调用失败：${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}
