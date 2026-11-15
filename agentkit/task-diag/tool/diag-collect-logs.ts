/**
 * S2.1 日志取证：v1 日志查询 → 归一化 → 指纹 → 幂等落盘。
 *
 * 这是唯一允许「读日志原文」的地方，且原文只进本进程、不进模型上下文：
 * 工具返回的是 ≤10 条指纹摘要，完整证据包写到 `.diag/runs/<runId>/evidence/`。
 *
 * v1 契约：`POST /api/telemetry/v1/logs/query`
 * - target 是四层身份：serviceType → componentId → hostId；
 * - 必须带 dataType（log.service / log.task）与 stream（stdout / stderr / slowquery）；
 * - log.task 走 YARN 聚合日志，要求 ref.jobName 或 ref.jobId 至少一个；
 * - 非 ok 结果必须带 typed code + requirements[]，不能返回空数组冒充成功。
 *
 * 归属约束：只能取 scope 已授权的通道；跨引擎通道会被 D04 拒绝，
 * 未授权/未配置的通道会被 D10 拒绝，两种都不发后端请求。
 */
import fs from "node:fs"
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import {
  BUDGET,
  CODES,
  ALL_ENGINES,
  backendTargetOf,
  channelById,
  channelsOf,
  channelKeyOf,
  channelRefStatus,
  evidenceDir,
} from "../lib/constants"
import { toolError, toolFail, toolOk } from "../lib/http"
import {
  failureOf,
  telemetryQuery,
  warningTexts,
  type LogData,
} from "../lib/telemetry"
import { assertChannel, evidenceFileName, loadScope, saveEvidencePack } from "../lib/scope"
import { spend } from "../lib/budget"
import { clipText, fingerprint, type LogLevel } from "../lib/signature"
import { nowIso } from "../lib/constants"
import type { EvidencePack, Gap, Signature } from "../lib/schema"

const LOG_QUERY_PATH = "/api/telemetry/v1/logs/query"

