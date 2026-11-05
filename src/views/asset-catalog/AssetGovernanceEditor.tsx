/**
 * 资产概览区块（资产管理 → 资产目录 → 选中一张表后的概览页签）
 *
 * ── 覆盖的写接口 ────────────────────────────────────────────
 * | 区块     | 接口                              |
 * | -------- | --------------------------------- |
 * | 生命周期 | PUT /asset/table/{id}/lifecycle   |
 * | 负责人   | PUT /asset/table/{id}/owner       |
 * | 分类属性 | PUT /asset/table/{id}/category    |
 * | 标签     | PUT /asset/table/{id}/tags        |
 * | 元数据   | POST /asset/table/{id}/refresh    |
 *
 * ── 交互约定 ────────────────────────────────────────────────
 * - 每个区块默认只读，标题右侧放编辑图标：点「编辑」进入编辑态（同一时刻只允许一个区块可改，
 *   避免把半成品一并提交），图标变为「保存 / 取消」。表固有信息（存储引擎 / 格式 / 字段结构等，
 *   由 TableDetailContent 渲染）不在可编辑范围内，只有「基础信息」区块内的生命周期可改。
 * - 标签接口是**整体替换**（提交最终集合，不是增量），因此编辑态以复选框维护一个本地集合，
 *   提交前不写库；分类属性同理，一次提交四个字段。
 * - 负责人下拉只列**平台用户**，但后端实际存的是**租户编码**：用「租户 ↔ 绑定用户」关系
 *   （tenant.userId === user.id）把用户映射到 tenantCode，下拉取值即 tenantCode、展示为用户。
 * - 字典（分类 / 标签）各自探测：字典不可用时降级为「当前值只读展示 + 说明」，
 *   不用自由文本硬撑 —— 否则会写入服务端不认识的编码。
 * - 写失败一律 toast（写操作必须让用户知道没成功）；读失败仍在区块内降级。
 * - 写成功后由宿主面板重拉详情，这里不自行改本地副本（避免与服务端解析结果漂移，
 *   例如 categoryCode 清空后服务端会按表名重新解析分层与业务域）。
 */

import { useEffect, useState } from 'react';
import { Check, CircleAlert, Pencil, RefreshCw, X } from 'lucide-react';
import { assetCatalogApi } from '../../api/assetCatalog';
import { systemUserApi } from '../../api/systemUser';
import type { UserInfo } from '../../api/systemUser';
import { tenantApi } from '../../api/systemTenant';
import type { TenantVO } from '../../api/systemTenant';
import type {
  AssetCategoryVO,
  AssetLifecycleVO,
  AssetTagVO,
  AssetTableDetailVO,
} from '../../api/assetCatalog';
import TableDetailContent from '../data-explore/TableDetailContent';
import type { TableDetailData } from '../data-explore/TableDetailContent';
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

/** 生命周期编辑表单：以字符串承载输入，提交前统一校验（避免输入中途被 number 化截断） */
interface LifecycleForm {
  hotDays: string;
  coldDays: string;
  keepDays: string;
}

/** 生命周期三档校验：正整数天数，且热 ≤ 冷 ≤ 保留（与 table_metadata 的列语义一致） */
function validateLifecycle(form: LifecycleForm): { value?: AssetLifecycleVO; error?: string } {
  const parseDays = (raw: string, label: string): number | string => {
    const text = raw.trim();
    if (!/^\d+$/.test(text) || Number(text) <= 0) return `${label}须为大于 0 的整数天数`;
    return Number(text);
  };
  const hot = parseDays(form.hotDays, '热数据天数');
  if (typeof hot === 'string') return { error: hot };
  const cold = parseDays(form.coldDays, '冷数据天数');
  if (typeof cold === 'string') return { error: cold };
  const keep = parseDays(form.keepDays, '保留天数');
  if (typeof keep === 'string') return { error: keep };
  if (hot > cold) return { error: '热数据天数不得大于冷数据天数' };
  if (cold > keep) return { error: '冷数据天数不得大于保留天数' };
  return { value: { hotDays: hot, coldDays: cold, keepDays: keep } };
}

/** 当前处于编辑态的区块（'' 表示全部只读） */
type EditableSection = '' | 'lifecycle' | 'owner' | 'category' | 'tags';

/** 各区块编辑图标的无障碍名称 */
const EDIT_LABEL: Record<Exclude<EditableSection, ''>, string> = {
  lifecycle: '编辑生命周期',
  owner: '编辑负责人',
  category: '编辑分类属性',
  tags: '编辑标签',
};

