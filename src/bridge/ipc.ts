/**
 * 主进程命令桥：invoke 通过 window.dataforge IPC 通道转发到 Electron 主进程。
 */
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return window.dataforge.invoke(cmd, args ?? {}) as Promise<T>;
}

export default invoke;
