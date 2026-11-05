import React, { useState, useRef, useEffect } from 'react';
import {
  FilePlus,
  FolderPlus,
  Pencil,
  Move,
  Copy,
  Trash2,
  History,
  Undo2,
  Sliders,
  Send,
} from 'lucide-react';
import type { TreeNode } from 'react-file-navigator';
import type { DolphinSchedulerApi } from '../../../types/dolphinscheduler';
import '../ExplorerPanel.css';

/** 各菜单项依赖的宿主能力（对应 ExplorerPanel 的可选回调是否提供） */
export interface ExplorerMenuCapabilities {
  createFile: boolean;
  createFolder: boolean;
  rename: boolean;
  move: boolean;
  copy: boolean;
  showHistory: boolean;
  /** 撤销文件变更：需要 onRevertFile 与 onCheckFileChanged 同时提供 */
  revert: boolean;
}

interface ExplorerContextMenuProps {
  /** 打开位置（视口坐标，与菜单 position: fixed 一致） */
  x: number;
  y: number;
  /** 菜单作用目标：右键命中节点属于多选集合时为集合全部节点，否则仅该节点 */
  targets: TreeNode[];
  /** 「配置参数/提交调度」可见性（目标全是 code 分层目录下的文件夹） */
  canConfigureParams: boolean;
  /** 目标文件夹下的代码文件数（配置参数/提交调度共用的折算结果） */
  configTargetFileCount: number;
  /** 配置参数落库所需的项目上下文 */
  projectId?: number;
  /** 调度客户端（未提供时「提交调度」置灰） */
  dsApi?: DolphinSchedulerApi | null;
  /** 检查文件是否有未提交变更（置灰「撤销文件变更」） */
  onCheckFileChanged?: (filePath: string) => Promise<boolean>;
  capabilities: ExplorerMenuCapabilities;
  onClose: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
  onRename: () => void;
  onMove: () => void;
  onCopy: () => void;
  onConfigureParams: () => void;
  onSubmitSchedule: () => void;
  onShowHistory: () => void;
  onRevert: () => void;
  onDelete: () => void;
}

