/**
 * Electron 版 dataforge 的宿主桥接类型定义。
 * preload.ts 通过 contextBridge 暴露 window.dataforge（IPC 通道），
 * 并注入 window.__TAURI_INTERNALS__ 哨兵，使原 Tauri 代码的宿主探测全部生效。
 */
interface DataforgeBridge {
  /** 调用主进程命令（对应 Rust 侧 #[tauri::command]） */
  invoke(cmd: string, args: unknown): Promise<unknown>;
  /** 订阅主进程推送事件，返回取消订阅函数 */
  listen(event: string, handler: (payload: unknown) => void): () => void;
  /** 向主进程发送事件 */
  emit(event: string, payload?: unknown): void;
  /** 用户主目录 */
  homeDir(): Promise<string>;
  /** 窗口控制（无边框 TitleBar 用） */
  win(op: 'minimize' | 'toggleMaximize' | 'close'): Promise<void>;
  /** 文件系统操作（对应 @tauri-apps/plugin-fs） */
  fs(op: string, args: Record<string, unknown>): Promise<unknown>;
  /** 命令执行（对应 @tauri-apps/plugin-shell Command.execute） */
  shell(opts: unknown): Promise<unknown>;
  /** 跨域 HTTP 请求（对应 @tauri-apps/plugin-http fetch） */
  httpFetch(req: unknown): Promise<unknown>;
  /** 中止指定 id 的 HTTP 请求 */
  httpAbort(id: number): void;
  /** 读取 Store 文件（对应 @tauri-apps/plugin-store） */
  storeRead(file: string): Promise<unknown>;
  /** 持久化 Store 文件 */
  storeWrite(file: string, data: unknown): Promise<void>;
}

interface Window {
  dataforge: DataforgeBridge;
  __TAURI_INTERNALS__?: unknown;
  __TAURI__?: unknown;
}