/**
 * @tauri-apps/api/core 兼容垫片。
 * invoke 等通过 window.dataforge IPC 通道转发到 Electron 主进程。
 */
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return window.dataforge.invoke(cmd, args ?? {}) as Promise<T>;
}

/** 平台探测：在 Electron 桌面宿主中恒为 true（对应 Tauri 语义的「桌面环境可用」）。 */
export function isTauri(): boolean {
  return true;
}

export default invoke;