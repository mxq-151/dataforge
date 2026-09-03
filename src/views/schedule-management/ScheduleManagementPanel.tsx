import { useState, useEffect, useCallback } from 'react';
import {
  FolderKanban, GitBranch, Play, Search, Plus, Trash2,
  RefreshCw, ChevronLeft, ChevronRight, Eye, StopCircle, CheckCircle,
  AlertTriangle, FileText, ArrowLeft, Copy, List,
  Edit3, Clock, ArrowUpCircle, ArrowDownCircle, TreePine, Info,
  RotateCcw, Pause, PlayCircle,
} from 'lucide-react';
import { useDolphinSchedulerApi } from '../../contexts/DolphinSchedulerContext';
import type {
  DolphinSchedulerApi,
  DSProject, DSWorkflowDefinition, DSWorkflowInstance, DSTaskInstance,
  DSWorkflowTaskNode, DSWorkflowEdge, DSWorkflowGlobalParam, DSWorkflowTriggerForm,
  DSWorkerGroup, DSEnvironment, DSAlertGroup,
} from '../../types/dolphinscheduler';
import { ReleaseState, parseReleaseState, WorkflowExecutionStatus, TaskExecutionStatus, ExecutionType } from '../../types/dolphinscheduler';
import WorkflowDefinitionEditor from './components/WorkflowDefinitionEditor';
import WorkflowInstanceDetail from './components/WorkflowInstanceDetail';
import TaskInstanceDetailView from './components/TaskInstanceDetail';
import './ScheduleManagementPanel.css';

const PAGE_SIZE = 10;

const WORKFLOW_STATE_STRING_TO_ENUM: Record<string, WorkflowExecutionStatus> = {
  'SUBMITTED_SUCCESS': WorkflowExecutionStatus.SUBMITTED_SUCCESS,
  'RUNNING_EXECUTION': WorkflowExecutionStatus.RUNNING_EXECUTION,
  'READY_PAUSE': WorkflowExecutionStatus.READY_PAUSE,
  'PAUSE': WorkflowExecutionStatus.PAUSE,
  'READY_STOP': WorkflowExecutionStatus.READY_STOP,
  'STOP': WorkflowExecutionStatus.STOP,
  'FAILURE': WorkflowExecutionStatus.FAILURE,
  'SUCCESS': WorkflowExecutionStatus.SUCCESS,
};

const TASK_STATE_STRING_TO_ENUM: Record<string, TaskExecutionStatus> = {
  'SUBMITTED_SUCCESS': TaskExecutionStatus.SUBMITTED_SUCCESS,
  'RUNNING_EXECUTION': TaskExecutionStatus.RUNNING_EXECUTION,
  'READY_PAUSE': TaskExecutionStatus.READY_PAUSE,
  'PAUSE': TaskExecutionStatus.PAUSE,
  'READY_STOP': TaskExecutionStatus.READY_STOP,
  'STOP': TaskExecutionStatus.STOP,
  'FAILURE': TaskExecutionStatus.FAILURE,
  'SUCCESS': TaskExecutionStatus.SUCCESS,
  'NEED_FAULT_TOLERANCE': TaskExecutionStatus.NEED_FAULT_TOLERANCE,
  'KILL': TaskExecutionStatus.KILL,
  'WAITTING_THREAD': TaskExecutionStatus.WAITTING_THREAD,
  'WAITTING_DEPEND': TaskExecutionStatus.WAITTING_DEPEND,
  'DELAY_EXECUTION': TaskExecutionStatus.DELAY_EXECUTION,
};

const WORKFLOW_STATUS_CONFIG: Record<number, { label: string; color: string; bgColor: string; isSpin?: boolean }> = {
  [WorkflowExecutionStatus.SUBMITTED_SUCCESS]: { label: '提交成功', color: '#75beff', bgColor: '#1e3a5f' },
  [WorkflowExecutionStatus.RUNNING_EXECUTION]: { label: '运行中', color: '#89d185', bgColor: '#1e4d1e', isSpin: true },
  [WorkflowExecutionStatus.READY_PAUSE]: { label: '准备暂停', color: '#d1d185', bgColor: '#4d4d1e' },
  [WorkflowExecutionStatus.PAUSE]: { label: '已暂停', color: '#d1a855', bgColor: '#4d3a1e' },
  [WorkflowExecutionStatus.READY_STOP]: { label: '准备停止', color: '#d18555', bgColor: '#4d2d1e' },
  [WorkflowExecutionStatus.STOP]: { label: '已停止', color: '#999999', bgColor: '#3c3c3c' },
  [WorkflowExecutionStatus.FAILURE]: { label: '失败', color: '#f48771', bgColor: '#5a1d1d' },
  [WorkflowExecutionStatus.SUCCESS]: { label: '成功', color: '#89d185', bgColor: '#1e4d1e' },
};

