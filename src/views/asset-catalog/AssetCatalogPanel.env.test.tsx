import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import AssetCatalogPanel from './AssetCatalogPanel';
import { ToastProvider } from '../../components/Toast';

/**
 * 「资产目录」页签的环境切换。
 *
 * 断言环境作为查询参数覆盖到本页签的**全部**内容——目录树、检索、治理项三块；
 * 并验证切换环境时会把「已选中的表」清掉（否则右栏会停在不属于当前环境的表上）。
 *
 * 与 lifecycle 测试同样的处理方式：整体替换 `api/assetCatalog`，
 * 因此必须一并提供环境定义常量（面板与切换器都从该模块读）。
 */

const h = vi.hoisted(() => {
  const tableNode = {
    key: 'table:1',
    label: 'dwd_trade_order_d',
    nodeKind: 'table' as const,
    tableMetadataId: 1,
    datasourceId: 7,
    databaseName: 'dwd_trade_prod',
    tableName: 'dwd_trade_order_d',
  };

  // 引擎视角的「库」节点：库名遵循 {分层}_{业务域}_{环境}，用于验证选中库时的收窄
  const dbNode = {
    key: 'db:7:dwd_trade_prod',
    label: 'dwd_trade_prod',
    nodeKind: 'database' as const,
    datasourceId: 7,
    databaseName: 'dwd_trade_prod',
  };

  const detail = {
    id: 1,
    datasourceId: 7,
    datasourceName: 'hive-prod',
    storageEngine: 'hive',
    databaseName: 'dwd_trade_prod',
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
    healthIssueCount: 0,
    columns: [],
    tags: [],
  };

  const api = {
    getCatalogTree: vi.fn(async () => ({ code: 200, data: [dbNode, tableNode] })),
    getTableDetail: vi.fn(async () => ({ code: 200, data: detail })),
    // 概况页签（面板默认页签）挂载即探测的 5 个接口，统一空数据
    getInventoryByEnvProject: vi.fn(async () => ({ code: 200, data: [] })),
    getTopAssets: vi.fn(async () => ({ code: 200, data: [] })),
    getTopComputeTasks: vi.fn(async () => ({ code: 200, data: [] })),
    getTaskDelayRate: vi.fn(async () => ({ code: 200, data: null })),
    getSizeGrowthAnomalies: vi.fn(async () => ({ code: 200, data: [] })),
    // 治理项三块
    getInventoryOverview: vi.fn(async () => ({ code: 200, data: null })),
    getInventoryHealth: vi.fn(async () => ({ code: 200, data: [] })),
    getAnnotationGaps: vi.fn(async () => ({ code: 200, data: null })),
    // 检索
    search: vi.fn(async () => ({ code: 200, data: { tables: [], columns: [], indicators: [], total: 0 } })),
    suggest: vi.fn(async () => ({ code: 200, data: [] })),
    // 详情页签相关（选中表后可能被触达，保证不抛错）
    listCategories: vi.fn(async () => ({ code: 200, data: [] })),
    listTags: vi.fn(async () => ({ code: 200, data: [] })),
    updateOwner: vi.fn(async () => ({ code: 200, data: null })),
    updateCategory: vi.fn(async () => ({ code: 200, data: null })),
    updateTags: vi.fn(async () => ({ code: 200, data: null })),
    updateLifecycle: vi.fn(async () => ({ code: 200, data: null })),
    refreshTableMetadata: vi.fn(async () => ({ code: 200, data: null })),
    getTableIndicators: vi.fn(async () => ({ code: 200, data: [] })),
    getTableProducers: vi.fn(async () => ({ code: 200, data: [] })),
    getTableQuality: vi.fn(async () => ({ code: 200, data: null })),
    previewTable: vi.fn(async () => ({ code: 200, data: { columns: [], rows: [] } })),
    getTableDoc: vi.fn(async () => ({ code: 200, data: null })),
    saveTableDoc: vi.fn(async () => ({ code: 200, data: null })),
    listDocHistory: vi.fn(async () => ({ code: 200, data: [] })),
  };

  return { tableNode, detail, api };
});

