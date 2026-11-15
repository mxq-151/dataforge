/**
 * 运行时契约（zod）。所有落盘的 JSON 都必须先过这里的校验再用，
 * 避免模型写出「看起来对但字段缺失」的 findings 被当成结论。
 *
 * 命名与方案 §7.3 一一对应：Scope / EvidencePack / Finding / Report。
 */
import { z } from "zod"
import { ALL_ENGINES, VERDICT_CATEGORIES } from "./constants"

export const EngineSchema = z.enum(ALL_ENGINES as unknown as [string, ...string[]])
export const ModeSchema = z.enum(["FAILED", "SLOW"])
export const LevelSchema = z.enum(["L1", "L2", "L3", "L4"])
export const CategorySchema = z.enum(VERDICT_CATEGORIES as unknown as [string, ...string[]])
export const ConfidenceSchema = z.number().min(0).max(1)

const RefMapSchema = z.record(z.string(), z.string())

// ── 通道 ────────────────────────────────────────────────────────────────
export const ChannelSchema = z.object({
  serviceType: z.string().min(1),
  logKind: z.string().min(1),
  componentRole: z.string().min(1),
  refKey: z.string().optional(),
  label: z.string().optional(),
})
export type Channel = z.infer<typeof ChannelSchema>

export const ChannelRefSchema = z.object({
  serviceType: z.string().min(1),
  logKind: z.string().min(1),
  componentRole: z.string().min(1),
  ref: RefMapSchema,
})

// ── 目标 ────────────────────────────────────────────────────────────────
export const TimeRangeSchema = z.object({
  start: z.string().optional(),
  end: z.string().optional(),
})

export const TargetSchema = z.object({
  engine: z.string().min(1),
  cluster: z.string().default("default"),
  taskName: z.string().optional(),
  deployMode: z.enum(["cluster", "client", "unknown"]).default("unknown"),
  taskInstanceId: z.string().optional(),
  applicationId: z.string().optional(),
  appId: z.string().optional(),
  jobId: z.string().optional(),
  ref: RefMapSchema.default({}),
  timeRange: TimeRangeSchema.optional(),
})
export type Target = z.infer<typeof TargetSchema>

export const CandidateSchema = z.object({
  engine: z.string().min(1),
  cluster: z.string().default("default"),
  confidence: z.enum(["exact", "derived", "guessed"]),
  source: z.string().min(1),
  refs: RefMapSchema,
  channels: z.array(ChannelSchema).default([]),
  deployMode: z.enum(["cluster", "client", "unknown"]).default("unknown"),
  evidence: z.string().optional(),
})
export type Candidate = z.infer<typeof CandidateSchema>

// ── 能力 ────────────────────────────────────────────────────────────────
export const SignalSchema = z.object({
  signal: z.string().min(1),
  status: z.enum(["available", "unavailable", "unverified"]),
  via: z.string().optional(),
  logKind: z.string().optional(),
  reason: z.string().optional(),
  code: z.string().optional(),
  detail: z.string().optional(),
  need: z.string().optional(),
  verified: z.boolean().optional(),
})
export type Signal = z.infer<typeof SignalSchema>

export const EngineCapabilitySchema = z.object({
  engine: z.string().min(1),
  cluster: z.string().default("default"),
  diagnosable: z.enum(["full", "partial", "none"]),
  signals: z.array(SignalSchema).default([]),
  diagnosisTypes: z.array(ModeSchema).default([]),
  limits: z.object({
    maxLines: z.number().optional(),
    maxBytes: z.number().optional(),
    maxComponents: z.number().optional(),
    maxVertices: z.number().optional(),
  }).default({}),
})
export type EngineCapability = z.infer<typeof EngineCapabilitySchema>

export const CapabilityReportSchema = z.object({
  runId: z.string().min(1),
  generatedAt: z.string().min(1),
  engines: z.array(EngineCapabilitySchema),
  degraded: z.boolean().default(false),
})
export type CapabilityReport = z.infer<typeof CapabilityReportSchema>

// ── 作用域票据 ──────────────────────────────────────────────────────────
export const ScopeSchema = z.object({
  runId: z.string().min(1),
  engine: z.string().min(1),
  mode: ModeSchema,
  createdAt: z.string().min(1),
  target: TargetSchema.nullable(),
  allowedChannels: z.array(ChannelSchema),
  forbiddenChannels: z.array(z.object({ channelKey: z.string(), reason: z.string() })).default([]),
  budget: z.object({ calls: z.number().int().positive(), scanBytes: z.number().int().positive() }),
})
export type Scope = z.infer<typeof ScopeSchema>

