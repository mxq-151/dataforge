/**
 * WebFetchTool — webfetch 工具卡片
 *
 * 对齐桌面版 webfetch 渲染器（message-part.tsx 1725-1769 行）。
 * hideDetails 模式：仅显示 URL 链接，无展开内容。
 */

import React from 'react';
import BasicTool from '../BasicTool';
import type { ToolProps } from '../ToolRegistry';

const WebFetchTool: React.FC<ToolProps> = ({ input, status }) => {
  const url = String(input.url ?? '');

  return (
    <BasicTool
      status={status}
      hideDetails
      trigger={
        <div className="ai-panel__basic-tool-info">
          <div className="ai-panel__basic-tool-info-main">
            <span className="ai-panel__type-badge ai-panel__type-badge--tool">工具</span>
            <span className="ai-panel__basic-tool-title">Web Fetch</span>
            {url && (
              <a
                className="ai-panel__basic-tool-subtitle ai-panel__basic-tool-subtitle--clickable"
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
              >
                {url}
              </a>
            )}
          </div>
        </div>
      }
    />
  );
};

export default React.memo(WebFetchTool);
