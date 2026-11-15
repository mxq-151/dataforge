/**
 * S2.1 日志取证：切片 → 归一化 → 指纹 → 幂等落盘。
 *
 * 这是唯一允许「读日志原文」的地方，且原文只进本进程、不进模型上下文：
 * 工具返回的是 ≤10 条指纹摘要，完整证据包写到 `.diag/runs/<runId>/evidence/`。
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
  channelById,
  channelsOf,
  channelKeyOf,
  evidenceDir,
} from "../lib/constants"
import { requestJson, diagError, toolError, toolFail, toolOk } from "../lib/http"
import { assertChannel, evidenceFileName, loadScope, saveEvidencePack } from "../lib/scope"
import { spend } from "../lib/budget"
import { clipText, fingerprint, type LogLevel } from "../lib/signature"
import { nowIso } from "../lib/constants"
import type { EvidencePack, Gap, Signature } from "../lib/schema"

type LogQueryResult = {
  content?: string
  lines?: string[]
  lineCount?: number
  byteSize?: number
  nextCursor?: string
  hasMore?: boolean
  truncated?: boolean
  degraded?: boolean
  degradationReason?: string
  errorCode?: string
  message?: string
}

export default tool({
  description:
    "S2.1：按通道拉取日志并抽取指纹，落证据包。只接受 scope 已授权的通道；返回 ≤10 条指纹摘要，不返回日志原文。同一通道重复调用会复用已有证据包（reused=true）。",
  args: {
    runId: z.string().min(1).describe("运行 ID"),
    channelId: z.string().min(1).describe("通道逻辑名（来自能力表的 signals[].signal，例如 yarn-am / flink-exception / doris-fe-log）"),
    ref: z.record(z.string(), z.string()).optional().describe("覆盖或补充 ref，例如 {path:'/var/log/doris/fe.log'}"),
    keyword: z.string().optional().describe("关键词过滤（服务端过滤，大小写不敏感）"),
    timeRange: z.object({ start: z.string().optional(), end: z.string().optional() }).optional().describe("时间窗"),
    focusLevels: z
      .array(z.enum(["FATAL", "ERROR", "WARN", "INFO", "DEBUG", "UNKNOWN"]))
      .optional()
      .describe("只对指定级别做指纹；失败诊断通常传 [FATAL,ERROR,WARN]"),
    maxBytes: z.number().int().positive().optional().describe("本次最多扫描的字节，默认 4MB"),
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

      const ref: Record<string, string> = { ...(scope.target?.ref ?? {}), ...(args.ref ?? {}) }
      if (!ref[spec.refKey]) {
        return toolFail(
          CODES.CHANNEL_UNAVAILABLE,
          `通道 ${spec.id} 需要 ref.${spec.refKey}，当前 ref=${JSON.stringify(ref)}`,
        )
      }

      const dedupeKey = channelKeyOf({
        serviceType: spec.serviceType,
        logKind: spec.logKind,
        componentRole: spec.componentRole,
        ref,
      })

      // 幂等：同通道同 ref 已有证据包时直接复用，不重复取数
      const cached = `${evidenceDir(root, args.runId)}/${evidenceFileName(`s2-${spec.id}`, dedupeKey)}`
      if (fs.existsSync(cached)) {
        return toolOk({
          runId: args.runId,
          channelId: spec.id,
          packPath: cached.replace(`${root}/`, ""),
          reused: true,
          note: "命中已落盘证据包，未发起新的后端请求。",
        })
      }

      const scanCap = Math.min(args.maxBytes ?? BUDGET.scanBytes, BUDGET.scanBytes)
      const lines: string[] = []
      const gaps: Gap[] = []
      let scannedBytes = 0
      let pages = 0
      let cursor: string | undefined
      let degraded = false
      let degradationReason: string | undefined
      let truncated = false

      while (scannedBytes < scanCap) {
        pages += 1
        const result = await requestJson<LogQueryResult>("/api/logs/query", {
          method: "POST",
          body: {
            serviceType: spec.serviceType,
            cluster: scope.target?.cluster || "default",
            logKind: spec.logKind,
            componentRole: spec.componentRole,
            ref,
            keyword: args.keyword,
            timeRange: args.timeRange
              ? { start: args.timeRange.start, end: args.timeRange.end }
              : scope.target?.timeRange,
            cursor,
            limit: BUDGET.pageLines,
            maxBytes: Math.min(BUDGET.pageBytes, scanCap - scannedBytes),
          },
          timeoutMs: BUDGET.apiTimeoutMs,
        })

        const pageLines = result.lines && result.lines.length > 0 ? result.lines : (result.content ?? "").split("\n")
        lines.push(...pageLines)
        scannedBytes += result.byteSize ?? Buffer.byteLength(pageLines.join("\n"), "utf8")
        if (result.degraded) {
          degraded = true
          degradationReason = result.degradationReason || result.errorCode || "上游降级"
          break
        }
        if (result.truncated) truncated = true
        if (!result.hasMore || !result.nextCursor) break
        cursor = result.nextCursor
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
          neededInterface: spec.requires,
        })
      }

      const pack: EvidencePack = {
        runId: args.runId,
        engine: scope.engine,
        step: `s2-${spec.id}`,
        channel: { serviceType: spec.serviceType, logKind: spec.logKind, componentRole: spec.componentRole, ref },
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
        facts: [],
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
      if (error instanceof Error && error.message.includes("D05_BUDGET_EXHAUSTED")) return toolError(error)
      return toolError(error)
    }
  },
})
