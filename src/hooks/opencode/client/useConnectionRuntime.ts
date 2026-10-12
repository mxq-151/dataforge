/**
 * client/useConnectionRuntime.ts — 公共连接运行时（模块无关）
 *
 * 负责「一条 opencode 连接」的全部生命周期：客户端创建/销毁、工作目录切换、
 * SSE 事件流订阅、sidecar 崩溃监听、实例级日志。
 *
 * 与两个模块的差异无关 —— 唯一的交汇点是构造时注入的 `resetState` /
 * `clearBusy` / `clearCurrentSession`：切换连接前必须清掉消息、busy 与会话标识，
 * 否则旧会话的 message 会被带到新目录下（目录过滤只能挡住事件，挡不住本地残留）。
 */

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { OpencodeClient } from '@opencode-ai/sdk/v2/client';
import { listen } from '../../../bridge/event';
import { useOpencodeBackend, type UseOpencodeBackendReturn } from '../useOpencodeBackend';
import type { LogEntry } from '../../../types/opencode-backend';

/** 实例级日志：同时进本实例的 logs（界面日志面板）与全局 backend 日志 */
export interface UseAgentLogReturn {
  backend: UseOpencodeBackendReturn;
  logs: LogEntry[];
  addLog: (entry: LogEntry) => void;
  clearLogs: () => void;
}

/**
 * 必须在任何消费 addLog 的 hook（useOpencodeEvents 等）之前调用。
 */
export function useAgentLog(): UseAgentLogReturn {
  const backend = useOpencodeBackend();
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const addLog = useCallback((entry: LogEntry) => {
    setLogs(prev => [...prev, entry]);
    backend.addLog(entry);
  }, [backend.addLog]);

  const clearLogs = useCallback(() => {
    setLogs([]);
  }, []);

  return { backend, logs, addLog, clearLogs };
}

export interface UseOpencodeConnectionOptions {
  backend: UseOpencodeBackendReturn;
  /** 模块标识（仅用于日志与调试输出） */
  moduleId: string;
  /** 项目标识（仅用于日志与调试输出） */
  projectId: string;
  /** Provider 传入的固定工作目录（数据探索为 individual/ 基础目录） */
  directory?: string | null;
  addLog: (entry: LogEntry) => void;
  /** 清空消息与事件状态（来自 useOpencodeEvents） */
  resetState: () => void;
  /** 清除 busy（sidecar 崩溃兜底） */
  clearBusy: () => void;
  /** 清空当前会话标识（来自 useOpencodeSessions） */
  clearCurrentSession: () => void;
  /** 清空任务列表（来自 useSessionHistory）：断开连接后不得继续展示上一个目录的任务 */
  clearTasks: () => void;
  /**
   * 当前 SDK 客户端 ref。由 core 创建并共享给「会话历史 / 工作空间策略 / 动作层」——
   * 它们要在任何 await 之前读到最新客户端，且必须在连接运行时建立之前就存在。
   */
  clientRef: MutableRefObject<OpencodeClient | null>;
  /** 当前 SSE 订阅的取消函数 ref（同样由 core 创建并共享） */
  unsubscribeRef: MutableRefObject<(() => void) | null>;
}

export interface OpencodeConnectionRuntime {
  connected: boolean;
  ready: boolean;
  error: string | null;
  starting: boolean;
  client: OpencodeClient | null;
  clientRef: MutableRefObject<OpencodeClient | null>;
  currentDirectory: string | null;
  /** 当前 SSE 订阅的取消函数（切目录/断开时必须先调用） */
  unsubscribeRef: MutableRefObject<(() => void) | null>;
  start: (cwd?: string) => Promise<void>;
  connect: (serverUrl?: string) => Promise<void>;
  disconnect: () => void;
  setWorkingDirectory: (cwd: string | undefined | null) => Promise<void>;
}

