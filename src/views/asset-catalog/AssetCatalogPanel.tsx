/**
 * 资产管理面板（一级入口「资产目录」）
 *
 * ── 页签 ────────────────────────────────────────────────────
 * 三个模块级页签（后一个由「数据质量」模块并入）：
 * - 资产概况：盘子与成本（环境×项目规模 + 质量规则覆盖四个指标、访问/空间 TOP100、
 *   资源/耗时 TOP50、任务延迟率、数据大小突增），见 AssetOverviewTab，默认落在本页签；
 * - 资产目录：找数认数（目录树 + 检索 + 表详情），本文件承载；
 * - 规则模板：内置/自定义校验 SQL 模板维护，见 TemplateTab（原数据质量模块）。
 *
 * ── 定位 ────────────────────────────────────────────────────
 * 资产目录是「人」侧的元数据调研入口，与智能体侧的元数据代理接口 /metadata/agent 对位。
 * 它不产生新的智能体上下文类别，而是「库表描述 + 指标描述 + 血缘 + 任务依赖」四类的
 * 聚合消费面 —— 找数、认数、定责，回答「这表是什么、谁负责、能不能用、质量如何、影响谁」。
 *
 * ── 与数据探索的边界（刻意并存，不重复建设）──────────────────
 * - 数据探索：取数即席查询（我要查数、我要写 SQL）
 * - 资产目录：治理视角的浏览与检索（含负责人、分类、质量、使用热度）
 * - 库表树与表详情内容与数据探索共用同一组件（DBTableBrowser / TableDetailContent）
 *
 * ── 主区视图 ────────────────────────────────────────────────
 * 右栏有两种互斥视图，由用户动作切换：
 * - detail：选中一张表后的详情（概览 + 能力页签，见 AssetDetailTabs）
 * - search：提交检索后的结果列表（表 / 字段 / 指标三类，服务端已按权限过滤）
 *
 * ── 环境切换（模块级，资产概况与资产目录共用）───────────────
 * 页签条右侧是**模块级**环境切换器（生产 / 灰度 / 测试，默认生产），切换后**资产概况与资产目录**重新取数：
 * - 资产概况：五块看板图表（含①的项目排行与占比环形图）；
 * - 资产目录：目录树、检索（表 / 字段 / 联想）、检索结果、治理项（资产盘点 / 治理项 / 标注缺口）。
 * 之所以做成模块级而非各页签一个：环境是「这一屏看的是哪一套数据」的全局前提，
 * 两个页签若各持一个状态，切页签时环境会悄悄变回默认值，用户很容易把「测试库的空结果」
 * 当成「没有数据」。切换器状态由本面板持有，`AssetOverviewTab` 是受控组件（只接 env、不持状态）。
 * 「规则模板」与库表环境无关，展示该切换器时隐藏。
 * 环境作为查询参数下推服务端（由服务端按库名后缀解析，前端不自行猜测环境），
 * 因此越权表不会因为换环境而出现 —— 环境只缩小「看哪一套」，不改变权限边界。
 *
 * ── 接口接线 ────────────────────────────────────────────────
 * 目录树 / 详情 / 生命周期 → 本文件；治理写操作（负责人、分类、标签、刷新元数据）
 * → AssetGovernanceEditor；详情各能力页签 → AssetDetailTabs；档案检索 / 治理项
 * 两个列表视图 → 本文件内的 SearchResultPane / GovernanceSection。
 * 读失败按区块降级为「不可用 + 能力清单」，写失败才用 toast 提示。
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Search,
  Database,
  Layers,
  ChevronRight,
  ChevronDown,
  RefreshCw,
  Table2,
  CircleAlert,
  Info,
  Tag,
  Library,
  LayoutDashboard,
  ScrollText,
} from 'lucide-react';
import { assetCatalogApi, DEFAULT_ASSET_ENV } from '../../api/assetCatalog';
import type {
  AnnotationGapSummary,
  AssetEnvCode,
  AssetHealthIssueVO,
  AssetInventoryVO,
  AssetSearchHit,
  AssetSearchResult,
  AssetSearchType,
  AssetTableDetailVO,
  CatalogTreeNode,
  CatalogViewMode,
} from '../../api/assetCatalog';
import { useProbe } from './useProbe';
import AssetEnvSwitch, { ASSET_ENV_COLOR, assetEnvLabel } from './AssetEnvSwitch';
import AssetOverviewTab from './AssetOverviewTab';
import AssetDetailTabs from './AssetDetailTabs';
import AssetGovernanceEditor from './AssetGovernanceEditor';
import TemplateTab from '../data-quality/TemplateTab';
import type { TableDetailData } from '../data-explore/TableDetailContent';
import './AssetCatalogPanel.css';

/**
 * 模块级页签：资产概况（盘子与成本，含质量规则覆盖）、资产目录（找数认数）在前，
 * 规则模板（由「数据质量」模块并入）追加在后。
 * 默认落在「资产概况」，作为进入资产管理的第一屏。
 */
