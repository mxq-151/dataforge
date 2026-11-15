/**
 * 访问 dataforge-server 的唯一 HTTP 出口。
 *
 * 约束（与方案一致，不要在工具里绕过）：
 * - 只允许访问 `/api/**`，即服务端 controller 的路径；不直连任何集群；
 * - 凭据只从进程环境读取（opencode 启动时注入），永不写日志、永不回显；
 * - 统一超时；超时不重试（仅幂等 GET 由调用方决定是否重试）。
 *
 * 服务端成功信封固定为 `{ code: 200, message, data }`（见 common/vo/Result.java），
 * 因此这里以 code===200 判定成功，而不是只看 HTTP 状态码。
 */

export const SUCCESS_CODE = 200

export class DiagError extends Error {
  readonly code: string
  readonly detail?: unknown

  constructor(code: string, message: string, detail?: unknown) {
    super(`[${code}] ${message}`)
    this.name = "DiagError"
    this.code = code
    this.detail = detail
  }
}

export function diagError(code: string, message: string, detail?: unknown): DiagError {
  return new DiagError(code, message, detail)
}

/** 服务端地址；未注入时直接失败，不做任何默认端口猜测。 */
export function apiHost(): string {
  const raw = (process.env.DATAFORGE_API_HOST ?? "").trim()
  if (!raw) {
    throw diagError("D09_API_UNAVAILABLE", "未注入 DATAFORGE_API_HOST，无法访问 dataforge-server")
  }
  return raw.replace(/\/+$/, "")
}

export function authToken(): string | null {
  const raw = (process.env.DATAFORGE_AUTH_TOKEN ?? "").trim()
  return raw ? raw : null
}

/** 是否具备访问后端的最低条件（供工具在动手前一次性判断）。 */
export function hasApiAccess(): boolean {
  return Boolean((process.env.DATAFORGE_API_HOST ?? "").trim())
}

export type QueryValue = string | number | boolean | undefined | null

export function buildQuery(params?: Record<string, QueryValue | QueryValue[]>): string {
  if (!params) return ""
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null || item === "") continue
        search.append(key, String(item))
      }
    } else {
      search.append(key, String(value))
    }
  }
  const text = search.toString()
  return text ? `?${text}` : ""
}

export type RequestOptions = {
  method?: "GET" | "POST"
  query?: Record<string, QueryValue | QueryValue[]>
  body?: unknown
  timeoutMs?: number
}

type Envelope<T> = { code?: number; message?: string; data?: T }

/**
 * 发起请求并解包 `data`。
 * 失败一律抛 DiagError：HTTP 非 2xx、业务 code≠200、超时、响应不是 JSON 信封。
 *
 * 签名固定为 `(path, options)`：`path` 必须是显式的第一个参数，
 * 避免「只传 {} 就静默打到错误地址」。
 */
export async function requestJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", query, body, timeoutMs = 8_000 } = options
  if (typeof path !== "string" || !path.startsWith("/api/")) {
    throw diagError("D09_API_UNAVAILABLE", `拒绝访问非 /api 路径：${String(path)}`)
  }

  const url = `${apiHost()}${path}${buildQuery(query)}`
  const headers: Record<string, string> = { Accept: "application/json" }
  const token = authToken()
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers["Content-Type"] = "application/json"

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response: Response
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (error) {
    const reason = controller.signal.aborted ? `请求超时（${timeoutMs}ms）` : "请求失败"
    throw diagError("D09_API_UNAVAILABLE", `${reason}：${method} ${path}`, String(error))
  } finally {
    clearTimeout(timer)
  }

  const text = await response.text().catch(() => "")
  let parsed: Envelope<T> | null = null
  try {
    parsed = text ? (JSON.parse(text) as Envelope<T>) : null
  } catch {
    parsed = null
  }

  if (!response.ok) {
    const message = parsed?.message || `HTTP ${response.status}`
    throw diagError("D09_API_UNAVAILABLE", `${method} ${path} 失败：${message}`, {
      status: response.status,
      businessCode: parsed?.code,
    })
  }

  if (!parsed || typeof parsed !== "object") {
    throw diagError("D09_API_UNAVAILABLE", `${method} ${path} 响应不是 JSON 信封`)
  }

  if (parsed.code !== undefined && parsed.code !== SUCCESS_CODE) {
    throw diagError("D09_API_UNAVAILABLE", `${method} ${path} 业务失败：${parsed.message || parsed.code}`, {
      status: response.status,
      businessCode: parsed.code,
    })
  }

  return parsed.data as T
}

// ── 工具返回信封（所有工具共用）────────────────────────────────────────
/**
 * 工具返回给模型的字节上限。
 * 超出时不是简单截断字符串，而是「递归收窄」：数组取前 5 项、字符串截到 200 字节，
 * 保证结构仍可解析（模型读到 truncated=true 会知道要缩小参数或读落盘文件）。
 */
const TOOL_RETURN_BYTES = 8 * 1024

function shrinkStrings(value: unknown): unknown {
  if (typeof value === "string") return value.length > 200 ? `${value.slice(0, 200)}…` : value
  if (Array.isArray(value)) return value.slice(0, 5).map(shrinkStrings)
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = shrinkStrings(item)
    return out
  }
  return value
}

function serialize(payload: unknown): string {
  const text = JSON.stringify(payload)
  if (Buffer.byteLength(text, "utf8") <= TOOL_RETURN_BYTES) return text
  const shrunk = JSON.stringify({ ...(shrinkStrings(payload) as Record<string, unknown>), truncated: true })
  if (Buffer.byteLength(shrunk, "utf8") <= TOOL_RETURN_BYTES) return shrunk
  return JSON.stringify({
    ok: (payload as Record<string, unknown>)?.ok ?? false,
    truncated: true,
    note: "返回体超过 8KB，已收窄；请缩小参数范围或读取落盘文件。",
  })
}

export function toolOk(data: Record<string, unknown>): string {
  return serialize({ ok: true, ...data })
}

export function toolFail(code: string, message: string, extra?: Record<string, unknown>): string {
  return serialize({ ok: false, code, message, ...(extra ?? {}) })
}

/** 工具统一异常出口：DiagError 原样透出，未知异常归入 D09。 */
export function toolError(error: unknown): string {
  if (error instanceof DiagError) return toolFail(error.code, error.message, { detail: error.detail })
  return toolFail("D09_API_UNAVAILABLE", error instanceof Error ? error.message : String(error))
}
