/**
 * S2.2b 速率/增量对比：变慢类问题的核心判据。
 *
 * 为什么单独一个工具：`/compare` 返回的是「两次进程内快照的差值 + 每秒速率」，
 * 语义与绝对快照不同，混在一起容易让模型把速率当总量。原始行落盘，
 * 返回体只给「越界项」，避免把几十行数值全塞进上下文。
 */
import fs from "node:fs"
import path from "node:path"
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { BUDGET, CODES, evidenceDir, profileOf } from "../lib/constants"
import { requestJson, toolError, toolFail, toolOk } from "../lib/http"
import { assertEngine, evidenceKey, loadScope, saveEvidencePack } from "../lib/scope"
import { spend } from "../lib/budget"
import { nowIso, writeJsonAtomic } from "../lib/constants"
import type { EvidencePack, Fact, Gap, MetricPoint } from "../lib/schema"

type CompareRow = {
  name?: string
  family?: string
  component?: string
  from?: number | null
  to?: number | null
  delta?: number | null
  perSecond?: number | null
}

type CompareResult = {
  jobId?: string
  comparable?: boolean
  reason?: string
  windowSeconds?: number
  fromCapturedAt?: number
  toCapturedAt?: number
  rows?: CompareRow[]
  degraded?: boolean
  degradationReason?: string
  warnings?: string[]
}

export default tool({
  description:
    "S2.2b：对比同一作业两次快照的增量与每秒速率（变慢类首选判据）。原始行落盘，只返回变化最显著的若干项。",
  args: {
    runId: z.string().min(1).describe("运行 ID"),
    jobId: z.string().optional().describe("作业 ID；缺省从 target.ref 推导"),
    families: z.array(z.string()).optional().describe("指标族，缺省取引擎画像的全部族"),
    windowSeconds: z.number().int().positive().optional().describe("对比窗口，默认沿用服务端默认"),
    runtimeMode: z.enum(["live", "history"]).optional().describe("spark 默认 history，flink 只有 live"),
    top: z.number().int().positive().max(20).optional().describe("返回多少条变化最大的行，默认 8"),
  },
  async execute(args, context) {
    try {
      const root = context.directory
      const scope = loadScope(root, args.runId)
      assertEngine(scope, scope.engine)
      const profile = profileOf(scope.engine)
      if (!profile || profile.families.length === 0) {
        return toolFail(CODES.CHANNEL_UNAVAILABLE, `引擎 ${scope.engine} 没有运行态指标，无法做速率对比。`, {
          gaps: profile?.gaps ?? [],
        })
      }

      const jobId = args.jobId || scope.target?.jobId || scope.target?.appId || scope.target?.applicationId || ""
      if (!jobId) return toolFail(CODES.CHANNEL_UNAVAILABLE, "缺少 jobId")

      const families = args.families && args.families.length > 0 ? args.families : profile.families
      const runtimeMode = args.runtimeMode ?? (scope.engine === "spark" ? "history" : "live")

      const result = await requestJson<CompareResult>(`/api/runtime/jobs/${encodeURIComponent(jobId)}/compare`, {
        query: {
          serviceType: scope.engine,
          cluster: scope.target?.cluster || "default",
          mode: runtimeMode,
          families,
          windowSeconds: args.windowSeconds,
        },
        timeoutMs: BUDGET.apiTimeoutMs,
      })

      const dir = evidenceDir(root, args.runId)
      fs.mkdirSync(dir, { recursive: true })
      const rawPath = path.join(dir, `compare-${evidenceKey(`compare|${jobId}|${families.join(",")}`)}.json`)
      writeJsonAtomic(rawPath, result)

      const rows = result.rows ?? []
      const metrics: MetricPoint[] = rows
        .filter((row) => row.name)
        .map((row) => ({
          family: row.family,
          name: row.name as string,
          component: row.component,
          value: row.perSecond ?? null,
          verified: true,
        }))

      const facts: Fact[] = [
        { key: "compare.comparable", value: Boolean(result.comparable), source: "runtime.compare" },
        { key: "compare.windowSeconds", value: result.windowSeconds ?? null, source: "runtime.compare" },
        { key: "compare.fromCapturedAt", value: result.fromCapturedAt ?? null, source: "runtime.compare" },
        { key: "compare.toCapturedAt", value: result.toCapturedAt ?? null, source: "runtime.compare" },
        { key: "compare.rowCount", value: rows.length, source: "runtime.compare" },
        { key: "compare.rawPath", value: path.relative(root, rawPath), source: "local" },
      ]

      const gaps: Gap[] = []
      if (result.comparable === false) {
        gaps.push({
          signal: "两次快照对比",
          reason: result.reason || "服务端判定不可对比（可能只有一份快照）",
          code: CODES.SOURCE_DEGRADED,
          neededInterface: "同一进程内需至少两次快照；可先调 diag_collect_runtime 再调本工具",
        })
      }
      if (result.degraded) {
        gaps.push({
          signal: "runtime.compare",
          reason: result.degradationReason || "上游降级",
          code: CODES.SOURCE_DEGRADED,
        })
      }

      const pack: EvidencePack = {
        runId: args.runId,
        engine: scope.engine,
        step: "s2-compare",
        scan: {
          bytes: Buffer.byteLength(JSON.stringify(result), "utf8"),
          lines: 0,
          pages: 1,
          truncated: false,
          degraded: Boolean(result.degraded),
          degradationReason: result.degradationReason,
        },
        signatures: [],
        metrics,
        facts,
        gaps,
        createdAt: nowIso(),
      }
      const saved = saveEvidencePack(root, args.runId, "s2-compare", pack, `compare|${jobId}|${families.join(",")}`)
      const spent = spend(root, args.runId, { calls: 1, bytes: pack.scan.bytes }, "s2-compare")

      const ranked = [...rows]
        .filter((row) => typeof row.delta === "number" || typeof row.perSecond === "number")
        .sort((a, b) => Math.abs(b.delta ?? b.perSecond ?? 0) - Math.abs(a.delta ?? a.perSecond ?? 0))
        .slice(0, args.top ?? 8)

      return toolOk({
        runId: args.runId,
        jobId,
        comparable: result.comparable !== false,
        windowSeconds: result.windowSeconds ?? null,
        packPath: saved.path,
        rawPath: path.relative(root, rawPath),
        rowCount: rows.length,
        topChanges: ranked,
        gaps,
        warnings: result.warnings ?? [],
        note: "perSecond 是速率，delta 是窗口内增量；不要把速率当总量。",
        budget: { callsLeft: spent.remaining.calls, bytesLeft: spent.remaining.bytes },
      })
    } catch (error) {
      return toolError(error)
    }
  },
})
