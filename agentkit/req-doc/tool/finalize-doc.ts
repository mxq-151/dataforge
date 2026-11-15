/**
 * S3：渲染 + MD 校验 + 写盘（R16）。
 * 已存在目标文档时走 mergeDocs 增量合并，不覆盖已有内容；合并冲突直接阻断。
 * 本工具用 node:fs 原子写盘，不经过 write 工具，因此 guard 拦截的是「绕过本工具的写入」。
 */
import fs from "node:fs"
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import {
  CHAPTERS,
  docPath,
  loadSections,
  nowIso,
  readJson,
  ruleOf,
  updateJson,
  workPath,
  writeTextAtomic,
  type ChapterId,
} from "../lib/constants"
import { compactIssues, hasError, validateMarkdown } from "../lib/md-validator"
import { mergeDocs, renderDocument } from "../lib/render"

type LogicReport = { issues: { code: string; severity: string; chapter: number; message: string }[] }
type ReviewReport = { findings: { id: string; severity: string; status: string; chapter: number; claim: string }[] }

export default tool({
  description:
    "S3 收口（R16）：把 .work/sec1~sec9 渲染为需求文档，跑 Markdown 校验 R01–R07/R10/R15，检查 A/B 与 C 类结论，增量合并后原子写盘。任一门禁不过则不写盘并返回阻断原因。",
  args: {
    businessName: z.string().min(1),
    dryRun: z.boolean().optional().describe("仅渲染与校验，不写盘"),
  },
  async execute(args, context) {
    const root = context.directory
    const rule = ruleOf("R16")
    const blocking: { code: string; message: string }[] = []

    const sections = loadSections(root)
    const missing = CHAPTERS.filter((chapter) => sections[chapter.id] === undefined).map((chapter) => chapter.id)
    if (missing.length) {
      return JSON.stringify({
        ok: false,
        rule: rule.id,
        code: rule.code,
        blocking: [{ code: "E16_SECTION_MISSING", message: `缺少章节结构化数据：${missing.join(",")}` }],
        wrote: false,
      })
    }

    const markdown = renderDocument(args.businessName, sections)

    const mdIssues = validateMarkdown(markdown)
    if (hasError(mdIssues)) {
      blocking.push({ code: "E16_MD_INVALID", message: `Markdown 校验未通过：${compactIssues(mdIssues).join(" / ")}` })
    }

    const logic = readJson<LogicReport>(workPath(root, "logic-errors.json"))
    if (!logic) {
      blocking.push({ code: "E16_LOGIC_MISSING", message: "缺少 .work/logic-errors.json，请先跑 check-logic-graph" })
    } else {
      const errors = logic.issues.filter((issue) => issue.severity === "error")
      if (errors.length) {
        blocking.push({
          code: "E16_LOGIC_BLOCKED",
          message: `存在 ${errors.length} 条 error 级逻辑问题：${errors
            .slice(0, 5)
            .map((issue) => `${issue.code}@第${issue.chapter}章`)
            .join(",")}`,
        })
      }
    }

    const review = readJson<ReviewReport>(workPath(root, "review.json"))
    if (review) {
      const openBlockers = review.findings.filter((item) => item.status === "open" && item.severity === "blocker")
      if (openBlockers.length) {
        blocking.push({
          code: "E16_REVIEW_BLOCKED",
          message: `存在 ${openBlockers.length} 条未处理的 blocker 级审查结论：${openBlockers
            .slice(0, 5)
            .map((item) => item.id)
            .join(",")}`,
        })
      }
    }

    const target = docPath(root, args.businessName)
    const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : ""
    const merged = mergeDocs(existing, markdown)
    if (merged.conflicts.length) {
      blocking.push({
        code: "E16_MERGE_CONFLICT",
        message: `与目标文档冲突 ${merged.conflicts.length} 处（不覆盖已有内容）：${merged.conflicts
          .slice(0, 5)
          .map((conflict) => `第${conflict.chapter}章/${conflict.key}`)
          .join(",")}`,
      })
    }

    if (blocking.length) {
      return JSON.stringify({
        ok: false,
        rule: rule.id,
        code: rule.code,
        blocking,
        conflicts: merged.conflicts,
        mdIssues: compactIssues(mdIssues),
        wrote: false,
        message: "未写盘。按 blocking 逐条修正后重新调用 finalize-doc。",
      })
    }

    if (args.dryRun) {
      return JSON.stringify({
        ok: true,
        dryRun: true,
        mode: merged.mode,
        bytes: Buffer.byteLength(merged.content, "utf8"),
        mdIssues: compactIssues(mdIssues),
        wrote: false,
      })
    }

    // 写盘后回读再校验一次，防止合并过程引入结构破坏
    writeTextAtomic(target, merged.content)
    const verified = validateMarkdown(fs.readFileSync(target, "utf8"))
    if (hasError(verified)) {
      blocking.push({
        code: "E16_POSTCHECK_FAILED",
        message: `落盘后回读校验失败：${compactIssues(verified).join(" / ")}`,
      })
      return JSON.stringify({ ok: false, rule: rule.id, code: rule.code, blocking, wrote: true, target })
    }

    const contextFile = workPath(root, "context.json")
    updateJson<any>(contextFile, (current) => ({
      ...(current ?? {}),
      businessName: args.businessName,
      finalizedAt: nowIso(),
      docBytes: Buffer.byteLength(merged.content, "utf8"),
      metricCount: Array.isArray(sections[3 as ChapterId]) ? (sections[3 as ChapterId] as any[]).length : 0,
    }))

    return JSON.stringify({
      ok: true,
      mode: merged.mode,
      target: `${"docs"}/${args.businessName}_开发需求.md`,
      bytes: Buffer.byteLength(merged.content, "utf8"),
      wrote: true,
      message: merged.mode === "created" ? "文档已创建。" : "文档已增量合并，已有内容未被覆盖。",
    })
  },
})
