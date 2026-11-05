/**
 * FileEditTool — edit/write/apply_patch 工具卡片
 *
 * 对齐桌面版 edit/write/apply_patch 渲染器。
 * 显示文件名 + diff 统计，展开后显示 patch 内容。
 * edit/write/apply_patch 三个工具共用此组件。
 */

import React, { useMemo } from 'react';
import BasicTool, { type TriggerTitle } from '../BasicTool';
import type { ToolProps } from '../ToolRegistry';
import { getBaseName } from '../../../../utils/pathUtils';

/** 从路径中提取文件名 */
function getFilename(path: string | undefined): string {
  if (!path) return '';
  return getBaseName(path);
}

const FileEditTool: React.FC<ToolProps> = ({ tool, input, metadata, output, status }) => {
  const filePath = String(
    input.filePath ?? (metadata.filediff as any)?.file ?? '',
  );
  const filename = getFilename(filePath);
  const filediff = metadata.filediff as any;
  const hasPatch = !!filediff?.patch;
  const hasOutput = !!output;

  // 计算 diff 统计
  const diffStats = useMemo(() => {
    if (!filediff?.patch) return null;
    const patch = filediff.patch as string;
    let additions = 0;
    let deletions = 0;
    for (const line of patch.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) additions++;
      if (line.startsWith('-') && !line.startsWith('---')) deletions++;
    }
    return { additions, deletions };
  }, [filediff]);

  // 工具标题
  const title = tool === 'edit' ? 'Edit' : tool === 'write' ? 'Write' : 'Patch';

  const trigger: TriggerTitle = useMemo(
    () => ({
      title,
      subtitle: filename || undefined,
      action: diffStats ? (
        <span className="ai-panel__tool-card-diff-stats">
          <span className="ai-panel__tool-card-diff-add">+{diffStats.additions}</span>
          <span className="ai-panel__tool-card-diff-del">-{diffStats.deletions}</span>
        </span>
      ) : undefined,
    }),
    [title, filename, diffStats],
  );

  return (
    <BasicTool status={status} trigger={trigger} defaultOpen={false} defer={true}>
      {hasPatch && (
        <div className="ai-panel__tool-card-section">
          <div className="ai-panel__basic-tool-content-label">变更内容</div>
          <pre className="ai-panel__tool-card-diff">{filediff.patch}</pre>
        </div>
      )}
      {hasOutput && !hasPatch && (
        <div className="ai-panel__tool-card-section">
          <div className="ai-panel__basic-tool-content-label">执行结果</div>
          <pre className="ai-panel__tool-card-output">{output}</pre>
        </div>
      )}
    </BasicTool>
  );
};

export default React.memo(FileEditTool);
