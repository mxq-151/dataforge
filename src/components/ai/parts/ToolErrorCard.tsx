/**
 * ToolErrorCard — 工具错误卡片
 *
 * 对齐桌面版 ToolErrorCard（tool-error-card.tsx）。
 * 所有 status === "error" 的工具都使用此卡片渲染。
 *
 * 功能：
 * - 红色错误样式
 * - 错误消息拆分为 subtitle（冒号前）和 body（冒号后）
 * - 可折叠查看完整错误
 */

import React, { useState } from 'react';
import CollapsibleHeader from './CollapsibleHeader';

export interface ToolErrorCardProps {
  /** 工具名称 */
  tool: string;
  /** 错误消息 */
  error?: string;
  /** 可选自定义标题 */
  title?: string;
  /** 可选副标题（task 工具传 description） */
  subtitle?: string;
  /** 默认展开 */
  defaultOpen?: boolean;
}

/** 工具标题映射 */
const TOOL_TITLES: Record<string, string> = {
  read: 'Read',
  list: 'List',
  glob: 'Glob',
  grep: 'Grep',
  task: 'Sub-Agent',
  webfetch: 'Web Fetch',
  websearch: 'Web Search',
  bash: 'Shell',
  edit: 'Edit',
  write: 'Write',
  apply_patch: 'Patch',
  question: 'Questions',
  skill: 'Skill',
};

function getToolTitle(tool: string): string {
  return TOOL_TITLES[tool] || tool;
}

const ToolErrorCard: React.FC<ToolErrorCardProps> = ({
  tool,
  error,
  title,
  subtitle,
  defaultOpen = false,
}) => {
  const [open, setOpen] = useState(defaultOpen);

  const errorMessage = error || 'Unknown error';
  const toolTitle = title || getToolTitle(tool);

  // 清理错误消息
  const cleanMessage = errorMessage
    .replace(/^Error:\s*/i, '')
    .replace(new RegExp(`^${tool}[:\\s]*`, 'i'), '');

  // 拆分为 subtitle 和 body
  const effectiveSubtitle = subtitle || (() => {
    const colonIdx = cleanMessage.indexOf(':');
    if (colonIdx > 0) return cleanMessage.slice(0, colonIdx);
    return 'Failed';
  })();

  const body = (() => {
    if (subtitle) return cleanMessage;
    const colonIdx = cleanMessage.indexOf(':');
    if (colonIdx > 0) return cleanMessage.slice(colonIdx + 1).trim();
    return cleanMessage;
  })();

  // body 有内容即允许展开/折叠、显示箭头。
  // 旧的 body.length > 60 门控会导致短错误消息（如子代理失败）永远不可见、
  // 箭头也消失，用户无任何视觉提示。这里改为 hasBody = !!body。
  const hasBody = !!body;

  return (
    <div className="ai-panel__tool-card ai-panel__tool-card--error">
      <CollapsibleHeader
        open={open}
        onToggle={() => hasBody && setOpen((prev) => !prev)}
        disabled={!hasBody}
        showArrow={hasBody}
        className="ai-panel__tool-card-header ai-panel__tool-card-header--error"
      >
        <span className="ai-panel__tool-card-status">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="ai-panel__tool-icon--error">
            <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M4 4l4 4M8 4l-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </span>
        <span className="ai-panel__tool-card-name">{toolTitle}</span>
        {effectiveSubtitle && (
          <span className="ai-panel__tool-card-title ai-panel__tool-card-title--error">
            {effectiveSubtitle}
          </span>
        )}
      </CollapsibleHeader>
      {open && hasBody && body && (
        <div className="ai-panel__tool-card-body ai-panel__tool-card-body--error">
          <pre className="ai-panel__tool-card-output">{body}</pre>
        </div>
      )}
    </div>
  );
};

export default React.memo(ToolErrorCard);
