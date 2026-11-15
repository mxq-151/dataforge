/**
 * dataforge-server `POST /api/telemetry/v1/**` 的响应契约与调用出口。
 *
 * 为什么单独一层：metrics / logs / discovery / snapshot / config / compare 六个端点共用同一套
 * `{ outcome, retryable, backend, data, error, meta }` 外壳。把「非 ok 一律带 typed code +
 * requirements」的判断收敛在这里，避免六个工具各写一遍后语义漂移。
 *
 * 契约来源：docs/任务诊断取数接口设计-v2-2026-11-15.md 第 7 / 14 节。
 */
import { CODES } from "./constants"
import { diagError, requestJson } from "./http"

export type TelemetryOutcome = "ok" | "unavailable" | "not_implemented" | "failed"

export type RequirementView = {
  kind?: string
  key?: string
  description?: string
}

export type BackendWarningView = {
  code?: string
  message?: string
}

export type BackendSkipView = {
  backendId?: string
  backendType?: string
  code?: string
  reason?: string
}

export type BackendAttemptView = {
  backendId?: string
  backendType?: string
  code?: string
  elapsedMs?: number
  retryable?: boolean
}

export type BackendView = {
  selected?: {
    backendId?: string
    backendType?: string
    queryMode?: string
    fallback?: boolean
  } | null
  preferred?: string | null
  fallback?: boolean
  skipped?: BackendSkipView[]
  attempts?: BackendAttemptView[]
  candidates?: unknown[]
}

export type MetaView = {
  elapsedMs?: number
  partial?: boolean
  degraded?: boolean
  warnings?: BackendWarningView[]
  retryAfterMs?: number | null
  collectedAt?: string | null
  cursor?: string | null
  truncated?: boolean
  scan?: { files?: number; bytes?: number; lines?: number; matched?: number } | null
}

export type ErrorView = {
  code?: string
  message?: string
  requirements?: RequirementView[]
}

export type TelemetryResponse<T> = {
  outcome: TelemetryOutcome
  retryable?: boolean
  target?: { serviceType?: string; componentId?: string; hostId?: string } | null
  mode?: string
  backend?: BackendView | null
  data?: T | null
  error?: ErrorView | null
  meta?: MetaView | null
}

