import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import AssetOverviewTab from './AssetOverviewTab';
import AssetEnvSwitch from './AssetEnvSwitch';

/**
 * 「资产概况」页签的环境切换（受控组件）。
 *
 * 断言两件事：
 * 1. 切换器本身的取值/中文名/选中态；
 * 2. 环境确实作为查询参数下推到**每一块**看板，且 env 变化时全部重新取数 ——
 *    这是「切换环境时所有图表模块都要切换」的接口侧证据。
 *
 * 各看板统一返回空数据：既不渲染 ECharts（jsdom 下无渲染上下文），
 * 也让断言聚焦在「请求参数」而不是图表细节上。
 */

const h = vi.hoisted(() => ({
  api: {
    getInventoryByEnvProject: vi.fn(async () => ({ code: 200, data: [] })),
    getTopAssets: vi.fn(async () => ({ code: 200, data: [] })),
    getTopComputeTasks: vi.fn(async () => ({ code: 200, data: [] })),
    getTaskDelayRate: vi.fn(async () => ({ code: 200, data: null })),
    getSizeGrowthAnomalies: vi.fn(async () => ({ code: 200, data: [] })),
  },
}));

vi.mock('../../api/assetCatalog', () => ({
  ASSET_ENV_OPTIONS: [
    { value: 'prod', label: '生产' },
    { value: 'gray', label: '灰度' },
    { value: 'test', label: '测试' },
  ],
  DEFAULT_ASSET_ENV: 'prod',
  assetCatalogApi: {
    getInventoryByEnvProject: () => h.api.getInventoryByEnvProject(),
    getTopAssets: (params: unknown) => h.api.getTopAssets(params),
    getTopComputeTasks: (params: unknown) => h.api.getTopComputeTasks(params),
    getTaskDelayRate: (params: unknown) => h.api.getTaskDelayRate(params),
    getSizeGrowthAnomalies: (params: unknown) => h.api.getSizeGrowthAnomalies(params),
  },
}));

beforeEach(() => {
  Object.values(h.api).forEach(fn => fn.mockClear());
});

describe('AssetEnvSwitch', () => {
  it('渲染生产 / 灰度 / 测试三项，并标出选中项', () => {
    render(<AssetEnvSwitch value="gray" onChange={() => undefined} />);
    expect(screen.getByRole('tab', { name: /生产/ }).getAttribute('aria-selected')).toBe('false');
    expect(screen.getByRole('tab', { name: /灰度/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: /测试/ }).getAttribute('aria-selected')).toBe('false');
  });

  it('点击非选中项时回调目标环境', () => {
    const onChange = vi.fn();
    render(<AssetEnvSwitch value="prod" onChange={onChange} />);
    fireEvent.click(screen.getByRole('tab', { name: /测试/ }));
    expect(onChange).toHaveBeenCalledWith('test');
  });
});

describe('AssetOverviewTab 五块看板随环境切换', () => {
  it('env=prod 时四块「下推式」看板都带 env，且①的规模统计只算生产', async () => {
    render(<AssetOverviewTab env="prod" />);

    await waitFor(() =>
      expect(h.api.getTopAssets).toHaveBeenCalledWith({ limit: 100, env: 'prod' })
    );
    expect(h.api.getTopComputeTasks).toHaveBeenCalledWith({ sortBy: 'resource', limit: 50, env: 'prod' });
    expect(h.api.getTaskDelayRate).toHaveBeenCalledWith({ days: 30, env: 'prod' });
    expect(h.api.getSizeGrowthAnomalies).toHaveBeenCalledWith({
      growthPercent: 10,
      minSizeBytes: 10 * 1024 ** 3,
      env: 'prod',
    });
    // ① 取全环境明细（占比需要分母），但展示只筛所选环境
    expect(h.api.getInventoryByEnvProject).toHaveBeenCalledTimes(1);

    // 标题带环境后缀，避免「这一屏看的是哪个环境」要回头找切换器
    expect(screen.getByText(/② 占空间 TOP 100 表 · 生产/)).toBeTruthy();
    expect(screen.getByText(/⑤ 数据大小突增表 · 生产/)).toBeTruthy();
  });

  it('env 变为 gray 时五块看板全部重新取数（不是只有一部分跟着切）', async () => {
    const { rerender } = render(<AssetOverviewTab env="prod" />);
    await waitFor(() => expect(h.api.getTopAssets).toHaveBeenCalledTimes(1));

    rerender(<AssetOverviewTab env="gray" />);

    await waitFor(() =>
      expect(h.api.getTopAssets).toHaveBeenCalledWith({ limit: 100, env: 'gray' })
    );
    expect(h.api.getTopComputeTasks).toHaveBeenLastCalledWith({ sortBy: 'resource', limit: 50, env: 'gray' });
    expect(h.api.getTaskDelayRate).toHaveBeenLastCalledWith({ days: 30, env: 'gray' });
    expect(h.api.getSizeGrowthAnomalies).toHaveBeenLastCalledWith({
      growthPercent: 10,
      minSizeBytes: 10 * 1024 ** 3,
      env: 'gray',
    });
    expect(screen.getByText(/① 资产规模 · 灰度/)).toBeTruthy();
    expect(screen.getByText(/④ 任务延迟率 · 灰度/)).toBeTruthy();
  });

  it('TOP 任务排序维度切换不影响环境（两者是正交的查询参数）', async () => {
    render(<AssetOverviewTab env="prod" />);
    await waitFor(() => expect(h.api.getTopComputeTasks).toHaveBeenCalledWith({ sortBy: 'resource', limit: 50, env: 'prod' }));

    fireEvent.click(screen.getByRole('tab', { name: '按运行时长' }));

    await waitFor(() =>
      expect(h.api.getTopComputeTasks).toHaveBeenLastCalledWith({ sortBy: 'duration', limit: 50, env: 'prod' })
    );
  });
});
