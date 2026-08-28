/**
 * useOpencodeEvents — SSE 事件订阅与状态路由
 */

import { useState, useCallback, useRef, useEffect, type MutableRefObject } from 'react';
import type { OpencodeClient, MessageEntry, Part, Todo, ModalRequest, LogEntry, RetryState } from '../../types/opencode-backend';
import { normalizePath, trimTrailingSlash } from '../../utils/pathUtils';
import { useSseConnection, RECOVERY_FALLBACK_MS } from './useSseConnection';

/** 过滤掉不需要处理的噪音事件
 *
 * 注意：server.heartbeat 不在此列表中。心跳事件用于刷新「最后活动时间」，
 * 作为连接健康检测的依据（见 useSseConnection 中的心跳看护）。
 *
 * SDK 1.18.x 变化：原 session.next / session.agent / session.model.switched
 * 已拆分为 session.next.agent.switched / session.next.model.switched /
 * session.next.synthetic 等。
 */
const IGNORED_EVENTS = new Set([
  'plugin.added',
  'catalog.updated',
  'integration.updated',
  'reference.updated',
  // session.next.* 系列：V2 durable event 模型事件，当前使用 V1 兼容 API
  // （message.part.delta / message.part.updated），这些事件属于冗余噪音
  'session.next.agent.switched',
  'session.next.model.switched',
  'session.next.synthetic',
  'session.diff',
  'server.instance.disposed',
  'global.disposed',
  'installation.updated',
  'installation.update.available',
  'project.directories.updated',
  'project.updated',
  'pty.created',
  'pty.updated',
  'pty.exited',
  'pty.deleted',
  'mcp.tools.changed',
  'mcp.browser.open.failed',
  'lsp.updated',
  'vcs.branch.updated',
  'workspace.ready',
  'workspace.failed',
  'workspace.status',
  'worktree.ready',
  'worktree.failed',
]);

// 全局 unhandledrejection 监听器：过滤 Monaco loader 的 makeCancelable 取消信号
// （StrictMode 双挂载时 Monaco loader 调 .cancel()，会 reject {type:"cancelation"} 非真实错误）
if (typeof window !== 'undefined' && !(window as any).__unhandledRejectionHooked) {
  (window as any).__unhandledRejectionHooked = true;
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    if (reason && typeof reason === 'object'
        && (reason as any).type === 'cancelation'
        && (reason as any).msg === 'operation is manually canceled') {
      event.preventDefault?.();
    }
  });
}

export interface ContextUsage {
  /**
   * 当前实际上下文大小 = 原始 input + cache.read + cache.write。
   * 启用 prompt caching 后，SDK 的 tokens.input 只含未命中缓存的输入 token，
   * cache.read 是从缓存读取的输入 token —— 它们同样是 prompt 的一部分，
   * 占用 context 窗口，必须计入"当前上下文大小"才能正确反映使用率。
   */
  input: number;
  /** 最近一次 step 的输出 token */
  output: number;
  /** 最近一次 step 的推理 token */
  reasoning: number;
  /** 最近一次 step 的缓存读/写（原始值，已计入 input，此处仅供明细展示） */
  cache: { read: number; write: number };
  /** 累计总 token（所有 step-finish 之和，含缓存，反映整个会话累计开销） */
  total: number;
  /** 模型 context 限制（如 128000），用于计算使用率 */
  contextLimit: number;
  /** 使用率（0-1）= 当前实际上下文大小（含缓存） / contextLimit */
  ratio: number;
}

export interface UseOpencodeEventsReturn {
  messages: MessageEntry[];
  busy: boolean;
  busyLabel: string | undefined;
  /** retry 状态（session.status 事件 type==='retry' 时设置） */
  retry: RetryState | null;
  /** pending 权限/提问请求列表（支持并发权限+提问） */
  modals: ModalRequest[];
  todos: Todo[];
  lastFileChangeSeq: number;
  lastFileChangePaths: string[];
  /** 当前会话的 token 使用情况 */
  contextUsage: ContextUsage;
  /** 手动清除 busy 状态（用于 sendInterrupt 兜底） */
  clearBusy: () => void;
  subscribe: (client: OpencodeClient, directory: string | null) => () => void;
  resetState: () => void;
  /** 手动添加一条消息（用于立即显示用户发送的消息） */
  addMessage: (entry: MessageEntry) => void;
  /**
   * 删除指定消息之后的所有消息（用于回滚后即时清理 UI）。
   * 保留指定消息及其之前的所有消息。
   */
  removeMessagesAfter: (messageId: string) => void;
  /**
   * 批量设置消息列表（用于加载历史会话时回显）。
   * 会先清空内部过滤状态（confirmedUserMessageIds 等），
   * 然后直接替换 messages。
   */
  setMessagesDirect: (entries: MessageEntry[]) => void;
  /** 手动设置 todos（用于加载历史会话时恢复） */
  setTodos: React.Dispatch<React.SetStateAction<Todo[]>>;
  /**
   * 设置模型 context 限制（在加载 session 或启动时设置）。
   * 用于计算 contextUsage.ratio。
   */
  setContextLimit: (limit: number) => void;
  /** 流式 delta 累积缓冲（Map<partID, string>），供 TextPartDisplay 读取流式文本 */
  partTextAccumDelta: MutableRefObject<Map<string, string>>;
  /**
   * 读取 part 的流式文本（对齐桌面版 part_text_accum_delta）。
   * 流式过程中返回 delta 累积值，流式结束后返回 part.text 全量值。
   */
  readPartText: (partID: string, part: Part) => string;
}

export interface UseOpencodeEventsOptions {
  /**
   * "已发送的真实用户输入"文本集合（由 useOpencodeBackend 维护）。
   * 用于过滤 sub-agent 注入到主 session 的内部 user 消息：
   * 当 message.part.updated 累积的 user text 与集合不匹配时，
   * 该 user 消息会被视为"内部消息"并从列表中移除。
   */
  sentUserInputsRef?: MutableRefObject<Set<string>>;
}

