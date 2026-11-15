/**
 * S0 目标解析。
 *
 * v1 下没有 `ds` 服务类型，也没有调度侧任务日志接口，因此不再从 DS 任务日志首屏正则推导。
 * 两级解析改为：
 *   1. 显式强引用（applicationId / jobId）→ exact；
 *   2. 任务名 + 引擎 → `POST /api/telemetry/v1/discovery/query`（scope=jobs）精确匹配 → derived，
 *      并把「猜出来的」这个事实写进 evidence。
 * 解析不到就返回 D01，绝不自选一个候选往下走。
 */
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { CODES, BUDGET, channelsOf, profileOf, runtimeTargetOf } from "../lib/constants"
import { toolError, toolFail, toolOk } from "../lib/http"
import { failureOf, telemetryQuery, type DiscoveryData } from "../lib/telemetry"

const DISCOVERY_PATH = "/api/telemetry/v1/discovery/query"

type Candidate = {
  engine: string
  cluster: string
  confidence: "exact" | "derived" | "guessed"
  source: string
  refs: Record<string, string>
  channels: {
    serviceType: string
    componentId: string
    hostId: string
    dataTypeId: string
    stream: string
    refKey?: string
    requiredAnyRefs?: string[]
    label: string
  }[]
  deployMode: "cluster" | "client" | "unknown"
  evidence?: string
}

const FLINK_JOB_ID = /\b[0-9a-f]{32}\b/

function channelsFor(engine: string) {
  return channelsOf(engine).map((channel) => ({
    serviceType: channel.serviceType,
    componentId: channel.componentId,
    hostId: channel.hostId,
    dataTypeId: channel.dataTypeId,
    stream: channel.stream,
    refKey: channel.refKey,
    requiredAnyRefs: channel.requiredAnyRefs,
    label: channel.label,
  }))
}

export default tool({
  description:
    "S0：把用户给的任务引用解析成引擎与作业标识（engine + cluster + refs + deployMode）。只接受强引用或 v1 discovery 中可验证的任务名匹配；解析不到返回 D01，不要自行猜测。",
  args: {
    taskInstanceId: z.union([z.string(), z.number()]).optional().describe("DS 任务实例 ID（v1 已无调度侧日志接口，仅记录）"),
    integrationTaskId: z.union([z.string(), z.number()]).optional().describe("数据集成任务 ID（后端无详情接口，通常解析不到）"),
    applicationId: z.string().optional().describe("YARN application id，形如 application_1730000000000_0042"),
    jobId: z.string().optional().describe("引擎作业 ID（Flink 为 32 位十六进制）"),
    engine: z.string().optional().describe("用户已明确的引擎类型，用于收窄候选"),
    cluster: z.string().optional().describe("集群名，默认 default"),
    taskName: z.string().optional().describe("任务名，用于 discovery 精确匹配与报告文件名"),
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

      if (candidates.length === 0 && args.taskName && args.engine && runtimeTargetOf(args.engine)) {
        const target = runtimeTargetOf(args.engine)
        if (target) {
          try {
            const response = await telemetryQuery<DiscoveryData>(
              DISCOVERY_PATH,
              { scope: "jobs", target, limit: 50 },
              BUDGET.apiTimeoutMs,
            )
            const failure = failureOf(response)
            if (failure) {
              missing.push(`v1 discovery 读取作业失败：${failure.code} ${failure.message}`)
            } else {
              const jobs = response.data?.jobs ?? []
              const matched = jobs.filter((job) => job.name && job.name === args.taskName)
              for (const job of matched) {
                if (!job.jobId) continue
                if (args.engine === "spark") {
                  candidates.push({
                    engine: "spark",
                    cluster,
                    confidence: "derived",
                    source: "v1_discovery_jobs",
                    refs: { applicationId: job.jobId, appId: job.jobId },
                    channels: channelsFor("spark"),
                    deployMode: "cluster",
                    evidence: "v1 discovery jobs 中按任务名精确匹配到 Spark application id（需在报告中标注为 derived）",
                  })
                } else if (args.engine === "flink" && FLINK_JOB_ID.test(job.jobId)) {
                  candidates.push({
                    engine: "flink",
                    cluster,
                    confidence: "derived",
                    source: "v1_discovery_jobs",
                    refs: { jobId: job.jobId },
                    channels: channelsFor("flink"),
                    deployMode: "unknown",
                    evidence: "v1 discovery jobs 中按任务名精确匹配到 Flink jobId（需在报告中标注为 derived）",
                  })
                }
              }
              if (matched.length === 0) {
                const names = jobs
                  .map((job) => job.name)
                  .filter((name): name is string => Boolean(name))
                  .slice(0, 5)
                missing.push(
                  `v1 discovery jobs 中没有名称为「${args.taskName}」的作业${
                    names.length > 0 ? `（现有：${names.join("、")}）` : ""
                  }`,
                )
              }
            }
          } catch (error) {
            missing.push(`调用 v1 discovery jobs 失败：${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }

      if (args.taskInstanceId !== undefined && args.taskInstanceId !== null && candidates.length === 0) {
        missing.push(
          `taskInstanceId=${String(args.taskInstanceId)}：v1 没有 ds 服务类型与调度侧日志接口，无法再通过 DS 任务日志推导；请提供 applicationId / jobId / 精确任务名`,
        )
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
