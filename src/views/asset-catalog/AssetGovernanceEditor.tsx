/**
 * 资产治理编辑器（资产管理 → 资产目录 → 概览页签内）
 *
 * ── 覆盖的写接口 ────────────────────────────────────────────
 * | 区块     | 接口                              |
 * | -------- | --------------------------------- |
 * | 负责人   | PUT /asset/table/{id}/owner       |
 * | 分类属性 | PUT /asset/table/{id}/category    |
 * | 标签     | PUT /asset/table/{id}/tags        |
 * | 元数据   | POST /asset/table/{id}/refresh    |
 *
 * ── 约定 ────────────────────────────────────────────────────
 * - 标签接口是**整体替换**（提交最终集合，不是增量），因此这里以复选框维护一个本地集合，
 *   提交前不写库；分类属性同理，一次提交四个字段。
 * - 字典（分类 / 标签）各自探测：字典不可用时降级为「当前值只读展示 + 说明」，
 *   不用自由文本硬撑 —— 否则会写入服务端不认识的编码。
 * - 写失败一律 toast（写操作必须让用户知道没成功）；读失败仍在区块内降级。
 * - 写成功后由宿主面板重拉详情，这里不自行改本地副本（避免与服务端解析结果漂移，
 *   例如 categoryCode 清空后服务端会按表名重新解析分层与业务域）。
 */

import { useEffect, useState } from 'react';
import { CircleAlert, RefreshCw, Save } from 'lucide-react';
import { assetCatalogApi } from '../../api/assetCatalog';
import type { AssetCategoryVO, AssetTagVO, AssetTableDetailVO } from '../../api/assetCatalog';
import { useProbe } from './useProbe';
import { useToast } from '../../components/Toast';

/** 可见性取值与服务端校验一致（AssetGovernanceService 只接受这三个） */
const VISIBILITY_OPTIONS = [
  { value: 'public', label: 'public（公开）' },
  { value: 'internal', label: 'internal（内部）' },
  { value: 'restricted', label: 'restricted（受限）' },
];

/** 资产等级取值与服务端校验一致（L1~L5） */
const ASSET_LEVEL_OPTIONS = ['L1', 'L2', 'L3', 'L4', 'L5'];

interface AssetGovernanceEditorProps {
  detail: AssetTableDetailVO;
  /** 写成功后通知宿主重拉详情 */
  onSaved: () => void;
}

const SectionTitle: React.FC<{ title: string; hint?: string }> = ({ title, hint }) => (
  <h4 className="ac-section__title">
    <span>{title}</span>
    {hint && <span className="ac-section__hint">{hint}</span>}
  </h4>
);

