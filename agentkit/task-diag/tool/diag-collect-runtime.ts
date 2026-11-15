/**
 * S2.2 运行态指标快照。
 *
 * 只对画像里声明了指标族的引擎开放（spark / flink）。其余引擎调用会得到 D10，
 * 并且提示词要求它们「不要假装有 job / executor 级证据」。
 *
 * 指标语义（必须原样转述给模型）：
 * - 未注册或拼错的指标名不报错，直接缺席，服务端标 UNAVAILABLE；
 * - 因此「值为 0」与「取不到」是两件事，不得混为一谈。
 */
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { BUDGET, CODES, profileOf } from "../lib/constants"
import { requestJson, toolError, toolFail, toolOk } from "../lib/http"
import { assertEngine, loadScope, saveEvidencePack } from "../lib/scope"
import { spend } from "../lib/budget"
import { nowIso } from "../lib/constants"
import type { EvidencePack, Fact, Gap, MetricPoint } from "../lib/schema"

type RuntimeMetric = {
  name?: string
  family?: string
  component?: string
  componentType?: string
  value?: number | null
  unit?: string
  availability?: string
  reason?: string
}

type RuntimeComponent = {
  id?: string
  name?: string
  type?: string
  status?: string
  metrics?: RuntimeMetric[]
}

type RuntimeSnapshot = {
  jobId?: string
  jobName?: string
  state?: string
  mode?: string
  durationMs?: number
  capturedAt?: number
  degraded?: boolean
  degradationReason?: string
  errorCode?: string
  components?: RuntimeComponent[]
  jobMetrics?: RuntimeMetric[]
  unavailableFamilies?: Record<string, string>
  warnings?: string[]
}

export default tool({
  description:
    "S2.2：拉取引擎作业的运行态快照并落证据包，返回状态 + 指标摘要。只有 spark/flink 有指标族；其它引擎调用会返回 D10，不得用日志冒充指标。",
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

      const families = args.families && args.families.length > 0 ? args.families : profile.families
      const runtimeMode = args.runtimeMode ?? (scope.engine === "spark" ? "history" : "live")

      const snapshot = await requestJson<RuntimeSnapshot>(
        `/api/runtime/jobs/${encodeURIComponent(jobId)}/snapshot`,
        {
          query: {
            serviceType: scope.engine,
            cluster: scope.target?.cluster || "default",
            mode: runtimeMode,
            families,
            metrics: args.metrics,
            components: args.components,
          },
          timeoutMs: BUDGET.apiTimeoutMs,
        },
      )

      const metrics: MetricPoint[] = []
      const push = (metric: RuntimeMetric) => {
        if (!metric?.name) return
        metrics.push({
          family: metric.family,
          name: metric.name,
          scope: metric.componentType,
          component: metric.component,
          value: metric.value ?? null,
          verified: metric.availability ? metric.availability !== "UNAVAILABLE" : undefined,
          unavailable: metric.availability === "UNAVAILABLE",
        })
      }
      for (const metric of snapshot.jobMetrics ?? []) push(metric)
      for (const component of snapshot.components ?? []) {
        for (const metric of component.metrics ?? []) {
          push({ ...metric, component: metric.component || component.id || component.name })
        }
      }

      const facts: Fact[] = [
        { key: "job.state", value: snapshot.state ?? null, source: "runtime.snapshot" },
        { key: "job.name", value: snapshot.jobName ?? null, source: "runtime.snapshot" },
        { key: "job.durationMs", value: snapshot.durationMs ?? null, source: "runtime.snapshot" },
        { key: "runtime.mode", value: snapshot.mode ?? runtimeMode, source: "runtime.snapshot" },
        { key: "component.count", value: (snapshot.components ?? []).length, source: "runtime.snapshot" },
      ]

      const gaps: Gap[] = []
      for (const [family, reason] of Object.entries(snapshot.unavailableFamilies ?? {})) {
        gaps.push({
          signal: `runtime.${family}`,
          reason,
          code: CODES.SOURCE_DEGRADED,
          neededInterface: "检查 runtime.sources 配置与该引擎版本是否支持该指标族",
        })
      }
      if (snapshot.degraded) {
        gaps.push({
          signal: "runtime.snapshot",
          reason: snapshot.degradationReason || snapshot.errorCode || "上游降级",
          code: CODES.SOURCE_DEGRADED,
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
          degraded: Boolean(snapshot.degraded),
          degradationReason: snapshot.degradationReason,
        },
        signatures: [],
        metrics: metrics.slice(0, 200),
        facts,
        gaps,
        createdAt: nowIso(),
      }

      const dedupeKey = `runtime:snapshot|${jobId}|${families.sort().join(",")}|${runtimeMode}`
      const saved = saveEvidencePack(root, args.runId, "s2-runtime", pack, dedupeKey)
      const spent = spend(root, args.runId, { calls: 1, bytes: pack.scan.bytes }, "s2-runtime")

      const meaningful = metrics
        .filter((metric) => metric.value !== null && metric.unavailable !== true)
        .slice(0, 15)

      return toolOk({
        runId: args.runId,
        jobId,
        state: snapshot.state ?? null,
        degraded: Boolean(snapshot.degraded),
        packPath: saved.path,
        reused: saved.reused,
        componentCount: (snapshot.components ?? []).length,
        metricCount: metrics.length,
        unavailableFamilies: snapshot.unavailableFamilies ?? {},
        metrics: meaningful,
        warnings: snapshot.warnings ?? [],
        gaps,
        caveat: "值为 0 与「取不到」不同：unavailableFamilies 或 unavailable=true 表示取数失败，不要当作 0 参与推理。",
        budget: { callsLeft: spent.remaining.calls, bytesLeft: spent.remaining.bytes },
      })
    } catch (error) {
      return toolError(error)
    }
  },
})
