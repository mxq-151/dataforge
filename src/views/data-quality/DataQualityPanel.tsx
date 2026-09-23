/**
 * 数据质量面板（一级入口「数据质量」）
 *
 * ── 页签就绪度 ──────────────────────────────────────────────
 * 六个页签全部接入：质量大盘（/quality/overview）、规则配置（/quality/rule，左树取自
 * DataSourceProvider 缓存的元数据）、质检任务（/quality/task）、运行记录（/quality/run）、
 * 告警订阅（/quality/alert）、规则模板（本地契约，无需接口）。
 *
 * 接口不可达时各页签在自己的空态/错误态里呈现原因，而不是白屏或空表格。
 *
 * 规则模板页签的内置模板即 7 类规则类型，来自本地契约（src/types/quality.ts，
 * 与智能体提示词同源），不需要接口即可正确展示，服务端就绪后以服务端数据为准。
 *
 * ── 与提示词契约的关系 ──────────────────────────────────────
 * 7 类规则类型与处置方式的取值都取自 types/quality，不得在本文件内出现
 * 任何自造的规则类型字样（提示词明令禁止自造同义词）。
 */

import { useEffect, useMemo, useState } from 'react';
import {
  LayoutDashboard,
  ListChecks,
  ScrollText,
  ClipboardList,
  History,
  Bell,
  CircleAlert,
  Info,
  RefreshCw,
} from 'lucide-react';
import { QUALITY_RULE_TYPES, QUALITY_DISPOSE_MODES } from '../../types/quality';
import type { QualityOverviewVO, QualityRunInstanceVO, QualityRuleResultVO } from '../../types/quality';
import { qualityApi } from '../../api/quality';
import RuleTab from './RuleTab';
import TaskTab from './TaskTab';
import AlertTab from './AlertTab';
import './DataQualityPanel.css';

type TabId = 'overview' | 'ruleByTable' | 'template' | 'task' | 'run' | 'alert';

interface TabDef {
  id: TabId;
  label: string;
  icon: React.ReactNode;
}

const TABS: TabDef[] = [
  { id: 'overview', label: '质量大盘', icon: <LayoutDashboard size={14} /> },
  { id: 'ruleByTable', label: '规则配置', icon: <ListChecks size={14} /> },
  { id: 'template', label: '规则模板', icon: <ScrollText size={14} /> },
  { id: 'task', label: '质检任务', icon: <ClipboardList size={14} /> },
  { id: 'run', label: '运行记录', icon: <History size={14} /> },
  { id: 'alert', label: '告警订阅', icon: <Bell size={14} /> },
];

/** 每个页签在接口就绪前要告知用户的能力清单（内容与设计文档一致） */
const TAB_PLAN: Record<TabId, { title: string; items: string[] }> = {
  overview: {
    title: '质量大盘',
    items: [
      '规则覆盖率：已配置规则的表数 / 有产出任务的核心表数',
      '近 N 日校验通过率趋势与失败分布',
      'TOP 质量问题表与问题责任人',
      '强规则阻断次数',
    ],
  },
  ruleByTable: {
    title: '规则配置（按表）',
    items: [
      '左侧复用数据源 / 库 / 表树（与资产目录共用组件）',
      '右侧为该表已配置的规则清单，支持按规则类型分组',
      '新建规则：选择规则类型 → 选字段 → 设阈值与处置方式',
      '规则试跑：保存前验证阈值是否合理，不落运行实例',
      '按模板批量配置：一次为多张表生成同类型规则',
    ],
  },
  template: {
    title: '规则模板',
    items: [
      '内置模板：即 7 类规则类型，与智能体提示词同源，只读',
      '自定义模板：维护校验 SQL 模板，但仍需归属 7 类之一',
      '模板参数渲染为方言 SQL 预览',
    ],
  },
  task: {
    title: '质检任务',
    items: [
      '规则集：把一组规则组织为一次执行计划',
      '触发方式：调度触发（关联工作流与节点）/ 手动触发',
      '任务级处置策略：阻断下游或仅告警',
      '启停与手动执行',
    ],
  },
  run: {
    title: '运行记录',
    items: [
      '运行实例：批次、触发来源、调度实例号、起止时间、统计',
      '规则级结果：规则名 / 校验对象 / 阈值 / 实际值 / 是否通过',
      '执行 SQL 与异常明细，便于定位与修复',
      '一键跳转对应的调度实例详情',
    ],
  },
  alert: {
    title: '告警订阅',
    items: [
      '按任务订阅：命中哪些校验结果时告警（橙色 / 红色 / 校验失败）',
      '接收人与渠道配置',
      '告警发送记录与失败原因',
    ],
  },
};

type ProbeStatus = 'loading' | 'ok' | 'unavailable';

interface ProbeResult<T> {
  status: ProbeStatus;
  data: T | null;
}

/**
 * 探测接口可用性：成功返回数据，失败一律落到 unavailable（不抛异常、不触发全局 toast）。
 * 这是占位阶段的刻意设计——接口未接入不是错误，是预期状态。
 */