vi.mock('../../api/assetCatalog', () => ({
  ASSET_ENV_OPTIONS: [
    { value: 'prod', label: '生产' },
    { value: 'gray', label: '灰度' },
    { value: 'test', label: '测试' },
  ],
  DEFAULT_ASSET_ENV: 'prod',
  assetCatalogApi: {
    getCatalogTree: (params: unknown) => h.api.getCatalogTree(params),
    getTableDetail: (id: number) => h.api.getTableDetail(id),
    getInventoryByEnvProject: () => h.api.getInventoryByEnvProject(),
    getTopAssets: (params: unknown) => h.api.getTopAssets(params),
    getTopComputeTasks: (params: unknown) => h.api.getTopComputeTasks(params),
    getTaskDelayRate: (params: unknown) => h.api.getTaskDelayRate(params),
    getSizeGrowthAnomalies: (params: unknown) => h.api.getSizeGrowthAnomalies(params),
    getInventoryOverview: (params?: unknown) => h.api.getInventoryOverview(params),
    getInventoryHealth: (params?: unknown) => h.api.getInventoryHealth(params),
    getAnnotationGaps: (params?: unknown) => h.api.getAnnotationGaps(params),
    search: (params: unknown) => h.api.search(params),
    suggest: (keyword: string, env?: string) => h.api.suggest(keyword, env),
    listCategories: () => h.api.listCategories(),
    listTags: () => h.api.listTags(),
    updateOwner: (id: number, payload: unknown) => h.api.updateOwner(id, payload),
    updateCategory: (id: number, payload: unknown) => h.api.updateCategory(id, payload),
    updateTags: (id: number, tags: unknown) => h.api.updateTags(id, tags),
    updateLifecycle: (id: number, payload: unknown) => h.api.updateLifecycle(id, payload),
    refreshTableMetadata: (id: number) => h.api.refreshTableMetadata(id),
    getTableIndicators: (id: number) => h.api.getTableIndicators(id),
    getTableProducers: (id: number) => h.api.getTableProducers(id),
    getTableQuality: (id: number) => h.api.getTableQuality(id),
    previewTable: (id: number, params: unknown) => h.api.previewTable(id, params),
    getTableDoc: (id: number) => h.api.getTableDoc(id),
    saveTableDoc: (id: number, content: string) => h.api.saveTableDoc(id, content),
    listDocHistory: (id: number) => h.api.listDocHistory(id),
  },
}));

// 概览页签的负责人下拉会探测系统用户列表；本文件不涉及负责人，返回空即可
vi.mock('../../api/systemUser', () => ({
  systemUserApi: {
    getUserList: vi.fn(async () => ({
      code: 200,
      data: { records: [], total: 0, current: 1, size: 200 },
    })),
  },
}));

// 负责人存的是租户编码，下拉还需租户列表做 userId → tenantCode 映射
vi.mock('../../api/systemTenant', () => ({
  tenantApi: {
    getList: vi.fn(async () => ({
      code: 200,
      data: { records: [], total: 0, current: 1, size: 200 },
    })),
  },
}));

const renderPanel = () =>
  render(
    <ToastProvider>
      <AssetCatalogPanel />
    </ToastProvider>
  );

/** 切到「资产目录」页签 */
const openCatalogTab = () => fireEvent.click(screen.getByText('资产目录'));

beforeEach(() => {
  h.api.getCatalogTree.mockClear();
  h.api.getInventoryOverview.mockClear();
  h.api.getInventoryHealth.mockClear();
  h.api.getAnnotationGaps.mockClear();
  h.api.getTableDetail.mockClear();
  // 概况页签的四块「下推式」看板：跨用例断言重新取数，逐个清掉调用记录
  h.api.getInventoryByEnvProject.mockClear();
  h.api.getTopAssets.mockClear();
  h.api.getTopComputeTasks.mockClear();
  h.api.getTaskDelayRate.mockClear();
  h.api.getSizeGrowthAnomalies.mockClear();
});

