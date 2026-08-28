/**
 * SessionSwitcher — 任务历史切换器
 *
 * 从本地 localStorage 加载任务列表（任务名称 ↔ session id），
 * 用户选中任务后通过 session id 从 OpenCode 加载对话内容回显。
 */

import React, { useState, useCallback, useEffect, useLayoutEffect, useRef, useMemo } from 'react';
import { ChevronDown, Plus, Trash2, MessageSquare, Pencil, Check, X } from 'lucide-react';
import type { TaskRecord } from '../../hooks/opencode/useOpencodeClient';

/** 数据探索：任务（用户对话）→ 工作目录 SQL 文件（供下拉勾选打开，仅已关联会话） */
export interface DataExploreTaskFile {
  sessionId: string;
  dir: string;
  filePath: string;
  title: string;
}

interface SessionSwitcherProps {
  currentSessionId: string | null;
  tasks: TaskRecord[];
  onNewSession: () => Promise<void>;
  onSwitchSession: (sessionId: string) => Promise<void>;
  onDeleteSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, newTitle: string) => void;
  /** 未连接时禁用交互（防止服务未就绪时选中会话导致静默失败） */
  disabled?: boolean;
  /** 数据探索：已打开的文件标签目录列表（用于判断勾选状态） */
  dataExploreDirs?: Array<{ dir: string; filePath: string }>;
  /** 数据探索：任务下拉可勾选打开的文件（仅 data-explore 模块注入） */
  dataExploreTaskFiles?: DataExploreTaskFile[];
  /** 数据探索：勾选/取消勾选任务 → 打开/关闭对应文件（与 AI 对话无关） */
  dataExploreToggleSession?: (sessionId: string) => void;
}