export default tool({
  description:
    "S2.1：按通道拉取日志并抽取指纹，落证据包。只接受 scope 已授权的通道；返回 ≤10 条指纹摘要，不返回日志原文。同一通道重复调用会复用已有证据包（reused=true）。",
  args: {
    runId: z.string().min(1).describe("运行 ID"),
    channelId: z
      .string()
      .min(1)
      .describe("通道逻辑名（来自能力表的 signals[].signal，例如 yarn-am / flink-jm-log / doris-fe-log）"),
    ref: z.record(z.string(), z.string()).optional().describe("覆盖或补充 ref，例如 {jobName:'xxx'}"),
    hostId: z.string().optional().describe("覆盖通道默认 hostId（local-disk 命中多个 host 时必须指定）"),
    keyword: z.string().optional().describe("关键词过滤（服务端过滤，大小写不敏感）"),
    keywords: z.array(z.string()).optional().describe("多关键词；默认 AND"),
    excludeKeywords: z.array(z.string()).optional().describe("排除词；任一命中即丢弃"),
    matchMode: z.enum(["all", "any"]).optional().describe("多关键词匹配模式，默认 all"),
    regex: z.boolean().optional().describe("关键词按 RE2 受限正则解释"),
    caseSensitive: z.boolean().optional().describe("大小写敏感，默认 false"),
    timeRange: z.object({ start: z.string().optional(), end: z.string().optional() }).optional().describe("时间窗"),
    focusLevels: z
      .array(z.enum(["FATAL", "ERROR", "WARN", "INFO", "DEBUG", "UNKNOWN"]))
      .optional()
      .describe("只对指定级别做指纹；失败诊断通常传 [FATAL,ERROR,WARN]"),
    maxBytes: z.number().int().positive().optional().describe("本次最多扫描的字节，默认 4MB"),
    limit: z.number().int().positive().max(BUDGET.pageLines).optional().describe("单页返回行数上限"),
  },
  async execute(args, context) {
    try {
      const root = context.directory
      const scope = loadScope(root, args.runId)
      const spec = channelById(scope.engine, args.channelId)
      if (!spec) {
        // 区分「越权（该通道属于别的引擎）」与「不可用（本引擎的通道被关掉）」：
        // 前者是 D04，必须在提示词层面也明确，避免模型换个通道名反复试。
        const owner = ALL_ENGINES.find((engine) =>
          channelsOf(engine).some((channel) => channel.id === args.channelId),
        )
        if (owner && owner !== scope.engine) {
          return toolFail(
            CODES.SCOPE_DENIED,
            `通道 ${args.channelId} 属于引擎 ${owner}，不在引擎 ${scope.engine} 的授权范围内。不得跨引擎取数。`,
            { engine: scope.engine, channel: args.channelId, ownerEngine: owner },
          )
        }
        return toolFail(
          CODES.CHANNEL_UNAVAILABLE,
          `未知通道：${args.channelId}（引擎 ${scope.engine} 的可用通道由能力表给出）`,
        )
      }

      // 作用域校验在任何网络请求之前
      assertChannel(scope, spec)

      const refs: Record<string, string> = {
        ...(scope.target?.ref ?? {}),
        ...(scope.target?.applicationId ? { applicationId: scope.target.applicationId, appId: scope.target.applicationId } : {}),
        ...(scope.target?.jobId ? { jobId: scope.target.jobId } : {}),
        ...(scope.target?.taskInstanceId ? { taskInstanceId: scope.target.taskInstanceId } : {}),
        ...(args.ref ?? {}),
      }
      const refStatus = channelRefStatus(spec, refs, scope.target?.taskName)
      if (!refStatus.ok) {
        return toolFail(
          CODES.CHANNEL_UNAVAILABLE,
          `通道 ${spec.id} 缺少业务引用：${refStatus.missing.join("、")}，当前 ref=${JSON.stringify(refs)}`,
          { channelId: spec.id, missing: refStatus.missing, requirements: refStatus.missing },
        )
      }

      const backendRef = backendRefsOf(spec.dataTypeId, refs, scope.target?.taskName)
      if (spec.dataTypeId === "log.task" && !backendRef.taskId && !backendRef.jobName) {
        return toolFail(
          CODES.CHANNEL_UNAVAILABLE,
          "log.task 需要可解析到 YARN 应用的引用：ref.taskId / ref.jobName（Spark 可用 applicationId）",
          {
            channelId: spec.id,
            requirements: ["ref.taskId 或 ref.jobName: log.task 查询 YARN 聚合日志时必填"],
          },
        )
      }

      const dedupeKey = channelKeyOf({
        serviceType: spec.serviceType,
        componentId: spec.componentId,
        hostId: args.hostId || spec.hostId,
        dataTypeId: spec.dataTypeId,
        stream: spec.stream,
        ref: backendRef,
      })

      // 幂等：同通道同 ref 已有证据包时直接复用，不重复取数
      const cached = `${evidenceDir(root, args.runId)}/${evidenceFileName(`s2-${spec.id}`, dedupeKey)}`
      if (fs.existsSync(cached)) {
        return toolOk({
          runId: args.runId,
          channelId: spec.id,
          dataTypeId: spec.dataTypeId,
          stream: spec.stream,
          packPath: cached.replace(`${root}/`, ""),
          reused: true,
          note: "命中已落盘证据包，未发起新的后端请求。",
        })
      }

      const scanCap = Math.min(args.maxBytes ?? BUDGET.scanBytes, BUDGET.scanBytes)
      const keywords = [...(args.keywords ?? []), ...(args.keyword ? [args.keyword] : [])]
      const timeRange = args.timeRange ?? scope.target?.timeRange
      const taskLog = spec.dataTypeId === "log.task"
      const effectiveTimeRange = taskLog ? undefined : timeRange

      const lines: string[] = []
      const gaps: Gap[] = []
      let scannedBytes = 0
      let pages = 0
      let cursor: string | undefined
      let degraded = false
      let degradationReason: string | null = null
      let truncated = false
      let resultState: string | null = null
      let backendInfo: unknown = null
      let warnings: string[] = []

      if (taskLog && (timeRange?.start || timeRange?.end)) {
        gaps.push({
          signal: spec.id,
          reason: "YARN 聚合日志没有统一行首时间戳，时间范围未应用",
          code: "TIME_FILTER_UNSUPPORTED",
          requirements: ["把任务日志接入 local-disk / elasticsearch 并配置 timestamp-pattern 后重试"],
          neededInterface: "把任务日志接入 local-disk / elasticsearch 并配置 timestamp-pattern",
        })
      }

      while (scannedBytes < scanCap) {
        pages += 1
        const response = await telemetryQuery<LogData>(
          LOG_QUERY_PATH,
          {
            mode: "data",
            dataType: spec.dataTypeId,
            stream: spec.stream,
            target: backendTargetOf(spec, args.hostId),
            ref: backendRef,
            keywords: keywords.length > 0 ? keywords : undefined,
            excludeKeywords: args.excludeKeywords,
            matchMode: args.matchMode,
            regex: args.regex,
            caseSensitive: args.caseSensitive,
            timeRange: effectiveTimeRange,
            cursor,
            limit: args.limit ?? BUDGET.pageLines,
            maxBytes: Math.min(BUDGET.pageBytes, scanCap - scannedBytes),
            includeBackendCandidates: true,
          },
          BUDGET.apiTimeoutMs,
        )

        const failure = failureOf(response)
        if (failure) {
          return toolFail(
            failure.outcome === "failed" ? CODES.API_UNAVAILABLE : CODES.CHANNEL_UNAVAILABLE,
            `v1 日志查询失败：${failure.code} ${failure.message}`,
            {
              runId: args.runId,
              channelId: spec.id,
              dataTypeId: spec.dataTypeId,
              stream: spec.stream,
              outcome: failure.outcome,
              backendCode: failure.code,
              retryable: failure.retryable,
              requirements: failure.requirements,
              backend: failure.backend,
            },
          )
        }

        const entries = response.data?.entries ?? []
        const pageLines = entries.map((entry) => entry.message ?? "").filter((line) => line.length > 0)
        lines.push(...pageLines)
        resultState = response.data?.resultState ?? null
        backendInfo = response.backend ?? null
        warnings = warningTexts(response.meta)
        scannedBytes +=
          response.meta?.scan?.bytes ?? Buffer.byteLength(pageLines.join("\n"), "utf8")

        if (response.meta?.degraded || warnings.some((item) => item.includes("PRIMARY_BACKEND_UNAVAILABLE"))) {
          degraded = true
          degradationReason = warnings.join("; ") || "上游降级"
        }
        if (response.meta?.truncated) truncated = true

        const nextCursor = response.meta?.cursor ?? undefined
        if (!nextCursor || nextCursor === cursor || pageLines.length === 0) break
        cursor = nextCursor
      }

      const printed = fingerprint(lines, {
        maxSignatures: BUDGET.maxSignatures,
        samplesPerSignature: BUDGET.samplesPerSignature,
        levels: (args.focusLevels as LogLevel[] | undefined) ?? undefined,
      })

      if (degraded) {
        gaps.push({
          signal: spec.id,
          reason: degradationReason || "上游降级",
          code: CODES.SOURCE_DEGRADED,
          requirements: spec.requires ? [spec.requires] : [],
          neededInterface: spec.requires,
        })
      }

      const pack: EvidencePack = {
        runId: args.runId,
        engine: scope.engine,
        step: `s2-${spec.id}`,
        channel: {
          serviceType: spec.serviceType,
          componentId: spec.componentId,
          hostId: args.hostId || spec.hostId,
          dataTypeId: spec.dataTypeId,
          stream: spec.stream,
          ref: backendRef,
        },
        fingerprintVersion: printed.version,
        scan: {
          bytes: scannedBytes,
          lines: printed.scannedLines,
          pages,
          truncated: truncated || scannedBytes >= scanCap,
          degraded,
          degradationReason,
        },
        signatures: printed.signatures,
        metrics: [],
        facts: [
          { key: "log.dataType", value: spec.dataTypeId, source: "logs.query.v1" },
          { key: "log.stream", value: spec.stream, source: "logs.query.v1" },
          { key: "log.resultState", value: resultState, source: "logs.query.v1" },
          { key: "log.backend", value: backendLabel(backendInfo), source: "logs.query.v1" },
        ],
        gaps,
        createdAt: nowIso(),
      }

      const saved = saveEvidencePack(root, args.runId, `s2-${spec.id}`, pack, dedupeKey)
      const spent = spend(root, args.runId, { calls: pages, bytes: scannedBytes }, `s2-logs:${spec.id}`)

      const top = printed.signatures.slice(0, 10)
      return toolOk({
        runId: args.runId,
        channelId: spec.id,
        channelLabel: spec.label,
        dataTypeId: spec.dataTypeId,
        stream: spec.stream,
        packPath: saved.path,
        reused: saved.reused,
        fingerprintVersion: printed.version,
        scan: {
          bytes: scannedBytes,
          lines: printed.scannedLines,
          pages,
          truncated: pack.scan.truncated,
          degraded,
          degradationReason,
        },
        resultState,
        backend: backendInfo,
        warnings,
        levelCounts: printed.levelCounts,
        droppedSignatures: printed.droppedSignatures,
        signatures: top.map((item: Signature) => ({
          id: item.id,
          signature: clipText(item.signature, 300),
          level: item.level,
          count: item.count,
          exceptionClass: item.exceptionClass,
          firstLine: item.firstLine,
          lastLine: item.lastLine,
          sample: clipText(item.samples[0]?.text ?? "", 300),
        })),
        hasMoreSignatures: printed.signatures.length > top.length,
        caveat: spec.caveat,
        budget: { callsLeft: spent.remaining.calls, bytesLeft: spent.remaining.bytes },
      })
    } catch (error) {
      return toolError(error)
    }
  },
})