function useApiProbe<T>(loader: () => Promise<{ data: T }>, deps: unknown[] = []): ProbeResult<T> {
  const [state, setState] = useState<ProbeResult<T>>({ status: 'loading', data: null });

  // deps 由调用方给出，语义与 useEffect 一致：变化即重新探测。
  // loader 通常是内联箭头函数，不放进依赖数组，避免每次渲染都重新请求。
  const depsKey = JSON.stringify(deps);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading', data: null });
    loader()
      .then(res => {
        if (!cancelled) setState({ status: 'ok', data: res?.data ?? null });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'unavailable', data: null });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depsKey]);

  return state;
}

/** 接口未就绪时的统一空态：说明原因 + 列出该页签将要提供的能力 */
const TabPlaceholder: React.FC<{ tab: TabId; reason: string }> = ({ tab, reason }) => {
  const plan = TAB_PLAN[tab];
  return (
    <div className="dq-placeholder">
      <div className="dq-placeholder__head">
        <CircleAlert size={16} />
        <span>{reason}</span>
      </div>
      <p className="dq-placeholder__lead">{plan.title}页签就绪后将提供：</p>
      <ul className="dq-placeholder__list">
        {plan.items.map(item => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
};

const StatCard: React.FC<{ value: string; label: string }> = ({ value, label }) => (
  <div className="dq-stat">
    <span className="dq-stat__value">{value}</span>
    <span className="dq-stat__label">{label}</span>
  </div>
);

/** 质量大盘 */
const OverviewTab: React.FC = () => {
  const { status, data } = useApiProbe<QualityOverviewVO>(() => qualityApi.getOverview());

  if (status === 'unavailable') {
    return <TabPlaceholder tab="overview" reason="服务端 /api/quality/overview 尚未接入，以下数据暂不可用。" />;
  }
  if (status === 'loading') {
    return <div className="dq-loading">加载中…</div>;
  }

  const ov = data;
  if (!ov) {
    return <TabPlaceholder tab="overview" reason="质量大盘接口返回为空。" />;
  }

  return (
    <div className="dq-overview">
      <div className="dq-stats">
        <StatCard value={`${Math.round((ov.ruleCoverage ?? 0) * 100)}%`} label="规则覆盖率" />
        <StatCard value={String(ov.coveredTableCount ?? 0)} label="已配置规则表数" />
        <StatCard value={String(ov.targetTableCount ?? 0)} label="应配置核心表数" />
        <StatCard value={String(ov.enabledRuleCount ?? 0)} label="启用规则数" />
        <StatCard value={String(ov.blockCount ?? 0)} label="阻断次数" />
      </div>
      <div className="dq-section">
        <h4 className="dq-section__title">TOP 质量问题表</h4>
        {(ov.topProblemTables?.length ?? 0) === 0 ? (
          <p className="dq-muted">暂无未通过记录。</p>
        ) : (
          <table className="dq-table">
            <thead>
              <tr>
                <th>表</th>
                <th>未通过</th>
                <th>责任人</th>
              </tr>
            </thead>
            <tbody>
              {ov.topProblemTables.map(t => (
                <tr key={`${t.databaseName}.${t.tableName}`}>
                  <td>
                    {t.databaseName}.{t.tableName}
                  </td>
                  <td>{t.failCount}</td>
                  <td>{t.ownerName || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

/** 规则模板：内置模板来自本地契约，无需接口 */
const TemplateTab: React.FC = () => (
  <div className="dq-template">
    <div className="dq-notice">
      <Info size={14} />
      <span>
        内置模板即 7 类规则类型，来自本地契约 src/types/quality.ts，与智能体提示词（S1/S2/S3）同源；
        服务端接口就绪后以服务端模板为准。
      </span>
    </div>
    <table className="dq-table">
      <thead>
        <tr>
          <th>规则类型</th>
          <th>校验对象</th>
          <th>说明</th>
        </tr>
      </thead>
      <tbody>
        {QUALITY_RULE_TYPES.map(t => (
          <tr key={t.code}>
            <td className="dq-table__strong">{t.label}</td>
            <td>{t.scope === 'COLUMN' ? '字段级' : t.scope === 'TABLE' ? '表级' : '两张表'}</td>
            <td>{t.desc}</td>
          </tr>
        ))}
      </tbody>
    </table>
    <div className="dq-section">
      <h4 className="dq-section__title">处置方式</h4>
      <div className="dq-chips">
        {QUALITY_DISPOSE_MODES.map(m => (
          <span className="dq-chip" key={m.code}>
            {m.label}（{m.code}）
          </span>
        ))}
      </div>
      <p className="dq-muted">
        处置方式取自提示词中 S2 的「处置方式」。阻断下游由质检任务作为 DAG 节点实现：校验失败即非零退出，
        下游自然不执行，平台不做反向改写调度状态。
      </p>
    </div>
  </div>
);

/** 校验结果状态的中文名 —— 与 types/quality 的 QualityCheckStatus 一一对应 */
const CHECK_STATUS_LABEL: Record<string, string> = {
  PASS: '通过',
  WARN: '橙色异常',
  ERROR: '红色异常',
  FAILED: '校验失败',
};

/** 运行记录 */
const RunTab: React.FC = () => {
  const { status, data } = useApiProbe<{ records: QualityRunInstanceVO[] }>(
    () => qualityApi.listRuns({ current: 1, size: 20 })
  );
  const [selected, setSelected] = useState<number | null>(null);
  const results = useApiProbe<QualityRuleResultVO[]>(
    () => (selected ? qualityApi.listRunResults(selected) : Promise.resolve({ data: [] as QualityRuleResultVO[] })),
    [selected]
  );

  if (status === 'unavailable') {
    return <TabPlaceholder tab="run" reason="服务端 /api/quality/run 尚未接入，运行记录暂不可用。" />;
  }
  if (status === 'loading') {
    return <div className="dq-loading">加载中…</div>;
  }

  const records = data?.records ?? [];
  if (records.length === 0) {
    return <TabPlaceholder tab="run" reason="暂无运行实例。质检任务执行后会在此展示每次校验的规则级结果。" />;
  }

  return (
    <div className="dq-runs">
      <table className="dq-table">
        <thead>
          <tr>
            <th>任务</th>
            <th>批次</th>
            <th>触发</th>
            <th>状态</th>
            <th>开始时间</th>
            <th>异常 / 失败</th>
          </tr>
        </thead>
        <tbody>
          {records.map(r => (
            <tr
              key={r.id}
              className={selected === r.id ? 'dq-table__row--active' : undefined}
              onClick={() => setSelected(r.id === selected ? null : r.id)}
            >
              <td>{r.taskName}</td>
              <td>{r.batchNo}</td>
              <td>{r.triggerType === 'MANUAL' ? '手动' : '调度'}</td>
              <td>{r.status}</td>
              <td>{r.startTime}</td>
              <td>
                {r.errorCount} / {r.failedCount}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {selected !== null && (
        <div className="dq-section">
          <h4 className="dq-section__title">规则级结果</h4>
          {results.status === 'unavailable' ? (
            <p className="dq-muted">结果明细接口尚未接入。</p>
          ) : results.status === 'loading' ? (
            <p className="dq-muted">加载中…</p>
          ) : (results.data?.length ?? 0) === 0 ? (
            <p className="dq-muted">该次运行暂无规则级结果。</p>
          ) : (
            <table className="dq-table">
              <thead>
                <tr>
                  <th>规则名</th>
                  <th>校验对象</th>
                  <th>阈值</th>
                  <th>实际值</th>
                  <th>是否通过</th>
                </tr>
              </thead>
              <tbody>
                {results.data!.map(item => (
                  <tr key={item.id}>
                    <td>{item.ruleName}</td>
                    <td>{item.checkObject}</td>
                    <td>{item.threshold}</td>
                    <td>{item.actualValue}</td>
                    <td>{CHECK_STATUS_LABEL[item.status] ?? item.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
};

const DataQualityPanel: React.FC = () => {
  const [active, setActive] = useState<TabId>('overview');
  const [probeSeq, setProbeSeq] = useState(0);

  const body = useMemo(() => {
    switch (active) {
      case 'overview':
        return <OverviewTab key={`ov-${probeSeq}`} />;
      case 'template':
        return <TemplateTab key={`tpl-${probeSeq}`} />;
      case 'run':
        return <RunTab key={`run-${probeSeq}`} />;
      case 'ruleByTable':
        return <RuleTab key={`rule-${probeSeq}`} />;
      case 'task':
        return <TaskTab key={`task-${probeSeq}`} />;
      case 'alert':
        return <AlertTab key={`alert-${probeSeq}`} />;
      default:
        return null;
    }
  }, [active, probeSeq]);

  return (
    <div className="dq-panel">
      <header className="dq-panel__header">
        <div>
          <h2 className="dq-panel__title">数据质量</h2>
          <p className="dq-panel__subtitle">
            规则模板 · 监控规则 · 质检任务 · 运行记录 · 告警订阅 —— 规则类型与全链路术语同源
          </p>
        </div>
        <button className="dq-iconbtn" onClick={() => setProbeSeq(n => n + 1)} aria-label="重新加载">
          <RefreshCw size={14} />
        </button>
      </header>

      <nav className="dq-tabs" role="tablist">
        {TABS.map(t => (
          <button
            key={t.id}
            role="tab"
            aria-selected={active === t.id}
            className={`dq-tab ${active === t.id ? 'dq-tab--active' : ''}`}
            onClick={() => setActive(t.id)}
          >
            {t.icon}
            <span>{t.label}</span>
          </button>
        ))}
      </nav>

      <div className="dq-panel__body">{body}</div>
    </div>
  );
};

export default DataQualityPanel;
