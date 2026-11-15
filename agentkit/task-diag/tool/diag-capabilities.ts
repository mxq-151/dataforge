/**
 * S1 能力画像 + S1.8 建立运行作用域（写 scope 票据）。
 *
 * 这是「能不能查」的唯一事实源：把服务端 /api/logs/sources、/api/runtime/sources、
 * /api/runtime/metrics/catalog 三个清单勾稽成「每个通道可用/不可用 + 原因 + 需要什么配置」。
 * 引擎 agent 拿到的是这份结论，不允许自己再判断能力。
 */
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import {
  BUDGET,
  CODES,
  ENGINE_PROFILES,
  channelTripleOf,
  newRunId,
  profileOf,
  targetPath,
  capabilitiesPath,
} from "../lib/constants"
import { requestJson, toolError, toolFail, toolOk } from "../lib/http"
import { initBudget } from "../lib/budget"
import { buildScope, saveScope, assertWorkspace } from "../lib/scope"
import { writeJsonAtomic, nowIso } from "../lib/constants"
import { CapabilityReportSchema, TargetSchema, type EngineCapability, type Signal, type Target } from "../lib/schema"

type LogSourceVO = {
  id: string
  serviceType: string
  cluster?: string
  enabled: boolean
  disabledReason?: string
  roles?: string[]
  logKinds?: string[]
}

type RuntimeSourceVO = { id: string; serviceType: string; cluster?: string; enabled: boolean; disabledReason?: string }

type MetricDefinitionVO = { serviceType: string; family: string; name: string; verified?: boolean; scope?: string }

