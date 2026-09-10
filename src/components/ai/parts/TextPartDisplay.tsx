/**
 * TextPartDisplay — 文本 part 渲染
 *
 * 对齐 opencode 桌面版 TextPartDisplay（message-part.tsx 1482-1593 行）。
 *
 * 功能：
 * - streaming 判断：assistant 且 time.completed 未定义
 * - text 来源：readPartText(part.id, part)（优先 accumDelta 流式累积值）
 * - 流式用 PacedMarkdown（24ms 打字机），非流式用 ReactMarkdown
 * - meta：agent · model · duration · interrupted（用 " · " 连接）
 */

import React, { useMemo, useCallback, useSyncExternalStore } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import PacedMarkdown from './PacedMarkdown';
import { markdownComponents } from './markdownComponents';
import { usePartsData } from './PartsDataContext';
import type { TextPart, AssistantMessage, Message } from '../../../types/opencode-backend';
import type { MessagePartProps } from './ToolPartDisplay';

// 模块级常量：避免每次渲染创建新数组导致 ReactMarkdown 重新处理
const REMARK_PLUGINS = [remarkGfm];

// 无订阅能力时的占位退订函数（保持引用稳定，避免 useSyncExternalStore 反复重订阅）
const NOOP_UNSUBSCRIBE = () => { /* noop */ };

// ── duration 格式化 ───────────────────────────────────────────

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes} minute${minutes === 1 ? '' : 's'} ${rest} second${rest === 1 ? '' : 's'}`;
}

/** Agent 名称首字母大写 */
function capitalizeAgent(name: string | undefined): string | undefined {
  if (!name) return undefined;
  return name[0].toUpperCase() + name.slice(1);
}

// ── TextPartDisplay 组件 ──────────────────────────────────────

const TextPartDisplay: React.FC<MessagePartProps> = ({ part, message, turnDurationMs }) => {
  const textPart = part as TextPart;
  const { readPartText, subscribePartText } = usePartsData();

  // streaming：assistant 且未完成
  const streaming = useMemo(() => {
    if (message.role !== 'assistant') return false;
    const assistantMsg = message as AssistantMessage;
    return typeof assistantMsg.time.completed !== 'number';
  }, [message]);

  // ── text 来源：part 级订阅 ──
  // 逐字增长的流式文本不再经由 messages 状态广播（那会让整棵时间线每次重算），
  // 而是直接订阅本 part 的文本变化：只有这一个组件随打字机节奏重渲染。
  // 流式结束后 accumDelta 被清理，readPartText 自动回退到完整的 part.text。
  const streamID = textPart.id;
  const subscribe = useCallback(
    (onChange: () => void) => subscribePartText?.(streamID, onChange) ?? NOOP_UNSUBSCRIBE,
    [subscribePartText, streamID],
  );
  const getText = useCallback(
    () => readPartText?.(streamID, textPart) ?? (textPart as any).text ?? '',
    [readPartText, streamID, textPart],
  );
  const text = useSyncExternalStore(subscribe, getText, getText);

  // meta 信息：agent · model · duration · interrupted
  const meta = useMemo(() => {
    if (message.role !== 'assistant') return undefined;
    const assistantMsg = message as AssistantMessage;
    const parts: string[] = [];

    const agent = capitalizeAgent(assistantMsg.agent);
    if (agent) parts.push(agent);

    if (assistantMsg.modelID) parts.push(assistantMsg.modelID);

    // duration
    const durationMs =
      typeof turnDurationMs === 'number'
        ? turnDurationMs
        : typeof assistantMsg.time.completed === 'number' && typeof assistantMsg.time.created === 'number'
          ? assistantMsg.time.completed - assistantMsg.time.created
          : undefined;
    if (typeof durationMs === 'number' && durationMs > 0) {
      parts.push(formatDuration(durationMs));
    }

    // interrupted
    if (assistantMsg.error?.name === 'MessageAbortedError') {
      parts.push('Interrupted');
    }

    return parts.length > 0 ? parts.join(' · ') : undefined;
  }, [message, turnDurationMs]);

  if (!text) return null;

  return (
    <div className="ai-panel__text-part" data-timeline-part-id={textPart.id}>
      {streaming ? (
        <PacedMarkdown text={text} cacheKey={textPart.id} streaming={streaming} />
      ) : (
        <div className="ai-panel__markdown" key={textPart.id}>
          <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={markdownComponents}>{text}</ReactMarkdown>
        </div>
      )}
      {meta && (
        <div className="ai-panel__text-part-meta-row">
          <span className="ai-panel__type-badge ai-panel__type-badge--text">回答</span>
          <span className="ai-panel__text-part-meta">{meta}</span>
        </div>
      )}
    </div>
  );
};

export default React.memo(TextPartDisplay);

// 导出 Message 类型供其他组件使用
export type { Message };