// ── 证据包 ──────────────────────────────────────────────────────────────
export const SignatureSchema = z.object({
  id: z.string(),
  signature: z.string(),
  level: z.enum(["FATAL", "ERROR", "WARN", "INFO", "DEBUG", "UNKNOWN"]),
  count: z.number().int().nonnegative(),
  firstSeen: z.string().nullable(),
  lastSeen: z.string().nullable(),
  firstLine: z.number().int().nonnegative(),
  lastLine: z.number().int().nonnegative(),
  exceptionClass: z.string().nullable(),
  samples: z.array(
    z.object({
      line: z.number().int().nonnegative(),
      text: z.string(),
      context: z.array(z.string()),
    }),
  ),
})

export const MetricPointSchema = z.object({
  family: z.string().optional(),
  name: z.string().min(1),
  scope: z.string().optional(),
  component: z.string().optional(),
  value: z.union([z.number(), z.string()]).nullable(),
  verified: z.boolean().optional(),
  unavailable: z.boolean().optional(),
})

export const FactSchema = z.object({
  key: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  source: z.string().min(1),
})

export const GapSchema = z.object({
  signal: z.string().min(1),
  reason: z.string().min(1),
  code: z.string().optional(),
  neededInterface: z.string().optional(),
})
export type Gap = z.infer<typeof GapSchema>

export const EvidencePackSchema = z.object({
  runId: z.string().min(1),
  engine: z.string().min(1),
  step: z.string().min(1),
  channel: ChannelRefSchema.optional(),
  fingerprintVersion: z.string().optional(),
  scan: z.object({
    bytes: z.number().int().nonnegative().default(0),
    lines: z.number().int().nonnegative().default(0),
    pages: z.number().int().nonnegative().default(0),
    truncated: z.boolean().default(false),
    degraded: z.boolean().default(false),
    degradationReason: z.string().nullish(),
  }),
  signatures: z.array(SignatureSchema).default([]),
  metrics: z.array(MetricPointSchema).default([]),
  facts: z.array(FactSchema).default([]),
  gaps: z.array(GapSchema).default([]),
  createdAt: z.string().min(1),
})
export type EvidencePack = z.infer<typeof EvidencePackSchema>

// ── 结论 ────────────────────────────────────────────────────────────────
export const EvidenceItemSchema = z.object({
  kind: z.enum(["log_signature", "metric", "fact", "config"]),
  packPath: z.string().optional(),
  signatureId: z.string().optional(),
  locator: z.string().optional(),
  quote: z.string().optional(),
  count: z.number().optional(),
  metric: z.string().optional(),
  value: z.union([z.number(), z.string(), z.boolean(), z.null()]).optional(),
})

export const FindingSchema = z.object({
  runId: z.string().min(1),
  engine: z.string().min(1),
  mode: ModeSchema,
  phase: z.string().min(1),
  verdict: z.object({
    category: CategorySchema,
    subCategory: z.string().optional(),
    rootCause: z.string().nullable(),
    confidence: ConfidenceSchema,
    level: LevelSchema,
  }),
  evidence: z.array(EvidenceItemSchema).default([]),
  rejected: z.array(z.object({ category: z.string(), reason: z.string() })).default([]),
  gaps: z.array(GapSchema).default([]),
  unknowns: z.array(z.string()).default([]),
  createdAt: z.string().min(1),
})
export type Finding = z.infer<typeof FindingSchema>

// ── 报告 ────────────────────────────────────────────────────────────────
export const ReportSchema = z.object({
  runId: z.string().min(1),
  title: z.string().min(1),
  engine: z.string().min(1),
  mode: ModeSchema,
  diagnosable: z.boolean(),
  /** 该引擎的结论能力上限（来自 ENGINE_PROFILES，不允许被模型抬高） */
  ceiling: LevelSchema,
  ceilingReason: z.string().min(1),
  evidenceTier: z.enum(["job-executor", "job-vertex-tm", "process-log", "none"]),
  fingerprintVersion: z.string().optional(),
  target: TargetSchema,
  verdict: FindingSchema.shape.verdict,
  phase: z.string().optional(),
  evidence: z.array(EvidenceItemSchema).default([]),
  attempted: z.array(
    z.object({
      step: z.string(),
      channel: z.string(),
      result: z.string(),
      note: z.string().optional(),
    }),
  ).default([]),
  gaps: z.array(GapSchema).default([]),
  unknowns: z.array(z.string()).default([]),
  nextSteps: z.array(z.object({ action: z.string(), owner: z.string().optional(), expectedGain: z.string().optional() })).default([]),
  generatedAt: z.string().min(1),
})
export type Report = z.infer<typeof ReportSchema>

