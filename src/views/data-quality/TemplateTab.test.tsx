import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import TemplateTab from './TemplateTab';
import { ToastProvider } from '../../components/Toast';

/**
 * 规则模板页签测试。
 *
 * 覆盖「页签 ↔ 接口」的接线：内置模板只读、自定义模板 CRUD、提交前校验对齐服务端
 * （单条 SELECT/WITH、7 类之一、编码名称非空）、SQL 预览走 preview-sql。
 */

const h = vi.hoisted(() => {
  const state = {
    created: null as Record<string, unknown> | null,
    deleted: null as number | null,
    updated: null as Record<string, unknown> | null,
  };

  const builtin = [
    {
      id: 1,
      templateCode: 'PRIMARY_KEY_UNIQUE',
      templateName: '主键唯一性',
      ruleType: 'PRIMARY_KEY_UNIQUE',
      templateKind: 'builtin' as const,
      sqlTemplate: 'SELECT ${column} FROM ${table} GROUP BY ${column} HAVING COUNT(1) > 1',
      fieldTypes: '',
      paramSchema: '',
      remark: '主键/唯一键重复检测',
      enabled: true,
    },
  ];

  const custom = [
    {
      id: 21,
      templateCode: 'CUSTOM_AMT_RANGE',
      templateName: '订单金额区间',
      ruleType: 'VALUE_RANGE',
      templateKind: 'custom' as const,
      sqlTemplate: 'SELECT COUNT(1) FROM ${table} WHERE ${column} < 0',
      fieldTypes: 'decimal',
      paramSchema: '',
      remark: '',
      enabled: true,
    },
  ];

  const api = {
    listBuiltinTemplates: vi.fn(async () => ({ code: 200, data: builtin })),
    listTemplates: vi.fn(async () => ({
      code: 200,
      data: { records: custom, total: custom.length, size: 10, current: 1, pages: 1 },
    })),
    createTemplate: vi.fn(async (payload: Record<string, unknown>) => {
      state.created = payload;
      return { code: 200, data: null };
    }),
    updateTemplate: vi.fn(async (payload: Record<string, unknown>) => {
      state.updated = payload;
      return { code: 200, data: null };
    }),
    deleteTemplate: vi.fn(async (id: number) => {
      state.deleted = id;
      return { code: 200, data: null };
    }),
    previewSql: vi.fn(async () => ({
      code: 200,
      data: { sql: 'SELECT COUNT(1) FROM dwd.dwd_trade_order_d WHERE amt IS NULL' },
    })),
  };

  const dsApi = {
    fetchAllDataSources: vi.fn(async () => ({
      code: 200,
      data: [{ id: 7, datasourceName: 'hive-prod' }],
    })),
    fetchTablesByDataSourceId: vi.fn(async () => ({
      code: 200,
      data: { records: [{ datasourceId: 7, databaseName: 'dwd', tableName: 'dwd_trade_order_d' }] },
    })),
  };

  return { state, api, dsApi, builtin, custom };
});

vi.mock('../../api/quality', () => ({
  qualityApi: {
    listBuiltinTemplates: () => h.api.listBuiltinTemplates(),
    listTemplates: (params: unknown) => h.api.listTemplates(params),
    createTemplate: (payload: Record<string, unknown>) => h.api.createTemplate(payload),
    updateTemplate: (payload: Record<string, unknown>) => h.api.updateTemplate(payload),
    deleteTemplate: (id: number) => h.api.deleteTemplate(id),
    previewSql: (payload: unknown) => h.api.previewSql(payload),
  },
}));

vi.mock('../../api/datasource', () => ({
  fetchAllDataSources: () => h.dsApi.fetchAllDataSources(),
  fetchTablesByDataSourceId: (id: number) => h.dsApi.fetchTablesByDataSourceId(id),
}));

const renderTab = () =>
  render(
    <ToastProvider>
      <TemplateTab />
    </ToastProvider>
  );

beforeEach(() => {
  h.state.created = null;
  h.state.deleted = null;
  h.state.updated = null;
});

