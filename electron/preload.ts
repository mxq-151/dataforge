import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

/**
 * 通过 contextBridge 暴露给渲染层的白名单桥（window.dataforge）。
 * 渲染层所有 Tauri 兼容调用最终都落到这些 IPC 通道上。
 */
const api = {
  invoke: (cmd: string, args: unknown): Promise<unknown> =>
    ipcRenderer.invoke('df:invoke', { cmd, args }),

  listen: (event: string, handler: (payload: unknown) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: unknown) => handler(payload);
    ipcRenderer.on(`df:event:${event}`, listener);
    return () => {
      ipcRenderer.removeListener(`df:event:${event}`, listener);
    };
  },

  emit: (event: string, payload?: unknown): void => {
    ipcRenderer.send(`df:emit:${event}`, payload);
  },

  homeDir: (): Promise<string> => ipcRenderer.invoke('df:homeDir'),

  fs: (op: string, args: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke('df:fs', { op, args }),

  shell: (opts: unknown): Promise<unknown> => ipcRenderer.invoke('df:shell:execute', opts),

  httpFetch: (req: unknown): Promise<unknown> => ipcRenderer.invoke('df:http:fetch', req),

  httpAbort: (id: number): void => {
    ipcRenderer.send('df:http:abort', id);
  },

  storeRead: (file: string): Promise<unknown> => ipcRenderer.invoke('df:store:read', file),

  storeWrite: (file: string, data: unknown): Promise<void> =>
    ipcRenderer.invoke('df:store:write', { file, data }),
};

contextBridge.exposeInMainWorld('dataforge', api);

// Tauri 宿主哨兵：使原代码的 `__TAURI_INTERNALS__`/`__TAURI__` 探测全部命中
// （TitleBar / useFileSystem / useOpencodeClient 等依赖该标记走桌面分支）。
contextBridge.exposeInMainWorld('__TAURI_INTERNALS__', {} as Record<string, never>);