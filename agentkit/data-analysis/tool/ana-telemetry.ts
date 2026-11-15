import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { CODES, LIMITS } from "../lib/constants"
import { aError, toolError, toolOk, toolFail, v1Query } from "../lib/client"
import { spend } from "../lib/budget"
import { nowIso } from "../../shared/lib/io"
import { TimeRangeSchema, type Fact, type Gap, type Stat } from "../lib/schema"
import { assertChannel, assertOwner, channelKeyFor, loadScope, saveEvidencePack } from "../lib/scope"

const TELEMETRY_CHANNELS = [
  "metrics",
  "logs",
  "discovery",
  "runtime.snapshot",
  "runtime.config",
  "runtime.compare",
  "metadata.service",
] as const

const TelemetryArgs = z
  .object({
    runId: z.string().min(1),
    channelId: z.enum(TELEMETRY_CHANNELS),
    target: z
      .object({
        serviceType: z.string().min(1),
        componentId: z.string().min(1).optional(),
        hostId: z.string().min(1).optional(),
        jobId: z.string().min(1).optional(),
      })
      .strict(),
    owner: z.string().min(1).default("ana-runtime"),
    // metrics
    mode: z.string().min(1).optional(),
    metric: z.string().min(1).optional(),
    labelMatchers: z.record(z.string(), z.string()).optional(),
    time: z.string().min(1).optional(),
    step: z.string().min(1).optional(),
    rate: z.boolean().optional(),
    // logs
    dataType: z.enum(["log.service", "log.task"]).optional(),
    stream: z.string().min(1).optional(),
    keywords: z.array(z.string().min(1)).max(10).optional(),
    excludeKeywords: z.array(z.string().min(1)).max(10).optional(),
    matchMode: z.enum(["all", "any"]).optional(),
    regex: z.boolean().optional(),
    caseSensitive: z.boolean().optional(),
    cursor: z.string().optional(),
    limit: z.number().int().positive().max(LIMITS.maxRows).optional(),
    maxBytes: z.number().int().positive().optional(),
    // runtime
    jobId: z.string().min(1).optional(),
    scope: z.enum(["sources", "jobs", "components"]).optional(),
    sourceMode: z.string().min(1).optional(),
    componentRole: z.string().min(1).optional(),
    components: z.array(z.string().min(1)).max(50).optional(),
    families: z.array(z.string().min(1)).max(50).optional(),
    metrics: z.array(z.string().min(1)).max(50).optional(),
    sections: z.array(z.string().min(1)).max(50).optional(),
    keys: z.array(z.string().min(1)).max(50).optional(),
    includeConfig: z.boolean().optional(),
    windowSeconds: z.number().int().positive().max(86_400).optional(),
    // common
    timeRange: TimeRangeSchema.optional(),
    ref: z.record(z.string(), z.string()).optional(),
    timeoutMs: z.number().int().positive().max(60_000).optional(),
  })
  .strict()

type Args = z.infer<typeof TelemetryArgs>