describe('AssetCatalogPanel 环境切换', () => {
  it('目录树按默认环境（生产）取数', async () => {
    renderPanel();
    openCatalogTab();

    await waitFor(() =>
      expect(h.api.getCatalogTree).toHaveBeenCalledWith({ view: 'engine', env: 'prod' })
    );
  });

  it('未选中表时的治理项（盘点 / 治理项 / 标注缺口）都带上当前环境', async () => {
    renderPanel();
    openCatalogTab();

    await waitFor(() => expect(h.api.getInventoryOverview).toHaveBeenCalledWith({ env: 'prod' }));
    expect(h.api.getInventoryHealth).toHaveBeenCalledWith({ env: 'prod' });
    expect(h.api.getAnnotationGaps).toHaveBeenCalledWith({ current: 1, size: 200, env: 'prod' });
    expect(screen.getByText('资产盘点 · 生产')).toBeTruthy();
  });

  it('引擎视角选中「库」时，概览按库名解析出的分层与业务域收窄（与规范视角一致）', async () => {
    renderPanel();
    openCatalogTab();
    await waitFor(() => expect(h.api.getCatalogTree).toHaveBeenCalled());

    h.api.getInventoryOverview.mockClear();
    fireEvent.click(await screen.findByText('dwd_trade_prod'));

    // 库名 dwd_trade_prod → 剥离环境后缀后得 分层 dwd + 业务域 trade
    await waitFor(() =>
      expect(h.api.getInventoryOverview).toHaveBeenCalledWith({
        env: 'prod',
        domainCode: 'trade',
        layerCode: 'dwd',
      })
    );
    expect(h.api.getInventoryHealth).toHaveBeenCalledWith({
      env: 'prod',
      domainCode: 'trade',
      layerCode: 'dwd',
    });
  });

  it('切换环境后重新取数，并清掉已选中的表（避免右栏停留在不属于当前环境的表）', async () => {
    renderPanel();
    openCatalogTab();

    // 选中一张生产库的表
    fireEvent.click(await screen.findByText('dwd_trade_order_d'));
    await waitFor(() => expect(h.api.getTableDetail).toHaveBeenCalledWith(1));
    expect(screen.getByText('dwd_trade_prod.dwd_trade_order_d')).toBeTruthy();

    h.api.getCatalogTree.mockClear();
    fireEvent.click(screen.getByRole('tab', { name: /灰度/ }));

    await waitFor(() =>
      expect(h.api.getCatalogTree).toHaveBeenCalledWith({ view: 'engine', env: 'gray' })
    );
    // 选中态被清空：右栏回到「未选中」的治理项视图
    await waitFor(() => expect(screen.queryByText('dwd_trade_prod.dwd_trade_order_d')).toBeNull());
    expect(screen.getByText('资产盘点 · 灰度')).toBeTruthy();
  });

  it('规范视角与环境是两个正交维度，组合后一起下发', async () => {
    renderPanel();
    openCatalogTab();
    await waitFor(() => expect(h.api.getCatalogTree).toHaveBeenCalledWith({ view: 'engine', env: 'prod' }));

    h.api.getCatalogTree.mockClear();
    fireEvent.click(screen.getByRole('tab', { name: /规范视角/ }));

    await waitFor(() =>
      expect(h.api.getCatalogTree).toHaveBeenCalledWith({ view: 'convention', env: 'prod' })
    );
  });

  it('切换器挂在页签条上，两个页签都能看到（不随页签隐藏）', async () => {
    renderPanel();
    // 默认落在「资产概况」页签
    expect(screen.getByRole('tab', { name: /灰度/ })).toBeTruthy();
    openCatalogTab();
    await waitFor(() => expect(h.api.getCatalogTree).toHaveBeenCalled());
    expect(screen.getByRole('tab', { name: /灰度/ })).toBeTruthy();
  });

  it('环境是模块级共用的：在「资产目录」切到灰度后回到「资产概况」，看板也按灰度取数', async () => {
    renderPanel();
    openCatalogTab();
    await waitFor(() => expect(h.api.getCatalogTree).toHaveBeenCalledWith({ view: 'engine', env: 'prod' }));

    fireEvent.click(screen.getByRole('tab', { name: /灰度/ }));
    await waitFor(() => expect(h.api.getCatalogTree).toHaveBeenCalledWith({ view: 'engine', env: 'gray' }));

    // 回到概况页签：五块看板必须按「灰度」取数，而不是回落到默认的生产
    fireEvent.click(screen.getByText('资产概况'));
    await waitFor(() =>
      expect(h.api.getTopAssets).toHaveBeenCalledWith({ limit: 100, env: 'gray' })
    );
    expect(h.api.getTopComputeTasks).toHaveBeenCalledWith({ sortBy: 'resource', limit: 50, env: 'gray' });
    expect(h.api.getTaskDelayRate).toHaveBeenCalledWith({ days: 30, env: 'gray' });
    expect(h.api.getSizeGrowthAnomalies).toHaveBeenCalledWith({
      growthPercent: 10,
      minSizeBytes: 10 * 1024 ** 3,
      env: 'gray',
    });
    expect(screen.getByText(/① 资产规模 · 灰度/)).toBeTruthy();
  });
});
