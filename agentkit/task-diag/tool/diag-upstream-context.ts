/**
 * S1.5 上游取证（编排器独占，全轮只调一次）。
 *
 * v1 下调度侧（DS）任务日志没有对应接口，因此这里改为
 * 采「引擎侧上游上下文」：`POST /api/telemetry/v1/discovery/query` 的 sources / jobs。
 * 作业侧证据（YARN / Spark / Flink 日志与指标）仍归对应引擎 agent，避免编排器与引擎 agent 各取一遍。
 */
import fs from "node:fs"
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { BUDGET, CODES, runtimeTargetOf, upstreamPath } from "../lib/constants"
import { toolError, toolOk } from "../lib/http"
import { failureOf, telemetryQuery, type DiscoveryData } from "../lib/telemetry"
import { loadScope, assertEngine } from "../lib/scope"
import { spend } from "../lib/budget"
import { nowIso, writeJsonAtomic } from "../lib/constants"
import type { Fact, Gap } from "../lib/schema"

const DISCOVERY_PATH = "/api/telemetry/v1/discovery/query"

export default tool({
  description:
    "S1.5：采集与引擎无关的上游上下文（v1 discovery 的运行态 sources / jobs），落 s0-upstream.json。全轮只需调用一次；引擎 agent 只读该文件，不得重取。",
  args: {
    runId: z.string().min(1).describe("运行 ID"),
  },
  async execute(args, context) {
    try {
      const root = context.directory
      const scope = loadScope(root, args.runId)
      assertEngine(scope, scope.engine)

      const facts: Fact[] = []
      const gaps: Gap[] = []
      const packPaths: string[] = []
      const taskInstanceId = scope.target?.taskInstanceId
      let calls = 0
      let bytes = 0

      if (taskInstanceId) {
        facts.push({ key: "ds.taskInstanceId", value: taskInstanceId, source: "target" })
        gaps.push({
          signal: "调度侧任务日志",
          reason: "v1 没有 ds 服务类型与调度侧日志接口，无法读取 DS 任务实例日志",
          code: "DATA_TYPE_NOT_IMPLEMENTED",
          requirements: ["需要后端新增调度侧任务日志接口；当前只能依赖引擎侧 discovery 与作业引用"],
          neededInterface: "需要后端新增调度侧任务日志接口；当前只能依赖引擎侧 discovery 与作业引用",
        })
      }

      const target = runtimeTargetOf(scope.engine)
      if (!target) {
        gaps.push({
          signal: "引擎运行时发现",
          reason: `v1 discovery 只覆盖 spark / flink，不支持 ${scope.engine}`,
          code: "NOT_SUPPORTED",
          requirements: ["需要后端新增该引擎的 RuntimeEngine 实现"],
          neededInterface: "需要后端新增该引擎的 RuntimeEngine 实现",
        })
      } else {
        calls += 1
        const sources = await callDiscovery(scope.engine, target, "sources", gaps)
        if (sources) {
          bytes += Buffer.byteLength(JSON.stringify(sources), "utf8")
          const source = sources.sources?.[0]
          facts.push({ key: "upstream.runtime.sourceCount", value: sources.sources?.length ?? 0, source: "discovery.sources" })
          if (source) {
            facts.push({ key: "upstream.runtime.backendId", value: source.backendId ?? null, source: "discovery.sources" })
            facts.push({ key: "upstream.runtime.mode", value: source.mode ?? null, source: "discovery.sources" })
            facts.push({
              key: "upstream.runtime.configured",
              value: source.baseUrlConfigured !== false,
              source: "discovery.sources",
            })
            facts.push({
              key: "upstream.runtime.supportedFamilies",
              value: (source.supportedFamilies ?? []).join(","),
              source: "discovery.sources",
            })
            const unavailable = Object.entries(source.unavailableFamilies ?? {})
            for (const [family, reason] of unavailable) {
              gaps.push({
                signal: `runtime.${family}`,
                reason,
                code: "NOT_SUPPORTED",
                requirements: [],
                neededInterface: "该指标族由引擎版本/端点决定，不能用其他族替代",
              })
            }
          }
        }

        calls += 1
        const jobs = await callDiscovery(scope.engine, target, "jobs", gaps)
        if (jobs) {
          bytes += Buffer.byteLength(JSON.stringify(jobs), "utf8")
          const list = jobs.jobs ?? []
          facts.push({ key: "upstream.jobs.count", value: list.length, source: "discovery.jobs" })
          const jobId = scope.target?.jobId || scope.target?.appId || scope.target?.applicationId
          if (jobId) {
            const matched = list.find((job) => job.jobId === jobId)
            facts.push({ key: "upstream.jobs.targetFound", value: Boolean(matched), source: "discovery.jobs" })
            if (matched) {
              facts.push({ key: "upstream.job.state", value: matched.state ?? null, source: "discovery.jobs" })
              facts.push({ key: "upstream.job.name", value: matched.name ?? null, source: "discovery.jobs" })
              facts.push({ key: "upstream.job.durationMs", value: matched.durationMs ?? null, source: "discovery.jobs" })
            } else {
              gaps.push({
                signal: "目标作业不在 discovery 列表",
                reason: `jobId=${jobId} 未出现在 ${scope.engine} discovery jobs 中`,
                code: "NOT_FOUND",
                requirements: ["确认 jobId / sourceMode（live/history）与作业是否已结束"],
                neededInterface: "确认 jobId / sourceMode（live/history）与作业是否已结束",
              })
            }
          }
        }
      }

      const payload = {
        runId: args.runId,
        engine: scope.engine,
        collectedAt: nowIso(),
        facts,
        gaps,
        packPaths,
      }
      const file = upstreamPath(root, args.runId)
      fs.mkdirSync(file.replace(/\/[^/]+$/, ""), { recursive: true })
      writeJsonAtomic(file, payload)

      const spent = spend(root, args.runId, { calls, bytes }, "s1.5-upstream")

      return toolOk({
        runId: args.runId,
        upstreamPath: file.replace(`${root}/`, ""),
        facts,
        gaps,
        packPaths,
        note: "引擎 agent 请只读该文件；不要重复读取上游上下文。",
        budget: { callsLeft: spent.remaining.calls, bytesLeft: spent.remaining.bytes },
      })
    } catch (error) {
      return toolError(error)
    }
  },
})

