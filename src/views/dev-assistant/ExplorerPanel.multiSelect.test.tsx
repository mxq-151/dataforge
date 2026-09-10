import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import ExplorerPanel from './ExplorerPanel';
import { ToastProvider } from '../../components/Toast';

/**
 * 文件浏览器多选行为的回归测试。
 *
 * ExplorerPanel 基于 react-file-navigator，该库内部只维护单选状态，
 * 多选由 ExplorerPanel 自行接管：Ctrl/Cmd + 点击切换、Shift + 点击范围选择、
 * Ctrl/Cmd + A 全选、Esc / 点击空白清空，并把高亮同步到真实 DOM 行上。
 */

const SRC = '/proj/src';

const fileTree: any[] = [
  {
    id: '1',
    name: 'src',
    type: 'folder',
    path: SRC,
    children: [
      { id: '2', name: 'a.ts', type: 'file', path: `${SRC}/a.ts` },
      { id: '3', name: 'b.ts', type: 'file', path: `${SRC}/b.ts` },
      { id: '4', name: 'c.ts', type: 'file', path: `${SRC}/c.ts` },
    ],
  },
  { id: '5', name: 'readme.md', type: 'file', path: '/proj/readme.md' },
];

const renderPanel = (overrides: Record<string, any> = {}) => {
  const props = {
    fileTree,
    rootPath: '/proj',
    isLoading: false,
    selectedFile: null,
    expandedFolders: new Set<string>([SRC]),
    onFileSelect: vi.fn(),
    onFolderToggle: vi.fn(),
    onOpenFolder: vi.fn(),
    onCreateFile: vi.fn(),
    onCreateFolder: vi.fn(),
    onDeleteNode: vi.fn().mockResolvedValue(true),
    onRenameNode: vi.fn(),
    onMoveNode: vi.fn(),
    onCopyNode: vi.fn(),
    ...overrides,
  };

  const utils = render(
    <ToastProvider>
      <ExplorerPanel {...props} />
    </ToastProvider>
  );
  const wrapper = () => utils.container.querySelector('.file-navigator-wrapper') as HTMLElement;
  const rows = () => Array.from(utils.container.querySelectorAll('div[tabindex]')) as HTMLElement[];
  const selectedRowNames = () =>
    rows()
      .filter(r => r.classList.contains('explorer-row--selected'))
      .map(r => r.textContent?.trim());

  return { ...utils, props, wrapper, rows, selectedRowNames };
};

// 行顺序（深度优先、文件夹展开）：src / a.ts / b.ts / c.ts / readme.md
const clickRow = (row: HTMLElement, init: MouseEventInit = {}) => fireEvent.click(row, init);

