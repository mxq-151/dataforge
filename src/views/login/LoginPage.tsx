import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { LogIn, User, Lock, AlertCircle, Server, Pencil, Check, X, ChevronDown } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import useOpencodeConfig from '../../hooks/useOpencodeConfig';
import { getSyncedStore } from '../../utils/syncedStore';
import TitleBar from '../../components/layout/TitleBar';
import './LoginPage.css';

// 记住的主机/账号密码改由 SyncedStore 持久化到主进程磁盘（userData/df-stores/），
// 不再写入 localStorage——明文凭据暴露给页面脚本存在 XSS 窃取风险。
// 与 token / API Key 的处理保持一致（见 api/index.ts、useOpencodeConfig.ts）。
const CRED_STORE_FILE = 'login-credentials.json';
const REMEMBERED_CREDENTIALS_KEY = 'dataforge-remembered-credentials';
const REMEMBERED_HOSTS_KEY = 'dataforge-remembered-hosts';

interface SavedCredential {
  host: string;
  username: string;
  password: string;
}

const credStore = getSyncedStore(CRED_STORE_FILE);

/**
 * 一次性迁移：把旧版本留在 localStorage 的主机/凭据搬到 SyncedStore 后清除，
 * 避免用户升级后「记住密码」因换了存储介质而失效。
 * 已在 SyncedStore 中存在的数据优先，不做覆盖。
 */
function migrateLegacyCredentials(): void {
  try {
    const rawHosts = localStorage.getItem(REMEMBERED_HOSTS_KEY);
    if (rawHosts) {
      const arr = JSON.parse(rawHosts) as unknown;
      if (Array.isArray(arr) && credStore.get(REMEMBERED_HOSTS_KEY) === undefined) {
        credStore.set(REMEMBERED_HOSTS_KEY, arr);
      }
      localStorage.removeItem(REMEMBERED_HOSTS_KEY);
    }
    const rawCreds = localStorage.getItem(REMEMBERED_CREDENTIALS_KEY);
    if (rawCreds) {
      const parsed = JSON.parse(rawCreds) as unknown;
      if (parsed != null && credStore.get(REMEMBERED_CREDENTIALS_KEY) === undefined) {
        credStore.set(REMEMBERED_CREDENTIALS_KEY, parsed);
      }
      localStorage.removeItem(REMEMBERED_CREDENTIALS_KEY);
    }
  } catch {
    // 迁移失败不影响登录流程
  }
}

/** 加载已登录过的主机列表（最近一次在前） */
const loadRememberedHosts = (): string[] => {
  try {
    const arr = credStore.get<string[]>(REMEMBERED_HOSTS_KEY);
    if (!Array.isArray(arr)) return [];
    return arr.filter((h): h is string => typeof h === 'string' && !!h.trim());
  } catch { return []; }
};

const persistRememberedHosts = (list: string[]) => {
  if (list.length === 0) {
    credStore.delete(REMEMBERED_HOSTS_KEY);
  } else {
    credStore.set(REMEMBERED_HOSTS_KEY, list);
  }
};

/** 记录一次登录使用的主机，置顶去重并落盘 */
const recordHost = (list: string[], host: string): string[] => {
  const h = (host || '').trim();
  if (!h) return list;
  const next = [h, ...list.filter(x => x !== h)];
  persistRememberedHosts(next);
  return next;
};

const loadSavedCredentials = (fallbackHost: string): SavedCredential[] => {
  try {
    const parsed = credStore.get<unknown>(REMEMBERED_CREDENTIALS_KEY);
    if (parsed == null) return [];
    // 兼容旧版本的单账号对象格式 { username, password }（归属当前 host）
    if (typeof parsed === 'object' && !Array.isArray(parsed)) {
      const legacy = parsed as Partial<SavedCredential>;
      if (typeof legacy.username === 'string' && typeof legacy.password === 'string') {
        const migrated: SavedCredential[] = [{ host: fallbackHost, username: legacy.username, password: legacy.password }];
        persistSavedCredentials(migrated);
        return migrated;
      }
    }
    if (!Array.isArray(parsed)) return [];
    return (parsed as Partial<SavedCredential>[])
      .filter((c): c is SavedCredential => !!c && typeof c.username === 'string' && typeof c.password === 'string')
      .map(c => ({
        host: typeof c.host === 'string' && c.host ? c.host : fallbackHost,
        username: c.username,
        password: c.password,
      }));
  } catch { return []; }
};

