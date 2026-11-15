/**
 * 统一后端出口（data-analysis）。
 *
 * 传输层直接复用 `task-diag/lib/http.ts` 与 `task-diag/lib/telemetry.ts`：
 * 超时、`{code,message,data}` 信封解包、`/api` 路径限制、工具返回体收窄都只有一份实现。
 * 本文件只做两件事：
 * 1. 把 task-diag 的 D 段错误重映射到 A 段（分析类型不产生 D 码）；
 * 2. 提供工具侧统一的 `toolOk/toolFail/toolError`，其中 `toolError` 只认 A 段。
 *
 * 工具不得绕过本文件自行拼 URL 或直接 fetch。
 */
import { DiagError, requestJson, toolFail, toolOk, type QueryValue } from "../../task-diag/lib/http"
import type { TelemetryResponse } from "../../task-diag/lib/telemetry"
import { CODES } from "./constants"

export class AnalysisError extends Error {
  readonly code: string
  readonly detail?: unknown

  constructor(code: string, message: string, detail?: unknown) {
    super(`[${code}] ${message}`)
    this.name = "AnalysisError"
    this.code = code
    this.detail = detail
  }
}

export function aError(code: string, message: string, detail?: unknown): AnalysisError {
  return new AnalysisError(code, message, detail)
}

/**
 * 把传输层的 D 段错误重映射到 A 段：
 * - 401/403 → A13（接口可达但无权限，不能与「不可达」混为一谈）；
 * - 业务 code=400 / HTTP 400 → A06（请求参数不合法，属于调用方问题，不是接口不可达）；
 * - 其它 → A08（不可达/后端异常）。原始 detail 保留，便于工具区分 404。
 */
function remap(error: unknown): AnalysisError {
  if (error instanceof AnalysisError) return error
  if (error instanceof DiagError) {
    const detail = error.detail as { status?: number; businessCode?: number } | undefined
    if (detail?.status === 401 || detail?.status === 403) {
      return new AnalysisError(CODES.AUTH_DENIED, error.message, error.detail)
    }
    if (detail?.businessCode === 400 || detail?.status === 400) {
      return new AnalysisError(CODES.SCHEMA_INVALID, error.message, error.detail)
    }
    return new AnalysisError(CODES.API_UNAVAILABLE, error.message, error.detail)
  }
  return new AnalysisError(CODES.API_UNAVAILABLE, error instanceof Error ? error.message : String(error))
}

/** metadata 侧只读接口只允许 GET；这是硬约束，不靠调用方自觉。 */
export function metadataGet<T>(
  path: string,
  query?: Record<string, QueryValue | QueryValue[]>,
  timeoutMs?: number,
): Promise<T> {
  if (!path.startsWith("/api/metadata/") && path !== "/api/agent/retrieval/tables") {
    return Promise.reject(aError(CODES.CHANNEL_FORBIDDEN, `metadata 通道不允许访问：${path}`))
  }
  return apiGet<T>(path, query, timeoutMs)
}

/**
 * 检索接口在后端契约里是 POST（查询条件放 body），语义仍是只读。
 * 白名单只放这一个路径，防止用「只读」名义调其它 POST 接口。
 */
export function metadataSearch<T>(path: string, body: unknown, timeoutMs?: number): Promise<T> {
  if (path !== "/api/agent/retrieval/tables") {
    return Promise.reject(aError(CODES.CHANNEL_FORBIDDEN, `metadata 检索只允许 /api/agent/retrieval/tables，拒绝：${path}`))
  }
  return apiPost<T>(path, body, timeoutMs)
}

export function apiGet<T>(
  path: string,
  query?: Record<string, QueryValue | QueryValue[]>,
  timeoutMs?: number,
): Promise<T> {
  return requestJson<T>(path, { method: "GET", query, timeoutMs }).catch((error) => {
    throw remap(error)
  })
}

export function apiPost<T>(path: string, body: unknown, timeoutMs?: number): Promise<T> {
  return requestJson<T>(path, { method: "POST", body, timeoutMs }).catch((error) => {
    throw remap(error)
  })
}

/**
 * telemetry v1 外壳查询；非 ok 不抛异常，由调用方映射四态。
 *
 * 说明：这里不复用 `task-diag/lib/telemetry.ts` 的运行时函数——该模块依赖
 * `task-diag/lib/constants.ts`，会把九引擎画像表一并打进本套件；而外壳校验只有 4 行。
 * 契约类型仍用 `import type` 引用，保证两类型对响应形状的理解一致。
 * 真正不能分叉的是幂等键格式，已经下沉到 `shared/lib/channel.ts`。
 */
export async function v1Query<T>(
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<TelemetryResponse<T>> {
  const response = await requestJson<TelemetryResponse<T>>(path, { method: "POST", body, timeoutMs }).catch(
    (error) => {
      throw remap(error)
    },
  )
  if (!response || typeof response !== "object" || typeof response.outcome !== "string") {
    throw aError(CODES.API_UNAVAILABLE, `${path} 响应不是 telemetry v1 外壳`)
  }
  return response
}

export function hasApiAccess(): boolean {
  return Boolean((process.env.DATAFORGE_API_HOST ?? "").trim())
}

/** 工具统一异常出口：只认 A 段，其它一律 A08。 */
export function toolError(error: unknown): string {
  if (error instanceof AnalysisError) {
    return toolFail(error.code, error.message, { detail: error.detail })
  }
  const mapped = remap(error)
  return toolFail(mapped.code, mapped.message, { detail: mapped.detail })
}

export { toolFail, toolOk }
