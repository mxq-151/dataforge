/**
 * useTodoDockState — TodoDock 3 态状态机 hook
 *
 * 状态机：
 * - hide: count=0，完全隐藏
 * - open: 有 todo 未完成，显示
 * - done: 所有 todo 已完成，保持显示（不自动隐藏）
 *
 * collapsed 按 session 持久化。
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import type { Todo } from '../../types/opencode-backend';

export type TodoDockState = 'hide' | 'open' | 'done';

/** 状态机纯函数 */
export function todoState(input: {
  count: number;
  done: boolean;
  live: boolean;
}): TodoDockState {
  if (input.count === 0) return 'hide';
  if (!input.done) return 'open';
  return 'done';
}

export interface UseTodoDockStateOptions {
  /** todo 列表 */
  todos: Todo[];
  /** 会话是否活跃（保留接口兼容，当前不影响状态机） */
  live: boolean;
  /** 当前 session ID（用于 per-session collapsed 持久化） */
  sessionID?: string;
  /** close 延迟毫秒（保留接口兼容，当前未使用） */
  closeMs?: number;
}

export interface UseTodoDockStateResult {
  /** dock 是否可见（状态机控制） */
  dock: boolean;
  /** 是否正在关闭中（保留接口，始终为 false） */
  closing: boolean;
  /** 是否折叠（per-session 持久化） */
  collapsed: boolean;
  /** 切换折叠 */
  toggle: () => void;
  /** 当前状态 */
  state: TodoDockState;
}

const COLLAPSED_STORAGE_KEY = 'ai-todo-collapsed';

function loadCollapsedMap(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSED_STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

export function useTodoDockState({
  todos,
  live,
  sessionID,
  closeMs: _closeMs,
}: UseTodoDockStateOptions): UseTodoDockStateResult {
  const [dock, setDock] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);
  const prevSessionRef = useRef<string | undefined>(sessionID);

  // collapsed per-session 持久化
  const [collapsedMap, setCollapsedMap] = useState<Record<string, boolean>>(loadCollapsedMap);
  const collapsed = collapsedMap[sessionID ?? ''] ?? true;
  const toggle = useCallback(() => {
    setCollapsedMap((prev) => {
      const key = sessionID ?? '';
      const next = { ...prev, [key]: !prev[key] };
      try {
        localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // localStorage 不可用时忽略
      }
      return next;
    });
  }, [sessionID]);

  // 计算状态机输入
  const count = todos.length;
  const done =
    count > 0 && todos.every((t) => t.status === 'completed' || t.status === 'cancelled');
  const state = todoState({ count, done, live });

  useEffect(() => {
    // session 切换 → 重置
    if (prevSessionRef.current !== sessionID) {
      prevSessionRef.current = sessionID;
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
        timerRef.current = undefined;
      }
      setDock(state === 'open' || state === 'done');
      return;
    }

    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }

    if (state === 'hide') {
      setDock(false);
      return;
    }

    // open 或 done：保持显示
    setDock(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, sessionID]);

  // 卸载时清理 timer
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  return { dock, closing: false, collapsed, toggle, state };
}