describe('ExplorerPanel 多选', () => {
  it('普通点击为单选，并在编辑器中打开该文件', () => {
    const { props, rows, selectedRowNames } = renderPanel();

    clickRow(rows()[1]);

    expect(props.onFileSelect).toHaveBeenCalledTimes(1);
    expect(props.onFileSelect).toHaveBeenCalledWith(`${SRC}/a.ts`);
    expect(selectedRowNames()).toEqual(['a.ts']);
  });

  it('Ctrl/Cmd + 点击可累加选中，且不会重复打开文件', () => {
    const { props, rows, selectedRowNames } = renderPanel();

    clickRow(rows()[1]);
    clickRow(rows()[2], { ctrlKey: true });
    clickRow(rows()[3], { metaKey: true });

    expect(selectedRowNames()).toEqual(['a.ts', 'b.ts', 'c.ts']);
    // 带修饰键的点击只调整选中集合，不应触发打开
    expect(props.onFileSelect).toHaveBeenCalledTimes(1);
  });

  it('Ctrl/Cmd + 点击已选中项可取消选中', () => {
    const { rows, selectedRowNames } = renderPanel();

    clickRow(rows()[1]);
    clickRow(rows()[2], { ctrlKey: true });
    expect(selectedRowNames()).toEqual(['a.ts', 'b.ts']);

    clickRow(rows()[2], { ctrlKey: true });
    expect(selectedRowNames()).toEqual(['a.ts']);
  });

  it('Shift + 点击按可见顺序做范围选择', () => {
    const { rows, selectedRowNames } = renderPanel();

    clickRow(rows()[1]);          // 锚点：a.ts
    clickRow(rows()[3], { shiftKey: true }); // 范围到 c.ts

    expect(selectedRowNames()).toEqual(['a.ts', 'b.ts', 'c.ts']);

    // 反向 Shift 点击：仍以同一锚点计算范围
    clickRow(rows()[2], { shiftKey: true });
    expect(selectedRowNames()).toEqual(['a.ts', 'b.ts']);
  });

  it('选中态只由 class 表达，不写入 inline 背景（悬停与选中不再互相覆盖）', () => {
    const { rows, selectedRowNames } = renderPanel();

    clickRow(rows()[1]);
    clickRow(rows()[2], { ctrlKey: true });
    expect(selectedRowNames()).toEqual(['a.ts', 'b.ts']);

    // 选中行不得带 inline background-color：库会把悬停行也写成 inline 背景，
    // 两套 inline 一旦共存，选中色就会随光标移动而变。
    rows().forEach(row => {
      expect(row.style.getPropertyValue('background-color')).toBe('');
    });
  });

  it('点击空白区域清空多选', () => {
    const { wrapper, rows, selectedRowNames } = renderPanel();

    clickRow(rows()[1]);
    clickRow(rows()[2], { ctrlKey: true });
    expect(selectedRowNames()).toHaveLength(2);

    fireEvent.click(wrapper());
    expect(selectedRowNames()).toHaveLength(0);
  });

  it('Ctrl/Cmd + A 全选当前可见节点，Esc 清空', () => {
    const { wrapper, selectedRowNames } = renderPanel();

    fireEvent.keyDown(wrapper(), { key: 'a', ctrlKey: true });
    expect(selectedRowNames()).toEqual(['src', 'a.ts', 'b.ts', 'c.ts', 'readme.md']);

    fireEvent.keyDown(wrapper(), { key: 'Escape' });
    expect(selectedRowNames()).toHaveLength(0);
  });

  it('多选后右键菜单作用于整个选中集合，可批量删除', async () => {
    const { props, rows, selectedRowNames } = renderPanel();

    clickRow(rows()[1]);
    clickRow(rows()[2], { ctrlKey: true });
    expect(selectedRowNames()).toHaveLength(2);

    // 在已选中的行上右键：菜单应作用于两个文件
    fireEvent.contextMenu(rows()[2]);
    const deleteItem = await waitFor(() => {
      const item = Array.from(document.querySelectorAll('.explorer-panel__context-menu-item'))
        .find(el => el.textContent?.includes('删除'));
      expect(item).toBeTruthy();
      return item as HTMLElement;
    });
    expect(deleteItem.textContent).toContain('删除 2 项');

    fireEvent.click(deleteItem);

    // 确认弹窗中点击删除，应逐个删除
    const confirmBtn = await waitFor(() => {
      const btn = Array.from(document.querySelectorAll('.explorer-panel__delete-dialog-btn--confirm'))[0] as HTMLElement;
      expect(btn).toBeTruthy();
      return btn;
    });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(props.onDeleteNode).toHaveBeenCalledTimes(2);
    });
    expect(props.onDeleteNode).toHaveBeenCalledWith(`${SRC}/a.ts`, 'file');
    expect(props.onDeleteNode).toHaveBeenCalledWith(`${SRC}/b.ts`, 'file');
  });

  it('右键未选中的节点时，选中集合收敛为该节点（删除仅一项）', async () => {
    const { props, rows } = renderPanel();

    clickRow(rows()[1]);
    clickRow(rows()[2], { ctrlKey: true });

    // 右键第 4 行（c.ts，不在选中集合中）
    fireEvent.contextMenu(rows()[3]);

    const deleteItem = await waitFor(() => {
      const item = Array.from(document.querySelectorAll('.explorer-panel__context-menu-item'))
        .find(el => el.textContent?.trim() === '删除');
      expect(item).toBeTruthy();
      return item as HTMLElement;
    });
    fireEvent.click(deleteItem);

    const confirmBtn = await waitFor(() => {
      const btn = document.querySelector('.explorer-panel__delete-dialog-btn--confirm') as HTMLElement;
      expect(btn).toBeTruthy();
      return btn;
    });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(props.onDeleteNode).toHaveBeenCalledTimes(1);
    });
    expect(props.onDeleteNode).toHaveBeenCalledWith(`${SRC}/c.ts`, 'file');
  });
});
