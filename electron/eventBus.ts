import { BrowserWindow } from 'electron';

/** 主进程 → 渲染层事件桥（渲染层通过 compat/tauri-event listen 接收）。 */
export function emitToRenderer(win: BrowserWindow | null, channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send(`df:event:${channel}`, payload);
  }
}

export function getMainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null;
}