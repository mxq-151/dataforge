/**
 * client/useOpencodeClientCore.ts — 公共运行时组装（模块无关）
 *
 * 把「所有模块都一样」的能力按依赖顺序组装起来，输出 OpencodeClientCore：
 *
 *   useAgentLog ────► 实例级日志
 *   useOpencodeSessions ─► 会话标识
 *   useOpencodeEvents ────► 消息/事件状态（需要 addLog）
 *   useOpencodeConnectionRuntime ─► 连接与工作目录（需要上述三者的清理回调）
 *   useOpencodeEventStream ─► SSE 订阅（需要 events.subscribe）
 *   useModelContextLimit / useFileReview / useSessionHistory ─► 独立能力
 *
 * 组装顺序不能随意调整：每一步只依赖它之前的步骤。工作空间差异不在这里，
 * 而是在 core 末尾交给各模块的 WorkspaceStrategy（见 ./workspace.ts）。
 *
 * core 会把一个实时刷新的 WorkspaceContext 挂在 ctxRef 上交给策略 —— 策略的钩子
 * 只在异步动作里被调用，因此读 ctxRef.current 拿到的永远是最新值，既避免了闭包
 * 旧快照，也让策略自身的 useCallback 依赖保持稳定。
 */

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { OpencodeClient } from '@opencode-ai/sdk/v2/client';
import { useOpencodeEvents, type UseOpencodeEventsReturn } from '../useOpencodeEvents';
import { useOpencodeSessions, type UseOpencodeSessionsReturn } from '../useOpencodeSessions';
import { useOpencodeChat, type UseOpencodeChatReturn } from '../useOpencodeChat';
import { useOpencodeBackend, type UseOpencodeBackendReturn } from '../useOpencodeBackend';
import {
  useAgentLog,
  useOpencodeConnectionRuntime,
  useOpencodeEventStream,
  type OpencodeConnectionRuntime,
} from './useConnectionRuntime';
import { useFileReview, type UseFileReviewReturn } from './useFileReview';
import { useSessionHistory, type UseSessionHistoryReturn } from './useSessionHistory';
import { useModelContextLimit } from './useModelContextLimit';
import type { WorkspaceContext } from './workspace';
import type { LogEntry, OpenCodeConfig } from '../../../types/opencode-backend';

export interface UseOpencodeClientCoreOptions {
  config: OpenCodeConfig;
  username?: string;
  moduleId: string;
  roleType?: string;
  projectId: string;
  /** 工作目录（项目路径），用于创建 OpencodeClient 时指定 directory */
  directory?: string | null;
  /** 模块默认任务类型（决定系统指令；各模块在 DEFAULT_TASK_TYPE_BY_MODULE 中定义） */
  defaultTaskType: string;
}

export interface OpencodeClientCore {
  // ── 环境 ──
  backend: UseOpencodeBackendReturn;
  config: OpenCodeConfig;
  username?: string;
  moduleId: string;
  roleType?: string;
  projectId: string;

  // ── 日志 ──
  logs: LogEntry[];
  addLog: (entry: LogEntry) => void;
  clearLogs: () => void;

  // ── 连接 ──
  conn: OpencodeConnectionRuntime;
  /** 当前 SDK 客户端 ref（跨模块共享，动作层/策略层都直接读它） */
  clientRef: MutableRefObject<OpencodeClient | null>;

  // ── 会话标识 ──
  currentSessionId: string | null;
  setCurrentSessionId: (id: string | null) => void;
  currentSessionParentID: string | null;
  restoreSession: (sessionId: string | null) => void;
  clearCurrentSession: () => void;

  // ── 事件与消息 ──
  events: UseOpencodeEventsReturn;
  sentUserInputsRef: MutableRefObject<Set<string>>;

  // ── 会话 SDK 操作 ──
  sessions: UseOpencodeSessionsReturn;
  /** 删除服务端会话（fire-and-forget：不阻塞 UI、失败不回滚本地结果） */
  deleteSessionRemote: (sessionId: string) => void;

  // ── 任务历史 ──
  history: UseSessionHistoryReturn;

  // ── 文件审批 ──
  review: UseFileReviewReturn;

  // ── 对话控制 ──
  chat: UseOpencodeChatReturn;

  // ── 模型 / 任务类型 ──
  activeLLMModel: { providerID: string; modelID: string } | null;
  activeLLMModelRef: MutableRefObject<{ providerID: string; modelID: string } | null>;
  setActiveLLMModel: (model: { providerID: string; modelID: string } | null) => void;
  taskType: string;
  setTaskType: (t: string) => void;

  /** 交给 WorkspaceStrategy 的实时上下文 */
  ctxRef: MutableRefObject<WorkspaceContext>;
}

