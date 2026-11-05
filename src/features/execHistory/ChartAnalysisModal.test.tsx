import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// ECharts 在 jsdom 下无法真正渲染画布，且本用例只覆盖「结果集切换」逻辑，整体 mock 掉
vi.mock('echarts', () => {
  const instance = { setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() };
  return { init: vi.fn(() => instance) };
});

import ChartAnalysisModal, { type ChartResultData } from './ChartAnalysisModal';

const makeResult = (id: string, columns: string[], rows: string[][]): ChartResultData => ({
  id,
  columns,
  rows,
});

const RESULTS: ChartResultData[] = [
  makeResult('r1', ['月份', '销量'], [['1月', '10'], ['2月', '20']]),
  makeResult('r2', ['城市', '订单数'], [['北京', '100'], ['上海', '200']]),
];

/** 通过标签文本找到对应的按钮元素 */
const tabOf = (label: RegExp) => screen.getByText(label).closest('button') as HTMLButtonElement;

describe('ChartAnalysisModal 结果集切换', () => {
  beforeEach(() => {
    // jsdom 未实现 ResizeObserver，图表容器初始化时会用到
    (globalThis as any).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  it('打开时默认展示第一个结果', () => {
    render(<ChartAnalysisModal visible onClose={() => {}} results={RESULTS} />);
    expect(screen.getByText('月份')).toBeTruthy();
    expect(tabOf(/结果 1/).className).toContain('ca-result-tab--active');
  });

  it('多结果时点击结果标签可真正切换（回归：曾被打回第一个结果）', () => {
    render(<ChartAnalysisModal visible onClose={() => {}} results={RESULTS} />);

    fireEvent.click(screen.getByText(/结果 2/));

    // 表格数据切换到第二个结果
    expect(screen.getByText('城市')).toBeTruthy();
    expect(screen.queryByText('月份')).toBeNull();
    // 激活态落在第二个标签上，且第一个标签已取消激活
    expect(tabOf(/结果 2/).className).toContain('ca-result-tab--active');
    expect(tabOf(/结果 1/).className).not.toContain('ca-result-tab--active');
  });

  it('切换结果后仍可设置图表样式，并保留已选图表类型', () => {
    render(<ChartAnalysisModal visible onClose={() => {}} results={RESULTS} />);

    // 先选柱状图
    fireEvent.click(screen.getByText('柱状图'));
    expect(screen.getByText('横轴')).toBeTruthy();

    // 切到第二个结果：图表类型应保留为柱状图（不再被打回表格）
    fireEvent.click(screen.getByText(/结果 2/));
    expect(screen.getByText('柱状图').closest('button')?.className).toContain('ca-chart-type--active');
    expect(tabOf(/结果 2/).className).toContain('ca-result-tab--active');
    // 横轴/纵轴按新结果的列重建
    expect(screen.getByText('横轴')).toBeTruthy();
  });
});