// ── 报告渲染（唯一实现，diag_save_report 与 diag_unsupported_report 共用）──
function cell(text: unknown): string {
  const value = text === null || text === undefined ? "" : String(text)
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ")
}

export function renderReport(report: Report): string {
  const lines: string[] = []
  lines.push(`# ${report.title}`)
  lines.push("")
  lines.push(`- 运行 ID：\`${report.runId}\``)
  lines.push(`- 引擎：\`${report.engine}\`　诊断类型：\`${report.mode}\``)
  lines.push(`- 目标：\`${report.target.cluster}\` / ${report.target.applicationId || report.target.jobId || report.target.taskInstanceId || "（未提供强引用）"}`)
  lines.push(`- 证据层级：${report.evidenceTier}　结论上限：${report.ceiling}`)
  lines.push(`- 结论分级：${report.verdict.level}　置信度：${report.verdict.confidence}`)
  lines.push(`- 生成时间：${report.generatedAt}`)
  lines.push("")

  lines.push("## 结论")
  lines.push("")
  if (!report.diagnosable) {
    lines.push("**该类型当前不可诊断。** 下列结论为 `UNRESOLVED`，不构成任何归因。")
    lines.push("")
  }
  lines.push(`- 类别：\`${report.verdict.category}\`${report.verdict.subCategory ? ` / \`${report.verdict.subCategory}\`` : ""}`)
  lines.push(`- 根因：${report.verdict.rootCause ?? "（无法定位）"}`)
  lines.push(`- 证据能力上限说明：${report.ceilingReason}`)
  if (report.phase) lines.push(`- 失败相位：${report.phase}`)
  lines.push("")

  lines.push("## 证据")
  lines.push("")
  if (report.evidence.length === 0) {
    lines.push("（无有效证据）")
  } else {
    lines.push("| # | 类型 | 位置 | 内容 | 计数 |")
    lines.push("|---|---|---|---|---|")
    report.evidence.forEach((item, index) => {
      lines.push(
        `| ${index + 1} | ${cell(item.kind)} | ${cell(item.packPath)} ${cell(item.locator)} | ${cell(
          item.quote ?? item.metric ?? "",
        )} | ${cell(item.count ?? "")} |`,
      )
    })
  }
  lines.push("")

  lines.push("## 已尝试的取证")
  lines.push("")
  if (report.attempted.length === 0) {
    lines.push("（无）")
  } else {
    lines.push("| 步骤 | 通道 | 结果 | 备注 |")
    lines.push("|---|---|---|---|")
    report.attempted.forEach((item) => {
      lines.push(`| ${cell(item.step)} | ${cell(item.channel)} | ${cell(item.result)} | ${cell(item.note ?? "")} |`)
    })
  }
  lines.push("")

  lines.push("## 缺口（neededInterface）")
  lines.push("")
  if (report.gaps.length === 0) {
    lines.push("（无）")
  } else {
    lines.push("| 信号 | 原因 | 需要的接口 |")
    lines.push("|---|---|---|")
    report.gaps.forEach((gap) => {
      lines.push(`| ${cell(gap.signal)} | ${cell(gap.reason)} | ${cell(gap.neededInterface ?? "（未给出）")} |`)
    })
  }
  lines.push("")

  if (report.unknowns.length > 0) {
    lines.push("## 未验证事项")
    lines.push("")
    report.unknowns.forEach((item) => lines.push(`- ${item}`))
    lines.push("")
  }

  if (report.nextSteps.length > 0) {
    lines.push("## 下一步")
    lines.push("")
    report.nextSteps.forEach((step) => {
      const owner = step.owner ? `（${step.owner}）` : ""
      const gain = step.expectedGain ? ` —— ${step.expectedGain}` : ""
      lines.push(`- ${step.action}${owner}${gain}`)
    })
    lines.push("")
  }

  lines.push("---")
  lines.push("")
  lines.push(
    `> 本报告由 task-diag 套件生成。指纹算法版本：${report.fingerprintVersion ?? "n/a"}；结论不高于 ${report.ceiling}。`,
  )
  lines.push("")
  return lines.join("\n")
}