const TASK_STATUS_CONFIG: Record<number, { label: string; color: string; bgColor: string; isSpin?: boolean }> = {
  [TaskExecutionStatus.SUBMITTED_SUCCESS]: { label: '提交成功', color: '#75beff', bgColor: '#1e3a5f' },
  [TaskExecutionStatus.RUNNING_EXECUTION]: { label: '运行中', color: '#89d185', bgColor: '#1e4d1e', isSpin: true },
  [TaskExecutionStatus.READY_PAUSE]: { label: '准备暂停', color: '#d1d185', bgColor: '#4d4d1e' },
  [TaskExecutionStatus.PAUSE]: { label: '已暂停', color: '#d1a855', bgColor: '#4d3a1e' },
  [TaskExecutionStatus.READY_STOP]: { label: '准备停止', color: '#d18555', bgColor: '#4d2d1e' },
  [TaskExecutionStatus.STOP]: { label: '已停止', color: '#999999', bgColor: '#3c3c3c' },
  [TaskExecutionStatus.FAILURE]: { label: '失败', color: '#f48771', bgColor: '#5a1d1d' },
  [TaskExecutionStatus.SUCCESS]: { label: '成功', color: '#89d185', bgColor: '#1e4d1e' },
  [TaskExecutionStatus.NEED_FAULT_TOLERANCE]: { label: '容错', color: '#d185d1', bgColor: '#4d1e4d' },
  [TaskExecutionStatus.KILL]: { label: '已Kill', color: '#999999', bgColor: '#3c3c3c' },
  [TaskExecutionStatus.WAITTING_THREAD]: { label: '等待线程', color: '#75beff', bgColor: '#1e3a5f' },
  [TaskExecutionStatus.WAITTING_DEPEND]: { label: '等待依赖', color: '#75beff', bgColor: '#1e3a5f' },
  [TaskExecutionStatus.DELAY_EXECUTION]: { label: '延迟执行', color: '#d1a855', bgColor: '#4d3a1e' },
};

const RELEASE_STATE_CONFIG: Record<number, { label: string; color: string; bgColor: string }> = {
  [ReleaseState.OFFLINE]: { label: '下线', color: '#999999', bgColor: '#3c3c3c' },
  [ReleaseState.ONLINE]: { label: '上线', color: '#89d185', bgColor: '#1e4d1e' },
};

type ProjectSubTab = 'workflowDefinitions' | 'workflowInstances' | 'taskInstances';

const PROJECT_SUB_TABS: { id: ProjectSubTab; label: string; icon: React.ReactNode }[] = [
  { id: 'workflowDefinitions', label: '工作流定义', icon: <GitBranch size={14} /> },
  { id: 'workflowInstances', label: '工作流实例', icon: <Play size={14} /> },
  { id: 'taskInstances', label: '任务实例', icon: <FileText size={14} /> },
];

function formatDateTime(dt: string | null | undefined): string {
  if (!dt) return '-';
  try {
    return new Date(dt).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return dt;
  }
}

function formatDuration(dur: string | null | undefined): string {
  if (!dur) return '-';
  return dur;
}

