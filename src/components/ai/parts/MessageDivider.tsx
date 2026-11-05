/**
 * MessageDivider — 横线-文字-横线分隔线
 *
 * 对齐 opencode 桌面版 MessageDivider 组件。
 * 用于 compaction / interrupted 等 turn 内部分隔。
 *
 * 示例：──── compaction ────
 */

import React from 'react';

export interface MessageDividerProps {
  /** 分隔线中央的文字标签 */
  label: string;
  /** 额外 className */
  className?: string;
}

const MessageDivider: React.FC<MessageDividerProps> = ({ label, className = '' }) => {
  return (
    <div className={`ai-panel__message-divider ${className}`.trim()} role="separator" aria-label={label}>
      <span className="ai-panel__message-divider-line" />
      <span className="ai-panel__message-divider-text">{label}</span>
      <span className="ai-panel__message-divider-line" />
    </div>
  );
};

export default React.memo(MessageDivider);