const persistSavedCredentials = (list: SavedCredential[]) => {
  if (list.length === 0) {
    credStore.delete(REMEMBERED_CREDENTIALS_KEY);
  } else {
    credStore.set(REMEMBERED_CREDENTIALS_KEY, list);
  }
};

const LoginPage: React.FC = () => {
  const { login } = useAuth();
  const { config, updateConfig, loaded } = useOpencodeConfig();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isEditingHost, setIsEditingHost] = useState(false);
  const [editHostValue, setEditHostValue] = useState('');
  const usernameRef = useRef<HTMLInputElement>(null);

  // 已记住的账号列表（按 host 区分）
  const [savedCredentials, setSavedCredentials] = useState<SavedCredential[]>([]);
  const [accountDropdownOpen, setAccountDropdownOpen] = useState(false);
  // 已登录过的主机列表（供用户选择）
  const [rememberedHosts, setRememberedHosts] = useState<string[]>([]);
  const [hostDropdownOpen, setHostDropdownOpen] = useState(false);

  // 当前选中的后端地址：以 store 中的 backendHost 为准
  const selectedHost = config.backendHost || '';

  // 挂载时加载已登录过的主机列表（需等 SyncedStore 从磁盘预热完成）
  useEffect(() => {
    let cancelled = false;
    void credStore.init().then(() => {
      if (cancelled) return;
      migrateLegacyCredentials();
      setRememberedHosts(loadRememberedHosts());
    });
    return () => { cancelled = true; };
  }, []);

  // 配置加载完成后读取记住的账号（旧格式迁移到当前 host），
  // 并确保当前 host 一定出现在主机列表里（否则选择器里看不到当前项）
  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    void credStore.init().then(() => {
      if (cancelled) return;
      const current = config.backendHost || '';
      setRememberedHosts(prev => {
        if (current && !prev.includes(current)) {
          persistRememberedHosts([current, ...prev]);
          return [current, ...prev];
        }
        return prev;
      });
      const list = loadSavedCredentials(current);
      setSavedCredentials(list);
      if (list.length > 0) {
        setRemember(true);
        setAccountDropdownOpen(true);
      }
    });
    return () => { cancelled = true; };
  }, [loaded, config.backendHost]);

  useEffect(() => {
    if (usernameRef.current) {
      usernameRef.current.setAttribute('autocomplete', 'new-password');
    }
  }, []);

  // 当前选中 host 名下的账号
  const accountsForSelectedHost = useMemo(
    () => savedCredentials.filter(c => (c.host || '') === selectedHost),
    [savedCredentials, selectedHost]
  );

  // 按当前输入过滤匹配的账号
  const filteredAccounts = useMemo(() => {
    const q = username.trim().toLowerCase();
    if (!q) return accountsForSelectedHost;
    return accountsForSelectedHost.filter(c => c.username.toLowerCase().includes(q));
  }, [username, accountsForSelectedHost]);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password.trim()) {
      setError('请输入用户名和密码');
      return;
    }
    setLoading(true);
    setError(null);

    // 记住本次登录的后端地址：输入过的 host 需像"记住用户名和密码"一样被持久化，
    // 否则重启后 opencode 的 DATAFORGE_API_HOST 仍用旧值（如 localhost:8080）。
    const enteredHost = (editHostValue || '').trim();
    const hostToUse = enteredHost || selectedHost;

    // 登录过的主机都会被记录（无论是否勾选"记住"），供下次选择
    setRememberedHosts(prev => recordHost(prev, hostToUse));

    // 按勾选状态保存/清除记住的凭据（登录成功会跳转，组件卸载后保存逻辑不执行）
    if (remember) {
      const u = username.trim();
      const h = hostToUse;
      setSavedCredentials(prev => {
        const others = prev.filter(c => !(c.host === h && c.username === u));
        const next = [{ host: h, username: u, password }, ...others];
        persistSavedCredentials(next);
        return next;
      });
    } else if (savedCredentials.length > 0) {
      persistSavedCredentials([]);
      setSavedCredentials([]);
    }

    if (enteredHost && enteredHost !== config.backendHost) {
      updateConfig({ backendHost: enteredHost });
    }
    setHostDropdownOpen(false);
    setAccountDropdownOpen(false);
    try {
      await login(username.trim(), password, hostToUse || undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败，请检查用户名和密码');
    } finally {
      setLoading(false);
    }
  }, [username, password, remember, login, savedCredentials.length, selectedHost, editHostValue, config.backendHost, updateConfig]);

  const handleRememberChange = useCallback((checked: boolean) => {
    setRemember(checked);
    if (!checked) {
      persistSavedCredentials([]);
      setSavedCredentials([]);
    }
  }, []);

  const handleSelectAccount = useCallback((cred: SavedCredential) => {
    setUsername(cred.username);
    setPassword(cred.password);
    setAccountDropdownOpen(false);
  }, []);

  const handleRemoveAccount = useCallback((e: React.MouseEvent, uname: string) => {
    e.stopPropagation();
    e.preventDefault();
    const host = selectedHost;
    setSavedCredentials(prev => {
      const next = prev.filter(c => !(c.host === host && c.username === uname));
      persistSavedCredentials(next);
      return next;
    });
    // 若当前输入框的用户名被删除，则清空用户名和密码
    if (username === uname) {
      setUsername('');
      setPassword('');
    }
  }, [selectedHost, username]);

  const handleUsernameFocus = useCallback(() => {
    setAccountDropdownOpen(true);
  }, []);

  const handleUsernameBlur = useCallback(() => {
    // 延迟关闭，让点击事件先触发
    setTimeout(() => setAccountDropdownOpen(false), 150);
  }, []);

  // ── 主机选择 ──
  const toggleHostDropdown = useCallback(() => {
    setHostDropdownOpen(open => {
      if (!open) setIsEditingHost(false);
      return !open;
    });
  }, []);

  const handleSelectHost = useCallback((host: string) => {
    if (!host) return;
    updateConfig({ backendHost: host });
    setEditHostValue(host);
    setHostDropdownOpen(false);
    // 切换 host 后打开账号下拉，展示该 host 下记住的账号
    setAccountDropdownOpen(true);
  }, [updateConfig]);

  const handleRemoveHost = useCallback((e: React.MouseEvent, host: string) => {
    e.stopPropagation();
    e.preventDefault();
    setRememberedHosts(prev => {
      const next = prev.filter(h => h !== host);
      persistRememberedHosts(next);
      return next;
    });
    // 同时清除该主机下记住的账号
    setSavedCredentials(prev => {
      const next = prev.filter(c => c.host !== host);
      persistSavedCredentials(next);
      return next;
    });
    // 若移除的是当前选中主机，回退到列表第一个或清空
    if (host === selectedHost) {
      const remaining = rememberedHosts.filter(h => h !== host);
      const nextHost = remaining[0] || '';
      updateConfig({ backendHost: nextHost });
      setEditHostValue(nextHost);
    }
  }, [selectedHost, rememberedHosts, updateConfig]);

  const handleStartEditHost = () => {
    setEditHostValue(selectedHost);
    setIsEditingHost(true);
    setHostDropdownOpen(false);
  };

  const handleSaveHost = () => {
    const h = editHostValue.trim();
    if (h) {
      updateConfig({ backendHost: h });
      setRememberedHosts(prev => recordHost(prev, h));
      setAccountDropdownOpen(true);
    }
    setIsEditingHost(false);
    setHostDropdownOpen(false);
  };

  const handleCancelEditHost = () => {
    setIsEditingHost(false);
  };

  return (
    <div className="login-page">
      <TitleBar title="dataforge" />
      <div className="login-card">
        <div className="login-card__header">
          <div className="login-card__logo">DF</div>
          <h1 className="login-card__title">DataForge</h1>
          <p className="login-card__subtitle">数据开发平台</p>
        </div>
        <form className="login-card__form" onSubmit={handleSubmit} autoComplete="off">
          {error && (
            <div className="login-card__error">
              <AlertCircle size={16} />
              <span>{error}</span>
            </div>
          )}
          <div className="login-card__field">
            <div className="login-card__input-wrapper">
              <User size={16} className="login-card__input-icon" />
              <input
                ref={usernameRef}
                type="text"
                placeholder="用户名"
                maxLength={50}
                value={username}
                onChange={e => setUsername(e.target.value)}
                onFocus={handleUsernameFocus}
                onBlur={handleUsernameBlur}
                autoComplete="new-password"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                name={`login_username_${Date.now()}`}
                autoFocus
              />
            </div>
            {accountDropdownOpen && filteredAccounts.length > 0 && (
              <div className="login-card__account-dropdown">
                {filteredAccounts.map(cred => (
                  <div
                    key={cred.username}
                    className="login-card__account-item"
                    onMouseDown={(e) => { e.preventDefault(); handleSelectAccount(cred); }}
                    title={`选择账号 ${cred.username}`}
                  >
                    <User size={13} className="login-card__account-item-icon" />
                    <span className="login-card__account-item-name">{cred.username}</span>
                    <button
                      type="button"
                      className="login-card__account-item-remove"
                      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); handleRemoveAccount(e, cred.username); }}
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
                      title="删除此账号"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="login-card__field">
            <div className="login-card__input-wrapper">
              <Lock size={16} className="login-card__input-icon" />
              <input
                type="password"
                placeholder="密码"
                maxLength={128}
                value={password}
                onChange={e => setPassword(e.target.value)}
                autoComplete="new-password"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                name={`login_password_${Date.now()}`}
              />
            </div>
          </div>
          <label className="login-card__remember">
            <input
              type="checkbox"
              checked={remember}
              onChange={e => handleRememberChange(e.target.checked)}
            />
            <span>记住用户名和密码</span>
          </label>
          <button
            type="submit"
            className="login-card__submit"
            disabled={loading}
          >
            {loading ? '登录中...' : (
              <>
                <LogIn size={16} />
                登录
              </>
            )}
          </button>
        </form>
        <div className="login-card__backend-host">
          <div className="login-card__backend-host-label">
            <Server size={12} />
            <span>后端服务地址</span>
          </div>
          {isEditingHost ? (
            <div className="login-card__backend-host-edit">
              <input
                type="text"
                className="login-card__backend-host-input"
                value={editHostValue}
                onChange={e => setEditHostValue(e.target.value)}
                placeholder="http://localhost:8080"
                maxLength={255}
                autoFocus
              />
              <button className="login-card__backend-host-btn login-card__backend-host-btn--save" onClick={handleSaveHost} title="保存">
                <Check size={12} />
              </button>
              <button className="login-card__backend-host-btn login-card__backend-host-btn--cancel" onClick={handleCancelEditHost} title="取消">
                <X size={12} />
              </button>
            </div>
          ) : (
            <div className="login-card__backend-host-display" onClick={toggleHostDropdown} title="选择或编辑后端服务地址">
              <span className={selectedHost ? 'login-card__backend-host-value' : 'login-card__backend-host-value login-card__backend-host-value--empty'}>{selectedHost || '请配置后端服务地址'}</span>
              <ChevronDown size={12} className="login-card__backend-host-chevron" />
            </div>
          )}
          {hostDropdownOpen && !isEditingHost && (
            <div className="login-card__host-dropdown">
              {rememberedHosts.length === 0 && (
                <div className="login-card__host-item-empty">暂无已登录过的主机</div>
              )}
              {rememberedHosts.map(host => (
                <div
                  key={host}
                  className={'login-card__host-item' + (host === selectedHost ? ' login-card__host-item--active' : '')}
                  onClick={() => handleSelectHost(host)}
                  title={`切换到 ${host}`}
                >
                  <Server size={13} className="login-card__host-item-icon" />
                  <span className="login-card__host-item-name">{host}</span>
                  <button
                    type="button"
                    className="login-card__host-item-remove"
                    onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); handleRemoveHost(e, host); }}
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
                    title="忘记此主机"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
              <div className="login-card__host-item login-card__host-item--add" onClick={handleStartEditHost} title="添加/编辑后端服务地址">
                <Pencil size={13} className="login-card__host-item-icon" />
                <span className="login-card__host-item-name">{selectedHost ? '编辑地址' : '添加后端地址'}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default LoginPage;
