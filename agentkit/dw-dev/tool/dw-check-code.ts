/**
 * C2：静态复核 + staging + 语法校验（W36）。
 *
 * staging 是「可编译但未交付」的位置：先落 .dw/staging 再调 /sql-validate 或 /compile，
 * 通过后由 dw-finalize-code 搬到产物目录。服务不可用即失败，不允许「没报错就算过」。
 */
import fs from "node:fs"
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { checkSyntax, duplicateLogicIssues, metricOwnershipIssues, stagingPath, validateJob, validateUtil, writeStaging } from "../lib/code-validator"
import { buildMetaIndex } from "../lib/design-validator"
import {
  codeErrorsPath,
  designStatePath,
  jobsPath,
  loadMeta,
  nowIso,
  readJson,
  writeJsonAtomic,
} from "../lib/constants"

export default tool({
  description:
    "C2 代码校验：重跑 W29–W35/W43–W49 静态规则（作业 + 公共 UDF），把代码写入 .dw/staging，再调 DataForge 本地 /sql-validate 或 /compile 做语法校验（W36）。未在 DataForge 内运行导致服务不可用时 fail-closed。",
  args: {
    jobNames: z.array(z.string()).optional().describe("只校验指定作业；缺省校验全部"),
    syntax: z.boolean().optional().describe("默认 true；仅调试时可显式关闭，关闭会在结果中标记 skipped"),
  },
  async execute(args, context) {
    const root = context.directory
    const design = readJson<any>(designStatePath(root))
    if (!design) {
      return JSON.stringify({ ok: false, code: "W28_DESIGN_NOT_FINALIZED", message: "缺少 .dw/design.json，请先调用 dw-extract-design" })
    }
    const state = readJson<{ jobs: any[]; utils?: any[] }>(jobsPath(root))
    const allJobs: any[] = state?.jobs ?? []
    const allUtils: any[] = state?.utils ?? []
    if (!allJobs.length && !allUtils.length) {
      return JSON.stringify({ ok: false, code: "W37_FINALIZE_CODE_BLOCKED", message: "没有已提交的作业代码或公共 UDF" })
    }
    const jobs = args.jobNames?.length ? allJobs.filter((job) => args.jobNames!.includes(job.name)) : allJobs
    const utils = args.jobNames?.length ? allUtils.filter((util) => args.jobNames!.includes(util.name)) : allUtils
    if (!jobs.length && !utils.length) {
      return JSON.stringify({ ok: false, code: "W29_JOB_NAME_PATH", message: "指定作业名不存在" })
    }

    const ctx = {
      tables: design.tables ?? [],
      trace: design.trace ?? [],
      meta: buildMetaIndex(loadMeta(root)),
      jobNames: [...new Set([...((design.jobs ?? []) as any[]).map((job) => String(job.name)), ...allJobs.map((job) => String(job.name))])],
      workspaceRoot: root,
    }
    const selected = new Set([...jobs, ...utils].map((item) => item.name))
    const staticIssues = [
      ...jobs.flatMap((job) => validateJob(job, ctx)),
      ...utils.flatMap((util) => validateUtil(util, root)),
      ...metricOwnershipIssues(allJobs),
      ...duplicateLogicIssues([...allJobs, ...allUtils]).filter((issue) => selected.has(issue.unit.replace(/^(job|util):/, ""))),
    ]
    const passedJobs = jobs.filter((job) => !staticIssues.some((issue) => issue.unit === `job:${job.name}`))
    const passedUtils = utils.filter((util) => !staticIssues.some((issue) => issue.unit === `util:${util.name}`))

    const staged: string[] = []
    for (const job of [...jobs, ...utils]) {
      writeStaging(root, job as any)
      staged.push(stagingPath(root, job as any))
    }

    const syntax = await checkSyntax(
      root,
      [...passedJobs, ...passedUtils.map((util) => ({ ...util, kind: String(util.filePath).endsWith(".scala") ? "scala" : "java" }))] as any,
      { enabled: args.syntax !== false },
    )

    const ok = staticIssues.length === 0 && (syntax.status === "passed" || syntax.status === "skipped")
    writeJsonAtomic(codeErrorsPath(root), {
      generatedAt: nowIso(),
      jobs: [...allJobs, ...allUtils].map((item) => item.name),
      checked: [...jobs, ...utils].map((item) => item.name),
      static: staticIssues,
      syntax,
      ok,
    })

    const code =
      staticIssues.length > 0
        ? "W36_STATIC_FAILED"
        : syntax.status === "failed"
          ? "W36_SYNTAX_FAILED"
          : syntax.status === "unavailable"
            ? "W36_SYNTAX_UNAVAILABLE"
            : ok
              ? null
              : "W36_SYNTAX_FAILED"

    return JSON.stringify({
      ok,
      code: code ?? undefined,
      file: ".dw/code-errors.json",
      static: staticIssues.slice(0, 60),
      syntax: { status: syntax.status, endpoint: syntax.endpoint, errors: syntax.errors },
      staging: staged.map((file) => file.replace(`${root}/`, "")),
      message: ok
        ? syntax.status === "skipped"
          ? "静态规则通过；语法校验被显式跳过（仅调试，不建议交付）。"
          : "静态规则与语法校验均通过，可调用 dw-finalize-code 落盘。"
        : "存在未通过项：按 job 回退 dw-coder 修正后重新 dw-check-code。",
    })
  },
})
