/**
 * dw-dev 的 zod 契约。
 *
 * 与 req-doc 一样采用「提交时拒绝」：单元格不合法就在写中间态之前失败，
 * 不做静默清洗——清洗会掩盖模型错误，也会让错误延迟到渲染阶段才暴露。
 */
import { z } from "zod"
import {
  COMPRESSIONS,
  DATA_TIERS,
  ENVS,
  IMPACT_DEGREES,
  IMPACT_OBJECTS,
  LAYERS,
  MASKING_METHODS,
  PARTITION_FORMATS,
  PERSONAL_INFO_TYPES,
  QUALITY_DISPOSITIONS,
  QUALITY_TYPE_LABELS,
  STORAGE_FORMATS,
  UPDATE_MODES,
} from "./constants"

const cell = (label: string, min = 1) =>
  z
    .string()
    .refine((value) => value.trim().length >= min, { message: `${label} 不能为空` })
    .refine((value) => !value.includes("|"), { message: `${label} 禁止出现竖线 "|"` })
    .refine((value) => !/[\r\n]/.test(value), { message: `${label} 禁止换行` })

const optionalCell = (label: string) =>
  z
    .string()
    .refine((value) => !value.includes("|"), { message: `${label} 禁止出现竖线 "|"` })
    .refine((value) => !/[\r\n]/.test(value), { message: `${label} 禁止换行` })

const enumOf = <T extends string>(values: readonly T[], label: string) =>
  z.string().refine((value) => (values as readonly string[]).includes(value), {
    message: `${label} 只能是：${values.join(" / ")}`,
  })

// ── metadata 证据 ───────────────────────────────────────────────────────
export const EvidenceSchema = z
  .object({
    database: cell("库名"),
    table: cell("表名"),
    column: optionalCell("字段名").optional(),
    datasource: cell("数据源"),
    sourceTool: enumOf(["metadata_search", "metadata_detail"], "证据来源工具"),
    query: cell("检索词/参数"),
    total: z.number().int().min(0),
    hit: z.boolean(),
    snippet: cell("命中片段"),
  })
  .strict()

export type EvidencePayload = z.infer<typeof EvidenceSchema>

// ── 表与字段 ────────────────────────────────────────────────────────────
export const FieldSchema = z
  .object({
    name: z
      .string()
      .refine((value) => /^[a-z][a-z0-9_]*$/.test(value), { message: "字段名必须小写字母开头，只含小写字母/数字/下划线" }),
    cnName: cell("字段中文名"),
    logicalType: cell("数据类型"),
    nullable: z.boolean(),
    defaultValue: optionalCell("默认值").optional(),
    source: optionalCell("来源").optional(),
    expression: optionalCell("计算逻辑").optional(),
    level: z.object({ tier: enumOf(DATA_TIERS, "数据级别") }).strict(),
    personalInfo: enumOf(PERSONAL_INFO_TYPES, "个人信息标记"),
    masking: enumOf(MASKING_METHODS, "脱敏方式"),
  })
  .strict()

export const TableSchema = z
  .object({
    enName: z
      .string()
      .refine((value) => /^[a-z][a-z0-9_]*$/.test(value), { message: "表名必须小写字母开头，只含小写字母/数字/下划线" }),
    cnName: cell("表中文名"),
    tableType: enumOf(["正式表", "临时表"], "表类型").default("正式表"),
    tempTtlDays: z.number().int().positive().max(7).optional(),
    layer: enumOf(LAYERS, "分层"),
    domain: z
      .string()
      .refine((value) => /^[a-z][a-z0-9_]*$/.test(value), { message: "业务域必须小写字母开头，只含小写字母/数字/下划线" }),
    env: enumOf(ENVS, "环境后缀"),
    grain: cell("粒度声明"),
    businessDefinition: cell("业务口径"),
    drillDimensions: z.array(cell("可下钻维度")).default([]),
    etlSteps: z.array(cell("加工步骤")).min(3),
    primaryKey: z.array(cell("主键字段")).min(1),
    uniqueKey: z.array(cell("唯一键字段")).optional(),
    partition: z
      .object({
        field: cell("分区字段"),
        format: enumOf(PARTITION_FORMATS, "分区格式"),
        strategy: enumOf(["single", "range", "list"], "分区策略"),
        buckets: z.number().int().positive().optional(),
      })
      .strict(),
    storage: z
      .object({
        format: enumOf(STORAGE_FORMATS, "存储格式"),
        compression: enumOf(COMPRESSIONS, "压缩算法"),
      })
      .strict(),
    lifecycleDays: z.number().int().positive(),
    updateMode: enumOf(UPDATE_MODES, "更新方式"),
    rerunnable: z.boolean(),
    engine: cell("引擎"),
    datasource: cell("数据源"),
    classification: z
      .object({
        industry: cell("行业领域"),
        businessAttribute: cell("业务属性"),
        categoryPath: cell("分类路径"),
        industryCatalog: optionalCell("行业分类目录").optional(),
      })
      .strict(),
    level: z
      .object({
        tier: enumOf(DATA_TIERS, "数据级别"),
        impactObject: enumOf(IMPACT_OBJECTS, "影响对象"),
        impactDegree: enumOf(IMPACT_DEGREES, "影响程度"),
        basis: cell("定级依据"),
      })
      .strict(),
    owner: optionalCell("负责人").optional(),
    consumer: optionalCell("使用方").optional(),
    upstream: z.array(cell("上游表")).default([]),
    fields: z.array(FieldSchema).min(1),
  })
  .strict()

export type TablePayload = z.infer<typeof TableSchema>