function bodyFor(args: Args): Record<string, unknown> {
  const target = {
    serviceType: args.target.serviceType,
    componentId: args.target.componentId,
    hostId: args.target.hostId,
  }
  const jobId = args.jobId ?? args.target.jobId
  const timeoutMs = args.timeoutMs ?? LIMITS.apiTimeoutMs

  switch (args.channelId) {
    case "metrics": {
      if (!args.mode) throw aError(CODES.SCHEMA_INVALID, "metrics 需要 mode（instant / range / catalog）")
      if (args.mode !== "catalog" && !args.metric) {
        throw aError(CODES.SCHEMA_INVALID, "metrics 非 catalog 模式需要 metric")
      }
      return {
        mode: args.mode,
        target,
        metric: args.metric,
        labelMatchers: args.labelMatchers,
        time: args.time,
        timeRange: args.timeRange,
        step: args.step,
        rate: args.rate,
        ref: args.ref,
        timeoutMs,
      }
    }
    case "logs": {
      if (!args.dataType) throw aError(CODES.SCHEMA_INVALID, "logs 需要 dataType（log.service / log.task）")
      if (!args.stream) throw aError(CODES.SCHEMA_INVALID, "logs 需要 stream")
      if (!args.keywords || args.keywords.length === 0) {
        throw aError(CODES.SCHEMA_INVALID, "logs 需要至少 1 个 keyword：禁止无关键词全量拉日志")
      }
      return {
        mode: "data",
        target,
        dataType: args.dataType,
        stream: args.stream,
        timeRange: args.timeRange,
        keywords: args.keywords,
        excludeKeywords: args.excludeKeywords,
        matchMode: args.matchMode,
        regex: args.regex,
        caseSensitive: args.caseSensitive,
        cursor: args.cursor,
        limit: args.limit,
        maxBytes: args.maxBytes,
        ref: args.ref,
        timeoutMs,
        includeBackendCandidates: true,
      }
    }
    case "discovery": {
      if (!args.scope) throw aError(CODES.SCHEMA_INVALID, "discovery 需要 scope（sources / jobs / components）")
      return {
        scope: args.scope,
        target,
        sourceMode: args.sourceMode,
        jobId,
        componentRole: args.componentRole,
        components: args.components ?? [],
        limit: args.limit,
      }
    }
    case "runtime.snapshot": {
      if (!jobId) throw aError(CODES.SCHEMA_INVALID, "runtime.snapshot 需要 jobId")
      return {
        target,
        sourceMode: args.sourceMode,
        jobId,
        families: args.families ?? [],
        metrics: args.metrics ?? [],
        components: args.components ?? [],
        includeConfig: args.includeConfig ?? false,
      }
    }
    case "runtime.config": {
      if (!jobId) throw aError(CODES.SCHEMA_INVALID, "runtime.config 需要 jobId")
      return {
        target,
        sourceMode: args.sourceMode,
        jobId,
        components: args.components ?? [],
      }
    }
    case "runtime.compare": {
      if (!jobId) throw aError(CODES.SCHEMA_INVALID, "runtime.compare 需要 jobId")
      return {
        target,
        sourceMode: args.sourceMode,
        jobId,
        windowSeconds: args.windowSeconds,
      }
    }
    case "metadata.service":
      return {
        targets: [target],
        scope: args.scope,
        sections: args.sections,
        keys: args.keys,
        limit: args.limit,
      }
    default:
      throw aError(CODES.CHANNEL_UNAVAILABLE, `不支持的通道：${String(args.channelId)}`)
  }
}

function identityFor(args: Args): {
  dataTypeId: string
  stream: string
  ref: Record<string, string>
} {
  const stream =
    args.channelId === "logs"
      ? args.stream ?? "unknown"
      : args.channelId === "metrics"
        ? args.mode ?? "instant"
        : args.channelId === "discovery"
          ? args.scope ?? "sources"
          : args.channelId === "runtime.snapshot"
            ? "snapshot"
            : args.channelId === "runtime.config"
              ? "config"
              : args.channelId === "runtime.compare"
                ? "compare"
                : "version"

  const dataTypeId =
    args.channelId === "logs" ? args.dataType ?? "log.service" : args.channelId === "metrics" ? "metrics" : args.channelId === "metadata.service" ? "metadata" : "runtime"

  const ref: Record<string, string> = {}
  const jobId = args.jobId ?? args.target.jobId
  if (jobId) ref.jobId = jobId
  if (args.metric) ref.metric = args.metric
  if (args.keywords && args.keywords.length > 0) ref.keywords = [...args.keywords].sort().join(",")
  return { dataTypeId, stream, ref }
}

type LooseData = Record<string, unknown> | null | undefined

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function countArrays(data: LooseData): { name: string; value: number }[] {
  if (!data) return []
  const counts: { name: string; value: number }[] = []
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) counts.push({ name: `${key}.count`, value: value.length })
  }
  return counts
}

function logSamples(data: LooseData): Record<string, string | number | boolean | null>[] {
  if (!data) return []
  const entries = asArray(data.entries ?? data.logs ?? data.items)
  return entries.slice(0, LIMITS.logEntriesReturned).map((entry) => {
    const item = (entry ?? {}) as Record<string, unknown>
    const message = String(item.message ?? item.line ?? item.content ?? "")
    return {
      timestamp: String(item.timestamp ?? item.time ?? ""),
      level: String(item.level ?? item.severity ?? ""),
      message: message.length > 300 ? `${message.slice(0, 300)}…` : message,
    }
  })
}

