/**
 * S2.3 运行态前后对比（telemetry v1）。
 *
 * v1 契约：`POST /api/telemetry/v1/runtime/compare`
 * - target 四层身份 + jobId + windowSeconds；
 * - 数据来自服务端进程内环形缓冲，必须先成功取过至少两次 snapshot 才可能 comparable=true；
 * - 不可比时返回 comparable=false + reason，禁止把缺失对比当「无变化」。
 */
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { BUDGET, CODES, profileOf, runtimeTargetOf } from "../lib/constants"
import { toolError, toolFail, toolOk } from "../lib/http"
import {
  failureOf,
  telemetryQuery,
  warningTexts,
  type CompareData,
} from "../lib/telemetry"
import { assertEngine, loadScope, saveEvidencePack } from "../lib/scope"
import { spend } from "../lib/budget"
import { nowIso } from "../lib/constants"
import type { EvidencePack, Fact, Gap, MetricPoint } from "../lib/schema"

const COMPARE_PATH = "/api/telemetry/v1/runtime/compare"

export default tool({
  description:
    "S2.3：对比两次运行态快照，返回吞吐/失败的每秒增量。只有 spark/flink 支持；comparable=false 时必须如实报告原因，不能推断「无变化」。",
  args: {
    runId: z.string().min(1).describe("运行 ID"),
    jobId: z.string().optional().describe("作业 ID；缺省时从 target.ref 推导"),
    windowSeconds: z.number().int().positive().max(3600).optional().describe("回看窗口秒数，默认 300"),
    runtimeMode: z.enum(["live", "history"]).optional().describe("spark 默认 history，flink 只有 live"),
  },
  async execute(args, context) {
    try {
      const root = context.directory
      const scope = loadScope(root, args.runId)
      assertEngine(scope, scope.engine)
      const profile = profileOf(scope.engine)
      if (!profile || profile.families.length === 0) {
        return toolFail(
          CODES.CHANNEL_UNAVAILABLE,
          `引擎 ${scope.engine} 没有运行态通道，无法做前后对比。`,
          { gaps: profile?.gaps ?? [] },
        )
      }

      const jobId =
        args.jobId || scope.target?.jobId || scope.target?.appId || scope.target?.applicationId || ""
      if (!jobId) {
        return toolFail(CODES.CHANNEL_UNAVAILABLE, "缺少 jobId：请先解析目标或显式传入")
      }

      const target = runtimeTargetOf(scope.engine)
      if (!target) {
        return toolFail(CODES.CHANNEL_UNAVAILABLE, `v1 runtime 只覆盖 spark / flink，不支持 ${scope.engine}`)
      }
      const runtimeMode = args.runtimeMode ?? (scope.engine === "spark" ? "history" : "live")
      const windowSeconds = args.windowSeconds ?? 300

      const response = await telemetryQuery<CompareData>(
        COMPARE_PATH,
        { target, sourceMode: runtimeMode, jobId, windowSeconds },
        BUDGET.apiTimeoutMs,
      )

      const failure = failureOf(response)
      if (failure) {
        return toolFail(
          failure.outcome === "failed" ? CODES.API_UNAVAILABLE : CODES.CHANNEL_UNAVAILABLE,
          `v1 运行态对比失败：${failure.code} ${failure.message}`,
          {
            runId: args.runId,
            jobId,
            outcome: failure.outcome,
            backendCode: failure.code,
            retryable: failure.retryable,
            requirements: failure.requirements,
            backend: failure.backend,
          },
        )
      }

      const compare = response.data ?? {}
      const metrics: MetricPoint[] = (compare.rows ?? []).map((row) => ({
        family: row.family,
        name: row.name || "unknown",
        scope: row.componentType,
        component: row.component,
        value: row.perSecond ?? null,
        unit: row.unit,
        availability: compare.comparable ? "AVAILABLE" : "UNAVAILABLE",
        reason: compare.comparable ? null : compare.reason ?? null,
        verified: Boolean(compare.comparable),
        unavailable: !compare.comparable,
      }))

      const facts: Fact[] = [
        { key: "compare.comparable", value: Boolean(compare.comparable), source: "runtime.compare" },
        { key: "compare.reason", value: compare.reason ?? null, source: "runtime.compare" },
        { key: "compare.windowSeconds", value: compare.windowSeconds ?? windowSeconds, source: "runtime.compare" },
        { key: "compare.rows", value: (compare.rows ?? []).length, source: "runtime.compare" },
        { key: "compare.fromCapturedAt", value: compare.fromCapturedAt ?? null, source: "runtime.compare" },
        { key: "compare.toCapturedAt", value: compare.toCapturedAt ?? null, source: "runtime.compare" },
      ]

      const gaps: Gap[] = []
      if (!compare.comparable) {
        gaps.push({
          signal: "runtime.compare",
          reason: compare.reason || "服务端没有足够的快照样本，无法对比",
          code: "NOT_ENOUGH_SAMPLES",
          requirements: ["先成功调用两次 runtime/snapshot（间隔 ≥ windowSeconds），再执行 compare"],
        })
      }
      for (const warning of warningTexts(response.meta)) {
        gaps.push({ signal: "runtime.compare", reason: warning, code: CODES.SOURCE_DEGRADED, requirements: [] })
      }

      const pack: EvidencePack = {
        runId: args.runId,
        engine: scope.engine,
        step: "s2-compare",
        fingerprintVersion: undefined,
        scan: {
          bytes: Buffer.byteLength(JSON.stringify(compare), "utf8"),
          lines: 0,
          pages: 1,
          truncated: false,
          degraded: Boolean(response.meta?.degraded),
          degradationReason: warningTexts(response.meta).join("; ") || null,
        },
        signatures: [],
        metrics: metrics.slice(0, 200),
        facts,
        gaps,
        createdAt: nowIso(),
      }

      const dedupeKey = `runtime:compare|v1|${scope.engine}|${target.componentId}|${jobId}|${windowSeconds}|${runtimeMode}`
      const saved = saveEvidencePack(root, args.runId, "s2-compare", pack, dedupeKey)
      const spent = spend(root, args.runId, { calls: 1, bytes: pack.scan.bytes }, "s2-compare")

      return toolOk({
        runId: args.runId,
        jobId,
        comparable: Boolean(compare.comparable),
        reason: compare.reason ?? null,
        windowSeconds: compare.windowSeconds ?? windowSeconds,
        fromCapturedAt: compare.fromCapturedAt ?? null,
        toCapturedAt: compare.toCapturedAt ?? null,
        rowCount: (compare.rows ?? []).length,
        packPath: saved.path,
        reused: saved.reused,
        backend: response.backend ?? null,
        metrics: metrics.filter((metric) => metric.value !== null).slice(0, 15),
        warnings: compare.warnings ?? [],
        gaps,
        note: compare.comparable
          ? "perSecond 是快照窗口内的增量/秒；请与作业启动时长一起解释。"
          : "comparable=false：不能据此推断「无变化」，必须把原因写进报告。",
        budget: { callsLeft: spent.remaining.calls, bytesLeft: spent.remaining.bytes },
      })
    } catch (error) {
      return toolError(error)
    }
  },
})
