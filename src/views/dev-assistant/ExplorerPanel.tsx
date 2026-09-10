import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
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
  Undo2,
  Sliders,
} from 'lucide-react';
import { Explorer } from 'react-file-navigator';
import type { Tree, TreeNode, IconMap, ExplorerConfig } from 'react-file-navigator';
import GitModal from './GitModal';
import ConfigParamsModal from '../../components/editor/ConfigParamsModal';
import { FileNode } from '../../types';
import { useToast } from '../../components/Toast';
import './ExplorerPanel.css';

interface DeleteConfirmState {
  visible: boolean;
  nodes: FileNode[];
}

/** 按「当前可见顺序」摊平文件树：文件夹仅在展开时才包含其子项。
 *  该顺序与 react-file-navigator 渲染出的 div[tabindex] 行顺序严格一致，
 *  因此可以用 DOM 行下标反查对应的树节点（比按文件名匹配更可靠，重名也不会出错）。 */
const flattenVisibleNodes = (nodes: TreeNode[]): TreeNode[] => {
  const result: TreeNode[] = [];
  const walk = (list: TreeNode[]) => {
    for (const node of list) {
      result.push(node);
      if (node.type === 'Folder' && node.children && node.children.length > 0 && node.expanded) {
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return result;
};

/** 在完整文件树中按路径查找节点（不要求处于展开状态） */
const findNodeByPath = (nodes: TreeNode[], path: string): TreeNode | null => {
  for (const node of nodes) {
    if (node.filePath === path) return node;
    if (node.type === 'Folder' && node.children) {
      const found = findNodeByPath(node.children, path);
      if (found) return found;
    }
  }
  return null;
};

/** 收集 FileNode 树中所有节点路径（用于刷新后清理已失效的选中项） */
const collectAllPaths = (nodes: FileNode[]): string[] => {
  const result: string[] = [];
  const walk = (list: FileNode[]) => {
    for (const node of list) {
      result.push(node.path);
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return result;
};

/** 代码文件扩展名集合：批量配置参数只对这些文件生效 */
const CODE_FILE_EXTENSIONS = new Set(['scala', 'sql', 'java', 'py']);

const isCodeFilePath = (filePath: string): boolean =>
  CODE_FILE_EXTENSIONS.has(filePath.split('.').pop()?.toLowerCase() || '');

/** 在 FileNode 树中按路径查找节点 */
const findFileNodeByPath = (nodes: FileNode[], path: string): FileNode | null => {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.children) {
      const found = findFileNodeByPath(node.children, path);
      if (found) return found;
    }
  }
  return null;
};

/**
 * 递归收集某个 FileNode 子树下的全部代码文件路径。
 *
 * 注意递归的是 fileTree（useFileSystem.buildFileTree 一次性构建的完整树），
 * 而不是右键拿到的 TreeNode —— 后者虽然也带 children，但语义属于渲染层，
 * 这里以数据源为准更稳妥，且折叠状态不影响结果。
 */
const collectCodeFilesUnder = (node: FileNode, out: string[]) => {
  if (node.type === 'file') {
    if (isCodeFilePath(node.path)) out.push(node.path);
    return;
  }
  node.children?.forEach(child => collectCodeFilesUnder(child, out));
};

/**
 * 把右键目标折算成「待统一配置参数的代码文件」列表：递归计入每个文件夹下的全部代码文件，
 * 多选时合并去重。
 *
 * 只处理文件夹：本功能的语义是「为某个文件夹下的所有代码文件配置相同参数」，
 * 单个代码文件不提供该菜单项（见调用处的 canConfigureParams 判定）。
 */
const resolveConfigTargetFiles = (targets: TreeNode[], fileTree: FileNode[]): string[] => {
  const result: string[] = [];
  for (const target of targets) {
    if (target.type !== 'Folder') continue;
    const folderNode = findFileNodeByPath(fileTree, target.filePath);
    if (folderNode) collectCodeFilesUnder(folderNode, result);
  }
  return Array.from(new Set(result));
};

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
  onAISummarize?: (files: string[], diffs: string) => Promise<string>;
  onBeforeCommit?: () => { valid: boolean; message: string | null };
  /** Git 模态框撤销变更成功后的回调，入参为受影响文件的绝对路径 */
  onDiscarded?: (filePaths: string[]) => void;
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
  onRevertFile,
  onCheckFileChanged,
  projectId,
  projectCode,
  openlineageTransportUrl,
  readFileContent,
  onSaveConfigParams,
  onAISummarize,
  onBeforeCommit,
  onDiscarded,
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
  // 面板根节点（始终挂载），用于托管文件树点击监听
  const panelRef = useRef<HTMLElement>(null);

  // 通知父组件折叠状态变化
  useEffect(() => {
    onCollapsedChange?.(isCollapsed);
  }, [isCollapsed, onCollapsedChange]);

  // 右键菜单状态
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; node: TreeNode | null } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // 右键目标文件是否可撤销（有未提交变更），用于置灰「撤销文件变更」；非文件或未提供检查能力时视为可点
  const [canRevertFile, setCanRevertFile] = useState(true);
  useEffect(() => {
    const node = contextMenu?.node;
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
  }, [contextMenu, onCheckFileChanged]);

  // 重命名状态
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [renamingNode, setRenamingNode] = useState<{ filePath: string; name: string; type: string } | null>(null);
  const renameInputRef = React.useRef<HTMLInputElement>(null);

  const [gitModalVisible, setGitModalVisible] = useState(false);

  // 配置参数弹窗（批量）：targets 为本次要统一配置的代码文件绝对路径。
  // 弹窗只在 visible 时才挂载，关闭即清空目标，避免下次打开残留上一批文件
  const [configParamsTargets, setConfigParamsTargets] = useState<string[]>([]);
  const [configParamsVisible, setConfigParamsVisible] = useState(false);

  // 移动对话框状态（支持批量：多选时一次移动多个节点）
  const [moveTargets, setMoveTargets] = useState<TreeNode[]>([]);
  const [selectedMoveDir, setSelectedMoveDir] = useState<string | null>(null);
  const [moveExpanded, setMoveExpanded] = useState<Set<string>>(new Set());
  const [isMoving, setIsMoving] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const moveTreeRef = useRef<HTMLDivElement>(null);

  // 复制对话框状态（复用移动的目录树选择 UI，支持批量）
  const [copyTargets, setCopyTargets] = useState<TreeNode[]>([]);
  const [selectedCopyDir, setSelectedCopyDir] = useState<string | null>(null);
  const [copyExpanded, setCopyExpanded] = useState<Set<string>>(new Set());
  const [isCopying, setIsCopying] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmState>({
    visible: false,
    nodes: [],
  });
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [tree, setTree] = useState<Tree>([]);
  const treeRef = useRef<Tree>([]);
  // 始终持有最新的 onFileSelect（避免点击监听器因回调引用变化而反复重挂）
  const onFileSelectRef = useRef(onFileSelect);
  onFileSelectRef.current = onFileSelect;

  // ===== 多选状态 =====
  // selectedPaths：当前选中的节点路径（文件与文件夹均可），顺序即选中顺序
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const selectedPathsRef = useRef<string[]>([]);
  // Shift 范围选择的锚点（最后一次「非 Shift」点击的节点路径）
  const lastAnchorRef = useRef<string | null>(null);
  // 最近一次真正打开的文件路径（用于与库的选中回调去重）
  const lastOpenedPathRef = useRef<string | null>(null);

  const commitSelection = useCallback((paths: string[]) => {
    const unique = Array.from(new Set(paths));
    selectedPathsRef.current = unique;
    setSelectedPaths(unique);
  }, []);

  const clearSelection = useCallback(() => {
    selectedPathsRef.current = [];
    lastAnchorRef.current = null;
    setSelectedPaths([]);
  }, []);

  /** 从事件目标向上定位到文件树行 div[tabindex]，并按行下标反查树节点 */
  const resolveNodeFromEventTarget = useCallback((target: EventTarget | null): TreeNode | null => {
    let el = target as HTMLElement | null;
    for (let i = 0; i < 8 && el; i++) {
      if (el.hasAttribute('tabindex')) break;
      el = el.parentElement;
    }
    if (!el || !el.hasAttribute('tabindex')) return null;

    const wrapper = el.closest('.file-navigator-wrapper');
    if (!wrapper) return null;

    const rows = Array.from(wrapper.querySelectorAll<HTMLElement>('div[tabindex]'));
    const index = rows.indexOf(el);
    if (index < 0) return null;

    const visible = flattenVisibleNodes(treeRef.current);
    return visible[index] ?? null;
  }, []);

  /** 把多选高亮同步到真实 DOM：只维护 `.explorer-row--selected` 类，视觉全部由 CSS 决定。
   *  之所以不写 inline 背景：库会把「悬停行」和「它内部的单选行」都写成 inline
   *  background-color，一旦我们也用 inline 表达选中态，两种状态就会互相覆盖，
   *  表现为「选中色随光标移动而变化」。 */
  const syncSelectionStyles = useCallback((paths: string[]) => {
    const wrapper = document.querySelector('.file-navigator-wrapper');
    if (!wrapper) return;

    const rows = Array.from(wrapper.querySelectorAll<HTMLElement>('div[tabindex]'));
    const visible = flattenVisibleNodes(treeRef.current);
    const selected = new Set(paths);

    rows.forEach((row, index) => {
      const node = visible[index];
      row.classList.toggle('explorer-row--selected', !!node && selected.has(node.filePath));
      // 必须清掉库写入的 inline background-color：库把「悬停行」和「它内部的单选行」都写成
      // inline style，而 inline 是没法用普通 CSS 类覆盖的 —— 那正是「选中色随光标移动而变化」
      // 的来源（悬停到哪一行，哪一行就变成和选中一样的蓝底）。视觉一律交给 CSS 类。
      row.style.removeProperty('background-color');
    });
  }, []);

  // 选中集合 / 树结构变化后，重新把高亮刷到 DOM 上
  useEffect(() => {
    syncSelectionStyles(selectedPaths);
  }, [selectedPaths, tree, syncSelectionStyles]);

  // 切换项目根目录时清空多选
  useEffect(() => {
    clearSelection();
  }, [rootPath, clearSelection]);

  useEffect(() => {
    const currentExpandedPaths = extractExpandedPaths(treeRef.current);
    const newTree = convertFileNodesToTree(fileTree, currentExpandedPaths);
    treeRef.current = newTree;
    setTree(newTree);

    // 树刷新后清理已不存在的选中项（如被外部删除/重命名）
    const alive = new Set(collectAllPaths(fileTree));
    const pruned = selectedPathsRef.current.filter(p => alive.has(p));
    if (pruned.length !== selectedPathsRef.current.length) {
      commitSelection(pruned);
    }
  }, [fileTree, commitSelection]);

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
  }, [tree, syncSelectionStyles]);

  // 修复 + 多选：
  // 1) react-file-navigator 的 onFileSelectionChange 仅在「选中节点改变」时触发，
  //    当文件已处于选中状态后再次点击同一节点，selection 引用不变 → 回调不再执行 → 无法在编辑器中重新打开。
  // 2) 库本身只支持单选，这里接管点击以实现多选：
  //    · 普通点击：单选该文件/文件夹（文件同时在编辑器中打开）
  //    · Ctrl/Cmd + 点击：切换该节点的选中状态（不打开、不展开）
  //    · Shift + 点击：以锚点为起点做范围选择
  //    带修饰键时阻止事件继续冒泡，避免库内部再把选中态收敛成单选 / 误展开文件夹。
  useEffect(() => {
    // 监听挂在常驻的面板根节点上：文件树容器在「未打开目录 / 折叠」时并不挂载，
    // 挂在它上面会导致一次卸载后监听器再也不回来。
    const panel = panelRef.current;
    if (!panel) return;

    const handleClick = (e: Event) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.file-navigator-wrapper')) return;

      const mouseEvent = e as MouseEvent;
      const node = resolveNodeFromEventTarget(e.target);

      if (!node) {
        // 点击空白处：清空多选
        if (selectedPathsRef.current.length > 0) clearSelection();
        return;
      }

      const withToggle = mouseEvent.metaKey || mouseEvent.ctrlKey;
      const withRange = mouseEvent.shiftKey;

      if (withToggle || withRange) {
        e.preventDefault();
        e.stopPropagation();
      }

      if (withRange) {
        const visible = flattenVisibleNodes(treeRef.current);
        const toIndex = visible.findIndex(n => n.filePath === node.filePath);
        const anchor = lastAnchorRef.current;
        const fromIndex = anchor ? visible.findIndex(n => n.filePath === anchor) : -1;
        if (fromIndex >= 0 && toIndex >= 0) {
          const [start, end] = fromIndex <= toIndex ? [fromIndex, toIndex] : [toIndex, fromIndex];
          commitSelection(visible.slice(start, end + 1).map(n => n.filePath));
        } else {
          commitSelection([node.filePath]);
          lastAnchorRef.current = node.filePath;
        }
        // 锚点保持不变，便于连续 Shift 点击调整范围
        return;
      }

      if (withToggle) {
        const current = new Set(selectedPathsRef.current);
        if (current.has(node.filePath)) {
          current.delete(node.filePath);
        } else {
          current.add(node.filePath);
        }
        commitSelection(Array.from(current));
        lastAnchorRef.current = node.filePath;
        return;
      }

      commitSelection([node.filePath]);
      lastAnchorRef.current = node.filePath;
      if (node.type === 'File') {
        lastOpenedPathRef.current = node.filePath;
        onFileSelectRef.current(node.filePath);
      }
    };

    panel.addEventListener('click', handleClick);
    return () => panel.removeEventListener('click', handleClick);
  }, [resolveNodeFromEventTarget, commitSelection, clearSelection]);

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

  // 库的选中回调会在「选中节点变化」时触发，与下面 DOM 点击回调存在重叠：
  // 普通点击一条链路会被调用两次（重复读取文件内容、重复激活 Tab）。
  // 这里加一道去重：只有 DOM 点击链路没处理过的路径才真正打开。
  const handleFileSelectionChange = useCallback((node: TreeNode | null) => {
    if (node && node.type === 'File' && node.filePath !== lastOpenedPathRef.current) {
      lastOpenedPathRef.current = node.filePath;
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
      commitSelection([createdNode.path]);
      lastAnchorRef.current = createdNode.path;
    }

    setIsCreatingFile(false);
    setNewFileName('');
  }, [newFileName, rootPath, createTarget, onCreateFile, onFileSelect, commitSelection]);

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

    setDeleteError(null);
    setDeleteConfirm({ visible: true, nodes: fileNodes });
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    const nodes = deleteConfirm.nodes;
    if (nodes.length === 0 || !onDeleteNode) return;

    setIsDeleting(true);
    setDeleteError(null);

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
      setDeleteConfirm({ visible: false, nodes: [] });
      clearSelection();
    } else {
      setDeleteError(`以下项目删除失败：${failed.join('、')}`);
    }
  }, [deleteConfirm.nodes, onDeleteNode, clearSelection]);

  const handleDeleteCancel = useCallback(() => {
    setDeleteConfirm({ visible: false, nodes: [] });
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

    // 使用 clientX/clientY（视口坐标），与菜单 position: fixed 保持一致
    const openMenu = (node: TreeNode | null) => {
      contextMenuAdjustedRef.current = null;
      setContextMenu({ x: e.clientX, y: e.clientY, node });
    };

    // react-file-navigator 渲染的行结构：div[draggable] > div[tabIndex=1, 交互层] > div[内容层] > span + span
    const node = resolveNodeFromEventTarget(e.target);

    // 空白区域（未命中任何节点）也弹出菜单：仅启用"新建文件/新建文件夹"，重命名/删除置灰
    if (!node) {
      openMenu(null);
      return;
    }

    // 右键命中的节点若不在多选集合中，先把选中集合收敛为该节点（与 VS Code 行为一致），
    // 这样菜单操作即可作用于整个多选集合。
    if (!selectedPathsRef.current.includes(node.filePath)) {
      commitSelection([node.filePath]);
      lastAnchorRef.current = node.filePath;
    }
    openMenu(node);
  }, [resolveNodeFromEventTarget, commitSelection]);

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
   * 「配置参数」菜单项的可见性：**只有右键目标全部是文件夹时**才出现。
   *
   * 该功能的作用域是文件夹（为其下所有代码文件下发同一份参数），
   * 单个代码文件/空白处右键/文件夹与文件混选都不显示这一项。
   */
  const canConfigureParams = useMemo(
    () => contextTargets.length > 0 && contextTargets.every(t => t.type === 'Folder'),
    [contextTargets]
  );

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
  }, [contextTargets, onRenameNode]);

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
    setConfigParamsTargets(configTargetFiles);
    setConfigParamsVisible(true);
  }, [configTargetFiles]);

  const handleCloseConfigParams = useCallback(() => {
    setConfigParamsVisible(false);
    setConfigParamsTargets([]);
  }, []);

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

  // 右键菜单：选择"移动到 ..."（支持批量）
  const handleMoveFromContext = useCallback(() => {
    if (contextTargets.length === 0 || !onMoveNode) return;
    // 默认选中源节点的父目录或项目根目录
    const defaultTarget = getParentDir(contextTargets[0].filePath);
    setMoveTargets(contextTargets);
    setSelectedMoveDir(rootPath && defaultTarget && rootPath !== defaultTarget && defaultTarget.startsWith(rootPath)
      ? defaultTarget
      : rootPath);
    setMoveExpanded(new Set());
    setMoveError(null);
    setContextMenu(null);
  }, [contextTargets, onMoveNode, rootPath]);

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

  // 移动：提交（批量：逐个移动，全部成功才关闭弹窗）
  const handleMoveSubmit = useCallback(async () => {
    if (moveTargets.length === 0 || !onMoveNode) return;

    if (!selectedMoveDir) {
      setMoveError('请选择目标文件夹');
      return;
    }

    setIsMoving(true);
    setMoveError(null);

    const failed: string[] = [];
    for (const node of moveTargets) {
      try {
        const success = await onMoveNode(
          node.filePath,
          selectedMoveDir,
          node.type === 'Folder' ? 'folder' : 'file'
        );
        if (!success) failed.push(node.name);
      } catch {
        failed.push(node.name);
      }
    }

    setIsMoving(false);
    if (failed.length === 0) {
      toast.info(moveTargets.length > 1
        ? `已移动 ${moveTargets.length} 个项目`
        : `已移动「${moveTargets[0].name}」`);
      setMoveTargets([]);
      setSelectedMoveDir(null);
      setMoveExpanded(new Set());
      clearSelection();
    } else {
      setMoveError(`以下项目移动失败：${failed.join('、')}`);
    }
  }, [moveTargets, selectedMoveDir, onMoveNode, toast, clearSelection]);

  // 移动：取消
  const handleMoveCancel = useCallback(() => {
    if (isMoving) return;
    setMoveTargets([]);
    setSelectedMoveDir(null);
    setMoveExpanded(new Set());
    setMoveError(null);
  }, [isMoving]);

  // 右键菜单：选择"复制到 ..."
  const handleCopyFromContext = useCallback(() => {
    if (contextTargets.length === 0 || !onCopyNode) return;
    const node = contextTargets[0];
    const defaultTarget = getParentDir(node.filePath);
    setCopyTargets(contextTargets);
    setSelectedCopyDir(rootPath && defaultTarget && rootPath !== defaultTarget && defaultTarget.startsWith(rootPath)
      ? defaultTarget
      : rootPath);
    setCopyExpanded(new Set());
    setCopyError(null);
    setContextMenu(null);
  }, [contextTargets, onCopyNode, rootPath]);

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
    if (copyTargets.length === 0 || !onCopyNode) return;

    if (!selectedCopyDir) {
      setCopyError('请选择目标文件夹');
      return;
    }

    setIsCopying(true);
    setCopyError(null);

    const failed: string[] = [];
    for (const target of copyTargets) {
      try {
        const success = await onCopyNode(
          target.filePath,
          selectedCopyDir,
          target.type === 'Folder' ? 'folder' : 'file'
        );
        if (!success) failed.push(target.name);
      } catch {
        failed.push(target.name);
      }
    }

    setIsCopying(false);
    if (failed.length === 0) {
      toast.info(copyTargets.length > 1
        ? `已复制 ${copyTargets.length} 个项目`
        : `已复制「${copyTargets[0].name}」`);
      setCopyTargets([]);
      setSelectedCopyDir(null);
      setCopyExpanded(new Set());
      clearSelection();
    } else {
      setCopyError(`以下项目复制失败：${failed.join('、')}`);
    }
  }, [copyTargets, selectedCopyDir, onCopyNode, toast, clearSelection]);

  // 复制：取消
  const handleCopyCancel = useCallback(() => {
    if (isCopying) return;
    setCopyTargets([]);
    setSelectedCopyDir(null);
    setCopyExpanded(new Set());
    setCopyError(null);
  }, [isCopying]);

  // 文件树键盘快捷键：Ctrl/Cmd + A 全选当前可见节点，Esc 清空多选
  const handleTreeKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (isRenaming || isCreatingFile || isCreatingFolder) return;

    if ((e.metaKey || e.ctrlKey) && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      e.stopPropagation();
      const visible = flattenVisibleNodes(treeRef.current);
      commitSelection(visible.map(n => n.filePath));
      lastAnchorRef.current = visible.length > 0 ? visible[visible.length - 1].filePath : null;
      return;
    }

    if (e.key === 'Escape' && selectedPathsRef.current.length > 0) {
      clearSelection();
    }
  }, [isRenaming, isCreatingFile, isCreatingFolder, commitSelection, clearSelection]);

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

      {/* 配置参数（批量）：文件夹右键时把同一份参数写入其下全部代码文件 */}
      {configParamsVisible && configParamsTargets.length > 0 && (
        <ConfigParamsModal
          visible
          onClose={handleCloseConfigParams}
          rootPath={rootPath || undefined}
          projectId={projectId}
          projectCode={projectCode}
          openlineageTransportUrl={openlineageTransportUrl}
          targetPaths={configParamsTargets}
          readFileContent={readFileContent}
          onSave={(data, filePath) => {
            if (filePath) onSaveConfigParams?.(filePath, data);
          }}
        />
      )}

      {deleteConfirm.visible && deleteConfirm.nodes.length > 0 && (() => {
        const nodes = deleteConfirm.nodes;
        const single = nodes.length === 1 ? nodes[0] : null;
        const hasFolder = nodes.some(n => n.type === 'folder');
        return (
        <div className="explorer-panel__delete-overlay" onClick={handleDeleteCancel}>
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
                {isDeleting ? '删除中...' : `删除${nodes.length > 1 ? ` ${nodes.length} 项` : ''}`}
              </button>
            </div>
          </div>
        </div>
        );
      })()}

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
            disabled={!onRenameNode || contextTargets.length !== 1}
          >
            <Pencil size={14} />
            <span>重命名</span>
          </button>
          <button
            className="explorer-panel__context-menu-item"
            onClick={handleMoveFromContext}
            disabled={!onMoveNode || contextTargets.length === 0}
          >
            <Move size={14} />
            <span>移动到 ...{contextTargets.length > 1 ? ` (${contextTargets.length})` : ''}</span>
          </button>
          <button
            className="explorer-panel__context-menu-item"
            onClick={handleCopyFromContext}
            disabled={!onCopyNode || contextTargets.length === 0}
          >
            <Copy size={14} />
            <span>复制到 ...{contextTargets.length > 1 ? ` (${contextTargets.length})` : ''}</span>
          </button>
          {/* 配置参数：只对文件夹显示（含分隔线一起隐藏，避免出现连续分隔线） */}
          {canConfigureParams && (
            <>
              <div className="explorer-panel__context-menu-divider" />
              <button
                className="explorer-panel__context-menu-item"
                onClick={handleConfigureParamsFromContext}
                disabled={!projectId || configTargetFiles.length === 0}
                title={
                  !projectId
                    ? '缺少项目上下文，无法配置参数'
                    : configTargetFiles.length === 0
                      ? '该节点下没有可配置参数的代码文件（仅支持 Scala / SQL / Java / Python）'
                      : `为 ${configTargetFiles.length} 个代码文件配置相同参数`
                }
              >
                <Sliders size={14} />
                <span>
                  配置参数
                  {configTargetFiles.length > 1 ? ` (${configTargetFiles.length})` : ''}
                </span>
              </button>
            </>
          )}
          <div className="explorer-panel__context-menu-divider" />
          {contextTargets.length === 1 && contextTargets[0].type === 'File' && (
            <button
              className="explorer-panel__context-menu-item"
              onClick={handleShowHistoryFromContext}
              disabled={!onShowHistory}
            >
              <History size={14} />
              <span>历史版本</span>
            </button>
          )}
          {contextTargets.length === 1 && contextTargets[0].type === 'File' && (
            <button
              className="explorer-panel__context-menu-item"
              onClick={handleRevertFromContext}
              disabled={!onRevertFile || !canRevertFile || !onCheckFileChanged}
              title={!canRevertFile && onCheckFileChanged ? '该文件没有未提交的变更' : undefined}
            >
              <Undo2 size={14} />
              <span>撤销文件变更</span>
            </button>
          )}
          <button
            className="explorer-panel__context-menu-item explorer-panel__context-menu-item--danger"
            onClick={handleDeleteFromContext}
            disabled={contextTargets.length === 0}
          >
            <Trash2 size={14} />
            <span>删除{contextTargets.length > 1 ? ` ${contextTargets.length} 项` : ''}</span>
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
      {moveTargets.length > 0 && (
        <div className="explorer-panel__move-overlay" onClick={handleMoveCancel}>
          <div className="explorer-panel__move-dialog" onClick={e => e.stopPropagation()}>
            <div className="explorer-panel__move-dialog-header">
              <Move size={18} className="explorer-panel__move-dialog-icon" />
              <span>移动到</span>
            </div>
            <div className="explorer-panel__move-dialog-body">
              <div className="explorer-panel__move-dialog-node">
                {moveTargets.length > 1
                  ? <>移动 <strong>{moveTargets.length}</strong> 个选中的项目</>
                  : <>移动{moveTargets[0].type === 'Folder' ? '文件夹' : '文件'}
                     <strong> {moveTargets[0].name} </strong></>}
              </div>
              <p className="explorer-panel__move-dialog-tip">
                请在下方选择目标文件夹：
              </p>
              <div className="explorer-panel__move-tree" ref={moveTreeRef}>
                {renderMoveDirTree(
                  fileTree,
                  selectedMoveDir,
                  moveTargets.map(n => n.filePath),
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
      {copyTargets.length > 0 && (
        <div className="explorer-panel__move-overlay" onClick={handleCopyCancel}>
          <div className="explorer-panel__move-dialog" onClick={e => e.stopPropagation()}>
            <div className="explorer-panel__move-dialog-header">
              <Copy size={18} className="explorer-panel__move-dialog-icon explorer-panel__move-dialog-icon--copy" />
              <span>复制到</span>
            </div>
            <div className="explorer-panel__move-dialog-body">
              <div className="explorer-panel__move-dialog-node">
                {copyTargets.length > 1
                  ? <>复制 <strong>{copyTargets.length}</strong> 个选中的项目</>
                  : <>复制{copyTargets[0].type === 'Folder' ? '文件夹' : '文件'}
                     <strong> {copyTargets[0].name} </strong></>}
              </div>
              <p className="explorer-panel__move-dialog-tip">
                请在下方选择目标文件夹（重名时自动追加"副本"后缀）：
              </p>
              <div className="explorer-panel__move-tree">
                {renderMoveDirTree(
                  fileTree,
                  selectedCopyDir,
                  copyTargets.map(n => n.filePath),
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
// srcPaths 为被移动/复制的节点路径（批量时多个），用于将这些节点自身及其子目录禁用、避免移动到自身内部。
const renderMoveDirTree = (
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
            {renderMoveDirTree(node.children, selectedDir, srcPaths, expanded, onSelect, onToggle, depth + 1)}
          </div>
        )}
      </div>
    );
  });
};

const getSeparator = (path: string): string => (path.includes('\\') ? '\\' : '/');

export default ExplorerPanel;
