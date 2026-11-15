/**
 * S2.2 运行态指标快照（telemetry v1）。
 *
 * v1 契约：`POST /api/telemetry/v1/runtime/snapshot`
 * - target 四层身份（serviceType / componentId / hostId）；
 * - jobId 必填；sourceMode = live | history；
 * - 指标项固定 { name, family, sourceMetric, value, unit, availability, reason }；
 *   `UNAVAILABLE` / `NOT_SUPPORTED` 时 value 必须为 null，禁止把缺失值当 0。
 *
 * 只对画像里声明了指标族的引擎开放（spark / flink）。其余引擎调用会得到 D10，
 * 并且提示词要求它们「不要假装有 job / executor 级证据」。
 */
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { BUDGET, CODES, profileOf, runtimeTargetOf } from "../lib/constants"
import { toolError, toolFail, toolOk } from "../lib/http"
import {
  failureOf,
  telemetryQuery,
  warningTexts,
  type RuntimeComponentView,
  type RuntimeMetricView,
  type SnapshotData,
} from "../lib/telemetry"
import { assertEngine, loadScope, saveEvidencePack } from "../lib/scope"
import { spend } from "../lib/budget"
import { nowIso } from "../lib/constants"
import type { EvidencePack, Fact, Gap, MetricPoint } from "../lib/schema"

const SNAPSHOT_PATH = "/api/telemetry/v1/runtime/snapshot"

