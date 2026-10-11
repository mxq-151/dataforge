import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import AssetDetailTabs from './AssetDetailTabs';
import { ToastProvider } from '../../components/Toast';
import type { AssetTableDetailVO } from '../../api/assetCatalog';

/**
 * 资产详情页签测试。
 *
 * 覆盖「页签 ↔ 接口」的接线本身：概览由宿主注入、指标 / 数据质量 / 数据预览 /
 * 使用说明各自探各自的口，读失败降级为「接口未接入 + 能力清单」。
 * 权限页签无独立端点（只读说明），不在此断言。
 */

const h = vi.hoisted(() => {
  const state = {
    docContent: '初始说明',
    saved: null as { id: number; content: string } | null,
  };

  const api = {
    getTableIndicators: vi.fn(async () => ({
      code: 200,
      data: [
        { id: 11, code: 'IND_ORDER_AMT', name: '订单金额', topic: '交易', businessOwner: '张三', fieldName: 'amt' },
      ],
    })),
    getTableQuality: vi.fn(async () => ({
      code: 200,
      data: {
        ruleCount: 6,
        enabledRuleCount: 5,
        lastRunStatus: 'SUCCESS',
        lastRunTime: '2026-10-06 02:00',
        errorCount: 1,
        failCount: 0,
        problemRuleCount: 2,
        enabledRules: [
          { id: 101, ruleName: '订单号唯一', ruleType: 'PRIMARY_KEY_UNIQUE', columnName: 'order_id', disposeMode: 'BLOCK', ownerName: '张三' },
          { id: 102, ruleName: '当日行数波动', ruleType: 'ROW_COUNT_FLUCTUATION', columnName: '', disposeMode: 'ALERT', ownerName: '李四' },
        ],
        failedSamples: [
          {
            id: 901,
            checkTime: '2026-10-06 02:00',
            ruleName: '订单号唯一',
            ruleType: 'PRIMARY_KEY_UNIQUE',
            status: 'ERROR',
            sample: 'order_id=1001\norder_id=1002',
          },
        ],
      },
    })),
    previewTable: vi.fn(async () => ({
      code: 200,
      data: { columns: ['id', 'amt'], rows: [['1', '100']] },
    })),
    getTableDoc: vi.fn(async () => ({
      code: 200,
      data: { content: state.docContent, updateTime: '2026-10-06 10:00', updateBy: 'zhangsan' },
    })),
    saveTableDoc: vi.fn(async (id: number, content: string) => {
      state.saved = { id, content };
      state.docContent = content;
      return { code: 200, data: null };
    }),
    listDocHistory: vi.fn(async () => ({
      code: 200,
      data: [{ version: 2, updateTime: '2026-10-06 10:00', updateBy: 'zhangsan' }],
    })),
  };

  return { state, api };
});

vi.mock('../../api/assetCatalog', () => ({
  assetCatalogApi: {
    getTableIndicators: (id: number) => h.api.getTableIndicators(id),
    getTableQuality: (id: number) => h.api.getTableQuality(id),
    previewTable: (id: number, params: unknown) => h.api.previewTable(id, params),
    getTableDoc: (id: number) => h.api.getTableDoc(id),
    saveTableDoc: (id: number, content: string) => h.api.saveTableDoc(id, content),
    listDocHistory: (id: number) => h.api.listDocHistory(id),
  },
}));

const detail = {
  id: 1,
  databaseName: 'dwd',
  tableName: 'dwd_trade_order_d',
  visibility: 'internal',
  assetLevel: 'L2',
  businessOwner: '',
  techOwner: '',
} as unknown as AssetTableDetailVO;

const renderTabs = () =>
  render(
    <ToastProvider>
      <AssetDetailTabs
        tableId={1}
        detail={detail}
        overviewContent={<div>概览内容占位</div>}
      />
    </ToastProvider>
  );

const openTab = async (name: string) => {
  fireEvent.click(screen.getByRole('tab', { name }));
};

beforeEach(() => {
  h.state.docContent = '初始说明';
  h.state.saved = null;
});

describe('AssetDetailTabs 页签接线', () => {
  it('默认落在概览页签并渲染宿主注入的内容', () => {
    renderTabs();
    expect(screen.getByText('概览内容占位')).toBeTruthy();
    expect(screen.getByRole('tab', { name: '概览' }).getAttribute('aria-selected')).toBe('true');
  });

  it('指标页签按 /table/{id}/indicators 取数并渲染', async () => {
    renderTabs();
    await openTab('指标');

    await waitFor(() => expect(screen.getByText('IND_ORDER_AMT')).toBeTruthy());
    expect(h.api.getTableIndicators).toHaveBeenCalledWith(1);
    expect(screen.getByText('订单金额')).toBeTruthy();
  });

  it('数据质量页签渲染规则数与未通过规则数', async () => {
    renderTabs();
    await openTab('数据质量');

    await waitFor(() => expect(screen.getByText('未通过规则')).toBeTruthy());
    expect(h.api.getTableQuality).toHaveBeenCalledWith(1);
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('数据质量页签用列表展示已启用质检规则', async () => {
    renderTabs();
    await openTab('数据质量');

    await waitFor(() => expect(screen.getByText('已启用质检规则')).toBeTruthy());
    // 规则名 + 规则类型中文名（编码 → label 由 types/quality 映射）
    expect(screen.getByText('订单号唯一')).toBeTruthy();
    expect(screen.getByText('主键唯一性')).toBeTruthy();
    expect(screen.getByText('行数波动')).toBeTruthy();
    // 处置方式中文名
    expect(screen.getByText('阻断下游')).toBeTruthy();
    expect(screen.getByText('告警')).toBeTruthy();
  });

  it('数据质量页签用列表展示未通过质检记录样例（时间/规则/完整数据样例）', async () => {
    renderTabs();
    await openTab('数据质量');

    await waitFor(() => expect(screen.getByText('未通过质检记录样例')).toBeTruthy());
    expect(screen.getByText('2026-10-06 02:00')).toBeTruthy();
    // 规则名 + 类型中文名同列
    expect(screen.getByText('订单号唯一（主键唯一性）')).toBeTruthy();
    // 状态中文名（统计卡「红色异常」+ 本记录一处）
    expect(screen.getAllByText('红色异常').length).toBeGreaterThan(1);
    // 完整数据样例：多行原文原样渲染
    expect(screen.getByText(/order_id=1001\s+order_id=1002/)).toBeTruthy();
  });

  it('数据预览按 preview 接口渲染列头', async () => {
    renderTabs();
    await openTab('数据预览');

    await waitFor(() => expect(screen.getByText('amt')).toBeTruthy());
    expect(h.api.previewTable).toHaveBeenCalledWith(1, { limit: 20 });
  });

  it('使用说明可编辑并保存（PUT /table/{id}/doc）', async () => {
    renderTabs();
    await openTab('使用说明');

    const textarea = (await screen.findByLabelText('使用说明')) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe('初始说明'));

    fireEvent.change(textarea, { target: { value: '新说明内容' } });
    fireEvent.click(screen.getByText('保存'));

    await waitFor(() => expect(h.api.saveTableDoc).toHaveBeenCalledWith(1, '新说明内容'));
    expect(h.state.saved).toEqual({ id: 1, content: '新说明内容' });
  });

  it('使用说明未修改时保存按钮不可点', async () => {
    renderTabs();
    await openTab('使用说明');

    const button = (await screen.findByText('保存')).closest('button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});
