/**
 * useOpencodeClient — OpenCode 业务通信主 Hook
 *
 * 负责所有与 OpenCode 的业务通信：事件订阅、会话管理、消息收发、
 * 文件变更追踪、任务历史等。
 *
 * 架构：
 * - OpencodeClientRegistry: 管理所有已访问的 (moduleId, projectId) 实例，
 *   为每个组合渲染独立的 OpencodeClientProvider（保持 hook 状态不丢失）
 * - OpencodeClientProvider: 为单个 (moduleId, projectId) 创建 useOpencodeClientImpl 实例，
 *   通过 Context 向下传递。每个实例拥有独立的 OpencodeClient 连接。
 * - useOpencodeClient(): 从 Context 获取当前活跃的 client 实例
 */

import { useCallback, useMemo, useEffect, useRef, useState, createContext, useContext, type ReactNode } from 'react';
import { listen } from '../../bridge/event';
import { useOpencodeBackend } from './useOpencodeBackend';
import { useOpencodeEvents } from './useOpencodeEvents';
import { useOpencodeChat } from './useOpencodeChat';
import { useOpencodeSessions } from './useOpencodeSessions';
import type { DataExploreSessionService } from './dataExploreSessionService';
import { joinPath } from '../../utils/pathUtils';
import { buildScopedStorageKey } from '../../features/execHistory';
import {
  buildSessionHistoryKey,
  loadSessionHistory,
  saveSessionHistory,
  upsertSessionHistory,
  removeSessionHistoryEntry,
} from './sessionHistoryStore';
/** 任务历史记录（从 SDK Session 映射） */
export interface TaskRecord {
  /** OpenCode session ID */
  sessionId: string;
  /** 任务名称 */
  title: string;
  /** 创建时间戳（ms） */
  createdAt: number;
  /** 最后更新时间戳（ms） */
  updatedAt: number;
}
import * as fileReviewStore from './fileReviewStore';
import type { OpenCodeConfig, Todo, MessageEntry, LogEntry, FileChange } from '../../types/opencode-backend';
import type { OpencodeClient } from '@opencode-ai/sdk/v2/client';
import { getHardcodedContextLimit, resolveContextLimit } from './modelContextLimit';

/**
 * 读取「会话ID → 独立工作目录」映射（按 host+user 隔离键）。
 *
 * 注：这里仍用 localStorage 而非 SyncedStore，是刻意为之而非遗漏——
 * 该映射被 useRef 当作初始值**同步**读取，改成异步加载会让首帧恢复会话目录时
 * 拿到空映射，导致已建立的「会话 ↔ 目录」关联丢失；且它是不含凭据的小体积
 * 元数据，迁移到磁盘存储没有安全或容量收益。
 */
