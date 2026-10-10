/**
 * 资产概况（资产管理 → 「资产概况」页签，默认页签）
 *
 * ── 定位 ────────────────────────────────────────────────────
 * 资产目录回答「这张表是什么」，本页签回答「资产盘子有多大、谁在花资源」——
 * 面向治理与成本，以图表为主呈现五块看板：
 *   1) 按环境（生产/灰度/测试）× 项目的表数量与占用空间
 *   2) 占用空间 TOP 100 表
 *   3) 消耗计算资源 / 运行时长 TOP 50 任务
 *   4) 任务延迟率（主要针对 YARN 任务）
 *   5) 数据大小增长率突增（> 10% 且 > 10GB）表
 *
 * ── 呈现约定 ────────────────────────────────────────────────
 * - 图表用 ECharts，暗色主题与模块基准一致（#1e1e1e / #252526 / #007acc）。
 * - 排行榜类看板「图 + 清单」并存：图表取前 12 条做趋势判读，完整清单在卡片内滚动查看，
 *   既不丢需求里的「前 100 / 前 50 清单」，也避免 100 条柱子糊成一团。
 * - 环境配色全局统一：生产蓝 / 灰度橙 / 测试绿，切换器与图表共用同一份常量
 *   （`AssetEnvSwitch.tsx` 的 ASSET_ENV_COLOR），跨图表语义一致。
 *
 * ── 环境切换（本页签的全部图表都随环境切换）──────────────────
 * 环境是**模块级**的（切换器在 AssetCatalogPanel 的页签条右侧），本页签只接收 `env` 作为受控入参，
 * 不自持状态 —— 这样「资产概况」与「资产目录」永远是同一个环境，切页签不会悄悄变回默认值。
 * 五块看板图表**全部**按所选环境取数：
 * - ① 资产规模：只统计所选环境，并给出该环境占全库空间的比例（占比需要分母，
 *   因此这一块仍取「按环境×项目」的全量结果再筛出所选环境）；
 * - ② / ③ / ④ / ⑤：环境作为查询参数下推服务端，由服务端过滤；
 *   任务类看板（③④）的环境取自**工作流名后缀**，与库名后缀是同一套约定。
 *
 * ── 口径与边界 ──────────────────────────────────────────────
 * - 环境由服务端按库名规范 {分层}_{业务域}_{环境} 解析（后缀仅 _prod/_gray/_test），
 *   前端不自行猜测环境，避免把生产库误判为测试库。
 * - 排序维度（计算资源/运行时长）与阈值通过 query 下推服务端，
 *   前端不做全量拉取后再本地排序 —— 排行应为服务端口径。
 * - 本页签只读：不做任何写操作。
 *
 * ── 错误处理 ────────────────────────────────────────────────
 * 每块看板各自探测接口，不可达时在该卡片内降级为「接口待接入 + 能力清单」，
 * 不影响其余看板（读失败不弹全局 toast，与资产目录既有约定一致）。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts';
import { CircleAlert, Activity, HardDrive, Cpu, Timer, TrendingUp } from 'lucide-react';
import { assetCatalogApi } from '../../api/assetCatalog';
import type {
  AssetEnvCode,
  AssetEnvProjectStatVO,
  AssetSizeGrowthVO,
  AssetTaskDelayVO,
  AssetTaskSortBy,
  AssetTopAssetVO,
  AssetTopComputeTaskVO,
} from '../../api/assetCatalog';
import { useProbe } from './useProbe';
import { ASSET_ENV_COLOR, assetEnvLabel } from './AssetEnvSwitch';
import './AssetCatalogPanel.css';

/** TOP 清单条数上限：与需求一致（表 100 / 任务 50） */
const TOP_ASSET_LIMIT = 100;
const TOP_TASK_LIMIT = 50;
/** 突增阈值：增长率 > 10% 且当前大小 > 10GB */
const GROWTH_PERCENT = 10;
const GROWTH_MIN_BYTES = 10 * 1024 ** 3;
/** 延迟率统计窗口（天） */
const WINDOW_DAYS = 30;
/** 排行榜图表展示条数：榜单仍完整落表，图表只取头部避免柱子过密 */
const CHART_TOP_N = 12;