/** 发起一次 v1 POST；只做外壳校验，不把非 ok 当成异常（交给调用方映射成 D10/D09）。 */
export async function telemetryQuery<T>(
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<TelemetryResponse<T>> {
  const response = await requestJson<TelemetryResponse<T>>(path, {
    method: "POST",
    body,
    timeoutMs,
  })
  if (!response || typeof response !== "object" || typeof response.outcome !== "string") {
    throw diagError(CODES.API_UNAVAILABLE, `${path} 响应不是 telemetry v1 外壳`)
  }
  return response
}

/** 把 error.requirements 转成可读字符串数组；不可用时不允许为空。 */
export function requirementTexts(error?: ErrorView | null): string[] {
  const items = error?.requirements ?? []
  const texts = items
    .map((item) => {
      const key = item.key ? `${item.key}: ` : ""
      const description = item.description || item.kind || ""
      return `${key}${description}`.trim()
    })
    .filter((item) => item.length > 0)
  // 后端部分错误只给 message（例如「未配置 local-disk 实例（配置键 ...）」），
  // 不能因此让 requirements 变成空数组；message 本身就是可执行的补齐项。
  if (texts.length === 0 && error?.message) return [error.message]
  return texts
}

export function warningTexts(meta?: MetaView | null): string[] {
  return (meta?.warnings ?? [])
    .map((item) => [item.code, item.message].filter(Boolean).join(": "))
    .filter((item) => item.length > 0)
}

export type TelemetryFailure = {
  outcome: Exclude<TelemetryOutcome, "ok">
  code: string
  message: string
  requirements: string[]
  retryable: boolean
  backend: BackendView | null
}

/** 非 ok 结果统一成可上报的失败描述；ok 返回 null。 */
export function failureOf<T>(response: TelemetryResponse<T>): TelemetryFailure | null {
  if (response.outcome === "ok") return null
  return {
    outcome: response.outcome,
    code: response.error?.code || response.outcome,
    message: response.error?.message || `telemetry 返回 ${response.outcome}`,
    requirements: requirementTexts(response.error),
    retryable: Boolean(response.retryable),
    backend: response.backend ?? null,
  }
}

export function isUnavailableFailure(failure: TelemetryFailure): boolean {
  return failure.outcome === "unavailable" || failure.outcome === "not_implemented"
}

// ── 目录 ────────────────────────────────────────────────────────────────
export type BackendBindingView = {
  backendId?: string
  backendType?: string
  status?: string
  priority?: number
  queryModes?: string[]
  sampling?: string[]
  authoritative?: boolean
  equivalenceGroup?: string | null
  notes?: string | null
}

export type MetricDefinitionView = {
  name: string
  type?: string
  unit?: string
  scope?: string
  requiredRefs?: string[]
  labels?: { name?: string; required?: boolean; description?: string }[]
  supportedBackends?: BackendBindingView[]
  rawMetric?: string | null
  endpoint?: string | null
  verified?: boolean | null
  note?: string | null
}

export type LogStreamDefinitionView = {
  dataType?: "log.service" | "log.task"
  stream?: string
  requiredRefs?: string[]
  requiredAnyRefs?: string[]
  supportedBackends?: BackendBindingView[]
  requirements?: RequirementView[]
}

export type ComponentCatalogEntryView = {
  serviceType: string
  componentId: string
  metrics?: MetricDefinitionView[]
  logStreams?: LogStreamDefinitionView[]
  engineEvidence?: { name?: string; supportedBackends?: BackendBindingView[] }[]
  metricCatalogStatus?: string
  metricRequirements?: RequirementView[]
}

export type CatalogData = {
  catalogVersion?: string
  components?: ComponentCatalogEntryView[]
}

// ── 日志 ────────────────────────────────────────────────────────────────
export type LogEntryView = {
  timestamp?: string | null
  stream?: string
  hostId?: string
  message?: string
  fields?: Record<string, string>
}

export type LogData = {
  dataType?: string
  stream?: string
  resultState?: "data" | "empty" | "partial"
  entries?: LogEntryView[]
  entryCount?: number
}

// ── 指标 ────────────────────────────────────────────────────────────────
export type SeriesView = {
  metric?: { name?: string; type?: string; unit?: string }
  labels?: Record<string, string>
  samples?: { timestamp?: string; value?: number }[]
  sampleCount?: number
}

export type MetricData = {
  mode?: string
  resultState?: "data" | "empty" | "partial"
  series?: SeriesView[]
  seriesCount?: number
}

// ── 运行时 ──────────────────────────────────────────────────────────────
export type RuntimeMetricView = {
  name?: string
  family?: string
  sourceMetric?: string
  value?: number | null
  unit?: string
  availability?: "AVAILABLE" | "ZERO" | "UNAVAILABLE" | "NOT_SUPPORTED" | string
  reason?: string | null
}

export type RuntimeComponentView = {
  id?: string
  type?: string
  name?: string
  host?: string
  status?: string
  slots?: number
  freeSlots?: number
  cores?: number
  maxMemoryBytes?: number
  usedMemoryBytes?: number
  startTime?: number
  endTime?: number
  note?: string
  metrics?: RuntimeMetricView[]
}

export type DiscoveryData = {
  scope?: string
  capturedAt?: number
  sources?: {
    backendId?: string
    backendType?: string
    serviceType?: string
    mode?: string
    baseUrlConfigured?: boolean
    supportedFamilies?: string[]
    unavailableFamilies?: Record<string, string>
  }[]
  jobs?: {
    jobId?: string
    name?: string
    state?: string
    startTime?: number
    endTime?: number | null
    durationMs?: number
    trackingUrl?: string | null
    note?: string | null
  }[]
  components?: RuntimeComponentView[]
  warnings?: string[]
}

export type SnapshotData = {
  jobId?: string
  jobName?: string
  state?: string
  startTime?: number
  endTime?: number | null
  durationMs?: number
  capturedAt?: number
  components?: RuntimeComponentView[]
  jobMetrics?: RuntimeMetricView[]
  checkpoint?: {
    available?: boolean
    reason?: string | null
    completed?: number
    failed?: number
    inProgress?: number
    restored?: number
    latestFailedReason?: string | null
    history?: {
      id?: number
      status?: string
      triggerTimestamp?: number
      completedTimestamp?: number
      durationMs?: number
      sizeBytes?: number
      failureMessage?: string | null
    }[]
  }
  unavailableFamilies?: Record<string, string>
  jobConfig?: Record<string, unknown>
  warnings?: string[]
}

export type ConfigData = {
  available?: boolean
  reason?: string | null
  jobId?: string
  capturedAt?: number
  sections?: Record<string, unknown>
  components?: RuntimeComponentView[]
  warnings?: string[]
}

export type CompareData = {
  comparable?: boolean
  reason?: string | null
  windowSeconds?: number
  fromCapturedAt?: number | null
  toCapturedAt?: number | null
  rows?: {
    component?: string
    componentType?: string
    family?: string
    name?: string
    unit?: string
    from?: number
    to?: number
    delta?: number
    perSecond?: number
  }[]
  warnings?: string[]
}
