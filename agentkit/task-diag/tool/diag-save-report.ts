/**
 * S6 汇总与落盘（编排器独占）。
 *
 * 硬约束（防止措辞放大置信度）：
 * - 只从 `.diag/runs/<runId>/findings.json` 读结论，**不接受**模型在本工具参数里重述 verdict；
 * - 结论级别不得高于引擎画像声明的上限（超过就由本工具确定性下调，并写进 unknowns）；
 * - category=UNRESOLVED 时强制 rootCause=null / confidence=0 / level=L4；
 * - confidence<0.5 时不允许停在 L1/L2，一律下调到 L3。
 */
import fs from "node:fs"
import path from "node:path"
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import {
  CODES,
  REPORT_DIR,
  clampVerdict,
  findingsPath,
  profileOf,
  reportPath,
  type Level,
} from "../lib/constants"
import { toolError, toolFail, toolOk } from "../lib/http"
import { loadScope } from "../lib/scope"
import { FindingSchema, renderReport, type Finding, type Report } from "../lib/schema"
import { nowIso, readJson, writeJsonAtomic, writeTextAtomic } from "../lib/constants"

export default tool({
  description:
    "S6：读取 findings.json 渲染最终报告并落盘（diagnosis/*.md + *.json）。不得在参数里重述结论；结论级别超过引擎上限或置信度不足时会被确定性下调。",
  args: {
    runId: z.string().min(1).describe("运行 ID"),
    extraUnknowns: z.array(z.string()).optional().describe("额外需要标注为「未验证」的事项"),
    nextSteps: z
      .array(z.object({ action: z.string(), owner: z.string().optional(), expectedGain: z.string().optional() }))
      .optional()
      .describe("建议的下一步（只描述动作，不执行）"),
  },
  async execute(args, context) {
    try {
      const root = context.directory
      const scope = loadScope(root, args.runId)
      const profile = profileOf(scope.engine)

      const raw = readJson<unknown>(findingsPath(root, args.runId))
      if (!raw) {
        return toolFail(CODES.SCHEMA, `未找到 findings.json（runId=${args.runId}）。请先由引擎 agent 写入结论。`)
      }
      const parsed = FindingSchema.safeParse(raw)
      if (!parsed.success) {
        return toolFail(
          CODES.SCHEMA,
          `findings.json 不合法：${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
        )
      }
      const finding = parsed.data
      const ceiling: Level = profile?.ceiling ?? "L4"
      const clamped = clampVerdict({
        category: finding.verdict.category,
        level: finding.verdict.level,
        confidence: finding.verdict.confidence,
        ceiling,
      })

      const unknowns = [...finding.unknowns, ...clamped.notes, ...(args.extraUnknowns ?? [])]
      const diagnosable = (profile?.evidenceTier ?? "none") !== "none"

      const report: Report = {
        runId: args.runId,
        title: `${profile?.label ?? scope.engine} 任务诊断报告（${scope.mode === "FAILED" ? "失败排查" : "性能变慢"}）`,
        engine: scope.engine,
        mode: scope.mode,
        diagnosable,
        ceiling,
        ceilingReason: profile?.ceilingReason ?? "未登记引擎，无证据能力",
        evidenceTier: profile?.evidenceTier ?? "none",
        fingerprintVersion: undefined,
        target: scope.target ?? ({} as never),
        verdict: {
          category: finding.verdict.category,
          subCategory: finding.verdict.subCategory,
          rootCause: finding.verdict.category === "UNRESOLVED" ? null : finding.verdict.rootCause,
          confidence: finding.verdict.category === "UNRESOLVED" ? 0 : finding.verdict.confidence,
          level: clamped.level,
        },
        phase: finding.phase,
        evidence: finding.evidence,
        attempted: [],
        gaps: finding.gaps,
        unknowns,
        nextSteps: args.nextSteps ?? [],
        generatedAt: nowIso(),
      }

      const file = reportPath(root, {
        taskName: scope.target?.taskName,
        engine: scope.engine,
        mode: scope.mode,
      })
      fs.mkdirSync(path.join(root, REPORT_DIR), { recursive: true })
      writeTextAtomic(file, renderReport(report))
      writeJsonAtomic(file.replace(/\.md$/, ".json"), report)

      return toolOk({
        runId: args.runId,
        reportPath: path.relative(root, file),
        reportJsonPath: path.relative(root, file.replace(/\.md$/, ".json")),
        level: clamped.level,
        ceiling,
        clamped: clamped.notes.length > 0,
        clampNotes: clamped.notes,
        diagnosable,
      })
    } catch (error) {
      return toolError(error)
    }
  },
})
