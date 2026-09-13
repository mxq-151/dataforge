import type { Tree, TreeNode } from 'react-file-navigator';
import type { FileNode } from '../../../types';

/** 按「当前可见顺序」摊平文件树：文件夹仅在展开时才包含其子项。
 *  该顺序与 react-file-navigator 渲染出的 div[tabindex] 行顺序严格一致，
 *  因此可以用 DOM 行下标反查对应的树节点（比按文件名匹配更可靠，重名也不会出错）。 */
export const flattenVisibleNodes = (nodes: TreeNode[]): TreeNode[] => {
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
export const findNodeByPath = (nodes: TreeNode[], path: string): TreeNode | null => {
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
export const collectAllPaths = (nodes: FileNode[]): string[] => {
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

export const isCodeFilePath = (filePath: string): boolean =>
  CODE_FILE_EXTENSIONS.has(filePath.split('.').pop()?.toLowerCase() || '');

/** 在 FileNode 树中按路径查找节点 */
export const findFileNodeByPath = (nodes: FileNode[], path: string): FileNode | null => {
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
export const resolveConfigTargetFiles = (targets: TreeNode[], fileTree: FileNode[]): string[] => {
  const result: string[] = [];
  for (const target of targets) {
    if (target.type !== 'Folder') continue;
    const folderNode = findFileNodeByPath(fileTree, target.filePath);
    if (folderNode) collectCodeFilesUnder(folderNode, result);
  }
  return Array.from(new Set(result));
};

export const convertFileNodesToTree = (
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

export const extractExpandedPaths = (tree: Tree): Set<string> => {
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
export const getParentDir = (filePath: string): string => {
  const sep = filePath.includes('/') ? '/' : '\\';
  const idx = filePath.lastIndexOf(sep);
  return idx >= 0 ? filePath.substring(0, idx) : filePath;
};

export const getSeparator = (path: string): string => (path.includes('\\') ? '\\' : '/');
