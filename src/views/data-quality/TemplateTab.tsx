/**
 * 规则模板页签（资产管理 → 规则模板）
 *
 * ── 与「规则类型」的关系 ────────────────────────────────────
 * 内置模板即 types/quality 的 7 类规则类型，由平台预置、**只读**（服务端 assertCustom 拒绝修改内置模板）。
 * 自定义模板仍须归属 7 类之一 —— 自定义体现在 **SQL 模板**而非规则类型，否则覆盖率统计会失去口径。
 *
 * ── 接口 ────────────────────────────────────────────────────
 * | 动作       | 接口                                    |
 * | ---------- | --------------------------------------- |
 * | 内置模板   | GET  /quality/template/builtin          |
 * | 自定义分页 | GET  /quality/template                  |
 * | 新建/修改  | POST / PUT /quality/template            |
 * | 删除       | DELETE /quality/template/{id}           |
 * | SQL 预览   | POST /quality/template/preview-sql      |
 *
 * ── 校验对齐服务端 ──────────────────────────────────────────
 * 服务端 DqRuleTemplateService.validate 的硬约束，这里在提交前先行拦截（省一次往返）：
 * 1) 模板编码 / 名称 / SQL 模板非空；
 * 2) ruleType 必须是 7 类之一；
 * 3) SQL 模板必须是**单条 SELECT / WITH 查询**，不含语句分隔符（校验动作只允许读数据）。
 *
 * ── SQL 预览为什么需要选表 ──────────────────────────────────
 * 预览是把模板占位符渲染成目标方言 SQL，必须知道「对哪张表的哪个字段」才渲染得出来，
 * 因此预览弹窗内提供数据源 → 库 → 表 → 字段的选择；数据源与表清单复用既有
 * api/datasource（懒加载，仅在打开弹窗时请求）。
 */

import { useCallback, useEffect, useState } from 'react';
import { CircleAlert, Eye, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { qualityApi } from '../../api/quality';
import type { QualityTemplateSaveDTO } from '../../api/quality';
import type { QualityRuleTemplateVO } from '../../types/quality';
import { QUALITY_RULE_TYPES, getQualityRuleType } from '../../types/quality';
import { fetchAllDataSources, fetchTablesByDataSourceId } from '../../api/datasource';
import type { DataSource, TableInfo } from '../../api/datasource';
import { useToast } from '../../components/Toast';
import './DataQualityPanel.css';

const PAGE_SIZE = 10;

interface TemplateFormState {
  id?: number;
  templateCode: string;
  templateName: string;
  ruleType: string;
  fieldTypes: string;
  sqlTemplate: string;
  paramSchema: string;
  remark: string;
  enabled: boolean;
}

const emptyForm = (): TemplateFormState => ({
  templateCode: '',
  templateName: '',
  ruleType: QUALITY_RULE_TYPES[0].code,
  fieldTypes: '',
  sqlTemplate: '',
  paramSchema: '',
  remark: '',
  enabled: true,
});

const toForm = (row: QualityRuleTemplateVO): TemplateFormState => ({
  id: row.id,
  templateCode: row.templateCode,
  templateName: row.templateName,
  ruleType: row.ruleType,
  fieldTypes: row.fieldTypes ?? '',
  sqlTemplate: row.sqlTemplate ?? '',
  paramSchema: row.paramSchema ?? '',
  remark: row.remark ?? '',
  enabled: !!row.enabled,
});

/**
 * 提交前校验，与服务端 validate 对齐。
 * 返回错误文案；null 表示通过。
 */
function validateForm(form: TemplateFormState): string | null {
  if (!form.templateCode.trim()) return '模板编码不能为空';
  if (!form.templateName.trim()) return '模板名称不能为空';
  if (!form.sqlTemplate.trim()) return 'SQL 模板不能为空';
  if (!getQualityRuleType(form.ruleType)) return '模板必须归属 7 类规则类型之一';

  const sql = form.sqlTemplate.trim();
  // 语句分隔符：模板是单条查询，出现分号即视为多条语句或尾随语句
  if (sql.replace(/;+\s*$/, '').includes(';')) {
    return 'SQL 模板必须是单条 SELECT / WITH 查询，不得包含语句分隔符';
  }
  if (!/^(select|with)\b/i.test(sql)) {
    return 'SQL 模板必须是一条 SELECT / WITH 查询（校验动作只允许读取数据）';
  }
  if (form.paramSchema.trim()) {
    try {
      const parsed = JSON.parse(form.paramSchema);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return '参数定义必须是 JSON 对象，如 {"dt":"yyyyMMdd"}';
      }
    } catch {
      return '参数定义不是合法 JSON';
    }
  }
  return null;
}

