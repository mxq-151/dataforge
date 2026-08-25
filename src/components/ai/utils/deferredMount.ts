/**
 * deferredMount — 延迟挂载调度工具
 *
 * 对齐 opencode 桌面版 basic-tool.tsx 的 deferredMounts 机制，
 * 适配 React 的 useEffect cleanup 模式（替代 SolidJS onCleanup）。
 *
 * 核心机制：
 * - 模块级全局队列（所有 BasicTool 实例共享）
 * - 双层 rAF（第一帧布局，第二帧绘制后挂载，避免同帧挂载重 DOM 卡住渲染）
 * - LIFO 出队（最新交互/最靠近视口底部的工具优先挂载）
 * - 每帧只处理 1 个（避免批量挂载导致帧丢失）
 * - cancel 仅标记 inactive（不从数组移除，flush 时跳过）
 *
 * 使用场景：edit/write/apply_patch 等含重 DOM（diff viewer）的工具
 * 首次默认展开时延迟挂载，避免长会话首屏一次性挂载大量 diff。
 */

interface DeferredItem {
  active: boolean;
  fn: () => void;
}

const queue: DeferredItem[] = [];
let scheduled = false;

/** flush 队列：每帧从尾部出队 1 个（LIFO），执行后调度下一帧 */
function flush(): void {
  scheduled = false;
  while (queue.length > 0) {
    const item = queue.pop()!;
    if (item.active) {
      // 还有剩余项则调度下一帧
      if (queue.length > 0) scheduleNext();
      item.fn();
      return; // 每帧只处理 1 个
    }
    // inactive 项直接跳过，继续 pop
  }
}

/** 双层 rAF 调度 flush */
function scheduleNext(): void {
  if (scheduled) return;
  scheduled = true;
  // 双层 rAF：第一帧让 trigger 布局，第二帧 paint 后再挂载重 children
  requestAnimationFrame(() => requestAnimationFrame(flush));
}

/**
 * 调度延迟挂载。
 * 入队后立即调度双层 rAF flush。
 *
 * @returns cancel 函数（调用后该项在 flush 时被跳过）
 */
export function scheduleDeferredMount(fn: () => void): () => void {
  const item: DeferredItem = { active: true, fn };
  queue.push(item);
  scheduleNext();
  return () => {
    item.active = false;
  };
}

/**
 * 单层 rAF 调度（用于后续用户主动展开，不进全局队列，响应即时）。
 *
 * 与 scheduleDeferredMount 的区别：
 * - scheduleDeferredMount：首次默认展开使用，进全局 LIFO 队列 + 双层 rAF，每帧 1 个，防首屏 jank
 * - scheduleFrameMount：后续展开使用，单层 rAF，不排队，立即在下一帧挂载
 *
 * @returns cancel 函数（取消 rAF）
 */
export function scheduleFrameMount(fn: () => void): () => void {
  const frame = requestAnimationFrame(fn);
  return () => cancelAnimationFrame(frame);
}
