/**
 * 质检任务页签（数据质量 → 质检任务）
 *
 * ── 定位 ────────────────────────────────────────────────────
 * 质检任务是「一组规则的执行计划」：把规则集与触发方式绑定起来，任务级处置策略作为
 * 规则未单独设置时的默认值。阻断下游的实现方式沿用提示词契约 —— 质检任务作为 DAG 节点，
 * 校验失败即非零退出，下游自然不执行，平台不反向改写调度状态。
 *
 * ── 接口 ────────────────────────────────────────────────────
 * 全部走 api/quality 的 /quality/task*（suppressError: true）：
 * 读失败在本页签内呈现空态/错误态，写失败才用 toast 提示（写操作由用户主动触发）。
 * 调度触发的工作流与节点通过既有 DolphinScheduler 客户端选择，不在本地维护副本。
 */

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import {
  Plus,
  Search,
  RotateCcw,
  Edit3,
  Trash2,
  Play,
  Power,
  ListChecks,
  CircleAlert,
} from 'lucide-react';
import { qualityApi } from '../../api/quality';
import type { QualityTaskSaveDTO } from '../../api/quality';
import type {
  QualityRuleVO,
  QualityTaskVO,
  QualityTriggerType,
  QualityDisposeMode,
} from '../../types/quality';
import { getQualityRuleType } from '../../types/quality';
import { fetchAllDataSources, fetchTablesByDataSourceId } from '../../api/datasource';
import type { DataSource, TableInfo } from '../../api/datasource';
import { useDolphinSchedulerApi } from '../../contexts/DolphinSchedulerContext';
import type { DSProject, DSWorkflowDefinition, DSWorkflowTaskNode } from '../../types/dolphinscheduler';
import { useToast } from '../../components/Toast';

const PAGE_SIZE = 10;

const TRIGGER_LABEL: Record<string, string> = { SCHEDULE: '调度触发', MANUAL: '手动触发' };
const DISPOSE_LABEL: Record<string, string> = { BLOCK: '阻断下游', ALERT: '告警' };

interface TaskFormState {
  id?: number;
  taskName: string;
  ownerName: string;
  description: string;
  datasourceId: number | null;
  databaseName: string;
  tableName: string;
  triggerType: QualityTriggerType;
  projectCode: string;
  workflowCode: number | null;
  workflowName: string;
  nodeName: string;
  disposePolicy: QualityDisposeMode;
  enabled: boolean;
}

const emptyForm = (): TaskFormState => ({
  taskName: '',
  ownerName: '',
  description: '',
  datasourceId: null,
  databaseName: '',
  tableName: '',
  // 默认手动触发：调度触发需要调度服务在线，作为默认值会让首次保存无故失败
  triggerType: 'MANUAL',
  projectCode: '',
  workflowCode: null,
  workflowName: '',
  nodeName: '',
  disposePolicy: 'ALERT',
  enabled: true,
});

/** 把任务 VO 回填为表单态 */
function toForm(row: QualityTaskVO): TaskFormState {
  return {
    id: row.id,
    taskName: row.taskName,
    ownerName: row.ownerName ?? '',
    description: row.description ?? '',
    datasourceId: row.datasourceId,
    databaseName: row.databaseName ?? '',
    tableName: row.tableName ?? '',
    triggerType: row.triggerType ?? 'MANUAL',
    projectCode: row.projectCode ?? '',
    workflowCode: row.workflowCode,
    workflowName: row.workflowName ?? '',
    nodeName: row.nodeName ?? '',
    disposePolicy: row.disposePolicy ?? 'ALERT',
    enabled: row.enabled ?? true,
  };
}