export function useOpencodeConnectionRuntime(
  options: UseOpencodeConnectionOptions,
): OpencodeConnectionRuntime {
  const { backend, moduleId, projectId, directory, addLog, resetState, clearBusy, clearCurrentSession, clearTasks, clientRef, unsubscribeRef } = options;

  // ── 本客户端实例的独立状态 ──
  const [connected, setConnected] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentDirectory, setCurrentDirectory] = useState<string | null>(directory ?? null);

  // client 状态变量：与 clientRef 同步，触发重渲染供消费方获取最新 client 实例
  const [client, setClient] = useState<OpencodeClient | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [starting, setStarting] = useState(false);
  // start() 幂等锁：防止 React StrictMode 双挂载或并发 caller 在第一次 start()
  // 的 await 期间触发第二次 start()，导致多个 SSE 同时建立。
  // 用 ref 而非 state：state 异步生效，ref 立即同步。
  const startingRef = useRef(false);

  // ── 连接建立 / 工作目录切换 共用闸门 ──
  // App 层两个 slot（DevAssistantClientSlot / DataExploreClientSlot）都有「自动启动连接」
  // 的 effect：`if (!backend.connected && !backend.starting) start()`。
  // 而 setWorkingDirectory（数据探索切会话）内部必须先 doDisconnect（connected 瞬时 false）
  // 再重建连接 —— 这个窗口正是该 effect 的触发条件。用计数而非布尔，是因为 start() 与
  // setWorkingDirectory() 可能交错，最后一个结束才放开闸门；提前放开就会让那个 effect
  // 抢跑 start()（不带 cwd ⇒ 目标是模块基础目录），把刚切到的会话目录覆盖掉。
  const startBusyDepthRef = useRef(0);
  const beginStartBusy = useCallback((): (() => void) => {
    startBusyDepthRef.current += 1;
    startingRef.current = true;
    setStarting(true);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      startBusyDepthRef.current = Math.max(0, startBusyDepthRef.current - 1);
      if (startBusyDepthRef.current === 0) {
        startingRef.current = false;
        setStarting(false);
      }
    };
  }, []);

  /** 断开当前客户端连接 */
  const doDisconnect = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    clientRef.current = null;
    setClient(null);
    setConnected(false);
    clearTasks();
    setReady(false);
    setError(null);
  }, [clearTasks]);

  /** 创建客户端并连接到指定目录 */
  const connectWithDirectory = useCallback(async (dir: string | null) => {
    try {
      // 确保工作目录存在，不存在则自动创建（递归）
      if (dir) {
        try {
          const fsModule = await import('../../../bridge/fs');
          if (!(await fsModule.exists(dir))) {
            await fsModule.mkdir(dir, { recursive: true });
            addLog({
              source: 'agent',
              text: `工作目录不存在，已自动创建: ${dir}`,
              timestamp: new Date(),
              level: 'info',
            });
          }
        } catch (e) {
          addLog({
            source: 'agent',
            text: `工作目录创建失败（可能已存在或无权限）: ${e instanceof Error ? e.message : String(e)}`,
            timestamp: new Date(),
            level: 'warn',
          });
        }
      }

      const newClient = await backend.createClient(dir);
      // 防护：覆盖 clientRef 前先清理上一个 client 的 SSE 订阅和 abort controller
      // （正常路径下 effect cleanup 会做，但若 start() 被并发调用，前一个 client
      //   会被静默覆盖导致 SSE listener 泄漏）
      if (clientRef.current && clientRef.current !== newClient) {
        abortRef.current?.abort();
        unsubscribeRef.current?.();
        unsubscribeRef.current = null;
      }
      clientRef.current = newClient;
      setClient(newClient);
      abortRef.current = new AbortController();
      setCurrentDirectory(dir);
      setConnected(true);
      setError(null);
      setReady(true);
      console.log(`[OC][debug] connected working dir (module=${moduleId}, project=${projectId}):`, dir);

      addLog({
        source: 'agent',
        text: `客户端已连接${dir ? ` (工作目录: ${dir})` : ''}`,
        timestamp: new Date(),
        level: 'info',
      });
    } catch (err) {
      const msg = `连接失败: ${err instanceof Error ? err.message : String(err)}`;
      addLog({ source: 'stderr', text: msg, timestamp: new Date(), level: 'error' });
      setError(msg);
    }
  }, [backend, addLog, moduleId, projectId]);

  // ── 监听 sidecar 进程崩溃事件 ──
  // 后端在 sidecar 运行中退出（崩溃/被杀）时通过主进程事件通知前端。
  // 若不监听，前端只会看到 SSE 流反复断开重连，但永远无法成功（进程已不在），
  // 用户会困惑于"思考过程意外中断"却不知道根本原因是 sidecar 崩溃。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<string>('opencode-process-terminated', (event) => {
      if (cancelled) return;
      const detail = event.payload || 'Agent 进程已退出';
      addLog({
        source: 'stderr',
        text: `Agent 服务进程已退出：${detail}`,
        timestamp: new Date(),
        level: 'error',
      });
      // 标记连接断开：SSE 流会自动尝试重连，但 sidecar 已不在，重连会持续失败。
      // 设置 error 状态让 UI 显示明确错误，而非无限"正在重连"。
      setError(`Agent 服务已停止：${detail}`);
      setConnected(false);
      setReady(false);
      // 清除 busy 状态，避免 UI 卡在"正在思考"
      clearBusy();
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    }).catch(() => {
      // 事件监听失败时忽略（不影响客户端连接）
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 监听 directory prop 变化，如果变化则重建客户端
  const directoryPropRef = useRef(directory);
  useEffect(() => {
    if (directory === directoryPropRef.current) return;
    directoryPropRef.current = directory;

    if (connected && directory !== undefined && directory !== currentDirectory) {
      // directory prop 变了，需要重建客户端
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      resetState();
      clearCurrentSession();
      connectWithDirectory(directory ?? null);
    }
  }, [directory, connected, currentDirectory, connectWithDirectory, resetState, clearCurrentSession]);

  // 断开时重置状态
  const disconnect = useCallback(() => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    resetState();
    doDisconnect();
  }, [resetState, doDisconnect]);

  const connect = useCallback(async (_serverUrl?: string) => {
    // serverUrl 参数保留兼容但实际使用 backend 的 serverUrl
    await connectWithDirectory(directory ?? currentDirectory);
  }, [connectWithDirectory, directory, currentDirectory]);

  const start = useCallback(async (cwd?: string) => {
    const dir = cwd ?? directory ?? null;

    // ── 语义守卫：无 cwd 的 start() 只表示「确保已连接」，不得改写已确定的目录 ──
    // App 层自动启动 effect 调用的正是无 cwd 的 start()（见 beginStartBusy 注释）。
    // 若此时已有存活客户端，说明已经连上了某个目录 —— 直接返回。
    // 否则会把数据探索刚切到的会话目录（individual/{ts}）覆盖回模块基础目录
    // （individual/）。而该会话的 SSE 事件是发往会话目录的，前端按「事件目录 == 订阅
    // 目录」过滤（useOpencodeEvents.ts；子代理会话共享父目录，故不能改按 sessionID 过滤）
    // ⇒ 事件被整条丢弃：用户消息有本地回显、智能体回复永不上屏，切到别的会话再切回来
    // （loadSession 直读服务端）才看得到。
    // 实测（2026-10-12 00:35 渲染进程日志）：会话目录连接完成仅 13ms 后，基础目录的
    // 客户端就把它覆盖掉了。
    // 条件必须含 connected：sidecar 崩溃时 connected=false 但 clientRef 仍在，那种情况
    // 需要走正常流程重连，不能被这里挡掉。
    if (!cwd && clientRef.current && connected) {
      console.log('[agent-client] start() 跳过：已连接且未指定目录，保持不变:', currentDirectory);
      return;
    }

    // 幂等锁：必须在任何 await 之前设置，否则 StrictMode 双挂载的第二次 effect
    // 会在第一次 await 期间通过检查并发调用 start()。
    // 用 ref 而非 state：ref 赋值同步立即生效，state 异步批处理来不及更新。
    if (startingRef.current) {
      return;
    }
    const releaseStartBusy = beginStartBusy();

    try {
      // 先确保服务进程已启动（使用返回值避免闭包中的旧 serverReady 快照）
      const { ready: backendReady, error: backendError } = await backend.start();
      if (!backendReady) {
        setError(backendError || '服务启动失败');
        return;
      }

      // 如果已连接到同一目录，跳过
      if (connected && clientRef.current && dir === currentDirectory) {
        return;
      }

      // 断开旧连接（如果有）
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      doDisconnect();
      resetState();
      clearCurrentSession();

      // 创建新客户端
      await connectWithDirectory(dir);
    } catch (err) {
      // 兜底捕获：connectWithDirectory 已有自己的 try/catch，但任何漏出的异常
      // 不能让它成为 Unhandled Promise Rejection（effect 中 startRef.current() 没 catch）
      const msg = `start 失败: ${err instanceof Error ? err.message : String(err)}`;
      setError(msg);
      addLog({ source: 'stderr', text: msg, timestamp: new Date(), level: 'error' });
    } finally {
      releaseStartBusy();
    }
  }, [backend, directory, connected, currentDirectory, doDisconnect, resetState, clearCurrentSession, connectWithDirectory, beginStartBusy, addLog]);

  /**
   * 切换 OpenCode 工作目录（重建客户端连接）。
   */
  const setWorkingDirectory = useCallback(async (cwd: string | undefined | null) => {
    const newCwd = (cwd || '').trim();
    if (!newCwd) {
      addLog({
        source: 'agent',
        text: '切换工作目录失败: 路径为空（保持当前目录）',
        timestamp: new Date(),
        level: 'warn',
      });
      return;
    }

    if (newCwd === currentDirectory) {
      return;
    }

    // ── 切换全程持有「连接建立中」闸门 ──
    // 下面的 doDisconnect() 会把 connected 瞬时置为 false。若不同时把 starting 置为 true，
    // App 层「进入 tab 自动启动连接」的 effect（if (!connected && !starting) start()）就会
    // 在这个窗口抢跑：它调用的 start() 不带 cwd ⇒ 目标是模块基础目录 individual/，与本次
    // 要切到的会话目录 individual/{ts} 互相覆盖，谁后完成谁生效。基础目录一旦胜出，该会话
    // 的 SSE 事件被目录过滤全部丢弃 ⇒ 智能体回复不上屏（详见 start() 里的语义守卫注释）。
    // 关键：必须在 doDisconnect 之前同步置位，使 connected=false 与 starting=true 落在
    // 同一次提交里 —— 否则那个 effect 闭包里读到的 starting 仍是 false，照样抢跑。
    const releaseStartBusy = beginStartBusy();
    console.log('[agent-client] 切换工作目录开始:', currentDirectory, '→', newCwd);

    try {
      // 断开旧连接，重建客户端
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      resetState();
      clearCurrentSession();
      doDisconnect();

      // 确保服务可用
      if (!backend.serverReady) {
        await backend.start();
      }

      await connectWithDirectory(newCwd);
      console.log('[agent-client] 切换工作目录完成:', newCwd);
    } finally {
      releaseStartBusy();
    }
  }, [currentDirectory, addLog, resetState, clearCurrentSession, doDisconnect, backend, connectWithDirectory, beginStartBusy]);

  return {
    connected,
    ready,
    error,
    starting,
    client,
    clientRef,
    currentDirectory,
    unsubscribeRef,
    start,
    connect,
    disconnect,
    setWorkingDirectory,
  };
}

