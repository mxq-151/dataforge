/**
 * C1：作业代码分批提交（每批 ≤5 个）。
 * 提交即静态校验：命名/代码头/SQL 规范/参数/对象存在/指标标注/字段顺序。
 * 语法校验不在这里，由 dw-check-code 在 staging 上跑。
 */
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { buildMetaIndex } from "../lib/design-validator"
import { validateJob, validateUtil } from "../lib/code-validator"
import { designStatePath, jobsPath, loadMeta, nowIso, readJson, updateJson } from "../lib/constants"
import { JobSchema, UtilSchema, flattenIssues } from "../lib/schema"

const BATCH_LIMIT = 5

export default tool({
  description: `C1 分批提交作业代码（作业 + 公共 UDF，每批合计最多 ${BATCH_LIMIT} 个）。内置 W29–W35/W43/W46/W47 静态校验；通过后追加到 .dw/jobs.json，语法校验请随后调用 dw-check-code。`,
  args: {
    jobs: z.array(z.unknown()).default([]),
    utils: z.array(z.unknown()).default([]),
    note: z.string().optional(),
  },
  async execute(args, context) {
    const root = context.directory
    const design = readJson<any>(designStatePath(root))
    if (!design) {
      return JSON.stringify({ ok: false, code: "W28_DESIGN_NOT_FINALIZED", message: "缺少 .dw/design.json，请先调用 dw-extract-design" })
    }
    if (args.jobs.length + args.utils.length === 0) {
      return JSON.stringify({ ok: false, code: "E_EMPTY_BATCH", message: "本批至少要提交 1 个作业或公共 UDF" })
    }
    if (args.jobs.length + args.utils.length > BATCH_LIMIT) {
      return JSON.stringify({ ok: false, code: "E_BATCH_LIMIT", message: `单批合计最多 ${BATCH_LIMIT} 个作业/UDF` })
    }

    const meta = buildMetaIndex(loadMeta(root))
    let response = ""
    updateJson<{ jobs?: any[]; utils?: any[]; updatedAt?: string }>(jobsPath(root), (state) => {
      const existing = state?.jobs ?? []
      const existingUtils = state?.utils ?? []
      const names = new Set([...existing, ...existingUtils].map((job) => job.name))
      const ctx = {
        tables: design.tables ?? [],
        trace: design.trace ?? [],
        meta,
        jobNames: [
          ...new Set([
            ...((design.jobs ?? []) as any[]).map((job) => String(job.name)),
            ...existing.map((job) => String(job.name)),
          ]),
        ],
        workspaceRoot: root,
      }
      const rejected: { index: number; name: string | null; code: string; issues: string[] }[] = []
      const accepted: any[] = []
      const acceptedUtils: any[] = []

      args.jobs.forEach((raw, index) => {
        const parsed = JobSchema.safeParse(raw)
        if (!parsed.success) {
          rejected.push({ index, name: null, code: "W30_CODE_HEADER", issues: flattenIssues(parsed.error) })
          return
        }
        if (names.has(parsed.data.name)) {
          rejected.push({ index, name: parsed.data.name, code: "W29_JOB_NAME_PATH", issues: [`作业名 ${parsed.data.name} 已提交过`] })
          return
        }
        const issues = validateJob(parsed.data as any, ctx)
        if (issues.length) {
          rejected.push({
            index,
            name: parsed.data.name,
            code: issues[0].code,
            issues: issues.map((issue) => `${issue.code}: ${issue.message}`),
          })
          return
        }
        names.add(parsed.data.name)
        accepted.push(parsed.data)
      })

      if (rejected.length) {
        response = JSON.stringify({ ok: false, acceptedCount: 0, rejected, message: "整批未写入（批内原子）。按 index/code 修正后整批重提。" })
        return undefined
      }

      args.utils.forEach((raw, index) => {
        const parsed = UtilSchema.safeParse(raw)
        if (!parsed.success) {
          rejected.push({ index, name: null, code: "W43_PACKAGE_CLASS", issues: flattenIssues(parsed.error) })
          return
        }
        if (names.has(parsed.data.name)) {
          rejected.push({ index, name: parsed.data.name, code: "W43_PACKAGE_CLASS", issues: [`名称 ${parsed.data.name} 已提交过`] })
          return
        }
        const issues = validateUtil(parsed.data as any, root)
        if (issues.length) {
          rejected.push({
            index,
            name: parsed.data.name,
            code: issues[0].code,
            issues: issues.map((issue) => `${issue.code}: ${issue.message}`),
          })
          return
        }
        names.add(parsed.data.name)
        acceptedUtils.push(parsed.data)
      })

      if (rejected.length) {
        response = JSON.stringify({ ok: false, acceptedCount: 0, rejected, message: "整批未写入（批内原子）。按 index/code 修正后整批重提。" })
        return undefined
      }

      const jobs = [...existing, ...accepted.map((job) => ({ ...job, submittedAt: nowIso() }))]
      const utils = [...existingUtils, ...acceptedUtils.map((util) => ({ ...util, submittedAt: nowIso() }))]
      response = JSON.stringify({
        ok: true,
        file: ".dw/jobs.json",
        accepted: [...accepted.map((job) => job.name), ...acceptedUtils.map((util) => util.name)],
        total: jobs.length + utils.length,
        message: `本批 ${accepted.length} 个作业、${acceptedUtils.length} 个 UDF 已提交，累计 ${jobs.length + utils.length} 个。`,
      })
      return { jobs, utils, updatedAt: nowIso() }
    })
    return response
  },
})
