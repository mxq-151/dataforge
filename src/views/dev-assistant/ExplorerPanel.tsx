import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  FolderOpen,
  RefreshCw,
  FilePlus,
  FolderPlus,
  ChevronRight,
  ChevronLeft,
  ChevronDown,
  GitCommitHorizontal,
  X,
  Check,
  AlertTriangle,
  Trash2,
  File,
  Folder,
  FileCode,
  FileJson,
  FileText,
  Image,
  Pencil,
  Move,
  Copy,
  History,
} from 'lucide-react';
import { Explorer } from 'react-file-navigator';
import type { Tree, TreeNode, IconMap, ExplorerConfig } from 'react-file-navigator';
import GitModal from './GitModal';
import { FileNode } from '../../types';
import { useToast } from '../../components/Toast';
import './ExplorerPanel.css';

interface DeleteConfirmState {
  visible: boolean;
  node: FileNode | null;
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
  onAISummarize?: (files: string[], diffs: string) => Promise<string>;
  onBeforeCommit?: () => { valid: boolean; message: string | null };
  style?: React.CSSProperties;
  onCollapsedChange?: (collapsed: boolean) => void;
}

const convertFileNodesToTree = (
  nodes: FileNode[],
  expandedPaths: Set<string>
): Tree => {
  return nodes.map(node => {
    if (node.type === 'folder') {
      const isExpanded = expandedPaths.has(node.path);
      return {
        id: node.id,
        type: 'Folder' as const,
        filePath: node.path,
        expanded: isExpanded,
        icon: isExpanded ? 'folderExpanded' : 'folderCollapsed',
        name: node.name,
        children: node.children ? convertFileNodesToTree(node.children, expandedPaths) : [],
      };
    } else {
      const ext = node.name.split('.').pop()?.toLowerCase() || '';
      return {
        id: node.id,
        type: 'File' as const,
        filePath: node.path,
        extension: ext,
        icon: ext || 'default',
        name: node.name,
      };
    }
  });
};

const extractExpandedPaths = (tree: Tree): Set<string> => {
  const paths = new Set<string>();
  const traverse = (nodes: Tree) => {
    for (const node of nodes) {
      if (node.type === 'Folder') {
        if (node.expanded) {
          paths.add(node.filePath);
        }
        if (node.children) {
          traverse(node.children);
        }
      }
    }
  };
  traverse(tree);
  return paths;
};

// 计算文件路径的父目录（兼容 '/' 与 '\' 分隔符）
const getParentDir = (filePath: string): string => {
  const sep = filePath.includes('/') ? '/' : '\\';
  const idx = filePath.lastIndexOf(sep);
  return idx >= 0 ? filePath.substring(0, idx) : filePath;
};

const iconMap: IconMap = {
  default: <File size={16} style={{ color: '#cccccc' }} />,
  folderCollapsed: (
    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
      <ChevronRight size={14} style={{ color: '#858585', marginRight: 2 }} />
      <Folder size={16} style={{ color: '#dcb67a' }} />
    </span>
  ),
  folderExpanded: (
    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
      <ChevronDown size={14} style={{ color: '#858585', marginRight: 2 }} />
      <FolderOpen size={16} style={{ color: '#dcb67a' }} />
    </span>
  ),
  ts: <FileCode size={16} style={{ color: '#519aba' }} />,
  tsx: <FileCode size={16} style={{ color: '#519aba' }} />,
  js: <FileCode size={16} style={{ color: '#519aba' }} />,
  jsx: <FileCode size={16} style={{ color: '#519aba' }} />,
  json: <FileJson size={16} style={{ color: '#f5de50' }} />,
  md: <FileText size={16} style={{ color: '#cccccc' }} />,
  txt: <FileText size={16} style={{ color: '#cccccc' }} />,
  png: <Image size={16} style={{ color: '#a07c3c' }} />,
  jpg: <Image size={16} style={{ color: '#a07c3c' }} />,
  jpeg: <Image size={16} style={{ color: '#a07c3c' }} />,
  gif: <Image size={16} style={{ color: '#a07c3c' }} />,
  svg: <Image size={16} style={{ color: '#a07c3c' }} />,
  sql: <FileCode size={16} style={{ color: '#e2c08d' }} />,
  py: <FileCode size={16} style={{ color: '#4EC9B0' }} />,
  java: <FileCode size={16} style={{ color: '#b8383d' }} />,
  scala: <FileCode size={16} style={{ color: '#de3423' }} />,
  css: <FileCode size={16} style={{ color: '#563d7c' }} />,
  scss: <FileCode size={16} style={{ color: '#c6538c' }} />,
  html: <FileCode size={16} style={{ color: '#e34c26' }} />,
  xml: <FileCode size={16} style={{ color: '#f26522' }} />,
  yml: <FileText size={16} style={{ color: '#cb171e' }} />,
  yaml: <FileText size={16} style={{ color: '#cb171e' }} />,
  sh: <FileText size={16} style={{ color: '#89e051' }} />,
};

