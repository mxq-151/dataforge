/**
 * PartsDataContext — Part 渲染层数据上下文
 *
 * 对齐 opencode 桌面版 useData（session-ui/src/context/data.tsx）。
 * 提供导航回调、会话链接生成、当前会话信息、流式文本读取等，
 * 供 ToolPartDisplay / TaskTool / TextPartDisplay 等组件消费。
 *
 * 桌面版通过 SolidJS Context 注入；dataforge 用 React Context 适配。
 */

import React, { createContext, useContext } from 'react';
import type { Part, Session } from '../../../types/opencode-backend';

// ── 上下文值类型 ───────────────────────────────────────────────

export interface PartsDataValue {
  /** 跳转到子 session（task 工具点击行为） */
  navigateToSession?: (sessionID: string) => void;
  /** 生成 session 链接（用于 triggerHref，支持 Cmd/中键新窗口） */
  sessionHref?: (sessionID: string) => string | undefined;
  /** 当前 session ID（用于 task 工具的 taskSession 回退匹配） */
  currentSessionID?: string;
  /** 全部 session 列表（用于 task 工具的 taskSession 回退匹配） */
  sessions?: Session[];
  /** 读取 part 流式文本（优先 accumDelta 累积值，fallback 到 part.text） */
  readPartText?: (partID: string, part: Part) => string;
}

const PartsDataContext = createContext<PartsDataValue>({});

// ── Provider ──────────────────────────────────────────────────

export interface PartsDataProviderProps extends PartsDataValue {
  children: React.ReactNode;
}

export const PartsDataProvider: React.FC<PartsDataProviderProps> = ({
  navigateToSession,
  sessionHref,
  currentSessionID,
  sessions,
  readPartText,
  children,
}) => {
  const value = React.useMemo<PartsDataValue>(
    () => ({ navigateToSession, sessionHref, currentSessionID, sessions, readPartText }),
    [navigateToSession, sessionHref, currentSessionID, sessions, readPartText],
  );
  return <PartsDataContext.Provider value={value}>{children}</PartsDataContext.Provider>;
};

// ── usePartsData hook ─────────────────────────────────────────

export function usePartsData(): PartsDataValue {
  return useContext(PartsDataContext);
}

export default PartsDataContext;
