/**
 * D4：稽核规则分批提交（每批 ≤20 条）。
 * 规则名唯一、类型取 7 类、对象真实、阈值可判定；每张表覆盖情况由 dw-validate-design 收口。
 */
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { loadMeta, loadTables, nowIso, qualityPath, updateJson } from "../lib/constants"
import { QualityRuleSchema, flattenIssues } from "../lib/schema"
import { buildMetaIndex, validateQuality } from "../lib/design-validator"

const BATCH_LIMIT = 20

export default tool({
  description: `D4 分批提交稽核规则（每批最多 ${BATCH_LIMIT} 条）。5 列契约、7 类规则类型、校验对象真实存在、阈值可判定；规则名唯一。`,
  args: {
    rules: z.array(z.unknown()).min(1),
    note: z.string().optional(),
  },
  async execute(args, context) {
    const root = context.directory
    if (args.rules.length > BATCH_LIMIT) {
      return JSON.stringify({ ok: false, code: "E_BATCH_LIMIT", message: `单批最多 ${BATCH_LIMIT} 条` })
    }
    const tables = loadTables(root)
    const meta = buildMetaIndex(loadMeta(root))

    let response = ""
    updateJson<{ rules?: any[]; updatedAt?: string }>(qualityPath(root), (state) => {
      const existing: any[] = Array.isArray(state?.rules) ? state!.rules! : []
      const names = new Set(existing.map((rule) => rule.name))
      const rejected: { index: number; name: string | null; code: string; issues: string[] }[] = []
      const accepted: any[] = []

      args.rules.forEach((raw, index) => {
        const parsed = QualityRuleSchema.safeParse(raw)
        if (!parsed.success) {
          rejected.push({ index, name: null, code: "W19_QUALITY_SHAPE", issues: flattenIssues(parsed.error) })
          return
        }
        const rule = parsed.data
        if (names.has(rule.name)) {
          rejected.push({ index, name: rule.name, code: "W21_QUALITY_COVERAGE", issues: [`规则名「${rule.name}」已存在`] })
          return
        }
        // 覆盖率在全局校验里判，这里只看单条规则本身
        const issues = validateQuality([rule], tables, meta).filter((issue) => !issue.unit.startsWith("table:"))
        if (issues.length) {
          rejected.push({ index, name: rule.name, code: issues[0].code, issues: issues.map((issue) => `${issue.code}: ${issue.message}`) })
          return
        }
        names.add(rule.name)
        accepted.push(rule)
      })

      if (rejected.length) {
        response = JSON.stringify({ ok: false, acceptedCount: 0, rejected, message: "整批未写入（批内原子）。" })
        return undefined
      }

      const rules = [...existing, ...accepted.map((rule) => ({ ...rule, submittedAt: nowIso() }))]
      response = JSON.stringify({
        ok: true,
        file: ".dw/quality.json",
        accepted: accepted.map((rule) => rule.name),
        total: rules.length,
        message: `本批 ${accepted.length} 条规则已提交，累计 ${rules.length} 条。`,
      })
      return { rules, updatedAt: nowIso() }
    })
    return response
  },
})
