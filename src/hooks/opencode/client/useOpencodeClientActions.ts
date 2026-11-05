/**
 * client/useOpencodeClientActions.ts — 公共会话动作 + 对外实例组装
 *
 * 动作层是「公共运行时（core）」与「模块工作空间策略（strategy）」的合流点：
 * 只有三类动作需要策略介入，其余全部与模块无关。
 *
 *   sendMessage   首发消息前 prepareNewSessionDirectory；续聊前 ensureSessionDirectory；
 *                 会话创建成功后 onSessionCreated
 *   newSession    清空会话态后 onNewSession（数据探索要另建目录）
 *   deleteSession 先本地删除（含墓碑）再 onSessionDeleted（数据探索要清理目录）
 *
 * 顺序上的硬约定见各函数内部注释，改动前务必先读 useOpencodeClient.deleteHistory.test.tsx
 * 与 useOpencodeClient.dataExploreDir.test.tsx 两个回归用例。
 */

import { useCallback, useMemo, useState } from 'react';
import type { MessageEntry, Todo } from '../../../types/opencode-backend';
import type { OpencodeClientBackend } from './types';
import type { WorkspaceStrategy } from './workspace';
import type { OpencodeClientCore } from './useOpencodeClientCore';

export interface OpencodeClientActions {
  sendMessage: (line: string) => Promise<void>;
  sendInterrupt: () => Promise<void>;
  sendRollback: (messageId: string) => Promise<{ success: boolean }>;
  sendPermissionResponse: (requestId: string, response: 'once' | 'always' | 'reject') => void;
  sendQuestionReply: (requestId: string, answers: string[][]) => void;
  sendQuestionReject: (requestId: string) => void;
  compressSession: () => Promise<{ success: boolean }>;
  compressing: boolean;

  newSession: () => Promise<void>;
  loadSession: (sessionId: string) => Promise<void>;
  listSessions: () => Promise<import('@opencode-ai/sdk/v2/client').Session[]>;
  deleteSession: (sessionId: string) => Promise<void>;
  renameTask: (sessionId: string, newTitle: string) => Promise<void>;
}