export default tool({
  description:
    "S1：生成引擎能力画像并建立本次运行的作用域票据（scope.json）。一次调用完成：读三个服务端清单 → 判断每条通道可用性 → 落 capabilities.json / target.json / scope.json / budget.json → 返回 runId。编排器必须先把 runId 交给对应引擎 agent。",
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

      // 三个清单各自独立；任意一个失败都不阻断——缺哪个就把对应的信号标成 unavailable。
      const problems: string[] = []
      let logSources: LogSourceVO[] = []
      let runtimeSources: RuntimeSourceVO[] = []
      let catalog: MetricDefinitionVO[] = []

      try {
        logSources = (await requestJson<LogSourceVO[]>("/api/logs/sources", { timeoutMs: BUDGET.apiTimeoutMs })) ?? []
      } catch (error) {
        problems.push(`日志源清单读取失败：${error instanceof Error ? error.message : String(error)}`)
      }
      try {
        runtimeSources =
          (await requestJson<RuntimeSourceVO[]>("/api/runtime/sources", { timeoutMs: BUDGET.apiTimeoutMs })) ?? []
      } catch (error) {
        problems.push(`运行态源清单读取失败：${error instanceof Error ? error.message : String(error)}`)
      }
      try {
        catalog =
          (await requestJson<MetricDefinitionVO[]>("/api/runtime/metrics/catalog", { timeoutMs: BUDGET.apiTimeoutMs })) ?? []
      } catch (error) {
        problems.push(`指标对照表读取失败：${error instanceof Error ? error.message : String(error)}`)
      }

      const signals: Signal[] = []
      const availableChannelIds: string[] = []
      const unavailable: { id: string; reason: string }[] = []

      for (const channel of profile.channels) {
        const source = logSources.find(
          (item) =>
            item.serviceType === channel.serviceType &&
            // file 源是「宿主机挂载目录」语义，没有集群概念（服务端固定 cluster=local），
            // 不能拿诊断目标的 cluster=default 去比，否则所有 file 通道会被误判为未配置。
            (channel.serviceType === "file" || !item.cluster || item.cluster === cluster) &&
            (!item.roles || item.roles.length === 0 || item.roles.includes(channel.componentRole)) &&
            (!item.logKinds || item.logKinds.length === 0 || item.logKinds.includes(channel.logKind)),
        )

        if (!source) {
          const reason = `未配置 ${channel.serviceType} 日志源（或该源不支持 ${channel.logKind}/${channel.componentRole}）`
          signals.push({
            signal: channel.id,
            status: "unavailable",
            logKind: channel.logKind,
            reason,
            code: "NOT_CONFIGURED",
            need: channel.requires,
          })
          unavailable.push({ id: channel.id, reason })
          continue
        }

        if (!source.enabled) {
          const reason = source.disabledReason || "日志源未启用"
          signals.push({
            signal: channel.id,
            status: "unavailable",
            logKind: channel.logKind,
            reason,
            code: "CONFIG_MISSING",
            detail: `sourceId=${source.id}`,
            need: channel.requires,
          })
          unavailable.push({ id: channel.id, reason })
          continue
        }

        signals.push({
          signal: channel.id,
          status: "available",
          via: "/api/logs/query",
          logKind: channel.logKind,
          detail: `sourceId=${source.id}`,
          need: channel.caveat,
        })
        availableChannelIds.push(channel.id)
      }

      // 运行态：只有画像里声明了指标族才有意义
      let runtimeAvailable = false
      if (profile.families.length > 0) {
        const runtimeSource = runtimeSources.find(
          (item) => item.serviceType === actorEngine(args.engine) && (!item.cluster || item.cluster === cluster),
        )
        if (runtimeSource?.enabled) {
          runtimeAvailable = true
          for (const family of profile.families) {
            const definitions = catalog.filter((item) => item.serviceType === args.engine && item.family === family)
            const verified = definitions.length > 0 && definitions.every((item) => item.verified !== false)
            signals.push({
              signal: `runtime.${family}`,
              status: definitions.length === 0 ? "unverified" : "available",
              via: "/api/runtime/jobs/{id}/snapshot",
              verified,
              detail:
                definitions.length === 0
                  ? "指标对照表里没有该族的定义，取数时可能缺席（不等于 0）"
                  : `${definitions.length} 个指标定义`,
            })
          }
        } else {
          signals.push({
            signal: "runtime.snapshot",
            status: "unavailable",
            via: "/api/runtime/jobs/{id}/snapshot",
            reason: runtimeSource?.disabledReason || "未配置该引擎的运行态源",
            code: "NOT_CONFIGURED",
            need: `配置 runtime.sources 中 serviceType=${args.engine} 的 base-url`,
          })
        }
      }

      const availableSignals = signals.filter((signal) => signal.status === "available").length
      let diagnosable: EngineCapability["diagnosable"]
      if (availableSignals === 0) diagnosable = "none"
      else if (runtimeAvailable && availableChannelIds.length > 0) diagnosable = "full"
      else diagnosable = "partial"

      // 允许通道：画像里已就绪的日志通道 + Hudi 这种「只有交接、无自有通道」的情形
      const runId = args.runId || newRunId(args.engine)

      const targetCandidate: Partial<Target> = {
        engine: args.engine,
        cluster,
        taskName: args.target?.taskName,
        deployMode: args.target?.deployMode ?? "unknown",
        taskInstanceId: args.target?.taskInstanceId,
        applicationId: args.target?.applicationId,
        appId: args.target?.applicationId,
        jobId: args.target?.jobId,
        ref: {
          ...(args.target?.applicationId ? { applicationId: args.target.applicationId, appId: args.target.applicationId } : {}),
          ...(args.target?.jobId ? { jobId: args.target.jobId } : {}),
          ...(args.target?.taskInstanceId ? { taskInstanceId: args.target.taskInstanceId } : {}),
        },
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

      const gaps = profile.gaps
      return toolOk({
        runId,
        engine: args.engine,
        engineLabel: profile.label,
        diagnosable,
        scopeNote:
          diagnosable === "none"
            ? "没有任何可用通道：引擎 agent 只能输出 UNRESOLVED 与缺口清单，不得给出归因。"
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
        gaps,
        problems,
        nextAction:
          diagnosable === "none" || availableChannelIds.length === 0
            ? profile.configOnly
              ? "该引擎环境未部署：只输出「无法定位 + 配置层验证路径」。"
              : "无可用通道：输出 UNRESOLVED + neededInterface，不要假装有作业级证据。"
            : "派发引擎 agent（runId 必传）。",
        scopeTriples: scope.allowedChannels.map((item) => channelTripleOf(item)),
        agent: ENGINE_PROFILES[args.engine as keyof typeof ENGINE_PROFILES]?.agent ?? null,
      })
    } catch (error) {
      return toolError(error)
    }
  },
})

/** 运行态源的 serviceType 与引擎名一致；单独抽出便于以后画像改名时只改一处。 */
function actorEngine(engine: string): string {
  return engine
}
