/**
 * 资产详情页签（资产管理 → 资产目录 → 选中一张表后的右栏页签条）
 *
 * ── 定位 ────────────────────────────────────────────────────
 * 资产目录详情要回答「这表是什么、谁负责、能不能用、质量如何、影响谁」。其中
 * 「概览」由宿主面板提供（它持有 detail 与治理编辑入口），本组件负责其余页签，
 * 每个页签各自探测自己的接口 —— 一个页签不可用不影响其它页签。
 *
 * ── 页签与接口对应 ──────────────────────────────────────────
 * | 页签     | 接口                                   |
 * | -------- | -------------------------------------- |
 * | 指标     | GET /asset/table/{id}/indicators       |
 * | 数据质量 | GET /asset/table/{id}/quality          |
 * | 数据预览 | GET /asset/table/{id}/preview          |
 * | 使用说明 | GET/PUT /asset/table/{id}/doc、/doc/history |
 * | 权限     | 无独立端点：权限在服务端 fail-close 生效，此处只读说明 |
 *
 * ── 边界 ────────────────────────────────────────────────────
 * - 数据预览必然过服务端列权限与脱敏，前端不做任何兜底过滤（否则越权数据已到达客户端）。
 */

import { useEffect, useState } from 'react';
import { CircleAlert, RefreshCw, Save } from 'lucide-react';
import { assetCatalogApi } from '../../api/assetCatalog';
import type {
  AssetIndicatorVO,
  AssetQualitySummaryVO,
  AssetTableDetailVO,
} from '../../api/assetCatalog';
import { useProbe } from './useProbe';
import { useToast } from '../../components/Toast';
import { getQualityRuleType, QUALITY_DISPOSE_MODES } from '../../types/quality';

export type AssetDetailTabId =
  | 'overview'
  | 'indicator'
  | 'quality'
  | 'preview'
  | 'doc'
  | 'permission';

const TAB_LABELS: Array<{ id: AssetDetailTabId; label: string }> = [
  { id: 'overview', label: '概览' },
  { id: 'indicator', label: '指标' },
  { id: 'quality', label: '数据质量' },
  { id: 'preview', label: '数据预览' },
  { id: 'doc', label: '使用说明' },
  { id: 'permission', label: '权限' },
];

interface AssetDetailTabsProps {
  tableId: number;
  detail: AssetTableDetailVO;
  /** 概览页签内容由宿主面板提供（它持有 detail 与治理编辑入口） */
  overviewContent: React.ReactNode;
}