export default tool({
  description:
    "S2.2：拉取引擎作业的 v1 运行态快照并落证据包，返回状态 + 指标摘要。只有 spark/flink 有指标族；其它引擎调用会返回 D10，不得用日志冒充指标。",
  args: {
    runId: z.string().min(1).describe("运行 ID"),
    jobId: z.string().optional().describe("作业 ID；缺省时从 target.ref 推导"),
    families: z.array(z.string()).optional().describe("指标族，例如 checkpoint / backpressure / jvm_gc"),
    components: z.array(z.string()).optional().describe("限定组件（TM / executor id）"),
    metrics: z.array(z.string()).optional().describe("显式追加原始指标名"),
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
          `引擎 ${scope.engine} 没有运行态指标通道。不要用日志或主观描述冒充 job/executor 级证据。`,
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

      const families = args.families && args.families.length > 0 ? args.families : profile.families
      const runtimeMode = args.runtimeMode ?? (scope.engine === "spark" ? "history" : "live")

      const response = await telemetryQuery<SnapshotData>(
        SNAPSHOT_PATH,
        {
          target,
          sourceMode: runtimeMode,
          jobId,
          families,
          metrics: args.metrics,
          components: args.components,
          includeConfig: false,
        },
        BUDGET.apiTimeoutMs,
      )

      const failure = failureOf(response)
      if (failure) {
        return toolFail(
          failure.outcome === "failed" ? CODES.API_UNAVAILABLE : CODES.CHANNEL_UNAVAILABLE,
          `v1 运行态快照失败：${failure.code} ${failure.message}`,
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

      const snapshot = response.data ?? {}
      const metrics: MetricPoint[] = []
      const pushMetric = (metric: RuntimeMetricView, component?: RuntimeComponentView) => {
        const name = metric.name || metric.sourceMetric
        if (!name) return
        const availability = metric.availability || "UNAVAILABLE"
        const hasValue = availability === "AVAILABLE" || availability === "ZERO"
        metrics.push({
          family: metric.family,
          name,
          scope: component?.type,
          component: component?.id || component?.name,
          sourceMetric: metric.sourceMetric,
          value: hasValue ? (metric.value ?? null) : null,
          unit: metric.unit,
          availability,
          reason: metric.reason ?? null,
          verified: hasValue,
          unavailable: !hasValue,
        })
      }
      for (const metric of snapshot.jobMetrics ?? []) pushMetric(metric)
      for (const component of snapshot.components ?? []) {
        for (const metric of component.metrics ?? []) pushMetric(metric, component)
      }

      const checkpoint = snapshot.checkpoint
      const facts: Fact[] = [
        { key: "job.state", value: snapshot.state ?? null, source: "runtime.snapshot" },
        { key: "job.name", value: snapshot.jobName ?? null, source: "runtime.snapshot" },
        { key: "job.durationMs", value: snapshot.durationMs ?? null, source: "runtime.snapshot" },
        { key: "runtime.mode", value: response.mode ?? runtimeMode, source: "runtime.snapshot" },
        { key: "snapshot.capturedAt", value: snapshot.capturedAt ?? null, source: "runtime.snapshot" },
        { key: "component.count", value: (snapshot.components ?? []).length, source: "runtime.snapshot" },
        { key: "checkpoint.completed", value: checkpoint?.completed ?? null, source: "runtime.snapshot" },
        { key: "checkpoint.failed", value: checkpoint?.failed ?? null, source: "runtime.snapshot" },
        { key: "checkpoint.restored", value: checkpoint?.restored ?? null, source: "runtime.snapshot" },
        {
          key: "checkpoint.latestFailedReason",
          value: checkpoint?.latestFailedReason ?? null,
          source: "runtime.snapshot",
        },
        { key: "runtime.backend", value: backendLabel(response.backend), source: "runtime.snapshot" },
      ]

      const gaps: Gap[] = []
      for (const [family, reason] of Object.entries(snapshot.unavailableFamilies ?? {})) {
        gaps.push({
          signal: `runtime.${family}`,
          reason,
          code: "NOT_SUPPORTED",
          requirements: [`该引擎不提供 ${family} 指标族；不要用其他族替代`],
        })
      }
      if (checkpoint && checkpoint.available === false && checkpoint.reason) {
        gaps.push({
          signal: "runtime.checkpoint",
          reason: checkpoint.reason,
          code: "NOT_SUPPORTED",
          requirements: ["该引擎或端点不提供 checkpoint；不要用 0 冒充"],
        })
      }
      for (const warning of warningTexts(response.meta)) {
        gaps.push({
          signal: "runtime.snapshot",
          reason: warning,
          code: CODES.SOURCE_DEGRADED,
          requirements: [],
        })
      }

      const pack: EvidencePack = {
        runId: args.runId,
        engine: scope.engine,
        step: "s2-runtime",
        fingerprintVersion: undefined,
        scan: {
          bytes: Buffer.byteLength(JSON.stringify(snapshot), "utf8"),
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

      const dedupeKey = `runtime:snapshot|v1|${scope.engine}|${target.componentId}|${jobId}|${families
        .slice()
        .sort()
        .join(",")}|${runtimeMode}`
      const saved = saveEvidencePack(root, args.runId, "s2-runtime", pack, dedupeKey)
      const spent = spend(root, args.runId, { calls: 1, bytes: pack.scan.bytes }, "s2-runtime")

      const meaningful = metrics
        .filter((metric) => metric.value !== null && metric.unavailable !== true)
        .slice(0, 15)

      return toolOk({
        runId: args.runId,
        jobId,
        state: snapshot.state ?? null,
        jobName: snapshot.jobName ?? null,
        sourceMode: response.mode ?? runtimeMode,
        degraded: Boolean(response.meta?.degraded),
        backend: response.backend ?? null,
        packPath: saved.path,
        reused: saved.reused,
        componentCount: (snapshot.components ?? []).length,
        metricCount: metrics.length,
        checkpoint: checkpoint ?? null,
        unavailableFamilies: snapshot.unavailableFamilies ?? {},
        metrics: meaningful,
        warnings: snapshot.warnings ?? [],
        gaps,
        caveat: "值为 0 与「取不到」不同：availability=UNAVAILABLE/NOT_SUPPORTED 表示取数失败，不要当作 0 参与推理。",
        budget: { callsLeft: spent.remaining.calls, bytesLeft: spent.remaining.bytes },
      })
    } catch (error) {
      return toolError(error)
    }
  },
})

function backendLabel(backend: unknown): string {
  if (!backend || typeof backend !== "object") return "unknown"
  const selected = (backend as { selected?: { backendId?: string; backendType?: string } }).selected
  if (!selected) return "unknown"
  return `${selected.backendId ?? ""}/${selected.backendType ?? ""}`
}
