import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import * as echarts from 'echarts';
import { X, BarChart3, TrendingUp, PieChart, ScatterChart, Table2 } from 'lucide-react';
import './ChartAnalysisModal.css';

/** 传入的结果数据（结构兼容 ExecutionResultTabs 的 ResultItem 子集，避免循环引用） */
export interface ChartResultData {
  id: string;
  columns: string[];
  rows: string[][];
  sqlSnippet?: string;
}

export type ChartTypeKey = 'bar' | 'line' | 'pie' | 'scatter' | 'table';

interface ChartAnalysisModalProps {
  visible: boolean;
  onClose: () => void;
  results: ChartResultData[];
}

const CHART_TYPES: { key: ChartTypeKey; label: string; icon: React.ReactNode }[] = [
  { key: 'table', label: '表格', icon: <Table2 size={14} /> },
  { key: 'bar', label: '柱状图', icon: <BarChart3 size={14} /> },
  { key: 'line', label: '折线图', icon: <TrendingUp size={14} /> },
  { key: 'pie', label: '饼图', icon: <PieChart size={14} /> },
  { key: 'scatter', label: '散点图', icon: <ScatterChart size={14} /> },
];

/** 将单元格字符串解析为数值，失败返回 NaN */
const toNumber = (v: string): number => {
  if (v == null || v === '') return NaN;
  const cleaned = String(v).replace(/[,，%\s]/g, '');
  if (cleaned === '') return NaN;
  const n = Number(cleaned);
  if (!isNaN(n) && isFinite(n)) return n;
  const p = parseFloat(cleaned);
  return isFinite(p) ? p : NaN;
};

/** 判断某列是否为数值列（多数单元格可解析为数字） */
const isNumericColumn = (rows: string[][], colIdx: number): boolean => {
  const nonEmpty = rows.filter(r => r[colIdx] != null && String(r[colIdx]).trim() !== '');
  if (nonEmpty.length === 0) return false;
  const numeric = nonEmpty.filter(r => !isNaN(toNumber(r[colIdx])));
  return numeric.length / nonEmpty.length >= 0.6;
};

const axisLabelColor = '#a5a5a5';
const splitLineColor = '#333333';
const legendColor = '#cccccc';

