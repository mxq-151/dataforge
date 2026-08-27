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
import type { OpenCodeConfig, Todo, MessageEntry, LogEntry } from '../../types/opencode-backend';
import type { FileChange } from '../../components/ai/FileReviewPanel';
import type { OpencodeClient } from '@opencode-ai/sdk/v2/client';

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
}

/**
 * 硬编码的模型 context 窗口大小（已知模型的官方限制）。
 * 用于：
 * 1. API `model.list()` 失败时的 fallback
 * 2. API 返回值低估时的下限保护（取 API 值与硬编码值的较大值）
 *
 * 注意：API 返回的 limit 有时不准确（例如 deepseek-v4-flash 实际支持 1M，
 * 但 API 可能返回 128000），因此对已知模型以硬编码值为下限。
 */
function getHardcodedContextLimit(modelID: string): number {
  const model = modelID.toLowerCase();
  if (model.includes('gpt-4o') || model.includes('gpt-4-turbo')) {
    return 128_000;
  }
  if (model.includes('gpt-4')) {
    return 8_192;
  }
  if (model.includes('gpt-3.5')) {
    return 16_385;
  }
  if (model.includes('claude-3') || model.includes('claude-4')) {
    return 200_000;
  }
  // deepseek-v4 系列（含 deepseek-v4-flash）支持 1M context
  if (model.includes('deepseek-v4')) {
    return 1_048_576;
  }
  if (model.includes('deepseek-v3') || model.includes('deepseek-r1') || model.includes('deepseek-v2') || model.includes('deepseek')) {
    return 128_000;
  }
  if (model.includes('qwen')) {
    return 32_000;
  }
  if (model.includes('gemini-1.5-pro') || model.includes('gemini-2')) {
    return 1_000_000;
  }
  if (model.includes('gemini')) {
    return 32_000;
  }
  return 128_000;
}

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
}: OpencodeClientProviderProps) {
  const client = useOpencodeClientImpl(config, username, moduleId, roleType, projectId, directory);

  return (
    <OpencodeClientContext.Provider value={client}>
      {children}
    </OpencodeClientContext.Provider>
  );
}

// ── Registry: 管理多个项目的 Provider ──

