import { tool } from "@opencode-ai/plugin"
import fs from "node:fs"
import path from "node:path"
import { z } from "zod"
import { CODES, LEVELS, capabilitiesPath, reportPath } from "../lib/constants"
import { aError, toolError, toolOk } from "../lib/client"
import { nowIso, readJson, writeJsonAtomic, writeTextAtomic } from "../../shared/lib/io"
import { CapabilitiesSchema, FindingSchema, GapSchema, type Finding, type Gap, type Scope } from "../lib/schema"
import { clampAnalysisVerdict, renderReport, reportFromFinding } from "../lib/render"
import { ensureReportDir, listEvidencePacks, loadFindings, loadScope } from "../lib/scope"

/**
 * 确定性兜底：所有通道都不可用时，不生成任何判断，只把能力缺口写成 L4 报告。
 * 这条分支由 `fallback=true` 触发，内容完全来自 capabilities.json，模型不参与。
 */
function buildFallbackFinding(root: string, scope: Scope, reason?: string): Finding {
  const parsed = CapabilitiesSchema.safeParse(readJson<unknown>(capabilitiesPath(root, scope.runId)))
  const gaps: Gap[] = parsed.success
    ? parsed.data.channels
        .filter((channel) => !channel.usable)
        .flatMap((channel) =>
          channel.requirements.length > 0
            ? channel.requirements.map((requirement) => ({
                code: "CAPABILITY_MISSING",
                detail: `${channel.id}（${channel.contract}）：${requirement}`,
                neededInterface: requirement.startsWith("B-") ? requirement.split(":")[0] : undefined,
                requirements: [requirement],
              }))
            : [
                {
                  code: "CAPABILITY_MISSING",
                  detail: `${channel.id}（${channel.contract}）不可用`,
                  requirements: [`启用 ${channel.id}`],
                },
              ],
        )
    : [
        {
          code: "CAPABILITIES_MISSING",
          detail: "能力表缺失，无法说明缺口",
          requirements: ["先调用 ana_capabilities 建立运行"],
        },
      ]

  return {
    runId: scope.runId,
    analysisType: scope.analysisType,
    target: scope.target,
    verdict: {
      conclusion: `无法判定：${reason ?? "可用通道不足，未产生任何证据"}`,
      confidence: 0,
      level: "L4",
    },
    claims: [],
    evidenceRefs: [],
    rejected: [],
    gaps,
    indicatorRefs: scope.indicators,
    unknowns: ["未取得任何证据；本报告只说明能力缺口，不构成分析结论"],
  }
}

export default tool({
  description:
    "渲染分析报告并钳制结论级别（纯函数，模型不参与）：读取 findings.json 与证据包，写 analysis/AN-<runId>/report.md。级别只能被下调。",
  args: {
    runId: z.string().min(1),
    title: z.string().min(1).optional(),
    unknowns: z.array(z.string()).max(20).optional(),
    extraGaps: z.array(GapSchema).max(20).optional(),
    fallback: z.boolean().default(false).describe("true=无 findings 时按能力缺口生成确定性 L4 报告"),
    reason: z.string().min(1).optional().describe("兜底原因，例如：所有通道不可用"),
  },
  async execute(args, context) {
    try {
      const root = context.directory || context.worktree || process.cwd()
      const scope = loadScope(root, args.runId)

      const raw = loadFindings(root, args.runId)
      let finding: Finding
      if (!raw) {
        if (!args.fallback) {
          throw aError(CODES.SCHEMA_INVALID, `未找到 findings.json（runId=${args.runId}）：请先由分析 agent 写入结论`)
        }
        finding = buildFallbackFinding(root, scope, args.reason)
      } else {
        const parsed = FindingSchema.safeParse(raw)
        if (!parsed.success) {
          throw aError(
            CODES.SCHEMA_INVALID,
            `findings.json 不合法：${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
          )
        }
        finding = parsed.data
      }
      if (finding.runId !== args.runId) {
        throw aError(CODES.SCHEMA_INVALID, `findings.runId(${finding.runId}) 与请求(${args.runId}) 不一致`)
      }

      const packs = listEvidencePacks(root, args.runId)
      const hasDataEvidence = packs.some((pack) => pack.channel.id === "data.query")
      const hasIndicator = finding.indicatorRefs.length > 0
      const truncated = packs.some((pack) => pack.query?.truncated === true)
      const zeroRows = packs.some((pack) => pack.query?.returnedRows === 0)
      if (!LEVELS.includes(finding.verdict.level)) {
        throw aError(CODES.VERDICT_INVALID, `非法结论级别：${finding.verdict.level}`)
      }

      const clamp = clampAnalysisVerdict({
        analysisType: finding.analysisType,
        level: finding.verdict.level,
        confidence: finding.verdict.confidence,
        hasDataEvidence,
        hasIndicator,
        truncated,
        zeroRows,
        claimCount: finding.claims.length,
      })

      const ceiling = hasDataEvidence ? "L1" : "L3"
      const ceilingReason = hasDataEvidence
        ? "存在受控数据证据"
        : "无受控数据证据（data.query 未纳管）：运行态/日志/元数据只能支撑到 L3"

      const dir = ensureReportDir(root, args.runId)
      const evidenceNames = fs.existsSync(path.join(dir, "evidence"))
        ? fs
            .readdirSync(path.join(dir, "evidence"))
            .filter((name) => name.endsWith(".json"))
            .sort()
            .map((name) => `analysis/AN-${args.runId}/evidence/${name}`)
        : []

      const unknowns = [...new Set([...(args.unknowns ?? []), ...finding.unknowns, ...clamp.notes])]
      const gaps = [...finding.gaps, ...(args.extraGaps ?? [])]

      const report = reportFromFinding({
        finding: { ...finding, gaps },
        level: clamp.level,
        confidence: clamp.confidence,
        ceiling,
        ceilingReason,
        evidence: evidenceNames,
        unknowns,
        timeRange: scope.timeRange,
        title: args.title ?? `数据分析报告：${finding.analysisType}`,
        generatedAt: nowIso(),
      })

      const md = renderReport(report)
      const mdPath = reportPath(root, args.runId)
      writeTextAtomic(mdPath, md)
      writeJsonAtomic(path.join(dir, "report.json"), report)
      writeJsonAtomic(path.join(dir, "findings.json"), { ...finding, gaps })

      return toolOk({
        reportPath: `analysis/AN-${args.runId}/report.md`,
        reportJsonPath: `analysis/AN-${args.runId}/report.json`,
        level: report.verdict.level,
        ceiling,
        ceilingReason,
        clampNotes: clamp.notes,
        confidence: report.verdict.confidence,
        evidenceCount: evidenceNames.length,
        gapCount: gaps.length,
        note: clamp.notes.length > 0 ? "结论级别已被钳制下调，模型不得改写" : "结论级别未触发钳制",
      })
    } catch (error) {
      return toolError(error)
    }
  },
})
