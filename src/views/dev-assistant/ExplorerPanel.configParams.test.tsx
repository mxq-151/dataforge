import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import ExplorerPanel from './ExplorerPanel';
import { ToastProvider } from '../../components/Toast';
import { saveProjectConfig } from '../../api/devProject';

/**
 * 文件浏览器右键「配置参数」的回归测试。
 *
 * 需求：右键菜单新增「配置参数」；选中文件夹时，为该文件夹下的**所有代码文件**
 * 配置**相同**的参数。
 *
 * 这里同时钉住三个容易回归的点：
 * 1. 菜单项只在**位于 code 目录下数仓分层目录**（code/ads|dws|dwd|ods|dqc|dim，含更深子目录）
 *    的文件夹上出现；
 * 2. 目标文件取自完整的 fileTree（useFileSystem 一次性构建），
 *    而不是当前渲染出来的行 —— 因此**未展开**的子目录里的代码文件也必须被算进去；
 * 3. 保存时逐文件 upsert，每个文件带各自代码头解析出的引擎，
 *    但依赖 / 程序参数 / 任务参数完全一致。
 */

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
/** code 下的数仓分层目录：右键目标（命中可见性规则） */
const LAYER = `${ROOT}/TEST/code/ods`;
/** 分层目录下更深的子目录：同样命中 */
const SUB = `${LAYER}/sub`;
/** code 下但不是数仓分层名：不显示菜单 */
const CODE_UTILS = `${ROOT}/TEST/code/utils`;
/** 分层名相同但父目录不是 code：不显示菜单 */
const SQL_LAYER = `${ROOT}/TEST/sql/ods`;
/** code/分层 目录，但其下没有代码文件：显示但置灰 */
const EMPTY_LAYER = `${ROOT}/TEST/code/dim`;

