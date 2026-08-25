/**
 * UserMessageDisplay — 用户消息展示
 *
 * 对齐 opencode 桌面版 UserMessage（message-part.tsx 1055-1231 行）。
 *
 * 功能：
 * - 附件（attachments/inline files/agents）：图片可点击，文件显示 icon+name
 * - 正文：高亮 file/agent 引用（dataforge 简化为纯文本 + 行内引用标记）
 * - meta：agent · model · timestamp
 * - 回滚按钮在气泡左侧
 * - 用户标识在输入内容上方
 *
 * 简化项（相对桌面版）：
 * - HighlightedText 简化为纯文本渲染（保留 file/agent 引用的基础高亮）
 * - 附件图片预览用原生 <img>（桌面版用 ImagePreview dialog）
 */

import React, { useMemo } from 'react';
import { Redo2 } from 'lucide-react';
import type { UserMessage } from '../../../types/opencode-backend';

// ── 附件类型 ───────────────────────────────────────────────────

interface AttachmentInfo {
  /** 文件名 */
  name: string;
  /** 文件路径（用于显示） */
  path?: string;
  /** 是否图片 */
  isImage?: boolean;
  /** 图片 data URL 或路径 */
  src?: string;
}

// ── UserMessageDisplayProps ───────────────────────────────────

export interface UserMessageDisplayProps {
  /** 用户消息 */
  message: UserMessage;
  /** 已聚合的正文文本（从 text parts 提取） */
  text?: string;
  /** 附件列表 */
  attachments?: AttachmentInfo[];
  /** 回滚回调 */
  onRevert?: () => void;
  /** 回滚按钮禁用（busy 时） */
  revertDisabled?: boolean;
}

/** Agent 名称首字母大写 */
function capitalizeAgent(name: string | undefined): string | undefined {
  if (!name) return undefined;
  return name[0].toUpperCase() + name.slice(1);
}

/** 格式化时间戳为短时间 */
function formatTimestamp(ts: number | undefined): string | undefined {
  if (typeof ts !== 'number') return undefined;
  try {
    return new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(new Date(ts));
  } catch {
    return undefined;
  }
}

// ── UserMessageDisplay 组件 ───────────────────────────────────

const UserMessageDisplay: React.FC<UserMessageDisplayProps> = ({
  message,
  text,
  attachments,
  onRevert,
  revertDisabled,
}) => {
  // 从 message 提取 meta 字段（兼容 SDK 字段名）
  const msg = message as any;
  const agent = capitalizeAgent(msg.agent);
  const modelID = msg.modelID;
  const timestamp = formatTimestamp(msg.time?.created);

  const meta = useMemo(() => {
    const parts: string[] = [];
    if (agent) parts.push(agent);
    if (modelID) parts.push(modelID);
    if (timestamp) parts.push(timestamp);
    return parts.length > 0 ? parts.join(' · ') : undefined;
  }, [agent, modelID, timestamp]);

  const hasAttachments = !!attachments?.length;
  const hasText = !!text?.trim();

  return (
    <div className="ai-panel__user-message">
      {/* 用户标识 — 放在气泡上方 */}
      <div className="ai-panel__user-message-header">
        <span className="ai-panel__type-badge ai-panel__type-badge--user">用户</span>
        {meta && <span className="ai-panel__user-message-meta">{meta}</span>}
      </div>

      {hasAttachments && (
        <div className="ai-panel__user-message-attachments">
          {attachments!.map((att, idx) => (
            <div key={idx} className="ai-panel__user-message-attachment">
              {att.isImage && att.src ? (
                <img
                  className="ai-panel__user-message-attachment-image"
                  src={att.src}
                  alt={att.name}
                />
              ) : (
                <>
                  <span className="ai-panel__user-message-attachment-icon" aria-hidden="true">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <path d="M3 1.5h4L9.5 4v6.5a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z" stroke="currentColor" strokeWidth="1" />
                    </svg>
                  </span>
                  <span className="ai-panel__user-message-attachment-name">{att.name}</span>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      {hasText && (
        <div className="ai-panel__user-message-body-row">
          {/* 回滚按钮 — 气泡左侧 */}
          {onRevert && (
            <button
              className="ai-panel__user-message-revert-btn"
              onClick={onRevert}
              disabled={revertDisabled}
              title="回滚到此消息"
            >
              <Redo2 size={14} />
            </button>
          )}
          <div className="ai-panel__user-message-body">
            <div className="ai-panel__user-message-text">
              <div className="ai-panel__markdown">{text}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default React.memo(UserMessageDisplay);
