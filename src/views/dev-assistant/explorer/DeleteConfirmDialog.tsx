import React, { useState, useCallback } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { FileNode } from '../../../types';
import '../ExplorerPanel.css';

interface DeleteConfirmDialogProps {
  nodes: FileNode[];
  onDeleteNode?: (nodePath: string, nodeType: 'file' | 'folder') => Promise<boolean>;
  onCancel: () => void;
  /** 全部删除成功后触发（父组件负责关闭并清空选中） */
  onComplete: () => void;
}

/** 删除确认对话框：批量时逐个删除，全部成功才关闭；失败的项目留在弹窗内提示 */
const DeleteConfirmDialog: React.FC<DeleteConfirmDialogProps> = ({
  nodes,
  onDeleteNode,
  onCancel,
  onComplete,
}) => {
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = useCallback(async () => {
    if (nodes.length === 0 || !onDeleteNode) return;

    setIsDeleting(true);
    setError(null);

    const failed: string[] = [];
    for (const node of nodes) {
      try {
        const success = await onDeleteNode(node.path, node.type);
        if (!success) failed.push(node.name);
      } catch {
        failed.push(node.name);
      }
    }

    setIsDeleting(false);
    if (failed.length === 0) {
      onComplete();
    } else {
      setError(`以下项目删除失败：${failed.join('、')}`);
    }
  }, [nodes, onDeleteNode, onComplete]);

  const single = nodes.length === 1 ? nodes[0] : null;
  const hasFolder = nodes.some(n => n.type === 'folder');

  return (
    <div className="explorer-panel__delete-overlay" onClick={onCancel}>
      <div className="explorer-panel__delete-dialog" onClick={e => e.stopPropagation()}>
        <div className="explorer-panel__delete-dialog-header">
          <AlertTriangle size={20} className="explorer-panel__delete-dialog-icon" />
          <span>确认删除</span>
        </div>
        <div className="explorer-panel__delete-dialog-body">
          {single ? (
            <p>
              确定要删除{single.type === 'folder' ? '文件夹' : '文件'}
              <strong> {single.name} </strong>
              吗？
            </p>
          ) : (
            <p>
              确定要删除选中的 <strong>{nodes.length}</strong> 个项目吗？
              <span className="explorer-panel__delete-dialog-list">
                {nodes.map(n => n.name).join('、')}
              </span>
            </p>
          )}
          {hasFolder && (
            <p className="explorer-panel__delete-dialog-warning">
              文件夹内的所有内容将被一并删除，此操作不可撤销。
            </p>
          )}
          {!hasFolder && (
            <p className="explorer-panel__delete-dialog-warning">
              此操作不可撤销。
            </p>
          )}
          {error && (
            <p className="explorer-panel__delete-dialog-error">{error}</p>
          )}
        </div>
        <div className="explorer-panel__delete-dialog-footer">
          <button
            className="explorer-panel__delete-dialog-btn explorer-panel__delete-dialog-btn--cancel"
            onClick={onCancel}
            disabled={isDeleting}
          >
            取消
          </button>
          <button
            className="explorer-panel__delete-dialog-btn explorer-panel__delete-dialog-btn--confirm"
            onClick={handleConfirm}
            disabled={isDeleting}
          >
            {isDeleting ? '删除中...' : `删除${nodes.length > 1 ? ` ${nodes.length} 项` : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
};

export default DeleteConfirmDialog;
