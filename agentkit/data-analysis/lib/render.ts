/**
 * 结论钳制与报告渲染（纯函数，模型不参与）。
 *
 * 五条钳制（与设计文档 §3.7 一致）：
 * 1. 无受控数据证据（data.query）→ 最高 L3；
 * 2. 只用运行态 / 日志 / 元数据等间接证据 → 最高 L3；
 * 3. `truncated=true` → 最高 L2，且不得给全量结论；
 * 4. `returnedRows=0` → 最高 L2，只能写「窗口内无数据」；
 * 5. confidence < 0.5 → 最高 L3。
 * 另外：reconcile 类型在无口径引用时最高 L3；无任何 claim 时强制 L4。
 */
import { levelRank, type Level } from "./constants"
import type { Claim, Finding, Gap, IndicatorRef, Report, Target, TimeRange } from "./schema"

export type ClampInput = {
  analysisType: string
  level: Level
  confidence: number
  hasDataEvidence: boolean
  hasIndicator: boolean
  truncated: boolean
  zeroRows: boolean
  claimCount: number
}

export type ClampResult = { level: Level; confidence: number; notes: string[] }

function cap(level: Level, ceiling: Level): Level {
  return levelRank(level) > levelRank(ceiling) ? level : ceiling
}

export function clampAnalysisVerdict(input: ClampInput): ClampResult {
  const notes: string[] = []
  let level = input.level
  let confidence = input.confidence

  if (!input.hasDataEvidence) {
    const capped = cap(level, "L3")
    if (capped !== level) notes.push(`无受控数据证据（仅有运行态/日志/元数据）：结论由 ${level} 下调为 ${capped}`)
    level = capped
  }
  if (input.truncated) {
    const capped = cap(level, "L2")
    if (capped !== level) notes.push(`结果被截断：结论由 ${level} 下调为 ${capped}；不得按全量解读`)
    level = capped
  }
  if (input.zeroRows) {
    const capped = cap(level, "L2")
    if (capped !== level) notes.push(`窗口内无数据：结论由 ${level} 下调为 ${capped}`)
    level = capped
  }
  if (confidence < 0.5) {
    const capped = cap(level, "L3")
    if (capped !== level) notes.push(`置信度 ${confidence} < 0.5：结论由 ${level} 下调为 ${capped}`)
    level = capped
  }
  if (input.analysisType === "reconcile" && !input.hasIndicator) {
    const capped = cap(level, "L3")
    if (capped !== level) notes.push(`口径对账缺少口径引用：结论由 ${level} 下调为 ${capped}`)
    level = capped
  }
  if (input.claimCount === 0) {
    notes.push("无任何可引用证据的结论：强制 L4")
    level = "L4"
    confidence = 0
  }

  return { level, confidence, notes }
}

function list(items: string[], empty = "（无）"): string {
  if (items.length === 0) return `- ${empty}`
  return items.map((item) => `- ${item}`).join("\n")
}

function targetText(target: Target): string {
  const parts = [target.datasource, target.database, target.table].filter(Boolean)
  if (target.serviceType) {
    parts.push([target.serviceType, target.componentId, target.hostId].filter(Boolean).join("/"))
  }
  if (target.jobId) parts.push(`job=${target.jobId}`)
  if (target.partitions && target.partitions.length > 0) parts.push(`partitions=${target.partitions.join(",")}`)
  return parts.length > 0 ? parts.join(" · ") : "（未指定）"
}

function timeRangeText(range?: TimeRange): string {
  if (!range) return "（未指定）"
  const from = range.start || "?"
  const to = range.end || "?"
  return `${from} ~ ${to}${range.granularity ? ` · 粒度 ${range.granularity}` : ""}`
}

function gapText(gap: Gap): string {
  const needed = gap.neededInterface ? `（缺接口：${gap.neededInterface}）` : ""
  const reqs = gap.requirements.length > 0 ? `；补齐：${gap.requirements.join("；")}` : ""
  return `${gap.code}: ${gap.detail}${needed}${reqs}`
}

function indicatorText(ref: IndicatorRef): string {
  const scope = [ref.projectCode, ref.topic].filter(Boolean).join(" / ")
  const version = ref.version ? ` @${ref.version}` : "（版本未确认）"
  return `${scope ? `${scope} · ` : ""}${ref.indicatorCode}${version}`
}

function claimText(claim: Claim): string {
  return `${claim.text}（证据：${claim.evidenceRefs.join("、")}）`
}

export function renderReport(report: Report): string {
  const evidence = report.evidence.length > 0 ? report.evidence : []
  return [
    `# ${report.title}`,
    "",
    `- 运行 ID：\`${report.runId}\``,
    `- 分析类型：\`${report.analysisType}\``,
    `- 分析对象：${targetText(report.target)}`,
    `- 时间窗：${timeRangeText(report.timeRange)}`,
    `- 结论级别：**${report.verdict.level}**（上限 ${report.ceiling}：${report.ceilingReason}）`,
    `- 置信度：${report.verdict.confidence}`,
    `- 生成时间：${report.generatedAt}`,
    "",
    "## 结论",
    "",
    report.verdict.conclusion,
    "",
    "## 依据",
    "",
    list(report.claims.map(claimText)),
    "",
    "## 证据",
    "",
    list(evidence),
    "",
    "## 口径引用",
    "",
    list(report.indicatorRefs.map(indicatorText), "未引用指标口径（结论不得声称口径一致）"),
    "",
    "## 缺口与待补接口",
    "",
    list(report.gaps.map(gapText)),
    "",
    "## 未验证事项",
    "",
    list(report.unknowns),
    "",
  ].join("\n")
}

export function reportFromFinding(input: {
  finding: Finding
  level: Level
  confidence: number
  ceiling: Level
  ceilingReason: string
  evidence: string[]
  unknowns: string[]
  timeRange?: TimeRange
  title: string
  generatedAt: string
}): Report {
  return {
    runId: input.finding.runId,
    title: input.title,
    analysisType: input.finding.analysisType,
    target: input.finding.target,
    timeRange: input.timeRange,
    verdict: {
      conclusion: input.finding.verdict.conclusion,
      confidence: input.confidence,
      level: input.level,
    },
    ceiling: input.ceiling,
    ceilingReason: input.ceilingReason,
    claims: input.finding.claims,
    evidence: input.evidence,
    gaps: input.finding.gaps,
    indicatorRefs: input.finding.indicatorRefs,
    unknowns: input.unknowns,
    generatedAt: input.generatedAt,
  }
}