/**
 * 后端 ref 与诊断 agent 的业务 ref 不是同一套键：
 * - log.service 原样携带（local-disk / ES 不需要业务引用，保留便于排障）；
 * - log.task 只认 YARN 的 taskId / jobName，Spark 的 applicationId 映射为 taskId。
 */
function backendRefsOf(
  dataTypeId: string,
  refs: Record<string, string>,
  taskName?: string,
): Record<string, string> {
  if (dataTypeId !== "log.task") return { ...refs }

  const applicationId = refs.applicationId || refs.appId
  const jobIdAsApp = refs.jobId && /^application_\d+_\d+$/.test(refs.jobId) ? refs.jobId : undefined
  const taskId = refs.taskId || applicationId || jobIdAsApp
  const jobName = refs.jobName || taskName
  return {
    ...(taskId ? { taskId } : {}),
    ...(jobName ? { jobName } : {}),
  }
}

function backendLabel(backend: unknown): string {
  if (!backend || typeof backend !== "object") return "unknown"
  const selected = (backend as { selected?: { backendId?: string; backendType?: string; fallback?: boolean } }).selected
  if (!selected) return "unknown"
  const fallback = selected.fallback ? " (fallback)" : ""
  return `${selected.backendId ?? ""}/${selected.backendType ?? ""}${fallback}`
}