export function useOpencodeEvents(
  addLog: (entry: LogEntry) => void,
  options: UseOpencodeEventsOptions = {}
): UseOpencodeEventsReturn {
  const { sentUserInputsRef } = options;
  const [messages, setMessages] = useState<MessageEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState<string | undefined>(undefined);
  const [retry, setRetry] = useState<RetryState | null>(null);

  // busyRef：subscribe 闭包中读取最新 busy 状态的桥梁。
  // subscribe 是 useCallback，闭包中的 busy 是创建时的快照，无法反映后续更新。
  // 通过 ref 同步，让 subscribe 在 SSE 流断开时能判断当前是否处于"思考中"。
  const busyRef = useRef(false);
  useEffect(() => { busyRef.current = busy; }, [busy]);
  const [modals, setModals] = useState<ModalRequest[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [lastFileChangeSeq, setLastFileChangeSeq] = useState(0);
  const [lastFileChangePaths, setLastFileChangePaths] = useState<string[]>([]);
  // ── 上下文使用量 ──
  // 从每个 step-finish part 累积 token：input/output/reasoning/cache.read/cache.write
  // total 用于显示累计消耗，ratio = total / contextLimit 用于显示使用率
  const [contextUsage, setContextUsage] = useState<ContextUsage>({
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
    total: 0,
    contextLimit: 0,
    ratio: 0,
  });

  const abortRef = useRef<AbortController | null>(null);

  // ── SSE 传输层（心跳健康检测、重连退避、恢复定时器）──
  // 这些是纯机械的定时器/标记位逻辑，与业务无关，已抽到 useSseConnection：
  // 记录最后一次收到事件的时间戳、超时置位、定时器的登记与批量清理。
  const sse = useSseConnection();

  // ── 内部 user 消息过滤 ──
  // OpenCode 的 sub-agent 工具会在主 session 推送 role:"user" 的消息，
  // 内容是子任务的 prompt（如 "Explore the project workspace..."），
  // 并非真实用户输入，需要从消息列表中过滤掉。
  //
  // 实现：
  // - userMessageTextMap: 累积 user message 的 text 内容（按 messageId 索引）
  // - internalCheckTimers: 延迟检查定时器（1 秒无新更新后判定）
  // - internalMessageIds: 已被标记为"内部消息"的 ID 集合（避免重复处理）
  // - confirmedUserMessageIds: 已被确认为真实用户消息的 ID 集合（锁定后不再重新检查）
  const userMessageTextMap = useRef<Map<string, string>>(new Map());
  const internalCheckTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const internalMessageIds = useRef<Set<string>>(new Set());
  const confirmedUserMessageIds = useRef<Set<string>>(new Set());
  const userMessageRoles = useRef<Map<string, 'user' | 'assistant'>>(new Map());

  // ── 流式 delta 累积缓冲 ──
  // v2 SDK 将流式文本拆分为 message.part.delta（增量）+ message.part.updated（全量）。
  // partTextAccumDelta 累积 delta 到 Map<partID, string>，供 TextPartDisplay 读取流式文本
  // （对齐桌面版 part_text_accum_delta）。同时同步更新 part.text 字段以保持向后兼容。
  const partTextAccumDelta = useRef<Map<string, string>>(new Map());

  /**
   * 读取 part 的流式文本（对齐桌面版 part_text_accum_delta 读取逻辑）。
   *
   * 优先返回 partTextAccumDelta 中累积的 delta 文本（流式过程中实时增长），
   * fallback 到 part.text（全量替换后的稳定文本）。
   *
   * TextPartDisplay 和 ReasoningPartDisplay 使用此函数获取渲染文本：
   * - 流式过程中（delta 事件持续到达）：返回 accumDelta 累积值（逐字增长）
   * - 流式结束后（part.updated 全量替换）：accumDelta 被清理，返回 part.text
   */
  const readPartText = useCallback((partID: string, part: Part): string => {
    const accum = partTextAccumDelta.current.get(partID);
    if (accum !== undefined) return accum;
    return (part as any).text || '';
  }, []);

  // ── delta 合并刷新（性能优化） ──
  // message.part.delta 事件频率可达 50-100+/秒，原先每个 delta 都调用 setMessages
  // 触发完整 React 渲染级联（AIPanel → MessageTimeline → 所有可见行）。
  //
  // 优化策略：
  // 1. accumDelta ref 始终立即更新（readPartText 读取它，保证文本不延迟）
  // 2. 新消息/新 part 首次到达时立即创建（保证 UI 即时显示）
  // 3. 已有消息的后续 delta 仅标记 dirty，通过 DELTA_FLUSH_MS 定时器合并刷新
  //    将 50-100 次/秒的 setMessages 降至 ~30 次/秒
  const knownMessageIdsRef = useRef<Set<string>>(new Set());
  const knownPartIdsRef = useRef<Set<string>>(new Set());
  const dirtyDeltaMessagesRef = useRef<Set<string>>(new Set());
  const deltaFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const DELTA_FLUSH_MS = 33; // ~30fps，合并窗口内所有 delta

  /** 合并刷新：将 accumDelta 中的最新文本同步到 messages state（仅 dirty 消息） */
  const flushDeltas = useCallback(() => {
    deltaFlushTimerRef.current = null;
    const dirty = dirtyDeltaMessagesRef.current;
    if (dirty.size === 0) return;
    dirtyDeltaMessagesRef.current = new Set();
    setMessages(prev => {
      let changed = false;
      const next = prev.map(m => {
        if (!dirty.has(m.info.id)) return m;
        let msgChanged = false;
        const newParts = m.parts.map(p => {
          const accum = partTextAccumDelta.current.get(p.id);
          if (accum === undefined) return p;
          const currentText = (p as any).text || '';
          if (currentText === accum) return p;
          msgChanged = true;
          return { ...p, text: accum };
        });
        if (!msgChanged) return m;
        changed = true;
        return { ...m, parts: newParts };
      });
      return changed ? next : prev;
    });
  }, []);

  /** 调度合并刷新（若已有定时器在排队则跳过） */
  const scheduleDeltaFlush = useCallback(() => {
    if (deltaFlushTimerRef.current !== null) return;
    deltaFlushTimerRef.current = setTimeout(flushDeltas, DELTA_FLUSH_MS);
  }, [flushDeltas]);

  // ── 压缩步骤的 step-finish 跳过标志 ──
  // session.summarize 服务端会运行一次"压缩" LLM 调用，其 step-finish.tokens.input
  // 是被压缩的"完整旧历史"大小，不是压缩后的新大小。如果直接采用，会让进度条短暂回到
  // 压缩前的数值，体验差。因此在收到 session.compacted 时设置本标志，
  // 下一个 step-finish 仍计入 total（保留累计开销），但**不更新** current step 指标。
  // 之后再下个 step-finish（即用户发送新消息后的 LLM 响应）即为压缩后的真实大小。
  const skipNextStepFinish = useRef(false);

  const resetState = useCallback(() => {
    setMessages([]);
    setBusy(false);
    setBusyLabel(undefined);
    setRetry(null);
    setModals([]);
    setTodos([]);
    setLastFileChangeSeq(0);
    setLastFileChangePaths([]);
    // 重置 context 使用量（保留 contextLimit，因为模型限制通常不变）
    setContextUsage(prev => ({
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
      total: 0,
      contextLimit: prev.contextLimit,
      ratio: 0,
    }));
    // 清理内部消息过滤状态
    userMessageTextMap.current.clear();
    internalCheckTimers.current.forEach(t => clearTimeout(t));
    internalCheckTimers.current.clear();
    internalMessageIds.current.clear();
    confirmedUserMessageIds.current.clear();
    userMessageRoles.current.clear();
    // 清理流式 delta 累积缓冲
    partTextAccumDelta.current.clear();
    // 清理 delta 合并刷新状态
    if (deltaFlushTimerRef.current !== null) {
      clearTimeout(deltaFlushTimerRef.current);
      deltaFlushTimerRef.current = null;
    }
    dirtyDeltaMessagesRef.current.clear();
    knownMessageIdsRef.current.clear();
    knownPartIdsRef.current.clear();
    // 清理重连恢复定时器
    sse.clearRecoveryTimers();
  }, [sse]);

  /** 清除 busy 状态（用于 sendInterrupt 兜底，SSE 流可能已断开收不到 idle 事件） */
  const clearBusy = useCallback(() => {
    setBusy(false);
    setBusyLabel(undefined);
    setRetry(null);
  }, []);

  /**
   * 设置模型 context 限制。
   * 通常在以下时机调用：
   * 1. 客户端启动时（从 config.model 推断）
   * 2. 用户切换模型时
   * 3. 从 session 信息中获取（OpenCode 的 session 中可能包含模型信息）
   */
  const setContextLimit = useCallback((limit: number) => {
    setContextUsage(prev => ({
      ...prev,
      contextLimit: limit,
      ratio: limit > 0 ? prev.input / limit : 0,  // input 已含 cache（当前实际上下文大小）
    }));
  }, []);

  /** 手动追加一条消息到列表 */
  const addMessage = useCallback((entry: MessageEntry) => {
    knownMessageIdsRef.current.add(entry.info.id);
    for (const part of entry.parts) {
      knownPartIdsRef.current.add(part.id);
    }
    setMessages(prev => {
      // 去重：如果已有相同 id 的消息，不重复添加
      if (prev.some(m => m.info.id === entry.info.id)) return prev;
      return [...prev, entry];
    });
  }, []);

  /**
   * 删除指定消息之后的所有消息（用于回滚后清理 UI）。
   * 保留指定消息及其之前的所有消息。
   *
   * session.revert 成功后服务端会逐步推送 message.removed 事件，
   * 但可能存在延迟或丢失。此方法提供即时 UI 更新，确保回滚后
   * 对话区立即反映正确状态，不依赖事件推送的时序。
   */
  const removeMessagesAfter = useCallback((messageId: string) => {
    setMessages(prev => {
      const idx = prev.findIndex(m => m.info.id === messageId);
      if (idx < 0) return prev;
      return prev.slice(0, idx);
    });
  }, []);

  /**
   * 批量设置消息列表（用于加载历史会话时回显）。
   * 先清空内部过滤状态，然后直接替换 messages。
   * 从历史消息的 step-finish parts 计算：
   * - input/output/reasoning/cache：取**最后一次** step-finish 的值（代表当前实际上下文大小）
   * - total：所有 step-finish 之和（代表整个会话累计开销）
   * 重要：必须清空 busy 状态，否则加载历史会话后 UI 会误显示"正在执行"
   */
  const setMessagesDirect = useCallback((entries: MessageEntry[]) => {
    // 清空内部过滤状态，避免旧 session 的过滤规则影响新消息
    userMessageTextMap.current.clear();
    internalCheckTimers.current.forEach(t => clearTimeout(t));
    internalCheckTimers.current.clear();
    internalMessageIds.current.clear();
    confirmedUserMessageIds.current.clear();
    userMessageRoles.current.clear();
    // 清理流式 delta 累积缓冲
    partTextAccumDelta.current.clear();
    // 清理 delta 合并刷新状态，并从历史消息填充 known 集合
    if (deltaFlushTimerRef.current !== null) {
      clearTimeout(deltaFlushTimerRef.current);
      deltaFlushTimerRef.current = null;
    }
    dirtyDeltaMessagesRef.current.clear();
    knownMessageIdsRef.current.clear();
    knownPartIdsRef.current.clear();
    for (const entry of entries) {
      knownMessageIdsRef.current.add(entry.info.id);
      for (const part of entry.parts) {
        knownPartIdsRef.current.add(part.id);
      }
    }
    // 加载历史会话时必然不在执行中，重置 busy 状态避免 UI 显示"正在执行"
    setBusy(false);
    setBusyLabel(undefined);
    setMessages(entries);

    // 从历史消息中累计 token 使用量
    // 优先从 entry.info.tokens（assistant 消息级）提取，
    // 回退到 step-finish part 的 tokens（兼容旧格式）。
    // v2 SDK 的 session.messages() 返回 { info: AssistantMessage, parts: Part[] }，
    // AssistantMessage.tokens 是该消息的完整 token 统计，比 step-finish part 更可靠。
    let cumInput = 0;
    let cumOutput = 0;
    let cumReasoning = 0;
    let cumCacheRead = 0;
    let cumCacheWrite = 0;
    // 最后一次 assistant 消息的 tokens（用于反映"当前实际上下文大小"）
    let lastInput = 0;
    let lastOutput = 0;
    let lastReasoning = 0;
    let lastCacheRead = 0;
    let lastCacheWrite = 0;
    for (const entry of entries) {
      // 方式1：从 entry.info.tokens 提取（assistant 消息级，v2 SDK 可靠来源）
      const info = entry.info as any;
      if (info.role === 'assistant' && info.tokens) {
        const tokens = info.tokens as {
          input: number;
          output: number;
          reasoning: number;
          cache: { read: number; write: number };
        };
        console.log('[opencode-events] loadHistory tokens from info.tokens:', {
          id: info.id?.slice(0, 8),
          input: tokens.input,
          output: tokens.output,
          reasoning: tokens.reasoning,
          cacheRead: tokens.cache?.read,
          cacheWrite: tokens.cache?.write,
          total: (tokens as any).total,
          raw: JSON.stringify(tokens),
        });
        const tInput = tokens.input || 0;
        const tOutput = tokens.output || 0;
        const tReasoning = tokens.reasoning || 0;
        const tCacheRead = tokens.cache?.read || 0;
        const tCacheWrite = tokens.cache?.write || 0;
        // 当前实际上下文大小 = input + cache.read + cache.write
        // （缓存命中的 token 仍是 prompt 的一部分，占用 context 窗口）
        const tContextSize = tInput + tCacheRead + tCacheWrite;
        cumInput += tContextSize;
        cumOutput += tOutput;
        cumReasoning += tReasoning;
        cumCacheRead += tCacheRead;
        cumCacheWrite += tCacheWrite;
        // 覆盖为最后一次 assistant 消息的值
        lastInput = tContextSize;
        lastOutput = tOutput;
        lastReasoning = tReasoning;
        lastCacheRead = tCacheRead;
        lastCacheWrite = tCacheWrite;
        continue; // 已从 info.tokens 提取，跳过 parts 遍历
      }
      // 方式2：从 step-finish part 提取（回退，兼容 info.tokens 缺失的情况）
      if (Array.isArray(entry.parts)) {
        for (const part of entry.parts) {
          if (part.type === 'step-finish') {
            const tokens = (part as any).tokens as {
              input: number;
              output: number;
              reasoning: number;
              cache: { read: number; write: number };
            } | undefined;
            if (tokens) {
              console.log('[opencode-events] loadHistory tokens from step-finish (fallback):', {
                id: (entry.info as any).id?.slice(0, 8),
                input: tokens.input,
                output: tokens.output,
                reasoning: tokens.reasoning,
                raw: JSON.stringify(tokens),
              });
              const sInput = tokens.input || 0;
              const sOutput = tokens.output || 0;
              const sReasoning = tokens.reasoning || 0;
              const sCacheRead = tokens.cache?.read || 0;
              const sCacheWrite = tokens.cache?.write || 0;
              const sContextSize = sInput + sCacheRead + sCacheWrite;
              cumInput += sContextSize;
              cumOutput += sOutput;
              cumReasoning += sReasoning;
              cumCacheRead += sCacheRead;
              cumCacheWrite += sCacheWrite;
              lastInput = sContextSize;
              lastOutput = sOutput;
              lastReasoning = sReasoning;
              lastCacheRead = sCacheRead;
              lastCacheWrite = sCacheWrite;
            }
          }
        }
      }
    }
    const total = cumInput + cumOutput + cumReasoning;
    console.log('[opencode-events] loadHistory contextUsage result:', {
      lastInput,
      lastOutput,
      lastReasoning,
      cumInput,
      cumOutput,
      total,
      entryCount: entries.length,
    });
    setContextUsage(prev => ({
      input: lastInput,
      output: lastOutput,
      reasoning: lastReasoning,
      cache: { read: lastCacheRead, write: lastCacheWrite },
      total,
      contextLimit: prev.contextLimit,
      ratio: prev.contextLimit > 0 ? lastInput / prev.contextLimit : 0,
    }));
  }, []);

  /**
   * 订阅 SSE 事件流，返回取消订阅函数
   *
   * 包含自动重连机制：SSE 流正常结束或异常断开后，
   * 延迟 RECONNECT_DELAY_MS 后自动重新订阅，确保事件流不会永久中断。
   * 重连前兜底清除 busy 状态（流断开后大概率收不到 session.status:idle 事件）。
   */
  const subscribe = useCallback((client: OpencodeClient, directory: string | null): (() => void) => {
    const abortController = new AbortController();
    abortRef.current = abortController;

    // 规范化目录路径用于比较：
    // 统一反斜杠为正斜杠（兼容 Windows）并去除尾部斜杠。
    // 前端 directory 经 joinPath 已为正斜杠，但 SSE 事件流中的
    // globalEvent.directory 在 Windows 下为反斜杠，若不统一分隔符，
    // 比较结果永远不相等，会导致本目录的事件被全部过滤 → 无回复。
    const normalizedDir = directory ? trimTrailingSlash(normalizePath(directory)) : null;

    let filteredCount = 0;

    const run = async () => {
      let reconnectDelay = sse.initialReconnectDelay;

      while (!abortController.signal.aborted) {
        // 心跳看护：定期检查最后活动时间，超时则置位标记，由 for await 主动跳出重连
        // （不能 abortController.abort()，否则会跳出整个重连循环）
        const stopHeartbeatWatch = sse.startHeartbeatWatch(
          () => !abortController.signal.aborted,
        );

        try {
          // v2 SDK: client.global.event() 返回 ServerSentEventsResult<GlobalEvent>
          // 其中 GlobalEvent = { directory, payload: Event }
          const result = await client.global.event();
          // 连接成功，重置退避延迟
          reconnectDelay = sse.initialReconnectDelay;

          // ── 重连成功后的恢复处理 ──
          // 1. 立即 flushDeltas：将 accumDelta 中累积的文本同步到 part.text，
          //    避免重连期间 delta 丢失导致 reasoning/text 显示不完整
          // 2. 如果重连前 busy=true（思考被中断），设置 15s 超时兜底：
          //    重连后如果 session 实际已 idle 但未推送 session.status 事件，
          //    15s 后自动清除 busy 并提示用户"连接已恢复，但思考状态未同步"
          if (dirtyDeltaMessagesRef.current.size > 0) {
            flushDeltas();
          }
          if (busyRef.current) {
            addLog({
              source: 'opencode',
              text: '事件流已重连，正在恢复思考状态...',
              timestamp: new Date(),
              level: 'info',
            });
            // 15s 超时兜底：重连后如果一直没收到 session.status:idle，
            // 说明服务端在断连期间已完成生成，主动清除 busy
            const recoveryTimer = setTimeout(() => {
              if (busyRef.current && !abortController.signal.aborted) {
                addLog({
                  source: 'opencode',
                  text: '重连后未收到会话状态更新，已清除执行状态（思考可能在断连时已结束）',
                  timestamp: new Date(),
                  level: 'warn',
                });
                setBusy(false);
                setBusyLabel(undefined);
                setRetry(null);
                // 兜底 flush，确保最终文本完整显示
                if (dirtyDeltaMessagesRef.current.size > 0) {
                  flushDeltas();
                }
              }
            }, RECOVERY_FALLBACK_MS);
            // 退出当前作用域时清理定时器（finally 的停止心跳看护不会清理这个）
            sse.trackRecoveryTimer(recoveryTimer);
          }

          for await (const globalEvent of result.stream) {
            if (abortController.signal.aborted) break;
            // 心跳超时标记：主动跳出 for await，进入重连
            if (sse.consumeHeartbeatTimeout()) {
              console.warn('[opencode-events] 心跳超时，主动中断当前 SSE 流');
              break;
            }
            // GlobalEvent = { directory, payload: Event }
            // 按工作目录过滤事件：两个 backend 共享同一个 OpenCode 服务进程，
            // 各自订阅全局事件流。只处理属于自己工作目录的事件，避免跨模块串扰。
            if (normalizedDir && globalEvent.directory) {
              const eventDir = trimTrailingSlash(normalizePath(String(globalEvent.directory)));
              if (eventDir !== normalizedDir) {
                filteredCount++;
                continue;
              }
            }
            handleEvent(globalEvent.payload);
          }

          // for await 正常退出（流结束，非 abort）
          if (abortController.signal.aborted) {
            stopHeartbeatWatch();
            break;
          }

          // ── 流断开处理 ──
          // 区分两种情况：
          // 1. 用户主动 abort（如切换目录/断开连接）→ 不处理，外层 break
          // 2. 流异常结束（服务端关闭/网络中断/心跳超时）→ 需要重连
          //
          // 关键修复：如果断开时 busy=true（智能体正在思考），
          // 不再立即清除 busy 状态，而是：
          // - 记录 error 级别日志（而非 warn），明确提示"思考过程意外中断"
          // - 保留 busy 状态短暂时间，等重连后由 session.status 事件纠正
          // - 重连成功后立即 flushDeltas，将 accumDelta 同步到 part.text
          //   避免重连期间 delta 丢失导致 reasoning 显示不完整
          const wasBusy = busyRef.current;
          if (wasBusy) {
            // 思考过程被意外中断：这是用户感知最强的问题
            addLog({
              source: 'opencode',
              text: '思考过程意外中断（事件流断开），正在尝试重连以恢复...',
              timestamp: new Date(),
              level: 'error',
            });
            // 不清除 busy：保留"正在思考"状态，等重连成功后由 session.status 事件纠正
            // 如果重连失败（达到最大重试次数），下面的退避逻辑会清除 busy
          } else {
            // 非思考期间的断开：清除 busy 兜底（UI 不会卡在"执行中"）
            setBusy(false);
            setBusyLabel(undefined);
            setRetry(null);
            addLog({
              source: 'opencode',
              text: '事件流断开，正在重连...',
              timestamp: new Date(),
              level: 'warn',
            });
          }
        } catch (err: any) {
          if (abortController.signal.aborted) {
            stopHeartbeatWatch();
            return;
          }

          console.error('[opencode-events] SSE error:', err?.message || err);
          addLog({
            source: 'opencode',
            text: `事件流错误: ${err?.message || String(err)}`,
            timestamp: new Date(),
            level: 'error',
          });

          // 异常断开也兜底清除 busy
          setBusy(false);
          setBusyLabel(undefined);
          setRetry(null);
        } finally {
          stopHeartbeatWatch();
          // 清理重连恢复定时器（无论是否触发，都不再需要）
          sse.clearRecoveryTimers();
        }

        // 退避延迟后重连（指数退避，上限 30s）
        if (abortController.signal.aborted) break;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, reconnectDelay);
          // 如果 abort 在等待期间触发，立即 resolve 跳出循环
          abortController.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
        reconnectDelay = sse.nextBackoffDelay(reconnectDelay);

        // 重连成功后会进入下一次 while 循环，在 client.global.event() 成功后
        // 立即 flushDeltas（见上方"重连成功后的恢复处理"），
        // 将 accumDelta 中累积的文本同步到 part.text，
        // 避免重连期间 delta 丢失导致显示不完整。
        // accumDelta ref 在重连期间不会被清理，readPartText 读取它保证文本不丢失。
      }
    };

    // run() 是 async fire-and-forget；用 .catch 兜底防止 Unhandled Promise Rejection
    run().catch((err) => {
      if (abortController.signal.aborted) return;
      addLog({
        source: 'opencode',
        text: `事件流未捕获异常: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: new Date(),
        level: 'error',
      });
    });

    return () => {
      abortController.abort();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addLog, sse]);

  /**
   * 检查并过滤内部 user 消息
   *
   * 当 user message 的 text 累积稳定后（800ms 无新更新）触发：
   * 1. 累积的 text 已经在 sentUserInputsRef 中 → 真实用户消息，标记为已确认并锁定
   * 2. 累积的 text 不在 sentUserInputsRef 中 → sub-agent 内部消息，移除
   *
   * 注意：本地临时 user 消息（id 以 "user-" 开头）由 useOpencodeBackend.sendMessage
   * 通过 addMessage 直接添加，不走事件流，所以不会被此逻辑处理。
   *
   * 匹配策略：因为累积 text 可能包含用户输入后追加的 sub-agent 内容，
   * 用 startsWith 判断"以真实用户输入开头"以兼容这种情况。
   */
  function checkAndFilterInternalUserMessage(messageId: string): void {
    // 已确认为真实用户消息或已标记为内部消息 → 跳过
    if (confirmedUserMessageIds.current.has(messageId)) return;
    if (internalMessageIds.current.has(messageId)) return;

    const accumulatedText = (userMessageTextMap.current.get(messageId) || '').trim();
    if (!accumulatedText) {
      // 还没有 text，继续等待
      return;
    }

    const knownInputs = sentUserInputsRef?.current;
    let isKnown = false;
    if (knownInputs && knownInputs.size > 0) {
      for (const input of knownInputs) {
        const trimmedInput = input.trim();
        if (!trimmedInput) continue;
        // 匹配策略（按优先级）：
        // 1. 累积的 text 以真实用户输入开头（处理 sub-agent 在尾部追加内容的情况）
        // 2. 真实用户输入包含累积的 text（累积尚未完成，但已有部分匹配）
        if (
          accumulatedText.startsWith(trimmedInput) ||
          trimmedInput.includes(accumulatedText)
        ) {
          isKnown = true;
          break;
        }
      }
    }

    if (!isKnown) {
      // 不在已知用户输入中 → 视为 sub-agent 内部消息，从列表移除
      internalMessageIds.current.add(messageId);
      setMessages(prev => prev.filter(m => m.info.id !== messageId));
      addLog({
        source: 'opencode',
        text: `已过滤 sub-agent 内部消息 (${messageId.slice(0, 8)}...)`,
        timestamp: new Date(),
        level: 'debug',
      });
    } else {
      // 是真实用户消息，标记为已确认并锁定（后续 part 更新不再重新检查）
      confirmedUserMessageIds.current.add(messageId);
      addLog({
        source: 'opencode',
        text: `已确认真实用户消息 (${messageId.slice(0, 8)}...)`,
        timestamp: new Date(),
        level: 'debug',
      });
    }

    // 清理该消息的累积状态
    userMessageTextMap.current.delete(messageId);
    internalCheckTimers.current.delete(messageId);
  }



  /**
   * 处理单个 SSE 事件（event = GlobalEvent.payload = Event 联合类型）
   */
  function handleEvent(event: any) {
    const type = event?.type as string;
    if (!type) return;
    // 任何事件（含心跳）都更新最后活动时间，用于连接健康检测
    sse.noteActivity();
    // 心跳事件仅用于刷新活动时间，不需要进一步处理
    if (type === 'server.heartbeat') return;
    if (IGNORED_EVENTS.has(type)) return;
    const props = event.properties || {};

    switch (type) {
      // ── 服务端连接 ──
      case 'server.connected':
        setBusy(false);
        break;

      // ── 会话事件 ──
      // 注意：不在此处自动 setCurrentSessionId。
      // 两个模块（数据探索/开发助手）共享同一 OpenCode 服务进程的全局事件流，
      // 当一个模块创建/更新/删除 session 时，事件可能泄漏到另一个模块。
      // 若此处无条件 setCurrentSessionId，会导致另一个模块的 currentSessionId
      // 被污染为错误的 session，后续消息发到错误 session → 回复被目录过滤 → 无回复。
      // currentSessionId 的设置由本模块主动操作负责：
      //   - sendMessage 创建 session 后主动设置
      //   - newSession 创建后主动设置
      //   - loadSession 加载后主动设置
      //   - deleteSession 删除后主动清理
      case 'session.created':
      case 'session.updated':
        // EventSessionCreated/Updated.properties = { info: Session }
        break;

      case 'session.deleted':
        // EventSessionDeleted.properties = { info: Session }
        break;

      case 'session.status': {
        // EventSessionStatus.properties = { sessionID, status: SessionStatus }
        // v2 SessionStatus = { type: "idle" } | { type: "busy" } | { type: "retry", attempt, message, next, action? }
        // busy 状态无 label 字段，客户端固定显示"正在思考..."（对齐桌面版 ui.sessionTurn.status.thinking）
        // retry 期间保持 busy=true（对齐桌面版：retry 是 busy 的子态，避免 TodoDock 误判 idle）
        const st = props.status?.type;
        if (st === 'busy') {
          setBusy(true);
          setBusyLabel('正在思考...');
          setRetry(null);
        } else if (st === 'retry') {
          const status = props.status as { type: 'retry'; attempt: number; message: string; next: number; action?: RetryState['action'] };
          setBusy(true);
          setBusyLabel('正在重试...');
          setRetry({
            attempt: status.attempt,
            message: status.message,
            next: status.next,
            action: status.action,
          });
        } else if (st === 'idle') {
          setBusy(false);
          setBusyLabel(undefined);
          setRetry(null);
          // 流式结束，立即刷新未合并的 delta，确保最终文本完整显示
          if (deltaFlushTimerRef.current !== null) {
            clearTimeout(deltaFlushTimerRef.current);
            deltaFlushTimerRef.current = null;
            flushDeltas();
          }
        }
        break;
      }

      case 'session.idle':
        // EventSessionIdle.properties = { sessionID }
        setBusy(false);
        setBusyLabel(undefined);
        setRetry(null);
        // 流式结束，立即刷新未合并的 delta
        if (deltaFlushTimerRef.current !== null) {
          clearTimeout(deltaFlushTimerRef.current);
          deltaFlushTimerRef.current = null;
          flushDeltas();
        }
        break;

      case 'session.error':
        // EventSessionError.properties = { sessionID?, error? }
        addLog({
          source: 'opencode',
          text: `会话错误: ${props.error?.data?.message || props.error?.name || '未知错误'}`,
          timestamp: new Date(),
          level: 'error',
        });
        break;

      case 'session.compacted': {
        // EventSessionCompacted.properties = { sessionID }
        // 服务端已完成会话历史压缩（session.summarize 调用完成）。
        //
        // 处理逻辑：
        // 1. 设置 skipNextStepFinish 标志，跳过压缩步骤自己的 step-finish（其 input
        //    是被压缩的"完整旧历史"大小，不是压缩后的新大小）。
        // 2. 重置 current step 指标（input/output/reasoning/cache/ratio），
        //    进度条暂时归零，等待用户发送新消息后由 LLM 响应 step-finish 设置新值。
        // 3. 累计 total 保留不变（仍反映整个会话累计开销）。
        
        skipNextStepFinish.current = true;
        setContextUsage(prev => ({
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
          total: prev.total,
          contextLimit: prev.contextLimit,
          ratio: 0,
        }));
        addLog({
          source: 'opencode',
          text: '会话历史已压缩，进度条已重置',
          timestamp: new Date(),
          level: 'info',
        });
        break;
      }

      // ── 消息事件 ──
      case 'message.updated': {
        // EventMessageUpdated.properties = { info: Message }
        const info = props.info as any;
        if (!info?.id) break;

        // ── AssistantMessage 的 tokens 更新上下文使用量 ──
        // AssistantMessage.tokens 包含该消息完整的 token 统计，
        // 在消息完成（finish 字段存在）时用其覆盖式更新 current step 指标，
        // 确保进度条反映最终准确值（比 step-finish 中的中间值更可靠）。
        if (info.role === 'assistant' && info.finish && info.tokens) {
          const msgTokens = info.tokens as {
            input: number;
            output: number;
            reasoning: number;
            cache: { read: number; write: number };
          };
          console.log('[opencode-events] SSE message.updated tokens:', {
            id: info.id?.slice(0, 8),
            input: msgTokens.input,
            output: msgTokens.output,
            reasoning: msgTokens.reasoning,
            cacheRead: msgTokens.cache?.read,
            cacheWrite: msgTokens.cache?.write,
            total: (msgTokens as any).total,
            raw: JSON.stringify(msgTokens),
          });
          const msgInput = msgTokens.input || 0;
          const msgOutput = msgTokens.output || 0;
          const msgReasoning = msgTokens.reasoning || 0;
          const msgCacheRead = msgTokens.cache?.read || 0;
          const msgCacheWrite = msgTokens.cache?.write || 0;
          // 当前实际上下文大小 = input + cache.read + cache.write
          // （缓存命中的 token 仍是 prompt 的一部分，占用 context 窗口）
          const msgContextSize = msgInput + msgCacheRead + msgCacheWrite;
          const msgTotal = msgContextSize + msgOutput + msgReasoning;

          setContextUsage(prev => ({
            input: msgContextSize,
            output: msgOutput,
            reasoning: msgReasoning,
            cache: { read: msgCacheRead, write: msgCacheWrite },
            total: prev.total + msgTotal,
            contextLimit: prev.contextLimit,
            ratio: prev.contextLimit > 0 ? msgContextSize / prev.contextLimit : 0,
          }));
        }

        // 记录消息 role（用于后续判断 user message 是否需要过滤）
        userMessageRoles.current.set(info.id, info.role);
        // 标记消息为已知（delta 合并刷新用）
        knownMessageIdsRef.current.add(info.id);

        setMessages(prev => {
          let cleaned = prev;
          if (info.role === 'user') {
            // 跳过已被标记为内部消息的 user 消息
            if (internalMessageIds.current.has(info.id)) {
              return prev;
            }
            // 过滤掉本地临时 user 消息（id 以 "user-" 开头）
            // 等待服务端回传的真实 user message 来替换
            cleaned = prev.filter(m => !m.info.id.startsWith('user-'));
          }
          const idx = cleaned.findIndex(m => m.info.id === info.id);
          if (idx >= 0) {
            const next = [...cleaned];
            next[idx] = { info, parts: next[idx].parts };
            return next;
          }
          return [...cleaned, { info, parts: [] }];
        });
        break;
      }

      case 'message.part.delta': {
        // v2 新增事件：流式增量 delta
        // EventMessagePartDelta.properties = { sessionID, messageID, partID, field, delta }
        // v2 将流式文本拆分：delta 事件推送增量，updated 事件推送全量状态。
        const deltaMessageId = props.messageID as string;
        const deltaPartId = props.partID as string;
        const deltaField = props.field as string;
        const deltaText = props.delta as string;
        if (!deltaMessageId || !deltaPartId || !deltaText) break;
        if (internalMessageIds.current.has(deltaMessageId)) break;

        // 累积到 partTextAccumDelta Map（供 TextPartDisplay 读取流式文本，对齐桌面版 part_text_accum_delta）
        // ref 立即更新，readPartText 读取它保证文本不延迟
        if (deltaField === 'text' || deltaField === 'reasoning') {
          const prev = partTextAccumDelta.current.get(deltaPartId) || '';
          partTextAccumDelta.current.set(deltaPartId, prev + deltaText);
        }

        // ── 同步 messages state（合并刷新优化） ──
        // 新消息/新 part 首次到达时立即创建；已有消息的后续 delta 合并刷新
        const messageKnown = knownMessageIdsRef.current.has(deltaMessageId);
        const partKnown = knownPartIdsRef.current.has(deltaPartId);

        if (!messageKnown) {
          // message.part.delta 可能先于 message.part.updated 到达，自动创建占位条目
          knownMessageIdsRef.current.add(deltaMessageId);
          knownPartIdsRef.current.add(deltaPartId);
          setMessages(prev => {
            if (prev.some(m => m.info.id === deltaMessageId)) return prev;
            return [...prev, {
              info: {
                id: deltaMessageId,
                sessionID: props.sessionID || '',
                role: 'assistant',
                time: { created: Date.now() },
              } as any,
              parts: [{
                id: deltaPartId,
                type: deltaField === 'reasoning' ? 'reasoning' : 'text',
                text: deltaText,
                messageID: deltaMessageId,
                sessionID: props.sessionID || '',
              } as any],
            }];
          });
        } else if (!partKnown) {
          // part 尚未通过 part.updated 创建，先插入占位 part
          knownPartIdsRef.current.add(deltaPartId);
          setMessages(prev => prev.map(m => {
            if (m.info.id !== deltaMessageId) return m;
            if (m.parts.some(p => p.id === deltaPartId)) return m;
            return {
              ...m,
              parts: [...m.parts, {
                id: deltaPartId,
                type: deltaField === 'reasoning' ? 'reasoning' : 'text',
                text: deltaText,
                messageID: deltaMessageId,
                sessionID: props.sessionID || '',
              } as any],
            };
          }));
        } else {
          // 已有消息 + 已有 part：标记 dirty，合并刷新
          // accumDelta 已更新，flushDeltas 会将 accumDelta 同步到 part.text
          dirtyDeltaMessagesRef.current.add(deltaMessageId);
          scheduleDeltaFlush();
        }

        // ── 内部 user 消息检测（从 delta 累积 text） ──
        // v2 中 user message 的流式 text 通过 message.part.delta 推送，
        // 在此累积后检查是否匹配真实用户输入。
        const deltaRole = userMessageRoles.current.get(deltaMessageId);
        if (deltaRole === 'user' && deltaField === 'text') {
          const prevText = userMessageTextMap.current.get(deltaMessageId) || '';
          const newText = prevText + deltaText;
          userMessageTextMap.current.set(deltaMessageId, newText);

          const oldTimer = internalCheckTimers.current.get(deltaMessageId);
          if (oldTimer) {
            clearTimeout(oldTimer);
            internalCheckTimers.current.delete(deltaMessageId);
          }
          checkAndFilterInternalUserMessage(deltaMessageId);
        }
        break;
      }

      case 'message.part.updated': {
        // v2 EventMessagePartUpdated.properties = { sessionID, part: Part, time }
        // 注意：v2 不再有 delta 字段！流式增量通过 message.part.delta 事件推送。
        // 此处做全量替换：用 part（完整状态）覆盖现有 part。
        const part = props.part as Part;
        const messageId = part?.messageID;
        if (!messageId || !part?.id) break;

        // 如果该消息已被标记为内部消息或已确认为真实用户消息，跳过处理
        if (internalMessageIds.current.has(messageId)) break;
        if (confirmedUserMessageIds.current.has(messageId)) break;

        // text/reasoning part 全量替换时清理 accumDelta（part.text 已是完整文本）
        if (part.type === 'text' || part.type === 'reasoning') {
          partTextAccumDelta.current.delete(part.id);
        }
        // 标记消息和 part 为已知（delta 合并刷新用）
        knownMessageIdsRef.current.add(messageId);
        knownPartIdsRef.current.add(part.id);

        setMessages(prev => {
          const msgIdx = prev.findIndex(m => m.info.id === messageId);
          if (msgIdx < 0) {
            // message.updated 事件可能丢失或被目录过滤，自动创建消息条目
            const role = (part as any).role || 'assistant';
            return [...prev, {
              info: {
                id: messageId,
                sessionID: (part as any).sessionID || '',
                role,
                time: { created: Date.now() },
              } as any,
              parts: [part],
            }];
          }
          return prev.map(m => {
            if (m.info.id !== messageId) return m;
            const partIdx = m.parts.findIndex(p => p.id === part.id);
            if (partIdx >= 0) {
              // 全量替换：v2 的 part 是完整状态，合并覆盖现有 part
              const newParts = [...m.parts];
              newParts[partIdx] = { ...newParts[partIdx], ...part } as Part;
              return { ...m, parts: newParts };
            }
            return { ...m, parts: [...m.parts, part] };
          });
        });

        // ── todowrite 工具更新时提取 todos（回退机制） ──
        // 当 todo.updated SSE 事件未触发时，从工具 part 的 metadata 中提取 todos
        if (part.type === 'tool' && (part as any).tool === 'todowrite') {
          const toolState = (part as any).state;
          const metaTodos = toolState?.metadata?.todos;
          const inputTodos = toolState?.input?.todos;
          console.log('[DEBUG-TODO] todowrite part.updated:', {
            time: new Date().toISOString(),
            partState: toolState?.status,
            metaStatuses: (metaTodos || []).map((t: any) => t.status),
            inputStatuses: (inputTodos || []).map((t: any) => t.status),
          });
          const extractedTodos = Array.isArray(metaTodos) && metaTodos.length > 0
            ? metaTodos
            : (Array.isArray(inputTodos) && inputTodos.length > 0 ? inputTodos : null);
          if (extractedTodos) {
            setTodos(extractedTodos);
          }
        }

        // ── step-finish 事件：更新 token 使用量 ──
        // StepFinishPart 包含当次 LLM 调用的 token 统计：
        //   tokens: { input, output, reasoning, cache: { read, write } }
        //
        // 关键区分：
        // - input/output/reasoning/cache：取**当次**值（覆盖式），代表"当前实际上下文大小"，
        //   用于进度条展示。
        // - total：累加所有 step 的 token，反映"整个会话累计开销"（供趋势分析）。
        //
        // 压缩步骤特殊处理：被 skipNextStepFinish 标记时，仅累加到 total，
        // 不覆盖 current step 指标（避免进度条短暂回弹到压缩前的旧历史大小）。
        if (part.type === 'step-finish') {
          const tokens = (part as any).tokens as {
            input: number;
            output: number;
            reasoning: number;
            cache: { read: number; write: number };
          } | undefined;
          if (tokens) {
            const stepInput = tokens.input || 0;
            const stepOutput = tokens.output || 0;
            const stepReasoning = tokens.reasoning || 0;
            const stepCacheRead = tokens.cache?.read || 0;
            const stepCacheWrite = tokens.cache?.write || 0;
            // 当前实际上下文大小 = input + cache.read + cache.write
            // （缓存命中的 token 仍是 prompt 的一部分，占用 context 窗口）
            const stepContextSize = stepInput + stepCacheRead + stepCacheWrite;
            const stepTotal = stepContextSize + stepOutput + stepReasoning;

            if (skipNextStepFinish.current) {
              // 压缩步骤：仅累加到 total，不更新 current step 指标
              skipNextStepFinish.current = false;
              setContextUsage(prev => ({
                input: prev.input,
                output: prev.output,
                reasoning: prev.reasoning,
                cache: { ...prev.cache },
                total: prev.total + stepTotal,
                contextLimit: prev.contextLimit,
                ratio: prev.contextLimit > 0 ? prev.input / prev.contextLimit : 0,
              }));
            } else {
              // 正常步骤：覆盖式更新 current step 指标
              setContextUsage(prev => ({
                input: stepContextSize,
                output: stepOutput,
                reasoning: stepReasoning,
                cache: { read: stepCacheRead, write: stepCacheWrite },
                total: prev.total + stepTotal,
                contextLimit: prev.contextLimit,
                ratio: prev.contextLimit > 0 ? stepContextSize / prev.contextLimit : 0,
              }));
            }
          }
        }
        break;
      }

      case 'message.part.removed': {
        // EventMessagePartRemoved.properties = { sessionID; messageID; partID }
        const rmMessageId = props.messageID;
        const rmPartId = props.partID;
        if (!rmMessageId || !rmPartId) break;
        setMessages(prev =>
          prev.map(m =>
            m.info.id === rmMessageId
              ? { ...m, parts: m.parts.filter(p => p.id !== rmPartId) }
              : m
          )
        );
        break;
      }

      case 'message.removed': {
        // EventMessageRemoved.properties = { sessionID; messageID }
        const removedId = props.messageID;
        if (!removedId) break;
        setMessages(prev => prev.filter(m => m.info.id !== removedId));
        break;
      }

      // ── 权限事件 ──
      // v2 将 permission.updated 拆分为 permission.asked（请求）+ permission.replied（响应）
      case 'permission.asked': {
        // v2 EventPermissionAsked.properties = { id, sessionID, permission, patterns, metadata, always, tool? }
        // external_directory 已在服务端配置为 "deny"：工作目录之外的外部路径直接拒绝，
        // 不再产生 permission.asked 事件；此处仅处理其余（bash 等）权限弹窗。
        if (props.id) {
          const newModal: ModalRequest = {
            kind: 'permission',
            request_id: props.id,
            tool_name: props.permission,
            permission: props.permission,
            patterns: props.patterns,
          };
          setModals(prev => prev.some(m => m.request_id === props.id) ? prev : [...prev, newModal]);
        }
        break;
      }

      case 'permission.v2.asked': {
        // v2 EventPermissionV2Asked.properties = { id, sessionID, action, resources, save?, metadata?, source? }
        if (props.id) {
          const newModal: ModalRequest = {
            kind: 'permission',
            request_id: props.id,
            tool_name: props.action,
            permission: props.action,
            patterns: props.resources,
          };
          setModals(prev => prev.some(m => m.request_id === props.id) ? prev : [...prev, newModal]);
        }
        break;
      }

      case 'permission.replied':
      case 'permission.v2.replied': {
        // v2 EventPermissionReplied/V2Replied.properties = { sessionID; requestID; reply }
        const reqId = props.requestID as string | undefined;
        setModals(prev => reqId ? prev.filter(m => m.request_id !== reqId) : []);
        break;
      }

      // ── 提问事件 ──
      // 对齐桌面版 session-question-dock：question.asked 推送提问请求，question.replied/rejected 清除
      case 'question.asked': {
        // EventQuestionAsked.properties = { id, sessionID, questions: QuestionInfo[], tool? }
        if (props.id) {
          const newModal: ModalRequest = {
            kind: 'question',
            request_id: props.id,
            questions: props.questions,
          };
          setModals(prev => prev.some(m => m.request_id === props.id) ? prev : [...prev, newModal]);
        }
        break;
      }

      case 'question.v2.asked': {
        // V2EventQuestionV2Asked.data = { id, sessionID, questions: QuestionV2Info[], tool? }
        // 注意：v2 事件用 data 而非 properties，但 props 兼容取值
        if (props.id) {
          const newModal: ModalRequest = {
            kind: 'question',
            request_id: props.id,
            questions: props.questions,
          };
          setModals(prev => prev.some(m => m.request_id === props.id) ? prev : [...prev, newModal]);
        }
        break;
      }

      case 'question.replied':
      case 'question.rejected':
      case 'question.v2.replied':
      case 'question.v2.rejected': {
        // EventQuestionReplied/Rejected.properties = { sessionID, requestID }
        const reqId = props.requestID as string | undefined;
        setModals(prev => reqId ? prev.filter(m => m.request_id !== reqId) : []);
        break;
      }

      // ── 文件变更事件 ──
      case 'file.edited':
        // EventFileEdited.properties = { file: string }
        setLastFileChangeSeq(prev => prev + 1);
        if (props.file) {
          setLastFileChangePaths([props.file]);
        }
        break;

      case 'file.watcher.updated':
        // EventFileWatcherUpdated.properties = { file: string; event: "add"|"change"|"unlink" }
        setLastFileChangeSeq(prev => prev + 1);
        if (props.file) {
          setLastFileChangePaths([props.file]);
        }
        break;

      // ── Todo 事件 ──
      case 'todo.updated':
        // EventTodoUpdated.properties = { sessionID; todos: Todo[] }
        console.log('[DEBUG-TODO] todo.updated arrived:', {
          time: new Date().toISOString(),
          count: props.todos?.length,
          statuses: (props.todos || []).map((t: any) => t.status),
        });
        if (props.todos) {
          setTodos(props.todos);
        }
        break;

      // ── 命令执行事件 ──
      case 'command.executed':
        // EventCommandExecuted.properties = { name; sessionID; arguments; messageID }
        if (props.name) {
          addLog({
            source: 'stdout',
            text: `执行: ${props.name}${props.arguments ? ' ' + props.arguments : ''}`,
            timestamp: new Date(),
            level: 'info',
          });
        }
        break;

      default:
        break;
    }
  }

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      // 清理所有延迟检查定时器，避免内存泄漏
      internalCheckTimers.current.forEach(t => clearTimeout(t));
      internalCheckTimers.current.clear();
      // 清理 delta 合并刷新定时器
      if (deltaFlushTimerRef.current !== null) {
        clearTimeout(deltaFlushTimerRef.current);
        deltaFlushTimerRef.current = null;
      }
      // 清理重连恢复定时器
      sse.clearRecoveryTimers();
    };
  }, [sse]);

  return {
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
    partTextAccumDelta,
    readPartText,
  };
}
