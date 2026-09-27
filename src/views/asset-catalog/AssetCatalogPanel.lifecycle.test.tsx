import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import AssetCatalogPanel from './AssetCatalogPanel';
import { ToastProvider } from '../../components/Toast';

/**
 * 资产目录「修改生命周期」链路测试。
 *
 * 只覆盖生命周期这一条：三档回显 → 打开弹窗 → 校验拦截 → 提交成功后写接口与就地回填
 * → 写失败 toast → 详情接口不可用时降级为「不可用 + 重新加载」。
 * 目录树与详情由假 api 提供，目录树搜索/检索等其余占位能力不在本文件范围内。
 */

const h = vi.hoisted(() => {
  const tableNode = {
    key: 'table:1',
    label: 'dwd_trade_order_d',
    nodeKind: 'table' as const,
    tableMetadataId: 1,
    datasourceId: 7,
    databaseName: 'dwd',
    tableName: 'dwd_trade_order_d',
  };

  const detail = {
    id: 1,
    datasourceId: 7,
    datasourceName: 'hive-prod',
    storageEngine: 'hive',
    databaseName: 'dwd',
    tableName: 'dwd_trade_order_d',
    tableType: 'MANAGED_TABLE',
    tableComment: '',
    description: '',
    businessOwner: '',
    techOwner: '',
    topic: '',
    visibility: 'internal',
    categoryCode: '',
    layerCode: 'dwd',
    domainCode: 'trade',
    conventionParsed: true,
    refreshCycle: 'd',
    assetLevel: 'L2',
    rowCount: 120,
    sizeBytes: 2048,
    hotDays: 90,
    coldDays: 180,
    keepDays: 720,
    storageFormat: 'parquet',
    location: 'hdfs:///dwd/dwd_trade_order_d',
    partitionColumns: [],
    lastModifyTime: '',
    syncTime: '',
    browseCount30d: 0,
    readCount30d: 0,
    bookmarkCount: 0,
    lastAccessTime: '',
    healthIssueCount: 0,
    bookmarked: false,
    columns: [],
    tags: [],
  };

  // 用一个可变标志控制详情接口成败，便于断言「重新加载」确实重新发起了请求
  const state = { detailFails: false };

  const api = {
    getCatalogTree: vi.fn(async () => ({ code: 200, data: [tableNode] })),
    getTableDetail: vi.fn(async () => {
      if (state.detailFails) throw new Error('接口不可用');
      return { code: 200, data: detail };
    }),
    updateLifecycle: vi.fn(async () => ({ code: 200, data: null })),
  };

  return { tableNode, detail, state, api };
});

vi.mock('../../api/assetCatalog', () => ({
  assetCatalogApi: {
    getCatalogTree: () => h.api.getCatalogTree(),
    getTableDetail: (id: number) => h.api.getTableDetail(id),
    updateLifecycle: (id: number, payload: unknown) => h.api.updateLifecycle(id, payload),
  },
}));

const renderPanel = () =>
  render(
    <ToastProvider>
      <AssetCatalogPanel />
    </ToastProvider>
  );

/** 点击目录树里的表节点（选中后右栏切换到「基础信息 · 生命周期」） */
async function selectTable() {
  fireEvent.click(await screen.findByText('dwd_trade_order_d'));
}

/** 按标签取生命周期卡片上的展示值（值节点里带「天」单位，不能直接用 textContent 相等断言） */
function lifecycleValue(label: string): string {
  const item = screen.getByText(label).closest('.ac-kv__item');
  return item?.querySelector('.ac-kv__value')?.textContent ?? '';
}

beforeEach(() => {
  h.state.detailFails = false;
  h.api.getCatalogTree.mockClear();
  h.api.getTableDetail.mockClear();
  h.api.updateLifecycle.mockClear();
});

describe('AssetCatalogPanel 生命周期', () => {
  it('选中表后回显热/冷/保留天数', async () => {
    renderPanel();
    await selectTable();

    await waitFor(() => expect(screen.getByText('修改生命周期')).toBeTruthy());
    expect(lifecycleValue('热数据天数')).toBe('90天');
    expect(lifecycleValue('冷数据天数')).toBe('180天');
    expect(lifecycleValue('保留天数')).toBe('720天');
    expect(h.api.getTableDetail).toHaveBeenCalledWith(1);
  });

  it('热数据天数大于冷数据天数时拦截提交', async () => {
    renderPanel();
    await selectTable();
    fireEvent.click(await screen.findByText('修改生命周期'));

    fireEvent.change(screen.getByLabelText(/热数据天数/), { target: { value: '200' } });
    fireEvent.click(screen.getByText('确定'));

    expect(await screen.findByText('热数据天数不得大于冷数据天数')).toBeTruthy();
    expect(h.api.updateLifecycle).not.toHaveBeenCalled();
  });

  it('非整数天数按校验拦截', async () => {
    renderPanel();
    await selectTable();
    fireEvent.click(await screen.findByText('修改生命周期'));

    fireEvent.change(screen.getByLabelText(/保留天数/), { target: { value: '720.5' } });
    fireEvent.click(screen.getByText('确定'));

    expect(await screen.findByText('保留天数须为大于 0 的整数天数')).toBeTruthy();
    expect(h.api.updateLifecycle).not.toHaveBeenCalled();
  });

  it('提交合法生命周期后写接口并就地回填', async () => {
    renderPanel();
    await selectTable();
    fireEvent.click(await screen.findByText('修改生命周期'));

    fireEvent.change(screen.getByLabelText(/热数据天数/), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText(/冷数据天数/), { target: { value: '120' } });
    fireEvent.change(screen.getByLabelText(/保留天数/), { target: { value: '900' } });
    fireEvent.click(screen.getByText('确定'));

    await waitFor(() =>
      expect(h.api.updateLifecycle).toHaveBeenCalledWith(1, { hotDays: 30, coldDays: 120, keepDays: 900 })
    );
    await waitFor(() => expect(screen.queryByText(/修改生命周期 · dwd\.dwd_trade_order_d/)).toBeNull());
    expect(lifecycleValue('热数据天数')).toBe('30天');
    expect(lifecycleValue('保留天数')).toBe('900天');
  });

  it('写失败走 toast 提示，弹窗保持打开', async () => {
    h.api.updateLifecycle.mockRejectedValueOnce(new Error('权限不足'));
    renderPanel();
    await selectTable();
    fireEvent.click(await screen.findByText('修改生命周期'));

    fireEvent.click(screen.getByText('确定'));

    expect(await screen.findByText('生命周期更新失败：权限不足')).toBeTruthy();
    expect(screen.getByText(/修改生命周期 · dwd\.dwd_trade_order_d/)).toBeTruthy();
  });

  it('详情接口不可用时降级显示，并可重新加载', async () => {
    h.state.detailFails = true;
    renderPanel();
    await selectTable();

    await waitFor(() => expect(screen.getByText('资产详情接口不可用，生命周期暂无法读取与修改。')).toBeTruthy());
    expect(h.api.getTableDetail).toHaveBeenCalledTimes(1);

    h.state.detailFails = false;
    fireEvent.click(screen.getByText('重新加载'));

    await waitFor(() => expect(screen.getByText('修改生命周期')).toBeTruthy());
    expect(h.api.getTableDetail).toHaveBeenCalledTimes(2);
  });
});