// ── 图表主题常量（与模块暗色基准一致）─────────────────────
const AXIS_LABEL = '#a5a5a5';
const SPLIT_LINE = '#333333';
const TEXT = '#cccccc';
const CARD_BG = '#252526';
const TOOLTIP = {
  backgroundColor: '#2d2d30',
  borderColor: '#3c3c3c',
  borderWidth: 1,
  textStyle: { color: TEXT, fontSize: 12 },
} as const;

/** 卡片标题统一带环境后缀，避免「这一屏看的是哪个环境」需要回头找切换器 */
function withEnv(title: string, env: AssetEnvCode): string {
  return `${title} · ${assetEnvLabel(env)}`;
}

/** 环境后缀（`prod` → `_prod`）：用于空态里点明「本环境靠什么后缀识别」 */
function envSuffix(env: AssetEnvCode): string {
  return `_${env}`;
}

/**
 * 空态文案。
 *
 * 只说「暂无数据」会被误读成「环境没切换成功」——环境是**按名称后缀**识别的，
 * 库里没有带该后缀的库/工作流时，空就是正确结果。因此这里把判定依据一并写出来，
 * 让用户一眼能分清「切错了」和「本来就没有」。
 */
function envEmptyText(env: AssetEnvCode, scope: 'table' | 'task', tail?: string): string {
  const subject = scope === 'table' ? '库名' : '工作流名';
  return `「${assetEnvLabel(env)}」环境下暂无${tail ?? '数据'}（未找到${subject}以 ${envSuffix(env)} 结尾的${scope === 'table' ? '库' : '任务'}）。`;
}

