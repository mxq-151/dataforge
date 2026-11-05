/**
 * api 层请求基础设施（与业务无关的纯工具，零模块依赖）。
 *
 * 背景：request() 之外，codeExecution(6 处)、dolphinscheduler(4 处)、fileExplorer(3 处)、
 * marquez(2 处) 各自手写 fetch，把「取 token 拼 Bearer」「HTTP 状态码转错误消息」
 * 「AbortController 超时」重复实现了多份，且部分请求因此丢了超时与统一错误提示。
 *
 * 这里只放不依赖任何模块状态（api host / token store）的纯函数：host 与 token 由调用方
 * 传入，避免 httpCore 反向依赖 api/index 形成循环依赖。
 */

/** 默认请求超时（毫秒） */
export const DEFAULT_TIMEOUT_MS = 30000;

/**
 * HTTP 状态码 → 通用中文消息。
 * 不直接暴露 statusText（可能含服务器版本信息，见 index.ts 的 L13 修复）。
 */
export const HTTP_STATUS_MESSAGES: Record<number, string> = {
  400: '请求参数错误',
  401: '认证失败，请重新登录',
  403: '无权限执行此操作',
  404: '请求的资源不存在',
  408: '请求超时',
  409: '数据冲突',
  413: '请求数据过大',
  429: '请求过于频繁，请稍后再试',
  500: '服务器内部错误',
  502: '网关错误',
  503: '服务暂不可用',
  504: '网关超时',
};

/** 取 HTTP 状态码对应的通用消息，未覆盖的返回兜底文案 */
export function statusMessage(status: number): string {
  return HTTP_STATUS_MESSAGES[status] || `请求失败 (HTTP ${status})`;
}

/** 拼接 query string（含前导 ?），跳过 undefined/null/空串；无参数返回空串 */
export function buildQuery(params?: Record<string, unknown>): string {
  if (!params) return '';
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return qs ? `?${qs}` : '';
}

/**
 * 生成 Bearer 鉴权头。token 为空时不设置 Authorization，由服务端决定匿名行为。
 * extra 中的自定义头会覆盖同名默认头。
 */
export function bearerHeader(
  token: string | null | undefined,
  extra?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

/**
 * 创建超时控制器。返回的 signal 可直接传给 fetch，
 * 调用方须在请求结束后（finally 中）调用 dispose 清理定时器，否则会延长事件循环。
 */
export function createTimeout(timeoutMs: number = DEFAULT_TIMEOUT_MS): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}

/** 非 2xx 时抛出统一格式错误（HTTP ${status}: ${statusText}） */
export function ensureOk(res: Response): void {
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
}

/** 非 2xx 时抛出带响应体摘要的错误（用于对接第三方系统、需要看原始报错的场景） */
export async function ensureOkWithBody(res: Response): Promise<void> {
  if (res.ok) return;
  const errorText = await res.text().catch(() => 'Unable to read error response');
  throw new Error(`HTTP ${res.status}: ${res.statusText} - ${errorText.substring(0, 200)}`);
}
