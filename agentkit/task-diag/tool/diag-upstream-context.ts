/**
 * S1.5 上游取证（编排器独占，全轮只调一次）。
 *
 * 归属边界：这里只取「与引擎无关」的上游证据——DS 任务实例日志。
 * 作业侧证据（YARN / Spark / Flink 日志与指标）一律归对应引擎 agent，
 * 避免编排器与引擎 agent 各取一遍。
 */
import fs from "node:fs"
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { BUDGET, CODES, upstreamPath } from "../lib/constants"
import { requestJson, toolError, toolOk } from "../lib/http"
import { loadScope, saveEvidencePack, assertEngine } from "../lib/scope"
import { spend } from "../lib/budget"
import { fingerprint } from "../lib/signature"
import { nowIso, writeJsonAtomic } from "../lib/constants"
import type { EvidencePack, Fact, Gap } from "../lib/schema"

type LogQueryResult = {
  content?: string
  lines?: string[]
  degraded?: boolean
  degradationReason?: string
  errorCode?: string
  byteSize?: number
}

export default tool({
  description:
    "S1.5：采集与引擎无关的上游证据（DS 任务实例日志首屏），落 s0-upstream.json 并顺带落一份指纹证据包。全轮只需调用一次；引擎 agent 只读该文件，不得重取。",
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
      let scannedBytes = 0
      let calls = 1

      if (!taskInstanceId) {
        gaps.push({
          signal: "调度侧证据",
          reason: "本次运行没有 taskInstanceId，跳过 DS 任务日志",
          neededInterface: "无需新增接口：从任务详情页进入诊断即可带上 taskInstanceId",
        })
      } else {
        try {
          const result = await requestJson<LogQueryResult>("/api/logs/query", {
            method: "POST",
            body: {
              serviceType: "ds",
              cluster: scope.target?.cluster || "default",
              logKind: "runtime",
              componentRole: "master",
              ref: { taskInstanceId },
              limit: 300,
              maxBytes: BUDGET.resolveScanBytes,
            },
            timeoutMs: BUDGET.apiTimeoutMs,
          })
          const lines = result.lines && result.lines.length > 0 ? result.lines : (result.content ?? "").split("\n")
          const printed = fingerprint(lines, {
            maxSignatures: BUDGET.maxSignatures,
            samplesPerSignature: BUDGET.samplesPerSignature,
          })
          scannedBytes += result.byteSize ?? Buffer.byteLength(lines.join("\n"), "utf8")

          const pack: EvidencePack = {
            runId: args.runId,
            engine: scope.engine,
            step: "s1.5-ds",
            channel: { serviceType: "ds", logKind: "runtime", componentRole: "master", ref: { taskInstanceId } },
            fingerprintVersion: printed.version,
            scan: {
              bytes: scannedBytes,
              lines: printed.scannedLines,
              pages: 1,
              truncated: Boolean(result.degraded),
              degraded: Boolean(result.degraded),
              degradationReason: result.degradationReason,
            },
            signatures: printed.signatures,
            metrics: [],
            facts: [],
            gaps: result.degraded
              ? [
                  {
                    signal: "DS 任务日志",
                    reason: result.degradationReason || result.errorCode || "上游降级",
                    code: CODES.SOURCE_DEGRADED,
                  },
                ]
              : [],
            createdAt: nowIso(),
          }
          const saved = saveEvidencePack(root, args.runId, "s1.5-ds", pack, `ds|${taskInstanceId}`)
          packPaths.push(saved.path)

          facts.push({ key: "ds.log.readable", value: !result.degraded, source: "logs.query(ds)" })
          facts.push({ key: "ds.log.errorSignatures", value: printed.signatures.filter((s) => s.level === "ERROR" || s.level === "FATAL").length, source: "fingerprint" })
          if (result.degraded) {
            gaps.push({
              signal: "DS 任务日志",
              reason: result.degradationReason || result.errorCode || "上游降级",
              code: CODES.SOURCE_DEGRADED,
              neededInterface: "检查 DolphinScheduler 地址与 worker 日志可读性（无需新增接口）",
            })
          }
        } catch (error) {
          gaps.push({
            signal: "DS 任务实例日志",
            reason: error instanceof Error ? error.message : String(error),
            code: CODES.SOURCE_DEGRADED,
            neededInterface: "检查 logs.sources 中 ds 源的 base-url 与权限（无需新增接口）",
          })
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

      const spent = spend(root, args.runId, { calls, bytes: scannedBytes }, "s1.5-upstream")

      return toolOk({
        runId: args.runId,
        upstreamPath: file.replace(`${root}/`, ""),
        facts,
        gaps,
        packPaths,
        note: "引擎 agent 请只读该文件；不要重复读取 DS 日志。",
        budget: { callsLeft: spent.remaining.calls, bytesLeft: spent.remaining.bytes },
      })
    } catch (error) {
      return toolError(error)
    }
  },
})
