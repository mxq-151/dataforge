/**
 * 主进程 → 渲染层事件桥：listen / emit 走 window.dataforge IPC。
 * 主进程用 `df:event:<channel>` 通道把事件推送到渲染层。
 */
export interface Event<T> {
  event: string;
  id: number;
  payload: T;
}

export type UnlistenFn = () => void;

export async function listen<T>(event: string, handler: (event: Event<T>) => void): Promise<UnlistenFn> {
  const unlisten = window.dataforge.listen(event, (payload) => {
    handler({ event, id: 0, payload: payload as T });
  });
  return unlisten;
}

export async function emit(event: string, payload?: unknown): Promise<void> {
  window.dataforge.emit(event, payload);
}