const SessionSwitcher: React.FC<SessionSwitcherProps> = ({
  currentSessionId,
  tasks,
  onNewSession,
  onSwitchSession,
  onDeleteSession,
  onRenameSession,
  disabled = false,
  dataExploreDirs,
  dataExploreTaskFiles,
  dataExploreToggleSession,
}) => {
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number } | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
        setEditingId(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // 计算下拉框位置：使用 fixed 定位，避免被 .ai-panel 的 overflow:hidden 裁剪
  // （当智能体面板宽度小于下拉框 min-width 时，absolute 定位会导致下拉框溢出面板右边界被遮挡）
  useLayoutEffect(() => {
    if (!open || !buttonRef.current) {
      setDropdownPos(null);
      return;
    }
    const rect = buttonRef.current.getBoundingClientRect();
    const DROPDOWN_WIDTH = 260;
    const MARGIN = 4;
    const VIEWPORT_PAD = 8;
    let left = rect.left;
    // 若右侧溢出视口，则向左偏移以保证完整显示
    if (left + DROPDOWN_WIDTH > window.innerWidth - VIEWPORT_PAD) {
      left = Math.max(VIEWPORT_PAD, window.innerWidth - DROPDOWN_WIDTH - VIEWPORT_PAD);
    }
    setDropdownPos({ top: rect.bottom + MARGIN, left });
  }, [open]);

  // 视口尺寸变化或滚动时关闭下拉，避免定位错乱
  useEffect(() => {
    if (!open) return;
    const handleClose = () => {
      setOpen(false);
      setEditingId(null);
    };
    window.addEventListener('resize', handleClose);
    window.addEventListener('scroll', handleClose, true);
    return () => {
      window.removeEventListener('resize', handleClose);
      window.removeEventListener('scroll', handleClose, true);
    };
  }, [open]);

  // 编辑时自动聚焦
  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  const currentTask = tasks.find(t => t.sessionId === currentSessionId);
  const displayTitle = currentTask?.title || '请选择对话';

  const handleSwitch = useCallback(async (sessionId: string) => {
    setOpen(false);
    await onSwitchSession(sessionId);
  }, [onSwitchSession]);

  const handleNew = useCallback(async () => {
    setOpen(false);
    await onNewSession();
  }, [onNewSession]);

  const handleDelete = useCallback((e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    onDeleteSession(sessionId);
  }, [onDeleteSession]);

  const handleStartRename = useCallback((e: React.MouseEvent, task: TaskRecord) => {
    e.stopPropagation();
    setEditingId(task.sessionId);
    setEditText(task.title);
  }, []);

  const handleConfirmRename = useCallback(() => {
    if (editingId && editText.trim()) {
      onRenameSession(editingId, editText.trim());
    }
    setEditingId(null);
    setEditText('');
  }, [editingId, editText, onRenameSession]);

  const handleCancelRename = useCallback(() => {
    setEditingId(null);
    setEditText('');
  }, []);

  const handleEditKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleConfirmRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleCancelRename();
    }
  }, [handleConfirmRename, handleCancelRename]);

  /** 格式化时间戳为可读字符串 */
  const formatTime = (ts: number): string => {
    const date = new Date(ts);
    const now = new Date();
    const diff = now.getTime() - ts;
    if (diff < 60_000) return '刚刚';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (date.toDateString() === now.toDateString()) {
      return `今天 ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
    }
    return `${date.getMonth() + 1}/${date.getDate()} ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
  };

  // ── 数据探索：任务 → 文件勾选（仅 data-explore 生效，与 AI 对话无关） ──
  const deTaskFileMap = useMemo(() => {
    const m = new Map<string, DataExploreTaskFile>();
    (dataExploreTaskFiles ?? []).forEach(tf => m.set(tf.sessionId, tf));
    return m;
  }, [dataExploreTaskFiles]);
  const openDeDirs = useMemo(() => new Set((dataExploreDirs ?? []).map(d => d.dir)), [dataExploreDirs]);
  const handleToggleFile = useCallback((e: React.MouseEvent, taskFile: DataExploreTaskFile | undefined) => {
    e.stopPropagation();
    if (taskFile) dataExploreToggleSession?.(taskFile.sessionId);
  }, [dataExploreToggleSession]);

  return (
    <div className="ai-panel__session-switcher" ref={dropdownRef}>
      <button
        ref={buttonRef}
        className="ai-panel__session-btn"
        onClick={() => setOpen(prev => !prev)}
        title={disabled ? 'AI 服务未连接，请稍候' : '切换任务'}
        disabled={disabled}
      >
        <MessageSquare size={10} />
        <span className="ai-panel__session-title">{displayTitle}</span>
        <ChevronDown size={10} className={`ai-panel__session-chevron ${open ? 'ai-panel__session-chevron--open' : ''}`} />
      </button>

      {/* 常驻的"新建会话"按钮 */}
      <button
        className="ai-panel__session-quick-new-btn"
        onClick={handleNew}
        title={disabled ? 'AI 服务未连接，请稍候' : '新建会话'}
        disabled={disabled}
      >
        <Plus size={11} />
      </button>

      {open && dropdownPos && (
        <div
          className="ai-panel__session-dropdown"
          style={{ position: 'fixed', top: `${dropdownPos.top}px`, left: `${dropdownPos.left}px` }}
        >
          <div className="ai-panel__session-dropdown-header">
            <span>任务历史</span>
          </div>
          <button className="ai-panel__session-new-btn" onClick={handleNew}>
            <Plus size={14} />
            <span>新建会话</span>
          </button>
          <div className="ai-panel__session-list">
            {tasks.length === 0 && (
              <div className="ai-panel__session-empty">暂无历史任务</div>
            )}
            {tasks.map(task => {
              const taskFile = deTaskFileMap.get(task.sessionId);
              const deMode = !!dataExploreTaskFiles;
              const checked = !!taskFile && openDeDirs.has(taskFile.dir);
              return (
                <div
                  key={task.sessionId}
                  className={`ai-panel__session-item ${task.sessionId === currentSessionId ? 'ai-panel__session-item--active' : ''}`}
                  onClick={() => editingId !== task.sessionId && handleSwitch(task.sessionId)}
                >
                  {deMode && taskFile && (
                    <span
                      className={`ai-panel__session-check ${checked ? 'ai-panel__session-check--checked' : ''}`}
                      onClick={e => handleToggleFile(e, taskFile)}
                      title={checked ? '已打开：点击关闭文件' : '点击打开文件'}
                    >
                      {checked ? <Check size={12} /> : null}
                    </span>
                  )}
                  <MessageSquare size={14} className="ai-panel__session-item-icon" />
                  {editingId === task.sessionId ? (
                    <div className="ai-panel__session-item-edit">
                      <input
                        ref={editInputRef}
                        className="ai-panel__session-edit-input"
                        value={editText}
                        onChange={e => setEditText(e.target.value)}
                        onKeyDown={handleEditKeyDown}
                        onClick={e => e.stopPropagation()}
                      />
                      <button
                        className="ai-panel__session-edit-confirm"
                        onClick={e => { e.stopPropagation(); handleConfirmRename(); }}
                        title="确认"
                      >
                        <Check size={12} />
                      </button>
                      <button
                        className="ai-panel__session-edit-cancel"
                        onClick={e => { e.stopPropagation(); handleCancelRename(); }}
                        title="取消"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ) : (
                    <>
                      <span className="ai-panel__session-item-title">
                        {task.title}
                      </span>
                      <span className="ai-panel__session-item-time">
                        {formatTime(task.updatedAt)}
                      </span>
                      <button
                        className="ai-panel__session-rename-btn"
                        onClick={e => handleStartRename(e, task)}
                        title="重命名"
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        className="ai-panel__session-delete-btn"
                        onClick={e => handleDelete(e, task.sessionId)}
                        title="删除"
                      >
                        <Trash2 size={12} />
                      </button>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

export default React.memo(SessionSwitcher);
