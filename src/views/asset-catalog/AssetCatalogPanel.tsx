/**
 * 数据资产目录面板（一级入口「资产目录」）
 *
 * ── 定位 ────────────────────────────────────────────────────
 * 资产目录是「人」侧的元数据调研入口，与智能体侧的元数据代理接口 /metadata/agent 对位。
 * 它不产生新的智能体上下文类别，而是「库表描述 + 指标描述 + 血缘 + 任务依赖」四类的
 * 聚合消费面 —— 找数、认数、定责，回答「这表是什么、谁负责、能不能用、质量如何、影响谁」。
 *
 * ── 与数据探索的边界（刻意并存，不重复建设）──────────────────
 * - 数据探索：取数即席查询（我要查数、我要写 SQL）
 * - 资产目录：治理视角的浏览与检索（含负责人、分类、质量、使用热度）
 * 库表树由两处共用同一组件（DBTableBrowser 的抽取在第二批完成）；本面板不重复实现
 * 查询编辑器，需要查询时跳数据探索；不重复实现血缘图，血缘页签复用 Marquez 客户端。
 *
 * ── 当前阶段：入口占位 ──────────────────────────────────────
 * 服务端第一批只完成建表，接口尚未接入。目录树、检索、详情在接口不可达时显示
 * 「接口待接入」+ 能力清单；「资产盘点与治理」在本地即可解释，因此直接展示口径。
 */

import { useEffect, useState } from 'react';
import {
  Search,
  Database,
  Layers,
  ChevronRight,
  ChevronDown,
  RefreshCw,
  Table2,
  Star,
  Bookmark,
  CircleAlert,
  Info,
  Link2,
  Tag,
} from 'lucide-react';
import { assetCatalogApi } from '../../api/assetCatalog';
import type { CatalogTreeNode, CatalogViewMode } from '../../api/assetCatalog';
import './AssetCatalogPanel.css';

interface AssetCatalogPanelProps {
  /** 跳转到数据血缘：与指标管理的既有联动范式一致（namespace=项目编码，datasetName=表名） */
  onNavigateToLineage?: (target: { namespace: string; datasetName: string }) => void;
}

/** 详情页签（接口就绪后逐个接入，这里先固定顺序） */
const DETAIL_TABS = [
  '概览',
  '字段',
  '分区',
  '血缘',
  '指标',
  '产出任务',
  '数据质量',
  '使用记录',
  '权限',
  '使用说明',
] as const;

/** 资产详情的规划内容（供占位说明使用） */
const DETAIL_PLAN: Array<{ tab: string; content: string }> = [
  { tab: '概览', content: '分层 / 业务域 / 负责人 / 主题域 / 可见性 / 生命周期 / 存储量 / 行数 / 最近更新 / 治理项' },
  { tab: '字段', content: '字段类型、注释与业务描述、主键与分区标记、安全等级、字段热度星级' },
  { tab: '分区', content: '分区字段、分区记录数与存储量' },
  { tab: '血缘', content: '表级与字段级上下游（复用 Marquez 客户端，可跳数据血缘）' },
  { tab: '指标', content: '该表产出的指标（按 indicators_fields 反查）：指标编码、名称、主题域、业务负责人' },
  { tab: '产出任务', content: '写入该表的调度工作流与节点（服务端代理查询 DolphinScheduler）' },
  { tab: '数据质量', content: '该表的规则数、最近一次校验结果、未通过规则条数（跨模块读质量模块）' },
  { tab: '使用记录', content: '浏览与读取趋势、字段热度明细、读取 TOP 人员（T+1 汇总）' },
  { tab: '权限', content: '当前用户对该表的行 / 列权限（既有 sys_table_permission，只读展示）' },
  { tab: '使用说明', content: 'markdown 说明与历史版本（复用知识库文档能力）' },
];

/** 治理项口径：全部可核查，不引入加权评分 */
const HEALTH_ITEMS = [
  '命名不合规表：表名不符合 {分层}_{业务域}_{实体描述}_{刷新周期}，无法解析分层与业务域',
  '未标注字段：字段缺少注释与业务描述（复用既有元数据标注缺口清单）',
  '无负责人表：business_owner 与 tech_owner 均为空',
  '无质量规则的核心表：有产出任务但未配置任何监控规则',
  '长期未更新表：last_modify_time 超过生命周期阈值',
];

type ProbeState<T> = { status: 'loading' | 'ok' | 'unavailable'; data: T | null };

