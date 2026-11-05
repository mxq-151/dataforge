/**
 * TimelineRowFrame — 时间线行外壳
 *
 * 对齐 opencode 桌面版 TimelineRowFrame（message-timeline.tsx 977-1004 行）。
 * 提供统一的 data 属性、锚点 id、居中布局、previousAssistantPart 间距。
 */

import React from 'react';
import type { TimelineRow } from './rows';

export interface TimelineRowFrameProps {
  row: TimelineRow;
  children: React.ReactNode;
  className?: string;
}

const TimelineRowFrame: React.FC<TimelineRowFrameProps> = ({ row, children, className = '' }) => {
  const isAnchor = row._tag === 'UserMessage' && row.anchor;
  const previousAssistantPart = row._tag === 'AssistantPart' && row.previousAssistantPart;
  const userMessageID = 'userMessageID' in row ? row.userMessageID : undefined;

  return (
    <div
      id={isAnchor && userMessageID ? `message-${userMessageID}` : undefined}
      data-message-id={userMessageID}
      data-timeline-row={row._tag}
      className={`ai-panel__timeline-row ${previousAssistantPart ? 'ai-panel__timeline-row--gap' : ''} ${className}`.trim()}
    >
      {children}
    </div>
  );
};

export default React.memo(TimelineRowFrame);