const explorerConfig: ExplorerConfig = {
  label: '',
  fontColor: '#cccccc',
  accentColor: '#094771',
  fontSize: '13px',
  iconSize: '16px',
  disableActions: true,
  rename: 'None' as any,
  delete: 'None' as any,
};

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
  onAISummarize,
  onBeforeCommit,
  style,
  onCollapsedChange,
}) => {
  const toast = useToast();
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isCreatingFile, setIsCreatingFile] = useState(false);
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [newFolderName, setNewFolderName] = useState('');
  // 新建文件/文件夹的目标父目录：null 表示根目录(rootPath)，右键菜单创建时指向对应目录
  const [createTarget, setCreateTarget] = useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const folderInputRef = React.useRef<HTMLInputElement>(null);

  // 通知父组件折叠状态变化
  useEffect(() => {
    onCollapsedChange?.(isCollapsed);
  }, [isCollapsed, onCollapsedChange]);

  // 右键菜单状态
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; node: TreeNode | null } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // 重命名状态
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [renamingNode, setRenamingNode] = useState<{ filePath: string; name: string; type: string } | null>(null);
  const renameInputRef = React.useRef<HTMLInputElement>(null);

  const [gitModalVisible, setGitModalVisible] = useState(false);

  // 移动对话框状态
  const [moveTarget, setMoveTarget] = useState<{ node: TreeNode } | null>(null);
  const [selectedMoveDir, setSelectedMoveDir] = useState<string | null>(null);
  const [moveExpanded, setMoveExpanded] = useState<Set<string>>(new Set());
  const [isMoving, setIsMoving] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const moveTreeRef = useRef<HTMLDivElement>(null);

  // 复制对话框状态（复用移动的目录树选择 UI）
  const [copyTarget, setCopyTarget] = useState<{ node: TreeNode } | null>(null);
  const [selectedCopyDir, setSelectedCopyDir] = useState<string | null>(null);
  const [copyExpanded, setCopyExpanded] = useState<Set<string>>(new Set());
  const [isCopying, setIsCopying] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmState>({
    visible: false,
    node: null,
  });
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [tree, setTree] = useState<Tree>([]);
  const treeRef = useRef<Tree>([]);
  const currentSelectedNodeRef = useRef<TreeNode | null>(null);

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
      setTimeout(addTitles, 50);
    });
    observer.observe(wrapper, { childList: true, subtree: true });

    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [tree]);

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

  const handleFileSelectionChange = useCallback((node: TreeNode | null) => {
    currentSelectedNodeRef.current = node;
    if (node && node.type === 'File') {
      onFileSelect(node.filePath);
    }
  }, [onFileSelect]);

  const handleToggle = () => {
    setIsCollapsed(!isCollapsed);
    setIsCreatingFile(false);
    setNewFileName('');
  };

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
    }

    setIsCreatingFile(false);
    setNewFileName('');
  }, [newFileName, rootPath, createTarget, onCreateFile, onFileSelect]);

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

  const handleDeleteNodeRequest = useCallback(() => {
    const node = currentSelectedNodeRef.current;
    if (!node) return;

    const fileNode: FileNode = node.type === 'Folder'
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
        };

    setDeleteError(null);
    setDeleteConfirm({ visible: true, node: fileNode });
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteConfirm.node || !onDeleteNode) return;

    setIsDeleting(true);
    setDeleteError(null);
    try {
      const success = await onDeleteNode(deleteConfirm.node.path, deleteConfirm.node.type);
      if (success) {
        setDeleteConfirm({ visible: false, node: null });
      } else {
        setDeleteError('删除失败，请检查文件是否正在使用或权限不足');
      }
    } catch {
      setDeleteError('删除时发生错误');
    } finally {
      setIsDeleting(false);
    }
  }, [deleteConfirm.node, onDeleteNode]);

  const handleDeleteCancel = useCallback(() => {
    setDeleteConfirm({ visible: false, node: null });
    setDeleteError(null);
  }, []);

  // 右键菜单：关闭（点击外部）
  useEffect(() => {
    if (!contextMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [contextMenu]);

  // 右键菜单：渲染后按窗口边界校正位置，避免溢出 app 视口
  const contextMenuAdjustedRef = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!contextMenu || !contextMenuRef.current) return;
    // 避免校正后 setState 再触发本 effect 导致循环
    const last = contextMenuAdjustedRef.current;
    if (last && last.x === contextMenu.x && last.y === contextMenu.y) return;

    const el = contextMenuRef.current;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const margin = 4;

    let nx = contextMenu.x;
    let ny = contextMenu.y;

    if (nx + w > vw - margin) nx = Math.max(margin, vw - w - margin);
    if (ny + h > vh - margin) ny = Math.max(margin, vh - h - margin);
    if (nx < margin) nx = margin;
    if (ny < margin) ny = margin;

    if (nx !== contextMenu.x || ny !== contextMenu.y) {
      contextMenuAdjustedRef.current = { x: nx, y: ny };
      setContextMenu(prev => prev ? { ...prev, x: nx, y: ny } : prev);
    } else {
      contextMenuAdjustedRef.current = { x: nx, y: ny };
    }
  }, [contextMenu]);

  // 右键菜单：处理文件树节点上的右键事件
  // react-file-navigator 的 FileTree 渲染的 DOM 层级为：
  //   div[draggable] > div[draggable, 节点行] > div[tabIndex=1, 交互层] > div[内容层] > span(图标) + span(文件名)
  const handleTreeContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const target = e.target as HTMLElement;

    // 空白区域（未命中任何节点）也弹出菜单：仅启用"新建文件/新建文件夹"，重命名/删除置灰
    // 使用 clientX/clientY（视口坐标），与菜单 position: fixed 保持一致
    const openMenu = (node: TreeNode | null) => {
      contextMenuAdjustedRef.current = null;
      setContextMenu({ x: e.clientX, y: e.clientY, node });
    };

    // 向上遍历找到有 tabIndex 的交互层 div
    let el: HTMLElement | null = target;
    for (let i = 0; i < 8 && el; i++) {
      if (el.hasAttribute('tabindex')) {
        break;
      }
      el = el.parentElement;
    }

    if (!el || !el.hasAttribute('tabindex')) {
      openMenu(null);
      return;
    }

    // 在交互层中找最后一个纯文本 span（即文件名）
    // 结构: div(内容层) > span(图标) + span(文件名)
    const allSpans = el.querySelectorAll('span');
    let nodeName: string | null = null;
    for (let j = allSpans.length - 1; j >= 0; j--) {
      const text = allSpans[j].textContent?.trim();
      // 纯文本 span：有内容、长度合理、不包含子元素
      if (text && text.length > 0 && text.length < 100 && !allSpans[j].querySelector('*')) {
        nodeName = text;
        break;
      }
    }

    if (!nodeName) {
      openMenu(null);
      return;
    }

    // 在 tree 中按名称查找对应的 TreeNode
    const findNodeByName = (nodes: TreeNode[], name: string): TreeNode | null => {
      for (const n of nodes) {
        if (n.name === name) return n;
        if ('children' in n && n.children) {
          const found = findNodeByName(n.children, name);
          if (found) return found;
        }
      }
      return null;
    };

    const node = findNodeByName(treeRef.current, nodeName);
    if (node) {
      contextMenuAdjustedRef.current = null;
      setContextMenu({ x: e.clientX, y: e.clientY, node });
    } else {
      openMenu(null);
    }
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

  // 右键菜单：选择"重命名"
  const handleRenameFromContext = useCallback(() => {
    if (!contextMenu || !contextMenu.node || !onRenameNode) return;
    const node = contextMenu.node;
    setRenameValue(node.name);
    setRenamingNode({ filePath: node.filePath, name: node.name, type: node.type });
    setIsRenaming(true);
    setContextMenu(null);
    setTimeout(() => {
      if (renameInputRef.current) {
        renameInputRef.current.focus();
        renameInputRef.current.select();
      }
    }, 100);
  }, [contextMenu, onRenameNode]);

  // 右键菜单：选择"删除"
  const handleDeleteFromContext = useCallback(() => {
    if (!contextMenu || !contextMenu.node) return;
    currentSelectedNodeRef.current = contextMenu.node;
    setContextMenu(null);
    handleDeleteNodeRequest();
  }, [contextMenu, handleDeleteNodeRequest]);

  // 右键菜单：查看文件历史版本
  const handleShowHistoryFromContext = useCallback(() => {
    if (!contextMenu || !contextMenu.node || !onShowHistory) return;
    const node = contextMenu.node;
    setContextMenu(null);
    onShowHistory(node.filePath);
  }, [contextMenu, onShowHistory]);

  // 重命名：提交
  const handleRenameSubmit = useCallback(async () => {
    if (!renameValue.trim() || !renamingNode || !onRenameNode) return;

    const success = await onRenameNode(
      renamingNode.filePath,
      renameValue.trim(),
      renamingNode.type === 'Folder' ? 'folder' : 'file'
    );

    if (success) {
      toast.info('重命名成功');
    } else {
      toast.error('重命名失败');
    }

    setIsRenaming(false);
    setRenameValue('');
    setRenamingNode(null);
  }, [renameValue, renamingNode, onRenameNode, toast]);

  // 重命名：取消
  const handleRenameCancel = useCallback(() => {
    setIsRenaming(false);
    setRenameValue('');
    setRenamingNode(null);
  }, []);

  // 右键菜单：选择"移动到 ..."
  const handleMoveFromContext = useCallback(() => {
    if (!contextMenu || !contextMenu.node || !onMoveNode) return;
    // 默认选中源节点的父目录或项目根目录
    const defaultTarget = getParentDir(contextMenu.node.filePath);
    setMoveTarget({ node: contextMenu.node });
    setSelectedMoveDir(rootPath && defaultTarget && rootPath !== defaultTarget && defaultTarget.startsWith(rootPath)
      ? defaultTarget
      : rootPath);
    setMoveExpanded(new Set());
    setMoveError(null);
    setContextMenu(null);
  }, [contextMenu, onMoveNode, rootPath]);

  // 移动目录树：展开/折叠
  const toggleMoveDir = useCallback((path: string) => {
    setMoveExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // 移动：选中目标目录
  const handleMoveSelectDir = useCallback((path: string) => {
    setSelectedMoveDir(path);
    setMoveError(null);
  }, []);

  // 移动：提交
  const handleMoveSubmit = useCallback(async () => {
    if (!moveTarget || !onMoveNode) return;
    const node = moveTarget.node;

    if (!selectedMoveDir) {
      setMoveError('请选择目标文件夹');
      return;
    }

    setIsMoving(true);
    setMoveError(null);
    try {
      const success = await onMoveNode(
        node.filePath,
        selectedMoveDir,
        node.type === 'Folder' ? 'folder' : 'file'
      );
      if (success) {
        toast.info(`已移动「${node.name}」`);
        setMoveTarget(null);
        setSelectedMoveDir(null);
        setMoveExpanded(new Set());
      } else {
        setMoveError('移动失败：目标文件夹无效、不存在或与源位置冲突');
      }
    } catch {
      setMoveError('移动时发生错误');
    } finally {
      setIsMoving(false);
    }
  }, [moveTarget, selectedMoveDir, onMoveNode, toast]);

  // 移动：取消
  const handleMoveCancel = useCallback(() => {
    if (isMoving) return;
    setMoveTarget(null);
    setSelectedMoveDir(null);
    setMoveExpanded(new Set());
    setMoveError(null);
  }, [isMoving]);

  // 右键菜单：选择"复制到 ..."
  const handleCopyFromContext = useCallback(() => {
    if (!contextMenu || !contextMenu.node || !onCopyNode) return;
    const node = contextMenu.node;
    const defaultTarget = getParentDir(node.filePath);
    setCopyTarget({ node });
    setSelectedCopyDir(rootPath && defaultTarget && rootPath !== defaultTarget && defaultTarget.startsWith(rootPath)
      ? defaultTarget
      : rootPath);
    setCopyExpanded(new Set());
    setCopyError(null);
    setContextMenu(null);
  }, [contextMenu, onCopyNode, rootPath]);

  // 复制目录树：展开/折叠
  const toggleCopyDir = useCallback((path: string) => {
    setCopyExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // 复制：选中目标目录
  const handleCopySelectDir = useCallback((path: string) => {
    setSelectedCopyDir(path);
    setCopyError(null);
  }, []);

  // 复制：提交
  const handleCopySubmit = useCallback(async () => {
    if (!copyTarget || !onCopyNode) return;
    const node = copyTarget.node;

    if (!selectedCopyDir) {
      setCopyError('请选择目标文件夹');
      return;
    }

    setIsCopying(true);
    setCopyError(null);
    try {
      const success = await onCopyNode(
        node.filePath,
        selectedCopyDir,
        node.type === 'Folder' ? 'folder' : 'file'
      );
      if (success) {
        toast.info(`已复制「${node.name}」`);
        setCopyTarget(null);
        setSelectedCopyDir(null);
        setCopyExpanded(new Set());
      } else {
        setCopyError('复制失败：目标文件夹无效、不存在或与源位置冲突');
      }
    } catch {
      setCopyError('复制时发生错误');
    } finally {
      setIsCopying(false);
    }
  }, [copyTarget, selectedCopyDir, onCopyNode, toast]);

  // 复制：取消
  const handleCopyCancel = useCallback(() => {
    if (isCopying) return;
    setCopyTarget(null);
    setSelectedCopyDir(null);
    setCopyExpanded(new Set());
    setCopyError(null);
  }, [isCopying]);

  const handleOpenGitModal = useCallback(() => {
    if (!rootPath) return;
    setGitModalVisible(true);
  }, [rootPath]);

  const handleCloseGitModal = useCallback(() => {
    setGitModalVisible(false);
  }, []);

  return (
    <aside
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
              <div className="file-navigator-wrapper" onContextMenu={handleTreeContextMenu}>
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
        onCommitted={() => {
          // 提交/拉取/回滚后可触发外部刷新（如需刷新文件树可在此回调）
        }}
      />

      {deleteConfirm.visible && deleteConfirm.node && (
        <div className="explorer-panel__delete-overlay" onClick={handleDeleteCancel}>
          <div className="explorer-panel__delete-dialog" onClick={e => e.stopPropagation()}>
            <div className="explorer-panel__delete-dialog-header">
              <AlertTriangle size={20} className="explorer-panel__delete-dialog-icon" />
              <span>确认删除</span>
            </div>
            <div className="explorer-panel__delete-dialog-body">
              <p>
                确定要删除{deleteConfirm.node.type === 'folder' ? '文件夹' : '文件'}
                <strong> {deleteConfirm.node.name} </strong>
                吗？
              </p>
              {deleteConfirm.node.type === 'folder' && (
                <p className="explorer-panel__delete-dialog-warning">
                  文件夹内的所有内容将被一并删除，此操作不可撤销。
                </p>
              )}
              {deleteConfirm.node.type === 'file' && (
                <p className="explorer-panel__delete-dialog-warning">
                  此操作不可撤销。
                </p>
              )}
              {deleteError && (
                <p className="explorer-panel__delete-dialog-error">{deleteError}</p>
              )}
            </div>
            <div className="explorer-panel__delete-dialog-footer">
              <button
                className="explorer-panel__delete-dialog-btn explorer-panel__delete-dialog-btn--cancel"
                onClick={handleDeleteCancel}
                disabled={isDeleting}
              >
                取消
              </button>
              <button
                className="explorer-panel__delete-dialog-btn explorer-panel__delete-dialog-btn--confirm"
                onClick={handleDeleteConfirm}
                disabled={isDeleting}
              >
                {isDeleting ? '删除中...' : '删除'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 右键菜单 */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="explorer-panel__context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            className="explorer-panel__context-menu-item"
            onClick={handleNewFileFromContext}
            disabled={!onCreateFile}
          >
            <FilePlus size={14} />
            <span>新建文件</span>
          </button>
          <button
            className="explorer-panel__context-menu-item"
            onClick={handleNewFolderFromContext}
            disabled={!onCreateFolder}
          >
            <FolderPlus size={14} />
            <span>新建文件夹</span>
          </button>
          <div className="explorer-panel__context-menu-divider" />
          <button
            className="explorer-panel__context-menu-item"
            onClick={handleRenameFromContext}
            disabled={!onRenameNode || !contextMenu.node}
          >
            <Pencil size={14} />
            <span>重命名</span>
          </button>
          <button
            className="explorer-panel__context-menu-item"
            onClick={handleMoveFromContext}
            disabled={!onMoveNode || !contextMenu.node}
          >
            <Move size={14} />
            <span>移动到 ...</span>
          </button>
          <button
            className="explorer-panel__context-menu-item"
            onClick={handleCopyFromContext}
            disabled={!onCopyNode || !contextMenu.node}
          >
            <Copy size={14} />
            <span>复制到 ...</span>
          </button>
          <div className="explorer-panel__context-menu-divider" />
          {contextMenu?.node?.type === 'File' && (
            <button
              className="explorer-panel__context-menu-item"
              onClick={handleShowHistoryFromContext}
              disabled={!onShowHistory}
            >
              <History size={14} />
              <span>历史版本</span>
            </button>
          )}
          <button
            className="explorer-panel__context-menu-item explorer-panel__context-menu-item--danger"
            onClick={handleDeleteFromContext}
            disabled={!contextMenu.node}
          >
            <Trash2 size={14} />
            <span>删除</span>
          </button>
        </div>
      )}

      {/* 重命名输入框 */}
      {isRenaming && (
        <div className="explorer-panel__rename-overlay" onClick={handleRenameCancel}>
          <div className="explorer-panel__rename-input-wrapper" onClick={e => e.stopPropagation()}>
            <input
              ref={renameInputRef}
              type="text"
              className="explorer-panel__rename-input"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRenameSubmit();
                if (e.key === 'Escape') handleRenameCancel();
              }}
            />
            <button
              className="explorer-panel__rename-confirm"
              onMouseDown={(e) => { e.preventDefault(); handleRenameSubmit(); }}
              title="确认重命名"
            >
              <Check size={16} />
            </button>
            <button
              className="explorer-panel__rename-cancel"
              onMouseDown={(e) => { e.preventDefault(); handleRenameCancel(); }}
              title="取消"
            >
              <X size={16} />
            </button>
          </div>
        </div>
      )}

      {/* 移动对话框 */}
      {moveTarget && (
        <div className="explorer-panel__move-overlay" onClick={handleMoveCancel}>
          <div className="explorer-panel__move-dialog" onClick={e => e.stopPropagation()}>
            <div className="explorer-panel__move-dialog-header">
              <Move size={18} className="explorer-panel__move-dialog-icon" />
              <span>移动到</span>
            </div>
            <div className="explorer-panel__move-dialog-body">
              <div className="explorer-panel__move-dialog-node">
                移动{moveTarget.node.type === 'Folder' ? '文件夹' : '文件'}
                <strong> {moveTarget.node.name} </strong>
              </div>
              <p className="explorer-panel__move-dialog-tip">
                请在下方选择目标文件夹：
              </p>
              <div className="explorer-panel__move-tree" ref={moveTreeRef}>
                {renderMoveDirTree(
                  fileTree,
                  selectedMoveDir,
                  moveTarget.node.filePath,
                  moveExpanded,
                  handleMoveSelectDir,
                  toggleMoveDir
                )}
                {fileTree.length === 0 && (
                  <div className="explorer-panel__move-tree-empty">目录为空</div>
                )}
              </div>
              {moveError && (
                <p className="explorer-panel__move-dialog-error">{moveError}</p>
              )}
            </div>
            <div className="explorer-panel__move-dialog-footer">
              <span className="explorer-panel__move-target-path" title={selectedMoveDir || ''}>
                {selectedMoveDir || '未选择目录'}
              </span>
              <div className="explorer-panel__move-dialog-actions">
                <button
                  className="explorer-panel__move-dialog-btn explorer-panel__move-dialog-btn--cancel"
                  onClick={handleMoveCancel}
                  disabled={isMoving}
                >
                  取消
                </button>
                <button
                  className="explorer-panel__move-dialog-btn explorer-panel__move-dialog-btn--confirm"
                  onClick={handleMoveSubmit}
                  disabled={isMoving || !selectedMoveDir}
                >
                  {isMoving ? '移动中...' : '移动'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 复制对话框（复用与移动相同的目录树选择 UI） */}
      {copyTarget && (
        <div className="explorer-panel__move-overlay" onClick={handleCopyCancel}>
          <div className="explorer-panel__move-dialog" onClick={e => e.stopPropagation()}>
            <div className="explorer-panel__move-dialog-header">
              <Copy size={18} className="explorer-panel__move-dialog-icon explorer-panel__move-dialog-icon--copy" />
              <span>复制到</span>
            </div>
            <div className="explorer-panel__move-dialog-body">
              <div className="explorer-panel__move-dialog-node">
                复制{copyTarget.node.type === 'Folder' ? '文件夹' : '文件'}
                <strong> {copyTarget.node.name} </strong>
              </div>
              <p className="explorer-panel__move-dialog-tip">
                请在下方选择目标文件夹（重名时自动追加"副本"后缀）：
              </p>
              <div className="explorer-panel__move-tree">
                {renderMoveDirTree(
                  fileTree,
                  selectedCopyDir,
                  copyTarget.node.filePath,
                  copyExpanded,
                  handleCopySelectDir,
                  toggleCopyDir
                )}
                {fileTree.length === 0 && (
                  <div className="explorer-panel__move-tree-empty">目录为空</div>
                )}
              </div>
              {copyError && (
                <p className="explorer-panel__move-dialog-error">{copyError}</p>
              )}
            </div>
            <div className="explorer-panel__move-dialog-footer">
              <span className="explorer-panel__move-target-path" title={selectedCopyDir || ''}>
                {selectedCopyDir || '未选择目录'}
              </span>
              <div className="explorer-panel__move-dialog-actions">
                <button
                  className="explorer-panel__move-dialog-btn explorer-panel__move-dialog-btn--cancel"
                  onClick={handleCopyCancel}
                  disabled={isCopying}
                >
                  取消
                </button>
                <button
                  className="explorer-panel__move-dialog-btn explorer-panel__move-dialog-btn--confirm"
                  onClick={handleCopySubmit}
                  disabled={isCopying || !selectedCopyDir}
                >
                  {isCopying ? '复制中...' : '复制'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
};

// 移动目标目录选择树：递归渲染目录节点（只展示文件夹），可展开/折叠、点击选中。
// srcPath 为被移动的节点路径，用于将该节点自身及其子目录禁用、避免移动到自身内部。
const renderMoveDirTree = (
  nodes: FileNode[],
  selectedDir: string | null,
  srcPath: string,
  expanded: Set<string>,
  onSelect: (path: string) => void,
  onToggle: (path: string) => void,
  depth = 0
): React.ReactNode => {
  const folders = nodes.filter(n => n.type === 'folder');
  if (folders.length === 0) return null;

  return folders.map(node => {
    // 目标目录不能是被移动节点本身或其子目录
    const disabled = srcPath === node.path || node.path.startsWith(srcPath.endsWith('/') || srcPath.endsWith('\\') ? srcPath : srcPath + getSeparator(node.path));
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
            {renderMoveDirTree(node.children, selectedDir, srcPath, expanded, onSelect, onToggle, depth + 1)}
          </div>
        )}
      </div>
    );
  });
};

const getSeparator = (path: string): string => (path.includes('\\') ? '\\' : '/');

export default ExplorerPanel;
