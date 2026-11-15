/**
 * 收集 C 类审查结论 → .work/review.json；可选把累积结论渲染为 docs/{业务}_审查报告.md。
 * C 类结论必须带证据（evidence 引用原文片段），无证据的结论在 schema 层即被拒。
 */
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import {
  nowIso,
  readJson,
  reviewReportPath,
  ruleOf,
  updateJson,
  workPath,
  writeTextAtomic,
} from "../lib/constants"
import { ReviewFindingSchema, flattenIssues } from "../lib/schema"

type ReviewFile = {
  businessName: string
  findings: any[]
  updatedAt: string
}

const CATEGORY_LABEL: Record<string, string> = {
  "self-consistency": "自洽",
  measurability: "可度量",
  "data-feasibility": "可落数",
  attribution: "分摊合理",
}

function cellSafe(value: unknown): string {
  return String(value ?? "").replace(/\|/g, "｜").replace(/[\r\n]+/g, " ").trim()
}

export default tool({
  description:
    "提交 C 类逻辑审查结论（自洽/可度量/可落数/分摊合理），必须带原文证据。结果累积到 .work/review.json；finalize=true 时额外生成 docs/{业务}_审查报告.md。",
  args: {
    findings: z.array(z.unknown()).min(1).describe("审查结论数组，字段见 ReviewFindingSchema"),
    finalize: z.boolean().optional().describe("true 则渲染审查报告文件"),
  },
  async execute(args, context) {
    const root = context.directory
    const contextInfo = readJson<{ businessName?: string; targetFile?: string }>(workPath(root, "context.json"))
    const businessName = contextInfo?.businessName
    if (!businessName) {
      return JSON.stringify({
        ok: false,
        code: "E_ARG_CONTEXT",
        message: "缺少 .work/context.json 或其中没有 businessName，请先调用 extract-context。",
      })
    }

    const rejected: { index: number; issues: string[] }[] = []
    const incoming: any[] = []
    args.findings.forEach((raw, index) => {
      const parsed = ReviewFindingSchema.safeParse(raw)
      if (!parsed.success) rejected.push({ index, issues: flattenIssues(parsed.error) })
      else incoming.push(parsed.data)
    })

    if (rejected.length) {
      return JSON.stringify({
        ok: false,
        rule: null,
        code: "E_REVIEW_SCHEMA",
        rejected,
        message: "存在不合格结论（多为缺少 evidence），修正后重提；本次未写入。",
      })
    }

    const file = workPath(root, "review.json")
    const result = updateJson<ReviewFile>(file, (previous) => {
      const byId = new Map<string, any>()
      for (const finding of previous?.findings ?? []) byId.set(finding.id, finding)
      for (const finding of incoming) byId.set(finding.id, finding)
      const findings = [...byId.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)))
      return { businessName, findings, updatedAt: nowIso() }
    })
    const report = result.value as ReviewFile
    const findings = report.findings

    const stats = {
      total: findings.length,
      blocker: findings.filter((item) => item.severity === "blocker" && item.status === "open").length,
      major: findings.filter((item) => item.severity === "major" && item.status === "open").length,
      minor: findings.filter((item) => item.severity === "minor" && item.status === "open").length,
    }

    let reportFile: string | null = null
    if (args.finalize) {
      const rule = ruleOf("R16")
      const lines = [
        `# ${businessName} 需求文档审查报告`,
        "",
        `生成时间：${report.updatedAt}`,
        `审查范围：C 类逻辑（自洽 / 可度量 / 可落数 / 分摊合理）`,
        `结论统计：blocker ${stats.blocker} / major ${stats.major} / minor ${stats.minor}`,
        "",
        "## 结论",
        "",
        findings.length === 0
          ? "未发现问题。"
          : stats.blocker > 0
            ? `存在 ${stats.blocker} 条 blocker 级问题，需修正后才能定稿（对应 ${rule.code}）。`
            : "无 blocker 级问题，major/minor 可按优先级处理。",
        "",
        "## 明细",
        "",
        "| ID | 类别 | 严重度 | 章节 | 指标 | 问题 | 证据 | 建议 | 状态 |",
        "|----|------|--------|------|------|------|------|------|------|",
        ...findings.map(
          (item) =>
            `| ${cellSafe(item.id)} | ${cellSafe(CATEGORY_LABEL[item.category] ?? item.category)} | ${cellSafe(item.severity)} | ${cellSafe(item.chapter)} | ${cellSafe(item.metric ?? "-")} | ${cellSafe(item.claim)} | ${cellSafe(item.evidence)} | ${cellSafe(item.suggestion)} | ${cellSafe(item.status)} |`,
        ),
      ]
      writeTextAtomic(reviewReportPath(root, businessName), `${lines.join("\n")}\n`)
      reportFile = `docs/${businessName}_审查报告.md`
    }

    return JSON.stringify({
      ok: true,
      file: ".work/review.json",
      reportFile,
      accepted: incoming.length,
      stats,
      message: reportFile ? "审查结论已累积，审查报告已生成。" : "审查结论已累积。",
    })
  },
})
