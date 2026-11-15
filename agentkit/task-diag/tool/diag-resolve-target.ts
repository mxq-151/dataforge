/**
 * S0 目标解析。
 *
 * P0 期间后端没有 `/api/diagnosis/targets/resolve`（方案 D2），所以这里用两级解析：
 *   1. 显式强引用（applicationId / jobId）→ exact；
 *   2. DS 任务日志首屏正则 → derived，并把「猜出来的」这个事实写进 evidence。
 * 解析不到就返回 D01，绝不自选一个候选往下走。
 */
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { CODES, BUDGET, channelsOf, profileOf } from "../lib/constants"
import { requestJson, toolError, toolFail, toolOk } from "../lib/http"

type LogQueryResult = {
  content?: string
  lines?: string[]
  degraded?: boolean
  degradationReason?: string
  errorCode?: string
}

type Candidate = {
  engine: string
  cluster: string
  confidence: "exact" | "derived" | "guessed"
  source: string
  refs: Record<string, string>
  channels: { serviceType: string; logKind: string; componentRole: string; refKey: string; label: string }[]
  deployMode: "cluster" | "client" | "unknown"
  evidence?: string
}

const APP_ID = /\bapplication_\d{6,}_\d{3,}\b/
const FLINK_JOB_ID = /\b[0-9a-f]{32}\b/

function channelsFor(engine: string) {
  return channelsOf(engine).map((channel) => ({
    serviceType: channel.serviceType,
    logKind: channel.logKind,
    componentRole: channel.componentRole,
    refKey: channel.refKey,
    label: channel.label,
  }))
}

export default tool({
  description:
    "S0：把用户给的任务引用解析成引擎与作业标识（engine + cluster + refs + deployMode）。只接受强引用或 DS 日志首屏可验证的推理；解析不到返回 D01，不要自行猜测。",
  args: {
    taskInstanceId: z.union([z.string(), z.number()]).optional().describe("DS 任务实例 ID"),
    integrationTaskId: z.union([z.string(), z.number()]).optional().describe("数据集成任务 ID（后端详情接口尚未确认，通常解析不到）"),
    applicationId: z.string().optional().describe("YARN application id，形如 application_1730000000000_0042"),
    jobId: z.string().optional().describe("引擎作业 ID（Flink 为 32 位十六进制）"),
    engine: z.string().optional().describe("用户已明确的引擎类型，用于收窄候选"),
    cluster: z.string().optional().describe("集群名，默认 default"),
    taskName: z.string().optional().describe("任务名，用于报告文件名"),
    timeRange: z
      .object({ start: z.string().optional(), end: z.string().optional() })
      .optional()
      .describe("时间窗，形如 2026-11-15T09:00:00"),
  },
  async execute(args) {
    try {
      const cluster = args.cluster || "default"
      const candidates: Candidate[] = []
      const missing: string[] = []

      if (args.applicationId) {
        candidates.push({
          engine: "spark",
          cluster,
          confidence: "exact",
          source: "explicit.applicationId",
          refs: { applicationId: args.applicationId, appId: args.applicationId },
          channels: channelsFor("spark"),
          deployMode: "cluster",
          evidence: "调用方直接提供了 applicationId",
        })
      }

      if (args.jobId) {
        candidates.push({
          engine: "flink",
          cluster,
          confidence: "exact",
          source: "explicit.jobId",
          refs: { jobId: args.jobId },
          channels: channelsFor("flink"),
          deployMode: "unknown",
          evidence: "调用方直接提供了 jobId",
        })
      }

      if (args.taskInstanceId !== undefined && args.taskInstanceId !== null && candidates.length === 0) {
        const taskInstanceId = String(args.taskInstanceId)
        try {
          const result = await requestJson<LogQueryResult>("/api/logs/query", {
            method: "POST",
            body: {
              serviceType: "ds",
              cluster,
              logKind: "runtime",
              componentRole: "master",
              ref: { taskInstanceId },
              limit: 200,
              maxBytes: BUDGET.resolveScanBytes,
            },
            timeoutMs: BUDGET.apiTimeoutMs,
          })
          const text = result.content || (result.lines ?? []).join("\n")
          const app = APP_ID.exec(text)
          if (app) {
            candidates.push({
              engine: "spark",
              cluster,
              confidence: "derived",
              source: "ds_task_log_scan",
              refs: { taskInstanceId, applicationId: app[0], appId: app[0] },
              channels: channelsFor("spark"),
              deployMode: "cluster",
              evidence: "DS 任务日志首屏匹配到 application id（需在报告中标注为 derived）",
            })
          } else {
            const job = FLINK_JOB_ID.exec(text)
            if (job) {
              candidates.push({
                engine: "flink",
                cluster,
                confidence: "derived",
                source: "ds_task_log_scan",
                refs: { taskInstanceId, jobId: job[0] },
                channels: channelsFor("flink"),
                deployMode: "unknown",
                evidence: "DS 任务日志首屏匹配到 32 位作业 ID（可能是 Flink jobId，也可能是其它十六进制串）",
              })
            } else {
              missing.push("DS 任务日志里没有出现 application_* 或 32 位作业 ID")
            }
          }
          if (result.degraded) {
            missing.push(`DS 日志源降级：${result.degradationReason || result.errorCode || "未给出原因"}`)
          }
        } catch (error) {
          missing.push(`读取 DS 任务日志失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }

      if (args.integrationTaskId !== undefined && args.integrationTaskId !== null && candidates.length === 0) {
        missing.push("集成任务详情接口未确认，无法从 integrationTaskId 解析 jobId")
      }

      const filtered = args.engine
        ? candidates.filter((candidate) => candidate.engine === args.engine)
        : candidates

      if (filtered.length === 0) {
        return toolFail(
          CODES.TARGET_UNRESOLVED,
          "无法解析出唯一的诊断目标。请向用户补问：任务实例 ID / applicationId / jobId 中的任意一个，或提供任务名与时间窗。",
          {
            missing,
            hint: "不要自行选择一个引擎或作业继续下结论。",
          },
        )
      }

      if (filtered.length > 1) {
        return toolOk({
          resolved: false,
          ambiguous: true,
          code: CODES.TARGET_AMBIGUOUS,
          candidates: filtered,
          message: "存在多个候选，必须先向用户确认是哪一个。",
        })
      }

      const chosen = filtered[0]
      const profile = profileOf(chosen.engine)
      return toolOk({
        resolved: true,
        ambiguous: false,
        candidate: chosen,
        engine: chosen.engine,
        engineLabel: profile?.label ?? chosen.engine,
        ceiling: profile?.ceiling ?? "L4",
        ceilingReason: profile?.ceilingReason ?? "未登记引擎",
        evidenceTier: profile?.evidenceTier ?? "none",
        degradeChain: profile?.degradeChain ?? [],
        taskName: args.taskName,
        timeRange: args.timeRange,
        missing,
        note:
          chosen.confidence === "exact"
            ? "强引用可直接进入能力判定与路由。"
            : "derived/guessed 级别：报告中必须标注为推测来源，结论最高 L3。",
      })
    } catch (error) {
      return toolError(error)
    }
  },
})
