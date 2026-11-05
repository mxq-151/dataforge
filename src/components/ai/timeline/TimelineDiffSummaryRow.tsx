/**
 * TimelineDiffSummaryRow — DiffSummary 行
 *
 * 对齐 opencode 桌面版 TimelineDiffSummaryRow（message-timeline.tsx 138-219 行）。
 * turn 完成后展示文件改动摘要，最多 10 个文件，可展开看 patch。
 *
 * 简化项（相对桌面版）：
 * - 不用 Accordion 组件，用原生折叠（CollapsibleHeader）
 * - diff 视图用 <pre> 显示 patch（桌面版用 fileComponent diff 视图）
 */

import React, { useState, useMemo } from 'react';
import CollapsibleHeader from '../parts/CollapsibleHeader';
import type { SummaryDiff } from './rows';
import { getBaseName, getDirName } from '../../../utils/pathUtils';

export interface TimelineDiffSummaryRowProps {
  diffs: SummaryDiff[];
}

const MAX_FILES = 10;

/** 从路径提取文件名 */
function getFilename(path: string): string {
  return getBaseName(path);
}

/** 从路径提取目录 */
function getDirectory(path: string): string {
  return getDirName(path);
}

/** 计算总计 +/- */
function totalChanges(diffs: SummaryDiff[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const diff of diffs) {
    additions += diff.additions ?? 0;
    deletions += diff.deletions ?? 0;
  }
  return { additions, deletions };
}

const TimelineDiffSummaryRow: React.FC<TimelineDiffSummaryRowProps> = ({ diffs }) => {
  const [showAll, setShowAll] = useState(false);
  const [expandedFile, setExpandedFile] = useState<string | null>(null);

  const total = useMemo(() => totalChanges(diffs), [diffs]);
  const overflow = Math.max(0, diffs.length - MAX_FILES);
  const visible = showAll ? diffs : diffs.slice(0, MAX_FILES);

  return (
    <div className="ai-panel__timeline-diffs" data-timeline-row="DiffSummary">
      <div className="ai-panel__timeline-diffs-header">
        <span className="ai-panel__timeline-diffs-label">
          {diffs.length} {diffs.length === 1 ? 'file' : 'files'} changed
        </span>
        <span className="ai-panel__timeline-diffs-changes">
          <span className="ai-panel__tool-card-diff-add">+{total.additions}</span>
          <span className="ai-panel__tool-card-diff-del">-{total.deletions}</span>
        </span>
        {overflow > 0 && (
          <button
            className="ai-panel__timeline-diffs-toggle"
            onClick={() => setShowAll((prev) => !prev)}
          >
            {showAll ? 'Show less' : `Show all (${diffs.length})`}
          </button>
        )}
      </div>
      <div className="ai-panel__timeline-diffs-content">
        {visible.map((diff) => {
          const filename = getFilename(diff.file);
          const directory = getDirectory(diff.file);
          const isOpen = expandedFile === diff.file;
          const hasPatch = !!diff.patch;
          return (
            <div key={diff.file} className="ai-panel__timeline-diff-item">
              <CollapsibleHeader
                open={isOpen}
                onToggle={() => setExpandedFile(isOpen ? null : diff.file)}
                showArrow={hasPatch}
                disabled={!hasPatch}
                className="ai-panel__timeline-diff-trigger"
              >
                <span className="ai-panel__timeline-diff-path">
                  <span className="ai-panel__timeline-diff-directory">{directory}/</span>
                  <span className="ai-panel__timeline-diff-filename">{filename}</span>
                </span>
                <span className="ai-panel__timeline-diff-meta">
                  <span className="ai-panel__timeline-diff-changes">
                    <span className="ai-panel__tool-card-diff-add">+{diff.additions ?? 0}</span>
                    <span className="ai-panel__tool-card-diff-del">-{diff.deletions ?? 0}</span>
                  </span>
                </span>
              </CollapsibleHeader>
              {isOpen && hasPatch && (
                <pre className="ai-panel__timeline-diff-view">{diff.patch}</pre>
              )}
            </div>
          );
        })}
        {!showAll && overflow > 0 && (
          <button
            className="ai-panel__timeline-diffs-more"
            onClick={() => setShowAll(true)}
          >
            {overflow} more file{overflow > 1 ? 's' : ''}…
          </button>
        )}
      </div>
    </div>
  );
};

export default React.memo(TimelineDiffSummaryRow);