type AssetTabId = 'overview' | 'catalog' | 'template';

const MODULE_TABS: Array<{ id: AssetTabId; label: string; icon: React.ReactNode }> = [
  { id: 'overview', label: '资产概况', icon: <LayoutDashboard size={14} /> },
  { id: 'catalog', label: '资产目录', icon: <Library size={14} /> },
  { id: 'template', label: '规则模板', icon: <ScrollText size={14} /> },
];

/** 环境维度只作用于「资产概况 / 资产目录」，规则模板与环境无关 */
const ENV_SCOPED_TABS: AssetTabId[] = ['overview', 'catalog'];

/** 右栏视图：详情 / 检索结果 */
type MainView = 'detail' | 'search';

const SEARCH_PAGE_SIZE = 10;

/** 治理项口径：全部可核查，不引入加权评分 */
const HEALTH_ITEMS = [
  '命名不合规表：表名不符合 {分层}_{业务域}_{实体描述}_{刷新周期}，无法解析分层与业务域',
  '未标注字段：字段缺少注释与业务描述（复用既有元数据标注缺口清单）',
  '无负责人表：business_owner 与 tech_owner 均为空',
  '无质量规则的核心表：有产出任务但未配置任何监控规则',
  '长期未更新表：last_modify_time 超过生命周期阈值',
];

type ProbeState<T> = { status: 'loading' | 'ok' | 'unavailable'; data: T | null };