describe('TemplateTab 规则模板', () => {
  it('内置模板按 builtin 接口渲染，且只提供「预览 SQL」（不可改不可删）', async () => {
    renderTab();
    await waitFor(() => expect(screen.getByText('PRIMARY_KEY_UNIQUE')).toBeTruthy());

    expect(h.api.listBuiltinTemplates).toHaveBeenCalled();

    // 断言必须限定在内置区块内：自定义区块同样有「编辑 / 删除 / 预览 SQL」
    const builtinSection = screen.getByText('内置模板（只读）').closest('section') as HTMLElement;
    expect(within(builtinSection).getByText('PRIMARY_KEY_UNIQUE')).toBeTruthy();
    // 「主键唯一性」在内置行出现两次：模板名称 + 规则类型标签
    expect(within(builtinSection).getAllByText('主键唯一性').length).toBeGreaterThan(0);
    expect(within(builtinSection).getByText('预览 SQL')).toBeTruthy();
    expect(within(builtinSection).queryByText('编辑')).toBeNull();
    expect(within(builtinSection).queryByText('删除')).toBeNull();
  });

  it('自定义模板分页接口渲染出模板与操作入口', async () => {
    renderTab();
    await waitFor(() => expect(screen.getByText('CUSTOM_AMT_RANGE')).toBeTruthy());

    expect(h.api.listTemplates).toHaveBeenCalledWith({ current: 1, size: 10, keyword: undefined });
    expect(screen.getByText('订单金额区间')).toBeTruthy();
    expect(screen.getByText('编辑')).toBeTruthy();
    expect(screen.getByText('删除')).toBeTruthy();
  });

  it('非 SELECT 的 SQL 模板被提交前拦截，不调创建接口', async () => {
    renderTab();
    await waitFor(() => expect(screen.getByText('CUSTOM_AMT_RANGE')).toBeTruthy());

    fireEvent.click(screen.getByText('新建模板'));
    fireEvent.change(screen.getByLabelText('模板编码'), { target: { value: 'CUSTOM_X' } });
    fireEvent.change(screen.getByLabelText('模板名称'), { target: { value: '自定义X' } });
    fireEvent.change(screen.getByLabelText('SQL 模板'), { target: { value: 'DELETE FROM ${table}' } });
    fireEvent.click(screen.getByText('保存'));

    expect(await screen.findByText(/必须是一条 SELECT \/ WITH 查询/)).toBeTruthy();
    expect(h.api.createTemplate).not.toHaveBeenCalled();
  });

  it('合法模板提交后调创建接口，模板类型固定为 custom', async () => {
    renderTab();
    await waitFor(() => expect(screen.getByText('CUSTOM_AMT_RANGE')).toBeTruthy());

    fireEvent.click(screen.getByText('新建模板'));
    fireEvent.change(screen.getByLabelText('模板编码'), { target: { value: 'CUSTOM_X' } });
    fireEvent.change(screen.getByLabelText('模板名称'), { target: { value: '自定义X' } });
    fireEvent.change(screen.getByLabelText('SQL 模板'), {
      target: { value: 'SELECT COUNT(1) FROM ${table} WHERE ${column} IS NULL' },
    });
    fireEvent.click(screen.getByText('保存'));

    await waitFor(() => expect(h.api.createTemplate).toHaveBeenCalledTimes(1));
    expect(h.state.created).toMatchObject({
      templateCode: 'CUSTOM_X',
      templateName: '自定义X',
      templateKind: 'custom',
      ruleType: 'PRIMARY_KEY_UNIQUE',
      enabled: true,
    });
  });

  it('删除需二次确认，确认后调删除接口', async () => {
    renderTab();
    await waitFor(() => expect(screen.getByText('CUSTOM_AMT_RANGE')).toBeTruthy());

    fireEvent.click(screen.getByText('删除'));
    expect(await screen.findByText('删除模板')).toBeTruthy();

    fireEvent.click(screen.getByText('确认删除'));
    await waitFor(() => expect(h.api.deleteTemplate).toHaveBeenCalledWith(21));
    expect(h.state.deleted).toBe(21);
  });

  it('SQL 预览选定目标表后调 preview-sql 并渲染返回值', async () => {
    renderTab();
    await waitFor(() => expect(screen.getByText('CUSTOM_AMT_RANGE')).toBeTruthy());

    // 自定义行上的「预览 SQL」
    fireEvent.click(screen.getAllByText('预览 SQL')[1]);
    expect(await screen.findByText(/SQL 预览 · 订单金额区间/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('数据源'), { target: { value: '7' } });
    await waitFor(() => expect(screen.getByLabelText('库')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('库'), { target: { value: 'dwd' } });
    fireEvent.change(screen.getByLabelText('表'), { target: { value: 'dwd_trade_order_d' } });
    fireEvent.click(screen.getByText('渲染 SQL'));

    await waitFor(() => expect(h.api.previewSql).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByText('SELECT COUNT(1) FROM dwd.dwd_trade_order_d WHERE amt IS NULL')).toBeTruthy()
    );
    expect(h.api.previewSql).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: 21, datasourceId: 7, databaseName: 'dwd', tableName: 'dwd_trade_order_d' })
    );
  });
});
