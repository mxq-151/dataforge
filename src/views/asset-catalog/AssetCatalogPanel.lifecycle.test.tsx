import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, configure } from '@testing-library/react';
import AssetCatalogPanel from './AssetCatalogPanel';
import { ToastProvider } from '../../components/Toast';

// 全量并行跑测时机器负载高，默认 1s 的异步查询超时偶发不够，放宽到 5s
configure({ asyncUtilTimeout: 5000 });

/**
 * 资产目录「生命周期」链路测试。
 *
 * 覆盖：只读查看态回显 → 点「编辑生命周期」进入编辑态 → 校验拦截 → 提交成功后写接口、退出编辑态
 * → 写失败 toast 且保持编辑态 → 详情接口不可用时降级为「不可用 + 重新加载」。
 *
 * 概览页签中其余治理区块（负责人 / 分类属性 / 标签）同属 AssetGovernanceEditor，
 * 交互模式一致，本文件只深挖生命周期这一条，避免与其它专项测试重复。
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
    healthIssueCount: 0,
    columns: [],
    tags: [],
  };

  // 用一个可变标志控制详情接口成败，便于断言「重新加载」确实重新发起了请求
  const state = { detailFails: false };

  const api = {
    getCatalogTree: vi.fn(async () => ({ code: 200, data: [tableNode] })),
    getTableDetail: vi.fn(async () => {
      if (state.detailFails) throw new Error('接口不可用');
      // 每次返回浅拷贝，模拟服务端重拉后引用变化（治理编辑器据此回填并退出编辑态）
      return { code: 200, data: { ...detail } };
    }),
    // 写成功后更新本地 detail，模拟「重拉详情拿到最新值」
    updateLifecycle: vi.fn(async (_id: number, payload: Record<string, number>) => {
      Object.assign(detail, payload);
      return { code: 200, data: null };
    }),
    // 默认页签为「资产概况」，面板挂载即会探测这 5 个接口；本文件不覆盖概况，
    // 统一返回空数据让看板落到「暂无数据」，避免因未定义方法抛错。
    getInventoryByEnvProject: vi.fn(async () => ({ code: 200, data: [] })),
    getTopAssets: vi.fn(async () => ({ code: 200, data: [] })),
    getTopComputeTasks: vi.fn(async () => ({ code: 200, data: [] })),
    getTaskDelayRate: vi.fn(async () => ({ code: 200, data: null })),
    getSizeGrowthAnomalies: vi.fn(async () => ({ code: 200, data: [] })),

    // ── 「资产目录」页签挂载后会被触达的接口（本文件不断言其行为，只保证不抛错）──
    search: vi.fn(async () => ({ code: 200, data: { tables: [], columns: [], indicators: [], total: 0 } })),
    suggest: vi.fn(async () => ({ code: 200, data: [] })),
    getInventoryOverview: vi.fn(async () => ({ code: 200, data: null })),
    getInventoryHealth: vi.fn(async () => ({ code: 200, data: [] })),
    getAnnotationGaps: vi.fn(async () => ({ code: 200, data: null })),
    listCategories: vi.fn(async () => ({ code: 200, data: [] })),
    listTags: vi.fn(async () => ({ code: 200, data: [] })),
    updateOwner: vi.fn(async () => ({ code: 200, data: null })),
    updateCategory: vi.fn(async () => ({ code: 200, data: null })),
    updateTags: vi.fn(async () => ({ code: 200, data: null })),
    refreshTableMetadata: vi.fn(async () => ({ code: 200, data: null })),
    getTableIndicators: vi.fn(async () => ({ code: 200, data: [] })),
    getTableProducers: vi.fn(async () => ({ code: 200, data: [] })),
    getTableQuality: vi.fn(async () => ({ code: 200, data: null })),
    previewTable: vi.fn(async () => ({ code: 200, data: { columns: [], rows: [] } })),
    getTableDoc: vi.fn(async () => ({ code: 200, data: null })),
    saveTableDoc: vi.fn(async () => ({ code: 200, data: null })),
    listDocHistory: vi.fn(async () => ({ code: 200, data: [] })),
    // 负责人下拉的平台用户来源
    getUserList: vi.fn(async () => ({
      code: 200,
      data: {
        records: [
          { id: 1, username: 'zhangsan', realName: '张三', email: '', phone: '', status: 1 },
          { id: 2, username: 'lisi', realName: '李四', email: '', phone: '', status: 1 },
        ],
        total: 2,
        current: 1,
        size: 200,
      },
    })),
    // 租户列表：用户 1/2 各自绑定一个租户，负责人存的是这里的 tenantCode
    getTenantList: vi.fn(async () => ({
      code: 200,
      data: {
        records: [
          { id: 1, tenantCode: 'T001', tenantName: '租户一', userId: 1, username: 'zhangsan', userRealName: '张三' },
          { id: 2, tenantCode: 'T002', tenantName: '租户二', userId: 2, username: 'lisi', userRealName: '李四' },
        ],
        total: 2,
        current: 1,
        size: 200,
      },
    })),
  };

  return { tableNode, detail, state, api };
});

vi.mock('../../api/assetCatalog', () => ({
  // 面板与环境切换器都从该模块读环境定义：整体替换时必须一并提供，
  // 否则 AssetEnvSwitch 取不到 ASSET_ENV_OPTIONS 会直接抛错（默认环境的生产态也依赖它渲染）。
  ASSET_ENV_OPTIONS: [
    { value: 'prod', label: '生产' },
    { value: 'gray', label: '灰度' },
    { value: 'test', label: '测试' },
  ],
  DEFAULT_ASSET_ENV: 'prod',
  assetCatalogApi: {
    getCatalogTree: () => h.api.getCatalogTree(),
    getTableDetail: (id: number) => h.api.getTableDetail(id),
    updateLifecycle: (id: number, payload: unknown) => h.api.updateLifecycle(id, payload),
    getInventoryByEnvProject: () => h.api.getInventoryByEnvProject(),
    getTopAssets: (params: unknown) => h.api.getTopAssets(params),
    getTopComputeTasks: (params: unknown) => h.api.getTopComputeTasks(params),
    getTaskDelayRate: (params: unknown) => h.api.getTaskDelayRate(params),
    getSizeGrowthAnomalies: (params: unknown) => h.api.getSizeGrowthAnomalies(params),

    search: (params: unknown) => h.api.search(params),
    suggest: (keyword: string) => h.api.suggest(keyword),
    getInventoryOverview: (params?: unknown) => h.api.getInventoryOverview(params),
    getInventoryHealth: () => h.api.getInventoryHealth(),
    getAnnotationGaps: (params?: unknown) => h.api.getAnnotationGaps(params),
    listCategories: () => h.api.listCategories(),
    listTags: () => h.api.listTags(),
    updateOwner: (id: number, payload: unknown) => h.api.updateOwner(id, payload),
    updateCategory: (id: number, payload: unknown) => h.api.updateCategory(id, payload),
    updateTags: (id: number, tags: unknown) => h.api.updateTags(id, tags),
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

// 负责人下拉的数据源（系统用户）；不 mock 会走真实 request，徒增噪声
vi.mock('../../api/systemUser', () => ({
  systemUserApi: {
    getUserList: (params: unknown) => h.api.getUserList(params),
  },
}));

// 负责人存的是租户编码，需要租户列表把用户映射到 tenantCode
vi.mock('../../api/systemTenant', () => ({
  tenantApi: {
    getList: (params: unknown) => h.api.getTenantList(params),
  },
}));

const renderPanel = () =>
  render(
    <ToastProvider>
      <AssetCatalogPanel />
    </ToastProvider>
  );

/** 切到「资产目录」页签并点击目录树里的表节点（选中后右栏显示概览页签） */
async function selectTable() {
  fireEvent.click(screen.getByText('资产目录'));
  fireEvent.click(await screen.findByText('dwd_trade_order_d'));
}

