import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeftRight,
  ChevronLeft,
  ChevronRight,
  Eye,
  History,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Square,
  Trash2,
  Workflow,
  X,
} from 'lucide-react';
import { useToast } from '../../components/Toast';
import dataIntegrationApi from '../../api/dataIntegration';
import { fetchProjectList } from '../../api/devProject';
import type { ProjectInfo } from '../../api/devProject';
import { useAuth } from '../../contexts/AuthContext';
import type {
  IntegrationOptionsVO,
  IntegrationSubmitLogVO,
  IntegrationTableVO,
  IntegrationTaskDTO,
  IntegrationTaskStatusVO,
  IntegrationTaskVO,
} from '../../api/dataIntegration';
import './DataIntegrationPanel.css';

const STATUS_CLASS: Record<string, string> = {
  DRAFT: 'di-status--draft',
  PUBLISHED: 'di-status--published',
  RUNNING: 'di-status--running',
  FAILED: 'di-status--failed',
  OFFLINE: 'di-status--offline',
};

const ACTION_LABEL: Record<string, string> = {
  SUBMIT: '上线',
  OFFLINE: '下线',
  STATUS: '状态同步',
};

function formatTime(value?: string | null): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}

function typeLabel(options: IntegrationOptionsVO | null, type: string): string {
  const found = [...(options?.sourceTypes || []), ...(options?.targetTypes || [])]
    .find(item => item.code === type);
  return found?.label || type;
}

const StatusBadge: React.FC<{ status: string; label?: string }> = ({ status, label }) => (
  <span className={`di-status ${STATUS_CLASS[status] || ''}`}>{label || status}</span>
);

// ------------------------------------------------------------------ 动态连接参数表单

const DynamicFields: React.FC<{
  fields: { key: string; label: string; required: boolean; placeholder: string; type: string }[];
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}> = ({ fields, value, onChange }) => {
  if (fields.length === 0) {
    return <div className="di-form__hint">请选择类型后填写连接参数</div>;
  }
  const setField = (key: string, next: string) => onChange({ ...value, [key]: next });
  return (
    <div className="di-form__grid">
      {fields.map(field => {
        const wide = field.type === 'textarea';
        return (
          <label key={field.key} className={`di-field ${wide ? 'di-field--wide' : ''}`}>
            <span className="di-field__label">
              {field.label}
              {field.required && <em className="di-field__required">*</em>}
            </span>
            {field.type === 'textarea' ? (
              <textarea
                className="di-input di-textarea"
                rows={2}
                value={value[field.key] ?? ''}
                placeholder={field.placeholder}
                onChange={e => setField(field.key, e.target.value)}
              />
            ) : (
              <input
                className="di-input"
                type={field.type === 'password' ? 'password' : 'text'}
                value={value[field.key] ?? ''}
                placeholder={field.placeholder}
                onChange={e => setField(field.key, e.target.value)}
              />
            )}
          </label>
        );
      })}
    </div>
  );
};

// ------------------------------------------------------------------ 额外参数编辑器

interface ParamRow {
  key: string;
  value: string;
}

