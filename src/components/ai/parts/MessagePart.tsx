/**
 * MessagePart — Part 渲染分发
 *
 * 对齐 opencode 桌面版 Part 组件（message-part.tsx 1272-1292 行）+ PART_MAPPING。
 *
 * 按 part.type 查表分发：
 * - tool → ToolPartDisplay
 * - text → TextPartDisplay
 * - reasoning → ReasoningPartDisplay
 * - compaction → CompactionPartDisplay
 *
 * 未注册的 part type（snapshot/patch/subtask/step-start/step-finish/retry/file/agent）
 * 不渲染（renderable 已过滤，此处返回 null）。
 */

import React from 'react';
import ToolPartDisplay, { type MessagePartProps } from './ToolPartDisplay';
import TextPartDisplay from './TextPartDisplay';
import ReasoningPartDisplay from './ReasoningPartDisplay';
import CompactionPartDisplay from './CompactionPartDisplay';

// ── PART_MAPPING：part.type → 渲染组件 ─────────────────────────

const PART_MAPPING: Record<string, React.FC<MessagePartProps> | undefined> = {
  tool: ToolPartDisplay,
  text: TextPartDisplay,
  reasoning: ReasoningPartDisplay,
  compaction: CompactionPartDisplay,
};

// ── MessagePart 分发组件 ──────────────────────────────────────

const MessagePart: React.FC<MessagePartProps> = (props) => {
  const Component = PART_MAPPING[props.part.type];
  if (!Component) return null;
  return <Component {...props} />;
};

export default React.memo(MessagePart);

// 重新导出 MessagePartProps 供 timeline 层使用
export type { MessagePartProps };
