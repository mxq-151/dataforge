import { useState, useEffect, useCallback } from 'react';
import {
  Play, Plus, Trash2, RefreshCw, Eye, Copy, List, Edit3,
  StopCircle, CheckCircle, Clock, ArrowUpCircle, ArrowDownCircle, TreePine, Info,
  RotateCcw, Pause, PlayCircle, ArrowLeft, FolderKanban,
} from 'lucide-react';
import type {
  DolphinSchedulerApi,
  DSProject, DSWorkflowDefinition, DSWorkflowInstance, DSTaskInstance,
  DSWorkflowTaskNode, DSWorkflowEdge, DSWorkflowGlobalParam, DSWorkflowTriggerForm,
  DSWorkerGroup, DSEnvironment, DSAlertGroup,
} from '../../../types/dolphinscheduler';
import {
  ReleaseState, parseReleaseState,
  WorkflowExecutionStatus, TaskExecutionStatus, ExecutionType,
} from '../../../types/dolphinscheduler';
import WorkflowDefinitionEditor from './WorkflowDefinitionEditor';
import WorkflowInstanceDetail from './WorkflowInstanceDetail';
import TaskInstanceDetailView from './TaskInstanceDetail';
import {
  PAGE_SIZE,
  PROJECT_SUB_TAB_META,
  WORKFLOW_STATE_STRING_TO_ENUM, TASK_STATE_STRING_TO_ENUM,
  WORKFLOW_STATUS_CONFIG, TASK_STATUS_CONFIG,
  SearchBar, Pagination, ErrorBar, StatusBadge, ReleaseBadge, TaskTypeBadge,
  ConfirmModal, InputModal, LogModal,
  formatDateTime, formatDuration,
  type InputModalProps, type ProjectSubTab,
} from '../shared';

/**
 * 单个项目的详情页：工作流定义 / 工作流实例 / 任务实例三个子 Tab 及其编辑、详情视图。
 *
 * 多标签页下每个标签页挂载一份本组件实例，因此这里的所有状态（子 Tab、页码、搜索词、
 * 列表数据、正在编辑的工作流）天然随标签页隔离；切走再切回来不会丢失。
 */

const INSTANCE_POLL_INTERVAL = 5000;

export interface ProjectDetailViewProps {
  api: DolphinSchedulerApi;
  project: DSProject;
  /** 该标签页是否为当前激活页。非激活页只保留已加载数据，不参与 5s 轮询 */
  active: boolean;
  environments: DSEnvironment[];
  alertGroups: DSAlertGroup[];
  onBack: () => void;
}

