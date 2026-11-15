/**
 * 结构化产出落盘（唯一写入口）：证据包 / 结论 / 交接包。
 *
 * 为什么要统一入口：
 * - 证据包按 channelKey 幂等，防止同一通道被取两次；
 * - 结论只能落成 findings.json，编排器再从磁盘读取渲染报告，
 *   从而在结构上杜绝「模型在渲染阶段复述并抬高置信度」；
 * - Hudi 复用 Spark 时的交接包也走这里，避免另开一条隐式通道。
 */
import fs from "node:fs"
import path from "node:path"
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { CODES, findingsPath } from "../lib/constants"
import { toolError, toolFail, toolOk } from "../lib/http"
import { assertEngine, loadScope, saveEvidencePack, saveHandoff } from "../lib/scope"
import { FindingSchema, type Finding } from "../lib/schema"
import { nowIso } from "../lib/constants"

export default tool({
  description:
    "把结构化产出落盘。kind=evidence 写证据包（按 channelKey 幂等）；kind=findings 写 findings.json（引擎 agent 专用，schema 校验）；kind=handoff 写引擎交接包（如 spark → hudi）。",
  args: {
    runId: z.string().min(1).describe("运行 ID"),
    kind: z.enum(["evidence", "findings", "handoff"]).describe("产出类型"),
    step: z.string().optional().describe("步骤名（kind=evidence 时用作文件名前缀），例如 s2-yarn-am"),
    dedupeKey: z.string().optional().describe("幂等键（kind=evidence/handoff），缺省用 step"),
    payload: z.record(z.string(), z.unknown()).optional().describe("kind=evidence/handoff 的负载"),
    finding: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("kind=findings 的结论：phase / verdict{category,rootCause,confidence,level} / evidence / gaps / unknowns"),
  },
  async execute(args, context) {
    try {
      const root = context.directory
      const scope = loadScope(root, args.runId)

      if (args.kind === "findings") {
        if (!args.finding) return toolFail(CODES.SCHEMA, "kind=findings 时必须提供 finding")
        const candidate = {
          ...args.finding,
          runId: args.runId,
          engine: scope.engine,
          mode: scope.mode,
          createdAt: nowIso(),
        }
        const parsed = FindingSchema.safeParse(candidate)
        if (!parsed.success) {
          return toolFail(
            CODES.SCHEMA,
            `findings 不合法：${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
          )
        }
        const finding: Finding = parsed.data
        assertEngine(scope, finding.engine)
        const file = findingsPath(root, args.runId)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, JSON.stringify(finding, null, 2), "utf8")
        return toolOk({
          runId: args.runId,
          kind: "findings",
          path: path.relative(root, file),
          level: finding.verdict.level,
          note: "结论已落盘。编排器会用 diag_save_report 读取并渲染，不得再改写 verdict。",
        })
      }

      if (args.kind === "handoff") {
        const saved = saveHandoff(root, args.runId, scope.engine, args.payload ?? {})
        return toolOk({ runId: args.runId, kind: "handoff", fromEngine: scope.engine, path: saved })
      }

      if (!args.payload) return toolFail(CODES.SCHEMA, "kind=evidence 时必须提供 payload")
      const step = args.step || "evidence"
      const pack = {
        ...args.payload,
        runId: args.runId,
        engine: scope.engine,
        step,
        createdAt: (args.payload.createdAt as string) ?? nowIso(),
      }
      const saved = saveEvidencePack(root, args.runId, step, pack, args.dedupeKey || step)
      return toolOk({
        runId: args.runId,
        kind: "evidence",
        path: saved.path,
        bytes: saved.bytes,
        reused: saved.reused,
      })
    } catch (error) {
      return toolError(error)
    }
  },
})
