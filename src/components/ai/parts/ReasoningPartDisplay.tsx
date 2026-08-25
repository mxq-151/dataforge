/**
 * ReasoningPartDisplay — 推理 part 渲染（可折叠）
 *
 * 对齐 opencode 桌面版 ReasoningPartDisplay（message-part.tsx 1595-1612 行）。
 *
 * 功能：
 * - streaming 判断：assistant 且 time.completed 未定义
 * - text 来源：readPartText(part.id, part)
 * - 流式用 PacedMarkdown，非流式用 ReactMarkdown
 * - 可折叠/展开：标题栏显示 "思考中..."（流式）或 "思考内容"（已完成）+ reasoning heading 预览
 * - 类型标识：标题栏左侧 "思考" 徽章
 */

import React, { useState, useMemo, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import PacedMarkdown from './PacedMarkdown';
import { markdownComponents } from './markdownComponents';
import { usePartsData } from './PartsDataContext';
import type { ReasoningPart, AssistantMessage } from '../../../types/opencode-backend';
import type { MessagePartProps } from './ToolPartDisplay';

// 模块级常量：避免每次渲染创建新数组导致 ReactMarkdown 重新处理
const REMARK_PLUGINS = [remarkGfm];

/** 从 reasoning 文本中提取首个标题作为预览 */
function reasoningHeading(text: string): string | undefined {
  const markdown = text.replace(/\r\n?/g, '\n');

  // HTML 标题
  const html = markdown.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i);
  if (html?.[1]) {
    const value = cleanHeading(html[1].replace(/<[^>]+>/g, ' '));
    if (value) return value;
  }

  // ATX 标题
  const atx = markdown.match(/^\s{0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/m);
  if (atx?.[1]) {
    const value = cleanHeading(atx[1]);
    if (value) return value;
  }

  // Strong 标题
  const strong = markdown.match(/^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*$/m);
  if (strong?.[1]) {
    const value = cleanHeading(strong[1]);
    if (value) return value;
  }

  return undefined;
}

function cleanHeading(value: string): string {
  return value
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_~]+/g, '')
    .trim();
}

// ── ReasoningPartDisplay 组件 ──────────────────────────────────

const ReasoningPartDisplay: React.FC<MessagePartProps> = ({ part, message }) => {
  const reasoningPart = part as ReasoningPart;
  const { readPartText } = usePartsData();
  const [expanded, setExpanded] = useState(false);

  const streaming = useMemo(() => {
    if (message.role !== 'assistant') return false;
    return typeof (message as AssistantMessage).time.completed !== 'number';
  }, [message]);

  const text = useMemo(() => {
    if (readPartText) return readPartText(reasoningPart.id, reasoningPart);
    return (reasoningPart as any).text ?? '';
  }, [readPartText, reasoningPart]);

  const heading = useMemo(() => {
    if (!text) return undefined;
    return reasoningHeading(text);
  }, [text]);

  const handleToggle = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  if (!text) return null;

  return (
    <div className="ai-panel__reasoning-part" data-timeline-part-id={reasoningPart.id}>
      {/* 可折叠标题栏 */}
      <div
        className="ai-panel__reasoning-header"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={handleToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleToggle();
          }
        }}
      >
        <span className="ai-panel__reasoning-chevron">
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}
          >
            <path d="M3.5 2L6.5 5L3.5 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <span className="ai-panel__reasoning-badge">思考</span>
        {streaming ? (
          <span className="ai-panel__reasoning-label">思考中…</span>
        ) : (
          <span className="ai-panel__reasoning-label">思考内容</span>
        )}
        {!expanded && heading && (
          <span className="ai-panel__reasoning-preview">{heading}</span>
        )}
      </div>

      {/* 展开内容 */}
      {expanded && (
        <div className="ai-panel__reasoning-content">
          {streaming ? (
            <PacedMarkdown text={text} cacheKey={reasoningPart.id} streaming={streaming} />
          ) : (
            <div className="ai-panel__markdown ai-panel__markdown--reasoning" key={reasoningPart.id}>
              <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={markdownComponents}>{text}</ReactMarkdown>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default React.memo(ReasoningPartDisplay);
