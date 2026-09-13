import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import {
  FolderOpen,
  RefreshCw,
  FilePlus,
  FolderPlus,
  ChevronRight,
  ChevronLeft,
  GitCommitHorizontal,
  Check,
} from 'lucide-react';
import { Explorer } from 'react-file-navigator';
import type { Tree, TreeNode } from 'react-file-navigator';
import GitModal from './GitModal';
import type { DolphinSchedulerApi } from '../../types/dolphinscheduler';
import type { CompileConfig } from '../../services/unifiedCompile';
import { FileNode } from '../../types';
import { isUnderCodeLayerPath } from '../../utils/programLayout';
import './ExplorerPanel.css';
import {
  findNodeByPath,
  convertFileNodesToTree,
  extractExpandedPaths,
  getParentDir,
  resolveConfigTargetFiles,
} from './explorer/treeUtils';
import { iconMap, explorerConfig } from './explorer/explorerAssets';
import { useExplorerSelection } from './explorer/useExplorerSelection';
import ExplorerContextMenu from './explorer/ExplorerContextMenu';
import RenameDialog from './explorer/RenameDialog';
import type { RenameTarget } from './explorer/RenameDialog';
import DeleteConfirmDialog from './explorer/DeleteConfirmDialog';
import MoveCopyDialog from './explorer/MoveCopyDialog';
import FolderActionModals from './explorer/FolderActionModals';
import type { FolderAction } from './explorer/FolderActionModals';

interface DeleteConfirmState {
  visible: boolean;
  nodes: FileNode[];
}

interface ExplorerPanelProps {
  fileTree: FileNode[];
  rootPath: string | null;
  isLoading: boolean;
  selectedFile: string | null;
  expandedFolders: Set<string>;
  onFileSelect: (path: string) => void;
  onFolderToggle: (path: string) => void;
  onOpenFolder: () => void;
  onCreateFile: (parentPath: string, fileName: string) => Promise<FileNode | null>;
  onCreateFolder: (parentPath: string, folderName: string) => Promise<FileNode | null>;
  onDeleteNode?: (nodePath: string, nodeType: 'file' | 'folder') => Promise<boolean>;
  onRenameNode?: (oldPath: string, newName: string, nodeType: 'file' | 'folder') => Promise<boolean>;
  onMoveNode?: (srcPath: string, targetDirPath: string, nodeType: 'file' | 'folder') => Promise<boolean>;
  onCopyNode?: (srcPath: string, targetDirPath: string, nodeType: 'file' | 'folder') => Promise<boolean>;
  /** 请求查看某个文件的历史版本（仅文件） */
  onShowHistory?: (filePath: string) => void;
  /** 请求撤销某个文件的未提交修改（仅文件） */
  onRevertFile?: (filePath: string) => void;
  /** 判断文件是否有未提交变更（用于是否置灰「撤销文件变更」） */
  onCheckFileChanged?: (filePath: string) => Promise<boolean>;
  /**
   * 右键「配置参数」所需：项目 ID（配置按 (projectId, filePath) 落库）与弹窗只读展示项。
   * 未提供 projectId 时该菜单项置灰（无项目上下文无法落库）。
   */
  projectId?: number;
  /** 项目编码：弹窗内血缘命名空间的只读展示值 */
  projectCode?: string;
  /** 全局 OpenLineage Transport URL（来自设置页）：弹窗内血缘只读展示值 */
  openlineageTransportUrl?: string;
  /** 读取文件内容：批量配置参数时按各文件代码头解析引擎 */
  readFileContent?: (filePath: string) => Promise<string>;
  /** 批量配置参数保存成功后的回调（逐文件触发），供父组件按路径刷新内存态配置 */
  onSaveConfigParams?: (filePath: string, data: {
    dependencies: { id: string; name: string; version: string; source?: string; jarPath?: string; groupId?: string; scope?: string; autoChoose?: number | null; basePath?: string }[];
    programParams: { id: string; key: string; value: string }[];
    taskParams: { id: string; key: string; value: string }[];
  }) => void;
  /**
   * 右键「提交调度」所需：DolphinScheduler 客户端。
   * 未提供时该菜单项置灰（无调度上下文无法提交）。
   */
  dsApi?: DolphinSchedulerApi | null;
  /** 是否为真实调度环境（弹窗内的只读提示） */
  isRealApi?: boolean;
  /**
   * 开发项目根目录（与单文件「提交调度」同源，一般传 projectCwd）。
   * 右键文件夹「提交调度」用它推导工作流名称与展示路径 —— 必须与单文件提交调度用同一个基准，
   * 否则相对路径口径不同会算出不一样的工作流名（甚至回退成整条绝对路径）。
   * 未提供时回退 `rootPath`（文件浏览器的当前根）。
   */
  projectRoot?: string | null;
  /** 编译环境配置：右键文件夹「提交调度」时，Java/Scala 代码文件编译生成主 Jar 包 */
  compileConfig?: CompileConfig | null;
  onAISummarize?: (files: string[], diffs: string) => Promise<string>;
  onBeforeCommit?: () => { valid: boolean; message: string | null };
  /** Git 模态框撤销变更成功后的回调，入参为受影响文件的绝对路径 */
  onDiscarded?: (filePaths: string[]) => void;
  style?: React.CSSProperties;
  onCollapsedChange?: (collapsed: boolean) => void;
}

