/**
 * 共享 zod schema：指标、口径五项、场景、质量规则、验收标准、审查结论。
 * 运行时依赖 zod（package.json 声明，版本需与本机 opencode 的 zod 主版本一致）。
 */
import { z } from "zod"
import {
  CALIBER_PARTS,
  METRIC_FIELDS,
  METRIC_KEYS,
  OUTPUT_TYPES,
  PRIORITIES,
  type ChapterId,
} from "./constants"

const CALIBER_LABEL: Record<string, string> = Object.fromEntries(CALIBER_PARTS.map((p) => [p.key, p.label]))
const METRIC_LABEL: Record<string, string> = Object.fromEntries(METRIC_FIELDS.map((f) => [f.key, f.label]))

/**
 * 单元格文本：非空、禁竖线、禁换行。
 * 采用「提交时拒绝」而不是「渲染时转义」——静默替换会丢信息，也会掩盖模型错误。
 */
export const cell = (label: string, min = 1) =>
  z
    .string()
    .refine((v) => v.trim().length >= min, { message: `${label} 不能为空` })
    .refine((v) => !v.includes("|"), { message: `${label} 禁止出现竖线 "|"` })
    .refine((v) => !/[\r\n]/.test(v), { message: `${label} 禁止换行` })

const optionalCell = (label: string) =>
  z
    .string()
    .refine((v) => !v.includes("|"), { message: `${label} 禁止出现竖线 "|"` })
    .refine((v) => !/[\r\n]/.test(v), { message: `${label} 禁止换行` })

// ── 指标 ────────────────────────────────────────────────────────────────
export const CaliberSchema = z
  .object({
    objectScope: cell(CALIBER_LABEL.objectScope),
    counting: cell(CALIBER_LABEL.counting),
    timeBasis: cell(CALIBER_LABEL.timeBasis),
    validity: cell(CALIBER_LABEL.validity),
    attribution: cell(CALIBER_LABEL.attribution),
  })
  .strict()

export const MetricSchema = z
  .object({
    name: cell(METRIC_LABEL.name),
    domain: cell(METRIC_LABEL.domain),
    definition: cell(METRIC_LABEL.definition),
    caliber: CaliberSchema,
    filter: optionalCell(METRIC_LABEL.filter),
    dimensions: cell(METRIC_LABEL.dimensions),
    scenario: cell(METRIC_LABEL.scenario),
  })
  .strict()

export type MetricPayload = z.infer<typeof MetricSchema>

/** R18：字段数量/集合/顺序的快速检查（在 zod 之前跑，报错更精确）。 */
export function checkMetricShape(raw: unknown): { ok: boolean; issues: string[] } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, issues: ["指标必须是对象"] }
  }
  const keys = Object.keys(raw as Record<string, unknown>)
  const issues: string[] = []
  if (keys.length !== METRIC_KEYS.length) {
    issues.push(`字段数应为 ${METRIC_KEYS.length}，实际 ${keys.length}`)
  }
  for (const key of METRIC_KEYS) {
    if (!keys.includes(key)) issues.push(`缺少字段 ${key}（${METRIC_LABEL[key]}）`)
  }
  for (const key of keys) {
    if (!METRIC_KEYS.includes(key)) issues.push(`多余字段 ${key}`)
  }
  const seen = keys.filter((k) => METRIC_KEYS.includes(k))
  const expected = METRIC_KEYS.filter((k) => keys.includes(k))
  if (seen.join(",") !== expected.join(",")) {
    issues.push(`字段顺序应为 ${METRIC_KEYS.join(" -> ")}`)
  }
  return { ok: issues.length === 0, issues }
}

// ── 第 1 章 需求背景 ────────────────────────────────────────────────────
export const Chapter1Schema = z
  .object({
    businessGoal: cell("业务目标"),
    audiences: z.array(cell("使用对象")).min(1),
    decisionScenes: z.array(cell("决策场景")).min(1),
    expectedValue: cell("期望价值"),
  })
  .strict()

// ── 第 2 章 可分析场景梳理（不引入场景编号，规范未要求） ────────────────
export const SceneSchema = z
  .object({
    name: cell("场景名称"),
    purpose: cell("分析目的"),
    dimensions: z.array(cell("分析维度")).min(1),
    granularity: cell("期望数据粒度"),
  })
  .strict()

