import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { Store } from '../bridge/store';
import { systemUserApi, CurrentUserInfo, SysRoleVO } from '../api/systemUser';
import { getAuthToken, setAuthToken, setApiHost } from '../api/index';
import { FIRST_LEVEL_MENU_CODES } from '../types';
import {
  OPENCODE_CONFIG_STORE as STORE_FILE,
  startOpencodeAfterLogin,
  stopOpencode,
} from '../services/opencodeLifecycle';

const AUTH_CHECK_TIMEOUT = 10000;
const CONFIG_STORAGE_KEY = 'dataforge_opencode_config';

// M2 修复：JWT 过期检查间隔（每 5 分钟检查一次）
const TOKEN_EXPIRY_CHECK_INTERVAL = 5 * 60 * 1000;
// M2 修复：token 即将过期提前量（提前 5 分钟视为过期，触发重新登录）
const TOKEN_EXPIRY_MARGIN = 5 * 60 * 1000;

/** M2 修复：解码 JWT 获取 exp 过期时间戳（秒），失败返回 null */
function getTokenExpiry(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    // JWT payload 是 base64url 编码
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const decoded = atob(payload);
    const claims = JSON.parse(decoded);
    if (typeof claims.exp === 'number') return claims.exp;
    return null;
  } catch {
    return null;
  }
}

/** M2 修复：检查 token 是否已过期（含提前量） */
function isTokenExpired(token: string): boolean {
  const exp = getTokenExpiry(token);
  if (!exp) return false; // 无法解析 exp，不做客户端过期判断（依赖服务端校验）
  const nowMs = Date.now();
  const expMs = exp * 1000;
  return nowMs >= expMs - TOKEN_EXPIRY_MARGIN;
}

/** 从 Store 或 localStorage 读取 backendHost */
async function restoreBackendHost(): Promise<string | null> {
  // 1. 尝试 Store
  try {
    const store = await Store.load(STORE_FILE);
    const config = await store.get<Record<string, unknown>>('config');
    const host = config?.backendHost;
    if (typeof host === 'string' && host) return host;
  } catch { /* ignore */ }
  // 2. 回退到 localStorage（兼容旧数据）
  try {
    const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
    if (raw) {
      const savedConfig = JSON.parse(raw);
      if (savedConfig.backendHost) return savedConfig.backendHost;
    }
  } catch { /* ignore */ }
  return null;
}

const SUPER_ADMIN_ROLE_NAMES = ['ROLE_ADMIN', 'ADMIN', 'SUPER_ADMIN', '超级管理员'];

// 安全说明：超级管理员身份仅由后端返回的角色信息决定，不以用户名作为判定依据。
// 后端必须对每个 API 端点做独立的角色/权限校验，前端检查仅作 UX 优化，不能作为安全边界。
function isSuperAdmin(info: CurrentUserInfo | null): boolean {
  if (!info) return false;
  if (!info.roles || info.roles.length === 0) return false;
  return info.roles.some(role =>
    SUPER_ADMIN_ROLE_NAMES.some(adminRole =>
      role.roleCode === adminRole || role.roleCode?.toUpperCase() === adminRole.toUpperCase()
    )
  );
}

function getMenuTagsWithDefault(info: CurrentUserInfo | null): string[] {
  if (isSuperAdmin(info)) return FIRST_LEVEL_MENU_CODES;
  return info?.menuTags ?? [];
}

function getProjectCodesWithDefault(info: CurrentUserInfo | null, allProjectCodes?: string[]): string[] {
  if (isSuperAdmin(info)) return allProjectCodes ?? [];
  return info?.projectCodes ?? [];
}

export interface AuthUser {
  id: number;
  username: string;
  realName: string;
  email?: string;
  phone?: string;
  avatar?: string;
  roles: SysRoleVO[];
  roleIds: number[];
  menuTags: string[];
  projectCodes: string[];
  tenantId?: number;
  tenantName?: string;
  isSuperAdmin: boolean;
  currentRoleId: number | null;
}

