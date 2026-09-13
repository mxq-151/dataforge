import React, { useState, useCallback } from 'react';
import { Move, Copy, ChevronDown, ChevronRight, Folder } from 'lucide-react';
import type { TreeNode } from 'react-file-navigator';
import type { FileNode } from '../../../types';
import { useToast } from '../../../components/Toast';
import { getParentDir, getSeparator } from './treeUtils';
import '../ExplorerPanel.css';

export type MoveCopyMode = 'move' | 'copy';

interface MoveCopyDialogProps {
  mode: MoveCopyMode;
  /** 被移动/复制的节点（支持批量） */
  targets: TreeNode[];
  /** 完整文件树（目标目录选择树的数据源） */
  fileTree: FileNode[];
  /** 文件浏览器当前根目录 */
  rootPath: string | null;
  /** 移动/复制的实际执行函数（onMoveNode / onCopyNode） */
  onAction: (srcPath: string, targetDirPath: string, nodeType: 'file' | 'folder') => Promise<boolean>;
  /** 用户取消 */
  onClose: () => void;
  /** 全部成功后触发（父组件负责关闭并清空选中） */
  onComplete: () => void;
}

// 目标目录选择树：递归渲染目录节点（只展示文件夹），可展开/折叠、点击选中。
// srcPaths 为被移动/复制的节点路径（批量时多个），用于将这些节点自身及其子目录禁用、避免移动到自身内部。
const renderDirTree = (
  nodes: FileNode[],
  selectedDir: string | null,
  srcPaths: string[],
  expanded: Set<string>,
  onSelect: (path: string) => void,
  onToggle: (path: string) => void,
  depth = 0
): React.ReactNode => {
  const folders = nodes.filter(n => n.type === 'folder');
  if (folders.length === 0) return null;

  // 目标目录不能是被操作节点本身或其子目录
  const isSelfOrDescendant = (path: string) => srcPaths.some(srcPath =>
    path === srcPath ||
    path.startsWith(srcPath.endsWith('/') || srcPath.endsWith('\\') ? srcPath : srcPath + getSeparator(path))
  );

  return folders.map(node => {
    const disabled = isSelfOrDescendant(node.path);
    const isExpanded = expanded.has(node.path);
    const hasChildren = node.children && node.children.some(c => c.type === 'folder') ? true : false;
    const selected = selectedDir === node.path;

    return (
      <div key={node.path}>
        <div
          className={`explorer-panel__move-tree-row${selected ? ' explorer-panel__move-tree-row--selected' : ''}${disabled ? ' explorer-panel__move-tree-row--disabled' : ''}`}
          style={{ paddingLeft: depth * 16 }}
        >
          <span
            className="explorer-panel__move-tree-arrow"
            onClick={() => hasChildren && !disabled && onToggle(node.path)}
          >
            {hasChildren ? (isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : null}
          </span>
          <span
            className="explorer-panel__move-tree-label"
            onClick={() => !disabled && onSelect(node.path)}
          >
            <Folder size={14} style={{ color: '#dcb67a' }} />
            <span className="explorer-panel__move-tree-name">{node.name}</span>
          </span>
        </div>
        {isExpanded && node.children && (
          <div className="explorer-panel__move-tree-children">
            {renderDirTree(node.children, selectedDir, srcPaths, expanded, onSelect, onToggle, depth + 1)}
          </div>
        )}
      </div>
    );
  });
};

/** 移动/复制对话框：共用同一套目标目录选择 UI，批量时逐个执行，全部成功才关闭 */
const MoveCopyDialog: React.FC<MoveCopyDialogProps> = ({
  mode,
  targets,
  fileTree,
  rootPath,
  onAction,
  onClose,
  onComplete,
}) => {
  const toast = useToast();
  const isMove = mode === 'move';
  const verb = isMove ? '移动' : '复制';

  // 默认选中源节点的父目录或项目根目录
  const [selectedDir, setSelectedDir] = useState<string | null>(() => {
    const defaultTarget = getParentDir(targets[0]?.filePath || '');
    return rootPath && defaultTarget && rootPath !== defaultTarget && defaultTarget.startsWith(rootPath)
      ? defaultTarget
      : rootPath;
  });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [isWorking, setIsWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleDir = useCallback((path: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleSelectDir = useCallback((path: string) => {
    setSelectedDir(path);
    setError(null);
  }, []);

  // 提交（批量：逐个执行，全部成功才关闭弹窗）
  const handleSubmit = useCallback(async () => {
    if (targets.length === 0 || !onAction) return;

    if (!selectedDir) {
      setError('请选择目标文件夹');
      return;
    }

    setIsWorking(true);
    setError(null);

    const failed: string[] = [];
    for (const node of targets) {
      try {
        const success = await onAction(
          node.filePath,
          selectedDir,
          node.type === 'Folder' ? 'folder' : 'file'
        );
        if (!success) failed.push(node.name);
      } catch {
        failed.push(node.name);
      }
    }

    setIsWorking(false);
    if (failed.length === 0) {
      toast.info(targets.length > 1
        ? `已${verb} ${targets.length} 个项目`
        : `已${verb}「${targets[0].name}」`);
      onComplete();
    } else {
      setError(`以下项目${verb}失败：${failed.join('、')}`);
    }
  }, [targets, selectedDir, onAction, toast, verb, onComplete]);

  const handleCancel = useCallback(() => {
    if (isWorking) return;
    onClose();
  }, [isWorking, onClose]);

  return (
    <div className="explorer-panel__move-overlay" onClick={handleCancel}>
      <div className="explorer-panel__move-dialog" onClick={e => e.stopPropagation()}>
        <div className="explorer-panel__move-dialog-header">
          {isMove ? (
            <Move size={18} className="explorer-panel__move-dialog-icon" />
          ) : (
            <Copy size={18} className="explorer-panel__move-dialog-icon explorer-panel__move-dialog-icon--copy" />
          )}
          <span>{isMove ? '移动到' : '复制到'}</span>
        </div>
        <div className="explorer-panel__move-dialog-body">
          <div className="explorer-panel__move-dialog-node">
            {targets.length > 1
              ? <>{verb} <strong>{targets.length}</strong> 个选中的项目</>
              : <>{verb}{targets[0]?.type === 'Folder' ? '文件夹' : '文件'}
                 <strong> {targets[0]?.name} </strong></>}
          </div>
          <p className="explorer-panel__move-dialog-tip">
            {isMove
              ? '请在下方选择目标文件夹：'
              : '请在下方选择目标文件夹（重名时自动追加"副本"后缀）：'}
          </p>
          <div className="explorer-panel__move-tree">
            {renderDirTree(
              fileTree,
              selectedDir,
              targets.map(n => n.filePath),
              expanded,
              handleSelectDir,
              toggleDir
            )}
            {fileTree.length === 0 && (
              <div className="explorer-panel__move-tree-empty">目录为空</div>
            )}
          </div>
          {error && (
            <p className="explorer-panel__move-dialog-error">{error}</p>
          )}
        </div>
        <div className="explorer-panel__move-dialog-footer">
          <span className="explorer-panel__move-target-path" title={selectedDir || ''}>
            {selectedDir || '未选择目录'}
          </span>
          <div className="explorer-panel__move-dialog-actions">
            <button
              className="explorer-panel__move-dialog-btn explorer-panel__move-dialog-btn--cancel"
              onClick={handleCancel}
              disabled={isWorking}
            >
              取消
            </button>
            <button
              className="explorer-panel__move-dialog-btn explorer-panel__move-dialog-btn--confirm"
              onClick={handleSubmit}
              disabled={isWorking || !selectedDir}
            >
              {isWorking ? `${verb}中...` : verb}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MoveCopyDialog;