const TaskTab: React.FC = () => {
  const toast = useToast();
  const { api: dsApi } = useDolphinSchedulerApi();

  const [tasks, setTasks] = useState<QualityTaskVO[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const [keyword, setKeyword] = useState('');
  const [appliedKeyword, setAppliedKeyword] = useState('');
  const [triggerFilter, setTriggerFilter] = useState<'' | QualityTriggerType>('');
  const [enabledFilter, setEnabledFilter] = useState<'' | 'true' | 'false'>('');

  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [rules, setRules] = useState<QualityRuleVO[]>([]);
  const [rulesLoading, setRulesLoading] = useState(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<TaskFormState>(emptyForm);
  const [submitting, setSubmitting] = useState(false);
  const [confirm, setConfirm] = useState<{ visible: boolean; message: string; onConfirm: () => void }>({
    visible: false,
    message: '',
    onConfirm: () => {},
  });

  // 表单联动数据：监控对象（数据源 / 库 / 表）与调度关联（项目 / 工作流 / 节点）
  const [dataSources, setDataSources] = useState<DataSource[]>([]);
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [projects, setProjects] = useState<DSProject[]>([]);
  const [workflows, setWorkflows] = useState<DSWorkflowDefinition[]>([]);
  const [nodes, setNodes] = useState<DSWorkflowTaskNode[]>([]);

  // 弹窗打开时的一次性预加载需要读当前表单值，但不能把 form 放进依赖数组（否则每次输入都重新拉取）
  const formRef = useRef(form);
  formRef.current = form;

  const loadTasks = useCallback(async () => {
    setLoading(true);
    try {
      const res = await qualityApi.listTasks({
        current: page,
        size: PAGE_SIZE,
        keyword: appliedKeyword || undefined,
        triggerType: triggerFilter || undefined,
        enabled: enabledFilter === '' ? undefined : enabledFilter === 'true',
      });
      setTasks(res.data?.records ?? []);
      setTotal(res.data?.total ?? 0);
      setFailed(false);
    } catch {
      setTasks([]);
      setTotal(0);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [page, appliedKeyword, triggerFilter, enabledFilter]);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  const loadTables = async (datasourceId: number) => {
    try {
      const res = await fetchTablesByDataSourceId(datasourceId);
      setTables(res.data?.records ?? []);
    } catch {
      setTables([]);
    }
  };

  const loadWorkflows = async (projectCode: number): Promise<DSWorkflowDefinition[]> => {
    if (!dsApi) return [];
    try {
      const res = await dsApi.workflowDefinition.list(projectCode, { pageNo: 1, pageSize: 200 });
      const list = res.code === 0 && res.data?.totalList ? res.data.totalList : [];
      setWorkflows(list);
      return list;
    } catch {
      setWorkflows([]);
      return [];
    }
  };

  const loadNodes = async (projectCode: number, workflowCode: number) => {
    if (!dsApi) return;
    try {
      const res = await dsApi.workflowDefinition.detail(projectCode, workflowCode);
      const list = res.code === 0 && res.data?.taskNodes ? res.data.taskNodes : [];
      setNodes(list);
    } catch {
      setNodes([]);
    }
  };

  // 弹窗打开：预加载监控对象候选，并按已有值回填调度关联的下拉候选
  useEffect(() => {
    if (!dialogOpen) return;
    const current = formRef.current;

    (async () => {
      try {
        const res = await fetchAllDataSources();
        setDataSources(res.data ?? []);
      } catch {
        setDataSources([]);
      }
    })();

    if (current.datasourceId) loadTables(current.datasourceId);

    if (!dsApi) return;
    (async () => {
      try {
        const res = await dsApi.project.list({ pageNo: 1, pageSize: 100 });
        const list = res.code === 0 && res.data?.totalList ? res.data.totalList : [];
        setProjects(list);
        if (current.triggerType !== 'SCHEDULE' || !current.projectCode) return;
        const project = list.find(p => p.name === current.projectCode);
        if (!project) return;
        await loadWorkflows(project.code);
        if (current.workflowCode) await loadNodes(project.code, current.workflowCode);
      } catch {
        setProjects([]);
      }
    })();
    // 仅在弹窗打开时预加载；下拉联动由各 onChange 处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialogOpen]);

  const openCreate = () => {
    setForm(emptyForm());
    setTables([]);
    setWorkflows([]);
    setNodes([]);
    setDialogOpen(true);
  };

  const openEdit = (row: QualityTaskVO) => {
    setForm(toForm(row));
    setTables([]);
    setWorkflows([]);
    setNodes([]);
    setDialogOpen(true);
  };

  const handleDatasourceChange = (datasourceId: number | null) => {
    const ds = dataSources.find(d => d.id === datasourceId);
    setForm(f => ({
      ...f,
      datasourceId,
      databaseName: ds?.databaseName?.[0] ?? '',
      tableName: '',
    }));
    setTables([]);
    if (datasourceId) loadTables(datasourceId);
  };

  const handleProjectChange = (projectName: string) => {
    setForm(f => ({ ...f, projectCode: projectName, workflowCode: null, workflowName: '', nodeName: '' }));
    setWorkflows([]);
    setNodes([]);
    const project = projects.find(p => p.name === projectName);
    if (project) loadWorkflows(project.code);
  };

  const handleWorkflowChange = (workflowCode: number | null) => {
    const wf = workflows.find(w => w.code === workflowCode);
    setForm(f => ({ ...f, workflowCode, workflowName: wf?.name ?? '', nodeName: '' }));
    setNodes([]);
    const project = projects.find(p => p.name === form.projectCode);
    if (project && workflowCode) loadNodes(project.code, workflowCode);
  };

  const toggleRules = async (row: QualityTaskVO) => {
    if (expandedId === row.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(row.id);
    setRules([]);
    setRulesLoading(true);
    try {
      const res = await qualityApi.listTaskRules(row.id);
      setRules(res.data ?? []);
    } catch {
      setRules([]);
    } finally {
      setRulesLoading(false);
    }
  };

  const handleRun = async (row: QualityTaskVO) => {
    try {
      const res = await qualityApi.runTask(row.id);
      toast.info(`已触发「${row.taskName}」，运行实例 #${res.data ?? '-'}`);
      loadTasks();
    } catch (e) {
      toast.error(`触发失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleToggleEnabled = async (row: QualityTaskVO) => {
    try {
      await qualityApi.setTaskEnabled(row.id, !row.enabled);
      toast.info(`「${row.taskName}」已${row.enabled ? '停用' : '启用'}`);
      loadTasks();
    } catch (e) {
      toast.error(`操作失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleDelete = (row: QualityTaskVO) => {
    setConfirm({
      visible: true,
      message: `确定要删除质检任务「${row.taskName}」吗？任务下的规则关联会一并解除。`,
      onConfirm: async () => {
        try {
          await qualityApi.deleteTask(row.id);
          toast.info(`「${row.taskName}」已删除`);
          if (expandedId === row.id) setExpandedId(null);
          loadTasks();
        } catch (e) {
          toast.error(`删除失败：${e instanceof Error ? e.message : String(e)}`);
        }
        setConfirm(prev => ({ ...prev, visible: false }));
      },
    });
  };

  const handleSubmit = async () => {
    if (!form.taskName.trim()) {
      toast.warning('请填写任务名称');
      return;
    }
    if (!form.datasourceId || !form.databaseName || !form.tableName) {
      toast.warning('请选择监控对象表（数据源 / 库 / 表）');
      return;
    }
    if (form.triggerType === 'SCHEDULE' && (!form.projectCode || !form.workflowCode || !form.nodeName)) {
      toast.warning('调度触发需选择调度项目、工作流与节点');
      return;
    }

    const payload: QualityTaskSaveDTO = {
      id: form.id,
      taskName: form.taskName.trim(),
      ownerName: form.ownerName.trim(),
      description: form.description,
      datasourceId: form.datasourceId,
      datasourceName: dataSources.find(d => d.id === form.datasourceId)?.datasourceName ?? '',
      databaseName: form.databaseName,
      tableName: form.tableName,
      triggerType: form.triggerType,
      projectCode: form.triggerType === 'SCHEDULE' ? form.projectCode : '',
      workflowCode: form.triggerType === 'SCHEDULE' ? form.workflowCode : null,
      workflowName: form.triggerType === 'SCHEDULE' ? form.workflowName : '',
      nodeName: form.triggerType === 'SCHEDULE' ? form.nodeName : '',
      disposePolicy: form.disposePolicy,
      enabled: form.enabled,
    };

    setSubmitting(true);
    try {
      if (form.id) await qualityApi.updateTask(payload);
      else await qualityApi.createTask(payload);
      setDialogOpen(false);
      toast.info(form.id ? '质检任务已更新' : '质检任务已创建');
      loadTasks();
    } catch (e) {
      toast.error(`${form.id ? '更新' : '创建'}失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSubmitting(false);
    }
  };

  if (failed) {
    return (
      <div className="dq-placeholder">
        <div className="dq-placeholder__head">
          <CircleAlert size={16} />
          <span>质检任务接口不可用，暂时无法加载任务清单。</span>
        </div>
        <p className="dq-placeholder__lead">
          请确认服务端 /api/quality/task 已部署且当前账号有权限，然后点击右上角「重新加载」。
        </p>
      </div>
    );
  }

  const databases = dataSources.find(d => d.id === form.datasourceId)?.databaseName ?? [];
  const dbTables = tables.filter(t => !form.databaseName || t.databaseName === form.databaseName);
  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div>
      <div className="dq-toolbar">
        <div className="dq-search-bar">
          <input
            className="dq-input"
            placeholder="搜索任务名称"
            value={keyword}
            onChange={e => setKeyword(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                setPage(1);
                setAppliedKeyword(keyword);
              }
            }}
          />
          <select
            className="dq-select"
            value={triggerFilter}
            onChange={e => {
              setPage(1);
              setTriggerFilter(e.target.value as '' | QualityTriggerType);
            }}
          >
            <option value="">全部触发方式</option>
            <option value="SCHEDULE">调度触发</option>
            <option value="MANUAL">手动触发</option>
          </select>
          <select
            className="dq-select"
            value={enabledFilter}
            onChange={e => {
              setPage(1);
              setEnabledFilter(e.target.value as '' | 'true' | 'false');
            }}
          >
            <option value="">全部状态</option>
            <option value="true">启用</option>
            <option value="false">停用</option>
          </select>
          <button
            className="dq-btn dq-btn--primary"
            onClick={() => {
              setPage(1);
              setAppliedKeyword(keyword);
            }}
          >
            <Search size={14} /> 查询
          </button>
          <button
            className="dq-btn"
            onClick={() => {
              setKeyword('');
              setAppliedKeyword('');
              setTriggerFilter('');
              setEnabledFilter('');
              setPage(1);
            }}
          >
            <RotateCcw size={14} /> 重置
          </button>
        </div>
        <button className="dq-btn dq-btn--primary" onClick={openCreate}>
          <Plus size={14} /> 新增任务
        </button>
      </div>

      <table className="dq-table">
        <thead>
          <tr>
            <th>任务名</th>
            <th>监控对象</th>
            <th>触发方式</th>
            <th>关联工作流 / 节点</th>
            <th>处置策略</th>
            <th>状态</th>
            <th className="dq-th-actions">操作</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td colSpan={7} className="dq-table-empty">
                加载中…
              </td>
            </tr>
          ) : tasks.length === 0 ? (
            <tr>
              <td colSpan={7} className="dq-table-empty">
                暂无质检任务，点击「新增任务」创建第一个执行计划。
              </td>
            </tr>
          ) : (
            tasks.map(row => (
              <Fragment key={row.id}>
                <tr>
                  <td className="dq-table__strong">
                    {row.taskName}
                    {row.ownerName ? <span className="dq-table__sub">负责人 {row.ownerName}</span> : null}
                  </td>
                  <td>
                    {row.datasourceName || '—'}
                    <span className="dq-table__sub">
                      {row.databaseName}.{row.tableName}
                    </span>
                  </td>
                  <td>
                    <span className={`dq-tag dq-tag--${row.triggerType === 'SCHEDULE' ? 'info' : 'default'}`}>
                      {TRIGGER_LABEL[row.triggerType] ?? row.triggerType}
                    </span>
                  </td>
                  <td>
                    {row.triggerType === 'SCHEDULE' ? (
                      <>
                        {row.projectCode || '—'}
                        <span className="dq-table__sub">
                          {row.workflowName || row.workflowCode || '—'} / {row.nodeName || '—'}
                        </span>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>{DISPOSE_LABEL[row.disposePolicy] ?? row.disposePolicy}</td>
                  <td>
                    <span className={`dq-tag dq-tag--${row.enabled ? 'success' : 'danger'}`}>
                      {row.enabled ? '启用' : '停用'}
                    </span>
                  </td>
                  <td className="dq-td-actions">
                    <button className="dq-btn-link" onClick={() => toggleRules(row)}>
                      <ListChecks size={12} /> {expandedId === row.id ? '收起规则' : '规则'}
                    </button>
                    <button className="dq-btn-link" onClick={() => handleRun(row)}>
                      <Play size={12} /> 手动执行
                    </button>
                    <button className="dq-btn-link" onClick={() => handleToggleEnabled(row)}>
                      <Power size={12} /> {row.enabled ? '停用' : '启用'}
                    </button>
                    <button className="dq-btn-link" onClick={() => openEdit(row)}>
                      <Edit3 size={12} /> 编辑
                    </button>
                    <button className="dq-btn-link dq-btn-link--danger" onClick={() => handleDelete(row)}>
                      <Trash2 size={12} /> 删除
                    </button>
                  </td>
                </tr>
                {expandedId === row.id && (
                  <tr>
                    <td colSpan={7}>
                      {rulesLoading ? (
                        <p className="dq-muted">规则加载中…</p>
                      ) : rules.length === 0 ? (
                        <p className="dq-muted">该任务尚未关联规则。规则集在「规则配置」页签维护后加入本任务。</p>
                      ) : (
                        <table className="dq-table dq-table--nested">
                          <thead>
                            <tr>
                              <th>规则名</th>
                              <th>规则类型</th>
                              <th>校验对象</th>
                              <th>阈值</th>
                              <th>处置方式</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rules.map(rule => (
                              <tr key={rule.id}>
                                <td className="dq-table__strong">{rule.ruleName}</td>
                                <td>{getQualityRuleType(rule.ruleType)?.label ?? rule.ruleType}</td>
                                <td>
                                  {rule.tableName}
                                  {rule.columnName ? `.${rule.columnName}` : ''}
                                </td>
                                <td>
                                  {rule.expectedValue || rule.errorThreshold || '—'}
                                  {rule.warnThreshold ? `（橙色 ${rule.warnThreshold}）` : ''}
                                </td>
                                <td>{DISPOSE_LABEL[rule.disposeMode] ?? rule.disposeMode}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))
          )}
        </tbody>
      </table>

      {totalPages > 1 && (
        <div className="dq-pagination">
          <button className="dq-btn" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
            上一页
          </button>
          <span>
            {page} / {totalPages}（共 {total} 条）
          </span>
          <button className="dq-btn" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>
            下一页
          </button>
        </div>
      )}

      {dialogOpen && (
        <div className="dq-modal-overlay">
          <div className="dq-modal">
            <div className="dq-modal-header">
              <h3>{form.id ? '编辑质检任务' : '新增质检任务'}</h3>
              <button className="dq-modal-close" onClick={() => setDialogOpen(false)}>
                ×
              </button>
            </div>
            <div className="dq-modal-body">
              <div className="dq-form-row">
                <div className="dq-form-group">
                  <label>
                    任务名称 <span className="dq-required">*</span>
                  </label>
                  <input
                    className="dq-input"
                    value={form.taskName}
                    maxLength={128}
                    placeholder="如 dqc_订单表日校验"
                    onChange={e => setForm(f => ({ ...f, taskName: e.target.value }))}
                  />
                </div>
                <div className="dq-form-group">
                  <label>负责人</label>
                  <input
                    className="dq-input"
                    value={form.ownerName}
                    maxLength={64}
                    placeholder="校验失败时的责任人"
                    onChange={e => setForm(f => ({ ...f, ownerName: e.target.value }))}
                  />
                </div>
              </div>

              <div className="dq-form-group">
                <label>监控对象表</label>
                <div className="dq-form-row">
                  <select
                    className="dq-select"
                    value={form.datasourceId ?? ''}
                    onChange={e => handleDatasourceChange(e.target.value ? Number(e.target.value) : null)}
                  >
                    <option value="">请选择数据源</option>
                    {dataSources.map(d => (
                      <option key={d.id} value={d.id}>
                        {d.datasourceName}
                      </option>
                    ))}
                  </select>
                  <select
                    className="dq-select"
                    value={form.databaseName}
                    disabled={!form.datasourceId}
                    onChange={e => setForm(f => ({ ...f, databaseName: e.target.value, tableName: '' }))}
                  >
                    <option value="">请选择库</option>
                    {form.databaseName && !databases.includes(form.databaseName) && (
                      <option value={form.databaseName}>{form.databaseName}（当前值）</option>
                    )}
                    {databases.map(db => (
                      <option key={db} value={db}>
                        {db}
                      </option>
                    ))}
                  </select>
                  <select
                    className="dq-select"
                    value={form.tableName}
                    disabled={!form.datasourceId}
                    onChange={e => setForm(f => ({ ...f, tableName: e.target.value }))}
                  >
                    <option value="">请选择表</option>
                    {form.tableName && !dbTables.some(t => t.tableName === form.tableName) && (
                      <option value={form.tableName}>{form.tableName}（当前值）</option>
                    )}
                    {dbTables.map(t => (
                      <option key={`${t.databaseName}.${t.tableName}`} value={t.tableName}>
                        {t.tableName}
                      </option>
                    ))}
                  </select>
                </div>
                {form.datasourceId && dbTables.length === 0 && (
                  <p className="dq-hint">该库下未取到表清单（可能未同步元数据），可先在数据源管理同步元数据后再选择。</p>
                )}
              </div>

              <div className="dq-form-group">
                <label>触发方式</label>
                <div className="dq-switch">
                  <button
                    className={`dq-switch-btn ${form.triggerType === 'MANUAL' ? 'dq-switch-btn--active' : ''}`}
                    onClick={() => setForm(f => ({ ...f, triggerType: 'MANUAL' }))}
                  >
                    手动触发
                  </button>
                  <button
                    className={`dq-switch-btn ${form.triggerType === 'SCHEDULE' ? 'dq-switch-btn--active' : ''}`}
                    onClick={() => setForm(f => ({ ...f, triggerType: 'SCHEDULE' }))}
                  >
                    调度触发
                  </button>
                </div>
                <p className="dq-hint">
                  手动触发用于临时校验；调度触发把校验挂在调度工作流节点上，校验失败即节点失败，下游不执行。
                </p>
              </div>

              {form.triggerType === 'SCHEDULE' && (
                <div className="dq-form-group">
                  <label>
                    关联工作流与节点 <span className="dq-required">*</span>
                  </label>
                  <div className="dq-form-row">
                    <select
                      className="dq-select"
                      value={form.projectCode}
                      onChange={e => handleProjectChange(e.target.value)}
                    >
                      <option value="">请选择调度项目</option>
                      {form.projectCode && !projects.some(p => p.name === form.projectCode) && (
                        <option value={form.projectCode}>{form.projectCode}（当前值）</option>
                      )}
                      {projects.map(p => (
                        <option key={p.code} value={p.name}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                    <select
                      className="dq-select"
                      value={form.workflowCode ?? ''}
                      disabled={!form.projectCode}
                      onChange={e => handleWorkflowChange(e.target.value ? Number(e.target.value) : null)}
                    >
                      <option value="">请选择工作流</option>
                      {form.workflowCode && !workflows.some(w => w.code === form.workflowCode) && (
                        <option value={form.workflowCode}>{form.workflowName || form.workflowCode}（当前值）</option>
                      )}
                      {workflows.map(w => (
                        <option key={w.code} value={w.code}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                    <select
                      className="dq-select"
                      value={form.nodeName}
                      disabled={!form.workflowCode}
                      onChange={e => setForm(f => ({ ...f, nodeName: e.target.value }))}
                    >
                      <option value="">请选择节点</option>
                      {form.nodeName && !nodes.some(n => n.name === form.nodeName) && (
                        <option value={form.nodeName}>{form.nodeName}（当前值）</option>
                      )}
                      {nodes.map(n => (
                        <option key={n.code} value={n.name}>
                          {n.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  {!dsApi && <p className="dq-hint">调度服务不可用，无法加载项目与工作流；可先按「手动触发」保存任务。</p>}
                </div>
              )}

              <div className="dq-form-group">
                <label>任务级处置策略</label>
                <div className="dq-switch">
                  <button
                    className={`dq-switch-btn ${form.disposePolicy === 'ALERT' ? 'dq-switch-btn--active' : ''}`}
                    onClick={() => setForm(f => ({ ...f, disposePolicy: 'ALERT' }))}
                  >
                    告警
                  </button>
                  <button
                    className={`dq-switch-btn ${form.disposePolicy === 'BLOCK' ? 'dq-switch-btn--active' : ''}`}
                    onClick={() => setForm(f => ({ ...f, disposePolicy: 'BLOCK' }))}
                  >
                    阻断下游
                  </button>
                </div>
                <p className="dq-hint">规则未单独设置处置方式时按此策略执行。</p>
              </div>

              <div className="dq-form-group">
                <label>描述</label>
                <textarea
                  className="dq-textarea"
                  rows={3}
                  maxLength={512}
                  value={form.description}
                  placeholder="任务用途、覆盖范围等"
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                />
              </div>

              <div className="dq-form-group">
                <label>状态</label>
                <div className="dq-switch">
                  <button
                    className={`dq-switch-btn ${form.enabled ? 'dq-switch-btn--active' : ''}`}
                    onClick={() => setForm(f => ({ ...f, enabled: true }))}
                  >
                    启用
                  </button>
                  <button
                    className={`dq-switch-btn ${!form.enabled ? 'dq-switch-btn--active' : ''}`}
                    onClick={() => setForm(f => ({ ...f, enabled: false }))}
                  >
                    停用
                  </button>
                </div>
              </div>
            </div>
            <div className="dq-modal-footer">
              <button className="dq-btn" onClick={() => setDialogOpen(false)}>
                取消
              </button>
              <button className="dq-btn dq-btn--primary" disabled={submitting} onClick={handleSubmit}>
                {submitting ? '提交中…' : '确定'}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirm.visible && (
        <div className="dq-modal-overlay">
          <div className="dq-confirm-dialog">
            <h3>确认删除</h3>
            <p>{confirm.message}</p>
            <div className="dq-confirm-actions">
              <button className="dq-btn" onClick={() => setConfirm(prev => ({ ...prev, visible: false }))}>
                取消
              </button>
              <button className="dq-btn dq-btn--danger" onClick={confirm.onConfirm}>
                确定
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default TaskTab;
