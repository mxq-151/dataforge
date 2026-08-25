/**
 * @tauri-apps/api/window 兼容垫片：无边框窗口控制（TitleBar 用）。
 */
export interface WindowAPI {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
}

export function getCurrentWindow(): WindowAPI {
  return {
    minimize: () => window.dataforge.win('minimize'),
    toggleMaximize: () => window.dataforge.win('toggleMaximize'),
    close: () => window.dataforge.win('close'),
  };
}