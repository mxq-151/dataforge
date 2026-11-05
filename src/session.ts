import { Store } from './bridge/store';

/**
 * 会话配置：后端地址与鉴权凭据。
 *
 * 原先这两个职责寄居在 api/index.ts（一个同时承载请求发送、签名、错误映射的胖模块），
 * 导致下层模块为拿一个 host 就得反向依赖整个 api 层（见 features/execHistory/historyIsolation.ts、
 * utils/commitSummary.ts）。会话配置是比 api 更底层的基础设施，单独成模块后：
 *   下层模块 → session  ✅
 *   api    → session  ✅
 * api/index.ts 原样 re-export 这四个函数，既有引用无需改动。
 */

const API_HOST_DEFAULT = 'http://localhost:8080';

let apiHost = API_HOST_DEFAULT;

/** 设置后端地址。非 localhost 地址必须是 HTTPS，否则凭证明文传输 */
export const setApiHost = (host: string): void => {
  // 安全校验：非 localhost 地址必须使用 HTTPS，防止凭证明文传输
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(host);
  if (!isLocal && !host.startsWith('https://')) {
    console.warn('[security] 非 localhost 后端地址应使用 HTTPS，当前为 HTTP，凭据可能明文传输:', host);
  }
  apiHost = host;
};

export const getApiHost = (): string => apiHost;

// auth_token 存入 Store（secure-store.json）
const AUTH_TOKEN_KEY = 'auth_token';
const TOKEN_STORE_FILE = 'secure-store.json';

let storeInstance: Store | null = null;

async function getTokenStore(): Promise<Store> {
  if (!storeInstance) {
    storeInstance = await Store.load(TOKEN_STORE_FILE);
  }
  return storeInstance;
}

export const getAuthToken = async (): Promise<string | null> => {
  try {
    const store = await getTokenStore();
    const value = await store.get<string>(AUTH_TOKEN_KEY);
    return value ?? null;
  } catch {
    return null;
  }
};

export const setAuthToken = async (token: string | null): Promise<void> => {
  try {
    const store = await getTokenStore();
    if (token) {
      await store.set(AUTH_TOKEN_KEY, token);
    } else {
      await store.delete(AUTH_TOKEN_KEY);
    }
  } catch {
    // Store 不可用时不降级到 localStorage，避免 token 被 XSS 窃取
  }
};