/** 按标签取表固有信息区块里的展示值（该区块与数据探索模块共用 TableDetailContent） */
function infoValue(label: string): string {
  const item = screen.getByText(label).closest('.table-detail-modal__info-item');
  return item?.querySelector('.table-detail-modal__value')?.textContent ?? '';
}

beforeEach(() => {
  h.state.detailFails = false;
  h.detail.hotDays = 90;
  h.detail.coldDays = 180;
  h.detail.keepDays = 720;
  h.api.getCatalogTree.mockClear();
  h.api.getTableDetail.mockClear();
  h.api.updateLifecycle.mockClear();
  h.api.updateOwner.mockClear();
});

describe('AssetCatalogPanel 生命周期', () => {
  it('选中表后回显热/冷/保留天数', async () => {
    renderPanel();
    await selectTable();

    await waitFor(() => expect(screen.getByLabelText('编辑生命周期')).toBeTruthy());
    expect(infoValue('热数据天数')).toBe('90');
    expect(infoValue('冷数据天数')).toBe('180');
    expect(infoValue('保留天数')).toBe('720');
    expect(h.api.getTableDetail).toHaveBeenCalledWith(1);
  });

  it('默认只读，点「编辑生命周期」才进入编辑态', async () => {
    renderPanel();
    await selectTable();

    // 查看态：三个天数只读展示，没有输入框
    await waitFor(() => expect(screen.getByLabelText('编辑生命周期')).toBeTruthy());
    expect(screen.queryByLabelText(/热数据天数/)).toBeNull();

    fireEvent.click(screen.getByLabelText('编辑生命周期'));

    expect(await screen.findByLabelText(/热数据天数/)).toBeTruthy();
    expect(screen.getByLabelText(/冷数据天数/)).toBeTruthy();
    expect(screen.getByLabelText(/保留天数/)).toBeTruthy();
  });

  it('热数据天数大于冷数据天数时拦截提交', async () => {
    renderPanel();
    await selectTable();
    fireEvent.click(await screen.findByLabelText('编辑生命周期'));

    fireEvent.change(await screen.findByLabelText(/热数据天数/), { target: { value: '200' } });
    fireEvent.click(screen.getByLabelText('保存'));

    expect(await screen.findByText('热数据天数不得大于冷数据天数')).toBeTruthy();
    expect(h.api.updateLifecycle).not.toHaveBeenCalled();
  });

  it('非整数天数按校验拦截', async () => {
    renderPanel();
    await selectTable();
    fireEvent.click(await screen.findByLabelText('编辑生命周期'));

    fireEvent.change(await screen.findByLabelText(/保留天数/), { target: { value: '720.5' } });
    fireEvent.click(screen.getByLabelText('保存'));

    expect(await screen.findByText('保留天数须为大于 0 的整数天数')).toBeTruthy();
    expect(h.api.updateLifecycle).not.toHaveBeenCalled();
  });

  it('提交合法生命周期后写接口、退出编辑态并回填', async () => {
    renderPanel();
    await selectTable();
    fireEvent.click(await screen.findByLabelText('编辑生命周期'));

    fireEvent.change(await screen.findByLabelText(/热数据天数/), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText(/冷数据天数/), { target: { value: '120' } });
    fireEvent.change(screen.getByLabelText(/保留天数/), { target: { value: '900' } });
    fireEvent.click(screen.getByLabelText('保存'));

    await waitFor(() =>
      expect(h.api.updateLifecycle).toHaveBeenCalledWith(1, { hotDays: 30, coldDays: 120, keepDays: 900 })
    );
    // 保存成功后退出编辑态（输入框消失，回到只读展示）
    await waitFor(() => expect(screen.queryByLabelText(/热数据天数/)).toBeNull());
    expect(screen.getByLabelText('编辑生命周期')).toBeTruthy();
    await waitFor(() => expect(infoValue('热数据天数')).toBe('30'));
    expect(infoValue('保留天数')).toBe('900');
  });

  it('写失败走 toast 提示，且保持编辑态', async () => {
    h.api.updateLifecycle.mockRejectedValueOnce(new Error('权限不足'));
    renderPanel();
    await selectTable();
    fireEvent.click(await screen.findByLabelText('编辑生命周期'));

    fireEvent.click(await screen.findByLabelText('保存'));

    expect(await screen.findByText('生命周期更新失败：权限不足')).toBeTruthy();
    // 失败后仍停留在编辑态，输入框仍在
    expect(screen.getByLabelText(/热数据天数/)).toBeTruthy();
  });

  it('详情接口不可用时降级显示，并可重新加载', async () => {
    h.state.detailFails = true;
    renderPanel();
    await selectTable();

    await waitFor(() => expect(screen.getByText('资产详情接口不可用，表详情暂无法读取。')).toBeTruthy());
    expect(h.api.getTableDetail).toHaveBeenCalledTimes(1);

    h.state.detailFails = false;
    fireEvent.click(screen.getByText('重新加载'));

    await waitFor(() => expect(screen.getByLabelText('编辑生命周期')).toBeTruthy());
    expect(h.api.getTableDetail).toHaveBeenCalledTimes(2);
  });

  it('负责人下拉列出已绑定租户的平台用户，取值为其租户编码', async () => {
    renderPanel();
    await selectTable();
    fireEvent.click(await screen.findByLabelText('编辑负责人'));

    const select = (await screen.findByLabelText('业务负责人')) as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    // 选项值 = 租户编码，展示文字 = 平台用户
    await waitFor(() =>
      expect(Array.from(select.querySelectorAll('option')).map(o => o.value)).toEqual(['', 'T001', 'T002'])
    );
    expect(Array.from(select.querySelectorAll('option')).map(o => o.textContent)).toContain('张三（zhangsan）');
  });

  it('选择平台用户并保存，负责人写接口收到其租户编码', async () => {
    renderPanel();
    await selectTable();
    fireEvent.click(await screen.findByLabelText('编辑负责人'));

    const select = await screen.findByLabelText('业务负责人');
    await waitFor(() =>
      expect(Array.from(select.querySelectorAll('option')).map(o => o.value)).toContain('T001')
    );
    fireEvent.change(select, { target: { value: 'T001' } });
    fireEvent.click(screen.getByLabelText('保存'));

    await waitFor(() =>
      expect(h.api.updateOwner).toHaveBeenCalledWith(1, { businessOwner: 'T001', techOwner: '' })
    );
  });
});