/** 字节数 → 人类可读（与资产概况保持一致的口径） */
function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(2)} ${units[i]}`;
}

/** 比率（0~1）→ 百分比字符串；无定义（null）显示「—」 */
function formatRate(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(rate)) return '—';
  return `${(rate * 100).toFixed(1)}%`;
}

/** 检索命中的资产类型 → 中文名 */
const HIT_TYPE_LABEL: Record<AssetSearchType, string> = {
  table: '表',
  column: '字段',
  indicator: '指标',
};

/** 把检索命中折叠成一个「表」节点，复用详情视图的选中语义 */
function hitToTableNode(hit: AssetSearchHit): CatalogTreeNode | null {
  const tableMetadataId = hit.assetType === 'table' ? hit.id : hit.tableMetadataId;
  if (!tableMetadataId) return null;
  const [databaseName, tableName] = hit.subtitle.includes('.')
    ? [hit.subtitle.split('.')[0], hit.subtitle.split('.').pop() ?? '']
    : ['', hit.title];
  return {
    key: `table:${tableMetadataId}`,
    label: hit.title,
    nodeKind: 'table',
    tableMetadataId,
    databaseName,
    tableName,
  };
}

/**
 * 规范视角层级重排：服务端返回「数仓分层 → 业务域 → 表」，这里重排为
 * 「数仓名称（业务域）→ 数仓分层 → 表」——先看是哪座数仓，再看它的各个分层。
 * 只做结构重排与计数重算，表节点原样透传；若接口返回的结构不含「分层」节点（如只返回到表），
 * 则原样保留，不强改。
 */
function regroupConventionTree(nodes: CatalogTreeNode[]): CatalogTreeNode[] {
  if (!nodes.some(node => node.nodeKind === 'layer')) return nodes;

  // 与后端 TableNameConventionParser.UNCLASSIFIED_LAYER 对齐：解析失败的表统一用这个占位码。
  // 「未识别业务域」节点服务端会把 domainCode 置空，这里要补回占位码，否则下推筛选会命中 0 张表。
  const unclassifiedCode = '__unclassified';

  // 数仓名称（业务域）→ 分层 → 表
  const domains = new Map<
    string,
    { label: string; layers: Map<string, { label: string; layerCode: string; tables: CatalogTreeNode[] }> }
  >();
  const passthrough: CatalogTreeNode[] = [];

  for (const node of nodes) {
    if (node.nodeKind !== 'layer') {
      passthrough.push(node);
      continue;
    }
    for (const domain of node.children ?? []) {
      if (domain.nodeKind === 'table') continue;
      const tables = (domain.children ?? []).filter(child => child.nodeKind === 'table');
      const domainCode =
        domain.domainCode ||
        tables[0]?.domainCode ||
        (domain.unclassified ? unclassifiedCode : domain.label);
      let group = domains.get(domainCode);
      if (!group) {
        group = { label: domain.label, layers: new Map() };
        domains.set(domainCode, group);
      }
      const layerCode =
        node.layerCode || tables[0]?.layerCode || (node.unclassified ? unclassifiedCode : node.label);
      const bucket = group.layers.get(layerCode) ?? { label: node.label, layerCode, tables: [] };
      bucket.tables.push(...tables);
      group.layers.set(layerCode, bucket);
    }
  }

  const regrouped: CatalogTreeNode[] = [...domains.entries()].map(([domainCode, group]) => {
    const layerNodes: CatalogTreeNode[] = [...group.layers.entries()].map(([layerCode, bucket]) => ({
      key: `convention:${domainCode}:${layerCode}`,
      label: bucket.label,
      nodeKind: 'layer' as const,
      layerCode,
      domainCode,
      assetCount: bucket.tables.length,
      children: bucket.tables,
    }));
    return {
      key: `convention:${domainCode}`,
      label: group.label,
      nodeKind: 'domain' as const,
      domainCode,
      assetCount: layerNodes.reduce((sum, layer) => sum + (layer.assetCount ?? 0), 0),
      children: layerNodes,
    };
  });

  return [...regrouped, ...passthrough];
}

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
          <li>数仓名称（业务域）→ 分层（ODS/DWD/DWS/ADS/DIM/DQC/TMP）→ 表</li>
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

/** 视图级不可用占位（与详情页签同一套视觉） */
const PaneUnavailable: React.FC<{ title: string; apiPath: string; items: string[] }> = ({
  title,
  apiPath,
  items,
}) => (
  <div className="ac-placeholder">
    <div className="ac-placeholder__head">
      <CircleAlert size={14} />
      <span>
        服务端 {apiPath} 尚未接入，{title}暂不可用。
      </span>
    </div>
    <p className="ac-placeholder__lead">接口就绪后将提供：</p>
    <ul className="ac-placeholder__list">
      {items.map(item => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  </div>
);

/** 分页条（检索与收藏共用） */
const Pager: React.FC<{
  current: number;
  size: number;
  total: number;
  onChange: (next: number) => void;
}> = ({ current, size, total, onChange }) => {
  const pages = Math.max(1, Math.ceil(total / size));
  if (total <= size) return null;
  return (
    <div className="ac-inlinebar ac-inlinebar--pager">
      <button
        className="ac-btn ac-btn--ghost"
        type="button"
        disabled={current <= 1}
        onClick={() => onChange(current - 1)}
      >
        上一页
      </button>
      <span className="ac-muted">
        第 {current} / {pages} 页 · 共 {total} 条
      </span>
      <button
        className="ac-btn ac-btn--ghost"
        type="button"
        disabled={current >= pages}
        onClick={() => onChange(current + 1)}
      >
        下一页
      </button>
    </div>
  );
};

// ── 检索结果 ────────────────────────────────────────────────

const SearchResultPane: React.FC<{
  keyword: string;
  env: AssetEnvCode;
  onOpenTable: (hit: AssetSearchHit) => void;
}> = ({ keyword, env, onOpenTable }) => {
  const [page, setPage] = useState(1);
  const { status, data } = useProbe<AssetSearchResult>(
    () => assetCatalogApi.search({ keyword, current: page, size: SEARCH_PAGE_SIZE, env }),
    [keyword, page, env]
  );

  useEffect(() => {
    setPage(1);
  }, [keyword, env]);

  if (status === 'loading') return <div className="ac-loading">检索中…</div>;
  if (status === 'unavailable')
    return (
      <PaneUnavailable
        title="检索"
        apiPath="/api/asset/search"
        items={['表 / 字段 / 指标三类统一检索', '命中片段高亮、负责人与分层业务域', '结果由服务端按库表权限过滤']}
      />
    );
  if (!data || data.total === 0) {
    return (
      <div className="ac-placeholder">
        <div className="ac-placeholder__head">
          <Info size={14} />
          <span>未检索到与「{keyword}」匹配的表、字段或指标。</span>
        </div>
        <p className="ac-placeholder__lead">可尝试更短的关键词，或切换到规范视角浏览分层与业务域。</p>
      </div>
    );
  }

  const renderHits = (title: string, hits: AssetSearchHit[]) =>
    hits.length === 0 ? null : (
      <section className="ac-section ac-section--tight" key={title}>
        <h4 className="ac-section__title">
          <span>{title}</span>
          <span className="ac-section__hint">{hits.length} 条</span>
        </h4>
        <ul className="ac-hitlist">
          {hits.map(hit => (
            <li key={`${hit.assetType}-${hit.id}-${hit.subtitle}`}>
              <button
                type="button"
                className="ac-hit"
                disabled={hit.assetType === 'indicator' || (!hit.tableMetadataId && hit.assetType === 'column')}
                onClick={() => onOpenTable(hit)}
              >
                <span className={`ac-hit__type ac-hit__type--${hit.assetType}`}>{HIT_TYPE_LABEL[hit.assetType]}</span>
                <span className="ac-hit__title">{hit.title}</span>
                <span className="ac-hit__subtitle">{hit.subtitle}</span>
                <span className="ac-hit__meta">
                  {hit.layerCode && <span className="ac-tree__badge">{hit.layerCode}</span>}
                  {hit.domainCode && <span className="ac-tree__badge">{hit.domainCode}</span>}
                  {hit.ownerName && <span className="ac-muted">{hit.ownerName}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    );

  return (
    <>
      <p className="ac-muted">
        命中 {data.total} 条，以下按表 / 字段 / 指标分组。字段命中点击后跳到所属表；指标详情在指标管理模块维护。
      </p>
      {renderHits('表', data.tables ?? [])}
      {renderHits('字段', data.columns ?? [])}
      {renderHits('指标', data.indicators ?? [])}
      <Pager current={page} size={SEARCH_PAGE_SIZE} total={data.total} onChange={setPage} />
    </>
  );
};

// ── 治理项（未选中表时的盘点看板）───────────────────────────

const GovernanceSection: React.FC<{
  env: AssetEnvCode;
  /** 选中「数仓名称」时收窄到该业务域（数仓名称即规范视角的业务域，不是调度项目编码） */
  domainCode?: string;
  /** 选中「分层」时收窄到该业务域下的该分层 */
  layerCode?: string;
  /** 选中层级的中文名，仅用于标题提示（未收窄时不传） */
  scopeLabel?: string;
}> = ({ env, domainCode, layerCode, scopeLabel }) => {
  // 空值不塞进参数，保证「未收窄」时仍然是干净的 { env }（也便于测试断言）
  const scope = useMemo(() => {
    const params: { env: AssetEnvCode; domainCode?: string; layerCode?: string } = { env };
    if (domainCode) params.domainCode = domainCode;
    if (layerCode) params.layerCode = layerCode;
    return params;
  }, [env, domainCode, layerCode]);

  // 盘点 / 治理项 / 标注缺口三块共用同一份收窄参数，选中树节点时一起重取，口径保持一致
  const overview = useProbe<AssetInventoryVO>(
    () => assetCatalogApi.getInventoryOverview(scope),
    [scope]
  );
  const health = useProbe<AssetHealthIssueVO[]>(
    () => assetCatalogApi.getInventoryHealth(scope),
    [scope]
  );
  const gaps = useProbe<AnnotationGapSummary>(
    () => assetCatalogApi.getAnnotationGaps({ ...scope, current: 1, size: 200 }),
    [scope]
  );

  return (
    <>
      <section className="ac-section">
        <h4 className="ac-section__title">
          <Library size={13} />
          <span>
            资产盘点{scopeLabel ? ` · ${scopeLabel}` : ''} · {assetEnvLabel(env)}
          </span>
        </h4>
        {overview.status === 'loading' && <div className="ac-loading">加载中…</div>}
        {overview.status === 'unavailable' && (
          <p className="ac-muted">服务端 /api/asset/inventory/overview 尚未接入，资产盘点暂不可用。</p>
        )}
        {overview.status === 'ok' && overview.data && (
          <>
            <div className="ac-detailstats">
              <div className="ac-detailstat">
                <span className="ac-detailstat__value">{overview.data.totalTables}</span>
                <span className="ac-detailstat__label">表总数</span>
              </div>
              <div className="ac-detailstat">
                <span className="ac-detailstat__value">{overview.data.totalColumns}</span>
                <span className="ac-detailstat__label">字段总数</span>
              </div>
              <div className="ac-detailstat">
                <span className="ac-detailstat__value">{formatBytes(overview.data.totalSizeBytes)}</span>
                <span className="ac-detailstat__label">占用空间</span>
              </div>
              <div className="ac-detailstat">
                <span
                  className={`ac-detailstat__value ${
                    overview.data.qualityCoverageRate != null && overview.data.qualityCoverageRate < 1
                      ? 'ac-detailstat__value--warn'
                      : ''
                  }`}
                >
                  {formatRate(overview.data.qualityCoverageRate)}
                </span>
                <span className="ac-detailstat__label">质检规划覆盖率</span>
              </div>
            </div>
            {/* 收窄到单个分层时该分布只剩一行、表数与占用空间必然等于上方汇总，属重复信息，不展示 */}
            {(overview.data.byLayer ?? []).length > 1 && (
              <table className="ac-table">
                <thead>
                  <tr>
                    <th>分层</th>
                    <th>表数</th>
                    <th>占用空间</th>
                    <th>质检规划覆盖率</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.data.byLayer.map(layer => (
                    <tr key={layer.layerCode}>
                      <td className="ac-table__strong">{layer.layerCode || '未分类'}</td>
                      <td>{layer.tableCount}</td>
                      <td>{formatBytes(layer.sizeBytes)}</td>
                      <td>{formatRate(layer.qualityCoverageRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </section>

      <section className="ac-section ac-section--divided">
        <h4 className="ac-section__title">
          <Tag size={13} />
          <span>治理项 · {assetEnvLabel(env)}</span>
        </h4>
        <p className="ac-muted">
          治理项只做可核查计数，不引入加权评分 —— 每个治理项都能追到具体对象。口径：
        </p>
        <ul className="ac-list">
          {HEALTH_ITEMS.map(item => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        {health.status === 'loading' && <div className="ac-loading">加载中…</div>}
        {health.status === 'unavailable' && (
          <p className="ac-muted">服务端 /api/asset/inventory/health 尚未接入，治理项计数暂不可用。</p>
        )}
        {health.status === 'ok' &&
          ((health.data?.length ?? 0) === 0 ? (
            <p className="ac-muted">当前没有待治理项，或元数据尚未同步。</p>
          ) : (
            <table className="ac-table">
              <thead>
                <tr>
                  <th>治理项</th>
                  <th>数量</th>
                  <th>影响面</th>
                  <th>样例</th>
                </tr>
              </thead>
              <tbody>
                {health.data!.map(issue => (
                  <tr key={issue.issueCode}>
                    <td className="ac-table__strong">{issue.issueName}</td>
                    <td>{issue.count}</td>
                    <td>{issue.impact || '-'}</td>
                    <td>
                      {(issue.samples ?? []).length === 0
                        ? '-'
                        : issue.samples
                            .slice(0, 3)
                            .map(sample => `${sample.databaseName}.${sample.tableName}`)
                            .join('、')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
      </section>

      <section className="ac-section ac-section--divided">
        <h4 className="ac-section__title">
          <Info size={13} />
          <span>元数据标注缺口 · {assetEnvLabel(env)}</span>
        </h4>

        {gaps.status === 'loading' && <div className="ac-loading">加载中…</div>}
        {gaps.status === 'unavailable' && <p className="ac-muted">标注缺口接口不可用。</p>}
        {gaps.status === 'ok' &&
          (gaps.data ? (
            <>
              <div className="ac-detailstats">
                <div className="ac-detailstat">
                  <span className="ac-detailstat__value">{gaps.data.tableScanned ?? 0}</span>
                  <span className="ac-detailstat__label">已扫描表</span>
                </div>
                <div className="ac-detailstat">
                  <span
                    className={`ac-detailstat__value ${(gaps.data.unannotatedTableCount ?? 0) > 0 ? 'ac-detailstat__value--warn' : ''}`}
                  >
                    {gaps.data.unannotatedTableCount ?? 0}
                  </span>
                  <span className="ac-detailstat__label">缺注释表</span>
                </div>
                <div className="ac-detailstat">
                  <span className="ac-detailstat__value">{gaps.data.unannotatedColumnCount ?? 0}</span>
                  <span className="ac-detailstat__label">缺注释字段</span>
                </div>
              </div>
              {(gaps.data.tables ?? []).length > 0 && (
                <table className="ac-table">
                  <thead>
                    <tr>
                      <th>表</th>
                      <th>字段数</th>
                      <th>缺注释字段</th>
                      <th>表注释</th>
                    </tr>
                  </thead>
                  <tbody>
                    {gaps.data.tables.slice(0, 20).map(table => (
                      <tr key={table.id}>
                        <td className="ac-table__strong">
                          {table.databaseName}.{table.tableName}
                        </td>
                        <td>{table.columnCount}</td>
                        <td>{table.unannotatedColumnCount}</td>
                        <td>{table.tableCommentMissing ? '缺失' : table.tableComment || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {gaps.data.truncated && <p className="ac-muted">清单已截断，仅展示前 200 张表。</p>}
            </>
          ) : (
            <p className="ac-muted">暂无标注缺口数据。</p>
          ))}
      </section>
    </>
  );
};

// ── 主面板 ──────────────────────────────────────────────────

const AssetCatalogPanel: React.FC = () => {
  const [activeTab, setActiveTab] = useState<AssetTabId>('overview');
  const [view, setView] = useState<CatalogViewMode>('engine');
  const [keyword, setKeyword] = useState('');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<CatalogTreeNode | null>(null);
  const [tree, setTree] = useState<ProbeState<CatalogTreeNode[]>>({ status: 'loading', data: null });
  const [detail, setDetail] = useState<ProbeState<AssetTableDetailVO>>({ status: 'loading', data: null });
  const [detailReload, setDetailReload] = useState(0);
  const [refreshTick, setRefreshTick] = useState(0);

  // 右栏视图 + 检索驱动参数
  const [mainView, setMainView] = useState<MainView>('detail');
  const [searchKeyword, setSearchKeyword] = useState('');

  /** 当前环境：模块级状态，两个页签共用（切换即两个页签的全部内容一起重取）；默认生产 */
  const [env, setEnv] = useState<AssetEnvCode>(DEFAULT_ASSET_ENV);

  const selectedTableId = selected?.nodeKind === 'table' ? selected.tableMetadataId ?? null : null;

  /**
   * 盘点概况的收窄范围（规范视角下有效）：
   * - 选中「数仓名称」（domain 节点）→ 按 domainCode 收窄到该业务域；
   * - 选中「分层」（layer 节点）→ 再叠加 layerCode；
   * - 其它情况（未选 / 引擎视角的库表节点）→ 不收窄，保持环境全量。
   * 选中变化时下推服务端重取，四项盘点指标口径一致。
   */
  const inventoryScope = useMemo<{ domainCode?: string; layerCode?: string }>(() => {
    if (selected?.nodeKind === 'domain') return { domainCode: selected.domainCode };
    if (selected?.nodeKind === 'layer') {
      return { domainCode: selected.domainCode, layerCode: selected.layerCode };
    }
    return {};
  }, [selected]);

  /**
   * 详情聚合体 → 表详情统一形态。
   * 与数据探索的表详情（TableDetailContent）共用同一份渲染输入，
   * 保证两个入口看到的「一张表长什么样」完全一致。
   */
  const tableDetail = useMemo<TableDetailData | null>(() => {
    const d = detail.data;
    if (!d) return null;
    return {
      storageEngine: d.storageEngine || '',
      storageFormat: d.storageFormat || '',
      compression: d.compression ?? null,
      tableComment: d.tableComment || '',
      location: d.location || '',
      hotDays: d.hotDays,
      coldDays: d.coldDays,
      keepDays: d.keepDays,
      columns: (d.columns ?? [])
        .slice()
        .sort((a, b) => (a.ordinalPosition || 0) - (b.ordinalPosition || 0))
        .map(c => ({
          id: c.id,
          columnName: c.columnName,
          columnType: c.columnType || '',
          columnComment: c.columnComment || '',
          isPartition: !!c.isPartition,
          isPrimaryKey: !!c.isPrimaryKey,
          nullable: !!c.nullable,
        })),
    };
  }, [detail]);

  // 目录树按「视角 + 环境」探测：接口未接入时落到 unavailable，由 TreePlaceholder 呈现能力清单
  useEffect(() => {
    let cancelled = false;
    setTree({ status: 'loading', data: null });
    assetCatalogApi
      .getCatalogTree({ view, env })
      .then(res => {
        if (cancelled) return;
        const raw = res?.data ?? [];
        // 规范视角把服务端的「分层 → 业务域」重排为「数仓名称 → 分层」；引擎视角保持原样
        setTree({ status: 'ok', data: view === 'convention' ? regroupConventionTree(raw) : raw });
      })
      .catch(() => {
        if (!cancelled) setTree({ status: 'unavailable', data: null });
      });
    return () => {
      cancelled = true;
    };
  }, [view, refreshTick, env]);

  /**
   * 切换环境（模块级）：换的是「看哪一套」，因此原先选中的表不再属于当前环境，必须清掉，
   * 否则右栏会停留在「不属于当前环境的表」上，看起来像越权可见。
   * 目录树展开态同样清空。
   */
  const changeEnv = (next: AssetEnvCode) => {
    setEnv(next);
    setSelected(null);
    setExpanded(new Set());
  };

  /**
   * 切换目录视角：两套树的节点 key 不同，旧选中项在新树里已不存在，
   * 必须清掉，否则右栏会停在一个「当前树里并不存在」的节点上（盘点收窄也会跟着串味）。
   */
  const changeView = (next: CatalogViewMode) => {
    if (next === view) return;
    setView(next);
    setSelected(null);
    setExpanded(new Set());
  };

  // 选中表即拉取资产详情（概览与治理编辑的回显载体）。失败降级到 unavailable，不弹全局错误
  useEffect(() => {
    if (!selectedTableId) return;
    let cancelled = false;
    setDetail({ status: 'loading', data: null });
    assetCatalogApi
      .getTableDetail(selectedTableId)
      .then(res => {
        if (cancelled) return;
        setDetail(res?.data ? { status: 'ok', data: res.data } : { status: 'unavailable', data: null });
      })
      .catch(() => {
        if (!cancelled) setDetail({ status: 'unavailable', data: null });
      });
    return () => {
      cancelled = true;
    };
  }, [selectedTableId, detailReload, refreshTick]);

  // 检索联想：仅在有输入时探测，失败静默（联想属锦上添花，不降级为错误）
  useEffect(() => {
    const text = keyword.trim();
    if (!text) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      assetCatalogApi
        .suggest(text, env)
        .then(res => {
          if (!cancelled) setSuggestions(res?.data ?? []);
        })
        .catch(() => {
          if (!cancelled) setSuggestions([]);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [keyword, env]);

  const toggle = (key: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleSelect = (node: CatalogTreeNode) => {
    setSelected(node);
    setMainView('detail');
  };

  const submitSearch = () => {
    const text = keyword.trim();
    if (!text) return;
    setSearchKeyword(text);
    setMainView('search');
    setSuggestions([]);
  };

  const openFromHit = (hit: AssetSearchHit) => {
    const node = hitToTableNode(hit);
    if (!node) return;
    setSelected(node);
    setMainView('detail');
  };

  const reloadAll = () => {
    setRefreshTick(n => n + 1);
    if (selectedTableId) setDetailReload(n => n + 1);
  };

  /** 概览页签内容：基础信息（含生命周期编辑）+ 治理写操作，均由 AssetGovernanceEditor 提供 */
  const overviewContent =
    detail.data && tableDetail ? (
      <AssetGovernanceEditor
        detail={detail.data}
        tableDetail={tableDetail}
        onSaved={() => setDetailReload(n => n + 1)}
      />
    ) : null;

  const mainBody = (() => {
    if (mainView === 'search') {
      return (
        <SearchResultPane
          key={`search-${searchKeyword}-${refreshTick}-${env}`}
          keyword={searchKeyword}
          env={env}
          onOpenTable={openFromHit}
        />
      );
    }
    if (selectedTableId) {
      return (
        <>
          {/* 选中表：基础信息与数据探索模块共用同一份内容（TableDetailContent），
              其余能力页签见 AssetDetailTabs；读失败降级为「不可用 + 重新加载」 */}
          {detail.status === 'loading' && <div className="ac-loading">加载中…</div>}

          {detail.status === 'unavailable' && (
            <div className="ac-placeholder">
              <div className="ac-placeholder__head">
                <CircleAlert size={14} />
                <span>资产详情接口不可用，表详情暂无法读取。</span>
              </div>
              <p className="ac-placeholder__lead">
                请确认服务端 /api/asset/table/{'{id}'} 已部署；目录树与源表信息不受影响。
              </p>
              <button className="ac-btn ac-btn--ghost" type="button" onClick={() => setDetailReload(n => n + 1)}>
                <RefreshCw size={13} />
                <span>重新加载</span>
              </button>
            </div>
          )}

          {detail.status === 'ok' && detail.data && (
            <AssetDetailTabs
              tableId={detail.data.id}
              detail={detail.data}
              overviewContent={overviewContent}
            />
          )}
        </>
      );
    }
    return (
      <>

        <GovernanceSection
          env={env}
          domainCode={inventoryScope.domainCode}
          layerCode={inventoryScope.layerCode}
          scopeLabel={
            inventoryScope.domainCode || inventoryScope.layerCode ? selected?.label : undefined
          }
        />
      </>
    );
  })();

  return (
    <div className="ac-module">
      {/* 页签条右侧是模块级环境切换器：仅作用于资产概况 / 资产目录，切它即切换这两处全部内容 */}
      <div className="ac-module__bar">
        <nav className="ac-module__tabs" role="tablist">
          {MODULE_TABS.map(t => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={activeTab === t.id}
              className={`ac-module__tab ${activeTab === t.id ? 'ac-module__tab--active' : ''}`}
              onClick={() => setActiveTab(t.id)}
            >
              {t.icon}
              <span>{t.label}</span>
            </button>
          ))}
        </nav>
        {ENV_SCOPED_TABS.includes(activeTab) && (
          <AssetEnvSwitch
            value={env}
            onChange={changeEnv}
            hint="资产概况 / 资产目录共用"
          />
        )}
      </div>

      {activeTab === 'overview' ? (
        <AssetOverviewTab env={env} />
      ) : activeTab === 'template' ? (
        <div className="dq-panel__body">
          <TemplateTab />
        </div>
      ) : (
        <div className="ac-panel">
          {/* ── 左栏：搜索 + 视角 + 目录树 ── */}
          <aside className="ac-side">
            <div className="ac-side__search">
              <Search size={13} />
              <input
                className="ac-side__search-input"
                placeholder="搜索表 / 字段 / 指标"
                aria-label="搜索表 / 字段 / 指标"
                value={keyword}
                onChange={e => setKeyword(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') submitSearch();
                }}
              />
              <button className="ac-iconbtn ac-iconbtn--sm" type="button" aria-label="检索" onClick={submitSearch}>
                <Search size={13} />
              </button>
              {suggestions.length > 0 && (
                <ul className="ac-suggest" role="listbox">
                  {suggestions.slice(0, 8).map(text => (
                    <li key={text}>
                      <button
                        type="button"
                        onClick={() => {
                          setKeyword(text);
                          setSearchKeyword(text);
                          setMainView('search');
                          setSuggestions([]);
                        }}
                      >
                        {text}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="ac-side__views" role="tablist">
              <button
                role="tab"
                aria-selected={view === 'engine'}
                className={`ac-viewbtn ${view === 'engine' ? 'ac-viewbtn--active' : ''}`}
                onClick={() => changeView('engine')}
              >
                <Database size={12} />
                <span>引擎视角</span>
              </button>
              <button
                role="tab"
                aria-selected={view === 'convention'}
                className={`ac-viewbtn ${view === 'convention' ? 'ac-viewbtn--active' : ''}`}
                onClick={() => changeView('convention')}
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
                    <span>「{assetEnvLabel(env)}」环境下当前视角没有可访问的资产。</span>
                  </div>
                  <p className="ac-placeholder__lead">
                    若确认库中已有表，请检查元数据是否已同步、库名是否带上 _prod / _gray / _test 环境后缀，
                    以及当前角色的库表权限。
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
                    onSelect={handleSelect}
                  />
                ))}
            </div>
          </aside>

          {/* ── 右栏：详情 / 检索结果 ── */}
          <main className="ac-main">
            <header className="ac-main__header">
              <div>
                <h2 className="ac-main__title">
                  {mainView === 'search'
                    ? `检索「${searchKeyword}」`
                    : selected
                      ? selected.label
                      : '资产详情'}
                </h2>
                <p className="ac-main__subtitle">
                  {mainView !== 'detail'
                    ? '检索结果由服务端按库表权限过滤，并限定在当前环境'
                    : selected
                      ? `${selected.databaseName ?? ''}${selected.tableName ? `.${selected.tableName}` : ''}`
                      : '从左侧目录树选择一张表，或直接检索定位'}
                </p>
              </div>
              <div className="ac-main__tools">
                <span className="ac-main__env" title="当前环境，由左栏切换器控制">
                  <span className="ac-envswitch__dot" style={{ background: ASSET_ENV_COLOR[env] }} />
                  {assetEnvLabel(env)}
                </span>
                {mainView !== 'detail' && (
                  <button className="ac-btn ac-btn--ghost" type="button" onClick={() => setMainView('detail')}>
                    返回详情
                  </button>
                )}
                <button className="ac-iconbtn" type="button" aria-label="刷新" onClick={reloadAll}>
                  <RefreshCw size={14} />
                </button>
              </div>
            </header>

            <div className="ac-main__body">{mainBody}</div>
          </main>
        </div>
      )}
    </div>
  );
};

export default AssetCatalogPanel;
