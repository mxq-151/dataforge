import React, { useState } from 'react';
import { Minus, Square, X, Maximize2 } from 'lucide-react';
import './TitleBar.css';

/**
 * 自定义标题栏组件（跨平台）。
 * 由于 Tauri config 设置了 decorations=false，需要自己实现窗口控制：
 * - macOS: 左侧 traffic lights（关闭/最小化/最大化），hover 显示符号
 * - Windows: 右侧控制按钮（最小化/最大化/关闭）
 * - 中间应用标题 + 拖拽区域（data-tauri-drag-region）
 */

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

function isTauri() {
  return typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;
}

function isMacOS() {
  return typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
}

interface WindowApi {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
}

let cachedApi: WindowApi | null = null;
async function getWindowApi(): Promise<WindowApi | null> {
  if (cachedApi) return cachedApi;
  if (!isTauri()) return null;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const w = getCurrentWindow();
    cachedApi = {
      minimize: () => w.minimize(),
      toggleMaximize: () => w.toggleMaximize(),
      close: () => w.close(),
    };
    return cachedApi;
  } catch {
    return null;
  }
}

const TitleBar: React.FC<{ title?: string }> = ({ title = 'dataforge' }) => {
  const [maximized, setMaximized] = useState(false);
  const mac = isMacOS();

  const handleMinimize = async () => {
    const api = await getWindowApi();
    if (api) await api.minimize();
  };

  const handleToggleMaximize = async () => {
    const api = await getWindowApi();
    if (api) {
      await api.toggleMaximize();
      setMaximized(m => !m);
    }
  };

  const handleClose = async () => {
    const api = await getWindowApi();
    if (api) await api.close();
  };

  return (
    <div className="title-bar" data-tauri-drag-region>
      {mac ? (
        /* macOS: 左侧 functional traffic lights */
        <div className="title-bar__left" onPointerDown={e => e.stopPropagation()}>
          <button
            type="button"
            className="title-bar__traffic title-bar__traffic--close"
            onClick={handleClose}
            title="关闭"
            aria-label="关闭"
          >
            <X size={8} className="title-bar__traffic-icon" />
          </button>
          <button
            type="button"
            className="title-bar__traffic title-bar__traffic--min"
            onClick={handleMinimize}
            title="最小化"
            aria-label="最小化"
          >
            <Minus size={8} className="title-bar__traffic-icon" />
          </button>
          <button
            type="button"
            className="title-bar__traffic title-bar__traffic--max"
            onClick={handleToggleMaximize}
            title={maximized ? '还原' : '最大化'}
            aria-label={maximized ? '还原' : '最大化'}
          >
            {maximized ? <Maximize2 size={8} className="title-bar__traffic-icon" /> : <PlusIcon />}
          </button>
        </div>
      ) : (
        /* Windows: 左侧留空 */
        <div className="title-bar__left" />
      )}

      <div className="title-bar__center" data-tauri-drag-region>
        <span className="title-bar__title">{title}</span>
      </div>

      {!mac && (
        /* Windows: 右侧控制按钮 */
        <div className="title-bar__right" onPointerDown={e => e.stopPropagation()}>
          <button
            type="button"
            className="title-bar__btn title-bar__btn--min"
            onClick={handleMinimize}
            title="最小化"
          >
            <Minus size={12} />
          </button>
          <button
            type="button"
            className="title-bar__btn title-bar__btn--max"
            onClick={handleToggleMaximize}
            title={maximized ? '还原' : '最大化'}
          >
            {maximized ? <Maximize2 size={12} /> : <Square size={12} />}
          </button>
          <button
            type="button"
            className="title-bar__btn title-bar__btn--close"
            onClick={handleClose}
            title="关闭"
          >
            <X size={12} />
          </button>
        </div>
      )}
    </div>
  );
};

/* macOS 最大化按钮用 + 符号（与原生一致） */
const PlusIcon: React.FC = () => (
  <svg width="8" height="8" viewBox="0 0 8 8" className="title-bar__traffic-icon">
    <path d="M4 1v6M1 4h6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
);

export default TitleBar;
