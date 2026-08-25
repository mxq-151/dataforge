/**
 * BashTool — bash 工具卡片
 *
 * 对齐桌面版 bash 渲染器（message-part.tsx 1882-1947 行）。
 * 显示 $ command + 输出。
 */

import React, { useMemo } from 'react';
import BasicTool, { type TriggerTitle } from '../BasicTool';
import type { ToolProps } from '../ToolRegistry';

/** 去除 ANSI 转义序列 */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

const BashTool: React.FC<ToolProps> = ({ input, metadata, output, status }) => {
  const command = String(input.command ?? metadata.command ?? '');
  const description = String(input.description ?? '');
  const rawOutput = stripAnsi(output || '').replace(/\r\n?/g, '\n');
  const fullText = `$ ${command}${rawOutput ? '\n\n' + rawOutput : ''}`;
  const hasContent = !!command || !!rawOutput;

  const trigger: TriggerTitle = useMemo(
    () => ({
      title: 'Shell',
      subtitle: description || undefined,
    }),
    [description],
  );

  return (
    <BasicTool status={status} trigger={trigger} defaultOpen={false}>
      {hasContent && (
        <div className="ai-panel__bash-output">
          <div className="ai-panel__basic-tool-content-label">执行结果</div>
          <pre className="ai-panel__bash-pre">
            <code>{fullText}</code>
          </pre>
        </div>
      )}
    </BasicTool>
  );
};

export default React.memo(BashTool);
