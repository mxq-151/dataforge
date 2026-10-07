import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import AlertLogSection from './AlertLogSection';

/**
 * 告警记录（站内告警箱）测试。
 *
 * 这个区段存在的意义就是「订阅配了之后，告警到底发了没有、没发是什么原因」，
 * 因此断言集中在两件事上：**投递状态**（SENT / PENDING / FAILED）与**触发状态**
 * （因为什么告警）都被如实展示，且失败原因不被吞掉。
 */

const h = vi.hoisted(() => {
  const state = { fail: false, empty: false, lastParams: null as unknown };

  const records = [
    {
      id: 1,
      runId: 100,
      taskId: 9,
      taskName: '广告域质检',
      ruleId: 21,
      ruleName: 'R_AD_001 事件主键唯一',
      channel: 'WEBHOOK',
      receiver: 'zhangsan,lisi',
      status: 'FAILED',
      failReason: 'Webhook 返回 HTTP 500',
      sendTime: '',
      checkStatus: 'ERROR',
    },
  ];

  const pending = [
    {
      id: 2,
      runId: 100,
      taskId: 9,
      taskName: '广告域质检',
      ruleId: null,
      ruleName: 'R_AD_002 金额非空',
      channel: 'EMAIL',
      receiver: 'wangwu',
      status: 'PENDING',
      failReason: '邮件通道未配置，已登记待发（第一期实际投递的是站内记录与 Webhook）',
      sendTime: '',
      checkStatus: 'WARN',
    },
  ];

  return { state, records, pending };
});

vi.mock('../../api/quality', () => ({
  qualityApi: {
    listAlertLogs: async (params: unknown) => {
      h.state.lastParams = params;
      if (h.state.fail) throw new Error('接口不可用');
      const status = (params as { status?: string })?.status;
      const records = h.state.empty
        ? []
        : status === 'PENDING'
          ? h.pending
          : [...h.records, ...h.pending];
      return { code: 200, data: { records, total: records.length, size: 20, current: 1, pages: 1 } };
    },
  },
}));

beforeEach(() => {
  h.state.fail = false;
  h.state.empty = false;
  h.state.lastParams = null;
});

describe('AlertLogSection 告警记录', () => {
  it('渲染投递状态与触发状态：失败记录带出原因，待发记录写明未配置', async () => {
    render(<AlertLogSection />);

    await waitFor(() => expect(screen.getByText('R_AD_001 事件主键唯一')).toBeTruthy());

    expect(screen.getAllByText('广告域质检').length).toBeGreaterThan(0);
    // 「触发状态」与「投递状态」两列都在表内；表外还有筛选下拉的同名选项，所以断言要限定在表内
    const table = screen.getByRole('table');
    // 触发状态（因为什么告警）
    expect(within(table).getByText('红色异常')).toBeTruthy();
    expect(within(table).getByText('橙色异常')).toBeTruthy();
    // 投递状态（发出去了没有）
    expect(within(table).getByText('投递失败')).toBeTruthy();
    expect(within(table).getByText('待发')).toBeTruthy();
    // 失败/未投递的原因不能被吞掉
    expect(screen.getByText('Webhook 返回 HTTP 500')).toBeTruthy();
    expect(screen.getByText(/邮件通道未配置/)).toBeTruthy();
    // 渠道按中文展示
    expect(within(table).getByText('Webhook')).toBeTruthy();
    expect(within(table).getByText('邮件')).toBeTruthy();
  });

  it('规则未登记时不空着，明确标出以便排查关联断点', async () => {
    render(<AlertLogSection />);

    await waitFor(() => expect(screen.getByText('规则未登记')).toBeTruthy());
  });

  it('按投递状态筛选会带下去请求，并重置到第一页', async () => {
    render(<AlertLogSection />);
    await waitFor(() => expect(screen.getByText('R_AD_001 事件主键唯一')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('按投递状态筛选'), { target: { value: 'PENDING' } });

    await waitFor(() =>
      expect(h.state.lastParams).toMatchObject({ current: 1, status: 'PENDING' })
    );
    await waitFor(() => expect(screen.queryByText('R_AD_001 事件主键唯一')).toBeNull());
  });

  it('接口不可用时降级为说明文案，不白屏', async () => {
    h.state.fail = true;
    render(<AlertLogSection />);

    await waitFor(() =>
      expect(screen.getByText('告警记录接口不可用，暂时无法加载记录。')).toBeTruthy()
    );
  });

  it('无记录时给出空态说明', async () => {
    h.state.empty = true;
    render(<AlertLogSection />);

    await waitFor(() =>
      expect(screen.getByText('暂无告警记录。校验命中订阅条件后会在此留痕。')).toBeTruthy()
    );
  });
});
