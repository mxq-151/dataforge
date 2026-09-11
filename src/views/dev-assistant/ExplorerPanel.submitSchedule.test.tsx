import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import ExplorerPanel from './ExplorerPanel';
import { ToastProvider } from '../../components/Toast';

/**
 * 文件浏览器右键「提交调度」的回归测试。
 *
 * 需求：右键菜单新增「提交调度」，**只在文件夹上显示**；
 * 点击后弹出「与工作流定义内容一致、但不显示左侧任务节点类型面板」的模态框。
 *
 * 模态框本体（含内嵌的 DAG 画布）在 FolderSubmitScheduleModal.test.tsx 单独测，
 * 这里把它替换为桩组件，只钉住「菜单项何时出现/何时置灰」以及「传进去的目标是否正确」。
 */

vi.mock('./FolderSubmitScheduleModal', () => ({
  default: (props: any) => (
    <div
      data-testid="submit-schedule-stub"
      data-folder={props.folderPath}
      data-files={props.codeFilePaths.join(',')}
    />
  ),
}));

vi.mock('../../api/devProject', () => ({
  fetchProjectConfigByFilePath: vi.fn(async () => ({ code: 200, message: '', data: null })),
  saveProjectConfig: vi.fn(async () => ({ code: 200, message: '' })),
}));

vi.mock('../../api/dependency', () => ({
  fetchDependencyList: vi.fn(async () => ({
    code: 200,
    message: '',
    data: { records: [], total: 0, size: 0, current: 1, pages: 0 },
  })),
}));

const ROOT = '/proj';
const SRC = `${ROOT}/src`;
const SUB = `${SRC}/sub`;
const NOTES = `${ROOT}/notes`;

/** src 下有 4 个代码文件（其中 2 个在未展开的 sub/ 中）+ 1 个非代码文件；notes 下没有代码文件 */
const fileTree: any[] = [
  {
    id: '1', name: 'src', type: 'folder', path: SRC,
    children: [
      { id: '2', name: 'a.scala', type: 'file', path: `${SRC}/a.scala` },
      { id: '3', name: 'b.sql', type: 'file', path: `${SRC}/b.sql` },
      { id: '4', name: 'readme.md', type: 'file', path: `${SRC}/readme.md` },
      {
        id: '5', name: 'sub', type: 'folder', path: SUB,
        children: [
          { id: '6', name: 'c.java', type: 'file', path: `${SUB}/c.java` },
          { id: '7', name: 'd.py', type: 'file', path: `${SUB}/d.py` },
        ],
      },
    ],
  },
  {
    id: '8', name: 'notes', type: 'folder', path: NOTES,
    children: [{ id: '9', name: 'x.md', type: 'file', path: `${NOTES}/x.md` }],
  },
  { id: '10', name: 'root.sql', type: 'file', path: `${ROOT}/root.sql` },
];

/** 行顺序（仅展开 src；sub / notes 均折叠） */
const ROW = {
  src: 0, aScala: 1, bSql: 2, readmeMd: 3, sub: 4, notes: 5, rootSql: 6,
} as const;

const dsApi = {
  project: { list: vi.fn() },
  workflowDefinition: { list: vi.fn(), createWithTasks: vi.fn(), update: vi.fn(), release: vi.fn() },
} as any;

const renderPanel = (overrides: Record<string, any> = {}) => {
  const props = {
    fileTree,
    rootPath: ROOT,
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
    projectId: 7,
    projectCode: 'demo',
    readFileContent: vi.fn(async () => ''),
    dsApi,
    ...overrides,
  };

  const utils = render(
    <ToastProvider>
      <ExplorerPanel {...props} />
    </ToastProvider>
  );
  const rows = () => Array.from(utils.container.querySelectorAll('div[tabindex]')) as HTMLElement[];
  const openContextMenu = (rowIndex: number) => fireEvent.contextMenu(rows()[rowIndex]);
  const menuItem = (keyword: string) =>
    Array.from(document.querySelectorAll('.explorer-panel__context-menu-item'))
      .find(el => el.textContent?.includes(keyword)) as HTMLElement | undefined;

  return { ...utils, props, rows, openContextMenu, menuItem };
};

describe('ExplorerPanel 右键提交调度', () => {
  it('文件夹：菜单项可用，并标注其下代码文件数量（含未展开子目录）', async () => {
    const { openContextMenu, menuItem } = renderPanel();
    openContextMenu(ROW.src);

    const item = await waitFor(() => {
      const el = menuItem('提交调度');
      expect(el).toBeTruthy();
      return el!;
    });

    // a.scala / b.sql + sub 下未展开的 c.java / d.py = 4
    expect(item.textContent).toContain('(4)');
    expect(item.hasAttribute('disabled')).toBe(false);
  });

  it('点击后打开模态框：目标为右键的文件夹与其下全部代码文件', async () => {
    const { openContextMenu, menuItem } = renderPanel();
    openContextMenu(ROW.src);

    const item = await waitFor(() => {
      const el = menuItem('提交调度');
      expect(el).toBeTruthy();
      return el!;
    });
    fireEvent.click(item);

    const stub = await waitFor(() => {
      const el = document.querySelector('[data-testid="submit-schedule-stub"]') as HTMLElement;
      expect(el).toBeTruthy();
      return el;
    });
    expect(stub.getAttribute('data-folder')).toBe(SRC);
    // 折叠的 sub/ 下的代码文件同样计入
    expect(stub.getAttribute('data-files')?.split(',')).toEqual([
      `${SRC}/a.scala`, `${SRC}/b.sql`, `${SUB}/c.java`, `${SUB}/d.py`,
    ]);
  });

  it('代码文件：不显示「提交调度」菜单项（该功能只作用于文件夹）', async () => {
    const { openContextMenu, menuItem } = renderPanel();
    openContextMenu(ROW.aScala);

    // 菜单已弹出（以「重命名」为锚点），但没有「提交调度」
    await waitFor(() => expect(menuItem('重命名')).toBeTruthy());
    expect(menuItem('提交调度')).toBeUndefined();
  });

  it('文件夹与文件混选：不显示「提交调度」菜单项', async () => {
    const { rows, menuItem } = renderPanel();
    fireEvent.click(rows()[ROW.src], { ctrlKey: true });
    fireEvent.click(rows()[ROW.readmeMd], { ctrlKey: true });
    fireEvent.contextMenu(rows()[ROW.src]);

    await waitFor(() => expect(menuItem('重命名')).toBeTruthy());
    expect(menuItem('提交调度')).toBeUndefined();
  });

  it('文件夹下没有代码文件时：菜单项置灰并说明原因', async () => {
    const { openContextMenu, menuItem } = renderPanel();
    openContextMenu(ROW.notes);

    const item = await waitFor(() => {
      const el = menuItem('提交调度');
      expect(el).toBeTruthy();
      return el!;
    });

    expect(item.hasAttribute('disabled')).toBe(true);
    expect(item.getAttribute('title')).toContain('没有可提交调度的代码文件');
  });

  it('未提供调度 API 时：菜单项置灰（无调度上下文无法提交）', async () => {
    const { openContextMenu, menuItem } = renderPanel({ dsApi: null });
    openContextMenu(ROW.src);

    const item = await waitFor(() => {
      const el = menuItem('提交调度');
      expect(el).toBeTruthy();
      return el!;
    });

    expect(item.hasAttribute('disabled')).toBe(true);
    expect(item.getAttribute('title')).toContain('调度系统不可用');
  });
});