export function useOpencodeClientActions(
  core: OpencodeClientCore,
  strategy: WorkspaceStrategy,
): OpencodeClientActions {
  const {
    clientRef, addLog, config, currentSessionId, setCurrentSessionId, clearCurrentSession,
    sentUserInputsRef, activeLLMModelRef, sessions, history, chat, events, deleteSessionRemote,
  } = core;
  const currentDirectory = core.conn.currentDirectory;

  const {
    sendMessage: sendChatMessage,
    sendInterrupt: sendChatInterrupt,
    sendRollback: sendChatRollback,
    sendPermissionResponse: sendChatPermissionResponse,
    sendQuestionReply: sendChatQuestionReply,
    sendQuestionReject: sendChatQuestionReject,
    sendSummarize: sendChatSummarize,
  } = chat;
  const { addMessage, removeMessagesAfter, resetState, clearBusy, setTodos, setMessagesDirect } = events;
  const { listSessions: listSessionsRaw, loadSession: loadSessionRaw } = sessions;
  const { refreshTasks, upsertTask, removeTask, updateTaskTitleLocal } = history;

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

    // 续聊「已存在的会话」：交给策略把连接切回该会话所属的工作目录。
    // 数据探索每个会话 = individual/{ts} 独立目录；若沿 base 目录发送，SSE 事件发往会话
    // 自己的工作目录，与本模块订阅目录不一致 → 事件被目录过滤，只能看到本地临时消息、
    // 看不到智能体回复（开发助手是固定目录，策略为空操作）。
    if (sessionId) {
      await strategy.ensureSessionDirectory(sessionId);
    } else {
      // 首条消息通过对话创建会话：与「新建会话按钮」保持一致 ——
      // 若先前未新建会话目录（未点击新建按钮），则为本次对话创建一个独立目录并打开其标签页。
      // （策略内部保证 opencode 工作目录已实际落到 individual/{ts}，而不能停留在
      //  individual/ 基础目录，否则 session.create 会把新会话建在基础目录下。）
      await strategy.prepareNewSessionDirectory();

      try {
        const result = await clientRef.current!.session.create({
          title: trimmed.slice(0, 80),
        });
        if (result.data) {
          const newSessionId = result.data.id;
          sessionId = newSessionId;
          setCurrentSessionId(newSessionId);
          // 新增的会话写入本地历史（{backend_host}/{user}/{model_id}/{project_id}）
          upsertTask(newSessionId, trimmed.slice(0, 80));
          // 策略级关联（数据探索：把新会话与刚建好的会话目录绑定，删除时才能连带清理）
          strategy.onSessionCreated(newSessionId);
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
  }, [sendChatMessage, addMessage, addLog, currentSessionId, setCurrentSessionId, currentDirectory,
    refreshTasks, strategy, clientRef, sentUserInputsRef, activeLLMModelRef, upsertTask]);

  const sendInterrupt = useCallback(async () => {
    await sendChatInterrupt(clientRef.current);
    // 本地兜底清除 busy：abort 调用后如果 SSE 流已断开，
    // 收不到 session.status:idle 事件，UI 会永久卡在"执行中"。
    // 立即本地清除 busy，确保用户可以继续操作。
    // 如果 SSE 仍活跃，后续的 idle 事件也会清除（幂等）。
    clearBusy();
  }, [sendChatInterrupt, clearBusy, clientRef]);

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
  }, [sendChatRollback, removeMessagesAfter, addLog, clientRef]);

  const sendPermissionResponse = useCallback((requestId: string, response: 'once' | 'always' | 'reject') => {
    sendChatPermissionResponse(clientRef.current, requestId, response);
  }, [sendChatPermissionResponse, clientRef]);

  const sendQuestionReply = useCallback((requestId: string, answers: string[][]) => {
    sendChatQuestionReply(clientRef.current, requestId, answers);
  }, [sendChatQuestionReply, clientRef]);

  const sendQuestionReject = useCallback((requestId: string) => {
    sendChatQuestionReject(clientRef.current, requestId);
  }, [sendChatQuestionReject, clientRef]);

  // ── 上下文压缩状态 ──
  const [compressing, setCompressing] = useState(false);

  const compressSession = useCallback(async (): Promise<{ success: boolean }> => {
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
  }, [sendChatSummarize, currentSessionId, compressing, addLog, config.modelProvider, config.model,
    clientRef, activeLLMModelRef]);

  const newSession = useCallback(async () => {
    resetState();
    clearCurrentSession();

    // 模块差异：数据探索「新建会话 = 新建独立时间戳工作目录并切过去」（会话=标签页）；
    // 开发助手是固定目录，策略为空操作。
    await strategy.onNewSession();
  }, [resetState, clearCurrentSession, strategy]);

  const loadSession = useCallback(async (sessionId: string) => {
    if (!clientRef.current) {
      addLog({
        source: 'agent',
        text: 'AI 服务未连接，无法加载会话',
        timestamp: new Date(),
        level: 'error',
      });
      return;
    }
    resetState();
    const entries = await loadSessionRaw(clientRef.current, sessionId);
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
  }, [loadSessionRaw, resetState, setMessagesDirect, setTodos, addLog, clientRef]);

  const listSessions = useCallback(async () => {
    return listSessionsRaw(clientRef.current);
  }, [listSessionsRaw, clientRef]);

  /**
   * 删除会话（下拉框「任务历史」里那一行）。
   *
   * 顺序：**先本地、后服务端**——这是本函数唯一重要的约定：
   * 1) 任务列表的唯一事实来源是本地历史（sessionHistoryStore），所以本地删除同步落地，
   *    行立即从下拉框消失。不能等 session.delete 返回：该请求可能挂起（sidecar 忙）
   *    或失败，一等就把这一行永远留在列表里，用户表现就是「这条删不掉」。
   * 2) 服务端删除失败不回滚本地结果（用户意图是删掉这一行）；
   *    同时 removeTask 会给该 id 立墓碑，服务端仍持有该会话时也不会被播种复活。
   */
  const deleteSession = useCallback(async (sessionId: string) => {
    // 1) 本地立即生效（含墓碑），不等任何 await
    removeTask(sessionId);

    // 2) 模块差异：数据探索要撤掉「会话 ↔ 工作目录」映射并异步清理目录/标签页；
    //    开发助手无目录可清，策略为空操作。
    strategy.onSessionDeleted(sessionId);

    // 3) 删的是当前会话 → 清空当前会话（避免继续往已删会话发消息）
    if (sessionId === currentSessionId) clearCurrentSession();

    // 4) 服务端删除：不阻塞 UI、失败也不回滚
    deleteSessionRemote(sessionId);
  }, [removeTask, strategy, currentSessionId, clearCurrentSession, deleteSessionRemote]);

  /** 重命名任务（通过 SDK session.update 更新标题） */
  const renameTask = useCallback(async (sessionId: string, newTitle: string) => {
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    // 乐观更新（同时持久化到本地历史）
    updateTaskTitleLocal(sessionId, trimmed);
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
  }, [addLog, refreshTasks, updateTaskTitleLocal, clientRef]);

  return {
    sendMessage,
    sendInterrupt,
    sendRollback,
    sendPermissionResponse,
    sendQuestionReply,
    sendQuestionReject,
    compressSession,
    compressing,
    newSession,
    loadSession,
    listSessions,
    deleteSession,
    renameTask,
  };
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

