/**
 * CompactionPartDisplay — 压缩 part 渲染
 *
 * 对齐 opencode 桌面版 CompactionPartDisplay（message-part.tsx 1477-1480 行）。
 * 仅渲染一条 MessageDivider（──── compaction ────），作为上下文压缩的分隔标记。
 */

import React from 'react';
import MessageDivider from './MessageDivider';
import type { MessagePartProps } from './ToolPartDisplay';

const CompactionPartDisplay: React.FC<MessagePartProps> = () => {
  return <MessageDivider label="compaction" />;
};

export default React.memo(CompactionPartDisplay);