// ── 公共 UDF（code/utils） ──────────────────────────────────────────────
export const UtilSchema = z
  .object({
    kind: z.literal("util"),
    name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/, { message: "UDF 名称必须字母开头，只含字母/数字/下划线" }),
    filePath: z
      .string()
      .regex(/^code\/utils\/[A-Za-z][A-Za-z0-9_]*\.(java|scala)$/, {
        message: "UDF 路径必须是 code/utils/{名称}.java|scala",
      }),
    code: z.string().min(1),
    note: z.string().optional(),
  })
  .strict()

export type UtilPayload = z.infer<typeof UtilSchema>

// ── 指标映射 ────────────────────────────────────────────────────────────
export const MetricSchema = z
  .object({
    code: z
      .string()
      .refine((value) => /^[A-Z][A-Z0-9]{1,9}_\d{4}$/.test(value), {
        message: "指标编码格式应为 {项目编码}_NNNN，如 USR_0001",
      }),
    name: cell("指标名称"),
    domain: cell("主题域"),
    meaning: cell("指标含义"),
    expression: cell("计算表达式"),
    filter: optionalCell("过滤条件"),
    dimensions: optionalCell("下钻维度"),
    sources: cell("字段来源"),
    datasource: cell("数据源"),
    isNew: z.boolean().default(false),
  })
  .strict()

export type MetricPayload = z.infer<typeof MetricSchema>

// ── 稽核规则 ────────────────────────────────────────────────────────────
export const QualityRuleSchema = z
  .object({
    name: z
      .string()
      .refine((value) => /^R_[A-Z0-9]{2,10}_\d{3}\s+\S.*$/.test(value), {
        message: "规则名格式应为 {前缀}_{业务域}_{序号} {中文描述}，如 R_AD_001 事件主键唯一",
      }),
    ruleType: enumOf(QUALITY_TYPE_LABELS, "规则类型"),
    target: cell("校验对象"),
    threshold: z
      .string()
      .refine((value) => /^[^=<>≥≤\s]{0,10}\s*(>=|<=|=|>|<|≥|≤)\s*\d+(\.\d+)?$/.test(value.trim()), {
        message: "阈值必须是 比较符+数值，如 重复=0、匹配率≥99、偏差≤0.001",
      }),
    disposition: enumOf(QUALITY_DISPOSITIONS, "处置方式"),
    table: cell("所属表"),
  })
  .strict()

export type QualityRulePayload = z.infer<typeof QualityRuleSchema>

// ── 作业 ────────────────────────────────────────────────────────────────
export const JobSchema = z
  .object({
    name: z
      .string()
      .refine((value) => /^[a-z][a-z0-9_]*$/.test(value), { message: "作业名必须小写字母开头，只含小写字母/数字/下划线" }),
    kind: enumOf(["sql", "java", "scala"], "作业语言"),
    engine: cell("引擎"),
    layer: enumOf(LAYERS, "分层"),
    domain: z
      .string()
      .refine((value) => /^[a-z][a-z0-9_]*$/.test(value), { message: "业务域必须小写字母开头" }),
    entity: z
      .string()
      .refine((value) => /^[a-z][a-z0-9_]*$/.test(value), { message: "实体描述必须小写字母开头" }),
    op: z.string(),
    cycle: z.string(),
    filePath: cell("产出路径"),
    code: z.string().refine((value) => value.trim().length > 0, { message: "代码不能为空" }),
    dependencies: z.array(cell("依赖")).default([]),
    programParams: optionalCell("程序参数"),
    resourceParams: optionalCell("资源参数").optional(),
    taskParams: optionalCell("任务参数").optional(),
    datasource: z.array(cell("数据源")).default([]),
    targetTable: cell("目标表"),
    sourceTables: z.array(cell("源表")).default([]),
    metricCodes: z.array(cell("指标编码")).default([]),
  })
  .strict()

export type JobPayload = z.infer<typeof JobSchema>

// ── C 类审查 ────────────────────────────────────────────────────────────
export const DESIGN_REVIEW_CATEGORIES = [
  "self-consistency",
  "metric-uniqueness",
  "aggregation",
  "dimension-feasibility",
  "traceability",
] as const

export const CODE_REVIEW_CATEGORIES = [
  "caliber-equivalence",
  "aggregation-level",
  "join-correctness",
  "idempotency",
  "metric-annotation",
] as const

export const ReviewFindingSchema = z
  .object({
    id: cell("finding id"),
    category: z.string(),
    severity: z.enum(["blocker", "major", "minor"]),
    target: cell("问题位置"),
    claim: cell("问题描述"),
    evidence: cell("证据"),
    suggestion: cell("修改建议"),
    status: z.enum(["open", "fixed", "accepted"]).default("open"),
  })
  .strict()

export type ReviewFindingPayload = z.infer<typeof ReviewFindingSchema>

// ── 形状检查（比 zod 更早、报错更精确） ────────────────────────────────
export function checkObjectShape(raw: unknown, keys: string[], label: string): string[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [`${label}必须是对象`]
  const actual = Object.keys(raw as Record<string, unknown>)
  const issues: string[] = []
  for (const key of keys) if (!actual.includes(key)) issues.push(`缺少字段 ${key}`)
  for (const key of actual) if (!keys.includes(key)) issues.push(`多余字段 ${key}`)
  const seen = actual.filter((key) => keys.includes(key))
  const expected = keys.filter((key) => actual.includes(key))
  if (seen.join(",") !== expected.join(",")) issues.push(`字段顺序应为 ${keys.join(" -> ")}`)
  return issues
}

export function flattenIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const at = issue.path.length ? issue.path.join(".") : "(root)"
    return `${at}: ${issue.message}`
  })
}
