/**
 * 兜底分支：未登记引擎类型的「不可诊断」报告。
 *
 * 只用于**未登记**的类型（连 ENGINE_PROFILES 都没有）。已登记的九个引擎一律走各自 agent：
 * 即使它们当前没有可用通道，也要由引擎 agent 输出 UNRESOLVED + 缺口，而不是走这里——
 * 因为「哪些信号缺、缺哪个接口」是引擎画像的知识，不是通用模板能编出来的。
 *
 * 本工具零模型判断：不接收 verdict，不接收 rootCause，只做模板渲染。
 */
import fs from "node:fs"
import path from "node:path"
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import {
  CODES,
  ENGINE_PROFILES,
  REPORT_DIR,
  capabilitiesPath,
  newRunId,
  profileOf,
  reportPath,
  targetPath,
} from "../lib/constants"
import { toolError, toolFail, toolOk } from "../lib/http"
import { buildScope, saveScope, assertWorkspace } from "../lib/scope"
import { initBudget } from "../lib/budget"
import { TargetSchema, renderReport, type Report } from "../lib/schema"
import { nowIso, writeJsonAtomic, writeTextAtomic } from "../lib/constants"

export default tool({
  description:
    "兜底分支：为**未登记**的引擎类型生成「该类型不可诊断」报告（UNRESOLVED + 缺口清单）。已登记的九引擎不得调用本工具，应使用对应引擎 agent。",
  args: {
    engine: z.string().min(1).describe("未登记的引擎类型，例如 presto / trino / impala"),
    mode: z.enum(["FAILED", "SLOW"]).describe("诊断类型"),
    runId: z.string().optional().describe("已有 runId；不传则新建"),
    cluster: z.string().optional().describe("集群名，默认 default"),
    taskName: z.string().optional().describe("任务名"),
    taskRef: z.string().optional().describe("用户提供的任务引用（实例 ID / applicationId / jobId 之一）"),
    reason: z.string().optional().describe("为什么走到兜底分支（来自 resolve 或 capabilities）"),
  },
  async execute(args, context) {
    try {
      assertWorkspace(context.directory)
      const root = context.directory
      const cluster = args.cluster || "default"

      const registered = profileOf(args.engine)
      if (registered) {
        return toolFail(
          CODES.ENGINE_UNSUPPORTED,
          `${args.engine} 已登记（agent=${registered.agent}），不能走兜底分支。请把 runId 交给对应引擎 agent。`,
          { agent: registered.agent },
        )
      }

      const runId = args.runId || newRunId(args.engine)
      const target = TargetSchema.parse({
        engine: args.engine,
        cluster,
        taskName: args.taskName,
        deployMode: "unknown",
        ref: args.taskRef ? { hint: args.taskRef } : {},
      })

      const scope = buildScope({
        runId,
        engine: args.engine,
        mode: args.mode,
        target,
        availableChannelIds: [],
        unavailable: [],
        calls: 1,
      })
      saveScope(root, scope)
      initBudget(root, runId, { calls: 1, bytes: 0 })
      writeJsonAtomic(targetPath(root, runId), target)
      writeJsonAtomic(capabilitiesPath(root, runId), {
        runId,
        generatedAt: nowIso(),
        engines: [
          {
            engine: args.engine,
            cluster,
            diagnosable: "none",
            signals: [],
            diagnosisTypes: [],
            limits: {},
          },
        ],
        degraded: true,
      })

      const report: Report = {
        runId,
        title: `${args.engine} 任务诊断报告（该类型不可诊断）`,
        engine: args.engine,
        mode: args.mode,
        diagnosable: false,
        ceiling: "L4",
        ceilingReason: "该引擎类型未在 task-diag 中登记，没有任何证据通道定义",
        evidenceTier: "none",
        target,
        verdict: {
          category: "UNRESOLVED",
          rootCause: null,
          confidence: 0,
          level: "L4",
        },
        evidence: [],
        attempted: [
          {
            step: "S1",
            channel: "capabilities",
            result: "unsupported",
            note: args.reason || `引擎类型 ${args.engine} 未登记`,
          },
        ],
        gaps: [
          {
            signal: "全部诊断证据",
            reason: `dataforge-server 与 task-diag 均未支持引擎类型 ${args.engine}`,
            neededInterface:
              "先确认服务端是否有该引擎的日志/指标通道；若无，需要新增 ServiceType + LogAdapter（或在 /api/diagnosis/probe 增加白名单探针）后再登记引擎画像",
          },
        ],
        unknowns: ["该引擎是否存在可用的服务端日志源（未检查）"],
        nextSteps: [
          {
            action: `登记引擎画像：在 agentkit/task-diag/lib/constants.ts 的 ENGINE_PROFILES 增加 ${args.engine}`,
            owner: "开发",
            expectedGain: "登记后即可路由到专属诊断 agent",
          },
        ],
        generatedAt: nowIso(),
      }

      const file = reportPath(root, { taskName: args.taskName, engine: args.engine, mode: args.mode })
      fs.mkdirSync(path.join(root, REPORT_DIR), { recursive: true })
      writeTextAtomic(file, renderReport(report))
      writeJsonAtomic(file.replace(/\.md$/, ".json"), report)

      return toolOk({
        runId,
        diagnosable: false,
        reportPath: path.relative(root, file),
        reportJsonPath: path.relative(root, file.replace(/\.md$/, ".json")),
        agent: null,
        note: "报告已明确标注不可诊断，不含任何归因。",
        registeredEngines: Object.keys(ENGINE_PROFILES),
      })
    } catch (error) {
      return toolError(error)
    }
  },
})