/** 页签级不可用占位：说明哪个接口没通 + 该页签将提供什么 */
const TabUnavailable: React.FC<{ apiPath: string; items: string[] }> = ({ apiPath, items }) => (
  <div className="ac-placeholder">
    <div className="ac-placeholder__head">
      <CircleAlert size={14} />
      <span>服务端 {apiPath} 尚未接入。</span>
    </div>
    <p className="ac-placeholder__lead">接口就绪后本页签将提供：</p>
    <ul className="ac-placeholder__list">
      {items.map(item => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  </div>
);

const TabLoading: React.FC = () => <div className="ac-loading">加载中…</div>;

const EmptyText: React.FC<{ text: string }> = ({ text }) => <p className="ac-muted">{text}</p>;

// ── 指标 ────────────────────────────────────────────────────

const IndicatorTab: React.FC<{ tableId: number }> = ({ tableId }) => {
  const { status, data } = useProbe<AssetIndicatorVO[]>(
    () => assetCatalogApi.getTableIndicators(tableId),
    [tableId]
  );

  if (status === 'loading') return <TabLoading />;
  if (status === 'unavailable')
    return (
      <TabUnavailable
        apiPath={`/api/asset/table/${tableId}/indicators`}
        items={['该表产出的指标（按 indicators_fields 反查）', '指标编码 / 名称 / 主题域 / 业务负责人 / 来源字段']}
      />
    );
  if (!data || data.length === 0) return <EmptyText text="该表暂未关联任何指标。" />;

  return (
    <table className="ac-table">
      <thead>
        <tr>
          <th>指标编码</th>
          <th>指标名称</th>
          <th>主题域</th>
          <th>业务负责人</th>
          <th>来源字段</th>
        </tr>
      </thead>
      <tbody>
        {data.map(item => (
          <tr key={item.id}>
            <td className="ac-table__strong">{item.code}</td>
            <td>{item.name}</td>
            <td>{item.topic || '-'}</td>
            <td>{item.businessOwner || '-'}</td>
            <td>{item.fieldName || '-'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

// ── 数据质量（跨模块读质量模块）────────────────────────────

/** 未通过记录的状态中文名；只用到两档：红色异常 / 校验失败 */
const QUALITY_STATUS_LABELS: Record<string, string> = {
  ERROR: '红色异常',
  FAILED: '校验失败',
};

const QualityTab: React.FC<{ tableId: number }> = ({ tableId }) => {
  const { status, data } = useProbe<AssetQualitySummaryVO>(
    () => assetCatalogApi.getTableQuality(tableId),
    [tableId]
  );

  if (status === 'loading') return <TabLoading />;
  if (status === 'unavailable')
    return (
      <TabUnavailable
        apiPath={`/api/asset/table/${tableId}/quality`}
        items={['该表已配置的规则数与启用数', '最近一次校验结果与时间、异常/失败条数', '未通过规则条数（用于在资产详情上提示质量问题）']}
      />
    );
  if (!data) return <EmptyText text="暂无质量摘要。" />;

  // 规则类型 / 处置方式的中文名只在 types/quality 定义一次，这里按编码映射，未知编码原样回显
  const disposeLabel = (code: string) =>
    QUALITY_DISPOSE_MODES.find(m => m.code === code)?.label ?? (code || '-');
  const enabledRules = data.enabledRules ?? [];
  const failedSamples = data.failedSamples ?? [];

  return (
    <div className="ac-section ac-section--tight">
      <div className="ac-detailstats">
        <div className="ac-detailstat">
          <span className="ac-detailstat__value">{data.ruleCount}</span>
          <span className="ac-detailstat__label">规则数</span>
        </div>
        <div className="ac-detailstat">
          <span className="ac-detailstat__value">{data.enabledRuleCount}</span>
          <span className="ac-detailstat__label">启用规则</span>
        </div>
        <div className="ac-detailstat">
          <span className={`ac-detailstat__value ${data.problemRuleCount > 0 ? 'ac-detailstat__value--warn' : ''}`}>
            {data.problemRuleCount}
          </span>
          <span className="ac-detailstat__label">未通过规则</span>
        </div>
        <div className="ac-detailstat">
          <span className="ac-detailstat__value">{data.errorCount}</span>
          <span className="ac-detailstat__label">红色异常</span>
        </div>
        <div className="ac-detailstat">
          <span className="ac-detailstat__value">{data.failCount}</span>
          <span className="ac-detailstat__label">校验失败</span>
        </div>
      </div>
      <p className="ac-muted">
        最近一次校验：{data.lastRunTime || '-'}
        {data.lastRunStatus ? ` · ${data.lastRunStatus}` : ''}
      </p>

      <hr className="ac-divider" />

      <h4 className="ac-section__title">已启用质检规则</h4>
      {enabledRules.length === 0 ? (
        <EmptyText text="该表暂无已启用的质检规则。" />
      ) : (
        <table className="ac-table">
          <thead>
            <tr>
              <th>规则名称</th>
              <th>规则类型</th>
              <th>校验字段</th>
              <th>处置方式</th>
              <th>负责人</th>
            </tr>
          </thead>
          <tbody>
            {enabledRules.map(rule => (
              <tr key={rule.id}>
                <td className="ac-table__strong">{rule.ruleName}</td>
                <td>{getQualityRuleType(rule.ruleType)?.label ?? rule.ruleType ?? '-'}</td>
                <td>{rule.columnName || '-'}</td>
                <td>{disposeLabel(rule.disposeMode)}</td>
                <td>{rule.ownerName || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <hr className="ac-divider" />

      <h4 className="ac-section__title">未通过质检记录样例</h4>
      {failedSamples.length === 0 ? (
        <EmptyText text="最近一次校验暂无未通过记录。" />
      ) : (
        <table className="ac-table">
          <thead>
            <tr>
              <th>质检时间</th>
              <th>质检规则</th>
              <th>状态</th>
              <th>完整数据样例</th>
            </tr>
          </thead>
          <tbody>
            {failedSamples.map(s => (
              <tr key={s.id}>
                <td className="ac-table__strong">{s.checkTime || '-'}</td>
                <td>
                  {s.ruleName || '-'}
                  {s.ruleType ? `（${getQualityRuleType(s.ruleType)?.label ?? s.ruleType}）` : ''}
                </td>
                <td>{QUALITY_STATUS_LABELS[s.status] ?? s.status ?? '-'}</td>
                <td>
                  <pre className="ac-sample">{s.sample || '-'}</pre>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <hr className="ac-divider" />

      <p className="ac-muted">
        规则的校验结果在此只读汇总；校验模板在「资产管理 → 规则模板」维护，阻断下游由质量校验任务作为调度节点实现。
      </p>
    </div>
  );
};

// ── 数据预览 ────────────────────────────────────────────────

const PREVIEW_LIMITS = [20, 50, 100];

const PreviewTab: React.FC<{ tableId: number }> = ({ tableId }) => {
  const [limit, setLimit] = useState(PREVIEW_LIMITS[0]);
  const [reload, setReload] = useState(0);
  const { status, data } = useProbe<{ columns: string[]; rows: Array<Array<string | null>> }>(
    () => assetCatalogApi.previewTable(tableId, { limit }),
    [tableId, limit, reload]
  );

  return (
    <>
      <div className="ac-inlinebar">
        <label className="ac-inlinebar__label" htmlFor="ac-preview-limit">
          预览行数
        </label>
        <select
          id="ac-preview-limit"
          className="ac-select ac-select--sm"
          value={limit}
          onChange={e => setLimit(Number(e.target.value))}
        >
          {PREVIEW_LIMITS.map(n => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <button className="ac-btn ac-btn--ghost" type="button" onClick={() => setReload(n => n + 1)}>
          <RefreshCw size={13} />
          <span>重新预览</span>
        </button>
        <span className="ac-muted">服务端已按当前用户的列权限过滤并对敏感字段脱敏。</span>
      </div>

      {status === 'loading' && <TabLoading />}
      {status === 'unavailable' && (
        <TabUnavailable
          apiPath={`/api/asset/table/${tableId}/preview`}
          items={['按行数上限采样预览表数据', '服务端强制过列权限与脱敏，越权字段不下发']}
        />
      )}
      {status === 'ok' && (
        !data || data.columns.length === 0 ? (
          <EmptyText text="该表暂无可预览数据。" />
        ) : (
          <div className="ac-preview">
            <table className="ac-table ac-table--preview">
              <thead>
                <tr>
                  {data.columns.map(col => (
                    <th key={col}>{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex}>{cell ?? '—'}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </>
  );
};

// ── 使用说明（markdown 文档 + 历史版本）─────────────────────

const DocTab: React.FC<{ tableId: number }> = ({ tableId }) => {
  const toast = useToast();
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  const doc = useProbe<{ content: string; updateTime: string; updateBy: string }>(
    () => assetCatalogApi.getTableDoc(tableId),
    [tableId, reload]
  );
  const history = useProbe<Array<{ version: number; updateTime: string; updateBy: string }>>(
    () => assetCatalogApi.listDocHistory(tableId),
    [tableId, reload]
  );

  // 回填服务端文档；只在非编辑态覆盖，避免把用户正在输入的内容冲掉
  useEffect(() => {
    if (doc.status === 'ok' && !dirty) setContent(doc.data?.content ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.status, reload]);

  const save = async () => {
    setSaving(true);
    try {
      await assetCatalogApi.saveTableDoc(tableId, content);
      setDirty(false);
      setReload(n => n + 1);
      toast.info('使用说明已保存');
    } catch (e) {
      toast.error(`使用说明保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  if (doc.status === 'loading') return <TabLoading />;
  if (doc.status === 'unavailable')
    return (
      <TabUnavailable
        apiPath={`/api/asset/table/${tableId}/doc`}
        items={['markdown 使用说明的读写', '历史版本（版本号 / 更新时间 / 更新人）']}
      />
    );

  return (
    <>
      <textarea
        className="ac-textarea"
        aria-label="使用说明"
        rows={10}
        placeholder="以 markdown 记录该表的使用说明、口径与注意事项…"
        value={content}
        onChange={e => {
          setContent(e.target.value);
          setDirty(true);
        }}
      />

      <div className="ac-inlinebar">
        <button className="ac-btn" type="button" disabled={saving || !dirty} onClick={save}>
          <Save size={13} />
          <span>{saving ? '保存中…' : '保存'}</span>
        </button>
        {dirty && <span className="ac-muted">有未保存的修改</span>}
        {!dirty && doc.data?.updateTime && (
          <span className="ac-muted">
            最近更新：{doc.data.updateTime}
            {doc.data.updateBy ? ` · ${doc.data.updateBy}` : ''}
          </span>
        )}
      </div>

      <section className="ac-section ac-section--tight">
        <h4 className="ac-section__title">历史版本</h4>
        {history.status === 'unavailable' ? (
          <EmptyText text="历史版本接口不可用。" />
        ) : (history.data?.length ?? 0) === 0 ? (
          <EmptyText text="暂无历史版本。" />
        ) : (
          <table className="ac-table">
            <thead>
              <tr>
                <th>版本</th>
                <th>更新时间</th>
                <th>更新人</th>
              </tr>
            </thead>
            <tbody>
              {history.data!.map(item => (
                <tr key={item.version}>
                  <td className="ac-table__strong">v{item.version}</td>
                  <td>{item.updateTime}</td>
                  <td>{item.updateBy || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
};

// ── 权限（只读说明）─────────────────────────────────────────

const PermissionTab: React.FC<{ detail: AssetTableDetailVO }> = ({ detail }) => (
  <div className="ac-section ac-section--tight">
    <p className="ac-muted">
      权限无独立端点：目录树、检索与详情由服务端按 <code>sys_table_permission</code>（含行 / 列级）
      fail-close 过滤 —— 越权表名与字段名根本不会下发到客户端，因此这里展示的即「你有权看的部分」。
    </p>
    <table className="ac-table">
      <thead>
        <tr>
          <th>维度</th>
          <th>当前值</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td className="ac-table__strong">可见性</td>
          <td>{detail.visibility || 'internal'}</td>
        </tr>
        <tr>
          <td className="ac-table__strong">资产等级</td>
          <td>{detail.assetLevel || '-'}</td>
        </tr>
        <tr>
          <td className="ac-table__strong">业务负责人</td>
          <td>{detail.businessOwner || '-'}</td>
        </tr>
        <tr>
          <td className="ac-table__strong">技术负责人</td>
          <td>{detail.techOwner || '-'}</td>
        </tr>
      </tbody>
    </table>
  </div>
);

// ── 页签条 ──────────────────────────────────────────────────

const AssetDetailTabs: React.FC<AssetDetailTabsProps> = ({ tableId, detail, overviewContent }) => {
  const [active, setActive] = useState<AssetDetailTabId>('overview');

  // 换表时回到概览：否则会带着 A 表的页签落到 B 表上
  useEffect(() => {
    setActive('overview');
  }, [tableId]);

  let body: React.ReactNode = null;
  switch (active) {
    case 'overview':
      body = overviewContent;
      break;
    case 'indicator':
      body = <IndicatorTab tableId={tableId} />;
      break;
    case 'quality':
      body = <QualityTab tableId={tableId} />;
      break;
    case 'preview':
      body = <PreviewTab tableId={tableId} />;
      break;
    case 'doc':
      body = <DocTab tableId={tableId} />;
      break;
    case 'permission':
      body = <PermissionTab detail={detail} />;
      break;
    default:
      body = null;
  }

  return (
    <>
      <nav className="ac-tabs" role="tablist">
        {TAB_LABELS.map(tab => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active === tab.id}
            className={`ac-tab ${active === tab.id ? 'ac-tab--active' : ''}`}
            onClick={() => setActive(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>
      <div className="ac-tabbody">{body}</div>
    </>
  );
};

export default AssetDetailTabs;
