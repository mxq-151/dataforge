import { useCallback, useEffect, useMemo, useRef } from 'react';

/**
 * SSE 事件流的传输层关注点：心跳健康检测、重连退避、恢复定时器管理。
 *
 * 原先这些都内联在 useOpencodeEvents 的 subscribe() 里，与消息/todo/modal 等
 * 领域状态挤在同一个 1400 行的 hook 中。传输层是纯机械逻辑（定时器、计数、
 * 标记位），不依赖任何业务概念，抽出来后可独立理解与测试；
 * useOpencodeEvents 则只保留领域状态与事件处理。
 *
 * 本模块只提供「零件」，不接管 while 重连循环与 AbortController 的生命周期——
 * 那部分与事件消费时序强耦合，留在调用方更安全。
 */

/** 心跳超时：超过此时间未收到任何事件（含心跳）即判定连接被静默关闭 */
export const HEARTBEAT_TIMEOUT_MS = 90_000;
/** 心跳检测间隔 */
export const HEARTBEAT_CHECK_MS = 15_000;
/** 重连后的恢复兜底：迟迟未收到 session.status 时清除执行中状态 */
export const RECOVERY_FALLBACK_MS = 15_000;

const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30_000;

export interface SseConnection {
  /** 记录一次流活动（收到任意事件，含心跳） */
  noteActivity(): void;
  /**
   * 启动心跳看护，返回停止函数（每次连接尝试结束时必须调用）。
   * isActive 用于在已主动中断时跳过告警，避免卸载后仍打印心跳超时。
   */
  startHeartbeatWatch(isActive: () => boolean): () => void;
  /** 取出并清除心跳超时标记；true 表示应中断当前流并进入重连 */
  consumeHeartbeatTimeout(): boolean;
  /** 登记重连恢复定时器，由 clearRecoveryTimers 统一清理 */
  trackRecoveryTimer(timer: ReturnType<typeof setTimeout>): void;
  /** 清理所有已登记的恢复定时器 */
  clearRecoveryTimers(): void;
  /** 指数退避，上限 30s */
  nextBackoffDelay(current: number): number;
  /** 首次重连前的延迟 */
  readonly initialReconnectDelay: number;
}

export function useSseConnection(): SseConnection {
  const lastEventTimeRef = useRef<number>(Date.now());
  // 心跳超时标记：setInterval 与 for await 之间的通信桥梁
  const heartbeatAbortFlagRef = useRef<boolean>(false);
  const recoveryTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const noteActivity = useCallback(() => {
    lastEventTimeRef.current = Date.now();
  }, []);

  const startHeartbeatWatch = useCallback((isActive: () => boolean) => {
    lastEventTimeRef.current = Date.now();
    const timer = setInterval(() => {
      if (!isActive()) return;
      const elapsed = Date.now() - lastEventTimeRef.current;
      if (elapsed > HEARTBEAT_TIMEOUT_MS) {
        console.warn(`[agent-events] 心跳超时 ${elapsed}ms，主动断开 SSE 流以触发重连`);
        // 不能直接 abort 整个重连循环，只置标记让 for await 主动跳出进入重连
        heartbeatAbortFlagRef.current = true;
      }
    }, HEARTBEAT_CHECK_MS);
    return () => clearInterval(timer);
  }, []);

  const consumeHeartbeatTimeout = useCallback((): boolean => {
    if (!heartbeatAbortFlagRef.current) return false;
    heartbeatAbortFlagRef.current = false;
    return true;
  }, []);

  const trackRecoveryTimer = useCallback((timer: ReturnType<typeof setTimeout>) => {
    recoveryTimersRef.current.push(timer);
  }, []);

  const clearRecoveryTimers = useCallback(() => {
    for (const t of recoveryTimersRef.current) {
      clearTimeout(t);
    }
    recoveryTimersRef.current = [];
  }, []);

  const nextBackoffDelay = useCallback(
    (current: number) => Math.min(current * 2, MAX_RECONNECT_DELAY_MS),
    [],
  );

  // 卸载兜底：清理尚未触发的恢复定时器，避免回调打到已卸载组件
  useEffect(() => clearRecoveryTimers, [clearRecoveryTimers]);

  // 必须缓存返回对象：调用方会把 sse 放进 useCallback/useEffect 的依赖数组，
  // 若每次渲染都返回新对象，依赖会持续变化，导致 cleanup 反复触发（例如提前
  // 清掉尚未到期的重连恢复定时器）。
  return useMemo(
    () => ({
      noteActivity,
      startHeartbeatWatch,
      consumeHeartbeatTimeout,
      trackRecoveryTimer,
      clearRecoveryTimers,
      nextBackoffDelay,
      initialReconnectDelay: INITIAL_RECONNECT_DELAY_MS,
    }),
    [
      noteActivity,
      startHeartbeatWatch,
      consumeHeartbeatTimeout,
      trackRecoveryTimer,
      clearRecoveryTimers,
      nextBackoffDelay,
    ],
  );
}