async function callDiscovery(
  engine: string,
  target: { serviceType: string; componentId: string; hostId: string },
  scope: "sources" | "jobs",
  gaps: Gap[],
): Promise<DiscoveryData | null> {
  try {
    const response = await telemetryQuery<DiscoveryData>(
      DISCOVERY_PATH,
      { scope, target, limit: 50 },
      BUDGET.apiTimeoutMs,
    )
    const failure = failureOf(response)
    if (failure) {
      gaps.push({
        signal: `upstream.discovery.${scope}`,
        reason: `${failure.code}: ${failure.message}`,
        code: failure.outcome === "unavailable" ? CODES.CHANNEL_UNAVAILABLE : CODES.SOURCE_DEGRADED,
        requirements: failure.requirements,
        neededInterface: `POST /api/telemetry/v1/discovery/query（scope=${scope}）`,
      })
      return null
    }
    return response.data ?? null
  } catch (error) {
    gaps.push({
      signal: `upstream.discovery.${scope}`,
      reason: error instanceof Error ? error.message : String(error),
      code: CODES.SOURCE_DEGRADED,
      requirements: [`确认 dataforge-server 已启动且 /api/telemetry/v1/discovery/query 可访问（engine=${engine}）`],
      neededInterface: `确认 dataforge-server 已启动且 /api/telemetry/v1/discovery/query 可访问（engine=${engine}）`,
    })
    return null
  }
}