const TreePlaceholder: React.FC<{ view: CatalogViewMode }> = ({ view }) => (
  <div className="ac-placeholder">
    <div className="ac-placeholder__head">
      <CircleAlert size={14} />
      <span>服务端 /api/asset/catalog/tree 尚未接入。</span>
    </div>
    <p className="ac-placeholder__lead">
      {view === 'engine' ? '引擎视角' : '规范视角'}目录树就绪后将提供：
    </p>
    <ul className="ac-placeholder__list">
      {view === 'engine' ? (
        <>
          <li>按数据源类型分组 → 数据源 → 库 → 表，逐层展开</li>
          <li>节点搜索定位，选中即刷新右侧详情</li>
          <li>仅展示当前用户有权限访问的资产（服务端 fail-close 过滤）</li>
        </>
      ) : (
        <>
          <li>分层（ODS/DWD/DWS/ADS/DIM/DQC/TMP）→ 业务域 → 表</li>
          <li>分层与业务域由表名规范解析，无需人工维护分类树</li>
          <li>解析失败的表归入「未分类」，并自动成为治理项</li>
        </>
      )}
    </ul>
  </div>
);

/** 递归渲染目录树节点 */
const TreeNodeItem: React.FC<{
  node: CatalogTreeNode;
  depth: number;
  expanded: Set<string>;
  selectedKey: string | null;
  onToggle: (key: string) => void;
  onSelect: (node: CatalogTreeNode) => void;
}> = ({ node, depth, expanded, selectedKey, onToggle, onSelect }) => {
  const hasChildren = (node.children?.length ?? 0) > 0;
  const isOpen = expanded.has(node.key);

  const icon = (() => {
    switch (node.nodeKind) {
      case 'datasource':
      case 'database':
        return <Database size={13} />;
      case 'layer':
      case 'domain':
        return <Layers size={13} />;
      default:
        return <Table2 size={13} />;
    }
  })();

  return (
    <>
      <div
        className={`ac-tree__node ${selectedKey === node.key ? 'ac-tree__node--active' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => {
          onSelect(node);
          if (hasChildren) onToggle(node.key);
        }}
      >
        <span className="ac-tree__chevron">
          {hasChildren ? (isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />) : null}
        </span>
        <span className="ac-tree__icon">{icon}</span>
        <span className="ac-tree__label">{node.label}</span>
        {node.unclassified && <span className="ac-tree__badge">未分类</span>}
        {typeof node.assetCount === 'number' && node.nodeKind !== 'table' && (
          <span className="ac-tree__count">{node.assetCount}</span>
        )}
      </div>
      {hasChildren && isOpen && (
        <div>
          {node.children!.map(child => (
            <TreeNodeItem
              key={child.key}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              selectedKey={selectedKey}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </>
  );
};

const AssetCatalogPanel: React.FC<AssetCatalogPanelProps> = ({ onNavigateToLineage }) => {
  const [view, setView] = useState<CatalogViewMode>('engine');
  const [keyword, setKeyword] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<CatalogTreeNode | null>(null);
  const [usedNavigator, setUsedNavigator] = useState(false);
  const [tree, setTree] = useState<ProbeState<CatalogTreeNode[]>>({ status: 'loading', data: null });

  // 目录树按视角探测：接口未接入时落到 unavailable，由 TreePlaceholder 呈现能力清单
  useEffect(() => {
    let cancelled = false;
    setTree({ status: 'loading', data: null });
    assetCatalogApi
      .getCatalogTree({ view })
      .then(res => {
        if (!cancelled) setTree({ status: 'ok', data: res?.data ?? [] });
      })
      .catch(() => {
        if (!cancelled) setTree({ status: 'unavailable', data: null });
      });
    return () => {
      cancelled = true;
    };
  }, [view]);

  const toggle = (key: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="ac-panel">
      {/* ── 左栏：搜索 + 视角 + 目录树 ── */}
      <aside className="ac-side">
        <div className="ac-side__search">
          <Search size={13} />
          <input
            className="ac-side__search-input"
            placeholder="搜索表 / 字段 / 指标"
            value={keyword}
            onChange={e => setKeyword(e.target.value)}
          />
        </div>

        <div className="ac-side__views" role="tablist">
          <button
            role="tab"
            aria-selected={view === 'engine'}
            className={`ac-viewbtn ${view === 'engine' ? 'ac-viewbtn--active' : ''}`}
            onClick={() => setView('engine')}
          >
            <Database size={12} />
            <span>引擎视角</span>
          </button>
          <button
            role="tab"
            aria-selected={view === 'convention'}
            className={`ac-viewbtn ${view === 'convention' ? 'ac-viewbtn--active' : ''}`}
            onClick={() => setView('convention')}
          >
            <Layers size={12} />
            <span>规范视角</span>
          </button>
        </div>

        <div className="ac-side__tree">
          {tree.status === 'loading' && <div className="ac-loading">加载中…</div>}
          {tree.status === 'unavailable' && <TreePlaceholder view={view} />}
          {tree.status === 'ok' && (tree.data?.length ?? 0) === 0 && (
            <div className="ac-placeholder">
              <div className="ac-placeholder__head">
                <CircleAlert size={14} />
                <span>当前视角下没有可访问的资产。</span>
              </div>
              <p className="ac-placeholder__lead">
                若确认库中已有表，请检查元数据是否已同步，以及当前角色的库表权限。
              </p>
            </div>
          )}
          {tree.status === 'ok' &&
            (tree.data?.length ?? 0) > 0 &&
            tree.data!.map(node => (
              <TreeNodeItem
                key={node.key}
                node={node}
                depth={0}
                expanded={expanded}
                selectedKey={selected?.key ?? null}
                onToggle={toggle}
                onSelect={setSelected}
              />
            ))}
        </div>

        <div className="ac-side__footer">
          <button className="ac-side__link" type="button">
            <Bookmark size={12} />
            <span>我的收藏</span>
          </button>
        </div>
      </aside>

      {/* ── 右栏：检索结果 / 资产详情 ── */}
      <main className="ac-main">
        <header className="ac-main__header">
          <div>
            <h2 className="ac-main__title">{selected ? selected.label : '资产详情'}</h2>
            <p className="ac-main__subtitle">
              {selected
                ? `${selected.databaseName ?? ''}${selected.tableName ? `.${selected.tableName}` : ''}`
                : '从左侧目录树选择一张表，或直接检索定位'}
            </p>
          </div>
          <button className="ac-iconbtn" type="button" aria-label="刷新">
            <RefreshCw size={14} />
          </button>
        </header>

        <div className="ac-main__body">
          <div className="ac-notice">
            <Info size={14} />
            <span>
              服务端 /api/asset/table/{'{id}'} 等接口尚未接入。本面板已按设计文档锁定接口契约
              （src/api/assetCatalog.ts），接口就绪后详情页签按下列口径逐个接入。
            </span>
          </div>

          <div className="ac-tabs">
            {DETAIL_TABS.map(t => (
              <span className="ac-tab" key={t}>
                {t}
              </span>
            ))}
          </div>

          <table className="ac-table">
            <thead>
              <tr>
                <th>页签</th>
                <th>将展示的内容</th>
              </tr>
            </thead>
            <tbody>
              {DETAIL_PLAN.map(item => (
                <tr key={item.tab}>
                  <td className="ac-table__strong">{item.tab}</td>
                  <td>{item.content}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* 联动入口：验证跨模块跳转范式（与指标管理 → 数据血缘一致） */}
          <div className="ac-actions">
            <button
              className="ac-btn"
              type="button"
              disabled={!selected}
              onClick={() => {
                if (!selected?.tableName) return;
                setUsedNavigator(true);
                onNavigateToLineage?.({
                  namespace: selected.databaseName ?? '',
                  datasetName: selected.tableName,
                });
              }}
            >
              <Link2 size={13} />
              <span>查看数据血缘</span>
            </button>
            <span className="ac-muted">
              {usedNavigator ? '已跳转到数据血缘。' : '血缘不在本面板重复实现，复用数据血缘模块。'}
            </span>
          </div>

          <section className="ac-section">
            <h4 className="ac-section__title">
              <Tag size={13} />
              <span>资产盘点与治理项</span>
            </h4>
            <p className="ac-muted">
              治理项只做可核查计数，不引入加权评分 —— 每个治理项都能追到具体对象。第一阶段口径：
            </p>
            <ul className="ac-list">
              {HEALTH_ITEMS.map(item => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <p className="ac-muted">
              其中「未标注字段」直接复用既有元数据标注缺口清单接口（/api/metadata/annotation-gaps），
              其余由服务端盘点接口汇总。
            </p>
          </section>

          <section className="ac-section">
            <h4 className="ac-section__title">
              <Star size={13} />
              <span>使用热度</span>
            </h4>
            <p className="ac-muted">
              浏览与读取分别统计，按日汇总（T+1）；访问埋点写入独立的轻量表，不写操作审计日志。
              热度指标：浏览数、读取数、收藏数、字段热度（0~5 星）。
            </p>
          </section>
        </div>
      </main>
    </div>
  );
};

export default AssetCatalogPanel;
