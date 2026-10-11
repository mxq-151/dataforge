/**
 * useOpencodeBackend — OpenCode 后端服务就绪检测 + 客户端工厂（全局单例）
 *
 * 服务进程的启动由 Electron 主进程自动完成（auto_start_opencode），
 * 前端不再负责触发启动。此 hook 只做两件事：
 * 1. 检测服务是否就绪（健康检查轮询）
 * 2. 为客户端连接提供工厂方法（createClient）
 *
 * 配置变更由 useOpencodeConfig 写入 Store，下次应用启动时由
 * auto_start_opencode 自动加载并启动服务。
 */

import { useState, useCallback, useMemo, createContext, useContext, type ReactNode } from 'react';
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/v2/client';
import { getAuthToken, getApiHost } from '../../api/index';
import type { LogEntry, OpenCodeConfig } from '../../types/opencode-backend';

export interface UseOpencodeBackendOptions {
  serverUrl: string;
  permissionMode: 'auto' | 'accept' | 'reject';
  config: OpenCodeConfig;
}

export interface UseOpencodeBackendReturn {
  /** 服务进程是否已启动且可访问 */
  serverReady: boolean;
  error: string | null;
  logs: LogEntry[];
  clearLogs: () => void;
  /** 等待服务就绪（轮询健康检查，不触发启动）。返回就绪状态和错误信息，避免调用方依赖闭包中的旧 serverReady 快照 */
  start: () => Promise<{ ready: boolean; error: string | null }>;
  /** 标记服务停止 */
  stop: () => void;
  /** 为指定目录创建独立的 OpencodeClient 实例 */
  createClient: (directory: string | null) => Promise<OpencodeClient>;
  addLog: (entry: LogEntry) => void;
}

// ── Context: 全局单例 ──
const OpencodeBackendContext = createContext<UseOpencodeBackendReturn | null>(null);

/**
 * OpencodeBackendProvider — 全局唯一的 OpenCode 后端实例提供者
 *
 * 在 App.tsx 中包裹一次，所有子组件通过 useOpencodeBackend() 获取同一个实例。
 */
export function OpencodeBackendProvider({ children, options }: {
  children: ReactNode;
  options: UseOpencodeBackendOptions;
}) {
  const backend = useOpencodeBackendImpl(options);

  return (
    <OpencodeBackendContext.Provider value={backend}>
      {children}
    </OpencodeBackendContext.Provider>
  );
}

/**
 * 获取全局 OpencodeBackend 实例
 * 必须在 OpencodeBackendProvider 内使用
 */
export function useOpencodeBackend(): UseOpencodeBackendReturn {
  const ctx = useContext(OpencodeBackendContext);
  if (!ctx) {
    throw new Error('useOpencodeBackend must be used within OpencodeBackendProvider');
  }
  return ctx;
}

/**
 * 全局单例状态：标记服务是否已被检测为就绪
 */
let globalServerDetected = false;
let globalServerUrl = '';
/** 等待锁：防止并发调用 start() 时重复轮询 */
let globalWaitingPromise: Promise<void> | null = null;

/**
 * 内部实现：检测 OpenCode 服务就绪状态 + 提供客户端工厂
 */
