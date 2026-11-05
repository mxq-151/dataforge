/**
 * SkillTool — skill 工具卡片
 *
 * 对齐桌面版 skill 渲染器（message-part.tsx 2415-2435 行）。
 * hideDetails 模式：仅显示 skill 名称，无展开内容。
 */

import React from 'react';
import BasicTool from '../BasicTool';
import type { ToolProps } from '../ToolRegistry';

const SkillTool: React.FC<ToolProps> = ({ input, status }) => {
  const skillName = String(input.name ?? 'Skill');

  return (
    <BasicTool
      status={status}
      hideDetails
      trigger={
        <div className="ai-panel__basic-tool-info">
          <div className="ai-panel__basic-tool-info-main">
            <span className="ai-panel__type-badge ai-panel__type-badge--tool">技能</span>
            <span className="ai-panel__basic-tool-title">{skillName}</span>
          </div>
        </div>
      }
    />
  );
};

export default React.memo(SkillTool);
