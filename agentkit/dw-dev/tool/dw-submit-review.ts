/**
 * C 类语义审查结论收集（设计/代码两阶段）。
 * 证据是硬门槛：没有原文证据的结论在 schema 层就被拒。
 */
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { nowIso, reviewPath, updateJson } from "../lib/constants"
import { CODE_REVIEW_CATEGORIES, DESIGN_REVIEW_CATEGORIES, ReviewFindingSchema, flattenIssues } from "../lib/schema"

export default tool({
  description:
    "收集 C 类语义审查结论（phase=design|code），每条必须带原文/代码证据。结论累积到 .dw/review.json，finalize 工具读取 open blocker 做门禁。",
  args: {
    phase: z.enum(["design", "code"]),
    findings: z.array(z.unknown()).min(1),
  },
  async execute(args, context) {
    const root = context.directory
    const allowed: readonly string[] = args.phase === "design" ? DESIGN_REVIEW_CATEGORIES : CODE_REVIEW_CATEGORIES
    const rejected: { index: number; issues: string[] }[] = []
    const incoming: any[] = []
    args.findings.forEach((raw, index) => {
      const parsed = ReviewFindingSchema.safeParse(raw)
      if (!parsed.success) {
        rejected.push({ index, issues: flattenIssues(parsed.error) })
        return
      }
      if (!allowed.includes(parsed.data.category)) {
        rejected.push({ index, issues: [`category ${parsed.data.category} 不属于 ${args.phase} 阶段（可选：${allowed.join("/")}）`] })
        return
      }
      if (parsed.data.evidence.trim().length < 8) {
        rejected.push({ index, issues: ["evidence 必须是原文/代码片段，不能是「已检查」这类空话"] })
        return
      }
      incoming.push(parsed.data)
    })

    if (rejected.length) {
      return JSON.stringify({
        ok: false,
        code: "W38_REVIEW_EVIDENCE",
        rejected,
        message: "存在不合格结论，本次未写入；补齐证据后重提。",
      })
    }

    let response = ""
    updateJson<{ phases?: Record<string, any[]>; updatedAt?: string }>(reviewPath(root), (state) => {
      const existing = state?.phases?.[args.phase] ?? []
      const byId = new Map(existing.map((finding) => [finding.id, finding]))
      for (const finding of incoming) byId.set(finding.id, finding)
      const findings = [...byId.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)))
      const other = args.phase === "design" ? state?.phases?.code ?? [] : state?.phases?.design ?? []

      const stats = {
        total: findings.length,
        blocker: findings.filter((item) => item.severity === "blocker" && item.status === "open").length,
        major: findings.filter((item) => item.severity === "major" && item.status === "open").length,
        minor: findings.filter((item) => item.severity === "minor" && item.status === "open").length,
      }
      response = JSON.stringify({ ok: true, file: ".dw/review.json", phase: args.phase, accepted: incoming.length, stats })
      return {
        updatedAt: nowIso(),
        phases: args.phase === "design" ? { design: findings, code: other } : { design: other, code: findings },
      }
    })
    return response
  },
})
