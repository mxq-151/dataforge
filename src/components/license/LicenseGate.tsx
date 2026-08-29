import { useEffect, useState, type ReactNode } from 'react';
import { Store } from '../../bridge/store';
import { ensureClientId } from '../../api/report';
import './LicenseGate.css';

// 软件使用许可协议正文（单一来源：仓库根目录 软件使用许可协议.txt，全平台共用）
// 注：.txt 为 UTF-8 带 BOM；vite 的 ?raw 会原样内联，BOM 字符在 <pre> 中正常显示无副作用
import licenseRaw from '../../../软件使用许可协议.txt?raw';

const LICENSE_STORE_FILE = 'license.json';
/** 协议版本：协议文本变更时递增，已同意的老版本需重新确认 */
const LICENSE_VERSION = '1.0';

interface LicenseRecord {
  version?: string;
  installToken?: string;
  acceptedAt?: string;
}

/**
 * 首次启动强制协议确认门：
 * - 同意标记与「本次安装」绑定（标记文件存于应用安装目录，重装即消失）
 * - 未安装标记（全新安装/重装）或标记与已存同意不匹配 → 强制重新同意；
 *   重装时旧同意记录（userData 中的 license.json）被忽略，必须再次同意
 * - 未同意前不渲染任何子内容（登录页/主界面均不可达）；点击「不同意」则退出应用
 */
export default function LicenseGate({ children }: { children: ReactNode }): React.JSX.Element {
  // 'loading' 读取同意记录中 | 'denied' 尚未同意 | 'accepted' 已同意
  const [state, setState] = useState<'loading' | 'denied' | 'accepted'>('loading');
  const [agreed, setAgreed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [store, installToken] = await Promise.all([
          Store.load(LICENSE_STORE_FILE),
          window.dataforge?.installToken?.() ?? Promise.resolve(null),
        ]);
        const rec = (await store.get<LicenseRecord>('license')) || {};
        // 已同意 = 本次安装存在标记 且 与已存同意的标记一致 且 协议版本一致
        const accepted =
          !!installToken &&
          !!rec.installToken &&
          rec.installToken === installToken &&
          rec.version === LICENSE_VERSION;
        if (!cancelled) setState(accepted ? 'accepted' : 'denied');
      } catch {
        if (!cancelled) setState('denied');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleAccept = async () => {
    try {
      // 生成并写入本次安装的同意标记；同步把标记 token 存入同意记录
      const installToken = (await window.dataforge?.markInstallToken?.()) ?? crypto.randomUUID();
      // 同意协议时生成（或重装后复用本地）唯一安装标识 client_id，供数据上报使用
      await ensureClientId();
      const store = await Store.load(LICENSE_STORE_FILE);
      await store.set('license', {
        version: LICENSE_VERSION,
        installToken,
        acceptedAt: new Date().toISOString(),
      });
      await store.save();
    } catch {
      // 持久化失败不阻塞进入，避免用户已同意却被反复拦截
    }
    setState('accepted');
  };

  const handleDecline = () => {
    // 用户拒绝协议：不在本机记录同意，直接退出应用，不进入任何界面
    if (typeof window !== 'undefined' && window.dataforge?.quitApp) {
      window.dataforge.quitApp();
    }
  };

  if (state === 'loading') {
    return <div className="lg-loading">正在加载软件使用许可协议...</div>;
  }

  if (state !== 'accepted') {
    return (
      <div className="lg-overlay">
        <div className="lg-modal">
          <div className="lg-modal__header">
            <span className="lg-modal__header-icon" aria-hidden="true">
              DataForge
            </span>
            <span className="lg-modal__title">软件使用许可协议</span>
            <span className="lg-modal__subtitle">DataForge v0.1.0</span>
          </div>

          <div className="lg-modal__body">
            <pre>{licenseRaw}</pre>
          </div>

          <label className="lg-modal__agree">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
            />
            我已阅读并同意《软件使用许可协议》全部条款
          </label>

          <div className="lg-modal__actions">
            <button
              type="button"
              className="lg-btn lg-btn--decline"
              onClick={handleDecline}
            >
              不同意并退出
            </button>
            <button
              type="button"
              className="lg-btn lg-btn--accept"
              disabled={!agreed}
              onClick={handleAccept}
            >
              同意并开始安装
            </button>
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}