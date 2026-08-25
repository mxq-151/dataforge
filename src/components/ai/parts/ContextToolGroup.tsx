/**
 * ContextToolGroup — 上下文工具组（新版本，位于 parts/ 目录）
 *
 * 对齐 opencode 桌面版 ContextToolGroup（message-part.tsx 947-1053 行）。
 * 将连续的 read/glob/grep/list 工具合并为一组显示。
 *
 * 功能：
 * - 折叠头：Gathering context（运行中）/ Gathered context（完成）+ 计数摘要
 * - 展开内容：每个工具的 title/subtitle/args，running 时 TextShimmer 闪烁
 * - 折叠头使用 CollapsibleHeader（div role=button，避免 button 嵌套）
 *
 * 与旧版（src/components/ai/ContextToolGroup.tsx）的差异：
 * - 使用 CollapsibleHeader 替代 <button>
 * - 使用 TextShimmer 替代 CSS class 切换
 * - 完整的 contextToolTrigger 支持 args（offset/limit/pattern/include）
 * - 摘要文本格式对齐桌面版（"N reads, M searches, K lists"）
 * - 支持 busy prop（活跃 turn 的最后一组工具仍在运行时显示 "Gathering"）
 */

import React, { useState, useMemo, useCallback } from 'react';
import CollapsibleHeader from './CollapsibleHeader';
import TextShimmer from './TextShimmer';
import type { ToolPart } from '../../../types/opencode-backend';

export interface ContextToolGroupProps {
  /** 合并到这一组的工具 parts（read/glob/grep/list） */
  parts: ToolPart[];
  /** 当前会话是否繁忙（影响 "Gathering" vs "Gathered" 标题） */
  busy?: boolean;
  /** 展开/折叠变化回调（用于外层重新计算尺寸） */
  onSizeChange?: () => void;
}

// ── contextToolSummary：数量统计 ───────────────────────────────

interface ContextSummary {
  read: number;
  search: number;
  list: number;
}

function contextToolSummary(parts: ToolPart[]): ContextSummary {
  let read = 0;
  let search = 0;
  let list = 0;
  for (const part of parts) {
    switch (part.tool) {
      case 'read':
        read++;
        break;
      case 'glob':
      case 'grep':
        search++;
        break;
      case 'list':
        list++;
        break;
    }
  }
  return { read, search, list };
}

// ── contextToolTrigger：每个工具的展示信息 ─────────────────────

interface ToolTriggerInfo {
  title: string;
  subtitle?: string;
  args?: string[];
}

/** 从文件路径提取文件名 */
function getFilename(filePath: string): string {
  const parts = filePath.split(/[/\\]/);
  return parts[parts.length - 1] || filePath;
}

/** 从路径提取目录名（取最后一级） */
function getDirectory(path: string | undefined): string {
  if (!path) return '/';
  const parts = path.replace(/[/\\]+$/, '').split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

function contextToolTrigger(part: ToolPart): ToolTriggerInfo {
  const input = ((part.state as any).input ?? {}) as Record<string, unknown>;
  const filePath = typeof input.filePath === 'string' ? input.filePath : undefined;
  const path = typeof input.path === 'string' ? input.path : '/';
  const pattern = typeof input.pattern === 'string' ? input.pattern : undefined;
  const include = typeof input.include === 'string' ? input.include : undefined;
  const offset = typeof input.offset === 'number' ? input.offset : undefined;
  const limit = typeof input.limit === 'number' ? input.limit : undefined;

  switch (part.tool) {
    case 'read': {
      const args: string[] = [];
      if (offset !== undefined) args.push(`offset=${offset}`);
      if (limit !== undefined) args.push(`limit=${limit}`);
      return {
        title: 'Read',
        subtitle: filePath ? getFilename(filePath) : '',
        args: args.length > 0 ? args : undefined,
      };
    }
    case 'list':
      return {
        title: 'List',
        subtitle: getDirectory(path),
      };
    case 'glob':
      return {
        title: 'Glob',
        subtitle: getDirectory(path),
        args: pattern ? [`pattern=${pattern}`] : undefined,
      };
    case 'grep': {
      const args: string[] = [];
      if (pattern) args.push(`pattern=${pattern}`);
      if (include) args.push(`include=${include}`);
      return {
        title: 'Grep',
        subtitle: getDirectory(path),
        args: args.length > 0 ? args : undefined,
      };
    }
    default:
      return { title: part.tool };
  }
}

// ── ContextToolGroup 组件 ──────────────────────────────────────

const ContextToolGroup: React.FC<ContextToolGroupProps> = ({ parts, busy, onSizeChange }) => {
  const [open, setOpen] = useState(false);

  const pending = useMemo(
    () => !!busy || parts.some((p) => p.state.status === 'pending' || p.state.status === 'running'),
    [busy, parts],
  );

  const summary = useMemo(() => contextToolSummary(parts), [parts]);

  // 构建摘要文本："N reads, M searches, K lists"
  const summaryText = useMemo(() => {
    const items: string[] = [];
    if (summary.read > 0) {
      items.push(`${summary.read} read${summary.read > 1 ? 's' : ''}`);
    }
    if (summary.search > 0) {
      items.push(`${summary.search} search${summary.search > 1 ? 'es' : ''}`);
    }
    if (summary.list > 0) {
      items.push(`${summary.list} list${summary.list > 1 ? 's' : ''}`);
    }
    return items.join(', ');
  }, [summary]);

  const title = pending ? 'Gathering context' : 'Gathered context';

  const handleToggle = useCallback(() => {
    setOpen((prev) => !prev);
    onSizeChange?.();
  }, [onSizeChange]);

  return (
    <div
      className={`ai-panel__context-tool-group ${open ? 'ai-panel__context-tool-group--expanded' : ''}`}
      data-timeline-part-ids={parts.map((p) => p.id).join(',')}
    >
      <CollapsibleHeader
        open={open}
        onToggle={handleToggle}
        className="ai-panel__context-tool-group-trigger"
        showArrow={!pending}
      >
        <span className="ai-panel__context-tool-group-label">
          <TextShimmer text={title} active={pending} />
        </span>
        {summaryText && !pending && (
          <span className="ai-panel__context-tool-group-summary">{summaryText}</span>
        )}
      </CollapsibleHeader>
      {open && (
        <div className="ai-panel__context-tool-group-list">
          {parts.map((part, idx) => {
            const trigger = contextToolTrigger(part);
            const isRunning = part.state.status === 'pending' || part.state.status === 'running';
            return (
              <div key={part.id || idx} className="ai-panel__context-tool-group-item">
                <div className="ai-panel__basic-tool-info">
                  <div className="ai-panel__basic-tool-info-main">
                    <span className="ai-panel__basic-tool-title">
                      <TextShimmer text={trigger.title} active={isRunning} />
                    </span>
                    {trigger.subtitle && !isRunning && (
                      <span className="ai-panel__basic-tool-subtitle">{trigger.subtitle}</span>
                    )}
                    {trigger.args?.length && !isRunning ? (
                      <span className="ai-panel__basic-tool-args">
                        {trigger.args.map((arg, i) => (
                          <span key={i} className="ai-panel__basic-tool-arg">{arg}</span>
                        ))}
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default React.memo(ContextToolGroup);