export default function ChartAnalysisModal({ visible, onClose, results }: ChartAnalysisModalProps) {
  const [activeIdx, setActiveIdx] = useState(0);
  const [chartType, setChartType] = useState<ChartTypeKey>('bar');
  const [xColumn, setXColumn] = useState<string>('');
  const [yColumns, setYColumns] = useState<string[]>([]);

  const chartRef = useRef<HTMLDivElement | null>(null);
  const chartInstanceRef = useRef<echarts.ECharts | null>(null);

  // 当前展示的结果项
  const activeResult = results[Math.min(activeIdx, Math.max(results.length - 1, 0))];

  const numericColumns = useMemo(() => {
    const r = activeResult;
    if (!r) return [] as string[];
    return r.columns.filter((_, i) => isNumericColumn(r.rows, i));
  }, [activeResult]);

  // 结果集标识：仅在所选结果集真正变化时重置，避免每次渲染都触发
  const resultsKey = useMemo(() => results.map(r => r.id).join('|'), [results]);

  // 打开模态框 / 所选结果集变化时：回到第一个结果，并恢复默认图表类型
  useEffect(() => {
    if (!visible) return;
    setActiveIdx(0);
    setChartType('table');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, resultsKey]);

  // 当前结果变化时（含用户切换结果集）：按该结果的列重置横轴 / 纵轴，保留已选图表类型
  // 注意：此处的依赖里绝不能出现 setActiveIdx，否则切换结果会被立即打回第一个结果
  useEffect(() => {
    if (!visible || !activeResult) return;
    const firstCol = activeResult.columns[0] || '';
    const firstNumeric = numericColumns[0] || '';
    setXColumn(firstCol);
    setYColumns(firstNumeric ? [firstNumeric] : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, activeResult?.id]);

  // 当切换到不允许多纵轴的图表类型（饼图/散点图）时，只保留第一个已选纵轴
  useEffect(() => {
    if (chartType === 'bar' || chartType === 'line' || yColumns.length <= 1) return;
    setYColumns(prev => prev.slice(0, 1));
  }, [chartType]);

  // 初始化 / 销毁 ECharts 实例（仅图表模式挂载容器时需要）
  const isChartMode = chartType !== 'table';
  useEffect(() => {
    const el = chartRef.current;
    if (!el || !visible || !isChartMode) return;
    const inst = echarts.init(el);
    chartInstanceRef.current = inst;
    const ro = new ResizeObserver(() => inst.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      inst.dispose();
      chartInstanceRef.current = null;
    };
  }, [visible, isChartMode]);

  const buildOption = useCallback((): echarts.EChartsOption => {
    const r = activeResult;
    if (!r || chartType === 'table') return {};
    const xIdx = r.columns.indexOf(xColumn) < 0 ? 0 : r.columns.indexOf(xColumn);

    if (chartType === 'pie') {
      const yCol = yColumns[0];
      const yIdx = r.columns.indexOf(yCol);
      const data = r.rows
        .map(row => ({
          name: String(row[xIdx] ?? ''),
          value: yIdx >= 0 && !isNaN(toNumber(row[yIdx])) ? toNumber(row[yIdx]) : 0,
        }))
        .filter(d => d.name !== '' || d.value !== 0);
      return {
        tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
        legend: { bottom: 0, textStyle: { color: legendColor }, type: 'scroll' },
        series: [{
          name: xColumn || '分类',
          type: 'pie',
          radius: ['30%', '65%'],
          center: ['50%', '45%'],
          data,
          label: { color: '#cccccc', formatter: '{b}' },
          itemStyle: { borderColor: '#1e1e1e', borderWidth: 1 },
        }],
      };
    }

    if (chartType === 'scatter') {
      const yIdx = r.columns.indexOf(yColumns[0]);
      const data = r.rows
        .map(row => [toNumber(row[xIdx]), yIdx >= 0 ? toNumber(row[yIdx]) : NaN])
        .filter(p => !isNaN(p[0]) && !isNaN(p[1]));
      return {
        tooltip: {
          trigger: 'item',
          formatter: (params: any) => `${params.value[0]}, ${params.value[1]}`,
        },
        grid: { left: 50, right: 24, top: 30, bottom: 48 },
        xAxis: { name: xColumn || '', type: 'value', nameTextStyle: { color: axisLabelColor }, axisLabel: { color: axisLabelColor }, splitLine: { lineStyle: { color: splitLineColor } } },
        yAxis: { name: yColumns[0] || '', type: 'value', nameTextStyle: { color: axisLabelColor }, axisLabel: { color: axisLabelColor }, splitLine: { lineStyle: { color: splitLineColor } } },
        series: [{ type: 'scatter', symbolSize: 8, data, itemStyle: { color: '#4EC9B0' } }],
      };
    }

    // bar / line：每个纵轴列对应一个独立的 yAxis，避免不同量级的列相互挤压而“看不见”
    const yCols = yColumns.filter(name => r.columns.includes(name));
    const xData = r.rows.map(row => String(row[xIdx] ?? ''));
    const yAxes = yCols.map((name, i) => ({
      type: 'value' as const,
      name,
      position: (i % 2 === 0 ? 'left' : 'right') as 'left' | 'right',
      nameLocation: 'middle' as const,
      nameGap: 35,
      nameTextStyle: { color: axisLabelColor },
      axisLabel: { color: axisLabelColor },
      splitLine: i === 0 ? { lineStyle: { color: splitLineColor } } : { show: false },
    }));
    const series = yCols.map((name, i) => {
      const idx = r.columns.indexOf(name);
      return {
        name,
        yAxisIndex: i,
        type: chartType as 'bar' | 'line', // bar / line
        data: r.rows.map(row => {
          const v = toNumber(row[idx]);
          return isNaN(v) ? null : v;
        }),
        smooth: chartType === 'line' ? true : undefined,
        emphasis: { focus: 'series' as const },
      };
    });
    return {
      tooltip: { trigger: 'axis' },
      legend: { top: 0, textStyle: { color: legendColor }, type: 'scroll' },
      grid: { left: 60, right: 60, top: 32, bottom: 48 },
      xAxis: {
        type: 'category',
        data: xData,
        name: xColumn || '',
        nameTextStyle: { color: axisLabelColor },
        axisLabel: { color: axisLabelColor },
        axisLine: { lineStyle: { color: '#555' } },
      },
      yAxis: yAxes,
      series,
    };
  }, [activeResult, chartType, xColumn, yColumns]);

  // 数据 / 配置变化时更新图表
  useEffect(() => {
    if (!visible || !chartInstanceRef.current) return;
    try {
      chartInstanceRef.current.setOption(buildOption(), true);
    } catch (_err) {
      // ECharts 在动态切换列/图表类型时偶尔会在内部状态机触发 stale 引用崩溃
      // 这是一个已知的 ECharts bug (blurSeries 中访问 disposed view.group)，
      // 捕获后忽略即可，下一次配置更新会自动恢复渲染
    }
  }, [visible, buildOption]);

  if (!visible) return null;

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  const updateYColumn = (idx: number, col: string) => {
    setYColumns(prev => prev.map((c, i) => (i === idx ? col : c)));
  };

  const removeYColumn = (idx: number) => {
    setYColumns(prev => prev.filter((_, i) => i !== idx));
  };

  const addYColumn = (col: string) => {
    if (!col) return;
    // 饼图 / 散点图只允许一个数值列
    if (chartType === 'pie' || chartType === 'scatter') {
      if (!yColumns.includes(col)) setYColumns([col]);
      return;
    }
    setYColumns(prev => (prev.includes(col) || prev.length >= 3 ? prev : [...prev, col]));
  };

  // 只有柱状图 / 折线图支持多个纵轴；饼图 / 散点图固定单个纵轴
  const multiY = chartType === 'bar' || chartType === 'line';

  // 已选中的数值列（下拉候选排除已选项，避免重复）
  const availableNumeric = numericColumns.filter(c => !yColumns.includes(c));

  return (
    <div className="ca-overlay" onClick={handleOverlayClick}>
      <div className="ca-modal">
        <header className="ca-header">
          <div className="ca-title">
            <BarChart3 size={18} />
            <span>图表分析</span>
            {results.length > 0 && <span className="ca-title-count">{results.length} 个结果</span>}
          </div>
          <button className="ca-close" onMouseDown={(e) => { e.preventDefault(); onClose(); }}>
            <X size={16} />
          </button>
        </header>

        <div className="ca-body">
          {/* 结果选择（多选时切换查看） */}
          {results.length > 1 && (
            <div className="ca-result-switch">
              {results.map((r, i) => (
                <button
                  key={r.id}
                  className={`ca-result-tab ${i === activeIdx ? 'ca-result-tab--active' : ''}`}
                  onClick={() => setActiveIdx(i)}
                  title={r.sqlSnippet}
                >
                  结果 {i + 1}（{r.rows.length} 行）
                </button>
              ))}
            </div>
          )}

          {!activeResult ? (
            <div className="ca-empty">
              <Table2 size={32} className="ca-empty-icon" />
              <p>没有可分析的结果数据，请先勾选包含数据的执行结果</p>
            </div>
          ) : (
            <>
              {/* 配置区 */}
              <div className="ca-config">
                <div className="ca-config-row">
                  <span className="ca-config-label">图表类型</span>
                  <div className="ca-chart-types">
                    {CHART_TYPES.map(ct => (
                      <button
                        key={ct.key}
                        className={`ca-chart-type ${chartType === ct.key ? 'ca-chart-type--active' : ''}`}
                        onClick={() => setChartType(ct.key)}
                      >
                        {ct.icon}
                        <span>{ct.label}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {chartType !== 'table' && (
                  <>
                  <div className="ca-config-row">
                    <span className="ca-config-label">横轴</span>
                    <select
                      className="ca-select"
                      value={xColumn}
                      onChange={(e) => setXColumn(e.target.value)}
                    >
                      {activeResult.columns.map(col => (
                        <option key={col} value={col}>{col}</option>
                      ))}
                    </select>
                    <span className="ca-hint">（{chartType === 'scatter' ? '作为 X 轴数值列' : '作为类目 X 轴'}）</span>
                  </div>

                  <div className="ca-config-row">
                    <span className="ca-config-label">纵轴</span>
                    <div className="ca-y-axis-list">
                      {yColumns.map((col, i) => (
                        <div className="ca-y-axis-row" key={i}>
                          <select
                            className="ca-select"
                            value={col}
                            onChange={(e) => updateYColumn(i, e.target.value)}
                          >
                            {numericColumns.map(nc => (
                              <option key={nc} value={nc} disabled={yColumns.includes(nc) && nc !== col}>
                                {nc}
                              </option>
                            ))}
                          </select>
                          {multiY && (
                          <button
                            className="ca-y-remove"
                            title="移除该列"
                            onClick={() => removeYColumn(i)}
                          >
                            <X size={12} />
                          </button>
                          )}
                        </div>
                      ))}
                      {multiY && yColumns.length < 3 && (
                        <div className="ca-y-axis-row">
                          <select className="ca-select" value="" onChange={(e) => addYColumn(e.target.value)}>
                            <option value="" disabled>选择纵轴列</option>
                            {availableNumeric.map(nc => (
                              <option key={nc} value={nc}>{nc}</option>
                            ))}
                          </select>
                          <span className="ca-hint">选择后自动增加</span>
                        </div>
                      )}
                    </div>
                  </div>
                  </>
                )}
              </div>

              {/* 表格 / 图表：由显示类型决定 */}
              {chartType === 'table' ? (
              <div className="ca-table-section">
                <div className="ca-section-title">
                  <Table2 size={13} />
                  <span>结果数据（表格）</span>
                  <span className="ca-section-count">{activeResult.rows.length} 行</span>
                </div>
                <div className="ca-table-wrapper">
                  <table className="ca-table">
                    <thead>
                      <tr>
                        {activeResult.columns.map((col, i) => (
                          <th key={i}>{col}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {activeResult.rows.map((row, ri) => (
                        <tr key={ri}>
                          {row.map((cell, cj) => (
                            <td key={cj}>{cell}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              ) : (
              <div className="ca-chart-section">
                <div className="ca-section-title">
                  <BarChart3 size={13} />
                  <span>图表预览</span>
                </div>
                <div className="ca-chart-wrap">
                  <div ref={chartRef} className="ca-chart" />
                </div>
              </div>
              )}
            </>
          )}
        </div>

        <footer className="ca-footer">
          <button
            className="ca-btn ca-btn--cancel"
            onMouseDown={(e) => { e.preventDefault(); onClose(); }}
          >
            关闭
          </button>
        </footer>
      </div>
    </div>
  );
}