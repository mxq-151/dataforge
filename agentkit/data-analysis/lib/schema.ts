/**
 * 证据包、结论与报告的契约。
 *
 * 外壳与 task-diag 的 `EvidencePack` 保持同形（scan / signatures / metrics / facts / gaps），
 * 但字段语义按分析类型：`engine` → `analysisType`，`step` → 分析步骤，`channel` 用逻辑通道 id。
 * 四态判断不走这里的 schema，统一在 `client.ts` 与工具里完成。
 */
import { z } from "zod"
import { ANALYSIS_TYPES, LEVELS } from "./constants"

export const TargetSchema = z
  .object({
    datasource: z.string().min(1).optional(),
    database: z.string().min(1).optional(),
    table: z.string().min(1).optional(),
    serviceType: z.string().min(1).optional(),
    componentId: z.string().min(1).optional(),
    hostId: z.string().min(1).optional(),
    jobId: z.string().min(1).optional(),
    partitions: z.array(z.string()).optional(),
  })
  .strict()

export const TimeRangeSchema = z
  .object({
    start: z.string().optional(),
    end: z.string().optional(),
    granularity: z.enum(["minute", "hour", "day", "week", "month"]).optional(),
  })
  .strict()

export const IndicatorRefSchema = z
  .object({
    projectCode: z.string().optional(),
    topic: z.string().optional(),
    indicatorCode: z.string().min(1),
    version: z.string().optional(),
  })
  .strict()

export const ChannelRefSchema = z
  .object({
    id: z.string().min(1),
    serviceType: z.string().optional(),
    componentId: z.string().optional(),
    hostId: z.string().optional(),
    dataTypeId: z.string().optional(),
    stream: z.string().optional(),
    ref: z.record(z.string(), z.string()).optional(),
  })
  .strict()

export const QueryMetaSchema = z
  .object({
    statementType: z.literal("select").optional(),
    sqlHash: z.string().optional(),
    rowLimit: z.number().int().positive().optional(),
    returnedRows: z.number().int().nonnegative().optional(),
    truncated: z.boolean().optional(),
  })
  .strict()

export const ScanSchema = z
  .object({
    bytes: z.number().int().nonnegative().nullable(),
    bytesUnavailable: z.boolean().optional(),
    lines: z.number().int().nonnegative().optional(),
    pages: z.number().int().nonnegative().optional(),
    durationMs: z.number().int().nonnegative().optional(),
    degraded: z.boolean().optional(),
    degradationReason: z.string().nullable().optional(),
  })
  .strict()

export const StatSchema = z
  .object({
    name: z.string().min(1),
    value: z.number().nullable(),
    unit: z.string().optional(),
    scope: z.string().optional(),
    sampleSize: z.number().int().nonnegative().optional(),
  })
  .strict()

export const FactSchema = z
  .object({
    key: z.string().min(1),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    source: z.string().min(1),
  })
  .strict()

export const GapSchema = z
  .object({
    code: z.string().min(1),
    detail: z.string().min(1),
    neededInterface: z.string().optional(),
    requirements: z.array(z.string()).default([]),
  })
  .strict()

export const EvidencePackSchema = z
  .object({
    runId: z.string().min(1),
    analysisType: z.enum(ANALYSIS_TYPES),
    owner: z.string().min(1),
    step: z.string().min(1),
    channel: ChannelRefSchema,
    channelKey: z.string().min(1),
    scopeTicketId: z.string().min(1),
    query: QueryMetaSchema.optional(),
    scan: ScanSchema,
    indicatorRefs: z.array(IndicatorRefSchema).default([]),
    stats: z.array(StatSchema).default([]),
    samples: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))).default([]),
    facts: z.array(FactSchema).default([]),
    gaps: z.array(GapSchema).default([]),
    createdAt: z.string().min(1),
  })
  .strict()

export const ClaimSchema = z
  .object({
    text: z.string().min(1),
    evidenceRefs: z.array(z.string()).min(1),
  })
  .strict()

export const VerdictSchema = z
  .object({
    conclusion: z.string().min(1),
    confidence: z.number().min(0).max(1),
    level: z.enum(LEVELS),
  })
  .strict()

export const FindingSchema = z
  .object({
    runId: z.string().min(1),
    analysisType: z.enum(ANALYSIS_TYPES),
    target: TargetSchema,
    verdict: VerdictSchema,
    claims: z.array(ClaimSchema).default([]),
    evidenceRefs: z.array(z.string()).default([]),
    rejected: z.array(z.string()).default([]),
    gaps: z.array(GapSchema).default([]),
    indicatorRefs: z.array(IndicatorRefSchema).default([]),
    unknowns: z.array(z.string()).default([]),
  })
  .strict()

export const ReportSchema = z
  .object({
    runId: z.string().min(1),
    title: z.string().min(1),
    analysisType: z.enum(ANALYSIS_TYPES),
    target: TargetSchema,
    timeRange: TimeRangeSchema.optional(),
    verdict: VerdictSchema,
    ceiling: z.enum(LEVELS),
    ceilingReason: z.string().min(1),
    claims: z.array(ClaimSchema),
    evidence: z.array(z.string()),
    gaps: z.array(GapSchema),
    indicatorRefs: z.array(IndicatorRefSchema),
    unknowns: z.array(z.string()),
    generatedAt: z.string().min(1),
  })
  .strict()

export type Target = z.infer<typeof TargetSchema>
export type TimeRange = z.infer<typeof TimeRangeSchema>
export type IndicatorRef = z.infer<typeof IndicatorRefSchema>
export type ChannelRef = z.infer<typeof ChannelRefSchema>
export type Scan = z.infer<typeof ScanSchema>
export type Stat = z.infer<typeof StatSchema>
export type Fact = z.infer<typeof FactSchema>
export type Gap = z.infer<typeof GapSchema>
export type EvidencePack = z.infer<typeof EvidencePackSchema>
export type Claim = z.infer<typeof ClaimSchema>
export type Finding = z.infer<typeof FindingSchema>
export type Report = z.infer<typeof ReportSchema>

export const ScopeSchema = z
  .object({
    runId: z.string().min(1),
    analysisType: z.enum(ANALYSIS_TYPES),
    target: TargetSchema,
    timeRange: TimeRangeSchema.optional(),
    indicators: z.array(IndicatorRefSchema).default([]),
    mode: z.literal("analysis"),
    allowedChannels: z.array(z.string()).min(1),
    forbiddenChannels: z.array(z.string()).default([]),
    budget: z
      .object({
        maxQueries: z.number().int().positive(),
        maxRows: z.number().int().positive(),
      })
      .strict(),
    createdAt: z.string().min(1),
  })
  .strict()

export type Scope = z.infer<typeof ScopeSchema>

export const CapabilitiesSchema = z
  .object({
    runId: z.string().min(1),
    analysisType: z.enum(ANALYSIS_TYPES),
    agent: z.string().min(1),
    apiAvailable: z.boolean(),
    channels: z.array(
      z
        .object({
          id: z.string().min(1),
          label: z.string().min(1),
          contract: z.enum(["telemetry-v1", "metadata-readonly", "unmanaged-execution"]),
          status: z.enum(["available", "unmanaged"]),
          usable: z.boolean(),
          owners: z.array(z.string()),
          requirements: z.array(z.string()),
        })
        .strict(),
    ),
    missing: z.array(z.string()),
    createdAt: z.string().min(1),
  })
  .strict()

export type Capabilities = z.infer<typeof CapabilitiesSchema>