export default tool({
  description:
    "查询 telemetry v1（metrics / logs / discovery / runtime snapshot|config|compare / 服务版本配置）。只允许这 7 个通道；非 ok 结果原样返回 typed code 与 requirements，不做默认值填充。",
  args: TelemetryArgs.shape,
  async execute(args, context) {
    try {
      const root = context.directory || context.worktree || process.cwd()
      const scope = loadScope(root, args.runId)
      const spec = assertChannel(scope, args.channelId)
      assertOwner(spec, args.owner)

      const body = bodyFor(args)
      const identity = identityFor(args)
      const channelKey = channelKeyFor({
        channelId: args.channelId,
        serviceType: args.target.serviceType,
        componentId: args.target.componentId,
        hostId: args.target.hostId,
        dataTypeId: identity.dataTypeId,
        stream: identity.stream,
        ref: identity.ref,
      })

      const response = await v1Query<LooseData>(spec.endpoint, body, args.timeoutMs ?? LIMITS.apiTimeoutMs)

      if (response.outcome !== "ok") {
        // 后端 error.requirements 可能为空，但 backend.skipped 里写了缺哪些配置；
        // 如实把它们抬到 requirements，避免「NOT_CONFIGURED 却没有缺口说明」。
        const declared = (response.error?.requirements ?? [])
          .map((item) => item.description ?? item.key ?? "")
          .filter(Boolean)
        const skipped = (response.backend?.skipped ?? [])
          .map((item) => `${item.backendId}（${item.backendType}）: ${item.reason}`)
          .filter(Boolean)
        return toolFail(response.error?.code ?? CODES.CHANNEL_UNAVAILABLE, response.error?.message ?? "后端返回非 ok", {
          outcome: response.outcome,
          retryable: response.retryable ?? false,
          channelId: args.channelId,
          requirements: declared.length > 0 ? declared : skipped,
          backend: response.backend,
          meta: response.meta,
        })
      }

      const data = (response.data ?? null) as LooseData
      const scanRaw = response.meta?.scan ?? null
      const stats: Stat[] = [
        ...countArrays(data).map((item) => ({ name: item.name, value: item.value, unit: "count" })),
        ...(scanRaw
          ? [
              { name: "scan.files", value: scanRaw.files ?? null, unit: "files" },
              { name: "scan.bytes", value: scanRaw.bytes ?? null, unit: "bytes" },
              { name: "scan.lines", value: scanRaw.lines ?? null, unit: "lines" },
              { name: "scan.matched", value: scanRaw.matched ?? null, unit: "rows" },
            ]
          : []),
      ]

      const gaps: Gap[] = (response.meta?.warnings ?? []).map((warning) => ({
        code: warning.code ?? "BACKEND_WARNING",
        detail: warning.message ?? "后端告警",
        requirements: [],
      }))
      if (response.meta?.degraded) {
        gaps.push({
          code: "BACKEND_DEGRADED",
          detail: "后端处于降级路径，结果可能不完整",
          requirements: [],
        })
      }

      const facts: Fact[] = [
        { key: "outcome", value: response.outcome, source: spec.endpoint },
        { key: "backend.selected", value: response.backend?.selected?.backendId ?? null, source: spec.endpoint },
        { key: "backend.fallback", value: Boolean(response.backend?.fallback), source: spec.endpoint },
        { key: "meta.partial", value: Boolean(response.meta?.partial), source: spec.endpoint },
        { key: "meta.truncated", value: Boolean(response.meta?.truncated), source: spec.endpoint },
      ]

      const samples = args.channelId === "logs" ? logSamples(data) : []
      const returnedRows = args.channelId === "logs" ? samples.length : 0

      const saved = saveEvidencePack(
        root,
        scope.runId,
        args.channelId.replace(/\./g, "-"),
        {
          runId: scope.runId,
          analysisType: scope.analysisType,
          owner: args.owner,
          step: args.channelId,
          channel: {
            id: args.channelId,
            serviceType: args.target.serviceType,
            componentId: args.target.componentId,
            hostId: args.target.hostId,
            dataTypeId: identity.dataTypeId,
            stream: identity.stream,
            ref: identity.ref,
          },
          channelKey,
          scopeTicketId: scope.runId,
          query: {
            rowLimit: args.limit,
            returnedRows,
            truncated: Boolean(response.meta?.truncated),
          },
          scan: {
            bytes: scanRaw?.bytes ?? null,
            bytesUnavailable: scanRaw?.bytes === undefined || scanRaw?.bytes === null,
            lines: scanRaw?.lines,
            durationMs: response.meta?.elapsedMs,
            degraded: Boolean(response.meta?.degraded),
            degradationReason: response.meta?.degraded ? "backend-degraded" : null,
          },
          indicatorRefs: scope.indicators,
          stats,
          samples,
          facts,
          gaps,
          createdAt: nowIso(),
        },
        channelKey,
      )

      spend(root, scope.runId, { queries: 1, rows: returnedRows }, `ana_telemetry:${args.channelId}`)

      return toolOk({
        outcome: "ok",
        channelId: args.channelId,
        channelKey,
        evidencePath: saved.path,
        reused: saved.reused,
        stats,
        samples,
        facts,
        gaps,
        meta: response.meta ?? null,
        data,
      })
    } catch (error) {
      return toolError(error)
    }
  },
})