const ruleTypeLabel = (code: string): string => getQualityRuleType(code)?.label ?? code;

/** SQL 单行摘要（表格里不铺整段 SQL） */
const sqlSummary = (sql: string): string => {
  const oneLine = (sql ?? '').replace(/\s+/g, ' ').trim();
  return oneLine.length > 90 ? `${oneLine.slice(0, 90)}…` : oneLine || '—';
};

// ── 表单弹窗 ────────────────────────────────────────────────

const TemplateFormModal: React.FC<{
  initial: TemplateFormState;
  saving: boolean;
  onClose: () => void;
  onSubmit: (form: TemplateFormState) => void;
}> = ({ initial, saving, onClose, onSubmit }) => {
  const [form, setForm] = useState<TemplateFormState>(initial);
  const [error, setError] = useState('');

  const submit = () => {
    const message = validateForm(form);
    if (message) {
      setError(message);
      return;
    }
    setError('');
    onSubmit(form);
  };

  const selectedType = getQualityRuleType(form.ruleType);

  return (
    <div className="dq-modal-overlay">
      <div className="dq-modal dq-modal--wide">
        <div className="dq-modal-header">
          <h3>{form.id ? '编辑自定义模板' : '新建自定义模板'}</h3>
          <button className="dq-modal-close" type="button" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="dq-modal-body">
          <div className="dq-form-row">
            <div className="dq-form-group">
              <label>
                模板编码 <span className="dq-required">*</span>
              </label>
              <input
                className="dq-input"
                aria-label="模板编码"
                value={form.templateCode}
                disabled={!!form.id}
                placeholder="如 CUSTOM_ORDER_AMT_RANGE"
                onChange={e => setForm(f => ({ ...f, templateCode: e.target.value }))}
              />
            </div>
            <div className="dq-form-group">
              <label>
                模板名称 <span className="dq-required">*</span>
              </label>
              <input
                className="dq-input"
                aria-label="模板名称"
                value={form.templateName}
                onChange={e => setForm(f => ({ ...f, templateName: e.target.value }))}
              />
            </div>
          </div>

          <div className="dq-form-row">
            <div className="dq-form-group">
              <label>
                归属规则类型 <span className="dq-required">*</span>
              </label>
              <select
                className="dq-select"
                value={form.ruleType}
                onChange={e => setForm(f => ({ ...f, ruleType: e.target.value }))}
              >
                {QUALITY_RULE_TYPES.map(t => (
                  <option key={t.code} value={t.code}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="dq-form-group">
              <label>适用字段类型</label>
              <input
                className="dq-input"
                value={form.fieldTypes}
                placeholder="逗号分隔，如 decimal,int；留空表示不限"
                onChange={e => setForm(f => ({ ...f, fieldTypes: e.target.value }))}
              />
            </div>
          </div>
          {selectedType && <p className="dq-hint">规则类型说明：{selectedType.desc}</p>}

          <div className="dq-form-group">
            <label>
              SQL 模板 <span className="dq-required">*</span>
            </label>
            <textarea
              className="dq-textarea"
              aria-label="SQL 模板"
              rows={6}
              value={form.sqlTemplate}
              placeholder={'单条 SELECT / WITH 查询，占位符用 ${xxx}，如\nSELECT COUNT(1) FROM ${table} WHERE ${column} IS NULL'}
              onChange={e => setForm(f => ({ ...f, sqlTemplate: e.target.value }))}
            />
            <p className="dq-hint">
              服务端会校验：必须是单条 SELECT / WITH 查询，且不含语句分隔符 —— 校验动作只允许读取数据。
            </p>
          </div>

          <div className="dq-form-row">
            <div className="dq-form-group">
              <label>参数定义</label>
              <input
                className="dq-input"
                value={form.paramSchema}
                placeholder='JSON 对象，如 {"dt":"yyyyMMdd"}'
                onChange={e => setForm(f => ({ ...f, paramSchema: e.target.value }))}
              />
            </div>
            <div className="dq-form-group">
              <label>备注</label>
              <input
                className="dq-input"
                value={form.remark}
                onChange={e => setForm(f => ({ ...f, remark: e.target.value }))}
              />
            </div>
          </div>

          <div className="dq-form-group">
            <label className="dq-check">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))}
              />
              <span>启用该模板</span>
            </label>
          </div>

          {error && <p className="dq-form-error">{error}</p>}
        </div>
        <div className="dq-modal-footer">
          <button className="dq-btn" type="button" onClick={onClose}>
            取消
          </button>
          <button className="dq-btn dq-btn--primary" type="button" disabled={saving} onClick={submit}>
            <Save size={13} />
            <span>{saving ? '提交中…' : '保存'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};

// ── SQL 预览弹窗 ────────────────────────────────────────────

const PreviewSqlModal: React.FC<{
  template: QualityRuleTemplateVO;
  onClose: () => void;
}> = ({ template, onClose }) => {
  const toast = useToast();
  const [dataSources, setDataSources] = useState<DataSource[]>([]);
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [datasourceId, setDatasourceId] = useState<number | ''>('');
  const [databaseName, setDatabaseName] = useState('');
  const [tableName, setTableName] = useState('');
  const [columnName, setColumnName] = useState('');
  const [paramsText, setParamsText] = useState('');
  const [sql, setSql] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // 打开弹窗才拉数据源：预览是低频动作，不必让页签挂载时就付出这次请求
  useEffect(() => {
    let cancelled = false;
    fetchAllDataSources()
      .then(res => {
        if (!cancelled) setDataSources(res?.code === 200 && res.data ? res.data : []);
      })
      .catch(() => {
        if (!cancelled) setDataSources([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (datasourceId === '') {
      setTables([]);
      return;
    }
    let cancelled = false;
    fetchTablesByDataSourceId(datasourceId)
      .then(res => {
        if (!cancelled) setTables(res?.code === 200 && res.data?.records ? res.data.records : []);
      })
      .catch(() => {
        if (!cancelled) setTables([]);
      });
    return () => {
      cancelled = true;
    };
  }, [datasourceId]);

  const databases = Array.from(
    new Set(tables.map(t => t.databaseName).filter((name): name is string => Boolean(name)))
  );

  const columns = tables.find(t => t.tableName === tableName && t.databaseName === databaseName)?.columns ?? [];

  const run = useCallback(async () => {
    if (datasourceId === '' || !databaseName || !tableName) {
      setError('请先选择数据源、库与表 —— 渲染方言 SQL 必须知道目标表');
      return;
    }
    let params: Record<string, string> | undefined;
    if (paramsText.trim()) {
      try {
        const parsed = JSON.parse(paramsText);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          setError('参数取值必须是 JSON 对象');
          return;
        }
        params = parsed as Record<string, string>;
      } catch {
        setError('参数取值不是合法 JSON');
        return;
      }
    }
    setError('');
    setLoading(true);
    try {
      const res = await qualityApi.previewSql({
        templateId: template.id,
        datasourceId: Number(datasourceId),
        databaseName,
        tableName,
        columnName: columnName || undefined,
        params,
      });
      setSql(res?.data?.sql ?? '');
    } catch (e) {
      setSql('');
      toast.error(`SQL 预览失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, [datasourceId, databaseName, tableName, columnName, paramsText, template.id, toast]);

  return (
    <div className="dq-modal-overlay">
      <div className="dq-modal dq-modal--wide">
        <div className="dq-modal-header">
          <h3>SQL 预览 · {template.templateName}</h3>
          <button className="dq-modal-close" type="button" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="dq-modal-body">
          <p className="dq-muted">模板：{template.templateCode}（{ruleTypeLabel(template.ruleType)}）</p>
          <pre className="dq-testresult__sql">{template.sqlTemplate}</pre>

          <div className="dq-form-row">
            <div className="dq-form-group">
              <label>数据源</label>
              <select
                className="dq-select"
                aria-label="数据源"
                value={datasourceId}
                onChange={e => {
                  setDatasourceId(e.target.value ? Number(e.target.value) : '');
                  setDatabaseName('');
                  setTableName('');
                  setColumnName('');
                }}
              >
                <option value="">请选择数据源</option>
                {dataSources.map(ds => (
                  <option key={ds.id} value={ds.id}>
                    {ds.datasourceName}
                  </option>
                ))}
              </select>
            </div>
            <div className="dq-form-group">
              <label>库</label>
              <select
                className="dq-select"
                aria-label="库"
                value={databaseName}
                onChange={e => {
                  setDatabaseName(e.target.value);
                  setTableName('');
                  setColumnName('');
                }}
              >
                <option value="">请选择库</option>
                {databases.map(db => (
                  <option key={db} value={db}>
                    {db}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="dq-form-row">
            <div className="dq-form-group">
              <label>表</label>
              <select
                className="dq-select"
                aria-label="表"
                value={tableName}
                onChange={e => {
                  setTableName(e.target.value);
                  setColumnName('');
                }}
              >
                <option value="">请选择表</option>
                {tables
                  .filter(t => !databaseName || t.databaseName === databaseName)
                  .map(t => (
                    <option key={`${t.databaseName}-${t.tableName}`} value={t.tableName}>
                      {t.tableName}
                    </option>
                  ))}
              </select>
            </div>
            <div className="dq-form-group">
              <label>字段（字段级规则用）</label>
              <input
                className="dq-input"
                value={columnName}
                placeholder="可留空"
                onChange={e => setColumnName(e.target.value)}
                list="dq-preview-columns"
              />
              <datalist id="dq-preview-columns">
                {columns.map(c => (
                  <option key={c.columnName} value={c.columnName} />
                ))}
              </datalist>
            </div>
          </div>

          <div className="dq-form-group">
            <label>参数取值</label>
            <input
              className="dq-input"
              aria-label="参数取值"
              value={paramsText}
              placeholder='JSON 对象，如 {"dt":"20261006"}'
              onChange={e => setParamsText(e.target.value)}
            />
          </div>

          {sql && (
            <>
              <p className="dq-section__title">渲染结果</p>
              <pre className="dq-testresult__sql">{sql}</pre>
            </>
          )}
          {error && <p className="dq-form-error">{error}</p>}
        </div>
        <div className="dq-modal-footer">
          <button className="dq-btn" type="button" onClick={onClose}>
            关闭
          </button>
          <button className="dq-btn dq-btn--primary" type="button" disabled={loading} onClick={run}>
            <Eye size={13} />
            <span>{loading ? '渲染中…' : '渲染 SQL'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};

// ── 页签主体 ────────────────────────────────────────────────

const TemplateTab: React.FC = () => {
  const toast = useToast();

  const [builtin, setBuiltin] = useState<QualityRuleTemplateVO[] | null>(null);
  const [builtinFailed, setBuiltinFailed] = useState(false);

  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState('');
  const [customKeyword, setCustomKeyword] = useState('');
  const [custom, setCustom] = useState<QualityRuleTemplateVO[]>([]);
  const [customTotal, setCustomTotal] = useState(0);
  const [customFailed, setCustomFailed] = useState(false);
  const [loadingCustom, setLoadingCustom] = useState(false);

  const [form, setForm] = useState<TemplateFormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [previewTarget, setPreviewTarget] = useState<QualityRuleTemplateVO | null>(null);
  const [pendingDelete, setPendingDelete] = useState<QualityRuleTemplateVO | null>(null);

  const loadBuiltin = useCallback(async () => {
    setBuiltinFailed(false);
    try {
      const res = await qualityApi.listBuiltinTemplates();
      setBuiltin(res?.data ?? []);
    } catch {
      setBuiltin([]);
      setBuiltinFailed(true);
    }
  }, []);

  const loadCustom = useCallback(async () => {
    setLoadingCustom(true);
    setCustomFailed(false);
    try {
      const res = await qualityApi.listTemplates({ current: page, size: PAGE_SIZE, keyword: customKeyword || undefined });
      setCustom(res?.data?.records ?? []);
      setCustomTotal(res?.data?.total ?? 0);
    } catch {
      setCustom([]);
      setCustomTotal(0);
      setCustomFailed(true);
    } finally {
      setLoadingCustom(false);
    }
  }, [page, customKeyword]);

  useEffect(() => {
    void loadBuiltin();
  }, [loadBuiltin]);

  useEffect(() => {
    void loadCustom();
  }, [loadCustom]);

  const submitForm = async (next: TemplateFormState) => {
    setSaving(true);
    const payload: QualityTemplateSaveDTO = {
      templateCode: next.templateCode.trim(),
      templateName: next.templateName.trim(),
      ruleType: next.ruleType,
      // 自定义模板：类型固定 custom，内置由平台维护，界面不提供保存入口
      templateKind: 'custom',
      sqlTemplate: next.sqlTemplate.trim(),
      fieldTypes: next.fieldTypes.trim(),
      paramSchema: next.paramSchema.trim(),
      remark: next.remark.trim(),
      enabled: next.enabled,
      ...(next.id ? { id: next.id } : {}),
    };
    try {
      if (next.id) await qualityApi.updateTemplate(payload);
      else await qualityApi.createTemplate(payload);
      toast.info(next.id ? '模板已更新' : '模板已创建');
      setForm(null);
      await loadCustom();
    } catch (e) {
      toast.error(`${next.id ? '模板更新' : '模板创建'}失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (row: QualityRuleTemplateVO) => {
    try {
      await qualityApi.updateTemplate({
        ...toForm(row),
        // 启停只可能作用在自定义模板上（内置模板界面不提供该入口），类型恒为 custom
        templateKind: 'custom',
        enabled: !row.enabled,
        id: row.id,
      });
      toast.info(row.enabled ? '模板已停用' : '模板已启用');
      await loadCustom();
    } catch (e) {
      toast.error(`模板${row.enabled ? '停用' : '启用'}失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    try {
      await qualityApi.deleteTemplate(pendingDelete.id);
      toast.info('模板已删除');
      setPendingDelete(null);
      await loadCustom();
    } catch (e) {
      toast.error(`模板删除失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const pages = Math.max(1, Math.ceil(customTotal / PAGE_SIZE));

  return (
    <div className="dq-template">


      {/* ── 内置模板（只读）── */}
      <section className="dq-section">
        <h4 className="dq-section__title">内置模板（只读）</h4>
        {builtin === null && <div className="dq-loading">加载中…</div>}
        {builtinFailed && (
          <div className="dq-placeholder">
            <div className="dq-placeholder__head">
              <CircleAlert size={14} />
              <span>服务端 /api/quality/template/builtin 尚未接入。</span>
            </div>
            <p className="dq-placeholder__lead">接口就绪后此处展示平台预置的 7 类模板与对应 SQL。</p>
          </div>
        )}
        {!builtinFailed && builtin !== null && (
          <table className="dq-table">
            <thead>
              <tr>
                <th>模板编码</th>
                <th>模板名称</th>
                <th>规则类型</th>
                <th>SQL 模板</th>
                <th>适用字段类型</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {builtin.length === 0 && (
                <tr>
                  <td colSpan={6} className="dq-table-empty">
                    暂无可展示的内置模板。
                  </td>
                </tr>
              )}
              {builtin.map(row => (
                <tr key={row.id}>
                  <td className="dq-table__strong">{row.templateCode}</td>
                  <td>{row.templateName}</td>
                  <td>
                    <span className="dq-tag dq-tag--info">{ruleTypeLabel(row.ruleType)}</span>
                  </td>
                  <td className="dq-td-ellipsis" title={row.sqlTemplate}>
                    {sqlSummary(row.sqlTemplate)}
                  </td>
                  <td>{row.fieldTypes || '不限'}</td>
                  <td className="dq-td-actions">
                    <button className="dq-btn-link" type="button" onClick={() => setPreviewTarget(row)}>
                      预览 SQL
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* ── 自定义模板（可增删改）── */}
      <section className="dq-section">
        <div className="dq-toolbar">
          <div className="dq-toolbar__lead">
            <h4 className="dq-section__title">自定义模板</h4>
            <p className="dq-muted">按现场口径维护 SQL 模板；仍归属 7 类规则类型之一。</p>
          </div>
          <div className="dq-search-bar dq-search-bar--tight">
            <input
              className="dq-input"
              placeholder="按名称 / 编码检索"
              aria-label="检索自定义模板"
              value={keyword}
              onChange={e => setKeyword(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  setPage(1);
                  setCustomKeyword(keyword.trim());
                }
              }}
            />
            <button
              className="dq-btn"
              type="button"
              onClick={() => {
                setPage(1);
                setCustomKeyword(keyword.trim());
              }}
            >
              检索
            </button>
            <button className="dq-btn" type="button" onClick={() => void loadCustom()}>
              <RefreshCw size={13} />
              <span>刷新</span>
            </button>
            <button className="dq-btn dq-btn--primary" type="button" onClick={() => setForm(emptyForm())}>
              <Plus size={13} />
              <span>新建模板</span>
            </button>
          </div>
        </div>

        {loadingCustom && <div className="dq-loading">加载中…</div>}

        {!loadingCustom && customFailed && (
          <div className="dq-placeholder">
            <div className="dq-placeholder__head">
              <CircleAlert size={14} />
              <span>服务端 /api/quality/template 尚未接入，自定义模板暂不可用。</span>
            </div>
            <p className="dq-placeholder__lead">
              接口就绪后此处可维护自定义模板：新建 / 修改 / 删除 / 启停，并渲染方言 SQL 预览。
            </p>
          </div>
        )}

        {!loadingCustom && !customFailed && (
          <>
            <table className="dq-table">
              <thead>
                <tr>
                  <th>模板编码</th>
                  <th>模板名称</th>
                  <th>规则类型</th>
                  <th>SQL 模板</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {custom.length === 0 && (
                  <tr>
                    <td colSpan={6} className="dq-table-empty">
                      暂无自定义模板。点右上「新建模板」按现场口径新增。
                    </td>
                  </tr>
                )}
                {custom.map(row => (
                  <tr key={row.id}>
                    <td className="dq-table__strong">{row.templateCode}</td>
                    <td>{row.templateName}</td>
                    <td>
                      <span className="dq-tag dq-tag--info">{ruleTypeLabel(row.ruleType)}</span>
                    </td>
                    <td className="dq-td-ellipsis" title={row.sqlTemplate}>
                      {sqlSummary(row.sqlTemplate)}
                    </td>
                    <td>
                      <span className={`dq-tag ${row.enabled ? 'dq-tag--success' : 'dq-tag--default'}`}>
                        {row.enabled ? '启用' : '停用'}
                      </span>
                    </td>
                    <td className="dq-td-actions">
                      <button className="dq-btn-link" type="button" onClick={() => setPreviewTarget(row)}>
                        预览 SQL
                      </button>
                      <button className="dq-btn-link" type="button" onClick={() => setForm(toForm(row))}>
                        编辑
                      </button>
                      <button className="dq-btn-link" type="button" onClick={() => void toggleEnabled(row)}>
                        {row.enabled ? '停用' : '启用'}
                      </button>
                      <button className="dq-btn-link dq-btn-link--danger" type="button" onClick={() => setPendingDelete(row)}>
                        删除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {customTotal > PAGE_SIZE && (
              <div className="dq-pagination">
                <button className="dq-btn" type="button" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
                  上一页
                </button>
                <span className="dq-muted">
                  第 {page} / {pages} 页 · 共 {customTotal} 条
                </span>
                <button className="dq-btn" type="button" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>
                  下一页
                </button>
              </div>
            )}
          </>
        )}
      </section>

      {form && (
        <TemplateFormModal
          initial={form}
          saving={saving}
          onClose={() => setForm(null)}
          onSubmit={submitForm}
        />
      )}

      {previewTarget && <PreviewSqlModal template={previewTarget} onClose={() => setPreviewTarget(null)} />}

      {pendingDelete && (
        <div className="dq-modal-overlay">
          <div className="dq-modal dq-modal--sm">
            <div className="dq-modal-header">
              <h3>删除模板</h3>
              <button className="dq-modal-close" type="button" onClick={() => setPendingDelete(null)}>
                ×
              </button>
            </div>
            <div className="dq-modal-body">
              <p className="dq-muted">
                确认删除模板「{pendingDelete.templateName}」（{pendingDelete.templateCode}）？
                已引用该模板的规则会失去模板关联，但规则本身不会被删除。
              </p>
            </div>
            <div className="dq-modal-footer">
              <button className="dq-btn" type="button" onClick={() => setPendingDelete(null)}>
                取消
              </button>
              <button className="dq-btn dq-btn--danger" type="button" onClick={confirmDelete}>
                <Trash2 size={13} />
                <span>确认删除</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default TemplateTab;