/** 字节数 → 人类可读，保留 2 位小数（大数值降为整数，避免长串） */
function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(2)} ${units[i]}`;
}

/** 秒 → 「1h 23m」/「45m 12s」 */
function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** 比率（0~1）→ 百分比字符串 */
function formatRate(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(rate)) return '—';
  return `${(rate * 100).toFixed(1)}%`;
}

// ── ECharts 封装 ──────────────────────────────────────────

/**
 * 单个图表容器：挂载即初始化，尺寸变化自动 resize，卸载即 dispose。
 * setOption 用 try/catch 包裹 —— ECharts 在动态切换配置时存在内部状态机的偶发崩溃
 * （disposed view.group 之类），捕获后忽略，下一次配置更新会自动恢复渲染。
 */
const EChart: React.FC<{ option: echarts.EChartsOption; height: number }> = ({ option, height }) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const instRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const inst = echarts.init(el);
    instRef.current = inst;
    const ro = new ResizeObserver(() => inst.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      inst.dispose();
      instRef.current = null;
    };
  }, []);

  useEffect(() => {
    const inst = instRef.current;
    if (!inst) return;
    try {
      inst.setOption(option, true);
    } catch {
      /* ECharts 内部状态机偶发崩溃，忽略；下次 setOption 自会恢复 */
    }
  }, [option]);

  return <div className="ac-chart" ref={ref} style={{ height }} />;
};

/** 横向排行榜柱状图：纵向类目 + 渐变条 + 条端数值标签 */
function rankBarOption(
  items: Array<{ name: string; value: number }>,
  format: (v: number) => string,
  color: string,
  tooltipFormat?: (v: number) => string
): echarts.EChartsOption {
  const shown = items.slice(0, CHART_TOP_N);
  return {
    grid: { left: 8, right: 72, top: 8, bottom: 8, containLabel: true },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      ...TOOLTIP,
      formatter: (params: any) => {
        const p = Array.isArray(params) ? params[0] : params;
        return `${p.name}<br/>${(tooltipFormat ?? format)(p.value)}`;
      },
    },
    xAxis: {
      type: 'value',
      axisLabel: { color: AXIS_LABEL, formatter: (v: number) => format(v) },
      splitLine: { lineStyle: { color: SPLIT_LINE } },
    },
    yAxis: {
      type: 'category',
      inverse: true,
      data: shown.map(i => i.name),
      axisLabel: { color: TEXT, width: 190, overflow: 'truncate' },
      axisLine: { lineStyle: { color: '#555' } },
      axisTick: { show: false },
    },
    series: [
      {
        type: 'bar',
        barMaxWidth: 16,
        data: shown.map(i => i.value),
        itemStyle: {
          borderRadius: [0, 4, 4, 0],
          color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
            { offset: 0, color: `${color}55` },
            { offset: 1, color },
          ]),
        },
        label: { show: true, position: 'right', color: TEXT, fontSize: 11, formatter: (p: any) => format(p.value) },
      },
    ],
  };
}

/** 环形占比图（所选环境占用空间 vs 其余环境） */
function donutOption(parts: Array<{ name: string; value: number; color: string }>): echarts.EChartsOption {
  return {
    tooltip: { trigger: 'item', ...TOOLTIP, formatter: (p: any) => `${p.name}<br/>${formatBytes(p.value)}（${p.percent}%）` },
    legend: { bottom: 0, icon: 'circle', itemWidth: 8, itemHeight: 8, textStyle: { color: TEXT, fontSize: 12 } },
    series: [
      {
        type: 'pie',
        radius: ['54%', '76%'],
        center: ['50%', '44%'],
        avoidLabelOverlap: false,
        itemStyle: { borderColor: CARD_BG, borderWidth: 2 },
        label: { show: false },
        labelLine: { show: false },
        data: parts.map(p => ({ name: p.name, value: p.value, itemStyle: { color: p.color } })),
      },
    ],
  };
}

/** 延迟率仪表盘：数值越大越红，一眼判读健康度 */
function delayGaugeOption(percent: number): echarts.EChartsOption {
  const color = percent >= 30 ? '#F06292' : percent >= 15 ? '#FFB74D' : '#81C784';
  return {
    series: [
      {
        type: 'gauge',
        startAngle: 210,
        endAngle: -30,
        min: 0,
        max: 100,
        radius: '94%',
        center: ['50%', '56%'],
        progress: { show: true, width: 14, roundCap: true, itemStyle: { color } },
        axisLine: { lineStyle: { width: 14, color: [[1, '#3c3c3c']] } },
        pointer: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
        anchor: { show: false },
        title: { show: true, offsetCenter: [0, '34%'], color: '#858585', fontSize: 12 },
        detail: {
          valueAnimation: true,
          offsetCenter: [0, '0%'],
          color: '#ffffff',
          fontSize: 30,
          fontWeight: 600,
          formatter: (v: number) => `${v.toFixed(1)}%`,
        },
        data: [{ value: percent, name: '任务延迟率' }],
      },
    ],
  };
}

/** 卡片的排序维度切换（计算资源/运行时长） */
const SortToggle = <T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (next: T) => void;
  options: Array<{ value: T; label: string }>;
}) => (
  <div className="ac-ov-toggle" role="tablist">
    {options.map(opt => (
      <button
        key={opt.value}
        type="button"
        role="tab"
        aria-selected={value === opt.value}
        className={`ac-ov-toggle__btn ${value === opt.value ? 'ac-ov-toggle__btn--active' : ''}`}
        onClick={() => onChange(opt.value)}
      >
        {opt.label}
      </button>
    ))}
  </div>
);

// ── 卡片骨架 ──────────────────────────────────────────────

const Card: React.FC<{
  icon: React.ReactNode;
  title: string;
  hint?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}> = ({ icon, title, hint, actions, children }) => (
  <section className="ac-card">
    <div className="ac-card__head">
      <h3 className="ac-card__title">
        {icon}
        <span>{title}</span>
      </h3>
      {actions}
    </div>
    {hint && <p className="ac-card__hint">{hint}</p>}
    {children}
  </section>
);

/** 接口未就绪时的统一空态：说明原因 + 列出该看板将提供的能力 */
const CardPlaceholder: React.FC<{ reason: string; items: string[] }> = ({ reason, items }) => (
  <div className="ac-placeholder">
    <div className="ac-placeholder__head">
      <CircleAlert size={14} />
      <span>{reason}</span>
    </div>
    <p className="ac-placeholder__lead">该看板就绪后将提供：</p>
    <ul className="ac-placeholder__list">
      {items.map(item => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  </div>
);

const Loading = () => <div className="ac-loading">加载中…</div>;
const Empty = ({ text }: { text: string }) => <div className="ac-card__empty">{text}</div>;

const Stat: React.FC<{ value: string; unit?: string; label: string }> = ({ value, unit, label }) => (
  <div className="ac-stat">
    <span className="ac-stat__value">
      {value}
      {unit && <span className="ac-stat__unit">{unit}</span>}
    </span>
    <span className="ac-stat__label">{label}</span>
  </div>
);

/** 榜单明细表：卡片内限高滚动，表头吸附 */
const ListTable: React.FC<{ head: React.ReactNode; children: React.ReactNode; total: number }> = ({ head, children, total }) => (
  <>
    <p className="ac-ov-note">共 {total} 条，图表仅展示前 {Math.min(total, CHART_TOP_N)} 条，完整清单如下：</p>
    <div className="ac-ov-scroll">
      <table className="ac-table">
        <thead>{head}</thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  </>
);

// ── ① 所选环境的资产规模 ─────────────────────────────────

const EnvProjectSection: React.FC<{ env: AssetEnvCode }> = ({ env }) => {
  // 取全量（所有环境）：占比口径需要分母，接口仍返回按环境×项目的完整明细
  const { status, data } = useProbe<AssetEnvProjectStatVO[]>(() => assetCatalogApi.getInventoryByEnvProject());
  const rows = (data ?? []) as AssetEnvProjectStatVO[];

  // 所选环境的明细；环境识别不出来（库名不合规范）的库不在任何环境里，不会出现在本页
  const scoped = useMemo(() => rows.filter(r => r.env === env), [rows, env]);

  const tableCount = scoped.reduce((sum, r) => sum + (r.tableCount ?? 0), 0);
  const sizeBytes = scoped.reduce((sum, r) => sum + (r.sizeBytes ?? 0), 0);
  const totalSize = rows.reduce((sum, r) => sum + (r.sizeBytes ?? 0), 0);
  const projectCount = new Set(scoped.map(r => r.projectCode || r.projectName)).size;
  const share = totalSize > 0 ? sizeBytes / totalSize : 0;

  /** 项目维度排行：同一项目可能按多条记录返回（不同环境/数据源），这里已收敛到所选环境 */
  const projectItems = useMemo(() => {
    const byProject = new Map<string, number>();
    for (const row of scoped) {
      const name = row.projectName || row.projectCode || '未归属项目';
      byProject.set(name, (byProject.get(name) ?? 0) + (row.tableCount ?? 0));
    }
    return Array.from(byProject, ([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [scoped]);

  const barOption = useMemo(
    () =>
      rankBarOption(
        projectItems,
        (v: number) => String(v),
        ASSET_ENV_COLOR[env],
        (v: number) => `${assetEnvLabel(env)}环境 ${v} 张表`
      ),
    [projectItems, env]
  );

  const donut = useMemo(
    () =>
      donutOption([
        { name: `${assetEnvLabel(env)} 占用空间`, value: sizeBytes, color: ASSET_ENV_COLOR[env] },
        { name: '其余环境', value: Math.max(0, totalSize - sizeBytes), color: '#555555' },
      ]),
    [env, sizeBytes, totalSize]
  );

  return (
    <Card
      icon={<HardDrive size={14} />}
      title={withEnv('① 资产规模', env)}
      hint={`环境由库名规范 {分层}_{业务域}_{环境} 解析（_prod / _gray / _test），本卡片只统计「${assetEnvLabel(env)}」环境的资产；环形图给出该环境占用空间占全库的比例。`}
    >
      {status === 'loading' && <Loading />}
      {status === 'unavailable' && (
        <CardPlaceholder
          reason="服务端 /api/asset/inventory/env-project 尚未接入，资产规模暂不可用。"
          items={['按环境（生产/灰度/测试）汇总的表数量与占用空间', '环境内按项目下钻的表数量与占用空间', '全库合计表数量与占用空间']}
        />
      )}
      {status === 'ok' && scoped.length === 0 && <Empty text={envEmptyText(env, 'table', '已纳管的资产')} />}
      {status === 'ok' && scoped.length > 0 && (
        <>
          <div className="ac-ov-stats">
            <Stat value={String(tableCount)} unit="表" label={`${assetEnvLabel(env)}环境资产`} />
            <Stat value={formatBytes(sizeBytes)} label="占用空间" />
            <Stat value={String(projectCount)} unit="个" label="涉及项目" />
            <Stat value={formatRate(share)} label="占全库空间" />
          </div>
          <div className="ac-ov-cols">
            <div>
              <p className="ac-ov-subtitle">各项目表数量（{assetEnvLabel(env)}）</p>
              {projectItems.length > 0 ? <EChart option={barOption} height={260} /> : <Empty text="该项目维度暂无数据。" />}
            </div>
            <div>
              <p className="ac-ov-subtitle">该环境占用空间占比</p>
              <EChart option={donut} height={260} />
            </div>
          </div>
        </>
      )}
    </Card>
  );
};

// ── ② 占用空间 TOP 100 表 ────────────────────────────────

const TopAssetsSection: React.FC<{ env: AssetEnvCode }> = ({ env }) => {
  const { status, data } = useProbe<AssetTopAssetVO[]>(
    () => assetCatalogApi.getTopAssets({ limit: TOP_ASSET_LIMIT, env }),
    [env]
  );
  const rows = (data ?? []) as AssetTopAssetVO[];

  const option = useMemo(
    () =>
      rankBarOption(
        rows.map(r => ({ name: `${r.databaseName}.${r.tableName}`, value: r.sizeBytes })),
        formatBytes,
        '#BA68C8',
        (v: number) => `占用 ${formatBytes(v)}`
      ),
    [rows]
  );

  return (
    <Card
      icon={<Activity size={14} />}
      title={withEnv(`② 占空间 TOP ${TOP_ASSET_LIMIT} 表`, env)}
      hint={`仅统计「${assetEnvLabel(env)}」环境；按占用空间从高到低排序。`}
    >
      {status === 'loading' && <Loading />}
      {status === 'unavailable' && (
        <CardPlaceholder
          reason="服务端 /api/asset/inventory/top-assets 尚未接入，TOP 表清单暂不可用。"
          items={['按占用空间排序的前 100 张表', '含环境、项目、负责人']}
        />
      )}
      {status === 'ok' && rows.length === 0 && <Empty text={envEmptyText(env, 'table')} />}
      {status === 'ok' && rows.length > 0 && (
        <>
          <EChart option={option} height={320} />
          <ListTable
            total={rows.length}
            head={
              <tr>
                <th className="ac-num">#</th>
                <th>表</th>
                <th>环境</th>
                <th>项目</th>
                <th className="ac-num">占用空间</th>
                <th>负责人</th>
              </tr>
            }
          >
            {rows.map((row, index) => (
              <tr key={row.tableMetadataId ?? `${row.databaseName}.${row.tableName}`}>
                <td className="ac-num ac-ov-rank">{index + 1}</td>
                <td className="ac-table__strong">
                  {row.databaseName}.{row.tableName}
                </td>
                <td>{assetEnvLabel(row.env)}</td>
                <td>{row.projectName || row.projectCode || '—'}</td>
                <td className="ac-num">{formatBytes(row.sizeBytes)}</td>
                <td>{row.ownerName || '—'}</td>
              </tr>
            ))}
          </ListTable>
        </>
      )}
    </Card>
  );
};

// ── ③ 消耗计算资源 / 运行时长 TOP 50 任务 ────────────────

const TopComputeSection: React.FC<{ env: AssetEnvCode }> = ({ env }) => {
  const [sortBy, setSortBy] = useState<AssetTaskSortBy>('resource');
  const { status, data } = useProbe<AssetTopComputeTaskVO[]>(
    () => assetCatalogApi.getTopComputeTasks({ sortBy, limit: TOP_TASK_LIMIT, env }),
    [sortBy, env]
  );
  const rows = (data ?? []) as AssetTopComputeTaskVO[];

  const isResource = sortBy === 'resource';
  const option = useMemo(
    () =>
      rankBarOption(
        rows.map(r => ({ name: `${r.workflowName} / ${r.nodeName}`, value: isResource ? r.cpuHours : r.runDurationSeconds })),
        isResource ? (v: number) => String(v) : formatDuration,
        isResource ? '#FFB74D' : '#4DD0E1',
        isResource ? (v: number) => `${v} CPU·小时` : (v: number) => `运行 ${formatDuration(v)}`
      ),
    [rows, isResource]
  );

  return (
    <Card
      icon={<Cpu size={14} />}
      title={withEnv(`③ 资源消耗与耗时 TOP ${TOP_TASK_LIMIT} 任务`, env)}
      hint={`仅统计「${assetEnvLabel(env)}」环境（环境取自工作流名后缀，与库名后缀同一套约定）；计算资源按 CPU 核·小时计（图表口径），表格同时给出内存 GB·小时与执行次数。`}
      actions={
        <SortToggle
          value={sortBy}
          onChange={setSortBy}
          options={[
            { value: 'resource', label: '按计算资源' },
            { value: 'duration', label: '按运行时长' },
          ]}
        />
      }
    >
      {status === 'loading' && <Loading />}
      {status === 'unavailable' && (
        <CardPlaceholder
          reason="服务端 /api/asset/inventory/top-compute 尚未接入，TOP 任务清单暂不可用。"
          items={['按消耗计算资源（CPU / 内存）排序的前 50 个任务', '按运行时长排序的前 50 个任务', '含工作流、节点、任务类型与执行次数']}
        />
      )}
      {status === 'ok' && rows.length === 0 && <Empty text={envEmptyText(env, 'task', '任务运行记录')} />}
      {status === 'ok' && rows.length > 0 && (
        <>
          <EChart option={option} height={320} />
          <ListTable
            total={rows.length}
            head={
              <tr>
                <th className="ac-num">#</th>
                <th>工作流 / 节点</th>
                <th>类型</th>
                <th>项目</th>
                <th className="ac-num">CPU·小时</th>
                <th className="ac-num">内存 GB·小时</th>
                <th className="ac-num">运行时长</th>
                <th className="ac-num">执行次数</th>
              </tr>
            }
          >
            {rows.map((row, index) => (
              <tr key={`${row.workflowName}.${row.nodeName}`}>
                <td className="ac-num ac-ov-rank">{index + 1}</td>
                <td className="ac-table__strong">
                  {row.workflowName}
                  <span className="ac-ov-sub">{row.nodeName}</span>
                </td>
                <td>{row.taskType || '—'}</td>
                <td>{row.projectName || '—'}</td>
                <td className="ac-num">{row.cpuHours ?? '—'}</td>
                <td className="ac-num">{row.memoryGbHours ?? '—'}</td>
                <td className="ac-num">{formatDuration(row.runDurationSeconds)}</td>
                <td className="ac-num">{row.execCount ?? '—'}</td>
              </tr>
            ))}
          </ListTable>
        </>
      )}
    </Card>
  );
};

// ── ④ 任务延迟率（YARN）───────────────────────────────────

const DelayRateSection: React.FC<{ env: AssetEnvCode }> = ({ env }) => {
  const { status, data } = useProbe<AssetTaskDelayVO>(
    () => assetCatalogApi.getTaskDelayRate({ days: WINDOW_DAYS, env }),
    [env]
  );
  const summary = data as AssetTaskDelayVO | null;

  const percent = summary ? (summary.delayRate ?? 0) * 100 : 0;
  const gauge = useMemo(() => delayGaugeOption(percent), [percent]);
  const queueOption = useMemo(
    () =>
      rankBarOption(
        (summary?.byQueue ?? []).map(q => ({ name: q.queueName || '（未分队列）', value: (q.delayRate ?? 0) * 100 })),
        (v: number) => `${v.toFixed(1)}%`,
        '#F06292',
        (v: number) => `延迟率 ${v.toFixed(1)}%`
      ),
    [summary]
  );
  const hasQueue = (summary?.byQueue?.length ?? 0) > 0;

  return (
    <Card
      icon={<Timer size={14} />}
      title={withEnv('④ 任务延迟率', env)}
      hint={`仅统计「${assetEnvLabel(env)}」环境（环境取自工作流名后缀）；延迟口径：任务实际开始时间晚于计划开始时间，以 YARN 任务为主，统计窗口近 ${WINDOW_DAYS} 天。`}
    >
      {status === 'loading' && <Loading />}
      {status === 'unavailable' && (
        <CardPlaceholder
          reason="服务端 /api/asset/inventory/task-delay 尚未接入，任务延迟率暂不可用。"
          items={['整体延迟率与延迟任务数 / 总任务数', '按 YARN 队列拆分的延迟分布', '与调度运行记录对齐的统计窗口']}
        />
      )}
      {status === 'ok' && !summary && <Empty text={envEmptyText(env, 'task', '任务运行记录')} />}
      {status === 'ok' && summary && (
        <>
          <div className="ac-ov-stats">
            <Stat value={formatRate(summary.delayRate)} label="整体延迟率" />
            <Stat value={String(summary.delayedTasks ?? 0)} unit="个" label="延迟任务" />
            <Stat value={String(summary.totalTasks ?? 0)} unit="个" label="任务总数" />
            <Stat value={String(summary.windowDays ?? WINDOW_DAYS)} unit="天" label="统计窗口" />
          </div>
          <div className="ac-ov-cols">
            <div>
              <p className="ac-ov-subtitle">整体延迟率</p>
              <EChart option={gauge} height={240} />
            </div>
            <div>
              <p className="ac-ov-subtitle">按 YARN 队列的延迟率</p>
              {hasQueue ? <EChart option={queueOption} height={240} /> : <Empty text="暂无队列维度数据。" />}
            </div>
          </div>
        </>
      )}
    </Card>
  );
};

// ── ⑤ 数据大小增长率突增表 ───────────────────────────────

const SizeGrowthSection: React.FC<{ env: AssetEnvCode }> = ({ env }) => {
  const { status, data } = useProbe<AssetSizeGrowthVO[]>(
    () =>
      assetCatalogApi.getSizeGrowthAnomalies({
        growthPercent: GROWTH_PERCENT,
        minSizeBytes: GROWTH_MIN_BYTES,
        env,
      }),
    [env]
  );
  const rows = (data ?? []) as AssetSizeGrowthVO[];

  const option = useMemo(
    () =>
      rankBarOption(
        rows.map(r => ({ name: `${r.databaseName}.${r.tableName}`, value: (r.growthRate ?? 0) * 100 })),
        (v: number) => `${v.toFixed(1)}%`,
        '#FF8A65',
        (v: number) => `增长率 ${v.toFixed(1)}%`
      ),
    [rows]
  );

  return (
    <Card
      icon={<TrendingUp size={14} />}
      title={withEnv('⑤ 数据大小突增表', env)}
      hint={`仅统计「${assetEnvLabel(env)}」环境；筛选口径：增长率 > ${GROWTH_PERCENT}% 且当前大小 > ${formatBytes(GROWTH_MIN_BYTES)}，用于发现异常膨胀的表。`}
    >
      {status === 'loading' && <Loading />}
      {status === 'unavailable' && (
        <CardPlaceholder
          reason="服务端 /api/asset/inventory/size-growth 尚未接入，突增表清单暂不可用。"
          items={['增长率 > 10% 且当前大小 > 10GB 的表清单', '含上期/本期大小、增长量与增长率', '按增长率从高到低排序']}
        />
      )}
      {status === 'ok' && rows.length === 0 && <Empty text={envEmptyText(env, 'table', '符合阈值的表')} />}
      {status === 'ok' && rows.length > 0 && (
        <>
          <EChart option={option} height={320} />
          <ListTable
            total={rows.length}
            head={
              <tr>
                <th className="ac-num">#</th>
                <th>表</th>
                <th>环境</th>
                <th>项目</th>
                <th className="ac-num">上期大小</th>
                <th className="ac-num">本期大小</th>
                <th className="ac-num">增长量</th>
                <th className="ac-num">增长率</th>
              </tr>
            }
          >
            {rows.map((row, index) => (
              <tr key={row.tableMetadataId ?? `${row.databaseName}.${row.tableName}`}>
                <td className="ac-num ac-ov-rank">{index + 1}</td>
                <td className="ac-table__strong">
                  {row.databaseName}.{row.tableName}
                </td>
                <td>{assetEnvLabel(row.env)}</td>
                <td>{row.projectName || '—'}</td>
                <td className="ac-num">{formatBytes(row.previousSizeBytes)}</td>
                <td className="ac-num">{formatBytes(row.currentSizeBytes)}</td>
                <td className="ac-num">{formatBytes(row.growthBytes)}</td>
                <td className="ac-num ac-ov-warn">{formatRate(row.growthRate)}</td>
              </tr>
            ))}
          </ListTable>
        </>
      )}
    </Card>
  );
};

/**
 * 资产概况页签。
 *
 * `env` 由宿主持有（模块级切换器），本组件是受控的：env 变则五块看板一起重取，
 * 不在这里保存任何环境状态。
 */
const AssetOverviewTab: React.FC<{ env: AssetEnvCode }> = ({ env }) => (
  <div className="ac-ov">
    <div className="ac-notice">
      <CircleAlert size={14} />
      <span>
        以下五块看板全部只统计「{assetEnvLabel(env)}」环境（环境由服务端按库名后缀 _prod / _gray / _test 解析），
        切换右上角环境即整体重取。五块看板各自独立探测：接口未部署时仅该看板降级为能力清单，不影响其余看板。
      </span>
    </div>
    <EnvProjectSection env={env} />
    <TopAssetsSection env={env} />
    <TopComputeSection env={env} />
    <DelayRateSection env={env} />
    <SizeGrowthSection env={env} />
  </div>
);

export default AssetOverviewTab;