/** 事件订阅回调（由 useOpencodeEvents 提供） */
export type OpencodeEventSubscriber = (client: OpencodeClient, directory: string | null) => () => void;

/**
 * 连接成功后自动订阅 SSE 事件流。
 *
 * 依赖必须同时包含「客户端实例」与「工作目录」，不能只看 connected：
 * - 数据探索是「会话 = 独立工作目录」，切会话会重建客户端并换目录。若 setConnected(false)
 *   与其后的 setConnected(true) 被 React 合并进同一次提交（connected 前后都是 true），
 *   只依赖 connected 的 effect 不会重跑；而切换逻辑已先 abort 旧订阅 ⇒ 旧订阅已断、
 *   新订阅没建，本模块从此收不到任何 SSE 事件。
 * - 订阅目录必须与「事件目录」严格相等（useOpencodeEvents 按目录过滤，不相等即整条丢弃），
 *   所以这里用 currentDirectory 而非 ref 快照，确保订阅与最新目录在同一次提交里生效。
 *
 * 单独成 hook（而不是并进 useOpencodeConnectionRuntime）是为了让运行时先于
 * useOpencodeEvents 建立：订阅需要 events.subscribe，而 events 需要运行时提供的 addLog。
 */
export function useOpencodeEventStream(params: {
  connected: boolean;
  client: OpencodeClient | null;
  currentDirectory: string | null;
  subscribe: OpencodeEventSubscriber;
  unsubscribeRef: MutableRefObject<(() => void) | null>;
}): void {
  const { connected, client, currentDirectory, subscribe, unsubscribeRef } = params;

  useEffect(() => {
    if (!connected || !client) return;
    unsubscribeRef.current?.();
    unsubscribeRef.current = subscribe(client, currentDirectory);
    return () => {
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
    };
  }, [connected, client, currentDirectory, subscribe, unsubscribeRef]);
}