/** ods 下有 4 个代码文件（其中 2 个在未展开的 sub/ 中）+ 1 个非代码文件 */
const fileTree: any[] = [
  {
    id: '1', name: 'ods', type: 'folder', path: LAYER,
    children: [
      { id: '2', name: 'a.scala', type: 'file', path: `${LAYER}/a.scala` },
      { id: '3', name: 'b.sql', type: 'file', path: `${LAYER}/b.sql` },
      { id: '4', name: 'readme.md', type: 'file', path: `${LAYER}/readme.md` },
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
    id: '8', name: 'dim', type: 'folder', path: EMPTY_LAYER,
    children: [{ id: '9', name: 'x.md', type: 'file', path: `${EMPTY_LAYER}/x.md` }],
  },
  { id: '10', name: 'utils', type: 'folder', path: CODE_UTILS, children: [] },
  { id: '11', name: 'ods', type: 'folder', path: SQL_LAYER, children: [] },
  { id: '12', name: 'root.sql', type: 'file', path: `${ROOT}/root.sql` },
  { id: '13', name: 'root.md', type: 'file', path: `${ROOT}/root.md` },
];

/** 行顺序（仅展开 ods；sub / dim / utils / sql-ods 均折叠） */
const ROW = {
  ods: 0, aScala: 1, bSql: 2, readmeMd: 3, sub: 4,
  dim: 5, codeUtils: 6, sqlOds: 7, rootSql: 8, rootMd: 9,
} as const;

/** 按文件名返回带 @引擎 的代码头，用于验证「逐文件解析引擎」 */
const headerFor = (engines: Record<string, string>) =>
  vi.fn(async (p: string) => {
    const name = p.split('/').pop() || '';
    const engine = engines[name] ?? '';
    return `/*\n * @备注: test\n * @引擎: ${engine}\n */\n`;
  });

const renderPanel = (overrides: Record<string, any> = {}) => {
  const onSaveConfigParams = vi.fn();
  const props = {
    fileTree,
    rootPath: ROOT,
    isLoading: false,
    selectedFile: null,
    expandedFolders: new Set<string>([LAYER]),
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
    projectCode: 'demo_project',
    onSaveConfigParams,
    ...overrides,
  };

  const utils = render(
    <ToastProvider>
      <ExplorerPanel {...props} />
    </ToastProvider>
  );
  const rows = () => Array.from(utils.container.querySelectorAll('div[tabindex]')) as HTMLElement[];
  /** 树容器（对空白处右键时作为事件目标） */
  const wrapper = () => utils.container.querySelector('.file-navigator-wrapper') as HTMLElement;

  const openContextMenu = (rowIndex: number) => fireEvent.contextMenu(rows()[rowIndex]);

  /** 取当前弹出的右键菜单项（按可见文本匹配） */
  const menuItem = (keyword: string) =>
    Array.from(document.querySelectorAll('.explorer-panel__context-menu-item'))
      .find(el => el.textContent?.includes(keyword)) as HTMLElement | undefined;

  return { ...utils, props, rows, wrapper, openContextMenu, menuItem };
};

/** 右键某行 → 点击「配置参数」→ 等待弹窗出现 */
const openConfigParamsModal = async (
  openContextMenu: (rowIndex: number) => void,
  menuItem: (keyword: string) => HTMLElement | undefined,
  rowIndex: number
) => {
  openContextMenu(rowIndex);
  const item = await waitFor(() => {
    const el = menuItem('配置参数');
    expect(el).toBeTruthy();
    return el!;
  });
  fireEvent.click(item);
  await waitFor(() => {
    expect(document.querySelector('.config-params-modal')).toBeTruthy();
  });
};

/** 目标文件列表项（按列表里展示的相对路径定位） */
const batchFileItem = (relativePath: string) =>
  Array.from(document.querySelectorAll('.config-params__batch-file-item')).find(
    el => el.querySelector('span')?.textContent === relativePath
  ) as HTMLElement | undefined;

const batchFileCheckbox = (relativePath: string) =>
  batchFileItem(relativePath)?.querySelector('input') as HTMLInputElement | undefined;

/** 列表里展示的全部路径文本 */
const batchFileLabels = () =>
  Array.from(document.querySelectorAll('.config-params__batch-file-item span')).map(s => s.textContent);

/** 展示路径：项目编码 + 项目目录相对路径 */
const LABEL = (rel: string) => `demo_project/${rel}`;

describe('ExplorerPanel 右键配置参数', () => {
  beforeEach(() => {
    vi.mocked(saveProjectConfig).mockClear();
    vi.mocked(saveProjectConfig).mockResolvedValue({ code: 200, message: '' } as any);
  });

  it('code/分层目录：菜单项可用，并标注其下代码文件数量（含未展开子目录）', async () => {
    const { openContextMenu, menuItem } = renderPanel();
    openContextMenu(ROW.ods);

    const item = await waitFor(() => {
      const el = menuItem('配置参数');
      expect(el).toBeTruthy();
      return el!;
    });

    // a.scala / b.sql + sub 下未展开的 c.java / d.py = 4
    expect(item.textContent).toContain('(4)');
    expect(item.hasAttribute('disabled')).toBe(false);
  });

  it('code/分层 的更深深层子目录：同样显示菜单项', async () => {
    const { openContextMenu, menuItem } = renderPanel();
    openContextMenu(ROW.sub);

    const item = await waitFor(() => {
      const el = menuItem('配置参数');
      expect(el).toBeTruthy();
      return el!;
    });

    // sub 下 c.java / d.py
    expect(item.textContent).toContain('(2)');
  });

  it('code 下但非数仓分层目录（code/utils）：不显示「配置参数」菜单项', async () => {
    const { openContextMenu, menuItem } = renderPanel();
    openContextMenu(ROW.codeUtils);

    // 菜单已弹出（以「重命名」为锚点，确认菜单确实渲染了）
    await waitFor(() => expect(menuItem('重命名')).toBeTruthy());
    expect(menuItem('配置参数')).toBeUndefined();
  });

  it('非 code 目录下的同名分层目录（sql/ods）：不显示「配置参数」菜单项', async () => {
    const { openContextMenu, menuItem } = renderPanel();
    openContextMenu(ROW.sqlOds);

    await waitFor(() => expect(menuItem('重命名')).toBeTruthy());
    expect(menuItem('配置参数')).toBeUndefined();
  });

  it('code/分层目录下没有代码文件时：菜单项置灰并说明原因', async () => {
    const { openContextMenu, menuItem } = renderPanel();
    openContextMenu(ROW.dim);

    const item = await waitFor(() => {
      const el = menuItem('配置参数');
      expect(el).toBeTruthy();
      return el!;
    });

    expect(item.hasAttribute('disabled')).toBe(true);
    expect(item.getAttribute('title')).toContain('没有可配置参数的代码文件');
  });

  it('代码文件：不显示「配置参数」菜单项（该功能只作用于文件夹）', async () => {
    const { openContextMenu, menuItem } = renderPanel();
    openContextMenu(ROW.aScala);

    // 菜单已弹出（以「重命名」为锚点，确认菜单确实渲染了）
    await waitFor(() => {
      expect(menuItem('重命名')).toBeTruthy();
    });
    expect(menuItem('配置参数')).toBeUndefined();
  });

  it('非代码文件：同样不显示「配置参数」菜单项', async () => {
    const { openContextMenu, menuItem } = renderPanel();
    openContextMenu(ROW.rootMd);

    await waitFor(() => {
      expect(menuItem('重命名')).toBeTruthy();
    });
    expect(menuItem('配置参数')).toBeUndefined();
  });

  it('空白处右键：不显示「配置参数」菜单项', async () => {
    const { wrapper, menuItem } = renderPanel();
    fireEvent.contextMenu(wrapper());

    await waitFor(() => {
      expect(menuItem('新建文件')).toBeTruthy();
    });
    expect(menuItem('配置参数')).toBeUndefined();
  });

  it('文件夹与文件混选：不显示「配置参数」菜单项', async () => {
    const { rows, menuItem } = renderPanel();
    // Ctrl 多选：ods 文件夹 + readme.md
    fireEvent.click(rows()[ROW.ods], { ctrlKey: true });
    fireEvent.click(rows()[ROW.readmeMd], { ctrlKey: true });
    fireEvent.contextMenu(rows()[ROW.ods]);

    await waitFor(() => {
      expect(menuItem('重命名')).toBeTruthy();
    });
    // 混选时目标不全是文件夹，不提供该项
    expect(menuItem('配置参数')).toBeUndefined();
  });

  it('多选两个 code/分层目录：菜单项可用且合并统计代码文件', async () => {
    const { rows, menuItem } = renderPanel();
    // dim 下没有代码文件，合并后仍为 ods 的 4 个
    fireEvent.click(rows()[ROW.ods], { ctrlKey: true });
    fireEvent.click(rows()[ROW.dim], { ctrlKey: true });
    fireEvent.contextMenu(rows()[ROW.ods]);

    const item = await waitFor(() => {
      const el = menuItem('配置参数');
      expect(el).toBeTruthy();
      return el!;
    });
    expect(item.textContent).toContain('(4)');
  });

  it('未提供 projectId 时：菜单项置灰（无法落库）', async () => {
    const { openContextMenu, menuItem } = renderPanel({ projectId: undefined });
    openContextMenu(ROW.ods);

    const item = await waitFor(() => {
      const el = menuItem('配置参数');
      expect(el).toBeTruthy();
      return el!;
    });

    expect(item.hasAttribute('disabled')).toBe(true);
  });

  it('保存：把同一份参数逐文件写入，各文件带各自代码头解析出的引擎', async () => {
    const readFileContent = headerFor({ 'a.scala': 'spark', 'b.sql': 'spark', 'c.java': 'java', 'd.py': 'python' });
    const { openContextMenu, menuItem, props } = renderPanel({ readFileContent, projectId: 7 });

    openContextMenu(ROW.ods);
    const item = await waitFor(() => {
      const el = menuItem('配置参数');
      expect(el).toBeTruthy();
      return el!;
    });
    fireEvent.click(item);

    // 切到「配置程序参数」页并添加一条参数，用于校验「同一份参数」被原样下发
    const progTab = await waitFor(() => {
      const el = Array.from(document.querySelectorAll('.config-params__tab'))
        .find(t => t.textContent?.includes('配置程序参数')) as HTMLElement | undefined;
      expect(el).toBeTruthy();
      return el!;
    });
    fireEvent.click(progTab);

    const addBtn = await waitFor(() => {
      const el = Array.from(document.querySelectorAll('.config-params__add-btn'))
        .find(b => b.textContent?.trim() === '添加') as HTMLElement | undefined;
      expect(el).toBeTruthy();
      return el!;
    });
    fireEvent.click(addBtn);
    const keyInput = document.querySelector('.config-params__input--key') as HTMLInputElement;
    fireEvent.change(keyInput, { target: { value: 'env' } });
    const valueInput = document.querySelector('.config-params__input--value') as HTMLInputElement;
    fireEvent.change(valueInput, { target: { value: 'prod' } });

    // 等批量引擎解析完成（readFileContent 对每个目标各读一次）
    await waitFor(() => {
      expect(readFileContent).toHaveBeenCalledTimes(4);
    });

    const saveBtn = document.querySelector('.config-params__btn--save') as HTMLElement;
    fireEvent.mouseDown(saveBtn);

    await waitFor(() => {
      expect(vi.mocked(saveProjectConfig)).toHaveBeenCalledTimes(4);
    });

    const calls = vi.mocked(saveProjectConfig).mock.calls;
    // 路径为「项目根目录相对路径」，引擎取自各文件自己的代码头（未展开子目录的文件同样被写入）
    expect(calls.map(c => [c[1].filePath, c[1].engine])).toEqual([
      ['TEST/code/ods/a.scala', 'spark'],
      ['TEST/code/ods/b.sql', 'spark'],
      ['TEST/code/ods/sub/c.java', 'java'],
      ['TEST/code/ods/sub/d.py', 'python'],
    ]);
    // 所有目标拿到的 projectId 与参数完全一致
    calls.forEach(c => {
      expect(c[0]).toBe(7);
      expect(c[1].runParams).toEqual({ env: 'prod' });
      expect(c[1].computeResources).toEqual({ 'lineage.enabled': 'true' });
    });
    // 逐文件回调父组件，便于按路径刷新内存态配置
    expect(props.onSaveConfigParams).toHaveBeenCalledTimes(4);
    expect(props.onSaveConfigParams).toHaveBeenCalledWith(
      `${LAYER}/a.scala`,
      expect.objectContaining({ programParams: [{ id: expect.any(String), key: 'env', value: 'prod' }] })
    );
  });

  it('保存：全部目标引擎一致时，按该引擎补齐默认任务参数', async () => {
    const readFileContent = headerFor({ 'a.scala': 'spark', 'b.sql': 'spark', 'c.java': 'spark', 'd.py': 'spark' });
    const { openContextMenu, menuItem } = renderPanel({ readFileContent });

    openContextMenu(ROW.ods);
    const item = await waitFor(() => {
      const el = menuItem('配置参数');
      expect(el).toBeTruthy();
      return el!;
    });
    fireEvent.click(item);

    // 切到任务参数页，应能看到 spark 引擎的默认参数
    const taskTab = await waitFor(() => {
      const el = Array.from(document.querySelectorAll('.config-params__tab'))
        .find(t => t.textContent?.includes('配置任务参数')) as HTMLElement | undefined;
      expect(el).toBeTruthy();
      return el!;
    });

    await waitFor(() => {
      expect(readFileContent).toHaveBeenCalledTimes(4);
    });
    fireEvent.click(taskTab);

    await waitFor(() => {
      const keys = Array.from(document.querySelectorAll('.config-params__input--key'))
        .map(i => (i as HTMLInputElement).value);
      expect(keys).toContain('spark.executor.cores');
    });
  });

  it('目标文件列表：展示「项目编码 + 项目目录相对路径」，且默认全部勾选', async () => {
    const readFileContent = headerFor({});
    const { openContextMenu, menuItem } = renderPanel({ readFileContent });
    await openConfigParamsModal(openContextMenu, menuItem, ROW.ods);

    // 首级为项目编码，其后为项目目录相对路径；不含项目目录的绝对前缀
    expect(batchFileLabels()).toEqual([
      LABEL('TEST/code/ods/a.scala'),
      LABEL('TEST/code/ods/b.sql'),
      LABEL('TEST/code/ods/sub/c.java'),
      LABEL('TEST/code/ods/sub/d.py'),
    ]);
    expect(batchFileLabels().some(p => p?.startsWith(ROOT))).toBe(false);

    // 默认全选
    const boxes = Array.from(
      document.querySelectorAll<HTMLInputElement>('.config-params__batch-file-item input')
    );
    expect(boxes).toHaveLength(4);
    expect(boxes.every(b => b.checked)).toBe(true);
    expect(document.querySelector('.config-params__batch-badge')?.textContent).toBe('4 个文件');
  });

  it('取消勾选的文件不会被写入（只写已勾选目标）', async () => {
    const readFileContent = headerFor({
      'a.scala': 'spark', 'b.sql': 'spark', 'c.java': 'java', 'd.py': 'python',
    });
    const { openContextMenu, menuItem, props } = renderPanel({ readFileContent, projectId: 7 });
    await openConfigParamsModal(openContextMenu, menuItem, ROW.ods);

    await waitFor(() => {
      expect(readFileContent).toHaveBeenCalledTimes(4);
    });

    // 取消 b.sql 与 sub/d.py（按展示路径定位）
    fireEvent.click(batchFileCheckbox(LABEL('TEST/code/ods/b.sql'))!);
    fireEvent.click(batchFileCheckbox(LABEL('TEST/code/ods/sub/d.py'))!);

    await waitFor(() => {
      expect(document.querySelector('.config-params__batch-badge')?.textContent).toBe('已选 2 / 4');
    });

    fireEvent.mouseDown(document.querySelector('.config-params__btn--save') as HTMLElement);

    await waitFor(() => {
      expect(vi.mocked(saveProjectConfig)).toHaveBeenCalledTimes(2);
    });
    const calls = vi.mocked(saveProjectConfig).mock.calls;
    // 未勾选的两个文件完全没被写入；剩余两个仍带各自的引擎。
    // 注意落库路径仍是「项目目录相对路径」，不带项目编码（DB 行已带 projectId）
    expect(calls.map(c => [c[1].filePath, c[1].engine])).toEqual([
      ['TEST/code/ods/a.scala', 'spark'],
      ['TEST/code/ods/sub/c.java', 'java'],
    ]);
    expect(props.onSaveConfigParams).toHaveBeenCalledTimes(2);
  });

  it('全部取消勾选：保存按钮禁用，不会写入任何文件', async () => {
    const readFileContent = headerFor({ 'a.scala': 'spark' });
    const { openContextMenu, menuItem } = renderPanel({ readFileContent });
    await openConfigParamsModal(openContextMenu, menuItem, ROW.ods);

    await waitFor(() => {
      expect(readFileContent).toHaveBeenCalledTimes(4);
    });

    const selectAll = document.querySelector(
      '.config-params__batch-select-all input'
    ) as HTMLInputElement;
    fireEvent.click(selectAll);

    await waitFor(() => {
      expect(document.querySelector('.config-params__batch-badge')?.textContent).toBe('已选 0 / 4');
    });

    const saveBtn = document.querySelector('.config-params__btn--save') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
    fireEvent.mouseDown(saveBtn);
    expect(vi.mocked(saveProjectConfig)).not.toHaveBeenCalled();
  });

  it('未提供项目编码时：列表回退为项目目录相对路径', async () => {
    const readFileContent = headerFor({});
    const { openContextMenu, menuItem } = renderPanel({ readFileContent, projectCode: undefined });
    await openConfigParamsModal(openContextMenu, menuItem, ROW.ods);

    expect(batchFileLabels()).toEqual([
      'TEST/code/ods/a.scala',
      'TEST/code/ods/b.sql',
      'TEST/code/ods/sub/c.java',
      'TEST/code/ods/sub/d.py',
    ]);
  });

  it('再次点击全选：恢复为全部勾选', async () => {
    const readFileContent = headerFor({});
    const { openContextMenu, menuItem } = renderPanel({ readFileContent });
    await openConfigParamsModal(openContextMenu, menuItem, ROW.ods);

    const selectAll = () =>
      document.querySelector('.config-params__batch-select-all input') as HTMLInputElement;

    fireEvent.click(selectAll());
    await waitFor(() => {
      expect(document.querySelector('.config-params__batch-badge')?.textContent).toBe('已选 0 / 4');
    });

    fireEvent.click(selectAll());
    await waitFor(() => {
      expect(document.querySelector('.config-params__batch-badge')?.textContent).toBe('4 个文件');
    });
    const boxes = Array.from(
      document.querySelectorAll<HTMLInputElement>('.config-params__batch-file-item input')
    );
    expect(boxes.every(b => b.checked)).toBe(true);
  });
});