export interface ClientInstance {
  moduleId: string;
  projectId: string;
}

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
  _projectId?: string,
  directory?: string | null,
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

  // ── 当前激活的 LLM 模型（运行时切换，覆盖服务端默认配置） ──
  const [activeLLMModel, setActiveLLMModelState] = useState<{ providerID: string; modelID: string } | null>(null);
  // ── 任务类型（覆盖 roleType，决定系统指令） ──
  // 数据探索模块默认数据分析，其他模块默认数仓设计
  const [taskType, setTaskType] = useState<string>(moduleId === 'data-explore' ? 'DATA_ANALYST' : 'DATA_ARCHITECT');
  const activeLLMModelRef = useRef<{ providerID: string; modelID: string } | null>(null);

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
    loadSession,
    listSessions,
    deleteSession,
  } = useOpencodeSessions();

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

  const rejectFileChange = useCallback((filePath: string, change: { type: 'edit' | 'write' | 'apply_patch'; messageID?: string; partID?: string }) => {
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
  }, [fileChangesApproved, fileChangesRejected, messages, extractFileChangesFromMessages, currentSessionId]);

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

  // ── 任务历史（从 SDK session.list() 获取，替代本地存储） ──
  const [tasks, setTasks] = useState<TaskRecord[]>([]);

  /** 从 SDK Session[] 映射为 TaskRecord[] */
  const mapSessionsToTasks = useCallback((sessions: any[]): TaskRecord[] => {
    return sessions.map(s => ({
      sessionId: s.id,
      title: s.title || '新对话',
      createdAt: s.time?.created ?? 0,
      updatedAt: s.time?.updated ?? 0,
    })).sort((a, b) => b.updatedAt - a.updatedAt); // 按更新时间降序
  }, []);

  /** 从 SDK 刷新任务列表 */
  const refreshTasks = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    try {
      const sessions = await listSessions(c);
      setTasks(mapSessionsToTasks(sessions));
    } catch (err) {
      addLog({ source: 'opencode', text: `刷新任务列表失败: ${err instanceof Error ? err.message : String(err)}`, timestamp: new Date(), level: 'warn' });
    }
  }, [listSessions, mapSessionsToTasks, addLog]);

  // 连接成功后自动加载任务列表
  useEffect(() => {
    if (ready && clientRef.current) {
      refreshTasks();
    }
  }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 设置模型 context 限制 ──
  // 优先从 SDK client.model.list() 获取当前模型的真实 limit.context，
  // 替代硬编码推断（硬编码无法覆盖自定义模型和新模型）。
  // 对已知模型以硬编码值为下限保护：API 返回的 limit 有时不准确
  // （如 deepseek-v4-flash 实际支持 1M，但 API 可能返回 128000），
  // 取 API 值与硬编码值的较大值，避免低估 context 窗口导致进度条误报满载。
  const fetchModelContextLimit = useCallback(async (c: OpencodeClient, modelID: string, providerID: string) => {
    const hardcodedLimit = getHardcodedContextLimit(modelID);
    try {
      const result = await c.v2.model.list();
      const models = (result.data as any)?.data ?? result.data;
      if (Array.isArray(models)) {
        const matched = models.find((m: any) =>
          m.id === modelID && m.providerID === providerID
        );
        if (matched?.limit?.context) {
          const finalLimit = Math.max(matched.limit.context, hardcodedLimit);
          setContextLimit(finalLimit);
          addLog({
            source: 'opencode',
            text: `模型 ${providerID}/${modelID} contextLimit=${finalLimit}（API=${matched.limit.context}, 硬编码=${hardcodedLimit}）`,
            timestamp: new Date(),
            level: 'info',
          });
          return;
        }
        // fallback: 只按 modelID 匹配
        const fallback = models.find((m: any) => m.id === modelID);
        if (fallback?.limit?.context) {
          const finalLimit = Math.max(fallback.limit.context, hardcodedLimit);
          setContextLimit(finalLimit);
          addLog({
            source: 'opencode',
            text: `模型 ${modelID} contextLimit=${finalLimit}（API=${fallback.limit.context}, 硬编码=${hardcodedLimit}, provider 未匹配）`,
            timestamp: new Date(),
            level: 'info',
          });
          return;
        }
      }
      addLog({
        source: 'opencode',
        text: `未从 API 找到模型 ${providerID}/${modelID} 的 limit，使用硬编码 fallback (${hardcodedLimit})`,
        timestamp: new Date(),
        level: 'warn',
      });
    } catch (err) {
      addLog({
        source: 'opencode',
        text: `model.list() 失败: ${err instanceof Error ? err.message : String(err)}，使用硬编码 fallback (${hardcodedLimit})`,
        timestamp: new Date(),
        level: 'warn',
      });
    }
    setContextLimit(hardcodedLimit);
  }, [setContextLimit, addLog]);

  // 当客户端连接或模型切换时，获取真实的 contextLimit
  useEffect(() => {
    const c = clientRef.current;
    if (!c || !ready) return;
    const modelID = activeLLMModel?.modelID ?? config.model;
    const providerID = activeLLMModel?.providerID ?? config.modelProvider;
    if (!modelID) return;
    fetchModelContextLimit(c, modelID, providerID);
  }, [ready, config.model, config.modelProvider, activeLLMModel, fetchModelContextLimit]);

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

  // 用 ref 跟踪当前工作目录，供 subscribe 使用
  const directoryRef = useRef<string | null>(currentDirectory);
  useEffect(() => {
    directoryRef.current = currentDirectory;
  }, [currentDirectory]);

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
              source: 'opencode',
              text: `工作目录不存在，已自动创建: ${dir}`,
              timestamp: new Date(),
              level: 'info',
            });
          }
        } catch (e) {
          addLog({
            source: 'opencode',
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

      addLog({
        source: 'opencode',
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

  // 连接成功后自动订阅事件
  useEffect(() => {
    if (connected && clientRef.current) {
      unsubscribeRef.current?.();
      unsubscribeRef.current = subscribe(clientRef.current, directoryRef.current);
    }
    return () => {
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, subscribe]);

  // ── 监听 sidecar 进程崩溃事件 ──
  // 后端在 sidecar 运行中退出（崩溃/被杀）时通过主进程事件通知前端。
  // 若不监听，前端只会看到 SSE 流反复断开重连，但永远无法成功（进程已不在），
  // 用户会困惑于"思考过程意外中断"却不知道根本原因是 sidecar 崩溃。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<string>('opencode-process-terminated', (event) => {
      if (cancelled) return;
      const detail = event.payload || 'OpenCode 进程已退出';
      addLog({
        source: 'stderr',
        text: `OpenCode 服务进程已退出：${detail}`,
        timestamp: new Date(),
        level: 'error',
      });
      // 标记连接断开：SSE 流会自动尝试重连，但 sidecar 已不在，重连会持续失败。
      // 设置 error 状态让 UI 显示明确错误，而非无限"正在重连"。
      setError(`OpenCode 服务已停止：${detail}`);
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
      setCurrentSessionId(null);
      connectWithDirectory(directory ?? null);
    }
  }, [directory, connected, currentDirectory, connectWithDirectory, resetState, setCurrentSessionId]);

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

    // 幂等锁：必须在任何 await 之前设置，否则 StrictMode 双挂载的第二次 effect
    // 会在第一次 await 期间通过检查并发调用 start()。
    // 用 ref 而非 state：ref 赋值同步立即生效，state 异步批处理来不及更新。
    if (startingRef.current) {
      return;
    }
    startingRef.current = true;
    setStarting(true);

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
      setCurrentSessionId(null);

      // 创建新客户端
      await connectWithDirectory(dir);
    } catch (err) {
      // 兜底捕获：connectWithDirectory 已有自己的 try/catch，但任何漏出的异常
      // 不能让它成为 Unhandled Promise Rejection（effect 中 startRef.current() 没 catch）
      const msg = `start 失败: ${err instanceof Error ? err.message : String(err)}`;
      setError(msg);
      addLog({ source: 'stderr', text: msg, timestamp: new Date(), level: 'error' });
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }, [backend, directory, connected, currentDirectory, doDisconnect, resetState, setCurrentSessionId, connectWithDirectory]);

  /**
   * 切换 OpenCode 工作目录（重建客户端连接）。
   */
  const setWorkingDirectory = useCallback(async (cwd: string | undefined | null) => {
    const newCwd = (cwd || '').trim();
    if (!newCwd) {
      addLog({
        source: 'opencode',
        text: '切换工作目录失败: 路径为空（保持当前目录）',
        timestamp: new Date(),
        level: 'warn',
      });
      return;
    }

    if (newCwd === currentDirectory) {
      return;
    }

    // 断开旧连接，重建客户端
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    resetState();
    setCurrentSessionId(null);
    doDisconnect();

    // 确保服务可用
    if (!backend.serverReady) {
      await backend.start();
    }

    await connectWithDirectory(newCwd);
  }, [currentDirectory, addLog, resetState, setCurrentSessionId, doDisconnect, backend, connectWithDirectory]);

  // 包装 chat 方法，自动传入 client
  const sendMessage = useCallback(async (line: string) => {
    if (!clientRef.current) {
      addLog({
        source: 'stderr',
        text: '未连接 OpenCode 服务，无法发送消息',
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

    const userMsgId = `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    addMessage({
      info: {
        id: userMsgId,
        sessionID: currentSessionId || '',
        role: 'user',
        time: { created: Date.now() },
        agent: '',
        model: { providerID: '', modelID: '' },
      } as any,
      parts: [{ type: 'text', text: line, id: `part-${userMsgId}`, sessionID: currentSessionId || '', messageID: userMsgId } as any],
    });

    let sessionId: string | null = currentSessionId;
    if (!sessionId) {
      try {
        const result = await clientRef.current!.session.create({
          title: trimmed.slice(0, 80),
        });
        if (result.data) {
          sessionId = result.data.id;
          setCurrentSessionId(sessionId);
        }
      } catch (err) {
        console.error('[opencode-client] session create failed:', err);
        return;
      }
    }

    sendChatMessage(clientRef.current, line, sessionId, activeLLMModelRef.current ?? undefined);

    // 消息发送后异步刷新任务列表（新 session 创建后列表需要更新）
    refreshTasks();
  }, [sendChatMessage, addMessage, addLog, currentSessionId, setCurrentSessionId, connected, currentDirectory, refreshTasks]);

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
        source: 'opencode',
        text: '无法压缩：未连接 OpenCode 服务或未选择会话',
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
        source: 'opencode',
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
    setCurrentSessionId(null);
  }, [resetState, setCurrentSessionId]);

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
      console.warn('[useOpencodeClient] Failed to load session todos:', err);
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
    await deleteSession(clientRef.current, sessionId);
    // 删除后从列表中移除（乐观更新），同时异步刷新确保同步
    setTasks(prev => prev.filter(t => t.sessionId !== sessionId));
    refreshTasks();
  }, [deleteSession, refreshTasks]);

  /** 重命名任务（通过 SDK session.update 更新标题） */
  const renameTask = useCallback(async (sessionId: string, newTitle: string) => {
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    // 乐观更新
    setTasks(prev => prev.map(t =>
      t.sessionId === sessionId ? { ...t, title: trimmed, updatedAt: Date.now() } : t
    ));
    // 通过 SDK 更新服务端标题
    const c = clientRef.current;
    if (c) {
      try {
        await c.session.update({ sessionID: sessionId, title: trimmed });
      } catch (err) {
        addLog({ source: 'opencode', text: `重命名失败: ${err instanceof Error ? err.message : String(err)}`, timestamp: new Date(), level: 'warn' });
        refreshTasks(); // 回滚乐观更新
      }
    }
  }, [addLog, refreshTasks]);

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
    starting,
    setActiveLLMModel,
    activeLLMModel,
    taskType,
    setTaskType,
    client,
    readPartText,
  }), [
    messages, busy, busyLabel, retry, ready, connected, error, modals, logs,
    currentSessionId, lastFileChangeSeq, lastFileChangePaths, todos, fileChanges, contextUsage, tasks,
    sendMessage, sendInterrupt, sendRollback, sendPermissionResponse, sendQuestionReply, sendQuestionReject,
    handleCompressSession, compressing, clearLogs,
    handleNewSession, handleLoadSession, handleListSessions, handleDeleteSession, renameTask,
    approveFileChange, rejectFileChange, approveAllFileChanges,
    start, connect, disconnect,
    setWorkingDirectory, currentDirectory, starting,
    setActiveLLMModel, activeLLMModel,
    taskType,
    client, readPartText,
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
