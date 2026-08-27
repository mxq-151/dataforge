/**
 * AIPanel — 智能体对话面板（主组件）
 *
 * 职责：组装所有子组件，提供完整的 AI 对话界面。
 * - SessionSwitcher: 任务历史切换 + 新建 + 重命名
 * - MessageTimeline: 虚拟化时间线消息列表（对齐桌面版 message-timeline）
 * - ChatInput: 输入区
 * - ContextUsageBar: token 使用量进度条
 * - TodoDock: Todo 计划面板（4 态状态机，对齐桌面版 session-todo-dock）
 * - PermissionDock: 权限请求 inline dock
 * - QuestionDock: AI 提问 inline dock
 *
 * 头部布局（从左到右）：
 *   任务历史 | 压缩按钮 | 上下文使用量
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { AlertCircle, Combine } from 'lucide-react';
import type { AIPanelProps } from './types';
import type { Session } from '../../types/opencode-backend';
import MessageTimeline from './timeline/MessageTimeline';
import ChatInput from './ChatInput';
import SessionSwitcher from './SessionSwitcher';
import PermissionDock from './PermissionDock';
import QuestionDock from './QuestionDock';
import ContextUsageBar from './ContextUsageBar';
import TodoDock from './TodoDock';
import { useTodoDockState } from './useTodoDockState';
import FileReviewPanel from './FileReviewPanel';
import './AIPanel.css';

const AIPanel: React.FC<AIPanelProps> = ({ chatBackend, llmModels, onRollback, onOpenFile, onViewDiff, fileTree, moduleId }) => {
  const {
    messages, busy, retry, connected, error, modals, currentSessionId,
    contextUsage, tasks, todos, fileChanges,
    sendMessage, sendInterrupt, sendRollback, sendPermissionResponse,
    sendQuestionReply, sendQuestionReject,
    compressSession, compressing,
    approveFileChange, rejectFileChange, approveAllFileChanges,
    newSession, loadSession, deleteSession, renameTask,
    setActiveLLMModel,
    taskType, setTaskType,
    client, readPartText, listSessions,
    currentDirectory,
  } = chatBackend;

  // ── blocked 状态（对齐桌面版 session-composer-state: blocked = permissionRequest || questionRequest） ──
  const permissionModal = modals.find(m => m.kind === 'permission');
  const questionModal = modals.find(m => m.kind === 'question');
  const blocked = modals.length > 0;

  // ── TodoDock 4 态状态机（对齐桌面版 session-composer-state） ──
  // live = busy 或被权限/问题请求阻塞
  const todoLive = busy || blocked;
  const todoDockState = useTodoDockState({
    todos: todos ?? [],
    live: todoLive,
    sessionID: currentSessionId ?? undefined,
  });

  // ── LLM 模型选择 ──
  // 默认选中第一个模型；当 llmModels 变化时，若当前选中已不存在则回退到第一个
  const models = llmModels ?? [];
  const [selectedLLMId, setSelectedLLMId] = useState<string | null>(
    models.length > 0 ? models[0].id : null
  );

  useEffect(() => {
    if (models.length === 0) {
      if (selectedLLMId !== null) setSelectedLLMId(null);
      return;
    }
    // 当前选中仍存在则保持
    if (selectedLLMId && models.some(m => m.id === selectedLLMId)) return;
    // 否则回退到第一个
    setSelectedLLMId(models[0].id);
  }, [models, selectedLLMId]);

  // 同步到 backend（驱动 sendMessage / compressSession 使用该模型）
  useEffect(() => {
    const selected = models.find(m => m.id === selectedLLMId) ?? null;
    if (selected) {
      setActiveLLMModel({ providerID: selected.providerID, modelID: selected.modelID });
    } else {
      setActiveLLMModel(null);
    }
  }, [selectedLLMId, models, setActiveLLMModel]);

  const handleLLMChange = useCallback((m: typeof models[number] | null) => {
    setSelectedLLMId(m ? m.id : null);
  }, []);

  // ── 任务类型切换：自动创建新对话 ──
  // 用户切换任务类型时，先更新 taskType（决定下一会话的系统指令），
  // 再 resetState 清空当前会话，下一次 sendMessage 会以新 taskType 创建会话。
  const handleTaskTypeChange = useCallback((newType: string) => {
    if (newType === taskType) return;
    setTaskType(newType);
    newSession();
  }, [taskType, setTaskType, newSession]);

  const [panelWidth, setPanelWidth] = useState(() => {
    const saved = localStorage.getItem('ai-panel-width');
    return saved ? parseInt(saved, 10) : 30;
  });
  const [isDragging, setIsDragging] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // ── 回滚后用户消息回显到输入框 ──
  // 仅当输入框为空时，将回滚目标用户消息的文本预填到输入框（nonce 触发 ChatInput effect）
  const [prefill, setPrefill] = useState<{ text: string; nonce: number }>({ text: '', nonce: 0 });

  // 回滚处理
  const handleRollback = useCallback(async (messageId: string) => {
    // 先回显用户消息文本到输入框（仅当输入框为空时生效）
    const entry = messages.find((e) => e.info.id === messageId);
    if (entry) {
      const text = entry.parts
        .filter((p) => p.type === 'text')
        .map((p) => (p as any).text ?? '')
        .join('\n');
      if (text) setPrefill({ text, nonce: Date.now() });
    }
    if (onRollback) {
      await onRollback(messageId);
    } else {
      await sendRollback(messageId);
    }
  }, [messages, onRollback, sendRollback]);

  // ── Task 工具跳转导航（对齐桌面版 navigateToSession + sessionHref） ──
  const navigateToSession = useCallback((sessionID: string) => {
    loadSession(sessionID);
  }, [loadSession]);

  // sessionHref：dataforge 是桌面应用无 session 路由，返回 undefined
  // TaskTool 将使用 navigateToSession 进行 SPA 跳转（不支持新窗口打开）
  const sessionHref = useCallback((_sessionID: string): string | undefined => undefined, []);

  // ── sessions 列表（供 TaskTool 回退匹配子 session） ──
  // 当 client 可用或消息数变化时刷新（task 工具执行后会产生新子 session）
  const [sessions, setSessions] = useState<Session[]>([]);
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    listSessions()
      .then((s) => {
        if (!cancelled) setSessions(s);
      })
      .catch(() => {
        // 拉取失败忽略，TaskTool 会走 metadata.sessionId 主路径
      });
    return () => {
      cancelled = true;
    };
  }, [client, messages.length, listSessions]);

  // 上下文压缩处理
  const handleCompress = useCallback(async () => {
    if (compressing) return;
    if (!currentSessionId) {
      return;
    }
    await compressSession();
  }, [compressSession, compressing, currentSessionId]);

  // 拖拽调整宽度
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    const startX = e.clientX;
    const startWidth = panelWidth;
    // 通过 ref 获取当前面板的父容器宽度作为分母。
    // 不能用 document.querySelector('.ai-panel-wrapper')：数据探索与开发助手两个模块
    // 都挂载了同名元素，querySelector 会命中另一个模块的元素，导致分母宽度错误、
    // 位移换算比例失真（边框移动速度与鼠标不一致）。
    const parentEl = wrapperRef.current?.parentElement;
    const refWidth = parentEl ? parentEl.getBoundingClientRect().width : window.innerWidth;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const dx = moveEvent.clientX - startX;
      const newWidth = startWidth + (dx / refWidth) * 100;
      const clamped = Math.max(20, Math.min(50, newWidth));
      setPanelWidth(clamped);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      localStorage.setItem('ai-panel-width', String(Math.round(panelWidth)));
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [panelWidth]);

  const canCompress = !!currentSessionId && !compressing && !!connected;

  return (
    <div ref={wrapperRef} className="ai-panel-wrapper" style={{ width: `${panelWidth}%` }}>
      <div className={`ai-panel ${isDragging ? 'ai-panel--dragging' : ''}`}>
        {/* 头部：任务历史 + LLM 选择 + 压缩按钮 + 上下文使用量 */}
        <div className="ai-panel__header">
          <SessionSwitcher
            currentSessionId={currentSessionId}
            tasks={tasks}
            onNewSession={newSession}
            onSwitchSession={loadSession}
            onDeleteSession={deleteSession}
            onRenameSession={renameTask}
            disabled={!connected}
          />
          <button
            className={`ai-panel__compress-btn ${compressing ? 'ai-panel__compress-btn--loading' : ''}`}
            onClick={handleCompress}
            disabled={!canCompress}
            title={
              !currentSessionId
                ? '请先选择或新建会话'
                : compressing
                  ? '正在压缩...'
                  : '压缩上下文'
            }
          >
            <Combine size={11} className={compressing ? 'ai-panel__compress-btn-icon--spin' : ''} />
            <span>压缩</span>
          </button>
          <ContextUsageBar usage={contextUsage} />
        </div>

        {/* 错误提示 */}
        {error && (
          <div className="ai-panel__error-banner">
            <AlertCircle size={14} />
            <span>{error}</span>
          </div>
        )}

        {/* 连接提示 */}
        {!connected && !error && (
          <div className="ai-panel__connect-prompt">
            <p>未连接到 AI 服务，请先配置并启动服务。</p>
          </div>
        )}

        {/* 消息列表（虚拟化时间线，对齐桌面版 message-timeline） */}
        <MessageTimeline
          messages={messages}
          status={busy ? (retry ? 'retry' : 'busy') : 'idle'}
          retry={retry}
          readPartText={readPartText}
          navigateToSession={navigateToSession}
          sessionHref={sessionHref}
          currentSessionID={currentSessionId ?? undefined}
          sessions={sessions}
          onRevert={handleRollback}
          revertDisabled={busy}
        />

        {/* 文件变更审查面板 */}
        {fileChanges.length > 0 && (
          <FileReviewPanel
            changes={fileChanges}
            onApprove={approveFileChange}
            onReject={rejectFileChange}
            onApproveAll={approveAllFileChanges}
            onOpenFile={onOpenFile}
            onViewDiff={onViewDiff}
          />
        )}

        {/* 输入区域（含 inline dock 栈，对齐桌面版 session-composer-region） */}
        <div className="ai-panel__input-region">
          {todoDockState.dock && (
            <TodoDock
              todos={todos}
              collapsed={todoDockState.collapsed}
              onToggle={todoDockState.toggle}
              closing={todoDockState.closing}
            />
          )}
          {questionModal && (
            <QuestionDock
              modal={questionModal}
              onSubmit={sendQuestionReply}
              onReject={sendQuestionReject}
            />
          )}
          {permissionModal && (
            <PermissionDock
              modal={permissionModal}
              onRespond={sendPermissionResponse}
            />
          )}
          {/* blocked 时隐藏 ChatInput（对齐桌面版 showComposer = !blocked） */}
          {!blocked && (
            <ChatInput
              busy={busy}
              onSend={sendMessage}
              onInterrupt={sendInterrupt}
              fileTree={fileTree}
              llmModels={models}
              selectedLLMId={selectedLLMId}
              onLLMChange={handleLLMChange}
              llmDisabled={!connected}
              taskType={taskType}
              onTaskTypeChange={handleTaskTypeChange}
              moduleId={moduleId}
              workspacePath={currentDirectory ?? undefined}
              prefill={prefill}
            />
          )}
        </div>
      </div>

      {/* 拖拽手柄 */}
      <div
        className={`ai-panel__resize-handle ${isDragging ? 'ai-panel__resize-handle--active' : ''}`}
        onMouseDown={handleMouseDown}
      />
    </div>
  );
};

export default AIPanel;