const AssetGovernanceEditor: React.FC<AssetGovernanceEditorProps> = ({ detail, onSaved }) => {
  const toast = useToast();
  const tableId = detail.id;

  const categories = useProbe<AssetCategoryVO[]>(() => assetCatalogApi.listCategories(), []);
  const tags = useProbe<AssetTagVO[]>(() => assetCatalogApi.listTags(), []);

  const [businessOwner, setBusinessOwner] = useState(detail.businessOwner ?? '');
  const [techOwner, setTechOwner] = useState(detail.techOwner ?? '');
  const [categoryCode, setCategoryCode] = useState(detail.categoryCode ?? '');
  const [topic, setTopic] = useState(detail.topic ?? '');
  const [visibility, setVisibility] = useState(detail.visibility || 'internal');
  const [assetLevel, setAssetLevel] = useState(detail.assetLevel ?? '');
  const [tagCodes, setTagCodes] = useState<string[]>(() => (detail.tags ?? []).map(t => t.tagCode));
  const [busy, setBusy] = useState<'' | 'owner' | 'category' | 'tags' | 'refresh'>('');
  const [refreshing, setRefreshing] = useState(false);

  // 换表或详情重拉后回填（写成功后 onSaved 会触发重拉，此处保证表单与服务端一致）
  useEffect(() => {
    setBusinessOwner(detail.businessOwner ?? '');
    setTechOwner(detail.techOwner ?? '');
    setCategoryCode(detail.categoryCode ?? '');
    setTopic(detail.topic ?? '');
    setVisibility(detail.visibility || 'internal');
    setAssetLevel(detail.assetLevel ?? '');
    setTagCodes((detail.tags ?? []).map(t => t.tagCode));
  }, [detail]);

  const fail = (label: string, e: unknown) => {
    toast.error(`${label}失败：${e instanceof Error ? e.message : String(e)}`);
  };

  const saveOwner = async () => {
    setBusy('owner');
    try {
      await assetCatalogApi.updateOwner(tableId, { businessOwner, techOwner });
      toast.info('负责人已更新');
      onSaved();
    } catch (e) {
      fail('负责人更新', e);
    } finally {
      setBusy('');
    }
  };

  const saveCategory = async () => {
    setBusy('category');
    try {
      await assetCatalogApi.updateCategory(tableId, { categoryCode, topic, visibility, assetLevel });
      toast.info('分类属性已更新');
      onSaved();
    } catch (e) {
      fail('分类属性更新', e);
    } finally {
      setBusy('');
    }
  };

  const saveTags = async () => {
    setBusy('tags');
    try {
      await assetCatalogApi.updateTags(tableId, tagCodes);
      toast.info('标签已更新');
      onSaved();
    } catch (e) {
      fail('标签更新', e);
    } finally {
      setBusy('');
    }
  };

  const refreshMetadata = async () => {
    setBusy('refresh');
    setRefreshing(true);
    try {
      await assetCatalogApi.refreshTableMetadata(tableId);
      toast.info('已触发元数据刷新');
      onSaved();
    } catch (e) {
      // 刷新失败原因通常很具体（未关联数据源 / 缺存储引擎 / 数据源不通），必须原样透出
      toast.error(`元数据刷新失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRefreshing(false);
      setBusy('');
    }
  };

  const toggleTag = (code: string) => {
    setTagCodes(prev => (prev.includes(code) ? prev.filter(c => c !== code) : [...prev, code]));
  };

  const categoryUnavailable = categories.status === 'unavailable';
  const tagUnavailable = tags.status === 'unavailable';

  return (
    <>
      <section className="ac-section ac-section--tight">
        <SectionTitle title="负责人" hint="业务负责人对口径负责，技术负责人对产出任务负责" />
        <div className="ac-form-row">
          <div className="ac-form-group">
            <label htmlFor="ac-owner-business">业务负责人</label>
            <input
              id="ac-owner-business"
              className="ac-input"
              value={businessOwner}
              onChange={e => setBusinessOwner(e.target.value)}
              placeholder="未指定"
            />
          </div>
          <div className="ac-form-group">
            <label htmlFor="ac-owner-tech">技术负责人</label>
            <input
              id="ac-owner-tech"
              className="ac-input"
              value={techOwner}
              onChange={e => setTechOwner(e.target.value)}
              placeholder="未指定"
            />
          </div>
        </div>
        <div className="ac-inlinebar">
          <button className="ac-btn" type="button" disabled={busy === 'owner'} onClick={saveOwner}>
            <Save size={13} />
            <span>{busy === 'owner' ? '保存中…' : '保存负责人'}</span>
          </button>
        </div>
      </section>

      <section className="ac-section ac-section--tight">
        <SectionTitle title="分类与可见性" hint="分类编码留空则按表名规范自动解析分层与业务域" />
        <div className="ac-form-row">
          <div className="ac-form-group">
            <label htmlFor="ac-category">分类</label>
            {categoryUnavailable ? (
              <input id="ac-category" className="ac-input" value={categoryCode} readOnly />
            ) : (
              <select
                id="ac-category"
                className="ac-select"
                value={categoryCode}
                onChange={e => setCategoryCode(e.target.value)}
              >
                <option value="">（按表名自动解析）</option>
                {(categories.data ?? []).map(item => (
                  <option key={item.code} value={item.code}>
                    {item.name}（{item.categoryKind === 'layer' ? '分层' : '业务域'}）
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="ac-form-group">
            <label htmlFor="ac-topic">主题域</label>
            <input id="ac-topic" className="ac-input" value={topic} onChange={e => setTopic(e.target.value)} />
          </div>
        </div>
        <div className="ac-form-row">
          <div className="ac-form-group">
            <label htmlFor="ac-visibility">可见性</label>
            <select
              id="ac-visibility"
              className="ac-select"
              value={visibility}
              onChange={e => setVisibility(e.target.value)}
            >
              {VISIBILITY_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <div className="ac-form-group">
            <label htmlFor="ac-level">资产等级</label>
            <select id="ac-level" className="ac-select" value={assetLevel} onChange={e => setAssetLevel(e.target.value)}>
              <option value="">（未定级）</option>
              {ASSET_LEVEL_OPTIONS.map(level => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="ac-inlinebar">
          <button className="ac-btn" type="button" disabled={busy === 'category'} onClick={saveCategory}>
            <Save size={13} />
            <span>{busy === 'category' ? '保存中…' : '保存分类属性'}</span>
          </button>
          {categoryUnavailable && (
            <span className="ac-muted">
              分类字典接口不可用，当前仅可查看；分类编码不是自由文本，避免写入服务端不认识的取值。
            </span>
          )}
        </div>
      </section>

      <section className="ac-section ac-section--tight">
        <SectionTitle title="标签" hint="整体替换：提交的是最终集合" />
        {tagUnavailable ? (
          <p className="ac-muted">
            <CircleAlert size={12} /> 标签字典接口不可用，暂无法编辑。
          </p>
        ) : (tags.data?.length ?? 0) === 0 ? (
          <p className="ac-muted">暂无可选标签。</p>
        ) : (
          <div className="ac-chips ac-chips--selectable">
            {tags.data!.map(tag => {
              const on = tagCodes.includes(tag.tagCode);
              return (
                <button
                  key={tag.tagCode}
                  type="button"
                  aria-pressed={on}
                  className={`ac-chip ${on ? 'ac-chip--on' : ''}`}
                  onClick={() => toggleTag(tag.tagCode)}
                >
                  {tag.tagName}
                </button>
              );
            })}
          </div>
        )}
        <div className="ac-inlinebar">
          <button className="ac-btn" type="button" disabled={busy === 'tags' || tagUnavailable} onClick={saveTags}>
            <Save size={13} />
            <span>{busy === 'tags' ? '保存中…' : '保存标签'}</span>
          </button>
        </div>
      </section>

      <section className="ac-section ac-section--tight">
        <SectionTitle title="元数据" hint="复用既有同步能力，仅做入口收口" />
        <div className="ac-inlinebar">
          <button className="ac-btn ac-btn--ghost" type="button" onClick={refreshMetadata} disabled={refreshing}>
            <RefreshCw size={13} />
            <span>{refreshing ? '刷新中…' : '刷新元数据'}</span>
          </button>
          <span className="ac-muted">重新拉取该表的字段与存储信息；数据源不通时刷新会失败并给出原因。</span>
        </div>
      </section>
    </>
  );
};

export default AssetGovernanceEditor;