function loadDeDirMap(key: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** 持久化「会话ID → 独立工作目录」映射 */
function saveDeDirMap(key: string, map: Record<string, string>): void {
  try {
    localStorage.setItem(key, JSON.stringify(map));
  } catch {
    // localStorage 不可用时静默忽略
  }
}

export interface OpencodeClientBackend {
  messages: MessageEntry[];
  busy: boolean;
  busyLabel: string | undefined;
  /** retry 状态（session.status 事件 type==='retry' 时设置） */
  retry: import('../../types/opencode-backend').RetryState | null;
  ready: boolean;
  connected: boolean;
  error: string | null;
  modals: import('../../types/opencode-backend').ModalRequest[];
  logs: LogEntry[];
  currentSessionId: string | null;
  /**
   * 当前会话是否为子代理会话（opencode 会话树中带 parentID 的子会话）。
   * 为 true 时，其首条用户消息是主会话注入的子代理任务 prompt，
   * 时间线需把它标注为「子代理任务」而不是用户输入。
   */
  currentSessionIsSubagent: boolean;
  lastFileChangeSeq: number;
  lastFileChangePaths: string[];
  todos: Todo[];
  /** 文件变更列表（来自 edit/write/apply_patch 工具） */
  fileChanges: FileChange[];
  /** 审批文件变更（按 partID 标识具体变更） */
  approveFileChange: (partID: string) => void;
  /** 拒绝文件变更（含变更详情，用于调用 SDK revert API 回退文件） */
  rejectFileChange: (filePath: string, change: { type: 'edit' | 'write' | 'apply_patch'; messageID?: string; partID?: string }) => void | Promise<void>;
  /** 全部审批通过 */
  approveAllFileChanges: () => void;
  /** 当前会话的 token 使用情况 */
  contextUsage: import('./useOpencodeEvents').ContextUsage;
  /** 本地任务历史列表 */
  tasks: TaskRecord[];

  /** 数据探索：会话工作目录标签页列表（会话=标签页，仅"已打开"的目录） */
  dataExploreDirs?: Array<{ dir: string; filePath: string }>;
  /** 数据探索：会话目录版本号（打开/关闭/新建/删除会话时递增，驱动编辑器标签页同步） */
  dataExploreDirsVersion?: number;
  /** 数据探索：删除会话（同时删除其 individual/{timestamp} 目录与 opencode 会话） */
  dataExploreDeleteSession?: (dir: string) => Promise<void>;
  /** 数据探索：任务（用户对话）→ 工作目录 SQL 文件（供任务下拉勾选打开，仅已关联会话） */
  dataExploreTaskFiles?: Array<{ sessionId: string; dir: string; filePath: string; title: string }>;
  /** 数据探索：勾选/取消勾选任务 → 打开/关闭对应文件标签（不动 AI 工作目录） */
  dataExploreToggleSession?: (sessionId: string) => void;
  /** 数据探索：关闭指定目录的文件标签（编辑器关标签用，不删会话/目录） */
  dataExploreCloseFile?: (dir: string) => void;

  sendMessage: (line: string) => Promise<void>;
  sendInterrupt: () => Promise<void>;
  sendRollback: (messageId: string) => Promise<{ success: boolean }>;
  sendPermissionResponse: (requestId: string, response: 'once' | 'always' | 'reject') => void;
  /** 回复提问请求 */
  sendQuestionReply: (requestId: string, answers: string[][]) => void;
  /** 拒绝提问请求 */
  sendQuestionReject: (requestId: string) => void;
  /**
   * 压缩当前会话的历史消息。
   * 调用 OpenCode session.summarize API；操作开始/结束会在对话区显示系统提示。
   * 压缩进行中返回 true 表示请求已发出（实际结果会通过 session.compacted 事件回传）。
   */
  compressSession: () => Promise<{ success: boolean }>;
  /** 当前是否正在执行压缩操作（按钮 disabled / loading 状态） */
  compressing: boolean;
  clearLogs: () => void;

  newSession: () => Promise<void>;
  loadSession: (sessionId: string) => Promise<void>;
  listSessions: () => Promise<import('../../types/opencode-backend').Session[]>;
  deleteSession: (sessionId: string) => Promise<void>;
  /** 重命名任务（通过 SDK session.update 更新标题） */
  renameTask: (sessionId: string, newTitle: string) => Promise<void>;

  /** 启动服务并连接（使用 provider 的 directory） */
  start: (cwd?: string) => Promise<void>;
  /** 连接到已运行的服务（使用 provider 的 directory） */
  connect: (serverUrl?: string) => Promise<void>;
  /** 断开连接 */
  disconnect: () => void;

  /** 切换工作目录（重建客户端连接） */
  setWorkingDirectory: (cwd: string | undefined | null) => Promise<void>;
  /** 当前工作目录 */
  currentDirectory: string | null;
  /** 是否正在启动中（防止 start() 过程中的 connected 状态翻转触发重复调用） */
  starting: boolean;
  /**
   * 设置当前激活的 LLM 模型（用于运行时切换）。
   * 后续 sendMessage / compressSession 调用将使用该模型，覆盖服务端默认配置。
   * 传入 null 清除覆盖，回退到服务端配置。
   */
  setActiveLLMModel: (model: { providerID: string; modelID: string } | null) => void;
  /** 当前激活的 LLM 模型（null 表示使用服务端默认配置） */
  activeLLMModel: { providerID: string; modelID: string } | null;

  /** 任务类型（覆盖角色，决定系统指令；默认 DATA_ARCHITECT 数仓设计） */
  taskType: string;
  /** 切换任务类型 */
  setTaskType: (t: string) => void;

  /** 当前 OpencodeClient 实例（连接后可用，供时间线和 SubagentTaskCard 调用 API） */
  client: OpencodeClient | null;
  /**
   * 读取 part 的流式文本（对齐桌面版 part_text_accum_delta）。
   * 流式过程中返回 delta 累积值，流式结束后返回 part.text 全量值。
   */
  readPartText: (partID: string, part: import('../../types/opencode-backend').Part) => string;
  /**
   * 订阅指定 part 的流式文本变化。
   * 用于把逐字增长的重渲染范围收缩到该 part 自身（见 useOpencodeEvents）。
   */
  subscribePartText: (partID: string, listener: () => void) => () => void;
}

/**
 * 硬编码的模型 context 窗口表 + 合并策略见 ./modelContextLimit。
 * 这里只保留 API 查询策略（location + 重试）。
 */

// ── Context: 每个 (moduleId, projectId) 独立实例 ──

const OpencodeClientContext = createContext<OpencodeClientBackend | null>(null);

/**
 * 获取当前 moduleId + projectId 对应的 OpencodeClientBackend 实例
 * 必须在 OpencodeClientProvider 内使用
 */
export function useOpencodeClient(): OpencodeClientBackend {
  const ctx = useContext(OpencodeClientContext);
  if (!ctx) {
    throw new Error('useOpencodeClient must be used within OpencodeClientProvider');
  }
  return ctx;
}

// ── Provider: 为单个 (moduleId, projectId) 创建 hook 实例 ──

export interface OpencodeClientProviderProps {
  children: ReactNode;
  config: OpenCodeConfig;
  username?: string;
  moduleId: string;
  roleType?: string;
  projectId: string;
  /** 工作目录（项目路径），用于创建 OpencodeClient 时指定 directory */
  directory?: string | null;
  /** 数据探索会话目录服务（各模块计算好独立工作目录路径后注入，实现解耦） */
  dataExploreService?: DataExploreSessionService | null;
}

/**
 * OpencodeClientProvider — 为单个 (moduleId, projectId) 创建并维护独立的 client 实例
 *
 * 每个 Provider 挂载一次 useOpencodeClientImpl，保持 hook 状态不丢失。
 * 即使项目当前未激活（未显示），只要 Provider 仍在组件树中，状态就会被保留。
 */
export function OpencodeClientProvider({
  children,
  config,
  username,
  moduleId,
  roleType,
  projectId,
  directory,
  dataExploreService,
}: OpencodeClientProviderProps) {
  const client = useOpencodeClientImpl(config, username, moduleId, roleType, projectId, directory, dataExploreService);

  return (
    <OpencodeClientContext.Provider value={client}>
      {children}
    </OpencodeClientContext.Provider>
  );
}

// ── Registry: 管理多个项目的 Provider ──

// ── 实现 ──

/**
 * 业务通信主 hook：组合所有子模块
 * 每个 (moduleId, projectId) 组合拥有独立的 OpencodeClient 连接
 */
function useOpencodeClientImpl(
  config: OpenCodeConfig,
  username?: string,
  moduleId?: string,
  roleType?: string,
  projectId?: string,
  directory?: string | null,
  dataExploreService?: DataExploreSessionService | null,
): OpencodeClientBackend {
  // ── 全局后端实例（仅用于服务进程管理和客户端创建） ──
  const backend = useOpencodeBackend();

  // ── 本客户端实例的独立状态 ──
  const [connected, setConnected] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [currentDirectory, setCurrentDirectory] = useState<string | null>(directory ?? null);

  const clientRef = useRef<OpencodeClient | null>(null);
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

  // ── 当前激活的 LLM 模型（运行时切换，覆盖服务端默认配置） ──
  const [activeLLMModel, setActiveLLMModelState] = useState<{ providerID: string; modelID: string } | null>(null);
  // ── 任务类型（覆盖 roleType，决定系统指令） ──
  // 数据探索模块默认数据分析，其他模块默认数仓设计
  const [taskType, setTaskType] = useState<string>(moduleId === 'data-explore' ? 'DATA_ANALYST' : 'DATA_ARCHITECT');
  const activeLLMModelRef = useRef<{ providerID: string; modelID: string } | null>(null);

  // ── 数据探索：会话 ↔ 独立工作目录 ──
  // 仅 data-explore 模块启用；路径（individual/{timestamp}/user_{user}.sql）由模块层
  // 通过 dataExploreService 注入计算，这里只做会话目录状态管理与映射持久化。
  const isDataExplore = moduleId === 'data-explore';
  const [dataExploreDirs, setDataExploreDirs] = useState<Array<{ dir: string; filePath: string }>>([]);
  const [dataExploreDirsVersion, setDataExploreDirsVersion] = useState(0);
  const bumpDeVersion = useCallback(() => setDataExploreDirsVersion(v => v + 1), []);
  // 会话ID → 工作目录 映射（持久化，按 host+user 隔离）
  const deDirMapKeyRef = useRef<string>(buildScopedStorageKey('dataforge_dataexplore_sessiondirs', username || ''));
  const deDirMapRef = useRef<Record<string, string>>(loadDeDirMap(deDirMapKeyRef.current));
  // 待关联目录：新建会话后首个形成的 opencode 会话归属该目录
  const pendingDeDirRef = useRef<string | null>(null);
  // 首次扫描守卫（避免 effect 重复触发重连）
  const scannedDeDirsRef = useRef(false);

  const setActiveLLMModel = useCallback((model: { providerID: string; modelID: string } | null) => {
    activeLLMModelRef.current = model;
    setActiveLLMModelState(model);
  }, []);

  const addLog = useCallback((entry: LogEntry) => {
    setLogs(prev => [...prev, entry]);
    backend.addLog(entry);
  }, [backend.addLog]);

  const clearLogs = useCallback(() => {
    setLogs([]);
  }, []);

  // ── 会话管理 ──
  const {
    currentSessionId,
    setCurrentSessionId,
    currentSessionParentID,
    setCurrentSessionParentID,
    loadSession,
    listSessions,
    deleteSession,
  } = useOpencodeSessions();

  /**
   * 清空当前会话（同时清空「子代理会话」标记）。
   * 断开连接/切换目录/新建会话/删除会话等场景统一走这里，
   * 避免 parentID 残留导致新会话的首条用户消息被误标为「子代理任务」。
   */
  const clearCurrentSession = useCallback(() => {
    setCurrentSessionId(null);
    setCurrentSessionParentID(null);
  }, [setCurrentSessionId, setCurrentSessionParentID]);

  // ── 记录"已发送的真实用户输入"（用于过滤 sub-agent 注入的内部 user 消息） ──
  const sentUserInputsRef = useRef<Set<string>>(new Set());

  // ── 事件订阅与消息状态 ──
  const {
    messages,
    busy,
    busyLabel,
    retry,
    modals,
    todos,
    setTodos,
    lastFileChangeSeq,
    lastFileChangePaths,
    contextUsage,
    clearBusy,
    subscribe,
    resetState,
    addMessage,
    removeMessagesAfter,
    setMessagesDirect,
    setContextLimit,
    readPartText,
    subscribePartText,
  } = useOpencodeEvents(addLog, {
    sentUserInputsRef,
  });

  // ── 文件变更追踪（从消息中的 edit/write/apply_patch 工具提取） ──
  const [fileChanges, setFileChanges] = useState<FileChange[]>([]);
  const [fileChangesApproved, setFileChangesApproved] = useState<Set<string>>(new Set());
  const [fileChangesRejected, setFileChangesRejected] = useState<Set<string>>(new Set());
  // 异步加载标记：Store 读取是异步的，加载完成前不触发 status 计算
  const [reviewStateLoaded, setReviewStateLoaded] = useState(false);

  /**
   * 从消息列表中提取文件变更，根据审批状态集合确定 status。
   *
   * 变更唯一键使用 partID（每个工具调用对应一个独立 part）：
   * - 同一文件在不同轮次的变更各自保留为独立条目，不会按 filePath 合并
   * - 审批状态绑定 partID，新轮次的变更不会继承旧轮次的"已通过/已拒绝"状态
   * - changeMap 按 partID 去重（同一 part 被多次更新时只保留最新状态）
   */
  const extractFileChangesFromMessages = useCallback((
    msgs: MessageEntry[],
    approved: Set<string>,
    rejected: Set<string>,
  ): FileChange[] => {
    const changeMap = new Map<string, FileChange>();
    const FILE_TOOLS = new Set(['edit', 'write', 'apply_patch']);

    for (const entry of msgs) {
      if (entry.info.role !== 'assistant') continue;
      for (const part of entry.parts) {
        if (part.type !== 'tool') continue;
        const toolPart = part as any;
        if (!FILE_TOOLS.has(toolPart.tool)) continue;

        const state = toolPart.state as any;
        const filePath = state?.input?.filePath
          || state?.metadata?.filediff?.file
          || '';
        if (!filePath) continue;

        // partID 是每个工具调用的全局唯一标识，用作变更唯一键
        const partID = (part as any).id || '';
        if (!partID) continue;

        const patch = state?.metadata?.filediff?.patch || '';
        let additions = 0;
        let deletions = 0;
        if (patch) {
          for (const line of patch.split('\n')) {
            if (line.startsWith('+') && !line.startsWith('+++')) additions++;
            if (line.startsWith('-') && !line.startsWith('---')) deletions++;
          }
        }

        const status: FileChange['status'] = rejected.has(partID) ? 'rejected'
          : approved.has(partID) ? 'approved'
          : 'pending';

        changeMap.set(partID, {
          filePath,
          patch: patch || undefined,
          additions,
          deletions,
          type: toolPart.tool,
          status,
          messageID: entry.info.id,
          partID,
        });
      }
    }
    return Array.from(changeMap.values());
  }, []);

  // session 变化时，从 Store 异步加载审批状态，然后提取文件变更
  useEffect(() => {
    if (!currentSessionId) {
      setFileChangesApproved(new Set());
      setFileChangesRejected(new Set());
      setFileChanges([]);
      setReviewStateLoaded(true);
      return;
    }

    let cancelled = false;
    setReviewStateLoaded(false);

    async function loadAndRefresh() {
      try {
        const sid = currentSessionId!;
        const [approvedArr, rejectedArr] = await Promise.all([
          fileReviewStore.load(sid, 'approved'),
          fileReviewStore.load(sid, 'rejected'),
        ]);
        if (cancelled) return;

        const approved = new Set<string>(approvedArr);
        const rejected = new Set<string>(rejectedArr);
        setFileChangesApproved(approved);
        setFileChangesRejected(rejected);
        setReviewStateLoaded(true);

        console.log(`[file-review] 从 Store 加载完成: approved=${approved.size}, rejected=${rejected.size}`);
      } catch (e) {
        console.warn('[file-review] Store 加载失败，使用空状态:', e);
        setFileChangesApproved(new Set());
        setFileChangesRejected(new Set());
        setReviewStateLoaded(true);
      }
    }

    loadAndRefresh();
    return () => { cancelled = true; };
  }, [currentSessionId]);

  // 审批状态加载完成后，消息变化时重新提取文件变更
  useEffect(() => {
    if (!reviewStateLoaded) return;
    const changes = extractFileChangesFromMessages(messages, fileChangesApproved, fileChangesRejected);
    setFileChanges(changes);
  }, [messages, fileChangesApproved, fileChangesRejected, reviewStateLoaded, extractFileChangesFromMessages]);

  const approveFileChange = useCallback((partID: string) => {
    const newApproved = new Set(fileChangesApproved);
    newApproved.add(partID);
    const newRejected = new Set(fileChangesRejected);
    newRejected.delete(partID);
    setFileChangesApproved(newApproved);
    setFileChangesRejected(newRejected);
    setFileChanges(extractFileChangesFromMessages(messages, newApproved, newRejected));
    const sid = currentSessionId;
    if (sid) {
      fileReviewStore.save(sid, 'approved', Array.from(newApproved));
      fileReviewStore.save(sid, 'rejected', Array.from(newRejected));
    }
  }, [fileChangesApproved, fileChangesRejected, messages, extractFileChangesFromMessages, currentSessionId]);

  const rejectFileChange = useCallback(async (filePath: string, change: { type: 'edit' | 'write' | 'apply_patch'; messageID?: string; partID?: string }) => {
    // 审批状态按 partID 追踪（每个工具调用独立审批，不继承同文件旧轮次的状态）
    const changeKey = change.partID || filePath;
    const newRejected = new Set(fileChangesRejected);
    newRejected.add(changeKey);
    const newApproved = new Set(fileChangesApproved);
    newApproved.delete(changeKey);
    setFileChangesRejected(newRejected);
    setFileChangesApproved(newApproved);
    setFileChanges(extractFileChangesFromMessages(messages, newApproved, newRejected));
    const sid = currentSessionId;
    if (sid) {
      fileReviewStore.save(sid, 'approved', Array.from(newApproved));
      fileReviewStore.save(sid, 'rejected', Array.from(newRejected));
    }
    // 通过 SDK session.revert API 回退文件，让「拒绝」真正撤销该部分对应的文件变更。
    // 这是通用实现（dev-assistant 在视图层另有覆盖，此处作为各智能体对话模块的兜底）。
    if (!client || !sid || !change.messageID) {
      // 无法通过 SDK 回退时（无 client / 无会话 / 无 messageID），仅更新审批状态，
      // 由视图层决定降级处理（如新建文件直接删除）。
      return;
    }
    try {
      await client.session.revert({
        sessionID: sid,
        messageID: change.messageID,
        partID: change.partID,
      });
    } catch (err) {
      console.warn('[agent] 拒绝文件变更回退失败:', err);
    }
  }, [fileChangesApproved, fileChangesRejected, messages, extractFileChangesFromMessages, currentSessionId, client]);

  const approveAllFileChanges = useCallback(() => {
    const newApproved = new Set(fileChangesApproved);
    for (const c of fileChanges) {
      if (c.partID) newApproved.add(c.partID);
    }
    const newRejected = new Set<string>();
    setFileChangesApproved(newApproved);
    setFileChangesRejected(newRejected);
    setFileChanges(extractFileChangesFromMessages(messages, newApproved, newRejected));
    const sid = currentSessionId;
    if (sid) {
      fileReviewStore.save(sid, 'approved', Array.from(newApproved));
      fileReviewStore.save(sid, 'rejected', Array.from(newRejected));
    }
  }, [fileChanges, fileChangesApproved, messages, extractFileChangesFromMessages, currentSessionId]);

  // ── 任务历史（本地存储持久化，按 backend_host/user/model_id/project_id 隔离） ──
  const [tasks, setTasks] = useState<TaskRecord[]>([]);

  // 会话历史存储 key：{backend_host}/{user}/{model_id}/{project_id}
  // model_id 为模块标识（数据探索=data-explore / 开发助手=dev-assistant），host 由
  // buildSessionHistoryKey 内部从当前全局 apiHost 读取
  const sessionHistoryKey = useMemo(
    () => buildSessionHistoryKey({ username, modelId: moduleId, projectId }),
    [username, moduleId, projectId],
  );

  // 已从服务端做过初始播种的存储 key：本地被清空（如删除全部会话）后不再从
  // 服务端回填，避免把已删除但服务端仍存在（尤其 data-explore 按目录隔离）的会话复活。
  const seededHistoryKeysRef = useRef<Set<string>>(new Set());

  /** 从 SDK Session[] 映射为 TaskRecord[] */
  const mapSessionsToTasks = useCallback((sessions: any[]): TaskRecord[] => {
    return sessions.map(s => ({
      sessionId: s.id,
      title: s.title || '新对话',
      createdAt: s.time?.created ?? 0,
      updatedAt: s.time?.updated ?? 0,
    })).sort((a, b) => b.updatedAt - a.updatedAt); // 按更新时间降序
  }, []);

  /** 刷新任务列表：优先读取本地会话历史；仅当本地为空且该 key 尚未播种时才回退服务端 */
  const refreshTasks = useCallback(async () => {
    const key = sessionHistoryKey;
    const local = loadSessionHistory(key);
    if (local.length > 0) {
      setTasks(local);
      return;
    }
    // 本地为空：若该 key 已播种过（曾真实出现过历史），一律视为「已删空/无历史」，
    // 不再回退服务端，防止复用已删除会话。
    if (seededHistoryKeysRef.current.has(key)) {
      setTasks([]);
      return;
    }
    const c = clientRef.current;
    if (!c) return;
    try {
      const sessions = await listSessions(c);
      const mapped = mapSessionsToTasks(sessions);
      setTasks(mapped);
      saveSessionHistory(key, mapped);
      seededHistoryKeysRef.current.add(key);
    } catch (err) {
      addLog({ source: 'agent', text: `刷新任务列表失败: ${err instanceof Error ? err.message : String(err)}`, timestamp: new Date(), level: 'warn' });
    }
  }, [sessionHistoryKey, listSessions, mapSessionsToTasks, addLog]);

  // 存储 key（模型/host/用户/项目变化）变化时重新加载对应维度的会话历史
  useEffect(() => {
    refreshTasks();
  }, [sessionHistoryKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // 连接成功后自动加载任务列表
  useEffect(() => {
    if (ready && clientRef.current) {
      refreshTasks();
    }
  }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 设置模型 context 限制 ──
  // 优先从 SDK client.model.list() 获取当前模型的真实 limit.context，
  // 替代硬编码推断（硬编码无法覆盖自定义模型和新模型）。
  //
  // 两个必须踩住的坑（2026-09-13 修复，症状：进度条显示 181.7k/128.0k = 142%）：
  // 1. **必须带 location**。`/api/model` 按 location 惰性初始化实例，不带
  //    location 时服务端只用自己的 cwd 兜底；带 location 才能查到目标项目实例
  //    的模型表。SDK 会把它同时写进 header 与 query。
  // 2. **冷实例首次查询会「成功但返回空」**。实例尚未完成 provider 加载时接口
  //    返回 200 + `data: []`，只查一次就会静默回落到硬编码表，而那正是被
  //    `deepseek-flash`（DeepSeek V4.1 Flash）漏判成 128k 的那张表。故按
  //    递增间隔重试几次，把冷启动窗口让过去。
  const fetchModelContextLimit = useCallback(async (
    c: OpencodeClient,
    modelID: string,
    providerID: string,
    dir: string | null,
    isCancelled: () => boolean,
  ) => {
    const hardcodedLimit = getHardcodedContextLimit(modelID);

    /** 查一次 API，返回 limit.context（查不到返回 null） */
    const queryApiLimit = async (): Promise<{ limit: number | null; reason: string }> => {
      try {
        const result = await c.v2.model.list(
          dir ? { location: { directory: dir } } : undefined
        );
        const models = (result.data as any)?.data ?? result.data;
        if (!Array.isArray(models)) {
          return { limit: null, reason: '返回体不是模型数组' };
        }
        const matched = models.find((m: any) => m.id === modelID && m.providerID === providerID)
          ?? models.find((m: any) => m.id === modelID);
        const ctx = matched?.limit?.context;
        if (typeof ctx === 'number' && ctx > 0) {
          return { limit: ctx, reason: 'ok' };
        }
        return { limit: null, reason: `模型表中无 ${modelID}（共 ${models.length} 条）` };
      } catch (err) {
        return { limit: null, reason: err instanceof Error ? err.message : String(err) };
      }
    };

    // 冷实例返回空列表是「会自愈」的，重试间隔按 0 / 800 / 1600 / 3200ms 递增
    const RETRY_DELAYS_MS = [0, 800, 1600, 3200];
    let lastReason = '';

    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
      if (attempt > 0) {
        await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      }
      if (isCancelled()) return;

      const { limit, reason } = await queryApiLimit();
      if (isCancelled()) return;

      if (limit != null) {
        const finalLimit = resolveContextLimit(limit, modelID);
        setContextLimit(finalLimit);
        addLog({
          source: 'agent',
          text: `模型 ${providerID}/${modelID} contextLimit=${finalLimit}（API=${limit}, 硬编码=${hardcodedLimit}, 第 ${attempt + 1} 次查询）`,
          timestamp: new Date(),
          level: 'info',
        });
        return;
      }

      lastReason = reason;
      addLog({
        source: 'agent',
        text: `第 ${attempt + 1}/${RETRY_DELAYS_MS.length} 次查询模型 ${providerID}/${modelID} 的 limit 未命中：${reason}`,
        timestamp: new Date(),
        level: 'warn',
      });
    }

    // 重试耗尽 → 硬编码兜底（此处才是真正需要警惕的路径：说明 API 一直不可用）
    if (isCancelled()) return;
    setContextLimit(hardcodedLimit);
    addLog({
      source: 'agent',
      text: `未从 API 获得模型 ${providerID}/${modelID} 的 limit（${lastReason}），使用硬编码 fallback (${hardcodedLimit})`,
      timestamp: new Date(),
      level: 'warn',
    });
  }, [setContextLimit, addLog]);

  // 当客户端连接、目录变化或模型切换时，获取真实的 contextLimit。
  // 用自增序号做「最后一次调用生效」的保护：模型/目录连续切换时，先发起的那次
  // 查询（含重试）可能后返回，不能让它覆盖新模型的结果。
  const limitFetchSeqRef = useRef(0);
  useEffect(() => {
    const c = clientRef.current;
    if (!c || !ready) return;
    const modelID = activeLLMModel?.modelID ?? config.model;
    const providerID = activeLLMModel?.providerID ?? config.modelProvider;
    if (!modelID) return;
    const seq = ++limitFetchSeqRef.current;
    fetchModelContextLimit(c, modelID, providerID, currentDirectory, () => seq !== limitFetchSeqRef.current);
  }, [ready, currentDirectory, config.model, config.modelProvider, activeLLMModel, fetchModelContextLimit]);

  // ── 对话控制 ──
  const {
    sendMessage: sendChatMessage,
    sendInterrupt: sendChatInterrupt,
    sendRollback: sendChatRollback,
    sendPermissionResponse: sendChatPermissionResponse,
    sendQuestionReply: sendChatQuestionReply,
    sendQuestionReject: sendChatQuestionReject,
    sendSummarize: sendChatSummarize,
  } = useOpencodeChat({
    username,
    moduleId,
    roleType: taskType || roleType,
    currentSessionId,
    setCurrentSessionId,
    addLog,
  });

  // ── 上下文压缩状态 ──
  const [compressing, setCompressing] = useState(false);

  // 跟踪是否正在取消订阅
  const unsubscribeRef = useRef<(() => void) | null>(null);

  // ── 客户端连接管理 ──

  /** 断开当前客户端连接 */
  const doDisconnect = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    clientRef.current = null;
    setClient(null);
    setConnected(false);
    setTasks([]);
    setReady(false);
    setError(null);
  }, []);

  /** 创建客户端并连接到指定目录 */
  const connectWithDirectory = useCallback(async (dir: string | null) => {
    try {
      // 确保工作目录存在，不存在则自动创建（递归）
      if (dir) {
        try {
          const fsModule = await import('../../bridge/fs');
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
  }, [backend, addLog]);

  // 连接成功后自动订阅事件。
  //
  // 依赖必须同时包含「客户端实例」与「工作目录」，不能只看 connected：
  // - 数据探索是「会话 = 独立工作目录」，切会话会重建客户端并换目录。若 setConnected(false)
  //   与其后的 setConnected(true) 被 React 合并进同一次提交（connected 前后都是 true），
  //   只依赖 connected 的 effect 不会重跑；而切换逻辑已先 abort 旧订阅 ⇒ 旧订阅已断、
  //   新订阅没建，本模块从此收不到任何 SSE 事件。
  // - 订阅目录必须与「事件目录」严格相等（useOpencodeEvents 按目录过滤，不相等即整条丢弃），
  //   所以这里用 currentDirectory 而非 ref 快照，确保订阅与最新目录在同一次提交里生效。
  useEffect(() => {
    if (!connected || !client) return;
    unsubscribeRef.current?.();
    unsubscribeRef.current = subscribe(client, currentDirectory);
    return () => {
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
    };
  }, [connected, client, currentDirectory, subscribe]);

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
      const { ready, error: backendError } = await backend.start();
      if (!ready) {
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
  }, [backend, directory, connected, currentDirectory, doDisconnect, resetState, clearCurrentSession, connectWithDirectory, beginStartBusy]);

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

  // 包装 chat 方法，自动传入 client
  const sendMessage = useCallback(async (line: string) => {
    if (!clientRef.current) {
      addLog({
        source: 'stderr',
        text: '未连接 Agent 服务，无法发送消息',
        timestamp: new Date(),
        level: 'error',
      });
      return;
    }

    const trimmed = line.trim();
    if (trimmed) {
      sentUserInputsRef.current.add(trimmed);
      if (sentUserInputsRef.current.size > 20) {
        const first = sentUserInputsRef.current.values().next().value;
        if (first !== undefined) sentUserInputsRef.current.delete(first);
      }
    }

    let sessionId: string | null = currentSessionId;

    // 数据探索：续聊「已存在的会话」时必须先把连接切到该会话的独立工作目录。
    // 每个会话 = individual/{ts} 独立目录；若沿 base 目录发送，SSE 事件发往会话
    // 自己的工作目录，与本模块订阅目录不一致 → 事件被目录过滤，只能看到本地临时
    // 消息、看不到智能体回复（开发助手是固定目录，不受影响）。
    if (isDataExplore && dataExploreService && sessionId) {
      const mappedDir = deDirMapRef.current[sessionId];
      if (mappedDir && mappedDir !== currentDirectory) {
        await setWorkingDirectory(mappedDir);
        // setWorkingDirectory 内部会清空当前会话（含子代理标记），这里恢复为当前会话。
        // 数据探索会话均为根会话（无 parentID），因此 parentID 恢复为 null。
        setCurrentSessionId(sessionId);
        setCurrentSessionParentID(null);
      }
    }

    if (!sessionId) {
      // 通过对话创建会话：与「新建会话按钮」保持一致——
      // 若先前未新建会话目录（未点击新建按钮），则为本次对话创建一个独立目录并打开其标签页。
      if (isDataExplore && dataExploreService) {
        // 关键：新建会话前必须保证 opencode 工作目录已实际落到会话时间戳目录
        // （individual/{ts}），而不能停留在 individual/ 基础目录，否则 session.create
        // 会把新会话建在基础目录下（session.directory = .../individual）。
        // pendingDeDirRef 可能由「新建会话/首次兜底」提前设置，但其目录切换可能仍在
        // 进行中，因此不把它当作"目录已就绪"信号，而是显式确保 currentDirectory 已指向目标目录。
        try {
          let targetDir = pendingDeDirRef.current ?? null;
          if (!targetDir) {
            const created = await dataExploreService.createDir();
            if (created) {
              targetDir = created.dir;
              pendingDeDirRef.current = created.dir;
              setDataExploreDirs(prev => {
                const rest = (prev || []).filter(d => d.dir !== created.dir);
                return [created, ...rest];
              });
              bumpDeVersion();
            }
          }
          if (targetDir && targetDir !== currentDirectory) {
            await setWorkingDirectory(targetDir);
          }
        } catch (err) {
          console.error('[agent-client] 通过对话新建数据探索目录失败:', err);
        }
      }
      try {
        const result = await clientRef.current!.session.create({
          title: trimmed.slice(0, 80),
        });
        if (result.data) {
          sessionId = result.data.id;
          setCurrentSessionId(sessionId);
          // 新增的会话写入本地历史（{backend_host}/{user}/{model_id}/{project_id}）
          setTasks(upsertSessionHistory(sessionHistoryKey, {
            sessionId,
            title: trimmed.slice(0, 80),
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }));
          // 数据探索：将新形成的会话与当前新建的会话目录关联（用于删除会话时清理目录）
          if (isDataExplore && sessionId && pendingDeDirRef.current) {
            deDirMapRef.current[sessionId] = pendingDeDirRef.current;
            pendingDeDirRef.current = null;
            saveDeDirMap(deDirMapKeyRef.current, deDirMapRef.current);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[agent-client] session create failed:', err);
        addLog({ source: 'agent', text: `创建会话失败：${msg}`, timestamp: new Date(), level: 'error' });
        return;
      }
    }

    // 本地回显用户消息。注意必须在会话/工作目录建立完成之后再添加：
    // 数据探索首次通过对话创建会话时，会调用 setWorkingDirectory 重建客户端连接，
    // 其内部执行 resetState() 会清空 messages —— 若在此之前添加临时消息即会被清掉，
    // 导致用户输入不回显在对话列表（开发助手固定目录不受影响）。
    const userMsgId = `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    addMessage({
      info: {
        id: userMsgId,
        sessionID: sessionId || '',
        role: 'user',
        time: { created: Date.now() },
        agent: '',
        model: { providerID: '', modelID: '' },
      } as any,
      parts: [{ type: 'text', text: line, id: `part-${userMsgId}`, sessionID: sessionId || '', messageID: userMsgId } as any],
    });

    // 注意：sendChatMessage 失败时会 rethrow（见 useOpencodeChat.sendMessage）。
    // 原先这里直接丢弃返回的 Promise，失败既无人捕获也不会进应用内日志，
    // 界面表现为「发送后毫无反应」，是最难排查的一类故障。这里补上 catch 并落日志。
    const modelSnapshot = activeLLMModelRef.current ?? undefined;
    addLog({
      source: 'agent',
      text: `发送消息：session=${sessionId ?? '(将新建)'} 目录=${currentDirectory ?? '(未设置)'} 模型=${modelSnapshot ? modelSnapshot.providerID + '/' + modelSnapshot.modelID : '(默认)'} 长度=${line.length}`,
      timestamp: new Date(),
      level: 'info',
    });

    sendChatMessage(clientRef.current, line, sessionId, modelSnapshot)
      .then((res) => {
        addLog({
          source: 'agent',
          text: `消息已提交（session=${sessionId ?? '新建'}，服务端返回=${res ?? 'ok'}）。若长时间无回复，请看是否有「未收到本目录事件」告警。`,
          timestamp: new Date(),
          level: 'info',
        });
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[agent-client] 发送消息失败:', err);
        addLog({
          source: 'agent',
          text: `发送消息失败：${msg}`,
          timestamp: new Date(),
          level: 'error',
        });
      });

    // 消息发送后异步刷新任务列表（新 session 创建后列表需要更新）
    refreshTasks();
  }, [sendChatMessage, addMessage, addLog, currentSessionId, setCurrentSessionId, connected, currentDirectory, refreshTasks, isDataExplore, dataExploreService, setWorkingDirectory, setDataExploreDirs, bumpDeVersion, sessionHistoryKey]);

  const sendInterrupt = useCallback(async () => {
    await sendChatInterrupt(clientRef.current);
    // 本地兜底清除 busy：abort 调用后如果 SSE 流已断开，
    // 收不到 session.status:idle 事件，UI 会永久卡在"执行中"。
    // 立即本地清除 busy，确保用户可以继续操作。
    // 如果 SSE 仍活跃，后续的 idle 事件也会清除（幂等）。
    clearBusy();
  }, [sendChatInterrupt, clearBusy]);

  const sendRollback = useCallback(async (messageId: string) => {
    const result = await sendChatRollback(clientRef.current, messageId);
    if (result.success) {
      removeMessagesAfter(messageId);
    } else {
      addLog({
        source: 'stderr',
        text: '回滚失败：请检查网络连接或会话状态',
        timestamp: new Date(),
        level: 'error',
      });
    }
    return result;
  }, [sendChatRollback, removeMessagesAfter, addLog]);

  const sendPermissionResponse = useCallback((requestId: string, response: 'once' | 'always' | 'reject') => {
    sendChatPermissionResponse(clientRef.current, requestId, response);
  }, [sendChatPermissionResponse]);

  const sendQuestionReply = useCallback((requestId: string, answers: string[][]) => {
    sendChatQuestionReply(clientRef.current, requestId, answers);
  }, [sendChatQuestionReply]);

  const sendQuestionReject = useCallback((requestId: string) => {
    sendChatQuestionReject(clientRef.current, requestId);
  }, [sendChatQuestionReject]);

  const handleCompressSession = useCallback(async (): Promise<{ success: boolean }> => {
    if (!clientRef.current || !currentSessionId) {
      addLog({
        source: 'agent',
        text: '无法压缩：未连接 Agent 服务或未选择会话',
        timestamp: new Date(),
        level: 'warn',
      });
      return { success: false };
    }
    if (compressing) {
      return { success: false };
    }
    setCompressing(true);
    try {
      const activeModel = activeLLMModelRef.current;
      const result = await sendChatSummarize(clientRef.current, {
        providerID: activeModel?.providerID ?? config.modelProvider,
        modelID: activeModel?.modelID ?? config.model,
      });
      return result;
    } catch (err) {
      addLog({
        source: 'agent',
        text: `压缩异常: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: new Date(),
        level: 'error',
      });
      return { success: false };
    } finally {
      setCompressing(false);
    }
  }, [sendChatSummarize, currentSessionId, compressing, addMessage, addLog, config.modelProvider, config.model]);

  const handleNewSession = useCallback(async () => {
    resetState();
    clearCurrentSession();

    // 数据探索：新建会话 = 新建独立时间戳工作目录并切过去（会话=标签页）
    if (isDataExplore && dataExploreService) {
      try {
        const created = await dataExploreService.createDir();
        if (!created) return;
        pendingDeDirRef.current = created.dir;
        await setWorkingDirectory(created.dir);
        setDataExploreDirs(prev => {
          const rest = (prev || []).filter(d => d.dir !== created.dir);
          return [created, ...rest];
        });
        bumpDeVersion();
      } catch (err) {
        console.error('[agent-client] 新建数据探索会话失败:', err);
      }
    }
  }, [resetState, clearCurrentSession, isDataExplore, dataExploreService, setWorkingDirectory]);

  /**
   * 首次进入数据探索：不自动打开任何会话文件、不自动创建会话目录、
   * 不自动切换 AI 工作目录，仅显示空白编辑器（可输入 SQL）。
   * 会话的打开/新建及工作目录/会话关联由用户在任务下拉选择或新建会话时兜底处理。
   */
  const ensureFirstDataExploreDir = useCallback(async () => {
    if (!isDataExplore || !dataExploreService || scannedDeDirsRef.current) return;
    scannedDeDirsRef.current = true;
  }, [isDataExplore, dataExploreService]);

  // data-explore 连接就绪后执行首次 scan（含兜底创建）
  useEffect(() => {
    if (isDataExplore && connected && !scannedDeDirsRef.current) {
      ensureFirstDataExploreDir();
    }
  }, [isDataExplore, connected, ensureFirstDataExploreDir]);

  /** 删除数据探索会话：撤映射 → 删目录 → 删 opencode 会话 */
  const handleDataExploreDeleteSession = useCallback(async (dir: string) => {
    if (!isDataExplore) return;
    let sid: string | null = null;
    for (const [k, v] of Object.entries(deDirMapRef.current)) {
      if (v === dir) { sid = k; break; }
    }
    if (sid) {
      delete deDirMapRef.current[sid];
      saveDeDirMap(deDirMapKeyRef.current, deDirMapRef.current);
    }
    if (sid && sid === currentSessionId) clearCurrentSession();
    if (dataExploreService) {
      try {
        await dataExploreService.removeDir(dir);
      } catch (err) {
        console.warn('[agent-client] 删除数据探索会话目录失败:', err);
      }
    }
    setDataExploreDirs(prev => (prev || []).filter(d => d.dir !== dir));
    bumpDeVersion();
    if (sid && clientRef.current) {
      try {
        await deleteSession(clientRef.current, sid);
        setTasks(removeSessionHistoryEntry(sessionHistoryKey, sid));
      } catch (err) {
        console.warn('[agent-client] 删除数据探索会话失败:', err);
      }
    }
  }, [isDataExplore, dataExploreService, currentSessionId, clearCurrentSession, deleteSession, sessionHistoryKey]);

  /** 数据探索：打开/关闭指定目录的文件标签（仅操作编辑器标签，不动 AI 工作目录） */
  const setDeDirOpen = useCallback((dir: string, open: boolean) => {
    if (!dir) return;
    setDataExploreDirs(prev => {
      const list = prev || [];
      const exists = list.some(d => d.dir === dir);
      if (open && !exists) {
        const filePath = list.find(d => d.dir === dir)?.filePath || joinPath(dir, `user_${username || 'user'}.sql`);
        return [{ dir, filePath }, ...list];
      }
      if (!open && exists) {
        return list.filter(d => d.dir !== dir);
      }
      return prev;
    });
    bumpDeVersion();
  }, [username]);

  /** 数据探索：任务下拉勾选 → 打开/关闭该会话文件标签（与 AI 对话无关） */
  const handleDataExploreToggleSession = useCallback((sessionId: string) => {
    if (!isDataExplore) return;
    const dir = deDirMapRef.current[sessionId];
    if (!dir) return;
    const currentlyOpen = (dataExploreDirs || []).some(d => d.dir === dir);
    setDeDirOpen(dir, !currentlyOpen);
  }, [isDataExplore, dataExploreDirs, setDeDirOpen]);

  /** 数据探索：编辑器关标签 → 关闭该目录文件（不删会话/目录） */
  const handleDataExploreCloseFile = useCallback((dir: string) => {
    if (!isDataExplore) return;
    setDeDirOpen(dir, false);
  }, [isDataExplore, setDeDirOpen]);

  /** 数据探索：任务（用户对话）→ 工作目录 SQL 文件（供下拉勾选展示，仅已关联会话） */
  const dataExploreTaskFiles = useMemo(() => {
    if (!isDataExplore) return [];
    const list: Array<{ sessionId: string; dir: string; filePath: string; title: string }> = [];
    for (const t of tasks) {
      const dir = deDirMapRef.current[t.sessionId];
      if (!dir) continue;
      list.push({ sessionId: t.sessionId, dir, filePath: joinPath(dir, `user_${username || 'user'}.sql`), title: t.title || '新对话' });
    }
    return list;
  }, [isDataExplore, tasks, username, dataExploreDirsVersion]);

  const handleLoadSession = useCallback(async (sessionId: string) => {
    if (!clientRef.current) {
      setError('AI 服务未连接，请稍候再试');
      return;
    }
    resetState();
    setError(null);
    const entries = await loadSession(clientRef.current, sessionId);
    setMessagesDirect(entries);

    let todosFromApi: Todo[] = [];
    try {
      const todoResult = await clientRef.current.session.todo({
        sessionID: sessionId,
      });
      if (todoResult?.data && todoResult.data.length > 0) {
        todosFromApi = todoResult.data;
        setTodos(todosFromApi);
      }
    } catch (err) {
      console.warn('[agent-client] Failed to load session todos:', err);
    }

    if (todosFromApi.length === 0 && entries.length > 0) {
      const extractedTodos = extractTodosFromMessages(entries);
      if (extractedTodos.length > 0) {
        setTodos(extractedTodos);
      }
    }
  }, [loadSession, resetState, setMessagesDirect, setTodos, setError]);

  const handleListSessions = useCallback(async () => {
    return listSessions(clientRef.current);
  }, [listSessions]);

  const handleDeleteSession = useCallback(async (sessionId: string) => {
    // 数据探索：删除会话时一并删除其独立工作目录
    if (isDataExplore) {
      const dir = deDirMapRef.current[sessionId];
      if (dir) {
        delete deDirMapRef.current[sessionId];
        saveDeDirMap(deDirMapKeyRef.current, deDirMapRef.current);
        if (dataExploreService) {
          try {
            await dataExploreService.removeDir(dir);
          } catch (err) {
            console.warn('[agent-client] 删除数据探索会话目录失败:', err);
          }
        }
        setDataExploreDirs(prev => (prev || []).filter(d => d.dir !== dir));
        bumpDeVersion();
      }
      if (sessionId === currentSessionId) clearCurrentSession();
    }
    await deleteSession(clientRef.current, sessionId);
    // 删除后从本地历史移除（乐观更新，同时持久化）
    setTasks(removeSessionHistoryEntry(sessionHistoryKey, sessionId));
  }, [deleteSession, isDataExplore, dataExploreService, currentSessionId, clearCurrentSession, sessionHistoryKey]);

  /** 重命名任务（通过 SDK session.update 更新标题） */
  const renameTask = useCallback(async (sessionId: string, newTitle: string) => {
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    // 乐观更新（同时持久化到本地历史）
    setTasks(prev => {
      const next = prev.map(t =>
        t.sessionId === sessionId ? { ...t, title: trimmed, updatedAt: Date.now() } : t
      );
      saveSessionHistory(sessionHistoryKey, next);
      return next;
    });
    // 通过 SDK 更新服务端标题
    const c = clientRef.current;
    if (c) {
      try {
        await c.session.update({ sessionID: sessionId, title: trimmed });
      } catch (err) {
        addLog({ source: 'agent', text: `重命名失败: ${err instanceof Error ? err.message : String(err)}`, timestamp: new Date(), level: 'warn' });
        refreshTasks(); // 回滚乐观更新
      }
    }
  }, [addLog, refreshTasks, sessionHistoryKey]);

  return useMemo(() => ({
    messages,
    busy,
    busyLabel,
    retry,
    ready,
    connected,
    error,
    modals,
    logs,
    currentSessionId,
    currentSessionIsSubagent: currentSessionParentID !== null,
    lastFileChangeSeq,
    lastFileChangePaths,
    todos,
    fileChanges,
    approveFileChange,
    rejectFileChange,
    approveAllFileChanges,
    contextUsage,
    tasks,

    sendMessage,
    sendInterrupt,
    sendRollback,
    sendPermissionResponse,
    sendQuestionReply,
    sendQuestionReject,
    compressSession: handleCompressSession,
    compressing,
    clearLogs,

    newSession: handleNewSession,
    loadSession: handleLoadSession,
    listSessions: handleListSessions,
    deleteSession: handleDeleteSession,
    renameTask,

    start,
    connect,
    disconnect,

    setWorkingDirectory,
    currentDirectory,

    dataExploreDirs,
    dataExploreDirsVersion,
    dataExploreDeleteSession: handleDataExploreDeleteSession,
    dataExploreTaskFiles,
    dataExploreToggleSession: handleDataExploreToggleSession,
    dataExploreCloseFile: handleDataExploreCloseFile,
    starting,
    setActiveLLMModel,
    activeLLMModel,
    taskType,
    setTaskType,
    client,
    readPartText,
    subscribePartText,
  }), [
    messages, busy, busyLabel, retry, ready, connected, error, modals, logs,
    currentSessionId, currentSessionParentID, lastFileChangeSeq, lastFileChangePaths, todos, fileChanges, contextUsage, tasks,
    sendMessage, sendInterrupt, sendRollback, sendPermissionResponse, sendQuestionReply, sendQuestionReject,
    handleCompressSession, compressing, clearLogs,
    handleNewSession, handleLoadSession, handleListSessions, handleDeleteSession, renameTask,
    approveFileChange, rejectFileChange, approveAllFileChanges,
    start, connect, disconnect,
    setWorkingDirectory, currentDirectory,
    dataExploreDirs, dataExploreDirsVersion, handleDataExploreDeleteSession,
    dataExploreTaskFiles, handleDataExploreToggleSession, handleDataExploreCloseFile,
    starting,
    setActiveLLMModel, activeLLMModel,
    taskType,
    client, readPartText,
    subscribePartText,
  ]);
}

/**
 * 从消息列表中提取 todos（回退机制）
 */
function extractTodosFromMessages(entries: MessageEntry[]): Todo[] {
  let latestTodos: Todo[] = [];

  for (const entry of entries) {
    if (entry.info.role !== 'assistant') continue;
    for (const part of entry.parts) {
      if (part.type !== 'tool') continue;
      const toolPart = part as any;
      if (toolPart.tool !== 'todowrite') continue;

      const metaTodos = toolPart.state?.metadata?.todos;
      if (Array.isArray(metaTodos) && metaTodos.length > 0) {
        latestTodos = metaTodos;
        continue;
      }

      const inputTodos = toolPart.state?.input?.todos;
      if (Array.isArray(inputTodos) && inputTodos.length > 0) {
        latestTodos = inputTodos;
      }
    }
  }

  return latestTodos;
}

export default useOpencodeClient;