const ProjectDetailView: React.FC<ProjectDetailViewProps> = ({
  api,
  project,
  active,
  environments,
  alertGroups,
  onBack,
}) => {
  const [projectSubTab, setProjectSubTab] = useState<ProjectSubTab>('workflowDefinitions');

  const [editingWorkflow, setEditingWorkflow] = useState<{
    mode: 'create' | 'edit';
    definition?: DSWorkflowDefinition;
    nodes: DSWorkflowTaskNode[];
    edges: DSWorkflowEdge[];
    globalParams: DSWorkflowGlobalParam[];
  } | null>(null);

  /**
   * 三个列表的搜索词都拆成「输入框文本」与「生效词」两份：
   * 只有后者参与请求，避免每敲一个字符就打一次接口（多标签页下会被成倍放大）。
   */
  const [workflowDefs, setWorkflowDefs] = useState<DSWorkflowDefinition[]>([]);
  const [workflowDefsTotal, setWorkflowDefsTotal] = useState(0);
  const [workflowDefsPage, setWorkflowDefsPage] = useState(1);
  const [defSearchInput, setDefSearchInput] = useState('');
  const [appliedDefSearch, setAppliedDefSearch] = useState('');

  const [workflowInstances, setWorkflowInstances] = useState<DSWorkflowInstance[]>([]);
  const [workflowInstancesTotal, setWorkflowInstancesTotal] = useState(0);
  const [workflowInstancesPage, setWorkflowInstancesPage] = useState(1);
  const [instSearchInput, setInstSearchInput] = useState('');
  const [appliedInstSearch, setAppliedInstSearch] = useState('');
  const [workflowInstanceStatusFilter, setWorkflowInstanceStatusFilter] = useState<string>('');

  const [taskInstances, setTaskInstances] = useState<DSTaskInstance[]>([]);
  const [taskInstancesTotal, setTaskInstancesTotal] = useState(0);
  const [taskInstancesPage, setTaskInstancesPage] = useState(1);
  const [taskSearchInput, setTaskSearchInput] = useState('');
  const [appliedTaskSearch, setAppliedTaskSearch] = useState('');
  const [taskInstanceStatusFilter, setTaskInstanceStatusFilter] = useState<string>('');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [confirmModal, setConfirmModal] = useState<{ message: string; onConfirm: () => void } | null>(null);
  const [inputModal, setInputModal] = useState<InputModalProps | null>(null);
  const [logModal, setLogModal] = useState<{ log: string; loading: boolean } | null>(null);

  const [viewingWorkflowInstance, setViewingWorkflowInstance] = useState<DSWorkflowInstance | null>(null);
  const [viewingTaskInstance, setViewingTaskInstance] = useState<DSTaskInstance | null>(null);

  const [workerGroups, setWorkerGroups] = useState<DSWorkerGroup[]>([]);

  // Worker 分组是按项目维度拉取的，跟着本组件的项目走
  useEffect(() => {
    let cancelled = false;
    const fetchWorkerGroups = async () => {
      try {
        const res = await api.workerGroup.list(project.code, { pageNo: 1, pageSize: 100 });
        if (cancelled) return;
        // 个别版本的 DS 返回 status=SUCCESS 而非 code=0，两种成功形态都认
        if (res.code === 0 || (res as any).status === 'SUCCESS') {
          const list = Array.isArray(res.data) ? res.data : (res.data?.totalList || []);
          setWorkerGroups(list);
        } else {
          console.warn('[ScheduleManagement] Worker groups response:', res);
        }
      } catch (err) {
        console.error('[ScheduleManagement] Failed to load worker groups:', err);
      }
    };
    fetchWorkerGroups();
    return () => { cancelled = true; };
  }, [api, project.code]);

  const fetchWorkflowDefs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.workflowDefinition.list(project.code, {
        pageNo: workflowDefsPage,
        pageSize: PAGE_SIZE,
        searchVal: appliedDefSearch || undefined,
      });
      if (res.code === 0 && res.data) {
        setWorkflowDefs(res.data.totalList || []);
        setWorkflowDefsTotal(res.data.total || 0);
      } else {
        setError(res.msg || '获取工作流定义失败');
      }
    } catch (e: any) {
      setError(e.message || '请求失败');
    } finally {
      setLoading(false);
    }
  }, [api, project.code, workflowDefsPage, appliedDefSearch]);

  const fetchWorkflowInstances = useCallback(async (silent = false) => {
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const res = await api.workflowInstance.list({
        pageNo: workflowInstancesPage,
        pageSize: PAGE_SIZE,
        searchVal: appliedInstSearch || undefined,
        projectCode: project.code?.toString() || undefined,
        executionStatus: workflowInstanceStatusFilter || undefined,
      });
      if (res.code === 0 && res.data) {
        const instances = (res.data.totalList || []).map((inst: any) => ({
          ...inst,
          state: WORKFLOW_STATE_STRING_TO_ENUM[inst.state] ?? inst.state,
        }));
        setWorkflowInstances(instances);
        setWorkflowInstancesTotal(res.data.total || 0);
      } else if (!silent) {
        setError(res.msg || '获取工作流实例失败');
      }
    } catch (e: any) {
      if (!silent) setError(e.message || '请求失败');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [api, project.code, workflowInstancesPage, appliedInstSearch, workflowInstanceStatusFilter]);

  const fetchTaskInstances = useCallback(async (silent = false) => {
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const res = await api.taskInstance.list({
        pageNo: taskInstancesPage,
        pageSize: PAGE_SIZE,
        searchVal: appliedTaskSearch || undefined,
        projectCode: project.code?.toString() || undefined,
        executionStatus: taskInstanceStatusFilter || undefined,
      });
      if (res.code === 0 && res.data) {
        const tasks = (res.data.totalList || []).map((task: any) => ({
          ...task,
          state: TASK_STATE_STRING_TO_ENUM[task.state] ?? task.state,
        }));
        setTaskInstances(tasks);
        setTaskInstancesTotal(res.data.total || 0);
      } else if (!silent) {
        setError(res.msg || '获取任务实例失败');
      }
    } catch (e: any) {
      if (!silent) setError(e.message || '请求失败');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [api, project.code, taskInstancesPage, appliedTaskSearch, taskInstanceStatusFilter]);

  /** 回车触发搜索：回到第一页并让搜索词生效；搜索词未变时手动补一次请求 */
  const handleSearchDefs = () => {
    setWorkflowDefsPage(1);
    if (defSearchInput !== appliedDefSearch) setAppliedDefSearch(defSearchInput);
    else fetchWorkflowDefs();
  };

  const handleSearchInstances = () => {
    setWorkflowInstancesPage(1);
    if (instSearchInput !== appliedInstSearch) setAppliedInstSearch(instSearchInput);
    else fetchWorkflowInstances();
  };

  const handleSearchTasks = () => {
    setTaskInstancesPage(1);
    if (taskSearchInput !== appliedTaskSearch) setAppliedTaskSearch(taskSearchInput);
    else fetchTaskInstances();
  };

  useEffect(() => {
    if (projectSubTab === 'workflowDefinitions') fetchWorkflowDefs();
  }, [fetchWorkflowDefs, projectSubTab]);

  useEffect(() => {
    if (projectSubTab === 'workflowInstances') fetchWorkflowInstances();
  }, [fetchWorkflowInstances, projectSubTab]);

  useEffect(() => {
    if (projectSubTab === 'taskInstances') fetchTaskInstances();
  }, [fetchTaskInstances, projectSubTab]);

  // 实例列表定时刷新：每 5 秒静默刷新。仅当前激活的标签页轮询，
  // 后台标签页与进入详情视图时暂停，避免无谓的请求。
  useEffect(() => {
    if (!active || projectSubTab !== 'workflowInstances') return;
    if (editingWorkflow || viewingWorkflowInstance || viewingTaskInstance) return;
    const timer = setInterval(() => { fetchWorkflowInstances(true); }, INSTANCE_POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [active, projectSubTab, editingWorkflow, viewingWorkflowInstance, viewingTaskInstance, fetchWorkflowInstances]);

  useEffect(() => {
    if (!active || projectSubTab !== 'taskInstances') return;
    if (editingWorkflow || viewingWorkflowInstance || viewingTaskInstance) return;
    const timer = setInterval(() => { fetchTaskInstances(true); }, INSTANCE_POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [active, projectSubTab, editingWorkflow, viewingWorkflowInstance, viewingTaskInstance, fetchTaskInstances]);

  const handleCreateWorkflowDef = () => {
    setEditingWorkflow({ mode: 'create', nodes: [], edges: [], globalParams: [] });
  };

  const handleEditWorkflowDef = async (def: DSWorkflowDefinition) => {
    if (parseReleaseState(def.releaseState) === ReleaseState.ONLINE) {
      setError('上线状态的工作流不能编辑，请先下线');
      return;
    }
    try {
      setLoading(true);
      const res = await api.workflowDefinition.detail(project.code, def.code);
      if (res.code === 0 && res.data) {
        setEditingWorkflow({
          mode: 'edit',
          definition: res.data.workflowDefinition,
          nodes: res.data.taskNodes || [],
          edges: res.data.edges || [],
          globalParams: res.data.globalParams || [],
        });
      } else {
        setError(res.msg || '获取工作流详情失败');
      }
    } catch (e: any) {
      setError(e.message || '获取工作流详情失败');
    } finally {
      setLoading(false);
    }
  };

  const handleSaveWorkflow = async (data: {
    name: string;
    description: string;
    executionType: ExecutionType;
    timeout: number;
    globalParams: DSWorkflowGlobalParam[];
    nodes: DSWorkflowTaskNode[];
    edges: DSWorkflowEdge[];
    release: boolean;
  }) => {
    try {
      if (editingWorkflow?.mode === 'edit' && editingWorkflow.definition) {
        if (!editingWorkflow.definition.code) {
          setError('工作流定义 code 缺失，无法更新，请重新打开编辑');
          return;
        }
        const res = await api.workflowDefinition.update(project.code, editingWorkflow.definition.code, data);
        if (res.code === 0) {
          setEditingWorkflow(null);
          fetchWorkflowDefs();
        } else {
          setError(res.msg || '保存工作流失败');
        }
      } else {
        const res = await api.workflowDefinition.createWithTasks(project.code, data);
        if (res.code === 0) {
          setEditingWorkflow(null);
          fetchWorkflowDefs();
        } else {
          setError(res.msg || '创建工作流失败');
        }
      }
    } catch (e: any) {
      setError(e.message || '保存失败');
    }
  };

  const handleTriggerWorkflowWithForm = async (defCode: number, _form: DSWorkflowTriggerForm) => {
    try {
      const res = await api.workflowDefinition.trigger(project.code, { processDefinitionCode: defCode });
      if (res.code === 0) {
        setEditingWorkflow(null);
        setProjectSubTab('workflowInstances');
        fetchWorkflowInstances();
      } else {
        setError(res.msg || '运行工作流失败');
      }
    } catch (e: any) {
      setError(e.message || '运行失败');
    }
  };

  const handleToggleWorkflowRelease = (def: DSWorkflowDefinition) => {
    const targetState: ReleaseState = parseReleaseState(def.releaseState) === ReleaseState.ONLINE ? ReleaseState.OFFLINE : ReleaseState.ONLINE;
    const action = targetState === ReleaseState.ONLINE ? '上线' : '下线';
    setConfirmModal({
      message: `确定要${action}工作流「${def.name}」吗？`,
      onConfirm: async () => {
        setConfirmModal(null);
        try {
          const res = await api.workflowDefinition.release(project.code, def.code, targetState);
          if (res.code === 0) {
            fetchWorkflowDefs();
          } else {
            setError(res.msg || `${action}失败`);
          }
        } catch (e: any) {
          setError(e.message || `${action}失败`);
        }
      },
    });
  };

  const handleDeleteWorkflowDef = (def: DSWorkflowDefinition) => {
    if (parseReleaseState(def.releaseState) === ReleaseState.ONLINE) {
      setError('上线状态的工作流不能删除，请先下线');
      return;
    }
    setConfirmModal({
      message: `确定要删除工作流定义「${def.name}」吗？此操作不可恢复。`,
      onConfirm: async () => {
        setConfirmModal(null);
        try {
          const res = await api.workflowDefinition.delete(project.code, def.code);
          if (res.code === 0) {
            fetchWorkflowDefs();
          } else {
            setError(res.msg || '删除失败');
          }
        } catch (e: any) {
          setError(e.message || '删除失败');
        }
      },
    });
  };

  const handleTriggerWorkflow = (def: DSWorkflowDefinition) => {
    setConfirmModal({
      message: `确定要运行工作流「${def.name}」吗？`,
      onConfirm: async () => {
        setConfirmModal(null);
        try {
          const res = await api.workflowDefinition.trigger(project.code, { processDefinitionCode: def.code });
          if (res.code === 0) {
            setProjectSubTab('workflowInstances');
          } else {
            setError(res.msg || '运行工作流失败');
          }
        } catch (e: any) {
          setError(e.message || '运行失败');
        }
      },
    });
  };

  const handleCopyWorkflowDef = (def: DSWorkflowDefinition) => {
    setInputModal({
      title: '复制工作流',
      fields: [
        { key: 'name', label: '工作流名称', placeholder: '请输入新工作流名称', required: true, defaultValue: `${def.name}_copy` },
      ],
      onConfirm: async (values) => {
        if (!values.name?.trim()) return;
        setInputModal(null);
        try {
          const res = await api.workflowDefinition.create(project.code, {
            name: values.name.trim(),
            description: def.description || '',
          });
          if (res.code === 0) {
            fetchWorkflowDefs();
          } else {
            setError(res.msg || '复制工作流失败');
          }
        } catch (e: any) {
          setError(e.message || '复制失败');
        }
      },
      onCancel: () => setInputModal(null),
    });
  };

  const handleExecuteWorkflowInstance = (instance: DSWorkflowInstance, executeType: string) => {
    const actionMap: Record<string, string> = {
      STOP: '停止',
      REPEAT_RUNNING: '重跑',
      RESUME_WAITING_THREAD: '恢复',
      PAUSE: '暂停',
    };
    setConfirmModal({
      message: `确定要${actionMap[executeType] || executeType}工作流实例「${instance.name}」吗？`,
      onConfirm: async () => {
        setConfirmModal(null);
        try {
          const res = await api.workflowInstance.execute(instance.id, executeType, project.code);
          if (res.code === 0) {
            fetchWorkflowInstances();
            if (viewingWorkflowInstance?.id === instance.id) {
              const detailRes = await api.workflowInstance.detail(instance.id, project.code);
              if (detailRes.code === 0 && detailRes.data) {
                setViewingWorkflowInstance({
                  ...detailRes.data,
                  state: WORKFLOW_STATE_STRING_TO_ENUM[detailRes.data.state] ?? detailRes.data.state,
                });
              }
            }
          } else {
            setError(res.msg || '操作失败');
          }
        } catch (e: any) {
          setError(e.message || '操作失败');
        }
      },
    });
  };

  const handleViewTaskLog = async (task: DSTaskInstance) => {
    setLogModal({ log: '', loading: true });
    try {
      const res = await api.taskInstance.log(task.projectCode, task.id);
      if (res.code === 0) {
        const logData = res.data as any;
        const logMessage = typeof logData === 'string' ? logData : logData?.message || '';
        setLogModal({ log: logMessage, loading: false });
      } else {
        setLogModal({ log: res.msg || '获取日志失败', loading: false });
      }
    } catch (e: any) {
      setLogModal({ log: e.message || '获取日志失败', loading: false });
    }
  };

  const handleForceSuccessTask = (task: DSTaskInstance) => {
    setConfirmModal({
      message: `确定要将任务「${task.name}」强制成功吗？`,
      onConfirm: async () => {
        setConfirmModal(null);
        try {
          const res = await api.taskInstance.forceSuccess(task.id, project.code);
          if (res.code === 0) {
            fetchTaskInstances();
          } else {
            setError(res.msg || '操作失败');
          }
        } catch (e: any) {
          setError(e.message || '操作失败');
        }
      },
    });
  };

  const renderWorkflowDefinitions = () => (
    <div className="sm-section">
      <div className="sm-section__toolbar">
        <div className="sm-section__toolbar-actions">
          <SearchBar
            value={defSearchInput}
            onChange={setDefSearchInput}
            onSearch={handleSearchDefs}
            placeholder="搜索工作流..."
          />
          <button className="sm-btn sm-btn--primary" onClick={handleCreateWorkflowDef}>
            <Plus size={14} /> 创建工作流
          </button>
          <button className="sm-btn sm-btn--ghost" onClick={fetchWorkflowDefs} title="刷新">
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      <div className="sm-table-wrapper">
        <table className="sm-table">
          <thead>
            <tr>
              <th style={{ width: '40px' }}>#</th>
              <th>工作流名称</th>
              <th style={{ width: '60px' }}></th>
              <th style={{ width: '60px' }}></th>
              <th>状态</th>
              <th>版本</th>
              <th>描述</th>
              <th>创建人</th>
              <th>修改人</th>
              <th>创建时间</th>
              <th>更新时间</th>
              <th style={{ width: '220px' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {workflowDefs.length === 0 ? (
              <tr><td colSpan={12} className="sm-table__empty">暂无工作流定义</td></tr>
            ) : (
              workflowDefs.map((d, idx) => (
                <tr key={d.code}>
                  <td className="sm-table__index">{(workflowDefsPage - 1) * PAGE_SIZE + idx + 1}</td>
                  <td className="sm-table__name">{d.name}</td>
                  <td>
                    <button className="sm-btn sm-btn--ghost sm-btn--icon" title="复制名称" onClick={() => navigator.clipboard?.writeText(d.name)}>
                      <Copy size={12} />
                    </button>
                  </td>
                  <td>
                    <button className="sm-btn sm-btn--ghost sm-btn--icon" title="查看实例" onClick={() => setProjectSubTab('workflowInstances')}>
                      <List size={12} />
                    </button>
                  </td>
                  <td><ReleaseBadge state={d.releaseState} /></td>
                  <td className="sm-table__version">v{d.version}</td>
                  <td className="sm-table__desc" title={d.description}>{d.description || '-'}</td>
                  <td>{d.userName || '-'}</td>
                  <td>{d.userName || '-'}</td>
                  <td className="sm-table__time">{formatDateTime(d.createTime)}</td>
                  <td className="sm-table__time">{formatDateTime(d.updateTime)}</td>
                  <td className="sm-table__actions">
                    <button className="sm-btn sm-btn--ghost sm-btn--xs" title="编辑" disabled={parseReleaseState(d.releaseState) === ReleaseState.ONLINE} onClick={() => handleEditWorkflowDef(d)}>
                      <Edit3 size={12} />
                    </button>
                    <button
                      className="sm-btn sm-btn--primary sm-btn--xs"
                      onClick={() => handleTriggerWorkflow(d)}
                      title="运行"
                      disabled={parseReleaseState(d.releaseState) !== ReleaseState.ONLINE}
                    >
                      <PlayCircle size={12} />
                    </button>
                    <button
                      className={`sm-btn sm-btn--xs ${parseReleaseState(d.releaseState) === ReleaseState.ONLINE ? 'sm-btn--warning' : 'sm-btn--success'}`}
                      onClick={() => handleToggleWorkflowRelease(d)}
                      title={parseReleaseState(d.releaseState) === ReleaseState.ONLINE ? '下线' : '上线'}
                    >
                      {parseReleaseState(d.releaseState) === ReleaseState.ONLINE ? <ArrowDownCircle size={12} /> : <ArrowUpCircle size={12} />}
                    </button>
                    <button className="sm-btn sm-btn--ghost sm-btn--xs" title="定时" onClick={() => setError('定时功能开发中...')}>
                      <Clock size={12} />
                    </button>
                    <button className="sm-btn sm-btn--ghost sm-btn--xs" title="复制" onClick={() => handleCopyWorkflowDef(d)}>
                      <Copy size={12} />
                    </button>
                    <button className="sm-btn sm-btn--danger sm-btn--xs" onClick={() => handleDeleteWorkflowDef(d)} title="删除" disabled={parseReleaseState(d.releaseState) === ReleaseState.ONLINE}>
                      <Trash2 size={12} />
                    </button>
                    <button className="sm-btn sm-btn--ghost sm-btn--xs" title="树形图" onClick={() => setError('树形图功能开发中...')}>
                      <TreePine size={12} />
                    </button>
                    <button className="sm-btn sm-btn--ghost sm-btn--xs" title="版本信息" onClick={() => setError('版本信息功能开发中...')}>
                      <Info size={12} />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <Pagination current={workflowDefsPage} total={workflowDefsTotal} onPageChange={p => setWorkflowDefsPage(p)} />
    </div>
  );

  const renderWorkflowInstances = () => (
    <div className="sm-section">
      <div className="sm-section__toolbar">
        <div className="sm-section__toolbar-actions">
          <SearchBar
            value={instSearchInput}
            onChange={setInstSearchInput}
            onSearch={handleSearchInstances}
            placeholder="搜索工作流实例..."
          />
          <select
            className="sm-select"
            value={workflowInstanceStatusFilter}
            onChange={e => { setWorkflowInstanceStatusFilter(e.target.value); setWorkflowInstancesPage(1); }}
          >
            <option value="">全部状态</option>
            <option value="1">运行中</option>
            <option value="7">成功</option>
            <option value="6">失败</option>
            <option value="3">已暂停</option>
            <option value="5">已停止</option>
          </select>
          <button className="sm-btn sm-btn--ghost" onClick={() => fetchWorkflowInstances()} title="刷新">
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      <div className="sm-table-wrapper">
        <table className="sm-table">
          <thead>
            <tr>
              <th style={{ width: '40px' }}>#</th>
              <th>实例名称</th>
              <th>状态</th>
              <th>运行类型</th>
              <th>调度时间</th>
              <th>开始时间</th>
              <th>结束时间</th>
              <th>耗时</th>
              <th>运行次数</th>
              <th>执行人</th>
              <th>Host</th>
              <th style={{ width: '160px' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {workflowInstances.length === 0 ? (
              <tr><td colSpan={12} className="sm-table__empty">暂无工作流实例</td></tr>
            ) : (
              workflowInstances.map((inst, idx) => (
                <tr key={inst.id}>
                  <td className="sm-table__index">{(workflowInstancesPage - 1) * PAGE_SIZE + idx + 1}</td>
                  <td className="sm-table__name">
                    <button className="sm-table__link" onClick={() => setViewingWorkflowInstance(inst)}>
                      {inst.name}
                    </button>
                  </td>
                  <td><StatusBadge status={inst.state} configMap={WORKFLOW_STATUS_CONFIG} /></td>
                  <td className="sm-table__type">START_PROCESS</td>
                  <td className="sm-table__time">{formatDateTime(inst.scheduleTime)}</td>
                  <td className="sm-table__time">{formatDateTime(inst.startTime)}</td>
                  <td className="sm-table__time">{formatDateTime(inst.endTime)}</td>
                  <td>{formatDuration(inst.duration)}</td>
                  <td className="sm-table__count">{inst.runTimes}</td>
                  <td>{inst.executorName || '-'}</td>
                  <td className="sm-table__host">{inst.host || '-'}</td>
                  <td className="sm-table__actions">
                    {(inst.state === WorkflowExecutionStatus.FAILURE || inst.state === WorkflowExecutionStatus.STOP) && (
                      <button className="sm-btn sm-btn--primary sm-btn--xs" onClick={() => handleExecuteWorkflowInstance(inst, 'REPEAT_RUNNING')} title="重跑">
                        <RotateCcw size={12} />
                      </button>
                    )}
                    {inst.state === WorkflowExecutionStatus.FAILURE && (
                      <button className="sm-btn sm-btn--success sm-btn--xs" onClick={() => handleExecuteWorkflowInstance(inst, 'RESUME_WAITING_THREAD')} title="恢复">
                        <Play size={12} />
                      </button>
                    )}
                    {inst.state === WorkflowExecutionStatus.RUNNING_EXECUTION && (
                      <>
                        <button className="sm-btn sm-btn--warning sm-btn--xs" onClick={() => handleExecuteWorkflowInstance(inst, 'PAUSE')} title="暂停">
                          <Pause size={12} />
                        </button>
                        <button className="sm-btn sm-btn--danger sm-btn--xs" onClick={() => handleExecuteWorkflowInstance(inst, 'STOP')} title="停止">
                          <StopCircle size={12} />
                        </button>
                      </>
                    )}
                    {inst.state === WorkflowExecutionStatus.PAUSE && (
                      <button className="sm-btn sm-btn--primary sm-btn--xs" onClick={() => handleExecuteWorkflowInstance(inst, 'RESUME_WAITING_THREAD')} title="恢复">
                        <Play size={12} />
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <Pagination current={workflowInstancesPage} total={workflowInstancesTotal} onPageChange={p => setWorkflowInstancesPage(p)} />
    </div>
  );

  const renderTaskInstances = () => (
    <div className="sm-section">
      <div className="sm-section__toolbar">
        <div className="sm-section__toolbar-actions">
          <SearchBar
            value={taskSearchInput}
            onChange={setTaskSearchInput}
            onSearch={handleSearchTasks}
            placeholder="搜索任务实例..."
          />
          <select
            className="sm-select"
            value={taskInstanceStatusFilter}
            onChange={e => { setTaskInstanceStatusFilter(e.target.value); setTaskInstancesPage(1); }}
          >
            <option value="">全部状态</option>
            <option value="1">运行中</option>
            <option value="7">成功</option>
            <option value="6">失败</option>
            <option value="5">已停止</option>
            <option value="9">已Kill</option>
          </select>
          <button className="sm-btn sm-btn--ghost" onClick={() => fetchTaskInstances()} title="刷新">
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      <div className="sm-table-wrapper">
        <table className="sm-table">
          <thead>
            <tr>
              <th style={{ width: '40px' }}>#</th>
              <th>任务名称</th>
              <th>任务类型</th>
              <th>状态</th>
              <th>工作流实例</th>
              <th>执行人</th>
              <th>开始时间</th>
              <th>结束时间</th>
              <th>耗时</th>
              <th>重试次数</th>
              <th>Host</th>
              <th style={{ width: '120px' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {taskInstances.length === 0 ? (
              <tr><td colSpan={12} className="sm-table__empty">暂无任务实例</td></tr>
            ) : (
              taskInstances.map((t, idx) => (
                <tr key={t.id}>
                  <td className="sm-table__index">{(taskInstancesPage - 1) * PAGE_SIZE + idx + 1}</td>
                  <td className="sm-table__name">
                    <button className="sm-table__link" onClick={() => setViewingTaskInstance(t)}>
                      {t.name}
                    </button>
                  </td>
                  <td><TaskTypeBadge type={t.taskType} /></td>
                  <td><StatusBadge status={t.state} configMap={TASK_STATUS_CONFIG} /></td>
                  <td className="sm-table__desc" title={t.processInstanceName}>{t.processInstanceName || '-'}</td>
                  <td>{t.executorName || '-'}</td>
                  <td className="sm-table__time">{formatDateTime(t.startTime)}</td>
                  <td className="sm-table__time">{formatDateTime(t.endTime)}</td>
                  <td>{formatDuration(t.duration)}</td>
                  <td className="sm-table__count">{t.retryTimes}</td>
                  <td className="sm-table__host">{t.host || '-'}</td>
                  <td className="sm-table__actions">
                    <button className="sm-btn sm-btn--ghost sm-btn--xs" onClick={() => handleViewTaskLog(t)} title="查看日志">
                      <Eye size={12} />
                    </button>
                    {(t.state === TaskExecutionStatus.FAILURE || t.state === TaskExecutionStatus.KILL || t.state === TaskExecutionStatus.NEED_FAULT_TOLERANCE) && (
                      <button className="sm-btn sm-btn--warning sm-btn--xs" onClick={() => handleForceSuccessTask(t)} title="强制成功">
                        <CheckCircle size={12} />
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <Pagination current={taskInstancesPage} total={taskInstancesTotal} onPageChange={p => setTaskInstancesPage(p)} />
    </div>
  );

  // 编辑器与详情视图需要占满整个标签页内容区（无内边距、不滚动外层）
  const fullScreenView = editingWorkflow ? (
    <WorkflowDefinitionEditor
      key={editingWorkflow.mode === 'edit' && editingWorkflow.definition ? `edit-${editingWorkflow.definition.code}` : 'create'}
      workflowName={editingWorkflow.mode === 'edit' && editingWorkflow.definition ? editingWorkflow.definition.name : '新建工作流'}
      description={editingWorkflow.mode === 'edit' && editingWorkflow.definition ? editingWorkflow.definition.description : ''}
      existingNodes={editingWorkflow.nodes}
      existingEdges={editingWorkflow.edges}
      existingGlobalParams={editingWorkflow.globalParams}
      existingExecutionType={editingWorkflow.mode === 'edit' && editingWorkflow.definition ? editingWorkflow.definition.executionType : undefined}
      existingTimeout={editingWorkflow.mode === 'edit' && editingWorkflow.definition ? editingWorkflow.definition.timeout : undefined}
      readonly={editingWorkflow.mode === 'edit' && editingWorkflow.definition ? parseReleaseState(editingWorkflow.definition.releaseState) === ReleaseState.ONLINE : false}
      workflowDefinitions={workflowDefs.map(d => ({ code: d.code, name: d.name }))}
      workerGroups={workerGroups}
      environments={environments}
      alertGroups={alertGroups}
      api={api}
      onSave={handleSaveWorkflow}
      onTrigger={editingWorkflow.mode === 'edit' && editingWorkflow.definition ? (form) => handleTriggerWorkflowWithForm(editingWorkflow.definition!.code, form) : undefined}
      onClose={() => setEditingWorkflow(null)}
    />
  ) : viewingWorkflowInstance ? (
    <WorkflowInstanceDetail
      instance={viewingWorkflowInstance}
      projectCode={project.code}
      api={api}
      onBack={() => setViewingWorkflowInstance(null)}
      onExecute={handleExecuteWorkflowInstance}
      onForceSuccessTask={handleForceSuccessTask}
    />
  ) : viewingTaskInstance ? (
    <TaskInstanceDetailView
      task={viewingTaskInstance}
      api={api}
      onBack={() => setViewingTaskInstance(null)}
      onViewLog={handleViewTaskLog}
      onForceSuccess={handleForceSuccessTask}
      onViewWorkflowInstance={(processInstanceId) => {
        const inst = workflowInstances.find(i => i.id === processInstanceId);
        if (inst) {
          setViewingWorkflowInstance(inst);
          setViewingTaskInstance(null);
        }
      }}
    />
  ) : null;

  return (
    <div className={`sm-view ${fullScreenView ? 'sm-view--full' : ''}`}>
      {error && <ErrorBar message={error} onClose={() => setError(null)} />}

      {fullScreenView ? (
        <div className="sm-view__full">{fullScreenView}</div>
      ) : (
        <div className="sm-project-detail">
          <div className="sm-project-detail__header">
            <button className="sm-btn sm-btn--ghost" onClick={onBack}>
              <ArrowLeft size={14} /> 返回项目列表
            </button>
            <div className="sm-project-detail__breadcrumb">
              <FolderKanban size={14} />
              <span className="sm-project-detail__project-name">{project.name}</span>
            </div>
            {loading && (
              <span className="sm-project-detail__loading">
                <RefreshCw size={12} className="sm-spin-icon" /> 加载中...
              </span>
            )}
          </div>

          <div className="sm-project-detail__tabs">
            {PROJECT_SUB_TAB_META.map(tab => (
              <button
                key={tab.id}
                className={`sm-project-detail__tab ${projectSubTab === tab.id ? 'sm-project-detail__tab--active' : ''}`}
                onClick={() => { setProjectSubTab(tab.id); setViewingWorkflowInstance(null); setViewingTaskInstance(null); }}
              >
                {tab.icon}
                <span>{tab.label}</span>
              </button>
            ))}
          </div>

          <div className="sm-project-detail__content">
            {projectSubTab === 'workflowDefinitions' && renderWorkflowDefinitions()}
            {projectSubTab === 'workflowInstances' && renderWorkflowInstances()}
            {projectSubTab === 'taskInstances' && renderTaskInstances()}
          </div>
        </div>
      )}

      {confirmModal && (
        <ConfirmModal
          message={confirmModal.message}
          onConfirm={confirmModal.onConfirm}
          onCancel={() => setConfirmModal(null)}
        />
      )}
      {inputModal && <InputModal {...inputModal} />}
      {logModal && (
        <LogModal log={logModal.log} loading={logModal.loading} onClose={() => setLogModal(null)} />
      )}
    </div>
  );
};

export default ProjectDetailView;
