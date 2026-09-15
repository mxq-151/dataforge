/**
 * Electron 版 dataforge 的宿主桥接类型定义。
 * preload.ts 通过 contextBridge 暴露 window.dataforge（IPC 通道），
 * 渲染层所有本地能力（命令、事件、文件系统、shell、HTTP 代理、Store）都经此桥。
 */
interface DataforgeBridge {
  /** 调用主进程命令 */
  invoke(cmd: string, args: unknown): Promise<unknown>;
  /** 订阅主进程推送事件，返回取消订阅函数 */
  listen(event: string, handler: (payload: unknown) => void): () => void;
  /** 向主进程发送事件 */
  emit(event: string, payload?: unknown): void;
  /** 用户主目录 */
  homeDir(): Promise<string>;
  /** 系统临时目录 */
  tempDir(): Promise<string>;
  /** 文件系统操作 */
  fs(op: string, args: Record<string, unknown>): Promise<unknown>;
  /** 命令执行（主进程 child_process） */
  shell(opts: unknown): Promise<unknown>;
  /** 跨域 HTTP 请求（主进程代理） */
  httpFetch(req: unknown): Promise<unknown>;
  /** 中止指定 id 的 HTTP 请求 */
  httpAbort(id: number): void;
  /** 读取 Store 文件 */
  storeRead(file: string): Promise<unknown>;
  /** 持久化 Store 文件 */
  storeWrite(file: string, data: unknown): Promise<void>;
  /** 导出诊断配置（全部 Store，凭据字段已在主进程侧剥离为 ***） */
  storeExport(): Promise<Record<string, unknown>>;
  /** 读取数据上报所需的环境信息（OS 版本 + 应用版本） */
  systemInfo(): Promise<{ os_version: string; dataforge_version: string }>;
  /** 退出应用（用户拒绝安装协议时调用） */
  quitApp(): void;
  /** 读取当前安装在安装目录内的协议同意标记（无则视为全新安装） */
  installToken(): Promise<string | null>;
  /** 写入本次同意的安装标记，返回生成的 token（写失败返回 null） */
  markInstallToken(): Promise<string | null>;
}

interface Window {
  dataforge: DataforgeBridge;
}
