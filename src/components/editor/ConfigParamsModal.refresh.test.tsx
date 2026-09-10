import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import ConfigParamsModal from './ConfigParamsModal';
import { ToastProvider } from '../Toast';
import { fetchProjectConfigByFilePath } from '../../api/devProject';

/**
 * 配置参数弹窗（编辑器单文件入口）的「打开时内容是否刷新」回归测试。
 *
 * 场景对应的问题：在文件编辑框里右键 →「配置参数」，弹窗显示的内容没有刷新
 * （仍残留上一次打开的文件 / 上一次拉取的结果）。
 *
 * 这里钉住三件事：
 * 1. 每次打开都按当前 filePath 重新拉取；
 * 2. 切换到另一个文件再打开，绝不残留上一个文件的值；
 * 3. 同一文件重新打开时，展示的是后端最新值（不缓存上一次的结果）。
 */

vi.mock('../../api/devProject', () => ({
  fetchProjectConfigByFilePath: vi.fn(),
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

/** 构造后端 /params 查询响应；runParams 即「程序参数」 */
const configOf = (runParams: Record<string, string>, engine = 'spark') => ({
  code: 200,
  message: '',
  data: {
    projectId: 1,
    filePath: '',
    engine,
    datasources: [],
    jarDependencyCatalogs: [],
    runParams,
    computeResources: {},
    remark: '',
  },
});

const renderModal = (props: Record<string, any> = {}) =>
  render(
    <ToastProvider>
      <ConfigParamsModal
        visible
        onClose={vi.fn()}
        onSave={vi.fn()}
        filePath={`${ROOT}/a.scala`}
        fileContent={'/*\n * @引擎: spark\n */\n'}
        rootPath={ROOT}
        projectId={1}
        projectCode="demo_project"
        {...props}
      />
    </ToastProvider>
  );

/** 切到「配置程序参数」页并读出当前参数键值对 */
const readProgramParams = async (): Promise<[string, string][]> => {
  const tab = await waitFor(() => {
    const el = Array.from(document.querySelectorAll('.config-params__tab'))
      .find(t => t.textContent?.includes('配置程序参数')) as HTMLElement | undefined;
    expect(el).toBeTruthy();
    return el!;
  });
  fireEvent.click(tab);
  await waitFor(() => {
    expect(document.querySelector('.config-params__section')).toBeTruthy();
  });
  return Array.from(document.querySelectorAll('.config-params__input--key')).map((keyEl, i) => {
    const row = keyEl.closest('div')?.parentElement ?? document.body;
    const valueEl = row.querySelectorAll('.config-params__input--value')[0] as HTMLInputElement | null;
    return [(keyEl as HTMLInputElement).value, valueEl?.value ?? ''];
  });
};

describe('ConfigParamsModal 打开时刷新', () => {
  beforeEach(() => {
    vi.mocked(fetchProjectConfigByFilePath).mockReset();
  });

  it('打开时按 filePath 拉取并展示该文件的配置', async () => {
    vi.mocked(fetchProjectConfigByFilePath).mockResolvedValue(
      configOf({ env: 'first' }) as any
    );
    const { container } = renderModal();

    expect(await readProgramParams()).toContainEqual(['env', 'first']);
    expect(fetchProjectConfigByFilePath).toHaveBeenCalledWith(1, 'a.scala');
    expect(container.querySelector('.config-params-modal')).toBeTruthy();
  });

  it('换成另一个文件再打开：展示新文件的配置，不残留上一个文件的值', async () => {
    vi.mocked(fetchProjectConfigByFilePath).mockResolvedValue(configOf({ env: 'a' }) as any);
    const { rerender } = renderModal();

    expect(await readProgramParams()).toContainEqual(['env', 'a']);

    // 关闭 → 切到 b.sql → 重新打开
    vi.mocked(fetchProjectConfigByFilePath).mockResolvedValue(configOf({ env: 'b' }) as any);
    const tree = (path: string) => (
      <ToastProvider>
        <ConfigParamsModal
          visible
          onClose={vi.fn()}
          onSave={vi.fn()}
          filePath={path}
          fileContent={'/*\n * @引擎: spark\n */\n'}
          rootPath={ROOT}
          projectId={1}
          projectCode="demo_project"
        />
      </ToastProvider>
    );

    rerender(<>{tree(`${ROOT}/b.sql`)}</>);

    await waitFor(async () => {
      const params = await readProgramParams();
      expect(params).toContainEqual(['env', 'b']);
    });
    // 旧值不得残留
    expect(await readProgramParams()).not.toContainEqual(['env', 'a']);
    expect(fetchProjectConfigByFilePath).toHaveBeenLastCalledWith(1, 'b.sql');
  });

  it('同一文件重新打开：展示后端最新值（不缓存上一次结果）', async () => {
    vi.mocked(fetchProjectConfigByFilePath).mockResolvedValue(configOf({ env: 'old' }) as any);
    const { rerender, ...rest } = renderModal();

    expect(await readProgramParams()).toContainEqual(['env', 'old']);

    // 关闭弹窗
    rerender(
      <ToastProvider>
        <ConfigParamsModal
          visible={false}
          onClose={vi.fn()}
          filePath={`${ROOT}/a.scala`}
          fileContent={'/*\n * @引擎: spark\n */\n'}
          rootPath={ROOT}
          projectId={1}
        />
      </ToastProvider>
    );
    expect(rest.container.querySelector('.config-params-modal')).toBeNull();

    // 期间后端的值已被别处修改
    vi.mocked(fetchProjectConfigByFilePath).mockResolvedValue(configOf({ env: 'new' }) as any);

    // 重新打开同一文件
    rerender(
      <ToastProvider>
        <ConfigParamsModal
          visible
          onClose={vi.fn()}
          filePath={`${ROOT}/a.scala`}
          fileContent={'/*\n * @引擎: spark\n */\n'}
          rootPath={ROOT}
          projectId={1}
        />
      </ToastProvider>
    );

    await waitFor(async () => {
      const params = await readProgramParams();
      expect(params).toContainEqual(['env', 'new']);
    });
    expect(fetchProjectConfigByFilePath).toHaveBeenCalledTimes(2);
  });

  it('竞态：先打开的文件的响应更慢时，不得覆盖后打开文件的内容', async () => {
    // 第一次（a.scala）的响应由我们手动控制，保持挂起；第二次（b.sql）立即返回
    let resolveFirst: ((v: unknown) => void) | null = null;
    const slowFirst = new Promise(resolve => { resolveFirst = resolve; });

    vi.mocked(fetchProjectConfigByFilePath)
      .mockImplementationOnce(() => slowFirst as any)
      .mockImplementationOnce(async () => configOf({ env: 'b' }) as any);

    const modal = (path: string, visible = true) => (
      <ToastProvider>
        <ConfigParamsModal
          visible={visible}
          onClose={vi.fn()}
          onSave={vi.fn()}
          filePath={path}
          fileContent={'/*\n * @引擎: spark\n */\n'}
          rootPath={ROOT}
          projectId={1}
          projectCode="demo_project"
        />
      </ToastProvider>
    );

    const { rerender } = render(modal(`${ROOT}/a.scala`));

    // a.scala 的请求还挂着，此时切到 b.sql 并拿到 b 的配置
    rerender(modal(`${ROOT}/b.sql`));
    await waitFor(async () => {
      expect(await readProgramParams()).toContainEqual(['env', 'b']);
    });

    // 现在 a.scala 的慢响应才回来：它必须被丢弃，不能把 b 的内容顶掉
    resolveFirst!(configOf({ env: 'a' }));
    await new Promise(r => setTimeout(r, 20));

    const params = await readProgramParams();
    expect(params).toContainEqual(['env', 'b']);
    expect(params).not.toContainEqual(['env', 'a']);
  });
});