/** 文件树右键菜单：负责定位校正、点外关闭与各菜单项的可用性判定 */
const ExplorerContextMenu: React.FC<ExplorerContextMenuProps> = ({
  x,
  y,
  targets,
  canConfigureParams,
  configTargetFileCount,
  projectId,
  dsApi,
  onCheckFileChanged,
  capabilities,
  onClose,
  onNewFile,
  onNewFolder,
  onRename,
  onMove,
  onCopy,
  onConfigureParams,
  onSubmitSchedule,
  onShowHistory,
  onRevert,
  onDelete,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  // 点击外部关闭
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  // 渲染后按窗口边界校正位置，避免溢出 app 视口
  useEffect(() => {
    if (!menuRef.current) return;

    const el = menuRef.current;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const margin = 4;

    let nx = x;
    let ny = y;

    if (nx + w > vw - margin) nx = Math.max(margin, vw - w - margin);
    if (ny + h > vh - margin) ny = Math.max(margin, vh - h - margin);
    if (nx < margin) nx = margin;
    if (ny < margin) ny = margin;

    if (nx !== x || ny !== y) {
      setPos({ x: nx, y: ny });
    }
  }, [x, y]);

  // 右键目标文件是否可撤销（有未提交变更），用于置灰「撤销文件变更」；非文件或未提供检查能力时视为可点
  const [canRevertFile, setCanRevertFile] = useState(true);
  useEffect(() => {
    const node = targets.length === 1 ? targets[0] : null;
    if (!node || node.type !== 'File' || !onCheckFileChanged) {
      setCanRevertFile(true);
      return;
    }
    let cancelled = false;
    setCanRevertFile(false);
    onCheckFileChanged(node.filePath)
      .then(ok => { if (!cancelled) setCanRevertFile(ok); })
      .catch(() => { if (!cancelled) setCanRevertFile(true); });
    return () => { cancelled = true; };
  }, [targets, onCheckFileChanged]);

  const isSingleFile = targets.length === 1 && targets[0].type === 'File';

  return (
    <div
      ref={menuRef}
      className="explorer-panel__context-menu"
      style={{ left: pos.x, top: pos.y }}
    >
      <button
        className="explorer-panel__context-menu-item"
        onClick={onNewFile}
        disabled={!capabilities.createFile}
      >
        <FilePlus size={14} />
        <span>新建文件</span>
      </button>
      <button
        className="explorer-panel__context-menu-item"
        onClick={onNewFolder}
        disabled={!capabilities.createFolder}
      >
        <FolderPlus size={14} />
        <span>新建文件夹</span>
      </button>
      <div className="explorer-panel__context-menu-divider" />
      <button
        className="explorer-panel__context-menu-item"
        onClick={onRename}
        disabled={!capabilities.rename || targets.length !== 1}
      >
        <Pencil size={14} />
        <span>重命名</span>
      </button>
      <button
        className="explorer-panel__context-menu-item"
        onClick={onMove}
        disabled={!capabilities.move || targets.length === 0}
      >
        <Move size={14} />
        <span>移动到 ...{targets.length > 1 ? ` (${targets.length})` : ''}</span>
      </button>
      <button
        className="explorer-panel__context-menu-item"
        onClick={onCopy}
        disabled={!capabilities.copy || targets.length === 0}
      >
        <Copy size={14} />
        <span>复制到 ...{targets.length > 1 ? ` (${targets.length})` : ''}</span>
      </button>
      {/* 配置参数 / 提交调度：只对 code 分层目录下的文件夹显示
          （含分隔线一起隐藏，避免出现连续分隔线；判定见 canConfigureParams） */}
      {canConfigureParams && (
        <>
          <div className="explorer-panel__context-menu-divider" />
          <button
            className="explorer-panel__context-menu-item"
            onClick={onConfigureParams}
            disabled={!projectId || configTargetFileCount === 0}
            title={
              !projectId
                ? '缺少项目上下文，无法配置参数'
                : configTargetFileCount === 0
                  ? '该节点下没有可配置参数的代码文件（仅支持 Scala / SQL / Java / Python）'
                  : `为 ${configTargetFileCount} 个代码文件配置相同参数`
            }
          >
            <Sliders size={14} />
            <span>
              配置参数
              {configTargetFileCount > 1 ? ` (${configTargetFileCount})` : ''}
            </span>
          </button>
          <button
            className="explorer-panel__context-menu-item"
            onClick={onSubmitSchedule}
            disabled={!dsApi || configTargetFileCount === 0}
            title={
              !dsApi
                ? '调度系统不可用，无法提交调度'
                : configTargetFileCount === 0
                  ? '该节点下没有可提交调度的代码文件（仅支持 Scala / SQL / Java / Python）'
                  : `按该文件夹下的 ${configTargetFileCount} 个代码文件生成任务节点并提交到调度系统`
            }
          >
            <Send size={14} />
            <span>
              提交调度
              {configTargetFileCount > 1 ? ` (${configTargetFileCount})` : ''}
            </span>
          </button>
        </>
      )}
      <div className="explorer-panel__context-menu-divider" />
      {isSingleFile && (
        <button
          className="explorer-panel__context-menu-item"
          onClick={onShowHistory}
          disabled={!capabilities.showHistory}
        >
          <History size={14} />
          <span>历史版本</span>
        </button>
      )}
      {isSingleFile && (
        <button
          className="explorer-panel__context-menu-item"
          onClick={onRevert}
          disabled={!capabilities.revert || !canRevertFile}
          title={!canRevertFile && onCheckFileChanged ? '该文件没有未提交的变更' : undefined}
        >
          <Undo2 size={14} />
          <span>撤销文件变更</span>
        </button>
      )}
      <button
        className="explorer-panel__context-menu-item explorer-panel__context-menu-item--danger"
        onClick={onDelete}
        disabled={targets.length === 0}
      >
        <Trash2 size={14} />
        <span>删除{targets.length > 1 ? ` ${targets.length} 项` : ''}</span>
      </button>
    </div>
  );
};

export default ExplorerContextMenu;
