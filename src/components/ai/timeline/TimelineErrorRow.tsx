/**
 * TimelineErrorRow — Error 行
 *
 * 对齐 opencode 桌面版 Error 行渲染（message-timeline.tsx）。
 * turn 级别的错误（非工具错误）展示为红色错误卡片。
 */

import React from 'react';

export interface TimelineErrorRowProps {
  /** 错误文本 */
  text: string;
}

const TimelineErrorRow: React.FC<TimelineErrorRowProps> = ({ text }) => {
  return (
    <div className="ai-panel__timeline-error" data-timeline-row="Error">
      <div className="ai-panel__timeline-error-icon" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.5" />
          <path d="M7 4v3M7 9.5v0.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </div>
      <span className="ai-panel__timeline-error-badge">错误</span>
      <div className="ai-panel__timeline-error-body">
        <pre className="ai-panel__timeline-error-text">{text}</pre>
      </div>
    </div>
  );
};

export default React.memo(TimelineErrorRow);