/**
 * 组装对外实例：core（公共运行时）+ actions（会话动作）+ strategy.extras（模块特有字段）。
 * 返回形状必须与重构前完全一致 —— 界面层只依赖 OpencodeClientBackend。
 */
export function useOpencodeClientValue(
  core: OpencodeClientCore,
  strategy: WorkspaceStrategy,
  actions: OpencodeClientActions,
): OpencodeClientBackend {
  const { events, conn, review, history, logs, clearLogs, currentSessionParentID } = core;
  const {
    messages, busy, busyLabel, retry, modals, lastFileChangeSeq, lastFileChangePaths,
    todos, contextUsage, readPartText, subscribePartText,
  } = events;
  const { fileChanges, approveFileChange, rejectFileChange, approveAllFileChanges } = review;
  const { tasks } = history;
  const extras = strategy.extras;

  return useMemo(() => ({
    messages,
    busy,
    busyLabel,
    retry,
    ready: conn.ready,
    connected: conn.connected,
    error: conn.error,
    modals,
    logs,
    currentSessionId: core.currentSessionId,
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

    sendMessage: actions.sendMessage,
    sendInterrupt: actions.sendInterrupt,
    sendRollback: actions.sendRollback,
    sendPermissionResponse: actions.sendPermissionResponse,
    sendQuestionReply: actions.sendQuestionReply,
    sendQuestionReject: actions.sendQuestionReject,
    compressSession: actions.compressSession,
    compressing: actions.compressing,
    clearLogs,

    newSession: actions.newSession,
    loadSession: actions.loadSession,
    listSessions: actions.listSessions,
    deleteSession: actions.deleteSession,
    renameTask: actions.renameTask,

    start: conn.start,
    connect: conn.connect,
    disconnect: conn.disconnect,

    setWorkingDirectory: conn.setWorkingDirectory,
    currentDirectory: conn.currentDirectory,
    starting: conn.starting,
    setActiveLLMModel: core.setActiveLLMModel,
    activeLLMModel: core.activeLLMModel,
    taskType: core.taskType,
    setTaskType: core.setTaskType,
    client: conn.client,
    readPartText,
    subscribePartText,

    // 模块特有字段（数据探索：会话目录/标签页/任务文件）
    ...(extras ?? {}),
  }), [
    messages, busy, busyLabel, retry, conn.ready, conn.connected, conn.error, modals, logs,
    core.currentSessionId, core.activeLLMModel, core.taskType, core.setActiveLLMModel, core.setTaskType,
    currentSessionParentID, lastFileChangeSeq, lastFileChangePaths, todos, fileChanges, contextUsage, tasks,
    actions, clearLogs, extras,
    approveFileChange, rejectFileChange, approveAllFileChanges,
    conn.start, conn.connect, conn.disconnect, conn.setWorkingDirectory, conn.currentDirectory, conn.starting, conn.client,
    readPartText, subscribePartText,
  ]);
}
