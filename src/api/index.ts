import { Store } from '../bridge/store';

const API_CONFIG = {
  // 开发默认值：仅在用户未在登录页设置后端地址时作为 fallback，实际地址由用户在登录页配置
  host: 'http://localhost:8080',
  timeout: 30000,
};

export const setApiHost = (host: string) => {
  // 安全校验：非 localhost 地址必须使用 HTTPS，防止凭证明文传输
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(host);
  if (!isLocal && !host.startsWith('https://')) {
    console.warn('[security] 非 localhost 后端地址应使用 HTTPS，当前为 HTTP，凭据可能明文传输:', host);
  }
  API_CONFIG.host = host;
};

export const getApiHost = (): string => API_CONFIG.host;

// auth_token 存入 Store（secure-store.json）
const AUTH_TOKEN_KEY = 'auth_token';
const STORE_FILE = 'secure-store.json';

let storeInstance: Store | null = null;

async function getStore(): Promise<Store> {
  if (!storeInstance) {
    storeInstance = await Store.load(STORE_FILE);
  }
  return storeInstance;
}

export const getAuthToken = async (): Promise<string | null> => {
  try {
    const store = await getStore();
    const value = await store.get<string>(AUTH_TOKEN_KEY);
    return value ?? null;
  } catch {
    return null;
  }
};

export const setAuthToken = async (token: string | null) => {
  try {
    const store = await getStore();
    if (token) {
      await store.set(AUTH_TOKEN_KEY, token);
    } else {
      await store.delete(AUTH_TOKEN_KEY);
    }
  } catch {
    // Store 不可用时不降级到 localStorage，避免 token 被 XSS 窃取
  }
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

  let url = `${API_CONFIG.host}${path}`;
  if (params) {
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    if (qs) url += `?${qs}`;
  }

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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_CONFIG.timeout);

  try {
    const res = await fetch(url, { ...init, headers, signal: controller.signal });
    if (!res.ok) {
      // L13 修复：不直接暴露 statusText（可能含服务器版本信息），映射为通用消息
      const statusMessages: Record<number, string> = {
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
      let errMsg = statusMessages[res.status] || `请求失败 (HTTP ${res.status})`;
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
      if (msg) {
        if (!options.suppressError) apiErrorHandler?.(msg);
      }
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export default request;
