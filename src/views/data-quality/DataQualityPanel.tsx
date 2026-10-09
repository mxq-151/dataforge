/**
 * 数据质量面板（一级入口「数据质量」）
 *
 * ── 页签就绪度 ──────────────────────────────────────────────
 * 三个页签全部接入真实接口：
 * - 质量大盘  GET /quality/overview
 * - 规则配置  /quality/rule*（左树取自 DataSourceProvider 缓存的元数据）
 * - 规则模板  /quality/template*（内置模板只读 + 自定义模板 CRUD + SQL 预览），见 TemplateTab
 *
 * 接口不可达时各页签在自己的空态/错误态里呈现原因，而不是白屏或空表格。
 *
 * ── 已移除的页签 ────────────────────────────────────────────
 * 「质检任务」「运行记录」「告警订阅」三个页签及其整条链路（dq_task / dq_task_rule_rel /
 * dq_run_instance / dq_alert_log / dq_alert_subscription）已从前后端一并删除，服务端不再
 * 提供 /quality/task*、/quality/run 的查询接口与 /quality/alert*。
 * 规则级校验结果仍保留为「结果留痕」（dq_rule_result，已去掉运行实例关联）——
 * 它是「行数波动 / 行数环比」试跑基线与规则覆盖率的支撑，见 DqResultService。
 *
 * ── 与提示词契约的关系 ──────────────────────────────────────
 * 7 类规则类型与处置方式的取值都取自 types/quality，不得在本文件内出现
 * 任何自造的规则类型字样（提示词明令禁止自造同义词）。
 */

import { useEffect, useMemo, useState } from 'react';
import { LayoutDashboard, ListChecks, ScrollText, CircleAlert, RefreshCw } from 'lucide-react';
import type { QualityOverviewVO } from '../../types/quality';
import { qualityApi } from '../../api/quality';
import RuleTab from './RuleTab';
import TemplateTab from './TemplateTab';
import './DataQualityPanel.css';

type TabId = 'overview' | 'ruleByTable' | 'template';

interface TabDef {
  id: TabId;
  label: string;
  icon: React.ReactNode;
}

const TABS: TabDef[] = [
  { id: 'overview', label: '质量大盘', icon: <LayoutDashboard size={14} /> },
  { id: 'ruleByTable', label: '规则配置', icon: <ListChecks size={14} /> },
  { id: 'template', label: '规则模板', icon: <ScrollText size={14} /> },
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

const DataQualityPanel: React.FC = () => {
  const [active, setActive] = useState<TabId>('overview');
  const [probeSeq, setProbeSeq] = useState(0);

  const body = useMemo(() => {
    switch (active) {
      case 'overview':
        return <OverviewTab key={`ov-${probeSeq}`} />;
      case 'template':
        return <TemplateTab key={`tpl-${probeSeq}`} />;
      case 'ruleByTable':
        return <RuleTab key={`rule-${probeSeq}`} />;
      default:
        return null;
    }
  }, [active, probeSeq]);

  return (
    <div className="dq-panel">
      <header className="dq-panel__header">
        <div>
          <h2 className="dq-panel__title">数据质量</h2>
          <p className="dq-panel__subtitle">质量大盘 · 规则配置 · 规则模板 —— 规则类型与全链路术语同源</p>
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