function toAuthUser(info: CurrentUserInfo, allProjectCodes?: string[]): AuthUser {
  const superAdmin = isSuperAdmin(info);
  const menuTags = getMenuTagsWithDefault(info);
  return {
    id: info.id,
    username: info.username,
    realName: info.realName,
    email: info.email,
    phone: info.phone,
    avatar: info.avatar,
    roles: info.roles,
    roleIds: info.roles.map(r => r.id),
    menuTags,
    projectCodes: getProjectCodesWithDefault(info, allProjectCodes),
    tenantId: info.tenantId,
    tenantName: info.tenantName,
    isSuperAdmin: superAdmin,
    currentRoleId: info.roles.length > 0 ? info.roles[0].id : null,
  };
}

interface AuthState {
  user: AuthUser | null;
  authenticated: boolean;
  loading: boolean;
  login: (username: string, password: string, hostOverride?: string) => Promise<void>;
  logout: () => void;
  switchRole: (roleId: number) => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const restoreSession = async () => {
      // 恢复后端服务地址（Store 优先，localStorage 兜底）
      const backendHost = await restoreBackendHost();
      if (backendHost) {
        setApiHost(backendHost);
      }

      const token = await getAuthToken();
      if (!token) {
        setLoading(false);
        return;
      }
      // M2 修复：客户端 JWT 过期检查，过期则自动清除 token
      if (isTokenExpired(token)) {
        await setAuthToken(null);
        setLoading(false);
        return;
      }
      try {
        const res = await Promise.race([
          systemUserApi.getCurrentUser(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Auth check timeout')), AUTH_CHECK_TIMEOUT)
          ),
        ]);
        if (res.code === 200 && res.data) {
          setUser(toAuthUser(res.data));
        } else {
          await setAuthToken(null);
        }
      } catch {
        await setAuthToken(null);
      } finally {
        setLoading(false);
      }
    };
    restoreSession();
  }, []);

  const login = useCallback(async (username: string, password: string, hostOverride?: string) => {
    // 登录前同步最新的后端服务地址。
    // 优先使用登录页当前输入/已保存的 host（hostOverride），
    // 否则回退到 Store 或 localStorage 中持久化的 backendHost。
    const backendHost = hostOverride || (await restoreBackendHost());
    if (backendHost) {
      setApiHost(backendHost);
    }

    let loginRes;
    try {
      loginRes = await systemUserApi.login({ username, password });
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('abort') || msg.includes('timeout')) {
        throw new Error('无法连接到后端服务，请检查服务是否已启动');
      }
      if (msg.includes('HTTP 502') || msg.includes('HTTP 503') || msg.includes('HTTP 504')) {
        throw new Error('后端服务暂时不可用，请稍后重试');
      }
      throw err;
    }
    if (loginRes.code !== 200 || !loginRes.data) {
      throw new Error(loginRes.message || '用户名或密码错误');
    }
    await setAuthToken(loginRes.data.token);

    // 登录成功后启动 opencode sidecar（内部先同步工作区配置与 backendHost，再拉起进程）。
    // 传入 username，供主进程注入沙箱将读写边界收紧到本用户实际工作目录。
    await startOpencodeAfterLogin(backendHost || '', username);

    let infoRes;
    try {
      infoRes = await systemUserApi.getCurrentUser();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
        throw new Error('登录成功但无法获取用户信息，请检查网络连接');
      }
      throw err;
    }
    if (infoRes.code === 200 && infoRes.data) {
      setUser(toAuthUser(infoRes.data));
    } else {
      throw new Error(infoRes.message || '获取用户信息失败');
    }
  }, []);

  const logout = useCallback(() => {
    // M2 修复：登出时停止 opencode sidecar 进程（清理子进程环境中的凭据）
    stopOpencode();
    setAuthToken(null);
    setUser(null);
  }, []);

  // M2 修复：定期检查 token 过期，过期自动登出
  const logoutRef = useRef(logout);
  logoutRef.current = logout;
  useEffect(() => {
    if (!user) return;
    const checkExpiry = async () => {
      const token = await getAuthToken();
      if (token && isTokenExpired(token)) {
        logoutRef.current();
      }
    };
    const interval = setInterval(checkExpiry, TOKEN_EXPIRY_CHECK_INTERVAL);
    return () => clearInterval(interval);
  }, [user]);

  const switchRole = useCallback(async (roleId: number) => {
    if (!user) return;
    setUser({ ...user, currentRoleId: roleId });
  }, [user]);

  const value: AuthState = {
    user,
    authenticated: !!user,
    loading,
    login,
    logout,
    switchRole,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthState => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export default AuthContext;
