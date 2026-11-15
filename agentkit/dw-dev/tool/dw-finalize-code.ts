/**
 * C3：代码落盘门禁（W37）。
 *
 * 只搬 staging 里已通过校验的文件；已存在同名文件且内容不同一律记冲突、不覆盖。
 * 写入走 node:fs，dw-* agent 的 edit 权限拿不到这条路径。
 */
import crypto from "node:crypto"
import path from "node:path"
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { stagingPath } from "../lib/code-validator"
import {
  codeErrorsPath,
  codeManifestPath,
  designStatePath,
  jobsPath,
  loadReview,
  nowIso,
  readJson,
  readText,
  writeJsonAtomic,
  writeTextAtomic,
} from "../lib/constants"

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex")
}

export default tool({
  description:
    "C3 代码落盘：校验 .dw/code-errors.json 覆盖全部作业且 ok、无 open blocker、目标文件无冲突，然后把 staging 文件写入 sql/{层}/、code/{层}/ 并记录 sha256 清单。",
  args: {
    dryRun: z.boolean().optional(),
  },
  async execute(args, context) {
    const root = context.directory
    const design = readJson<any>(designStatePath(root))
    const stored = readJson<{ jobs: any[]; utils?: any[] }>(jobsPath(root))
    const jobs: any[] = stored?.jobs ?? []
    const utils: any[] = stored?.utils ?? []
    const allFiles = [...jobs, ...utils]
    if (!design || !allFiles.length) {
      return JSON.stringify({ ok: false, code: "W37_FINALIZE_CODE_BLOCKED", message: "缺少作业计划或作业代码" })
    }
    const report = readJson<any>(codeErrorsPath(root))
    const blocking: { code: string; message: string }[] = []
    if (!report) {
      blocking.push({ code: "W36_NOT_RUN", message: "从未执行 dw-check-code" })
    } else {
      if (!report.ok) blocking.push({ code: "W36_NOT_PASSED", message: "最近一次代码校验未通过" })
      const checkedAll = allFiles.every((job) => (report.checked ?? []).includes(job.name))
      if (!checkedAll) blocking.push({ code: "W36_STALE", message: "有作业在最近一次校验之后才提交，请重跑 dw-check-code" })
      const staticCount = (report.static ?? []).length
      if (staticCount) blocking.push({ code: "W36_STATIC_FAILED", message: `仍有 ${staticCount} 条静态问题` })
      if (report.syntax?.status === "unavailable") {
        blocking.push({ code: "W36_SYNTAX_UNAVAILABLE", message: "语法校验服务不可用，未验证的代码不落盘" })
      }
      if (report.syntax?.status === "failed") {
        blocking.push({ code: "W36_SYNTAX_FAILED", message: "语法校验未通过" })
      }
    }

    const openBlockers = loadReview(root, "code").filter((finding) => finding.status === "open" && finding.severity === "blocker")
    if (openBlockers.length) {
      blocking.push({
        code: "W38_REVIEW_BLOCKED",
        message: `存在 ${openBlockers.length} 条未处理的代码 blocker：${openBlockers.slice(0, 6).map((item) => item.id).join(",")}`,
      })
    }

    const plan: { job: string; path: string; content: string; sha256: string; action: "write" | "skip" }[] = []
    const conflicts: { job: string; path: string }[] = []
    for (const job of allFiles) {
      const staged = readText(stagingPath(root, job))
      const content = staged ?? String(job.code ?? "")
      if (!content.trim()) {
        blocking.push({ code: "W37_EMPTY_CODE", message: `作业 ${job.name} 没有代码内容` })
        continue
      }
      const relative = String(job.filePath)
      const absolute = path.join(root, ...relative.split("/"))
      const existing = readText(absolute)
      if (existing !== null && existing !== content) {
        conflicts.push({ job: job.name, path: relative })
        continue
      }
      plan.push({ job: job.name, path: relative, content, sha256: sha256(content), action: existing === content ? "skip" : "write" })
    }
    for (const conflict of conflicts) {
      blocking.push({ code: "W37_FILE_CONFLICT", message: `${conflict.path} 已存在且内容不同，不覆盖；请先确认差异或改作业名` })
    }

    if (blocking.length) {
      return JSON.stringify({ ok: false, code: "W37_FINALIZE_CODE_BLOCKED", blocking, conflicts, wrote: false })
    }
    if (args.dryRun) {
      return JSON.stringify({ ok: true, dryRun: true, plan: plan.map((item) => ({ job: item.job, path: item.path, action: item.action })), wrote: false })
    }

    for (const item of plan.filter((entry) => entry.action === "write")) {
      writeTextAtomic(path.join(root, ...item.path.split("/")), item.content)
    }

    const manifest = {
      generatedAt: nowIso(),
      designDoc: design.designDoc,
      files: plan.map((item) => ({ job: item.job, path: item.path, sha256: item.sha256, bytes: Buffer.byteLength(item.content, "utf8") })),
      skipped: plan.filter((item) => item.action === "skip").map((item) => item.path),
    }
    writeJsonAtomic(codeManifestPath(root), manifest)

    return JSON.stringify({
      ok: true,
      wrote: true,
      file: ".dw/code-manifest.json",
      files: plan.map((item) => ({ path: item.path, action: item.action })),
      conflicts: [],
      message: `已落盘 ${plan.filter((item) => item.action === "write").length} 个文件，跳过 ${plan.filter((item) => item.action === "skip").length} 个内容相同的文件。`,
    })
  },
})
