/**
 * TodoDock — 输入框上方的 Todo 计划面板
 *
 * 对齐 opencode 桌面版 SessionTodoDock（session-todo-dock.tsx）：
 * - 折叠头使用 CollapsibleHeader（<div role="button">，避免 button 嵌套 hydration 错误）
 * - 进度文本 {done}/{total}
 * - in_progress: SVG circle 脉冲动画（对齐桌面版 dot() 函数 + pulse-scale keyframes）
 * - completed: 勾选图标 + 删除线弱化；pending: 低透明度
 * - 折叠时显示当前激活任务预览（优先级 in_progress > pending > 最后 completed > 首个）
 *
 * 可见性由 useTodoDockState 的 4 态状态机控制（hide/clear/open/close），
 * AIPanel 根据 dock 状态决定是否渲染本组件。
 */

import React, { useMemo } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, Circle } from 'lucide-react';
import CollapsibleHeader from './parts/CollapsibleHeader';
import type { Todo } from '../../types/opencode-backend';

interface TodoDockProps {
  /** todo 列表 */
  todos: Todo[];
  /** 是否折叠 */
  collapsed: boolean;
  /** 切换折叠 */
  onToggle: () => void;
  /** 是否正在关闭中（close 延迟期间，用于过渡样式） */
  closing?: boolean;
}

/** in_progress SVG circle 脉冲（对齐桌面版 dot() 函数） */
function InProgressDot() {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" fill="currentColor" className="ai-panel__todo-dot">
      <circle
        cx="6"
        cy="6"
        r="3"
        style={{
          animation: 'pulse-scale 1.2s ease-in-out infinite',
          transformOrigin: 'center',
          transformBox: 'fill-box',
        }}
      />
    </svg>
  );
}

const TodoDock: React.FC<TodoDockProps> = ({ todos, collapsed, onToggle, closing }) => {
  const total = todos.length;
  const done = useMemo(() => todos.filter((t) => t.status === 'completed').length, [todos]);

  // 当前活跃项预览（优先级对齐桌面版 active() memo）
  const active = useMemo(() => {
    const completed = todos.filter((t) => t.status === 'completed');
    return (
      todos.find((t) => t.status === 'in_progress') ??
      todos.find((t) => t.status === 'pending') ??
      (completed.length > 0 ? completed[completed.length - 1] : undefined) ??
      todos[0]
    );
  }, [todos]);

  if (total === 0) return null;

  return (
    <div className={`ai-panel__todo-dock ${closing ? 'ai-panel__todo-dock--closing' : ''}`}>
      <CollapsibleHeader open={!collapsed} onToggle={() => onToggle()} showArrow={false}>
        <span className="ai-panel__todo-dock-chevron">
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </span>
        <span className="ai-panel__todo-dock-progress">
          <CheckCircle2 size={12} className="ai-panel__todo-dock-progress-icon" />
          <span className="ai-panel__todo-dock-progress-text">
            {done}/{total}
          </span>
        </span>
        {collapsed && active && (
          <span className="ai-panel__todo-dock-preview">{active.content}</span>
        )}
      </CollapsibleHeader>

      {!collapsed && (
        <div className="ai-panel__todo-dock-list">
          {todos.map((todo, idx) => (
            <TodoItem key={idx} todo={todo} />
          ))}
        </div>
      )}
    </div>
  );
};

const TodoItem: React.FC<{ todo: Todo }> = ({ todo }) => {
  const isCompleted = todo.status === 'completed';
  const isInProgress = todo.status === 'in_progress';
  const isCancelled = todo.status === 'cancelled';

  return (
    <div className={`ai-panel__todo-item ai-panel__todo-item--${todo.status}`}>
      <span className="ai-panel__todo-item-check">
        {isCompleted ? (
          <CheckCircle2 size={14} className="ai-panel__todo-item-check--done" />
        ) : isInProgress ? (
          <InProgressDot />
        ) : (
          <Circle size={14} className="ai-panel__todo-item-check--pending" />
        )}
      </span>
      <span
        className={`ai-panel__todo-item-content ${
          isCompleted || isCancelled ? 'ai-panel__todo-item-content--done' : ''
        } ${todo.status === 'pending' ? 'ai-panel__todo-item-content--pending' : ''}`}
      >
        {todo.content}
      </span>
    </div>
  );
};

export default React.memo(TodoDock);
