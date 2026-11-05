import React, { useState, useCallback, useRef, useEffect } from 'react';
import type { Tree, TreeNode } from 'react-file-navigator';
import type { FileNode } from '../../../types';
import { flattenVisibleNodes, collectAllPaths } from './treeUtils';

interface UseExplorerSelectionParams {
  /** 当前树状态（树结构变化后需要把选中高亮重刷到 DOM） */
  tree: Tree;
  /** 始终持有最新树的 ref（DOM 事件回调里同步读取，避免闭包过期） */
  treeRef: React.MutableRefObject<Tree>;
  /** 面板根节点（始终挂载），用于托管文件树点击监听 */
  panelRef: React.RefObject<HTMLElement | null>;
  /** 项目根目录：切换时清空多选 */
  rootPath: string | null;
  /** 完整文件树：刷新后清理已不存在的选中项 */
  fileTree: FileNode[];
  /** 普通点击文件时在编辑器中打开 */
  onFileSelect: (path: string) => void;
  /** 正在新建/重命名（存在内联输入框）时跳过 Ctrl+A 抢键 */
  isInputActive: boolean;
}

/**
 * 文件树多选领域逻辑。
 *
 * react-file-navigator 库本身只支持单选，多选由本 hook 接管：
 * · 普通点击：单选该文件/文件夹（文件同时在编辑器中打开）
 * · Ctrl/Cmd + 点击：切换该节点的选中状态（不打开、不展开）
 * · Shift + 点击：以锚点为起点做范围选择
 * · Ctrl/Cmd + A：全选当前可见节点；Esc / 点击空白：清空
 *
 * 选中态只用 `.explorer-row--selected` 类表达，视觉全部由 CSS 决定。
 */
export function useExplorerSelection({
  tree,
  treeRef,
  panelRef,
  rootPath,
  fileTree,
  onFileSelect,
  isInputActive,
}: UseExplorerSelectionParams) {
  // selectedPaths：当前选中的节点路径（文件与文件夹均可），顺序即选中顺序
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const selectedPathsRef = useRef<string[]>([]);
  // Shift 范围选择的锚点（最后一次「非 Shift」点击的节点路径）
  const lastAnchorRef = useRef<string | null>(null);
  // 最近一次真正打开的文件路径（用于与库的选中回调去重）
  const lastOpenedPathRef = useRef<string | null>(null);

  // 始终持有最新的 onFileSelect（避免点击监听器因回调引用变化而反复重挂）
  const onFileSelectRef = useRef(onFileSelect);
  onFileSelectRef.current = onFileSelect;

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

  /** 收敛为单选并把该节点设为 Shift 锚点（右键收敛、新建文件后定位等场景共用） */
  const selectSingle = useCallback((path: string) => {
    commitSelection([path]);
    lastAnchorRef.current = path;
  }, [commitSelection]);

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

  // 树刷新后清理已不存在的选中项（如被外部删除/重命名）
  useEffect(() => {
    const alive = new Set(collectAllPaths(fileTree));
    const pruned = selectedPathsRef.current.filter(p => alive.has(p));
    if (pruned.length !== selectedPathsRef.current.length) {
      commitSelection(pruned);
    }
  }, [fileTree, commitSelection]);

  // 修复 + 多选：
  // 1) react-file-navigator 的 onFileSelectionChange 仅在「选中节点改变」时触发，
  //    当文件已处于选中状态后再次点击同一节点，selection 引用不变 → 回调不再执行 → 无法在编辑器中重新打开。
  // 2) 库本身只支持单选，这里接管点击以实现多选。
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
  }, [panelRef, resolveNodeFromEventTarget, commitSelection, clearSelection]);

  // 库的选中回调会在「选中节点变化」时触发，与上面 DOM 点击回调存在重叠：
  // 普通点击一条链路会被调用两次（重复读取文件内容、重复激活 Tab）。
  // 这里加一道去重：只有 DOM 点击链路没处理过的路径才真正打开。
  const handleFileSelectionChange = useCallback((node: TreeNode | null) => {
    if (node && node.type === 'File' && node.filePath !== lastOpenedPathRef.current) {
      lastOpenedPathRef.current = node.filePath;
      onFileSelectRef.current(node.filePath);
    }
  }, []);

  // 文件树键盘快捷键：Ctrl/Cmd + A 全选当前可见节点，Esc 清空多选
  const handleTreeKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (isInputActive) return;

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
  }, [isInputActive, treeRef, commitSelection, clearSelection]);

  return {
    selectedPaths,
    selectedPathsRef,
    commitSelection,
    clearSelection,
    selectSingle,
    syncSelectionStyles,
    resolveNodeFromEventTarget,
    handleFileSelectionChange,
    handleTreeKeyDown,
  };
}