interface AssetGovernanceEditorProps {
  detail: AssetTableDetailVO;
  /** 表详情统一形态（与数据探索共用渲染输入），基础信息区块直接渲染 */
  tableDetail: TableDetailData;
  /** 写成功后通知宿主重拉详情 */
  onSaved: () => void;
}

const SectionTitle: React.FC<{ title: string; hint?: string; action?: React.ReactNode }> = ({
  title,
  hint,
  action,
}) => (
  <h4 className="ac-section__title">
    <span>{title}</span>
    {hint && <span className="ac-section__hint">{hint}</span>}
    {action && <span className="ac-section__action">{action}</span>}
  </h4>
);

/** 只读态的一项：标签 + 值 */
const ReadonlyItem: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className="ac-readonly-item">
    <span className="ac-readonly-label">{label}</span>
    <span className="ac-readonly-value">{value}</span>
  </div>
);

const AssetGovernanceEditor: React.FC<AssetGovernanceEditorProps> = ({
  detail,
  tableDetail,
  onSaved,
}) => {
  const toast = useToast();
  const tableId = detail.id;

  const categories = useProbe<AssetCategoryVO[]>(() => assetCatalogApi.listCategories(), []);
  const tags = useProbe<AssetTagVO[]>(() => assetCatalogApi.listTags(), []);
  // 负责人只能从平台用户里选：拉取系统用户列表作为下拉选项
  const users = useProbe<UserInfo[]>(
    () => systemUserApi.getUserList({ current: 1, size: 200 }).then(res => ({ data: res.data?.records ?? [] })),
    []
  );
  // 后端负责人存的是租户编码：再拉租户列表，用「租户 ↔ 绑定用户」关系把用户映射到租户编码
  const tenants = useProbe<TenantVO[]>(
    () => tenantApi.getList({ current: 1, size: 200 }).then(res => ({ data: res.data?.records ?? [] })),
    []
  );

  const [editing, setEditing] = useState<EditableSection>('');

  const [businessOwner, setBusinessOwner] = useState(detail.businessOwner ?? '');
  const [techOwner, setTechOwner] = useState(detail.techOwner ?? '');
  const [categoryCode, setCategoryCode] = useState(detail.categoryCode ?? '');
  const [topic, setTopic] = useState(detail.topic ?? '');
  const [visibility, setVisibility] = useState(detail.visibility || 'internal');
  const [assetLevel, setAssetLevel] = useState(detail.assetLevel ?? '');
  const [tagCodes, setTagCodes] = useState<string[]>(() => (detail.tags ?? []).map(t => t.tagCode));
  const [lifecycleForm, setLifecycleForm] = useState<LifecycleForm>({
    hotDays: '',
    coldDays: '',
    keepDays: '',
  });
  const [lifecycleError, setLifecycleError] = useState('');
  const [busy, setBusy] = useState<'' | 'lifecycle' | 'owner' | 'category' | 'tags' | 'refresh'>('');
  const [refreshing, setRefreshing] = useState(false);

  // 换表或详情重拉后回填，并退出编辑态（写成功后 onSaved 会触发重拉，此处保证表单与服务端一致）
  useEffect(() => {
    setBusinessOwner(detail.businessOwner ?? '');
    setTechOwner(detail.techOwner ?? '');
    setCategoryCode(detail.categoryCode ?? '');
    setTopic(detail.topic ?? '');
    setVisibility(detail.visibility || 'internal');
    setAssetLevel(detail.assetLevel ?? '');
    setTagCodes((detail.tags ?? []).map(t => t.tagCode));
    setEditing('');
    setLifecycleError('');
  }, [detail]);

  /** 进入某区块的编辑态；生命周期需把当前值填进表单 */
  const startEdit = (section: EditableSection) => {
    setLifecycleError('');
    if (section === 'lifecycle') {
      setLifecycleForm({
        hotDays: detail.hotDays != null ? String(detail.hotDays) : '',
        coldDays: detail.coldDays != null ? String(detail.coldDays) : '',
        keepDays: detail.keepDays != null ? String(detail.keepDays) : '',
      });
    }
    setEditing(section);
  };

  const cancelEdit = () => {
    setLifecycleError('');
    setEditing('');
  };

  const fail = (label: string, e: unknown) => {
    toast.error(`${label}失败：${e instanceof Error ? e.message : String(e)}`);
  };

  const saveLifecycle = async () => {
    const checked = validateLifecycle(lifecycleForm);
    if (checked.error || !checked.value) {
      setLifecycleError(checked.error ?? '生命周期参数不合法');
      return;
    }
    setBusy('lifecycle');
    try {
      await assetCatalogApi.updateLifecycle(tableId, checked.value);
      toast.info('生命周期已更新');
      cancelEdit();
      onSaved();
    } catch (e) {
      fail('生命周期更新', e);
    } finally {
      setBusy('');
    }
  };

  const saveOwner = async () => {
    setBusy('owner');
    try {
      await assetCatalogApi.updateOwner(tableId, { businessOwner, techOwner });
      toast.info('负责人已更新');
      cancelEdit();
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
      cancelEdit();
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
      cancelEdit();
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
  const ownerUnavailable = users.status === 'unavailable' || tenants.status === 'unavailable';

  /** 分类编码 → 展示名（字典不可用时退回编码本身） */
  const categoryName = (code: string) => {
    if (!code) return '（按表名自动解析）';
    return (categories.data ?? []).find(c => c.code === code)?.name ?? code;
  };
  const visibilityLabel = VISIBILITY_OPTIONS.find(o => o.value === visibility)?.label ?? visibility;
  const selectedTags = detail.tags ?? [];

  /** 负责人下拉选项：把平台用户映射到其绑定的租户编码（后端负责人存的是租户编码） */
  const tenantCodeByUserId = new Map<number, string>();
  (tenants.data ?? []).forEach(t => {
    if (t.userId != null && t.tenantCode) tenantCodeByUserId.set(t.userId, t.tenantCode);
  });
  const ownerOptions = (users.data ?? [])
    .filter(u => tenantCodeByUserId.has(u.id))
    .map(u => ({
      code: tenantCodeByUserId.get(u.id) as string,
      label: u.realName ? `${u.realName}（${u.username}）` : u.username,
    }));

  /** 租户编码 → 展示名（找不到对应用户时原样展示编码） */
  const ownerLabel = (value: string) => {
    if (!value) return '未指定';
    return ownerOptions.find(o => o.code === value)?.label ?? value;
  };

  /** 负责人下拉选项：平台用户（值为其租户编码）+ 空值；历史值无法匹配时保留一条，避免误清空 */
  const ownerOptionsNode = (value: string) => (
    <>
      <option value="">（未指定）</option>
      {ownerOptions.map(o => (
        <option key={o.code} value={o.code}>
          {o.label}
        </option>
      ))}
      {value && !ownerOptions.some(o => o.code === value) && <option value={value}>{value}</option>}
    </>
  );

  /** 标题右侧的编辑图标：未编辑态是「笔」，编辑态是「保存 / 取消」 */
  const sectionAction = (
    key: Exclude<EditableSection, ''>,
    onSave: () => void,
    saveDisabled = false
  ) =>
    editing === key ? (
      <>
        <button
          className="ac-section__iconbtn"
          type="button"
          aria-label="保存"
          disabled={busy === key || saveDisabled}
          onClick={onSave}
        >
          <Check size={14} />
        </button>
        <button className="ac-section__iconbtn" type="button" aria-label="取消" onClick={cancelEdit}>
          <X size={14} />
        </button>
      </>
    ) : (
      <button
        className="ac-section__iconbtn"
        type="button"
        aria-label={EDIT_LABEL[key]}
        disabled={key === 'tags' && tagUnavailable}
        onClick={() => startEdit(key)}
      >
        <Pencil size={14} />
      </button>
    );

  return (
    <>
      <section className="ac-section ac-section--tight">
        <SectionTitle
          title="基础信息"
          hint="存储引擎 / 字段结构等为只读固有信息，仅生命周期可编辑"
          action={sectionAction('lifecycle', saveLifecycle)}
        />
        {editing === 'lifecycle' && (
          <>
            <div className="ac-form-row">
              <div className="ac-form-group">
                <label htmlFor="ac-lifecycle-hot">
                  热数据天数 <span className="ac-required">*</span>
                </label>
                <input
                  id="ac-lifecycle-hot"
                  className="ac-input"
                  inputMode="numeric"
                  value={lifecycleForm.hotDays}
                  onChange={e => setLifecycleForm({ ...lifecycleForm, hotDays: e.target.value })}
                />
              </div>
              <div className="ac-form-group">
                <label htmlFor="ac-lifecycle-cold">
                  冷数据天数 <span className="ac-required">*</span>
                </label>
                <input
                  id="ac-lifecycle-cold"
                  className="ac-input"
                  inputMode="numeric"
                  value={lifecycleForm.coldDays}
                  onChange={e => setLifecycleForm({ ...lifecycleForm, coldDays: e.target.value })}
                />
              </div>
              <div className="ac-form-group">
                <label htmlFor="ac-lifecycle-keep">
                  保留天数 <span className="ac-required">*</span>
                </label>
                <input
                  id="ac-lifecycle-keep"
                  className="ac-input"
                  inputMode="numeric"
                  value={lifecycleForm.keepDays}
                  onChange={e => setLifecycleForm({ ...lifecycleForm, keepDays: e.target.value })}
                />
              </div>
            </div>
            {lifecycleError && <p className="ac-form-error">{lifecycleError}</p>}
          </>
        )}
        <TableDetailContent detail={tableDetail} />
      </section>

      <section className="ac-section ac-section--tight ac-section--divided">
        <SectionTitle
          title="负责人"
          hint="业务负责人对口径负责，技术负责人对产出任务负责"
          action={sectionAction('owner', saveOwner)}
        />
        {editing === 'owner' ? (
          <>
            <div className="ac-form-row">
              <div className="ac-form-group">
                <label htmlFor="ac-owner-business">业务负责人</label>
                {ownerUnavailable ? (
                  <input id="ac-owner-business" className="ac-input" value={ownerLabel(businessOwner)} readOnly />
                ) : (
                  <select
                    id="ac-owner-business"
                    className="ac-select"
                    value={businessOwner}
                    onChange={e => setBusinessOwner(e.target.value)}
                  >
                    {ownerOptionsNode(businessOwner)}
                  </select>
                )}
              </div>
              <div className="ac-form-group">
                <label htmlFor="ac-owner-tech">技术负责人</label>
                {ownerUnavailable ? (
                  <input id="ac-owner-tech" className="ac-input" value={ownerLabel(techOwner)} readOnly />
                ) : (
                  <select
                    id="ac-owner-tech"
                    className="ac-select"
                    value={techOwner}
                    onChange={e => setTechOwner(e.target.value)}
                  >
                    {ownerOptionsNode(techOwner)}
                  </select>
                )}
              </div>
            </div>
            {ownerUnavailable ? (
              <p className="ac-muted">
                <CircleAlert size={12} /> 平台用户 / 租户列表接口不可用，负责人仅可查看，暂无法重新选择。
              </p>
            ) : ownerOptions.length === 0 ? (
              <p className="ac-muted">暂无可选负责人：需存在已绑定租户的平台用户。</p>
            ) : (
              <p className="ac-muted">负责人按平台用户选择，实际保存的是该用户名下绑定的租户编码。</p>
            )}
          </>
        ) : (
          <div className="ac-readonly-row">
            <ReadonlyItem label="业务负责人" value={ownerLabel(businessOwner)} />
            <ReadonlyItem label="技术负责人" value={ownerLabel(techOwner)} />
          </div>
        )}
      </section>

      <section className="ac-section ac-section--tight ac-section--divided">
        <SectionTitle
          title="分类与可见性"
          hint="分类编码留空则按表名规范自动解析分层与业务域"
          action={sectionAction('category', saveCategory)}
        />
        {editing === 'category' ? (
          <>
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
                <input
                  id="ac-topic"
                  className="ac-input"
                  value={topic}
                  onChange={e => setTopic(e.target.value)}
                />
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
                <select
                  id="ac-level"
                  className="ac-select"
                  value={assetLevel}
                  onChange={e => setAssetLevel(e.target.value)}
                >
                  <option value="">（未定级）</option>
                  {ASSET_LEVEL_OPTIONS.map(level => (
                    <option key={level} value={level}>
                      {level}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {categoryUnavailable && (
              <p className="ac-muted">
                <CircleAlert size={12} /> 分类字典接口不可用，分类编码不是自由文本，编辑时仅可查看，避免写入服务端不认识的取值。
              </p>
            )}
          </>
        ) : (
          <>
            <div className="ac-readonly-row">
              <ReadonlyItem label="分类" value={categoryName(categoryCode)} />
              <ReadonlyItem label="主题域" value={topic || '未设置'} />
            </div>
            <div className="ac-readonly-row">
              <ReadonlyItem label="可见性" value={visibilityLabel} />
              <ReadonlyItem label="资产等级" value={assetLevel || '（未定级）'} />
            </div>
          </>
        )}
      </section>

      <section className="ac-section ac-section--tight ac-section--divided">
        <SectionTitle
          title="标签"
          hint="整体替换：提交的是最终集合"
          action={sectionAction('tags', saveTags, tagUnavailable)}
        />
        {editing === 'tags' ? (
          tagUnavailable ? (
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
          )
        ) : selectedTags.length === 0 ? (
          <p className="ac-muted">未设置标签。</p>
        ) : (
          <div className="ac-chips">
            {selectedTags.map(tag => (
              <span key={tag.tagCode} className="ac-chip ac-chip--on ac-chip--static">
                {tag.tagName}
              </span>
            ))}
          </div>
        )}
      </section>

      <section className="ac-section ac-section--tight ac-section--divided">
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