/**
 * 开发助手文件浏览器面板（编排层）。
 *
 * 职责拆分（见 explorer/ 目录）：
 * · 多选/点击/快捷键 —— useExplorerSelection
 * · 右键菜单（定位校正、可用性判定）—— ExplorerContextMenu
 * · 新建/重命名/删除/移动/复制等对话框 —— RenameDialog / DeleteConfirmDialog / MoveCopyDialog
 * · 「配置参数」「提交调度」弹窗的跨模块接线 —— FolderActionModals
 * · 树数据换算与图标等静态资源 —— treeUtils / explorerAssets
 */
const ExplorerPanel: React.FC<ExplorerPanelProps> = ({
  fileTree,
  rootPath,
  isLoading,
  selectedFile: _selectedFile,
  expandedFolders,
  onFileSelect,
  onFolderToggle,
  onOpenFolder,
  onCreateFile,
  onCreateFolder,
  onDeleteNode,
  onRenameNode,
  onMoveNode,
  onCopyNode,
  onShowHistory,
  onRevertFile,
  onCheckFileChanged,
  projectId,
  projectCode,
  openlineageTransportUrl,
  readFileContent,
  onSaveConfigParams,
  dsApi,
  isRealApi,
  projectRoot,
  compileConfig,
  onAISummarize,
  onBeforeCommit,
  onDiscarded,
  style,
  onCollapsedChange,
}) => {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isCreatingFile, setIsCreatingFile] = useState(false);
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [newFolderName, setNewFolderName] = useState('');
  // 新建文件/文件夹的目标父目录：null 表示根目录(rootPath)，右键菜单创建时指向对应目录
  const [createTarget, setCreateTarget] = useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const folderInputRef = React.useRef<HTMLInputElement>(null);
  // 面板根节点（始终挂载），用于托管文件树点击监听
  const panelRef = useRef<HTMLElement>(null);

  // 通知父组件折叠状态变化
  useEffect(() => {
    onCollapsedChange?.(isCollapsed);
  }, [isCollapsed, onCollapsedChange]);

  // 右键菜单状态
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; node: TreeNode | null } | null>(null);

  // 重命名目标（非空时挂载 RenameDialog）
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);

  const [gitModalVisible, setGitModalVisible] = useState(false);

  // 「配置参数 / 提交调度」当前打开的弹窗（同一时刻最多一个）
  const [folderAction, setFolderAction] = useState<FolderAction | null>(null);

  // 移动/复制对话框的目标节点（支持批量；对话框内部状态自管理）
  const [moveTargets, setMoveTargets] = useState<TreeNode[]>([]);
  const [copyTargets, setCopyTargets] = useState<TreeNode[]>([]);

  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmState>({
    visible: false,
    nodes: [],
  });

  const [tree, setTree] = useState<Tree>([]);
  const treeRef = useRef<Tree>([]);

  // ===== 多选 / 点击 / 快捷键 =====
  const {
    selectedPaths,
    selectedPathsRef,
    selectSingle,
    clearSelection,
    syncSelectionStyles,
    resolveNodeFromEventTarget,
    handleFileSelectionChange,
    handleTreeKeyDown,
  } = useExplorerSelection({
    tree,
    treeRef,
    panelRef,
    rootPath,
    fileTree,
    onFileSelect,
    // 正在内联输入（新建/重命名）时，Ctrl+A 留给输入框
    isInputActive: isCreatingFile || isCreatingFolder || renameTarget !== null,
  });

  useEffect(() => {
    const currentExpandedPaths = extractExpandedPaths(treeRef.current);
    const newTree = convertFileNodesToTree(fileTree, currentExpandedPaths);
    treeRef.current = newTree;
    setTree(newTree);
  }, [fileTree]);

  useEffect(() => {
    const newTree = convertFileNodesToTree(fileTree, expandedFolders);
    treeRef.current = newTree;
    setTree(newTree);
  }, [expandedFolders]);

  // 为文件树节点添加 title 属性，悬停时显示文件名
  useEffect(() => {
    const wrapper = document.querySelector('.file-navigator-wrapper');
    if (!wrapper) return;

    const addTitles = () => {
      const interactiveDivs = wrapper.querySelectorAll('div[tabindex]');
      interactiveDivs.forEach(div => {
        const spans = div.querySelectorAll('span');
        for (let j = spans.length - 1; j >= 0; j--) {
          const text = spans[j].textContent?.trim();
          if (text && text.length > 0 && text.length < 100 && !spans[j].querySelector('*')) {
            div.setAttribute('title', text);
            break;
          }
        }
      });
    };

    // 初始添加
    const timer = setTimeout(addTitles, 100);

    // 监听 DOM 变化（展开/折叠文件夹时节点会重新渲染）
    const observer = new MutationObserver(() => {
      setTimeout(() => {
        addTitles();
        // 行被重新创建后高亮会丢失，这里补刷一次
        syncSelectionStyles(selectedPathsRef.current);
      }, 50);
    });
    observer.observe(wrapper, { childList: true, subtree: true });

    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [tree, syncSelectionStyles, selectedPathsRef]);

  const handleSetTree = useCallback((newTreeOrUpdater: Tree | ((prev: Tree) => Tree)) => {
    setTree(prev => {
      const newTree = typeof newTreeOrUpdater === 'function'
        ? newTreeOrUpdater(prev)
        : newTreeOrUpdater;
      treeRef.current = newTree;

      const newExpandedPaths = extractExpandedPaths(newTree);
      const oldExpandedPaths = extractExpandedPaths(prev);

      newExpandedPaths.forEach(path => {
        if (!oldExpandedPaths.has(path)) {
          onFolderToggle(path);
        }
      });
      oldExpandedPaths.forEach(path => {
        if (!newExpandedPaths.has(path)) {
          onFolderToggle(path);
        }
      });

      return newTree;
    });
  }, [onFolderToggle]);

  const handleToggle = () => {
    setIsCollapsed(!isCollapsed);
    setIsCreatingFile(false);
    setNewFileName('');
  };

  // ===== 新建文件 / 文件夹 =====

  const handleCreateFileClick = useCallback(() => {
    setIsCreatingFile(true);
    setIsCreatingFolder(false);
    setCreateTarget(null); // 顶部按钮 -> 根目录
    setNewFileName('untitled.tsx');
    setTimeout(() => {
      if (inputRef.current) {
        inputRef.current.focus();
        inputRef.current.select();
      }
    }, 100);
  }, []);

  const handleCreateFolderClick = useCallback(() => {
    setIsCreatingFolder(true);
    setIsCreatingFile(false);
    setCreateTarget(null); // 顶部按钮 -> 根目录
    setNewFolderName('新建文件夹');
    setTimeout(() => {
      if (folderInputRef.current) {
        folderInputRef.current.focus();
        folderInputRef.current.select();
      }
    }, 100);
  }, []);

  const handleCreateFileSubmit = useCallback(async () => {
    if (!newFileName.trim() || !rootPath) return;

    const parentPath = createTarget || rootPath;
    const createdNode = await onCreateFile(parentPath, newFileName.trim());

    if (createdNode) {
      onFileSelect(createdNode.path);
      selectSingle(createdNode.path);
    }

    setIsCreatingFile(false);
    setNewFileName('');
  }, [newFileName, rootPath, createTarget, onCreateFile, onFileSelect, selectSingle]);

  const handleCreateFolderSubmit = useCallback(async () => {
    if (!newFolderName.trim() || !rootPath) return;

    const parentPath = createTarget || rootPath;
    const createdNode = await onCreateFolder(parentPath, newFolderName.trim());

    if (createdNode) {
      onFolderToggle(createdNode.path);
    }

    setIsCreatingFolder(false);
    setNewFolderName('');
  }, [newFolderName, rootPath, createTarget, onCreateFolder, onFolderToggle]);

  const handleKeyPress = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (isCreatingFile) {
        handleCreateFileSubmit();
      } else if (isCreatingFolder) {
        handleCreateFolderSubmit();
      }
    } else if (e.key === 'Escape') {
      setIsCreatingFile(false);
      setIsCreatingFolder(false);
      setNewFileName('');
      setNewFolderName('');
    }
  }, [handleCreateFileSubmit, handleCreateFolderSubmit, isCreatingFile, isCreatingFolder]);

  // ===== 右键菜单 =====

  // 右键菜单：处理文件树节点上的右键事件
  // react-file-navigator 的 FileTree 渲染的 DOM 层级为：
  //   div[draggable] > div[draggable, 节点行] > div[tabIndex=1, 交互层] > div[内容层] > span(图标) + span(文件名)
  const handleTreeContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();

    // 使用 clientX/clientY（视口坐标），与菜单 position: fixed 保持一致
    const openMenu = (node: TreeNode | null) => {
      setContextMenu({ x: e.clientX, y: e.clientY, node });
    };

    const node = resolveNodeFromEventTarget(e.target);

    // 空白区域（未命中任何节点）也弹出菜单：仅启用"新建文件/新建文件夹"，重命名/删除置灰
    if (!node) {
      openMenu(null);
      return;
    }

    // 右键命中的节点若不在多选集合中，先把选中集合收敛为该节点（与 VS Code 行为一致），
    // 这样菜单操作即可作用于整个多选集合。
    if (!selectedPathsRef.current.includes(node.filePath)) {
      selectSingle(node.filePath);
    }
    openMenu(node);
  }, [selectedPathsRef, selectSingle]);

  // 右键菜单的作用目标：命中节点属于多选集合时作用于集合全部节点，否则仅作用于该节点
  const contextTargets = useMemo<TreeNode[]>(() => {
    const node = contextMenu?.node;
    if (!node) return [];
    if (selectedPaths.length > 1 && selectedPaths.includes(node.filePath)) {
      return selectedPaths
        .map(p => findNodeByPath(tree, p))
        .filter((n): n is TreeNode => !!n);
    }
    return [node];
  }, [contextMenu, selectedPaths, tree]);

  // 右键「配置参数」的目标代码文件：递归取每个所选文件夹下的全部代码文件并去重
  const configTargetFiles = useMemo(
    () => resolveConfigTargetFiles(contextTargets, fileTree),
    [contextTargets, fileTree]
  );

  /**
   * 「配置参数」「提交调度」两个菜单项的可见性（两项共用同一判定）。
   *
   * 需要同时满足：
   * 1. **右键目标全部是文件夹** —— 两个功能的作用域都是「文件夹下的全部代码文件」，
   *    单个代码文件/空白处右键/文件夹与文件混选都不显示；
   * 2. **目标位于 code 目录下的数仓分层目录（ads/dws/dwd/ods/dqc/dim）中，含更深子目录** ——
   *    只有这类目录才是 java/scala 程序的归宿，sql/、algo/、code/utils 等目录下不提供，
   *    避免在无关目录上误触发（判定见 utils/programLayout.ts）。
   */
  const canConfigureParams = useMemo(
    () =>
      contextTargets.length > 0 &&
      contextTargets.every(t => t.type === 'Folder' && isUnderCodeLayerPath(t.filePath)),
    [contextTargets]
  );

  // 右键菜单各项依赖的宿主能力
  const menuCapabilities = useMemo(
    () => ({
      createFile: !!onCreateFile,
      createFolder: !!onCreateFolder,
      rename: !!onRenameNode,
      move: !!onMoveNode,
      copy: !!onCopyNode,
      showHistory: !!onShowHistory,
      revert: !!onRevertFile && !!onCheckFileChanged,
    }),
    [onCreateFile, onCreateFolder, onRenameNode, onMoveNode, onCopyNode, onShowHistory, onRevertFile, onCheckFileChanged]
  );

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  // 右键菜单：新建文件/新建文件夹的目标父目录
  const getContextCreateParent = useCallback((): string | null => {
    if (!contextMenu || !rootPath) return null;
    const node = contextMenu.node;
    if (!node) return rootPath; // 空白处右键 -> 根目录
    return node.type === 'Folder' ? node.filePath : getParentDir(node.filePath);
  }, [contextMenu, rootPath]);

  // 右键菜单：选择"新建文件"
  const handleNewFileFromContext = useCallback(() => {
    if (!onCreateFile) return;
    const parentPath = getContextCreateParent();
    if (!parentPath) return;
    setContextMenu(null);
    setCreateTarget(parentPath);
    setIsCreatingFile(true);
    setIsCreatingFolder(false);
    setNewFileName('untitled.tsx');
    setTimeout(() => {
      if (inputRef.current) {
        inputRef.current.focus();
        inputRef.current.select();
      }
    }, 100);
  }, [getContextCreateParent, onCreateFile]);

  // 右键菜单：选择"新建文件夹"
  const handleNewFolderFromContext = useCallback(() => {
    if (!onCreateFolder) return;
    const parentPath = getContextCreateParent();
    if (!parentPath) return;
    setContextMenu(null);
    setCreateTarget(parentPath);
    setIsCreatingFolder(true);
    setIsCreatingFile(false);
    setNewFolderName('新建文件夹');
    setTimeout(() => {
      if (folderInputRef.current) {
        folderInputRef.current.focus();
        folderInputRef.current.select();
      }
    }, 100);
  }, [getContextCreateParent, onCreateFolder]);

  // 右键菜单：选择"重命名"（仅单选时可用）
  const handleRenameFromContext = useCallback(() => {
    if (contextTargets.length !== 1 || !onRenameNode) return;
    const node = contextTargets[0];
    setContextMenu(null);
    setRenameTarget({ filePath: node.filePath, name: node.name, type: node.type });
  }, [contextTargets, onRenameNode]);

  // 请求删除（支持批量：传入多个树节点）
  const requestDeleteNodes = useCallback((nodes: TreeNode[]) => {
    if (nodes.length === 0) return;

    const fileNodes: FileNode[] = nodes.map(node => node.type === 'Folder'
      ? {
          id: node.id,
          name: node.name,
          type: 'folder',
          path: node.filePath,
          children: [],
        }
      : {
          id: node.id,
          name: node.name,
          type: 'file',
          path: node.filePath,
        });

    setDeleteConfirm({ visible: true, nodes: fileNodes });
  }, []);

  // 右键菜单：选择"删除"（支持批量）
  const handleDeleteFromContext = useCallback(() => {
    if (contextTargets.length === 0) return;
    setContextMenu(null);
    requestDeleteNodes(contextTargets);
  }, [contextTargets, requestDeleteNodes]);

  // 右键菜单：查看文件历史版本（仅单选文件）
  const handleShowHistoryFromContext = useCallback(() => {
    if (contextTargets.length !== 1 || !onShowHistory) return;
    setContextMenu(null);
    onShowHistory(contextTargets[0].filePath);
  }, [contextTargets, onShowHistory]);

  // 右键菜单：撤销文件变更（仅单选文件）
  const handleRevertFromContext = useCallback(() => {
    if (contextTargets.length !== 1 || !onRevertFile) return;
    setContextMenu(null);
    onRevertFile(contextTargets[0].filePath);
  }, [contextTargets, onRevertFile]);

  // 右键菜单：配置参数（仅文件夹）。
  // 作用于所选文件夹下的全部代码文件，每个文件最终拿到相同参数。
  const handleConfigureParamsFromContext = useCallback(() => {
    if (configTargetFiles.length === 0) return;
    setContextMenu(null);
    setFolderAction({ kind: 'configParams', files: configTargetFiles });
  }, [configTargetFiles]);

  // 右键菜单：提交调度（仅文件夹）。
  // 弹窗内的任务节点由该文件夹下的代码文件自动生成，无需左侧任务节点类型面板。
  const handleSubmitScheduleFromContext = useCallback(() => {
    if (configTargetFiles.length === 0) return;
    const folder = contextMenu?.node?.filePath;
    if (!folder) return;
    setContextMenu(null);
    setFolderAction({ kind: 'submitSchedule', folder, files: configTargetFiles });
  }, [configTargetFiles, contextMenu]);

  const closeFolderAction = useCallback(() => {
    setFolderAction(null);
  }, []);

  // 右键菜单：选择"移动到 ..."（支持批量）
  const handleMoveFromContext = useCallback(() => {
    if (contextTargets.length === 0 || !onMoveNode) return;
    setContextMenu(null);
    setMoveTargets(contextTargets);
  }, [contextTargets, onMoveNode]);

  // 右键菜单：选择"复制到 ..."
  const handleCopyFromContext = useCallback(() => {
    if (contextTargets.length === 0 || !onCopyNode) return;
    setContextMenu(null);
    setCopyTargets(contextTargets);
  }, [contextTargets, onCopyNode]);

  const closeMoveDialog = useCallback(() => setMoveTargets([]), []);
  const handleMoveComplete = useCallback(() => {
    setMoveTargets([]);
    clearSelection();
  }, [clearSelection]);

  const closeCopyDialog = useCallback(() => setCopyTargets([]), []);
  const handleCopyComplete = useCallback(() => {
    setCopyTargets([]);
    clearSelection();
  }, [clearSelection]);

  const closeDeleteDialog = useCallback(() => {
    setDeleteConfirm({ visible: false, nodes: [] });
  }, []);

  const handleDeleteComplete = useCallback(() => {
    setDeleteConfirm({ visible: false, nodes: [] });
    clearSelection();
  }, [clearSelection]);

  const closeRenameDialog = useCallback(() => setRenameTarget(null), []);

  // ===== Git =====

  const handleOpenGitModal = useCallback(() => {
    if (!rootPath) return;
    setGitModalVisible(true);
  }, [rootPath]);

  const handleCloseGitModal = useCallback(() => {
    setGitModalVisible(false);
  }, []);

  return (
    <aside
      ref={panelRef as React.RefObject<HTMLElement>}
      className={`explorer-panel ${isCollapsed ? 'explorer-panel--collapsed' : ''}`}
      style={isCollapsed ? undefined : style}
    >
      <header className={`explorer-panel__header ${isCollapsed ? 'explorer-panel__header--collapsed' : ''}`}>
        {isCollapsed ? (
          <button
            className="explorer-panel__expand-btn"
            title="展开资源管理器"
            onClick={handleToggle}
          >
            <ChevronLeft size={18} />
          </button>
        ) : (
          <>
            <div className="explorer-panel__actions">
              <>
                <button
                  className="explorer-panel__action-btn"
                  title="折叠"
                  onClick={handleToggle}
                >
                  <ChevronRight size={14} />
                </button>
                <button
                  className="explorer-panel__action-btn"
                  title="新建文件"
                  onClick={handleCreateFileClick}
                >
                  <FilePlus size={14} />
                </button>
                <button
                  className="explorer-panel__action-btn"
                  title="新建文件夹"
                  onClick={handleCreateFolderClick}
                >
                  <FolderPlus size={14} />
                </button>
                <button
                  className="explorer-panel__action-btn"
                  title="Git 管理"
                  onClick={handleOpenGitModal}
                  disabled={!rootPath}
                >
                  <GitCommitHorizontal size={14} />
                </button>
                <button
                  className="explorer-panel__action-btn"
                  title="刷新"
                  onClick={onOpenFolder}
                >
                  <RefreshCw size={14} />
                </button>
              </>
            </div>
          </>
        )}
      </header>

      {!isCollapsed && (
        <>
          {isCreatingFile && (
            <div className="explorer-panel__create-input-wrapper">
              <input
                ref={inputRef}
                type="text"
                className="explorer-panel__create-input"
                value={newFileName}
                onChange={(e) => setNewFileName(e.target.value)}
                onKeyDown={handleKeyPress}
                placeholder="输入文件名..."
              />
              <button
                className="explorer-panel__create-confirm"
                onClick={handleCreateFileSubmit}
                title="确认创建"
              >
                <Check size={16} />
              </button>
            </div>
          )}

          {isCreatingFolder && (
            <div className="explorer-panel__create-input-wrapper">
              <input
                ref={folderInputRef}
                type="text"
                className="explorer-panel__create-input"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={handleKeyPress}
                placeholder="输入文件夹名称..."
              />
              <button
                className="explorer-panel__create-confirm"
                onClick={handleCreateFolderSubmit}
                title="确认创建"
              >
                <Check size={16} />
              </button>
            </div>
          )}

          <div className="explorer-panel__content">
            {rootPath ? (
              <div
                className="file-navigator-wrapper"
                onContextMenu={handleTreeContextMenu}
                onKeyDown={handleTreeKeyDown}
              >
                <Explorer
                  tree={tree}
                  setTree={handleSetTree}
                  iconMap={iconMap}
                  onFileSelectionChange={handleFileSelectionChange}
                  config={explorerConfig}
                />
              </div>
            ) : (
              <div className="explorer-panel__empty-state">
                <svg
                  width="64"
                  height="64"
                  viewBox="0 0 64 64"
                  fill="none"
                  style={{ marginBottom: 16, opacity: 0.3 }}
                >
                  <path
                    d="M8 16C8 13.7909 9.79086 12 12 12H28L32 16H52C54.2091 16 56 17.7909 56 20V48C56 50.2091 54.2091 52 52 52H12C9.79086 52 8 50.2091 8 48V16Z"
                    stroke="#858585"
                    strokeWidth="2"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M8 20H56V48C56 50.2091 54.2091 52 52 52H12C9.79086 52 8 50.2091 8 48V20Z"
                    fill="#2d2d2d"
                    stroke="#858585"
                    strokeWidth="2"
                  />
                  <line
                    x1="22" y1="30" x2="42" y2="30"
                    stroke="#858585"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                  <line
                    x1="22" y1="38" x2="38" y2="38"
                    stroke="#858585"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
                <p className="explorer-panel__empty-text">未打开文件夹</p>
                <button
                  className="explorer-panel__open-folder-btn"
                  onClick={onOpenFolder}
                  disabled={isLoading}
                >
                  <FolderOpen size={14} style={{ marginRight: 6 }} />
                  {isLoading ? '加载中...' : '打开文件夹'}
                </button>
              </div>
            )}
          </div>

          {rootPath && (
            <footer className="explorer-panel__footer">
              <span className="explorer-panel__path" title={rootPath}>
                {rootPath.split(/[/\\]/).pop() || rootPath}
              </span>
              {selectedPaths.length > 1 && (
                <span className="explorer-panel__selection-count">已选中 {selectedPaths.length} 项</span>
              )}
            </footer>
          )}
        </>
      )}

      <GitModal
        visible={gitModalVisible}
        rootPath={rootPath}
        onClose={handleCloseGitModal}
        onAISummarize={onAISummarize}
        onBeforeCommit={onBeforeCommit}
        onDiscarded={onDiscarded}
        onCommitted={() => {
          // 提交/拉取/回滚后可触发外部刷新（如需刷新文件树可在此回调）
        }}
      />

      {/* 「配置参数」「提交调度」弹窗的跨模块接线（devProject / DolphinScheduler / 编译环境） */}
      <FolderActionModals
        action={folderAction}
        rootPath={rootPath}
        projectRoot={projectRoot}
        projectId={projectId}
        projectCode={projectCode}
        openlineageTransportUrl={openlineageTransportUrl}
        readFileContent={readFileContent}
        onSaveConfigParams={onSaveConfigParams}
        dsApi={dsApi}
        isRealApi={isRealApi}
        compileConfig={compileConfig}
        onClose={closeFolderAction}
      />

      {deleteConfirm.visible && deleteConfirm.nodes.length > 0 && (
        <DeleteConfirmDialog
          nodes={deleteConfirm.nodes}
          onDeleteNode={onDeleteNode}
          onCancel={closeDeleteDialog}
          onComplete={handleDeleteComplete}
        />
      )}

      {/* 右键菜单 */}
      {contextMenu && (
        <ExplorerContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          targets={contextTargets}
          canConfigureParams={canConfigureParams}
          configTargetFileCount={configTargetFiles.length}
          projectId={projectId}
          dsApi={dsApi}
          onCheckFileChanged={onCheckFileChanged}
          capabilities={menuCapabilities}
          onClose={closeContextMenu}
          onNewFile={handleNewFileFromContext}
          onNewFolder={handleNewFolderFromContext}
          onRename={handleRenameFromContext}
          onMove={handleMoveFromContext}
          onCopy={handleCopyFromContext}
          onConfigureParams={handleConfigureParamsFromContext}
          onSubmitSchedule={handleSubmitScheduleFromContext}
          onShowHistory={handleShowHistoryFromContext}
          onRevert={handleRevertFromContext}
          onDelete={handleDeleteFromContext}
        />
      )}

      {/* 重命名输入框 */}
      {renameTarget && onRenameNode && (
        <RenameDialog node={renameTarget} onRenameNode={onRenameNode} onClose={closeRenameDialog} />
      )}

      {/* 移动对话框 */}
      {moveTargets.length > 0 && onMoveNode && (
        <MoveCopyDialog
          mode="move"
          targets={moveTargets}
          fileTree={fileTree}
          rootPath={rootPath}
          onAction={onMoveNode}
          onClose={closeMoveDialog}
          onComplete={handleMoveComplete}
        />
      )}

      {/* 复制对话框（复用与移动相同的目录树选择 UI） */}
      {copyTargets.length > 0 && onCopyNode && (
        <MoveCopyDialog
          mode="copy"
          targets={copyTargets}
          fileTree={fileTree}
          rootPath={rootPath}
          onAction={onCopyNode}
          onClose={closeCopyDialog}
          onComplete={handleCopyComplete}
        />
      )}
    </aside>
  );
};

export default ExplorerPanel;