interface ConfirmModalProps {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmModal({ message, onConfirm, onCancel }: ConfirmModalProps) {
  return (
    <div className="sm-modal-overlay" onClick={onCancel}>
      <div className="sm-modal" onClick={e => e.stopPropagation()}>
        <div className="sm-modal__header">
          <AlertTriangle size={18} />
          <span>确认操作</span>
        </div>
        <div className="sm-modal__body">{message}</div>
        <div className="sm-modal__footer">
          <button className="sm-btn sm-btn--secondary" onClick={onCancel}>取消</button>
          <button className="sm-btn sm-btn--danger" onClick={onConfirm}>确认</button>
        </div>
      </div>
    </div>
  );
}

interface InputModalProps {
  title: string;
  fields: { key: string; label: string; placeholder?: string; required?: boolean; defaultValue?: string; type?: string }[];
  onConfirm: (values: Record<string, string>) => void;
  onCancel: () => void;
}

function InputModal({ title, fields, onConfirm, onCancel }: InputModalProps) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    fields.forEach(f => { init[f.key] = f.defaultValue || ''; });
    return init;
  });

  return (
    <div className="sm-modal-overlay" onClick={onCancel}>
      <div className="sm-modal" onClick={e => e.stopPropagation()}>
        <div className="sm-modal__header">
          <Plus size={18} />
          <span>{title}</span>
        </div>
        <div className="sm-modal__body">
          {fields.map(f => (
            <div key={f.key} className="sm-modal__field">
              <label>{f.label}{f.required && <span className="sm-required">*</span>}</label>
              {f.type === 'textarea' ? (
                <textarea
                  placeholder={f.placeholder || ''}
                  value={values[f.key] || ''}
                  onChange={e => setValues(prev => ({ ...prev, [f.key]: e.target.value }))}
                  rows={6}
                  className="sm-modal__textarea"
                />
              ) : (
                <input
                  type={f.type || 'text'}
                  placeholder={f.placeholder || ''}
                  value={values[f.key] || ''}
                  onChange={e => setValues(prev => ({ ...prev, [f.key]: e.target.value }))}
                />
              )}
            </div>
          ))}
        </div>
        <div className="sm-modal__footer">
          <button className="sm-btn sm-btn--secondary" onClick={onCancel}>取消</button>
          <button className="sm-btn sm-btn--primary" onClick={() => onConfirm(values)}>确认</button>
        </div>
      </div>
    </div>
  );
}

interface LogModalProps {
  log: string;
  loading: boolean;
  onClose: () => void;
}

function LogModal({ log, loading, onClose }: LogModalProps) {
  return (
    <div className="sm-modal-overlay" onClick={onClose}>
      <div className="sm-modal sm-modal--log" onClick={e => e.stopPropagation()}>
        <div className="sm-modal__header">
          <FileText size={18} />
          <span>任务日志</span>
        </div>
        <div className="sm-modal__body sm-modal__body--log">
          {loading ? (
            <div className="sm-loading">加载中...</div>
          ) : (
            <pre className="sm-log-content">{log || '暂无日志'}</pre>
          )}
        </div>
        <div className="sm-modal__footer">
          <button className="sm-btn sm-btn--secondary" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status, configMap }: { status: number; configMap: Record<number, { label: string; color: string; bgColor: string; isSpin?: boolean }> }) {
  const cfg = configMap[status];
  if (!cfg) return <span className="sm-status-badge">未知</span>;
  return (
    <span className="sm-status-badge" style={{ color: cfg.color, backgroundColor: cfg.bgColor }}>
      {cfg.isSpin && <RefreshCw size={10} className="sm-spin-icon" />}
      {cfg.label}
    </span>
  );
}

function ReleaseBadge({ state }: { state: ReleaseState | string }) {
  const normalized = parseReleaseState(state);
  const cfg = RELEASE_STATE_CONFIG[normalized];
  if (!cfg) return <span className="sm-status-badge">未知</span>;
  return <span className="sm-status-badge" style={{ color: cfg.color, backgroundColor: cfg.bgColor }}>{cfg.label}</span>;
}

function TaskTypeBadge({ type }: { type: string }) {
  return <span className="sm-task-type">{type}</span>;
}

