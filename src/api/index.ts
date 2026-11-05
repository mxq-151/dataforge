// httpCore 是零依赖纯工具模块（不反向依赖本文件），可安全引入
import { buildQuery, createTimeout, statusMessage } from './httpCore';
import { getApiHost, getAuthToken } from '../session';

// 会话配置（后端地址、鉴权凭据）已迁至 src/session.ts——它比 api 层更底层，
// utils 等模块需要读取 host/token 时不应依赖整个 api 层。
// 这里原样 re-export，既有引用无需改动。
export { getApiHost, setApiHost, getAuthToken, setAuthToken } from '../session';

const API_CONFIG = {
  timeout: 30000,
};

async function generateRequestSignature(
  method: string,
  path: string,
  timestamp: number,
  nonce: string,
  body?: string
): Promise<string> {
  const token = await getAuthToken();
  const payload = `${method.toUpperCase()}${path}${timestamp}${nonce}${body || ''}${token || ''}`;
  const encoder = new TextEncoder();
  const data = encoder.encode(payload);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateNonce(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
}

let apiErrorHandler: ((message: string) => void) | null = null;

export const setApiErrorHandler = (handler: ((message: string) => void) | null) => {
  apiErrorHandler = handler;
};

interface RequestOptions extends RequestInit {
  params?: Record<string, string>;
  /** 为 true 时即使请求失败也不触发全局错误提示（用于「后端接口尚未部署」时可安全降级的请求） */
  suppressError?: boolean;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { params, ...init } = options;

  const url = `${getApiHost()}${path}${buildQuery(params)}`;

  const timestamp = Date.now();
  const nonce = generateNonce();
  const method = init.method || 'GET';
  const bodyStr = init.body ? String(init.body) : undefined;
  const signature = await generateRequestSignature(method, path, timestamp, nonce, bodyStr);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Request-Timestamp': String(timestamp),
    'X-Request-Nonce': nonce,
    'X-Request-Signature': signature,
    ...(options.headers as Record<string, string>),
  };

  const token = await getAuthToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const { signal, dispose } = createTimeout(API_CONFIG.timeout);

  try {
    const res = await fetch(url, { ...init, headers, signal });
    if (!res.ok) {
      // L13 修复：不直接暴露 statusText（可能含服务器版本信息），映射为通用消息
      let errMsg = statusMessage(res.status);
      try {
        const body = await res.json();
        if (body.message) {
          // L13 修复：后端 message 可能含敏感信息，做基本过滤
          const backendMsg = String(body.message);
          // 过滤掉包含堆栈/SQL/路径的泄露信息
          if (/at\s+\w+\.\w+|java\.lang\.|SQLException|SELECT\s+|INSERT\s+|UPDATE\s+|DELETE\s+|\/[a-zA-Z]:\//.test(backendMsg)) {
            // 检测到敏感信息，使用通用消息
          } else if (backendMsg.length <= 200) {
            errMsg = backendMsg;
          }
        }
      } catch { /* ignore parse error */ }
      if (!options.suppressError) apiErrorHandler?.(errMsg);
      throw new Error(errMsg);
    }
    const data = (await res.json()) as T;
    if (data && typeof data === 'object' && 'code' in data && (data as Record<string, unknown>).code !== 200) {
      const msg = (data as Record<string, unknown>).message as string | undefined;
      if (msg && !options.suppressError) apiErrorHandler?.(msg);
      // 业务错误：HTTP 虽为 200，但后端返回非成功码。必须抛异常，
      // 否则调用方会把失败当成成功继续执行（例如指标保存仍提示"提交成功"）。
      throw new Error(msg || `业务处理失败 (code: ${(data as Record<string, unknown>).code})`);
    }
    return data;
  } finally {
    dispose();
  }
}

export default request;
