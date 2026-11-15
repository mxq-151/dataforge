/**
 * 指标分批提交：内置 R08（全局唯一）/ R09（口径五项）/ R11（维度格式）/ R18（字段形状）即时校验。
 * 整批原子：任一条不通过则整批不落盘，返回逐条原因。
 */
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import {
  DIMENSION_NONE,
  METRIC_BATCH_LIMIT,
  nowIso,
  readJson,
  ruleOf,
  secPath,
  updateJson,
  workPath,
  type SectionState,
} from "../lib/constants"
import { MetricSchema, checkMetricShape } from "../lib/schema"

type Rejected = { index: number; name: string | null; rule: string; code: string; issues: string[] }

/** R11：维度写法（分隔符、层级箭头、「无」的独占性）。 */
function checkDimensionText(value: string): string[] {
  const issues: string[] = []
  if (value !== DIMENSION_NONE) {
    if (/[,，;；]/.test(value)) issues.push("多个维度请用「、」分隔，不要使用逗号或分号")
    if (/->/.test(value)) issues.push("层级请用「→」由粗到细，不要用半角 ->")
    if ((value.match(/（/g) ?? []).length !== (value.match(/）/g) ?? []).length) {
      issues.push("括号不闭合，层级说明请写成「时间（日→周→月）」")
    }
  } else if (value.trim() !== DIMENSION_NONE) {
    issues.push("确实无需下钻的指标请只填「无」")
  }
  return issues
}

export default tool({
  description: `分批提交第 3 章指标（每批最多 ${METRIC_BATCH_LIMIT} 条）。内置 R18 字段形状、R09 口径五项、R11 维度格式、R08 全局唯一性校验；整批通过才合并进 .work/sec3.json。`,
  args: {
    metrics: z.array(z.unknown()).min(1).describe(`指标数组，长度 <= ${METRIC_BATCH_LIMIT}`),
    note: z.string().optional().describe("本批次的说明，例如「第一批：交易域核心指标」"),
  },
  async execute(args, context) {
    const root = context.directory
    const batch = args.metrics
    const ruleR08 = ruleOf("R08")
    const ruleR09 = ruleOf("R09")
    const ruleR11 = ruleOf("R11")
    const ruleR18 = ruleOf("R18")

    if (batch.length > METRIC_BATCH_LIMIT) {
      return JSON.stringify({
        ok: false,
        code: "E_BATCH_LIMIT",
        message: `单批最多 ${METRIC_BATCH_LIMIT} 条，本次提交 ${batch.length} 条。请拆分后重提。`,
      })
    }

    const contextInfo = readJson<{ existingMetricNames?: string[] }>(workPath(root, "context.json"))
    const sec3File = secPath(root, 3)
    let response = ""
    updateJson<SectionState>(sec3File, (state) => {
      const accumulated: any[] = Array.isArray(state?.payload) ? (state!.payload as any[]) : []

      const taken = new Map<string, string>()
      for (const name of contextInfo?.existingMetricNames ?? []) taken.set(name, "目标文档已有指标")
      for (const metric of accumulated) {
        if (metric?.name) taken.set(metric.name, "本次会话已提交指标")
      }

      const rejected: Rejected[] = []
      const accepted: any[] = []

      batch.forEach((raw, index) => {
        const pushReject = (rule: string, code: string, issues: string[], name: string | null) => {
          rejected.push({ index, name, rule, code, issues })
        }

        const shape = checkMetricShape(raw)
        if (!shape.ok) {
          pushReject(ruleR18.id, ruleR18.code, shape.issues, null)
          return
        }
        const candidate = raw as any
        const name = typeof candidate.name === "string" ? candidate.name.trim() : null

        const dimensionIssues = typeof candidate.dimensions === "string" ? checkDimensionText(candidate.dimensions) : []
        if (dimensionIssues.length) {
          pushReject(ruleR11.id, ruleR11.code, dimensionIssues, name)
          return
        }

        const parsed = MetricSchema.safeParse(candidate)
        if (!parsed.success) {
          const issues = parsed.error.issues
          const caliberIssues = issues.filter((issue) => String(issue.path[0]) === "caliber")
          const dimensionSchemaIssues = issues.filter((issue) => String(issue.path[0]) === "dimensions")
          const rest = issues.filter(
            (issue) => String(issue.path[0]) !== "caliber" && String(issue.path[0]) !== "dimensions",
          )
          if (caliberIssues.length) {
            const caliberCount = Object.keys(candidate.caliber ?? {}).length
            pushReject(
              ruleR09.id,
              ruleR09.code,
              [
                ...caliberIssues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
                ...(caliberCount < 5 ? [`五项应齐备，当前仅 ${caliberCount} 项`] : []),
              ],
              name,
            )
            return
          }
          if (dimensionSchemaIssues.length) {
            pushReject(
              ruleR11.id,
              ruleR11.code,
              dimensionSchemaIssues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
              name,
            )
            return
          }
          pushReject(
            ruleR18.id,
            ruleR18.code,
            rest.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
            name,
          )
          return
        }

        const metricName = parsed.data.name.trim()
        const owner = taken.get(metricName)
        if (owner) {
          pushReject(ruleR08.id, ruleR08.code, [`指标名称「${metricName}」与${owner}重复，名称即全链路主键，不可重复定义`], metricName)
          return
        }
        taken.set(metricName, "本批已提交指标")
        accepted.push(parsed.data)
      })

      if (rejected.length) {
        response = JSON.stringify({
          ok: false,
          batchSize: batch.length,
          acceptedCount: 0,
          rejected,
          message: "整批未写入（批内原子）。按 rejected 逐条修正后重提，已通过的条目需一并重提。",
        })
        return undefined
      }

      const merged = [...accumulated, ...accepted]
      const nextState: SectionState = {
        chapter: 3,
        payload: merged,
        submittedAt: nowIso(),
        revision: (state?.revision ?? 0) + 1,
      }
      response = JSON.stringify({
        ok: true,
        batchSize: batch.length,
        acceptedCount: accepted.length,
        acceptedNames: accepted.map((metric) => metric.name),
        totalMetrics: merged.length,
        revision: nextState.revision,
        note: args.note ?? null,
        message: `本批 ${accepted.length} 条已合并，第 3 章当前共 ${merged.length} 条指标。`,
      })
      return nextState
    })
    return response
  },
})