const ParamsEditor: React.FC<{
  rows: ParamRow[];
  jsonText: string;
  mode: 'kv' | 'json';
  onRowsChange: (rows: ParamRow[]) => void;
  onJsonChange: (text: string) => void;
  onModeChange: (mode: 'kv' | 'json') => void;
}> = ({ rows, jsonText, mode, onRowsChange, onJsonChange, onModeChange }) => {
  const switchMode = (next: 'kv' | 'json') => {
    if (next === mode) return;
    if (next === 'json') {
      const obj: Record<string, string> = {};
      rows.forEach(row => {
        if (row.key.trim()) obj[row.key.trim()] = row.value;
      });
      onJsonChange(JSON.stringify(obj, null, 2));
    } else {
      try {
        const parsed = JSON.parse(jsonText || '{}') as Record<string, unknown>;
        const nextRows = Object.entries(parsed).map(([key, value]) => ({
          key,
          value: value === null || value === undefined ? '' : String(value),
        }));
        onRowsChange(nextRows.length > 0 ? nextRows : [{ key: '', value: '' }]);
      } catch {
        // JSON 不合法时保持原 key-value 不变，避免清空用户输入
      }
    }
    onModeChange(next);
  };

  return (
    <div className="di-params">
      <div className="di-params__modes">
        <button
          type="button"
          className={`di-chip ${mode === 'kv' ? 'di-chip--active' : ''}`}
          onClick={() => switchMode('kv')}
        >
          键值对
        </button>
        <button
          type="button"
          className={`di-chip ${mode === 'json' ? 'di-chip--active' : ''}`}
          onClick={() => switchMode('json')}
        >
          JSON
        </button>
        <span className="di-form__hint">
          透传给集群，写入 Flink 作业 SET 项
        </span>
      </div>
      {mode === 'kv' ? (
        <div className="di-params__rows">
          {rows.map((row, index) => (
            <div key={index} className="di-params__row">
              <input
                className="di-input"
                placeholder="参数名，如 pipeline.name"
                value={row.key}
                onChange={e => {
                  const next = [...rows];
                  next[index] = { ...row, key: e.target.value };
                  onRowsChange(next);
                }}
              />
              <input
                className="di-input"
                placeholder="参数值"
                value={row.value}
                onChange={e => {
                  const next = [...rows];
                  next[index] = { ...row, value: e.target.value };
                  onRowsChange(next);
                }}
              />
              <button
                type="button"
                className="di-btn di-btn--ghost di-btn--icon"
                title="删除该参数"
                onClick={() => onRowsChange(rows.filter((_, i) => i !== index))}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="di-btn di-btn--ghost di-btn--xs"
            onClick={() => onRowsChange([...rows, { key: '', value: '' }])}
          >
            <Plus size={12} /> 添加参数
          </button>
        </div>
      ) : (
        <textarea
          className="di-input di-textarea di-params__json"
          rows={6}
          value={jsonText}
          onChange={e => onJsonChange(e.target.value)}
          placeholder='{"pipeline.name": "di_demo"}'
        />
      )}
    </div>
  );
};

// ------------------------------------------------------------------ 任务编辑弹窗

let uidSeq = 1;
const nextUid = () => `u${uidSeq++}`;

/** 需要同步的一张表（表单态，排除字段以逗号分隔文本编辑） */
interface TableForm {
  uid: string;
  sourceTable: string;
  excludeColumnsText: string;
}

interface FormState {
  id?: number;
  taskName: string;
  taskCode: string;
  description: string;
  /** 所属项目（dev_project.id），上线时其项目编码作为数据血缘 namespace */
  projectId: number | '';
  clusterType: string;
  jobMode: string;
  triggerType: string;
  triggerConfig: string;
  sourceType: string;
  sourceConfig: Record<string, string>;
  targetType: string;
  targetConfig: Record<string, string>;
  tables: TableForm[];
  readParallelism: number;
  writeParallelism: number;
  paramMode: 'kv' | 'json';
  paramRows: ParamRow[];
  paramJson: string;
}

const emptyTable = (): TableForm => ({ uid: nextUid(), sourceTable: '', excludeColumnsText: '' });

function toTableForm(table: IntegrationTableVO): TableForm {
  return {
    uid: nextUid(),
    sourceTable: table.sourceTable || '',
    excludeColumnsText: (table.excludeColumns || []).join(', '),
  };
}

/** 逗号分隔文本 → 去空、去重（忽略大小写）的字段列表 */
function parseColumns(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  text.split(',').forEach(part => {
    const name = part.trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    result.push(name);
  });
  return result;
}

const TaskEditor: React.FC<{
  options: IntegrationOptionsVO;
  task: IntegrationTaskVO | null;
  onClose: () => void;
  onSaved: () => void;
}> = ({ options, task, onClose, onSaved }) => {
  const toast = useToast();
  const { user } = useAuth();
  const [saving, setSaving] = useState(false);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectError, setProjectError] = useState<string | null>(null);

  const [form, setForm] = useState<FormState>(() => {
    if (task) {
      const extra = task.extraParams || {};
      return {
        id: task.id,
        taskName: task.taskName,
        taskCode: task.taskCode,
        description: task.description || '',
        projectId: task.projectId ?? '',
        clusterType: task.clusterType,
        jobMode: task.jobMode || 'BATCH',
        triggerType: task.triggerType || 'MANUAL',
        triggerConfig: task.triggerConfig || '',
        sourceType: task.sourceType,
        sourceConfig: toStringRecord(task.sourceConfig),
        targetType: task.targetType,
        targetConfig: toStringRecord(task.targetConfig),
        tables: task.tables && task.tables.length > 0
          ? task.tables.map(toTableForm)
          : [emptyTable()],
        readParallelism: task.readParallelism || 1,
        writeParallelism: task.writeParallelism || 1,
        paramMode: 'kv',
        paramRows: Object.entries(extra).map(([key, value]) => ({
          key,
          value: value === null || value === undefined ? '' : String(value),
        })),
        paramJson: JSON.stringify(extra, null, 2),
      };
    }
    return {
      taskName: '',
      taskCode: '',
      description: '',
      projectId: '',
      clusterType: options.clusterTypes[0]?.code || 'flink-standalone',
      jobMode: 'BATCH',
      triggerType: 'MANUAL',
      triggerConfig: '',
      sourceType: options.sourceTypes[0]?.code || 'mysql',
      sourceConfig: {},
      targetType: options.targetTypes[0]?.code || 'mysql',
      targetConfig: {},
      tables: [emptyTable()],
      readParallelism: 1,
      writeParallelism: 1,
      paramMode: 'kv',
      paramRows: [{ key: '', value: '' }],
      paramJson: '{}',
    };
  });

  // 参数行少于一行时给一个空行，避免无法输入
  useEffect(() => {
    if (form.paramMode === 'kv' && form.paramRows.length === 0) {
      setForm(prev => ({ ...prev, paramRows: [{ key: '', value: '' }] }));
    }
  }, [form.paramMode, form.paramRows.length]);

  // 项目下拉与「开发助手」共用 /development/project/list：后端不做用户过滤，
  // 这里按登录用户的 projectCodes 收敛可见范围（超管全量），与开发助手项目列表一致。
  useEffect(() => {
    let active = true;
    setProjectsLoading(true);
    setProjectError(null);
    fetchProjectList({ current: 1, size: 100 })
      .then(res => {
        if (!active) return;
        if (res.code !== 200) throw new Error(res.message || '获取项目列表失败');
        setProjects(res.data?.records || []);
      })
      .catch(e => {
        if (active) setProjectError(e instanceof Error ? e.message : '获取项目列表失败');
      })
      .finally(() => {
        if (active) setProjectsLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const visibleProjects = useMemo(() => {
    if (user?.isSuperAdmin) return projects;
    const allowed = user?.projectCodes;
    if (!allowed || allowed.length === 0) return [];
    return projects.filter(project =>
      allowed.some(pc => pc.projectCode === project.projectCode)
    );
  }, [projects, user?.isSuperAdmin, user?.projectCodes]);

  const sourceTypeMeta = options.sourceTypes.find(item => item.code === form.sourceType);
  const targetTypeMeta = options.targetTypes.find(item => item.code === form.targetType);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm(prev => ({ ...prev, [key]: value }));

  const patchTable = (uid: string, patch: Partial<TableForm>) =>
    setForm(prev => ({
      ...prev,
      tables: prev.tables.map(item => (item.uid === uid ? { ...item, ...patch } : item)),
    }));

  const addTable = () => setForm(prev => ({ ...prev, tables: [...prev.tables, emptyTable()] }));

  const removeTable = (uid: string) =>
    setForm(prev => (
      prev.tables.length <= 1
        ? prev
        : { ...prev, tables: prev.tables.filter(item => item.uid !== uid) }
    ));

  const resolveExtraParams = (): Record<string, unknown> | null => {
    if (form.paramMode === 'json') {
      try {
        const parsed = JSON.parse(form.paramJson || '{}');
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          toast.error('额外参数 JSON 必须是对象');
          return null;
        }
        return parsed as Record<string, unknown>;
      } catch (e) {
        toast.error(`额外参数 JSON 解析失败：${(e as Error).message}`);
        return null;
      }
    }
    const result: Record<string, unknown> = {};
    form.paramRows.forEach(row => {
      const key = row.key.trim();
      if (key) result[key] = row.value;
    });
    return result;
  };

  const pickConfig = (config: Record<string, string>, fields: { key: string }[]) => {
    const result: Record<string, string> = {};
    fields.forEach(field => {
      const value = config[field.key];
      if (value !== undefined && String(value).trim() !== '') {
        result[field.key] = String(value).trim();
      }
    });
    return result;
  };

  const handleSave = async () => {
    if (!form.taskName.trim()) {
      toast.error('任务名称不能为空');
      return;
    }
    if (!form.projectId) {
      toast.error('请选择所属项目（项目编码将作为数据血缘 namespace）');
      return;
    }
    if (!form.targetType) {
      toast.error('请选择目标端类型');
      return;
    }

    const missing: string[] = [];
    (sourceTypeMeta?.readFields || []).forEach(field => {
      if (field.required && !String(form.sourceConfig[field.key] || '').trim()) {
        missing.push(`源端-${field.label}`);
      }
    });
    (targetTypeMeta?.writeFields || []).forEach(field => {
      if (field.required && !String(form.targetConfig[field.key] || '').trim()) {
        missing.push(`目标端-${field.label}`);
      }
    });
    if (missing.length > 0) {
      toast.error(`请填写必填参数：${missing.join('、')}`);
      return;
    }

    if (form.tables.length === 0) {
      toast.error('至少需要配置一张需要同步的表');
      return;
    }
    const tables = form.tables.map(item => ({
      sourceTable: item.sourceTable.trim(),
      excludeColumns: parseColumns(item.excludeColumnsText),
    }));
    const seenTables = new Set<string>();
    for (let i = 0; i < tables.length; i++) {
      const table = tables[i].sourceTable;
      if (!table) {
        toast.error(`第 ${i + 1} 行的源表不能为空`);
        return;
      }
      // 表清单前缀语义随源端类型不同：库名（MySQL/PG/OceanBase）/ schema（SQL Server/Db2）/ 不允许前缀（Oracle）
      const dot = table.indexOf('.');
      const configuredDb = String(form.sourceConfig.database || '').trim();
      if (dot >= 0) {
        const prefix = table.slice(0, dot).trim();
        const tablePart = table.slice(dot + 1).trim();
        if (!tablePart) {
          toast.error(`第 ${i + 1} 行源表「${table}」缺少表名`);
          return;
        }
        if (form.sourceType === 'oracle') {
          toast.error(`第 ${i + 1} 行源表「${table}」不要带前缀，Oracle 的 schema 请在源端配置里填写`);
          return;
        }
        if ((form.sourceType === 'mysql' || form.sourceType === 'postgresql' || form.sourceType === 'oceanbase'
            || form.sourceType === 'mongodb' || form.sourceType === 'tidb')
            && configuredDb && prefix.toLowerCase() !== configuredDb.toLowerCase()) {
          toast.error(`第 ${i + 1} 行源表「${table}」的库名与源端数据库「${configuredDb}」不一致，请只填表名`);
          return;
        }
      }
      const normalized = table.toLowerCase();
      if (seenTables.has(normalized)) {
        toast.error(`源表「${table}」重复配置，请只保留一条`);
        return;
      }
      seenTables.add(normalized);
    }

    const extraParams = resolveExtraParams();
    if (!extraParams) return;

    const payload: IntegrationTaskDTO = {
      id: form.id,
      taskName: form.taskName.trim(),
      taskCode: form.taskCode.trim() || undefined,
      description: form.description.trim(),
      projectId: Number(form.projectId),
      sourceType: form.sourceType,
      sourceConfig: pickConfig(form.sourceConfig, sourceTypeMeta?.readFields || []),
      targetType: form.targetType,
      targetConfig: pickConfig(form.targetConfig, targetTypeMeta?.writeFields || []),
      tables: tables.map((item, index) => ({ ...item, sortNo: index })),
      clusterType: form.clusterType,
      readParallelism: Number(form.readParallelism) || 1,
      writeParallelism: Number(form.writeParallelism) || 1,
      jobMode: form.jobMode,
      triggerType: form.triggerType,
      triggerConfig: form.triggerType === 'CRON' ? form.triggerConfig : '',
      extraParams,
    };

    setSaving(true);
    try {
      if (form.id) {
        await dataIntegrationApi.update(payload);
      } else {
        await dataIntegrationApi.create(payload);
      }
      toast.info(form.id ? '任务已保存，重新上线后生效' : '任务已创建（草稿）');
      onSaved();
      onClose();
    } catch {
      // 错误已由全局 apiErrorHandler 提示
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="di-modal-overlay" onClick={onClose}>
      <div className="di-modal di-modal--editor" onClick={e => e.stopPropagation()}>
        <div className="di-modal__header">
          <div className="di-modal__title">
            <Workflow size={16} />
            <span>{form.id ? '编辑数据集成任务' : '新建数据集成任务'}</span>
          </div>
          <button className="di-btn di-btn--ghost di-btn--icon" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="di-modal__body">
          <section className="di-section">
            <h4 className="di-section__title">基本信息</h4>
            <div className="di-form__grid">
              <label className="di-field">
                <span className="di-field__label">
                  任务名称<em className="di-field__required">*</em>
                </span>
                <input
                  className="di-input"
                  value={form.taskName}
                  placeholder="如：订单库同步到数仓"
                  onChange={e => set('taskName', e.target.value)}
                />
              </label>
              <label className="di-field">
                <span className="di-field__label">任务编码</span>
                <input
                  className="di-input"
                  value={form.taskCode}
                  placeholder="留空自动生成"
                  onChange={e => set('taskCode', e.target.value)}
                />
              </label>
              <label className="di-field">
                <span className="di-field__label">
                  运行集群<em className="di-field__required">*</em>
                </span>
                <select
                  className="di-input di-select"
                  value={form.clusterType}
                  onChange={e => set('clusterType', e.target.value)}
                >
                  {options.clusterTypes.map(item => (
                    <option key={item.code} value={item.code}>{item.label}</option>
                  ))}
                </select>
              </label>
              <label className="di-field">
                <span className="di-field__label">作业模式</span>
                <select
                  className="di-input di-select"
                  value={form.jobMode}
                  onChange={e => set('jobMode', e.target.value)}
                >
                  {options.jobModes.map(item => (
                    <option key={item.code} value={item.code}>{item.label}</option>
                  ))}
                </select>
              </label>
              <label className="di-field">
                <span className="di-field__label">触发方式</span>
                <select
                  className="di-input di-select"
                  value={form.triggerType}
                  onChange={e => set('triggerType', e.target.value)}
                >
                  {options.triggerTypes.map(item => (
                    <option key={item.code} value={item.code}>{item.label}</option>
                  ))}
                </select>
              </label>
              {form.triggerType === 'CRON' && (
                <label className="di-field">
                  <span className="di-field__label">Cron 表达式</span>
                  <input
                    className="di-input"
                    value={form.triggerConfig}
                    placeholder="0 0 2 * * ?"
                    onChange={e => set('triggerConfig', e.target.value)}
                  />
                </label>
              )}
              <label className="di-field">
                <span className="di-field__label">
                  所属项目<em className="di-field__required">*</em>
                </span>
                <select
                  className="di-input di-select"
                  value={form.projectId}
                  disabled={projectsLoading}
                  onChange={e => set('projectId', e.target.value ? Number(e.target.value) : '')}
                >
                  <option value="">
                    {projectsLoading
                      ? '加载中...'
                      : visibleProjects.length === 0
                        ? '暂无可选项目'
                        : '请选择所属项目'}
                  </option>
                  {form.projectId !== '' && !visibleProjects.some(item => item.id === form.projectId) && (
                    <option value={form.projectId}>
                      {task?.projectName || task?.projectCode || `项目#${form.projectId}`}（当前不可见）
                    </option>
                  )}
                  {visibleProjects.map(item => (
                    <option key={item.id} value={item.id}>
                      {item.projectName}（{item.projectCode}）
                    </option>
                  ))}
                </select>
                <span className={`di-form__hint ${form.id && !form.projectId ? 'di-form__hint--warn' : ''}`}>
                  {form.id && !form.projectId
                    ? '该历史任务未记录所属项目，请补齐后再保存/上线'
                    : projectError || '项目列表与开发助手一致；项目编码将作为血缘 namespace'}
                </span>
              </label>
              <label className="di-field di-field--wide">
                <span className="di-field__label">描述</span>
                <textarea
                  className="di-input di-textarea"
                  rows={2}
                  value={form.description}
                  placeholder="任务用途、口径说明等"
                  onChange={e => set('description', e.target.value)}
                />
              </label>
            </div>
          </section>

          <section className="di-section">
            <h4 className="di-section__title">
              源端配置
              <select
                className="di-input di-select di-section__select"
                value={form.sourceType}
                onChange={e => {
                  set('sourceType', e.target.value);
                  set('sourceConfig', {});
                }}
              >
                {options.sourceTypes.map(item => (
                  <option key={item.code} value={item.code}>{item.label}</option>
                ))}
              </select>
            </h4>
            <DynamicFields
              fields={sourceTypeMeta?.readFields || []}
              value={form.sourceConfig}
              onChange={next => set('sourceConfig', next)}
            />
          </section>

          <section className="di-section">
            <h4 className="di-section__title">
              目标端配置
              <select
                className="di-input di-select di-section__select"
                value={form.targetType}
                onChange={e => {
                  set('targetType', e.target.value);
                  set('targetConfig', {});
                }}
              >
                {options.targetTypes.map(item => (
                  <option key={item.code} value={item.code}>{item.label}</option>
                ))}
              </select>
            </h4>
            <DynamicFields
              fields={targetTypeMeta?.writeFields || []}
              value={form.targetConfig}
              onChange={next => set('targetConfig', next)}
            />
          </section>

          <section className="di-section">
            <h4 className="di-section__title">
              需要同步的表（{form.tables.length}）
              <span className="di-section__hint">
                目标标识由服务端按命名模板推导，无需逐表配置
              </span>
              <button type="button" className="di-btn di-btn--secondary di-btn--xs" onClick={addTable}>
                <Plus size={12} /> 添加表
              </button>
            </h4>
            <div className="di-tables">
              <div className="di-tables__head">
                <span />
                <span>
                  {form.sourceType === 'sqlserver' || form.sourceType === 'db2'
                    ? '源表名（可填 schema.表名）'
                    : form.sourceType === 'oracle'
                      ? '源表名（schema 由源端配置决定）'
                      : form.sourceType === 'mongodb'
                        ? '集合名（库名由源端数据库决定）'
                        : '源表名（库名由源端数据库决定）'}
                </span>
                <span>排除字段（逗号分隔，可留空）</span>
                <span />
              </div>
              {form.tables.map((table, index) => (
                <div key={table.uid} className="di-tables__row">
                  <span className="di-tables__index">{index + 1}</span>
                  <input
                    className="di-input"
                    value={table.sourceTable}
                    placeholder={form.sourceType === 'sqlserver' || form.sourceType === 'db2' ? '如 dbo.orders' : '如 orders'}
                    onChange={e => patchTable(table.uid, { sourceTable: e.target.value })}
                  />
                  <input
                    className="di-input"
                    value={table.excludeColumnsText}
                    placeholder="如 id, create_time"
                    onChange={e => patchTable(table.uid, { excludeColumnsText: e.target.value })}
                  />
                  <button
                    type="button"
                    className="di-btn di-btn--ghost di-btn--icon"
                    title={form.tables.length <= 1 ? '至少保留一张表' : '删除该表'}
                    disabled={form.tables.length <= 1}
                    onClick={() => removeTable(table.uid)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          </section>

          <section className="di-section">
            <h4 className="di-section__title">读写并行度</h4>
            <div className="di-form__grid">
              <label className="di-field">
                <span className="di-field__label">读并行度</span>
                <input
                  className="di-input"
                  type="number"
                  min={1}
                  value={form.readParallelism}
                  onChange={e => set('readParallelism', Number(e.target.value))}
                />
              </label>
              <label className="di-field">
                <span className="di-field__label">写并行度</span>
                <input
                  className="di-input"
                  type="number"
                  min={1}
                  value={form.writeParallelism}
                  onChange={e => set('writeParallelism', Number(e.target.value))}
                />
              </label>
            </div>
          </section>

          <section className="di-section">
            <h4 className="di-section__title">其他参数（动态透传）</h4>
            <ParamsEditor
              rows={form.paramRows}
              jsonText={form.paramJson}
              mode={form.paramMode}
              onRowsChange={rows => set('paramRows', rows)}
              onJsonChange={text => set('paramJson', text)}
              onModeChange={mode => set('paramMode', mode)}
            />
          </section>
        </div>
        <div className="di-modal__footer">
          <button className="di-btn di-btn--secondary" onClick={onClose}>取消</button>
          <button className="di-btn di-btn--primary" disabled={saving} onClick={handleSave}>
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ------------------------------------------------------------------ 日志弹窗

const LogModal: React.FC<{ logId: number; onClose: () => void }> = ({ logId, onClose }) => {
  const [log, setLog] = useState<IntegrationSubmitLogVO | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    dataIntegrationApi.logDetail(logId)
      .then(res => {
        if (alive) setLog(res.data);
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [logId]);

  return (
    <div className="di-modal-overlay" onClick={onClose}>
      <div className="di-modal di-modal--log" onClick={e => e.stopPropagation()}>
        <div className="di-modal__header">
          <div className="di-modal__title">
            <History size={16} />
            <span>提交日志 #{logId}</span>
          </div>
          <button className="di-btn di-btn--ghost di-btn--icon" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="di-modal__body">
          {loading ? (
            <div className="di-empty">加载中...</div>
          ) : !log ? (
            <div className="di-empty">日志不存在</div>
          ) : (
            <>
              <div className="di-log__meta">
                <span>{ACTION_LABEL[log.action] || log.action}</span>
                <span className={log.resultStatus === 'SUCCESS' ? 'di-text--ok' : 'di-text--error'}>
                  {log.resultStatus}
                </span>
                <span>jobId: {log.jobId || '-'}</span>
                <span>耗时: {log.durationMs ?? '-'} ms</span>
              </div>
              {log.errorMessage && (
                <div className="di-alert di-alert--error">{log.errorMessage}</div>
              )}
              <pre className="di-log__content">{log.logContent || '（本次操作没有输出）'}</pre>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

// ------------------------------------------------------------------ 详情 / 运维抽屉

const DetailDrawer: React.FC<{
  taskId: number;
  options: IntegrationOptionsVO | null;
  onClose: () => void;
  onChanged: () => void;
  onEdit: (task: IntegrationTaskVO) => void;
}> = ({ taskId, options, onClose, onChanged, onEdit }) => {
  const toast = useToast();
  const [detail, setDetail] = useState<IntegrationTaskVO | null>(null);
  const [logs, setLogs] = useState<IntegrationSubmitLogVO[]>([]);
  const [statusInfo, setStatusInfo] = useState<IntegrationTaskStatusVO | null>(null);
  const [logId, setLogId] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [detailRes, logRes] = await Promise.all([
        dataIntegrationApi.getById(taskId),
        dataIntegrationApi.logs(taskId, 20),
      ]);
      setDetail(detailRes.data);
      setLogs(logRes.data || []);
    } catch {
      // 全局错误提示已处理
    }
  }, [taskId]);

  useEffect(() => {
    load();
  }, [load]);

  const runAction = async (action: 'submit' | 'offline' | 'status') => {
    setBusy(action);
    try {
      if (action === 'submit') {
        const res = await dataIntegrationApi.submit(taskId);
        toast.info(res.data.message || '已上线');
      } else if (action === 'offline') {
        const res = await dataIntegrationApi.offline(taskId);
        toast.info(res.data.message || '已下线');
      } else {
        const res = await dataIntegrationApi.status(taskId);
        setStatusInfo(res.data);
        if (!res.data.clusterReachable) {
          toast.warning(res.data.message || '集群不可达，展示为最后一次已知状态');
        } else {
          toast.info(res.data.message || '状态已刷新');
        }
      }
      await load();
      onChanged();
    } catch {
      await load();
      onChanged();
    } finally {
      setBusy(null);
    }
  };

  const status = detail?.status || '';
  const canSubmit = status !== 'PUBLISHED' && status !== 'RUNNING';
  const canOffline = status !== 'DRAFT' && status !== 'OFFLINE';

  return (
    <aside className="di-drawer">
      <div className="di-drawer__header">
        <div>
          <div className="di-drawer__title">{detail?.taskName || '加载中...'}</div>
          <div className="di-drawer__code">{detail?.taskCode}</div>
        </div>
        <button className="di-btn di-btn--ghost di-btn--icon" onClick={onClose}>
          <X size={16} />
        </button>
      </div>

      {detail && (
        <div className="di-drawer__body">
          <div className="di-drawer__status">
            <StatusBadge status={detail.status} label={detail.statusLabel} />
            {detail.jobId && <span className="di-drawer__job">jobId: {detail.jobId}</span>}
            {detail.lastError && (
              <span className="di-drawer__error" title={detail.lastError}>
                <AlertTriangle size={12} /> {detail.lastError}
              </span>
            )}
          </div>

          <div className="di-drawer__actions">
            <button
              className="di-btn di-btn--success di-btn--xs"
              disabled={!canSubmit || busy !== null}
              title={canSubmit ? '提交到集群' : '已上线/运行中，请先下线'}
              onClick={() => runAction('submit')}
            >
              <Play size={12} /> 上线
            </button>
            <button
              className="di-btn di-btn--warning di-btn--xs"
              disabled={!canOffline || busy !== null}
              title={canOffline ? '从集群取消/停止作业' : '任务未上线或已下线'}
              onClick={() => runAction('offline')}
            >
              <Square size={12} /> 下线
            </button>
            <button
              className="di-btn di-btn--secondary di-btn--xs"
              disabled={busy !== null}
              onClick={() => runAction('status')}
            >
              <RefreshCw size={12} /> 刷新状态
            </button>
            <button className="di-btn di-btn--ghost di-btn--xs" onClick={() => onEdit(detail)}>
              <Pencil size={12} /> 编辑参数
            </button>
          </div>

          {statusInfo && (
            <div className={`di-alert ${statusInfo.clusterReachable ? 'di-alert--info' : 'di-alert--error'}`}>
              {statusInfo.message}
              {statusInfo.clusterStatus ? `（集群状态：${statusInfo.clusterStatus}）` : ''}
            </div>
          )}

          <section className="di-drawer__section">
            <h5>基本信息</h5>
            <dl className="di-meta">
              <div><dt>运行集群</dt><dd>{detail.clusterType}</dd></div>
              <div>
                <dt>所属项目</dt>
                <dd>
                  {detail.projectId ? (
                    <>
                      {detail.projectName || detail.projectCode}
                      {detail.projectName && detail.projectCode ? `（${detail.projectCode}）` : ''}
                    </>
                  ) : (
                    <span className="di-form__hint di-form__hint--warn">未设置（请编辑任务补齐，否则无法上线）</span>
                  )}
                </dd>
              </div>
              <div><dt>作业模式</dt><dd>{detail.jobMode}</dd></div>
              <div><dt>触发方式</dt><dd>{detail.triggerType}{detail.triggerConfig ? `（${detail.triggerConfig}）` : ''}</dd></div>
              <div><dt>并行度</dt><dd>读 {detail.readParallelism} / 写 {detail.writeParallelism}</dd></div>
              <div><dt>最后上线</dt><dd>{formatTime(detail.lastSubmitTime)}</dd></div>
              <div><dt>最后下线</dt><dd>{formatTime(detail.lastOfflineTime)}</dd></div>
              <div><dt>更新时间</dt><dd>{formatTime(detail.updateTime)}</dd></div>
            </dl>
          </section>

          <section className="di-drawer__section">
            <h5>
              表映射
              <span className="di-section__hint">
                {detail.tables?.length ? `${detail.tables.length} 张表` : '未配置表'}
              </span>
            </h5>
            <div className="di-flow">
              <span className="di-flow__node">
                {typeLabel(options, detail.sourceType)}
                <em>源端连接</em>
              </span>
              <ArrowLeftRight size={14} />
              <span className="di-flow__node">
                {typeLabel(options, detail.targetType)}
                <em>目标端连接</em>
              </span>
            </div>
            {!detail.tables || detail.tables.length === 0 ? (
              <div className="di-empty">尚未配置需要同步的表</div>
            ) : (
              <table className="di-map-table">
                <thead>
                  <tr>
                    <th>源表</th>
                    <th>排除字段</th>
                    <th>目标标识</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.tables.map((table, index) => (
                    <tr key={table.id ?? `${table.sourceTable}-${index}`}>
                      <td>{table.sourceTable || '-'}</td>
                      <td>{table.excludeColumns?.length ? table.excludeColumns.join(', ') : '-'}</td>
                      <td className="di-map-table__target">{table.targetIdentifier || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <details className="di-config__block">
              <summary className="di-config__summary">
                连接参数（源端 {typeLabel(options, detail.sourceType)} / 目标端{' '}
                {typeLabel(options, detail.targetType)}）
              </summary>
              <div className="di-config__label">源端参数</div>
              <pre className="di-config__pre">{JSON.stringify(detail.sourceConfig, null, 2)}</pre>
              <div className="di-config__label">目标端参数</div>
              <pre className="di-config__pre">{JSON.stringify(detail.targetConfig, null, 2)}</pre>
            </details>
          </section>

          <section className="di-drawer__section">
            <h5>额外参数</h5>
            <pre className="di-config__pre">{JSON.stringify(detail.extraParams || {}, null, 2)}</pre>
          </section>

          <section className="di-drawer__section">
            <h5>提交历史</h5>
            {logs.length === 0 ? (
              <div className="di-empty">暂无提交记录</div>
            ) : (
              <div className="di-history">
                {logs.map(log => (
                  <button key={log.id} className="di-history__item" onClick={() => setLogId(log.id)}>
                    <span className={`di-history__dot di-history__dot--${log.resultStatus.toLowerCase()}`} />
                    <span className="di-history__action">{ACTION_LABEL[log.action] || log.action}</span>
                    <span className={log.resultStatus === 'SUCCESS' ? 'di-text--ok' : 'di-text--error'}>
                      {log.resultStatus === 'SUCCESS' ? '成功' : '失败'}
                    </span>
                    <span className="di-history__time">{formatTime(log.createTime)}</span>
                    <Eye size={12} className="di-history__view" />
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {logId !== null && <LogModal logId={logId} onClose={() => setLogId(null)} />}
    </aside>
  );
};

// ------------------------------------------------------------------ 主面板

const DataIntegrationPanel: React.FC = () => {
  const toast = useToast();
  const [options, setOptions] = useState<IntegrationOptionsVO | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<IntegrationTaskVO[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(10);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [editor, setEditor] = useState<{ task: IntegrationTaskVO | null } | null>(null);

  const [filters, setFilters] = useState({
    keyword: '',
    status: '',
    clusterType: '',
    sourceType: '',
    targetType: '',
  });
  const [appliedFilters, setAppliedFilters] = useState(filters);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    try {
      const res = await dataIntegrationApi.getList({
        current: page,
        size: pageSize,
        ...appliedFilters,
      });
      setTasks(res.data.records || []);
      setTotal(res.data.total || 0);
    } catch {
      setTasks([]);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, appliedFilters]);

  /**
   * 拉取数据集成配置（数据源/集群/状态等枚举）。
   *
   * 这些枚举是「新建任务」与四个筛选下拉的唯一数据来源：早期实现只在挂载时拉一次，
   * 失败后把 options 留在 null（异常被静默吞掉），于是新建按钮被 `disabled={!options}`
   * 永久锁死、四个下拉永远只有占位项，且界面没有任何提示 —— 用户看到的就是
   * 「按钮和下拉都不可用」。这里显式维护 loading/error 并返回结果，供按钮点击时重试。
   */
  const loadOptions = useCallback(async (): Promise<IntegrationOptionsVO | null> => {
    setOptionsLoading(true);
    try {
      const res = await dataIntegrationApi.getOptions();
      setOptions(res.data);
      setOptionsError(null);
      return res.data;
    } catch (e) {
      setOptions(null);
      setOptionsError(e instanceof Error ? e.message : '数据集成配置加载失败');
      return null;
    } finally {
      setOptionsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadOptions();
  }, [loadOptions]);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  const pages = Math.max(1, Math.ceil(total / pageSize));

  /**
   * 打开新建弹窗。配置缺失时先重试拉取（而不是把按钮永久禁用），
   * 重试成功才打开编辑器，失败则由上方错误条展示真实原因。
   */
  const handleCreate = async () => {
    if (options) {
      setEditor({ task: null });
      return;
    }
    const data = await loadOptions();
    if (data) setEditor({ task: null });
  };

  const applyFilters = () => {
    setPage(1);
    setAppliedFilters({ ...filters });
  };

  const resetFilters = () => {
    const empty = { keyword: '', status: '', clusterType: '', sourceType: '', targetType: '' };
    setFilters(empty);
    setAppliedFilters(empty);
    setPage(1);
  };

  const handleSubmit = async (task: IntegrationTaskVO) => {
    setBusyId(task.id);
    try {
      const res = await dataIntegrationApi.submit(task.id);
      toast.info(res.data.message || '已上线');
      await loadTasks();
    } catch {
      await loadTasks();
    } finally {
      setBusyId(null);
    }
  };

  const handleOffline = async (task: IntegrationTaskVO) => {
    if (!window.confirm(`确定下线任务「${task.taskName}」？将调用集群接口取消/停止作业。`)) return;
    setBusyId(task.id);
    try {
      const res = await dataIntegrationApi.offline(task.id);
      toast.info(res.data.message || '已下线');
      await loadTasks();
    } catch {
      await loadTasks();
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (task: IntegrationTaskVO) => {
    if (!window.confirm(`确定删除任务「${task.taskName}」？提交记录一并删除。`)) return;
    setBusyId(task.id);
    try {
      await dataIntegrationApi.remove(task.id);
      toast.info('任务已删除');
      if (detailId === task.id) setDetailId(null);
      await loadTasks();
    } catch {
      // 全局提示
    } finally {
      setBusyId(null);
    }
  };

  const statusOptions = useMemo(() => options?.statuses || [], [options]);

  const activeDetailId = detailId;

  return (
    <div className={`data-integration ${activeDetailId ? 'data-integration--with-drawer' : ''}`}>
      <div className="di-main">
        <header className="di-header">
          <div className="di-header__title">
            <Workflow size={18} />
            <span>数据集成</span>
            <span className="di-header__sub">源端 → 目标端，一键上线 Flink CDC 作业</span>
          </div>
          <div className="di-header__actions">
            <button className="di-btn di-btn--secondary" onClick={loadTasks} disabled={loading}>
              <RefreshCw size={13} className={loading ? 'di-spin' : ''} /> 刷新
            </button>
            <button
              className="di-btn di-btn--primary"
              onClick={handleCreate}
              disabled={optionsLoading}
              title={!options && !optionsLoading ? '配置加载失败，点击重试' : undefined}
            >
              <Plus size={14} /> 新建任务
            </button>
          </div>
        </header>

        {optionsError && (
          <div className="di-banner di-alert di-alert--error" role="alert">
            <AlertTriangle size={12} />
            <span>数据集成配置加载失败：{optionsError}</span>
            <button
              className="di-btn di-btn--secondary di-btn--xs"
              onClick={() => void loadOptions()}
              disabled={optionsLoading}
            >
              {optionsLoading ? '重试中...' : '重试'}
            </button>
          </div>
        )}

        <div className="di-filters">
          <div className="di-search">
            <Search size={13} />
            <input
              className="di-search__input"
              placeholder="搜索任务名称 / 编码"
              value={filters.keyword}
              onChange={e => setFilters(prev => ({ ...prev, keyword: e.target.value }))}
              onKeyDown={e => {
                if (e.key === 'Enter') applyFilters();
              }}
            />
          </div>
          <select
            className="di-input di-select"
            value={filters.status}
            disabled={!options}
            onChange={e => setFilters(prev => ({ ...prev, status: e.target.value }))}
          >
            <option value="">全部状态</option>
            {statusOptions.map(item => (
              <option key={item.code} value={item.code}>{item.label}</option>
            ))}
          </select>
          <select
            className="di-input di-select"
            value={filters.clusterType}
            disabled={!options}
            onChange={e => setFilters(prev => ({ ...prev, clusterType: e.target.value }))}
          >
            <option value="">全部集群</option>
            {(options?.clusterTypes || []).map(item => (
              <option key={item.code} value={item.code}>{item.label}</option>
            ))}
          </select>
          <select
            className="di-input di-select"
            value={filters.sourceType}
            disabled={!options}
            onChange={e => setFilters(prev => ({ ...prev, sourceType: e.target.value }))}
          >
            <option value="">全部源端</option>
            {(options?.sourceTypes || []).map(item => (
              <option key={item.code} value={item.code}>{item.label}</option>
            ))}
          </select>
          <select
            className="di-input di-select"
            value={filters.targetType}
            disabled={!options}
            onChange={e => setFilters(prev => ({ ...prev, targetType: e.target.value }))}
          >
            <option value="">全部目标端</option>
            {(options?.targetTypes || []).map(item => (
              <option key={item.code} value={item.code}>{item.label}</option>
            ))}
          </select>
          <button className="di-btn di-btn--primary di-btn--xs" onClick={applyFilters}>查询</button>
          <button className="di-btn di-btn--ghost di-btn--xs" onClick={resetFilters}>重置</button>
        </div>

        <div className="di-table-wrap">
          <table className="di-table">
            <thead>
              <tr>
                <th>任务名称</th>
                <th>所属项目</th>
                <th>源端 → 目标端</th>
                <th>表数量</th>
                <th>运行集群</th>
                <th>状态</th>
                <th>读写并行度</th>
                <th>更新时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {loading && tasks.length === 0 ? (
                <tr><td colSpan={9} className="di-table__empty">加载中...</td></tr>
              ) : tasks.length === 0 ? (
                <tr><td colSpan={9} className="di-table__empty">暂无数据集成任务，点击右上角「新建任务」开始</td></tr>
              ) : (
                tasks.map(task => (
                  <tr key={task.id}>
                    <td>
                      <button className="di-table__link" onClick={() => setDetailId(task.id)}>
                        {task.taskName}
                      </button>
                      <div className="di-table__code">{task.taskCode}</div>
                    </td>
                    <td>
                      {task.projectId ? (
                        <span title={task.projectCode || ''}>
                          {task.projectName || task.projectCode}
                          {task.projectName && task.projectCode ? <div className="di-table__code">{task.projectCode}</div> : null}
                        </span>
                      ) : (
                        <span className="di-form__hint di-form__hint--warn">未设置</span>
                      )}
                    </td>
                    <td>
                      <div className="di-table__flow">
                        <span className="di-table__type">{typeLabel(options, task.sourceType)}</span>
                        <ArrowLeftRight size={11} />
                        <span className="di-table__type">{typeLabel(options, task.targetType)}</span>
                      </div>
                    </td>
                    <td className="di-table__num">{task.tableCount || task.tables?.length || 0}</td>
                    <td className="di-table__type">{task.clusterType}</td>
                    <td><StatusBadge status={task.status} label={task.statusLabel} /></td>
                    <td className="di-table__num">读 {task.readParallelism} / 写 {task.writeParallelism}</td>
                    <td className="di-table__time">{formatTime(task.updateTime)}</td>
                    <td>
                      <div className="di-table__actions">
                        <button
                          className="di-btn di-btn--ghost di-btn--xs"
                          onClick={() => setDetailId(task.id)}
                        >
                          <Eye size={12} /> 详情
                        </button>
                        <button
                          className="di-btn di-btn--success di-btn--xs"
                          disabled={task.status === 'PUBLISHED' || task.status === 'RUNNING' || busyId === task.id}
                          title={task.status === 'PUBLISHED' || task.status === 'RUNNING' ? '请先下线' : '上线'}
                          onClick={() => handleSubmit(task)}
                        >
                          <Play size={12} /> 上线
                        </button>
                        <button
                          className="di-btn di-btn--warning di-btn--xs"
                          disabled={task.status === 'DRAFT' || task.status === 'OFFLINE' || busyId === task.id}
                          title={task.status === 'DRAFT' || task.status === 'OFFLINE' ? '任务未上线或已下线' : '下线'}
                          onClick={() => handleOffline(task)}
                        >
                          <Square size={12} /> 下线
                        </button>
                        <button
                          className="di-btn di-btn--ghost di-btn--xs"
                          disabled={busyId === task.id}
                          onClick={() => setEditor({ task })}
                        >
                          <Pencil size={12} /> 编辑
                        </button>
                        <button
                          className="di-btn di-btn--danger di-btn--xs"
                          disabled={task.status === 'PUBLISHED' || task.status === 'RUNNING' || busyId === task.id}
                          title={task.status === 'PUBLISHED' || task.status === 'RUNNING' ? '请先下线' : '删除'}
                          onClick={() => handleDelete(task)}
                        >
                          <Trash2 size={12} /> 删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <footer className="di-pagination">
          <span className="di-pagination__total">共 {total} 条</span>
          <button
            className="di-pagination__btn"
            disabled={page <= 1 || loading}
            onClick={() => setPage(prev => Math.max(1, prev - 1))}
          >
            <ChevronLeft size={14} />
          </button>
          <span className="di-pagination__page">{page} / {pages}</span>
          <button
            className="di-pagination__btn"
            disabled={page >= pages || loading}
            onClick={() => setPage(prev => Math.min(pages, prev + 1))}
          >
            <ChevronRight size={14} />
          </button>
        </footer>
      </div>

      {activeDetailId !== null && (
        <DetailDrawer
          taskId={activeDetailId}
          options={options}
          onClose={() => setDetailId(null)}
          onChanged={loadTasks}
          onEdit={task => setEditor({ task })}
        />
      )}

      {editor && options && (
        <TaskEditor
          options={options}
          task={editor.task}
          onClose={() => setEditor(null)}
          onSaved={loadTasks}
        />
      )}
    </div>
  );
};

function toStringRecord(config: Record<string, unknown> | null | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  Object.entries(config || {}).forEach(([key, value]) => {
    if (value !== null && value !== undefined) {
      result[key] = String(value);
    }
  });
  return result;
}

export default DataIntegrationPanel;
