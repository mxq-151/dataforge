/**
 * PartsDataContext — Part 渲染层数据上下文
 *
 * 对齐 opencode 桌面版 useData（session-ui/src/context/data.tsx）。
 * 提供会话读取、当前会话信息、流式文本读取等，
 * 供 ToolPartDisplay / TaskTool / TextPartDisplay 等组件消费。
 *
 * 桌面版通过 SolidJS Context 注入；dataforge 用 React Context 适配。
 */

import React, { createContext, useContext } from 'react';
import type { Part, Session, MessageEntry } from '../../../types/opencode-backend';

// ── 上下文值类型 ───────────────────────────────────────────────

export interface PartsDataValue {
  /** 只读读取指定会话的消息（task 工具内联展开子代理对话用，不切换当前会话） */
  loadSessionMessages?: (sessionID: string) => Promise<MessageEntry[]>;
  /** 当前 session ID（用于 task 工具的 taskSession 回退匹配） */
  currentSessionID?: string;
  /** 全部 session 列表（用于 task 工具的 taskSession 回退匹配） */
  sessions?: Session[];
  /** 读取 part 流式文本（优先 accumDelta 累积值，fallback 到 part.text） */
  readPartText?: (partID: string, part: Part) => string;
  /**
   * 订阅指定 part 的流式文本变化，返回取消订阅函数。
   * 流式 part 用它把逐字增长的重渲染限制在自身，避免整棵时间线跟着刷新。
   */
  subscribePartText?: (partID: string, listener: () => void) => () => void;
}

const PartsDataContext = createContext<PartsDataValue>({});

// ── Provider ──────────────────────────────────────────────────

export interface PartsDataProviderProps extends PartsDataValue {
  children: React.ReactNode;
}

export const PartsDataProvider: React.FC<PartsDataProviderProps> = ({
  loadSessionMessages,
  currentSessionID,
  sessions,
  readPartText,
  subscribePartText,
  children,
}) => {
  const value = React.useMemo<PartsDataValue>(
    () => ({ loadSessionMessages, currentSessionID, sessions, readPartText, subscribePartText }),
    [loadSessionMessages, currentSessionID, sessions, readPartText, subscribePartText],
  );
  return <PartsDataContext.Provider value={value}>{children}</PartsDataContext.Provider>;
};

// ── usePartsData hook ─────────────────────────────────────────

export function usePartsData(): PartsDataValue {
  return useContext(PartsDataContext);
}

export default PartsDataContext;
