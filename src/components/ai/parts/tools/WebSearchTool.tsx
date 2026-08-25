/**
 * WebSearchTool — websearch 工具卡片
 *
 * 对齐桌面版 websearch 渲染器（message-part.tsx 1771-1795 行）。
 * 显示搜索查询，展开后显示搜索结果（提取 URL 链接列表）。
 */

import React, { useMemo } from 'react';
import BasicTool, { type TriggerTitle } from '../BasicTool';
import type { ToolProps } from '../ToolRegistry';

/** 从输出文本中提取 URL 链接 */
function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>"'`)\]]+/g);
  if (!matches) return [];
  // 去重
  return Array.from(new Set(matches));
}

/** 获取搜索提供商标签 */
function getProviderLabel(metadata: Record<string, unknown>): string {
  const provider = metadata.provider;
  if (provider === 'parallel') return 'Parallel Web Search';
  if (provider === 'exa') return 'Exa Web Search';
  return 'Web Search';
}

const WebSearchTool: React.FC<ToolProps> = ({ input, metadata, output, status }) => {
  const query = String(input.query ?? '');
  const providerLabel = getProviderLabel(metadata);

  const links = useMemo(() => extractUrls(output || ''), [output]);

  const trigger: TriggerTitle = useMemo(
    () => ({
      title: providerLabel,
      subtitle: query || undefined,
    }),
    [providerLabel, query],
  );

  return (
    <BasicTool status={status} trigger={trigger} defaultOpen={false}>
      {links.length > 0 ? (
        <div className="ai-panel__websearch-links">
          <div className="ai-panel__basic-tool-content-label">搜索结果</div>
          {links.map((url, i) => (
            <a
              key={i}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="ai-panel__websearch-link"
            >
              {url}
            </a>
          ))}
        </div>
      ) : output ? (
        <>
          <div className="ai-panel__basic-tool-content-label">搜索结果</div>
          <pre className="ai-panel__tool-card-output">{output}</pre>
        </>
      ) : null}
    </BasicTool>
  );
};

export default React.memo(WebSearchTool);