const ScheduleManagementPanelInner: React.FC<{ api: DolphinSchedulerApi }> = ({ api }) => {
  const [currentProject, setCurrentProject] = useState<DSProject | null>(null);
  const [projectSubTab, setProjectSubTab] = useState<ProjectSubTab>('workflowDefinitions');

  const [editingWorkflow, setEditingWorkflow] = useState<{
    mode: 'create' | 'edit';
    definition?: DSWorkflowDefinition;
    nodes: DSWorkflowTaskNode[];
    edges: DSWorkflowEdge[];
    globalParams: DSWorkflowGlobalParam[];
  } | null>(null);

  const [projects, setProjects] = useState<DSProject[]>([]);
  const [projectsTotal, setProjectsTotal] = useState(0);
  const [projectsPage, setProjectsPage] = useState(1);
  const [projectsSearch, setProjectsSearch] = useState('');

  const [workflowDefs, setWorkflowDefs] = useState<DSWorkflowDefinition[]>([]);
  const [workflowDefsTotal, setWorkflowDefsTotal] = useState(0);
  const [workflowDefsPage, setWorkflowDefsPage] = useState(1);
  const [workflowDefsSearch, setWorkflowDefsSearch] = useState('');

  const [workflowInstances, setWorkflowInstances] = useState<DSWorkflowInstance[]>([]);
  const [workflowInstancesTotal, setWorkflowInstancesTotal] = useState(0);
  const [workflowInstancesPage, setWorkflowInstancesPage] = useState(1);
  const [workflowInstancesSearch, setWorkflowInstancesSearch] = useState('');
  const [workflowInstanceStatusFilter, setWorkflowInstanceStatusFilter] = useState<string>('');

  const [taskInstances, setTaskInstances] = useState<DSTaskInstance[]>([]);
  const [taskInstancesTotal, setTaskInstancesTotal] = useState(0);
  const [taskInstancesPage, setTaskInstancesPage] = useState(1);
  const [taskInstancesSearch, setTaskInstancesSearch] = useState('');
  const [taskInstanceStatusFilter, setTaskInstanceStatusFilter] = useState<string>('');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [confirmModal, setConfirmModal] = useState<{ message: string; onConfirm: () => void } | null>(null);
  const [inputModal, setInputModal] = useState<InputModalProps | null>(null);
  const [logModal, setLogModal] = useState<{ log: string; loading: boolean } | null>(null);

  const [viewingWorkflowInstance, setViewingWorkflowInstance] = useState<DSWorkflowInstance | null>(null);
  const [viewingTaskInstance, setViewingTaskInstance] = useState<DSTaskInstance | null>(null);

  const [workerGroups, setWorkerGroups] = useState<DSWorkerGroup[]>([]);
  const [environments, setEnvironments] = useState<DSEnvironment[]>([]);
  const [alertGroups, setAlertGroups] = useState<DSAlertGroup[]>([]);

  const fetchProjects = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.project.list({
        pageNo: projectsPage,
        pageSize: PAGE_SIZE,
        searchVal: projectsSearch || undefined,
      });
      if (res.code === 0 && res.data) {
        setProjects(res.data.totalList || []);
        setProjectsTotal(res.data.total || 0);
      } else {
        setError(res.msg || '获取项目列表失败');
      }
    } catch (e: any) {
      setError(e.message || '请求失败');
    } finally {
      setLoading(false);
    }
  }, [projectsPage, projectsSearch]);

  const fetchWorkflowDefs = useCallback(async () => {
    if (!currentProject) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.workflowDefinition.list(currentProject.code, {
        pageNo: workflowDefsPage,
        pageSize: PAGE_SIZE,
        searchVal: workflowDefsSearch || undefined,
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
  }, [currentProject, workflowDefsPage, workflowDefsSearch]);

  const fetchWorkflowInstances = useCallback(async (silent = false) => {
    if (!currentProject) return;
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const res = await api.workflowInstance.list({
        pageNo: workflowInstancesPage,
        pageSize: PAGE_SIZE,
        searchVal: workflowInstancesSearch || undefined,
        projectCode: currentProject?.code?.toString() || undefined,
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
  }, [currentProject, workflowInstancesPage, workflowInstancesSearch, workflowInstanceStatusFilter]);

  const fetchTaskInstances = useCallback(async (silent = false) => {
    if (!currentProject) return;
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const res = await api.taskInstance.list({
        pageNo: taskInstancesPage,
        pageSize: PAGE_SIZE,
        searchVal: taskInstancesSearch || undefined,
        projectCode: currentProject?.code?.toString() || undefined,
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
  }, [currentProject, taskInstancesPage, taskInstancesSearch, taskInstanceStatusFilter]);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  useEffect(() => {
    const fetchConfigData = async () => {
      try {
        const promises: Promise<any>[] = [
          api.environment.list({ pageNo: 1, pageSize: 100 }),
          api.alertGroup.list({ pageNo: 1, pageSize: 100 }),
        ];
        if (currentProject) {
          promises.unshift(api.workerGroup.list(currentProject.code, { pageNo: 1, pageSize: 100 }));
        }
        const results = await Promise.all(promises);
        let idx = 0;
        if (currentProject) {
          const wgRes = results[idx++];
          const wgSuccess = wgRes.code === 0 || wgRes.status === 'SUCCESS';
          if (wgSuccess && wgRes.data) {
            const list = Array.isArray(wgRes.data) ? wgRes.data : (wgRes.data.totalList || []);
            console.log('[ScheduleManagement] Worker groups loaded:', list.length, list);
            setWorkerGroups(list);
          } else {
            console.warn('[ScheduleManagement] Worker groups response:', wgRes);
          }
        }
        const envRes = results[idx++];
        const agRes = results[idx];
        if (envRes.code === 0 && envRes.data) {
          const list = Array.isArray(envRes.data) ? envRes.data : (envRes.data.totalList || []);
          console.log('[ScheduleManagement] Environments loaded:', list.length, list);
          setEnvironments(list);
        } else {
          console.warn('[ScheduleManagement] Environments response:', envRes);
        }
        if ((agRes.code === 0 || agRes.status === 'SUCCESS') && agRes.data) {
          const list = Array.isArray(agRes.data) ? agRes.data : (agRes.data.totalList || []);
          console.log('[ScheduleManagement] Alert groups loaded:', list.length, list);
          setAlertGroups(list);
        } else {
          console.warn('[ScheduleManagement] Alert groups response:', agRes);
        }
      } catch (err) {
        console.error('[ScheduleManagement] Failed to load config data:', err);
      }
    };
    fetchConfigData();
  }, [api, currentProject]);

  useEffect(() => {
    if (currentProject && projectSubTab === 'workflowDefinitions') {
      fetchWorkflowDefs();
    }
  }, [fetchWorkflowDefs, projectSubTab]);

  useEffect(() => {
    if (currentProject && projectSubTab === 'workflowInstances') {
      fetchWorkflowInstances();
    }
  }, [fetchWorkflowInstances, projectSubTab]);

  useEffect(() => {
    if (currentProject && projectSubTab === 'taskInstances') {
      fetchTaskInstances();
    }
  }, [fetchTaskInstances, projectSubTab]);

  // 工作流实例列表定时刷新：每 5 秒静默刷新当前激活的列表（进入详情视图时暂停）
  useEffect(() => {
    if (!currentProject || projectSubTab !== 'workflowInstances') return;
    if (viewingWorkflowInstance || viewingTaskInstance) return;
    const timer = setInterval(() => {
      fetchWorkflowInstances(true);
    }, 5000);
    return () => clearInterval(timer);
  }, [currentProject, projectSubTab, viewingWorkflowInstance, viewingTaskInstance, fetchWorkflowInstances]);

  // 任务实例列表定时刷新：每 5 秒静默刷新当前激活的列表（进入详情视图时暂停）
  useEffect(() => {
    if (!currentProject || projectSubTab !== 'taskInstances') return;
    if (viewingWorkflowInstance || viewingTaskInstance) return;
    const timer = setInterval(() => {
      fetchTaskInstances(true);
    }, 5000);
    return () => clearInterval(timer);
  }, [currentProject, projectSubTab, viewingWorkflowInstance, viewingTaskInstance, fetchTaskInstances]);

  const handleEnterProject = (project: DSProject) => {
    setCurrentProject(project);
    setProjectSubTab('workflowDefinitions');
    setWorkflowDefsPage(1);
    setWorkflowInstancesPage(1);
    setTaskInstancesPage(1);
    setWorkflowDefsSearch('');
    setWorkflowInstancesSearch('');
    setTaskInstancesSearch('');
    setWorkflowInstanceStatusFilter('');
    setTaskInstanceStatusFilter('');
  };

  const handleBackToProjects = () => {
    setCurrentProject(null);
    setWorkflowDefs([]);
    setWorkflowInstances([]);
    setTaskInstances([]);
    setViewingWorkflowInstance(null);
    setViewingTaskInstance(null);
  };

  const handleCreateProject = () => {
    setInputModal({
      title: '创建项目',
      fields: [
        { key: 'projectName', label: '项目名称', placeholder: '请输入项目名称', required: true },
        { key: 'description', label: '项目描述', placeholder: '请输入项目描述', type: 'textarea' },
      ],
      onConfirm: async (values) => {
        if (!values.projectName?.trim()) return;
        setInputModal(null);
        try {
          const res = await api.project.create({
            projectName: values.projectName.trim(),
            description: values.description?.trim(),
          });
          if (res.code === 0) {
            fetchProjects();
          } else {
            setError(res.msg || '创建项目失败');
          }
        } catch (e: any) {
          setError(e.message || '创建失败');
        }
      },
      onCancel: () => setInputModal(null),
    });
  };

  const handleEditProject = (project: DSProject) => {
    setInputModal({
      title: '编辑项目',
      fields: [
        { key: 'projectName', label: '项目名称', placeholder: '请输入项目名称', required: true, defaultValue: project.name },
        { key: 'description', label: '项目描述', placeholder: '请输入项目描述', type: 'textarea', defaultValue: project.description },
      ],
      onConfirm: async (values) => {
        if (!values.projectName?.trim()) return;
        setInputModal(null);
        try {
          const res = await api.project.update(project.code, {
            projectName: values.projectName.trim(),
            description: values.description?.trim(),
          });
          if (res.code === 0) {
            fetchProjects();
          } else {
            setError(res.msg || '编辑项目失败');
          }
        } catch (e: any) {
          setError(e.message || '编辑失败');
        }
      },
      onCancel: () => setInputModal(null),
    });
  };

  const handleDeleteProject = (project: DSProject) => {
    setConfirmModal({
      message: `确定要删除项目「${project.name}」吗？此操作不可恢复。`,
      onConfirm: async () => {
        setConfirmModal(null);
        try {
          const res = await api.project.delete(project.code);
          if (res.code === 0) {
            if (currentProject?.code === project.code) {
              handleBackToProjects();
            }
            fetchProjects();
          } else {
            setError(res.msg || '删除项目失败');
          }
        } catch (e: any) {
          setError(e.message || '删除失败');
        }
      },
    });
  };

  const handleCreateWorkflowDef = () => {
    setEditingWorkflow({
      mode: 'create',
      nodes: [],
      edges: [],
      globalParams: [],
    });
  };

  const handleEditWorkflowDef = async (def: DSWorkflowDefinition) => {
    if (parseReleaseState(def.releaseState) === ReleaseState.ONLINE) {
      setError('上线状态的工作流不能编辑，请先下线');
      return;
    }
    try {
      setLoading(true);
      const res = await api.workflowDefinition.detail(currentProject!.code, def.code);
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
    if (!currentProject) return;
    try {
      if (editingWorkflow?.mode === 'edit' && editingWorkflow.definition) {
        if (!editingWorkflow.definition.code) {
          setError('工作流定义 code 缺失，无法更新，请重新打开编辑');
          return;
        }
        const res = await api.workflowDefinition.update(
          currentProject.code,
          editingWorkflow.definition.code,
          data,
        );
        if (res.code === 0) {
          setEditingWorkflow(null);
          fetchWorkflowDefs();
        } else {
          setError(res.msg || '保存工作流失败');
        }
      } else {
        const res = await api.workflowDefinition.createWithTasks(
          currentProject.code,
          data,
        );
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
    if (!currentProject) return;
    try {
      const res = await api.workflowDefinition.trigger(currentProject.code, {
        processDefinitionCode: defCode,
      });
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
          const res = await api.workflowDefinition.release(currentProject!.code, def.code, targetState);
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
          const res = await api.workflowDefinition.delete(currentProject!.code, def.code);
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
          const res = await api.workflowDefinition.trigger(currentProject!.code, {
            processDefinitionCode: def.code,
          });
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
          const res = await api.workflowDefinition.create(
            currentProject!.code,
            { name: values.name.trim(), description: def.description || '' },
          );
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
          const res = await api.workflowInstance.execute(instance.id, executeType, currentProject!.code);
          if (res.code === 0) {
            fetchWorkflowInstances();
            if (viewingWorkflowInstance?.id === instance.id) {
              const detailRes = await api.workflowInstance.detail(instance.id, currentProject!.code);
              if (detailRes.code === 0 && detailRes.data) {
                const detail = {
                  ...detailRes.data,
                  state: WORKFLOW_STATE_STRING_TO_ENUM[detailRes.data.state] ?? detailRes.data.state,
                };
                setViewingWorkflowInstance(detail);
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
        const logMessage = typeof logData === 'string'
          ? logData
          : logData?.message || '';
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
          const res = await api.taskInstance.forceSuccess(task.id, currentProject?.code);
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

  const renderPagination = (current: number, total: number, onPageChange: (p: number) => void) => {
    const totalPages = Math.ceil(total / PAGE_SIZE);
    if (totalPages <= 1) return null;
    return (
      <div className="sm-pagination">
        <button className="sm-pagination__btn" disabled={current <= 1} onClick={() => onPageChange(current - 1)}>
          <ChevronLeft size={14} />
        </button>
        <span className="sm-pagination__info">{current} / {totalPages}</span>
        <button className="sm-pagination__btn" disabled={current >= totalPages} onClick={() => onPageChange(current + 1)}>
          <ChevronRight size={14} />
        </button>
        <span className="sm-pagination__total">共 {total} 条</span>
      </div>
    );
  };

  const renderSearchBar = (
    value: string,
    onChange: (v: string) => void,
    onSearch: () => void,
    placeholder: string = '搜索...',
  ) => (
    <div className="sm-search-bar">
      <Search size={14} className="sm-search-bar__icon" />
      <input
        className="sm-search-bar__input"
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && onSearch()}
      />
    </div>
  );

  const renderProjectList = () => (
    <div className="sm-section">
      <div className="sm-section__toolbar">
        <h2 className="sm-section__title">
          <FolderKanban size={16} />
          项目管理
        </h2>
        <div className="sm-section__toolbar-actions">
          {renderSearchBar(projectsSearch, setProjectsSearch, () => { setProjectsPage(1); fetchProjects(); }, '搜索项目...')}
          <button className="sm-btn sm-btn--primary" onClick={handleCreateProject}>
            <Plus size={14} /> 创建项目
          </button>
          <button className="sm-btn sm-btn--ghost" onClick={fetchProjects}>
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      <div className="sm-table-wrapper">
        <table className="sm-table">
          <thead>
            <tr>
              <th style={{ width: '40px' }}>#</th>
              <th>项目名称</th>
              <th>描述</th>
              <th>负责人</th>
              <th>工作流数</th>
              <th>创建时间</th>
              <th>更新时间</th>
              <th style={{ width: '140px' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {projects.length === 0 ? (
              <tr><td colSpan={8} className="sm-table__empty">暂无项目数据</td></tr>
            ) : (
              projects.map((p, idx) => (
                <tr key={p.code}>
                  <td className="sm-table__index">{(projectsPage - 1) * PAGE_SIZE + idx + 1}</td>
                  <td className="sm-table__name">
                    <button className="sm-table__link" onClick={() => handleEnterProject(p)}>
                      {p.name}
                    </button>
                  </td>
                  <td className="sm-table__desc" title={p.description}>{p.description || '-'}</td>
                  <td>{p.userName || '-'}</td>
                  <td className="sm-table__count">
                    -
                  </td>
                  <td className="sm-table__time">{formatDateTime(p.createTime)}</td>
                  <td className="sm-table__time">{formatDateTime(p.updateTime)}</td>
                  <td className="sm-table__actions">
                    <button className="sm-btn sm-btn--ghost sm-btn--xs" onClick={() => handleEnterProject(p)} title="进入项目">
                      <Play size={12} />
                    </button>
                    <button className="sm-btn sm-btn--ghost sm-btn--xs" onClick={() => handleEditProject(p)} title="编辑">
                      <Edit3 size={12} />
                    </button>
                    <button className="sm-btn sm-btn--danger sm-btn--xs" onClick={() => handleDeleteProject(p)} title="删除">
                      <Trash2 size={12} />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {renderPagination(projectsPage, projectsTotal, p => setProjectsPage(p))}
    </div>
  );

  const renderProjectDetail = () => (
    <div className="sm-project-detail">
      <div className="sm-project-detail__header">
        <button className="sm-btn sm-btn--ghost" onClick={handleBackToProjects}>
          <ArrowLeft size={14} /> 返回项目列表
        </button>
        <div className="sm-project-detail__breadcrumb">
          <FolderKanban size={14} />
          <span className="sm-project-detail__project-name">{currentProject?.name}</span>
        </div>
      </div>

      <div className="sm-project-detail__tabs">
        {PROJECT_SUB_TABS.map(tab => (
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
  );

  const renderWorkflowDefinitions = () => (
    <div className="sm-section">
      <div className="sm-section__toolbar">
        <div className="sm-section__toolbar-actions">
          {renderSearchBar(workflowDefsSearch, setWorkflowDefsSearch, () => { setWorkflowDefsPage(1); fetchWorkflowDefs(); }, '搜索工作流...')}
          <button className="sm-btn sm-btn--primary" onClick={handleCreateWorkflowDef}>
            <Plus size={14} /> 创建工作流
          </button>
          <button className="sm-btn sm-btn--ghost" onClick={fetchWorkflowDefs}>
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
      {renderPagination(workflowDefsPage, workflowDefsTotal, p => setWorkflowDefsPage(p))}
    </div>
  );

  const renderWorkflowInstances = () => (
    <div className="sm-section">
      <div className="sm-section__toolbar">
        <div className="sm-section__toolbar-actions">
          {renderSearchBar(workflowInstancesSearch, setWorkflowInstancesSearch, () => { setWorkflowInstancesPage(1); fetchWorkflowInstances(); }, '搜索工作流实例...')}
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
          <button className="sm-btn sm-btn--ghost" onClick={() => fetchWorkflowInstances()}>
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
      {renderPagination(workflowInstancesPage, workflowInstancesTotal, p => setWorkflowInstancesPage(p))}
    </div>
  );

  const renderTaskInstances = () => (
    <div className="sm-section">
      <div className="sm-section__toolbar">
        <div className="sm-section__toolbar-actions">
          {renderSearchBar(taskInstancesSearch, setTaskInstancesSearch, () => { setTaskInstancesPage(1); fetchTaskInstances(); }, '搜索任务实例...')}
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
          <button className="sm-btn sm-btn--ghost" onClick={() => fetchTaskInstances()}>
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
      {renderPagination(taskInstancesPage, taskInstancesTotal, p => setTaskInstancesPage(p))}
    </div>
  );

  return (
    <div className="schedule-management">
      <div className="sm-main">
        {error && (
          <div className="sm-error-bar">
            <AlertTriangle size={14} />
            <span>{error}</span>
            <button className="sm-error-bar__close" onClick={() => setError(null)}>×</button>
          </div>
        )}

        {loading && (
          <div className="sm-loading-bar">
            <RefreshCw size={14} className="sm-spin" />
            <span>加载中...</span>
          </div>
        )}

        <div className={`sm-content ${editingWorkflow || viewingWorkflowInstance || viewingTaskInstance ? 'sm-content--full' : ''}`}>
          {editingWorkflow ? (
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
              projectCode={currentProject!.code}
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
          ) : currentProject ? renderProjectDetail() : renderProjectList()}
        </div>
      </div>

      {confirmModal && (
        <ConfirmModal
          message={confirmModal.message}
          onConfirm={confirmModal.onConfirm}
          onCancel={() => setConfirmModal(null)}
        />
      )}
      {inputModal && (
        <InputModal {...inputModal} />
      )}
      {logModal && (
        <LogModal
          log={logModal.log}
          loading={logModal.loading}
          onClose={() => setLogModal(null)}
        />
      )}
    </div>
  );
};

const ScheduleManagementPanel: React.FC = () => {
  const { api } = useDolphinSchedulerApi();

  if (!api) {
    return (
      <div className="sm-panel">
        <div className="sm-empty" style={{ padding: 48, textAlign: 'center' }}>
          <AlertTriangle size={48} style={{ color: '#e74c3c', marginBottom: 16 }} />
          <h3 style={{ marginBottom: 8 }}>未配置调度系统</h3>
          <p style={{ color: '#888' }}>请在设置中配置DolphinScheduler API地址和Token后再使用调度管理功能。</p>
        </div>
      </div>
    );
  }

  return <ScheduleManagementPanelInner api={api} />;
};

export default ScheduleManagementPanel;
