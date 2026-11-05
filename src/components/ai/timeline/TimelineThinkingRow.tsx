/**
 * TimelineThinkingRow — Thinking 行
 *
 * 对齐 opencode 桌面版 Thinking 行渲染（message-timeline.tsx）。
 * busy 且无可见 part 时显示 "Thinking…" 闪烁 + reasoning 标题预览。
 */

import React from 'react';
import TextShimmer from '../parts/TextShimmer';

export interface TimelineThinkingRowProps {
  /** reasoning 首个标题（预览用） */
  reasoningHeading?: string;
}

const TimelineThinkingRow: React.FC<TimelineThinkingRowProps> = ({ reasoningHeading }) => {
  return (
    <div className="ai-panel__timeline-thinking" data-timeline-row="Thinking">
      <span className="ai-panel__timeline-thinking-label">
        <TextShimmer text="Thinking…" active />
      </span>
      {reasoningHeading && (
        <span className="ai-panel__timeline-thinking-heading">{reasoningHeading}</span>
      )}
    </div>
  );
};

export default React.memo(TimelineThinkingRow);
