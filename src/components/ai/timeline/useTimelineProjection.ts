/**
 * useTimelineProjection — React 适配的 turn-based 行投影 hook
 *
 * 对齐 opencode 桌面版 projection.ts 的 createTimelineProjection，
 * 适配 React 的 useMemo 模式（替代 SolidJS createMemo）。
 *
 * 输入：messages + status 状态 + showReasoning
 * 输出：rows（TimelineRow[]）+ rowByKey + messageLastRowIndex + activeMessageID
 */

import { useMemo, useRef } from 'react';
import type { Part, SessionStatus, UserMessage } from '@opencode-ai/sdk/v2/client';
import type { MessageEntry } from '../../../types/opencode-backend';
import {
  constructMessageRows,
  reuseTimelineRows,
  assistantMessagesByParent,
  activeMessageID,
} from './projection';
import { rowKey, type TimelineRow } from './rows';

export interface UseTimelineProjectionResult {
  rows: TimelineRow[];
  rowByKey: Map<string, TimelineRow>;
  messageLastRowIndex: Map<string, number>;
  activeMessageID: string | undefined;
}

/**
 * @param messages 消息列表（MessageEntry[]）
 * @param status 会话状态类型（'idle' | 'busy' | 'retry'），对齐 SDK v2 SessionStatus
 * @param showReasoning 是否显示 reasoning
 * @param revertMessageID 可选，回滚到该消息（截断后续 user messages）
 */
export function useTimelineProjection(
  messages: MessageEntry[],
  status: SessionStatus['type'],
  showReasoning: boolean,
  revertMessageID?: string,
): UseTimelineProjectionResult {
  // 引用上一轮 rows，用于 reuseTimelineRows 引用复用
  const previousRowsRef = useRef<TimelineRow[] | undefined>(undefined);

  const result = useMemo(() => {
    // 构建 messageID → parts 查找表
    const partsByMessageID = new Map<string, Part[]>();
    for (const entry of messages) {
      partsByMessageID.set(entry.info.id, entry.parts);
    }
    const getMessageParts = (messageID: string): Part[] =>
      partsByMessageID.get(messageID) ?? [];

    // 过滤 user messages（类型守卫将 Message 收窄为 UserMessage）
    const userMessages = messages
      .map((entry) => entry.info)
      .filter((info): info is UserMessage => info.role === 'user');

    // 按 revertMessageID 截断
    let visibleUserMessages = userMessages;
    if (revertMessageID) {
      const revertIdx = userMessages.findIndex((m) => m.id === revertMessageID);
      if (revertIdx >= 0) {
        visibleUserMessages = userMessages.slice(0, revertIdx + 1);
      }
    }

    // 按 parentID 分组 assistant 消息
    const assistantMap = assistantMessagesByParent(messages);

    // 找活跃 turn
    const active = activeMessageID(messages, status);

    // 对每个 user message 构造行
    let newRows: TimelineRow[] = [];
    visibleUserMessages.forEach((userMessage, index) => {
      const assistantMessages = assistantMap.get(userMessage.id) ?? [];
      const isActive = active === userMessage.id;
      const rowsForMessage = constructMessageRows(
        userMessage,
        getMessageParts,
        assistantMessages,
        index,
        showReasoning,
        status,
        isActive,
      );
      newRows.push(...rowsForMessage);
    });

    // 引用复用优化
    newRows = reuseTimelineRows(previousRowsRef.current, newRows);
    previousRowsRef.current = newRows;

    // 构建 rowByKey 和 messageLastRowIndex
    const rowByKey = new Map<string, TimelineRow>();
    const messageLastRowIndex = new Map<string, number>();
    newRows.forEach((row, index) => {
      rowByKey.set(rowKey(row), row);
      if ('userMessageID' in row) {
        messageLastRowIndex.set(row.userMessageID, index);
      }
    });

    return {
      rows: newRows,
      rowByKey,
      messageLastRowIndex,
      activeMessageID: active,
    };
  }, [messages, status, showReasoning, revertMessageID]);

  return result;
}
