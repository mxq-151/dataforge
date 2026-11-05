/**
 * FileReviewPanel — 文件变更审查面板
 *
 * 简洁展示被修改的文件列表（来自 edit/write/apply_patch 工具），
 * 支持折叠/展开、逐个审批/拒绝、跳转文件查看。
 */

import React, { useState, useMemo } from 'react';
import { FileCode, Plus, Minus, ChevronDown, ChevronRight, ExternalLink, GitCompare } from 'lucide-react';
import type { FileChange } from '../../types/opencode-backend';

// 类型定义已迁至 types/opencode-backend（供 hooks 等下层模块引用，避免反向依赖组件），此处 re-export
export type { FileChange };

interface FileReviewPanelProps {
  changes: FileChange[];
  onApprove?: (partID: string) => void;
  onReject?: (filePath: string, change: { type: 'edit' | 'write' | 'apply_patch'; messageID?: string; partID?: string }) => void;
  onApproveAll?: () => void;
  /** 跳转到编辑器中打开文件 */
  onOpenFile?: (filePath: string) => void;
  /** 在编辑器中查看变更 diff */
  onViewDiff?: (filePath: string, patch: string) => void;
}

const TYPE_LABELS: Record<string, string> = {
  edit: '编辑',
  write: '新建',
  apply_patch: '补丁',
};

const FileReviewPanel: React.FC<FileReviewPanelProps> = ({
  changes,
  onApprove,
  onReject,
  onApproveAll,
  onOpenFile,
  onViewDiff,
}) => {
  const [collapsed, setCollapsed] = useState(true);
  const pendingCount = useMemo(() => changes.filter(c => c.status === 'pending').length, [changes]);

  if (changes.length === 0) return null;

  return (
    <div className="ai-panel__file-review">
      {/* 可点击折叠的头部 */}
      <button
        className="ai-panel__file-review-header"
        onClick={() => setCollapsed(prev => !prev)}
      >
        <span className="ai-panel__file-review-chevron">
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </span>
        <div className="ai-panel__file-review-title">
          <FileCode size={14} />
          <span>文件变更</span>
          <span className="ai-panel__file-review-count">{changes.length}</span>
        </div>

        {!collapsed && pendingCount > 0 && onApproveAll && (
              <button
                className="ai-panel__file-review-approve-all"
                onClick={(e) => { e.stopPropagation(); onApproveAll(); }}
              >
                全部通过
              </button>
            )}
            <span className="ai-panel__file-review-summary">
              待审 {pendingCount}
              {changes.length - pendingCount > 0 && ` / 已处理 ${changes.length - pendingCount}`}
            </span>
      </button>

      {/* 文件列表（可折叠） */}
      {!collapsed && (
        <div className="ai-panel__file-review-list">
          {changes.map((change) => {
            const filename = change.filePath.split(/[/\\]/).pop() || change.filePath;

            return (
              <div
                key={change.partID || change.filePath}
                className={`ai-panel__file-review-item ai-panel__file-review-item--${change.status}`}
              >
                <div className="ai-panel__file-review-row">
                  <span className={`ai-panel__file-review-icon ai-panel__file-review-icon--${change.type}`}>
                    <FileCode size={13} />
                  </span>
                  <span className="ai-panel__file-review-filename" title={change.filePath}>
                    {filename}
                  </span>
                  <span className="ai-panel__file-review-type">{TYPE_LABELS[change.type]}</span>

                  {(change.additions > 0 || change.deletions > 0) && (
                    <span className="ai-panel__file-review-diff-stats">
                      {change.additions > 0 && (
                        <span className="ai-panel__file-review-diff-add">
                          <Plus size={10} />{change.additions}
                        </span>
                      )}
                      {change.deletions > 0 && (
                        <span className="ai-panel__file-review-diff-del">
                          <Minus size={10} />{change.deletions}
                        </span>
                      )}
                    </span>
                  )}

                  {/* 状态文字 */}
                  {change.status === 'approved' && (
                    <span className="ai-panel__file-review-status-text ai-panel__file-review-status-text--approved">已通过</span>
                  )}
                  {change.status === 'rejected' && (
                    <span className="ai-panel__file-review-status-text ai-panel__file-review-status-text--rejected">已拒绝</span>
                  )}

                  {/* 操作按钮区 */}
                  <div className="ai-panel__file-review-actions">
                    {/* 跳转文件 / 查看变更按钮 */}
                    {onOpenFile && (
                      <button
                        className="ai-panel__file-review-btn ai-panel__file-review-btn--link"
                        onClick={() => onOpenFile(change.filePath)}
                        title="在编辑器中打开文件"
                      >
                        <ExternalLink size={12} />
                      </button>
                    )}
                    {onViewDiff && change.patch && (
                      <button
                        className="ai-panel__file-review-btn ai-panel__file-review-btn--diff"
                        onClick={() => onViewDiff(change.filePath, change.patch!)}
                        title="查看变更"
                      >
                        <GitCompare size={12} /> 变更
                      </button>
                    )}
                    {/* 审批按钮（仅 pending 状态） */}
                    {change.status === 'pending' && (
                      <>
                        {onReject && (
                          <button
                            className="ai-panel__file-review-btn ai-panel__file-review-btn--reject"
                            onClick={() => onReject(change.filePath, { type: change.type, messageID: change.messageID, partID: change.partID })}
                          >
                            拒绝
                          </button>
                        )}
                        {onApprove && (
                          <button
                            className="ai-panel__file-review-btn ai-panel__file-review-btn--approve"
                            onClick={() => change.partID && onApprove(change.partID)}
                          >
                            通过
                          </button>
                        )}
                      </>
                    )}
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

export default React.memo(FileReviewPanel);