export const Chapter2Schema = z.object({ scenes: z.array(SceneSchema).min(1) }).strict()

// ── 第 4 章 数据范围与加工逻辑 ──────────────────────────────────────────
export const SourceSystemSchema = z
  .object({
    name: cell("源系统名称"),
    businessObject: cell("业务对象"),
    verification: cell("查证依据"),
  })
  .strict()

export const Chapter4Schema = z
  .object({
    timeRange: cell("数据时间范围"),
    sourceSystems: z.array(SourceSystemSchema).min(1),
    processingSteps: z.array(cell("加工步骤")).min(1),
  })
  .strict()

// ── 第 5 章 数据时效要求 ────────────────────────────────────────────────
export const Chapter5Schema = z
  .object({
    updateFrequency: cell("更新频率"),
    latestAvailableTime: cell("最晚可用时间"),
    historyBackfill: cell("历史回溯范围"),
  })
  .strict()

// ── 第 6 章 数据输出方式 ────────────────────────────────────────────────
export const OutputSchema = z
  .object({
    type: z.enum(OUTPUT_TYPES),
    consumer: cell("使用方"),
    access: cell("访问方式"),
  })
  .strict()

export const Chapter6Schema = z.object({ outputs: z.array(OutputSchema).min(1) }).strict()

// ── 第 7 章 质量检查要求 ────────────────────────────────────────────────
export const QualityRuleSchema = z
  .object({
    /** 规则类型取自外部引用「数据质量规则类型」；用户未提供枚举时写占位文本 */
    ruleType: cell("规则类型"),
    description: cell("规则说明"),
    tolerance: cell("可接受偏差"),
  })
  .strict()

export const Chapter7Schema = z.object({ rules: z.array(QualityRuleSchema).min(1) }).strict()

// ── 第 8 章 优先级与验收标准 ────────────────────────────────────────────
export const Chapter8Schema = z
  .object({
    priority: z.enum(PRIORITIES),
    /** 验收标准只要求「可量化」，不引入规范外的三要素结构 */
    criteria: z.array(cell("验收标准")).min(1),
  })
  .strict()

// ── 第 9 章 待确认问题 ──────────────────────────────────────────────────
export const QuestionSchema = z
  .object({
    question: cell("待确认问题"),
    impact: cell("影响说明"),
  })
  .strict()

export const Chapter9Schema = z.object({ questions: z.array(QuestionSchema) }).strict()

// ── C 类审查结论 ────────────────────────────────────────────────────────
export const ReviewCategory = [
  "self-consistency", // 自洽
  "measurability", // 可度量
  "data-feasibility", // 可落数
  "attribution", // 分摊合理
] as const

export const ReviewFindingSchema = z
  .object({
    id: cell("finding id"),
    category: z.enum(ReviewCategory),
    severity: z.enum(["blocker", "major", "minor"]),
    chapter: z.number().int().min(1).max(9),
    metric: z.string().optional(),
    claim: cell("问题描述"),
    /** 必须引用原文片段，禁止无证据结论 */
    evidence: cell("证据"),
    suggestion: cell("修改建议"),
    status: z.enum(["open", "fixed", "accepted"]).default("open"),
  })
  .strict()

export type ReviewFinding = z.infer<typeof ReviewFindingSchema>

export const ReviewFileSchema = z
  .object({
    businessName: z.string(),
    findings: z.array(ReviewFindingSchema),
    updatedAt: z.string(),
  })
  .strict()

// ── 章节 schema 注册表 ──────────────────────────────────────────────────
export const CHAPTER_PAYLOAD_SCHEMAS: Partial<Record<ChapterId, z.ZodTypeAny>> = {
  1: Chapter1Schema,
  2: Chapter2Schema,
  4: Chapter4Schema,
  5: Chapter5Schema,
  6: Chapter6Schema,
  7: Chapter7Schema,
  8: Chapter8Schema,
  9: Chapter9Schema,
}

/** 把 zod 错误折叠成紧凑的 "path: message" 数组，便于低成本回传模型。 */
export function flattenIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const at = issue.path.length ? issue.path.join(".") : "(root)"
    return `${at}: ${issue.message}`
  })
}