export function useOpencodeClientCore(options: UseOpencodeClientCoreOptions): OpencodeClientCore {
  const { config, username, moduleId, roleType, projectId, directory, defaultTaskType } = options;

  // ── 全局后端实例（仅用于服务进程管理和客户端创建） ──
  const backend = useOpencodeBackend();

  // ── 实例级日志（必须在 events 之前） ──
  const { logs, addLog, clearLogs } = useAgentLog();

  // ── 跨模块共享的两个 ref（在连接运行时建立之前就要存在） ──
  // clientRef：会话历史 / 工作空间策略 / 动作层都要在 await 之前读到最新客户端。
  // unsubscribeRef：切目录与断开连接时必须先取消上一个 SSE 订阅。
  const clientRef = useRef<OpencodeClient | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  // ── 会话标识 ──
  const sessions = useOpencodeSessions();
  const {
    currentSessionId,
    setCurrentSessionId,
    currentSessionParentID,
    setCurrentSessionParentID,
    listSessions,
    deleteSession,
  } = sessions;

  /**
   * 清空当前会话（同时清空「子代理会话」标记）。
   * 断开连接/切换目录/新建会话/删除会话等场景统一走这里，
   * 避免 parentID 残留导致新会话的首条用户消息被误标为「子代理任务」。
   */
  const clearCurrentSession = useCallback(() => {
    setCurrentSessionId(null);
    setCurrentSessionParentID(null);
  }, [setCurrentSessionId, setCurrentSessionParentID]);

  /**
   * 恢复会话标识（切换工作目录会清空会话态，数据探索续聊时用它切回来）。
   * 切换目录只可能发生在根会话上（子代理会话共享父目录），故 parentID 归零。
   */
  const restoreSession = useCallback((sessionId: string | null) => {
    setCurrentSessionId(sessionId);
    setCurrentSessionParentID(null);
  }, [setCurrentSessionId, setCurrentSessionParentID]);

  // ── 记录"已发送的真实用户输入"（用于过滤 sub-agent 注入的内部 user 消息） ──
  const sentUserInputsRef = useRef<Set<string>>(new Set());

  // ── 事件订阅与消息状态 ──
  const events = useOpencodeEvents(addLog, { sentUserInputsRef });

  // ── 任务历史（需在连接之前：断开连接要清空任务列表，且它要读 clientRef） ──
  const history = useSessionHistory({
    username,
    moduleId,
    projectId,
    clientRef,
    listSessions,
    addLog,
  });

  // ── 连接运行时 ──
  const conn = useOpencodeConnectionRuntime({
    backend,
    moduleId,
    projectId,
    directory,
    addLog,
    resetState: events.resetState,
    clearBusy: events.clearBusy,
    clearCurrentSession,
    clearTasks: history.clearTasks,
    clientRef,
    unsubscribeRef,
  });

  // ── SSE 事件流订阅（需要 events.subscribe，故必须在两者之后） ──
  useOpencodeEventStream({
    connected: conn.connected,
    client: conn.client,
    currentDirectory: conn.currentDirectory,
    subscribe: events.subscribe,
    unsubscribeRef: conn.unsubscribeRef,
  });

  // 连接成功后自动加载任务列表
  useEffect(() => {
    if (conn.ready && conn.clientRef.current) {
      history.refreshTasks();
    }
  }, [conn.ready]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 模型 context 窗口 ──
  const [activeLLMModel, setActiveLLMModelState] = useState<{ providerID: string; modelID: string } | null>(null);
  const activeLLMModelRef = useRef<{ providerID: string; modelID: string } | null>(null);
  const setActiveLLMModel = useCallback((model: { providerID: string; modelID: string } | null) => {
    activeLLMModelRef.current = model;
    setActiveLLMModelState(model);
  }, []);

  useModelContextLimit({
    ready: conn.ready,
    clientRef,
    currentDirectory: conn.currentDirectory,
    config,
    activeLLMModel,
    setContextLimit: events.setContextLimit,
    addLog,
  });

  // ── 任务类型（覆盖 roleType，决定系统指令） ──
  const [taskType, setTaskType] = useState<string>(defaultTaskType);

  // ── 文件变更审批 ──
  const review = useFileReview({
    messages: events.messages,
    currentSessionId,
    client: conn.client,
  });

  // ── 对话控制 ──
  const chat = useOpencodeChat({
    username,
    moduleId,
    roleType: taskType || roleType,
    currentSessionId,
    setCurrentSessionId,
    addLog,
  });

  /** 删除服务端会话（不阻塞 UI；失败只记日志，不回滚本地已删除的事实） */
  const deleteSessionRemote = useCallback((sessionId: string) => {
    const c = clientRef.current;
    if (!c) return;
    void deleteSession(c, sessionId).catch(err => {
      addLog({
        source: 'agent',
        text: `删除会话失败（已从本地历史移除）: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: new Date(),
        level: 'warn',
      });
    });
  }, [deleteSession, clientRef, addLog]);

  // ── 交给 WorkspaceStrategy 的实时上下文 ──
  // 渲染期赋值：策略钩子只在异步动作里调用，读到的永远是最新值。
  const ctxRef = useRef<WorkspaceContext>({} as WorkspaceContext);
  ctxRef.current = {
    moduleId,
    username,
    currentDirectory: conn.currentDirectory,
    setWorkingDirectory: conn.setWorkingDirectory,
    currentSessionId,
    restoreSession,
    clearCurrentSession,
    tasks: history.tasks,
    setTasks: history.setTasks,
    sessionHistoryKey: history.sessionHistoryKey,
    clientRef,
    deleteSessionRemote,
    addLog,
  };

  return {
    backend,
    config,
    username,
    moduleId,
    roleType,
    projectId,
    logs,
    addLog,
    clearLogs,
    conn,
    clientRef,
    currentSessionId,
    setCurrentSessionId,
    currentSessionParentID,
    restoreSession,
    clearCurrentSession,
    events,
    sentUserInputsRef,
    sessions,
    deleteSessionRemote,
    history,
    review,
    chat,
    activeLLMModel,
    activeLLMModelRef,
    setActiveLLMModel,
    taskType,
    setTaskType,
    ctxRef,
  };
}