function useOpencodeBackendImpl(options: UseOpencodeBackendOptions): UseOpencodeBackendReturn {
  const { serverUrl, permissionMode } = options;

  const [serverReady, setServerReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const addLog = useCallback((entry: LogEntry) => {
    setLogs(prev => [...prev, entry]);
  }, []);

  const clearLogs = useCallback(() => {
    setLogs([]);
  }, []);

  /** 为指定目录创建独立的 OpencodeClient */
  const createClient = useCallback(async (directory: string | null): Promise<OpencodeClient> => {
    const token = await getAuthToken();
    const apiHost = getApiHost();

    return createOpencodeClient({
      baseUrl: serverUrl,
      authToken: token,
      permissionMode,
      apiHost,
      directory: directory || undefined,
    } as any);
  }, [serverUrl, permissionMode]);

  /** 健康检查 */
  const healthCheck = useCallback(async (): Promise<boolean> => {
    try {
      await fetch(`${serverUrl}/event`, { method: 'GET', signal: AbortSignal.timeout(5000) });
      return true;
    } catch {
      return false;
    }
  }, [serverUrl]);

  /**
   * 等待服务就绪（轮询健康检查）
   *
   * 服务启动由 Rust 后端自动完成，前端只负责等待。
   * - React 状态已就绪 → 直接返回
   * - 已有等待流程进行中 → 等待其完成
   * - 全局已检测到就绪 → 做一次健康检查确认
   * - 否则 → 轮询健康检查直到服务就绪或超时
   */
  const start = useCallback(async (): Promise<{ ready: boolean; error: string | null }> => {
    // ── React 状态已就绪，直接返回 ──
    if (serverReady) {
      return { ready: true, error: null };
    }

    // ── 并发锁：已有等待流程进行中 ──
    if (globalWaitingPromise) {
      await globalWaitingPromise;
      const ready = globalServerDetected;
      setServerReady(ready);
      return { ready, error: ready ? null : 'Agent 服务连接超时，请检查服务状态' };
    }

    setError(null);

    // ── 全局已检测到就绪，做一次确认 ──
    if (globalServerDetected && globalServerUrl === serverUrl) {
      const healthy = await healthCheck();
      if (healthy) {
        setServerReady(true);
        return { ready: true, error: null };
      }
      addLog({
        source: 'agent',
        text: '服务进程之前已就绪但健康检查失败，重新等待...',
        timestamp: new Date(),
        level: 'warn',
      });
      globalServerDetected = false;
    }

    addLog({
      source: 'agent',
      text: '正在等待 Agent 服务就绪（由 Rust 后端自动启动）...',
      timestamp: new Date(),
      level: 'info',
    });

    // 创建等待 Promise 并加锁
    const waitingPromise = (async () => {
      const maxRetries = 30; // 最多等待 60 秒
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const healthy = await healthCheck();
        if (healthy) {
          globalServerDetected = true;
          globalServerUrl = serverUrl;
          setServerReady(true);
          addLog({
            source: 'stdout',
            text: 'Agent 服务已就绪',
            timestamp: new Date(),
            level: 'info',
          });
          return;
        }
        if (attempt % 5 === 0) {
          addLog({
            source: 'agent',
            text: `等待服务就绪 ${attempt}/${maxRetries}...`,
            timestamp: new Date(),
            level: 'warn',
          });
        }
        await new Promise(r => setTimeout(r, 2000));
      }

      const msg = 'Agent 服务连接超时，请检查服务状态';
      addLog({ source: 'stderr', text: msg, timestamp: new Date(), level: 'error' });
      setError(msg);
    })();

    globalWaitingPromise = waitingPromise;

    try {
      await waitingPromise;
    } finally {
      globalWaitingPromise = null;
    }

    // 等待完成后，从全局变量读取最终状态（避免闭包中的旧 serverReady/error 快照）
    return { ready: globalServerDetected, error: globalServerDetected ? null : 'Agent 服务连接超时，请检查服务状态' };
  }, [serverReady, healthCheck, addLog, serverUrl]);

  const stop = useCallback(() => {
    globalServerDetected = false;
    setServerReady(false);
    addLog({
      source: 'agent',
      text: 'Agent 服务已停止',
      timestamp: new Date(),
      level: 'info',
    });
  }, [addLog]);

  // 用 useMemo 稳定返回对象引用，避免消费方（useOpencodeClient 中的
  // connectWithDirectory/start 等 useCallback 依赖 backend）每次渲染
  // 都拿到新对象导致下游 useCallback 引用级联失效、订阅 effect 重跑。
  // 修复前曾引发 MaxListenersExceededWarning：DevAssistantClientSlot 的
  // auto-start effect 依赖 backend.start，引用每次变就重跑 start()，
  // 而 starting 标志异步未及时生效，导致 start() 被并发调用多次，前几个
  // createClient 的 SSE 连接被新 client 覆盖前未 abort，造成 listener 泄漏。
  return useMemo(() => ({
    serverReady,
    error,
    logs,
    clearLogs,
    start,
    stop,
    createClient,
    addLog,
  }), [serverReady, error, logs, clearLogs, start, stop, createClient, addLog]);
}

export default useOpencodeBackend;
