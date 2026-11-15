/**
 * D3：指标落地分批提交（每批 ≤10 条）。
 * 名称逐字继承需求、编码唯一、字段来源绑定真实字段、数据源与证据一致。
 */
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { loadMeta, loadReq, loadTables, metricsPath, nowIso, updateJson } from "../lib/constants"
import { MetricSchema, flattenIssues } from "../lib/schema"
import { buildMetaIndex, validateMetric } from "../lib/design-validator"

const BATCH_LIMIT = 10

export default tool({
  description: `D3 分批提交指标落地映射（每批最多 ${BATCH_LIMIT} 条）。校验名称逐字继承、编码 {项目编码}_NNNN 唯一、字段来源真实、数据源与证据一致、下钻维度可落地。`,
  args: {
    metrics: z.array(z.unknown()).min(1),
    note: z.string().optional(),
  },
  async execute(args, context) {
    const root = context.directory
    const req = loadReq(root)
    if (!req) {
      return JSON.stringify({ ok: false, code: "W01_REQ_MISSING", message: "缺少 .dw/req.json，请先调用 dw-extract-req" })
    }
    if (args.metrics.length > BATCH_LIMIT) {
      return JSON.stringify({ ok: false, code: "E_BATCH_LIMIT", message: `单批最多 ${BATCH_LIMIT} 条` })
    }

    const tables = loadTables(root)
    const meta = buildMetaIndex(loadMeta(root))
    const reqNames: string[] = (req.metrics ?? []).map((metric: any) => metric.name)

    let response = ""
    updateJson<{ metrics?: any[]; updatedAt?: string }>(metricsPath(root), (state) => {
      const existing: any[] = Array.isArray(state?.metrics) ? state!.metrics! : []
      const codes = new Set(existing.map((metric) => metric.code))
      const names = new Set(existing.map((metric) => metric.name))
      const rejected: { index: number; name: string | null; code: string; issues: string[] }[] = []
      const accepted: any[] = []

      args.metrics.forEach((raw, index) => {
        const parsed = MetricSchema.safeParse(raw)
        if (!parsed.success) {
          rejected.push({ index, name: null, code: "W15_METRIC_CODE", issues: flattenIssues(parsed.error) })
          return
        }
        const metric = parsed.data
        if (codes.has(metric.code)) {
          rejected.push({ index, name: metric.name, code: "W15_METRIC_CODE", issues: [`指标编码 ${metric.code} 已存在`] })
          return
        }
        if (names.has(metric.name)) {
          rejected.push({ index, name: metric.name, code: "W14_METRIC_NAME_MISMATCH", issues: [`指标名称「${metric.name}」已提交过；名称即主键，不得重复`] })
          return
        }
        const issues = validateMetric(metric, tables, reqNames, meta)
        if (issues.length) {
          rejected.push({ index, name: metric.name, code: issues[0].code, issues: issues.map((issue) => `${issue.code}: ${issue.message}`) })
          return
        }
        codes.add(metric.code)
        names.add(metric.name)
        accepted.push(metric)
      })

      if (rejected.length) {
        response = JSON.stringify({
          ok: false,
          acceptedCount: 0,
          rejected,
          message: "整批未写入（批内原子）。按 index/code 修正后整批重提。",
        })
        return undefined
      }

      const metrics = [...existing, ...accepted.map((metric) => ({ ...metric, submittedAt: nowIso() }))]
      const covered = new Set(metrics.map((metric) => metric.name))
      response = JSON.stringify({
        ok: true,
        file: ".dw/metrics.json",
        acceptedCodes: accepted.map((metric) => metric.code),
        total: metrics.length,
        coverage: `${covered.size}/${reqNames.length}`,
        pending: reqNames.filter((name) => !covered.has(name)),
        message: `本批 ${accepted.length} 条已提交，累计 ${metrics.length} 条，需求覆盖 ${covered.size}/${reqNames.length}。`,
      })
      return { metrics, updatedAt: nowIso() }
    })
    return response
  },
})
