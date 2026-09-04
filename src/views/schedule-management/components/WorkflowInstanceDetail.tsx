import { useState, useEffect, useCallback, useRef } from 'react';
import {
  ArrowLeft, ZoomIn, ZoomOut, Maximize2, Move,
  GitBranch, RefreshCw, Play, Pause, StopCircle, RotateCcw, Eye,
  CheckCircle, Clock, User, HardDrive,
} from 'lucide-react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import type { Graph, Node, Markup } from '@antv/x6';
import type {
  DSWorkflowInstance, DSTaskInstance, DSWorkflowTaskNode, DSWorkflowEdge,
  DSEnvironment, DSWorkerGroup, DolphinSchedulerApi,
} from '../../../types/dolphinscheduler';
import { WorkflowExecutionStatus, TaskExecutionStatus } from '../../../types/dolphinscheduler';
import TaskConfigModal from './task-configs/TaskConfigModal';
import DagCanvas from '../dag/DagCanvas';
import { buildGraph } from '../dag/useCustomCellBuilder';
import { NODE, NODE_STATUS_MARKUP } from '../dag/dag-config';
import './WorkflowInstanceDetail.css';

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

const NODE_STATUS_COLORS: Record<number, { border: string; bg: string; indicator: string }> = {
  [TaskExecutionStatus.SUBMITTED_SUCCESS]: { border: '#75beff', bg: '#1e3a5f', indicator: '#75beff' },
  [TaskExecutionStatus.RUNNING_EXECUTION]: { border: '#89d185', bg: '#1e4d1e', indicator: '#89d185' },
  [TaskExecutionStatus.READY_PAUSE]: { border: '#d1d185', bg: '#4d4d1e', indicator: '#d1d185' },
  [TaskExecutionStatus.PAUSE]: { border: '#d1a855', bg: '#4d3a1e', indicator: '#d1a855' },
  [TaskExecutionStatus.READY_STOP]: { border: '#d18555', bg: '#4d2d1e', indicator: '#d18555' },
  [TaskExecutionStatus.STOP]: { border: '#666666', bg: '#2d2d30', indicator: '#666666' },
  [TaskExecutionStatus.FAILURE]: { border: '#f48771', bg: '#5a1d1d', indicator: '#f48771' },
  [TaskExecutionStatus.SUCCESS]: { border: '#89d185', bg: '#1e4d1e', indicator: '#89d185' },
  [TaskExecutionStatus.NEED_FAULT_TOLERANCE]: { border: '#d185d1', bg: '#4d1e4d', indicator: '#d185d1' },
  [TaskExecutionStatus.KILL]: { border: '#666666', bg: '#2d2d30', indicator: '#666666' },
  [TaskExecutionStatus.WAITTING_THREAD]: { border: '#75beff', bg: '#1e3a5f', indicator: '#75beff' },
  [TaskExecutionStatus.WAITTING_DEPEND]: { border: '#75beff', bg: '#1e3a5f', indicator: '#75beff' },
  [TaskExecutionStatus.DELAY_EXECUTION]: { border: '#d1a855', bg: '#4d3a1e', indicator: '#d1a855' },
};

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

function formatDateTime(dt: string | null | undefined): string {
  if (!dt) return '-';
  try {
    return new Date(dt).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return dt;
  }
}

interface WorkflowInstanceDetailProps {
  instance: DSWorkflowInstance;
  projectCode: number;
  api: DolphinSchedulerApi;
  onBack: () => void;
  onExecute: (instance: DSWorkflowInstance, executeType: string) => void;
  onForceSuccessTask: (task: DSTaskInstance) => void;
}

const WorkflowInstanceDetail: React.FC<WorkflowInstanceDetailProps> = ({
  instance,
  projectCode,
  api,
  onBack,
  onExecute,
  onForceSuccessTask,
}) => {
  const [taskInstances, setTaskInstances] = useState<DSTaskInstance[]>([]);
  const [nodes, setNodes] = useState<DSWorkflowTaskNode[]>([]);
  const [edges, setEdges] = useState<DSWorkflowEdge[]>([]);
  // 当前实例最新数据，定时刷新时更新（初始为传入的实例）
  const [curInstance, setCurInstance] = useState<DSWorkflowInstance>(instance);
  const [selectedTaskCode, setSelectedTaskCode] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);
  const [rightPanelTab, setRightPanelTab] = useState<'info' | 'tasks'>('info');
  const [logContent, setLogContent] = useState<string>('');
  const [logLoading, setLogLoading] = useState(false);
  const [logTaskId, setLogTaskId] = useState<number | null>(null);
  const [viewingTaskNode, setViewingTaskNode] = useState<DSWorkflowTaskNode | null>(null);
  const [environments, setEnvironments] = useState<DSEnvironment[]>([]);
  const [workerGroups, setWorkerGroups] = useState<DSWorkerGroup[]>([]);

  // 加载环境与 Worker 组，供任务配置/详情弹窗回显环境配置与 Worker 组。
  // StrictMode 双挂载会对 effect 执行两次，用 projectCode 幂等去重，避免重复请求
  const configLoadedKey = useRef<number | null>(null);
  useEffect(() => {
    if (configLoadedKey.current === projectCode) return;
    configLoadedKey.current = projectCode;
    const loadConfigData = async () => {
      try {
        const envRes = await api.environment.list({ pageNo: 1, pageSize: 100 });
        if (envRes.code === 0 && envRes.data) {
          setEnvironments(Array.isArray(envRes.data) ? envRes.data : (envRes.data.totalList || []));
        }
        const wgRes = await api.workerGroup.list(projectCode, { pageNo: 1, pageSize: 100 });
        if (wgRes.code === 0 && wgRes.data) {
          setWorkerGroups(Array.isArray(wgRes.data) ? wgRes.data : (wgRes.data.totalList || []));
        }
      } catch (err) {
        console.warn('[WorkflowInstanceDetail] 加载环境/Worker组失败:', err);
      }
    };
    loadConfigData();
  }, [api, projectCode]);

  const graphRef = useRef<Graph | null>(null);
  // 任务状态徽标对应的 React root，graph 重建时需清理
  const statusRootsRef = useRef<Map<string, Root>>(new Map());

  const detailLoadedKey = useRef<number | null>(null);
  useEffect(() => {
    // StrictMode 双挂载会对 effect 执行两次，按 instance.id 幂等去重，避免重复请求
    if (detailLoadedKey.current === instance.id) return;
    detailLoadedKey.current = instance.id;
    const loadDetail = async () => {

      try {
        const detailRes = await api.workflowInstance.detail(instance.id, projectCode);

        if (detailRes.code === 0 && detailRes.data) {
          const fullInstance = detailRes.data as any;
          const dagData = fullInstance.dagData;

          if (dagData) {
            console.log('[WorkflowInstanceDetail] 解析 dagData...');
            const locations = JSON.parse(dagData.workflowDefinition?.locations || '[]');
            const taskDefs = dagData.taskDefinitionList || [];
            const relations = dagData.workflowTaskRelationList || [];

            const parsedNodes: DSWorkflowTaskNode[] = taskDefs.map((task: any) => {
              const location = locations.find((l: any) => l.taskCode === task.code) || {};
              return {
                code: task.code,
                name: task.name,
                taskType: task.taskType,
                description: task.description || '',
                taskParams: JSON.stringify(task.taskParams || {}),
                flag: task.flag || 'YES',
                taskPriority: task.taskPriority || 'MEDIUM',
                workerGroup: task.workerGroup || 'default',
                environmentCode: task.environmentCode || -1,
                failRetryTimes: task.failRetryTimes || 0,
                failRetryInterval: task.failRetryInterval || 1,
                timeoutFlag: task.timeoutFlag || 'CLOSE',
                timeout: task.timeout || 0,
                delayTime: task.delayTime || 0,
                x: location.x || 100,
                y: location.y || 100,
              };
            });

            const parsedEdges: DSWorkflowEdge[] = relations
              .filter((r: any) => r.preTaskCode !== 0)
              .map((r: any, index: number) => ({
                id: `${r.preTaskCode}-${r.postTaskCode}-${index}`,
                sourceCode: r.preTaskCode,
                targetCode: r.postTaskCode,
                conditionType: r.conditionType || 'NONE',
                conditionParams: r.conditionParams ? JSON.stringify(r.conditionParams) : undefined,
              }));

            console.log('[WorkflowInstanceDetail] 解析完成 - 节点数:', parsedNodes.length, '边数:', parsedEdges.length);
            setNodes(parsedNodes);
            setEdges(parsedEdges);
          } else {
            console.warn('[WorkflowInstanceDetail] dagData 为空');
          }
        }

        const taskRes = await api.workflowInstance.tasks(instance.id, projectCode);

        if (taskRes.code === 0 && taskRes.data) {
          const rawData = taskRes.data as any;
          const rawTasks = Array.isArray(rawData?.taskList)
            ? rawData.taskList
            : Array.isArray(rawData)
              ? rawData
              : [];
          console.log('[WorkflowInstanceDetail] rawTasks:', rawTasks);

          const tasks = rawTasks.map((task: any) => ({
            ...task,
            state: TASK_STATE_STRING_TO_ENUM[task.state] ?? task.state,
          }));
          console.log('[WorkflowInstanceDetail] taskInstances 数量:', tasks.length);
          setTaskInstances(tasks);
        } else {
          console.error('[WorkflowInstanceDetail] workflowInstance.tasks 返回错误:', taskRes.code, taskRes.msg);
        }
      } catch (error) {
        console.error('[WorkflowInstanceDetail] 加载数据异常:', error);
      }

      console.log('=== WorkflowInstanceDetail: 数据加载完成 ===');
    };
    loadDetail();
  }, [projectCode, instance.id, api]);

  // 工作流实例详情定时刷新：每 5 秒静默刷新当前实例信息与任务实例状态（不重建 DAG）
  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        const [detailRes, taskRes] = await Promise.all([
          api.workflowInstance.detail(instance.id, projectCode),
          api.workflowInstance.tasks(instance.id, projectCode),
        ]);
        if (detailRes.code === 0 && detailRes.data) {
          const fullInstance = detailRes.data as any;
          setCurInstance(prev => ({ ...prev, ...fullInstance }));
        }
        if (taskRes.code === 0 && taskRes.data) {
          const rawData = taskRes.data as any;
          const rawTasks = Array.isArray(rawData?.taskList)
            ? rawData.taskList
            : Array.isArray(rawData)
              ? rawData
              : [];
          setTaskInstances(rawTasks.map((task: any) => ({
            ...task,
            state: TASK_STATE_STRING_TO_ENUM[task.state] ?? task.state,
          })));
        }
      } catch (error) {
        console.warn('[WorkflowInstanceDetail] 定时刷新失败:', error);
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [instance.id, projectCode, api]);

  const taskStatusMap = new Map<number, DSTaskInstance>();
  taskInstances.forEach(t => taskStatusMap.set(t.taskCode, t));

  const handleGraphReady = useCallback((graph: Graph) => {
    graphRef.current = graph;
    // graph 重建后旧的 React root 已失效（foreignObject DOM 被重建）
    statusRootsRef.current.forEach((root) => root.unmount());
    statusRootsRef.current.clear();

    graph.on('scale', ({ sx }) => setZoom(Math.round(sx * 100) / 100));
    // 点击节点 → 联动右侧任务面板
    graph.on('node:click', ({ node }) => {
      setSelectedTaskCode(Number(node.id));
      setRightPanelTab('tasks');
      graph.cleanSelection();
      graph.select(node);
    });
    // 双击节点 → 只读查看任务配置
    graph.on('node:dblclick', ({ node }) => {
      const data = node.getData() as { task?: DSWorkflowTaskNode } | undefined;
      if (data?.task) setViewingTaskNode(data.task);
    });
    // 点击空白 → 取消选中
    graph.on('blank:click', () => {
      setSelectedTaskCode(null);
      graph.cleanSelection();
    });
  }, []);

  // 从右侧任务列表选中 → 联动画布节点高亮
  const selectNodeByCode = useCallback((code: number) => {
    setSelectedTaskCode(code);
    setRightPanelTab('tasks');
    const graph = graphRef.current;
    if (!graph) return;
    const cell = graph.getCellById(String(code));
    if (cell) {
      graph.cleanSelection();
      graph.select(cell);
    }
  }, []);

  // 回填 DAG 并叠加任务状态徽标（幂等：图已有节点时仅刷新状态）
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || nodes.length === 0) return;

    if (graph.getNodes().length === 0) {
      graph.fromJSON(buildGraph(nodes, edges));
    }

    taskInstances.forEach((taskInst) => {
      const node = graph.getCellById(String(taskInst.taskCode)) as Node | undefined;
      if (!node) return;
      // 首次为节点追加状态徽标 foreignObject markup
      const markup = node.getMarkup() as Markup.JSONMarkup[];
      if (!markup.some((m) => m.selector === 'status-fo')) {
        node.setMarkup([...NODE.markup, ...NODE_STATUS_MARKUP]);
      }
      const view = graph.findViewByCell(node);
      const el = view?.find('div')[0];
      if (!el) return;
      const root = statusRootsRef.current.get(node.id) ?? createRoot(el);
      statusRootsRef.current.set(node.id, root);
      root.render(<TaskStatusBadge status={taskInst.state} />);
    });
  }, [nodes, edges, taskInstances]);

  // 组件卸载时清理状态徽标 React root
  useEffect(() => {
    return () => {
      statusRootsRef.current.forEach((root) => root.unmount());
      statusRootsRef.current.clear();
    };
  }, []);

  const handleViewLog = useCallback(async (task: DSTaskInstance) => {
    setLogLoading(true);
    setLogTaskId(task.id);
    setLogContent('');
    try {
      console.log('[WorkflowInstanceDetail] Fetching log for task:', task.id, 'projectCode:', task.projectCode);
      const res = await api.taskInstance.log(task.projectCode, task.id);
      console.log('[WorkflowInstanceDetail] Log response:', res);
      if (res.code === 0) {
        const logData = res.data as any;
        const logMessage = typeof logData === 'string'
          ? logData
          : logData?.message || '';
        setLogContent(logMessage || '暂无日志');
        if (!logMessage) {
          console.warn('[WorkflowInstanceDetail] Log data is empty for task:', task.id);
        }
      } else {
        const errorMsg = res.msg || `获取日志失败 (code: ${res.code})`;
        console.error('[WorkflowInstanceDetail] Log fetch error:', errorMsg);
        setLogContent(`错误: ${errorMsg}`);
      }
    } catch (e: any) {
      const errMsg = e.message || e.toString() || '未知错误';
      console.error('[WorkflowInstanceDetail] Log fetch exception:', e);
      setLogContent(`异常: ${errMsg}`);
    } finally {
      setLogLoading(false);
    }
  }, [api]);

  const handleZoomIn = () => graphRef.current?.zoom(0.1);
  const handleZoomOut = () => graphRef.current?.zoom(-0.1);
  const handleResetView = () => {
    const graph = graphRef.current;
    if (!graph) return;
    graph.zoomTo(1);
    graph.centerContent();
  };

  const selectedTaskInstance = selectedTaskCode ? taskStatusMap.get(selectedTaskCode) : null;

  const statusCfg = WORKFLOW_STATUS_CONFIG[WORKFLOW_STATE_STRING_TO_ENUM[curInstance.state as unknown as string] ?? curInstance.state];

  return (
    <div className="wi-detail">
      <div className="wi-detail__toolbar">
        <div className="wi-toolbar__left">
          <button className="sm-btn sm-btn--ghost" onClick={onBack} title="返回列表">
            <ArrowLeft size={14} />
          </button>
          <span className="wi-toolbar__name">{curInstance.name}</span>
          {statusCfg && (
            <span className="sm-status-badge" style={{ color: statusCfg.color, backgroundColor: statusCfg.bgColor }}>
              {statusCfg.isSpin && <RefreshCw size={10} className="sm-spin-icon" />}
              {statusCfg.label}
            </span>
          )}
        </div>
        <div className="wi-toolbar__center">
          <button className="sm-btn sm-btn--ghost sm-btn--xs" onClick={handleZoomOut} title="缩小">
            <ZoomOut size={14} />
          </button>
          <span className="wi-toolbar__zoom">{Math.round(zoom * 100)}%</span>
          <button className="sm-btn sm-btn--ghost sm-btn--xs" onClick={handleZoomIn} title="放大">
            <ZoomIn size={14} />
          </button>
          <button className="sm-btn sm-btn--ghost sm-btn--xs" onClick={handleResetView} title="重置视图">
            <Maximize2 size={14} />
          </button>
          <div className="wi-toolbar__separator" />
          <button className="sm-btn sm-btn--ghost sm-btn--xs" title="移动画布 (Alt+拖拽)">
            <Move size={14} />
          </button>
        </div>
        <div className="wi-toolbar__right">
          {(curInstance.state === WorkflowExecutionStatus.FAILURE || curInstance.state === WorkflowExecutionStatus.STOP) && (
            <button className="sm-btn sm-btn--primary sm-btn--xs" onClick={() => onExecute(curInstance, 'REPEAT_RUNNING')} title="重跑">
              <RotateCcw size={12} /> 重跑
            </button>
          )}
          {curInstance.state === WorkflowExecutionStatus.FAILURE && (
            <button className="sm-btn sm-btn--success sm-btn--xs" onClick={() => onExecute(curInstance, 'RESUME_WAITING_THREAD')} title="恢复">
              <Play size={12} /> 恢复
            </button>
          )}
          {curInstance.state === WorkflowExecutionStatus.RUNNING_EXECUTION && (
            <>
              <button className="sm-btn sm-btn--warning sm-btn--xs" onClick={() => onExecute(curInstance, 'PAUSE')} title="暂停">
                <Pause size={12} /> 暂停
              </button>
              <button className="sm-btn sm-btn--danger sm-btn--xs" onClick={() => onExecute(curInstance, 'STOP')} title="停止">
                <StopCircle size={12} /> 停止
              </button>
            </>
          )}
          {curInstance.state === WorkflowExecutionStatus.PAUSE && (
            <button className="sm-btn sm-btn--primary sm-btn--xs" onClick={() => onExecute(curInstance, 'RESUME_WAITING_THREAD')} title="恢复">
              <Play size={12} /> 恢复
            </button>
          )}
        </div>
      </div>

      <div className="wi-detail__body">
        <div className="wi-detail__canvas-container">
          <DagCanvas readonly showHoverLabel={false} onGraphReady={handleGraphReady}>
            {nodes.length === 0 && (
              <div className="wi-canvas__empty">
                <GitBranch size={48} strokeWidth={1} />
                <p>暂无工作流节点数据</p>
              </div>
            )}

            <div className="wi-canvas__legend">
            <div className="wi-legend__item">
              <span className="wi-legend__dot" style={{ backgroundColor: '#89d185' }}></span>
              <span>成功</span>
            </div>
            <div className="wi-legend__item">
              <span className="wi-legend__dot" style={{ backgroundColor: '#75beff' }}></span>
              <span>运行中</span>
            </div>
            <div className="wi-legend__item">
              <span className="wi-legend__dot" style={{ backgroundColor: '#f48771' }}></span>
              <span>失败</span>
            </div>
            <div className="wi-legend__item">
              <span className="wi-legend__dot" style={{ backgroundColor: '#d1a855' }}></span>
              <span>暂停</span>
            </div>
            <div className="wi-legend__item">
              <span className="wi-legend__dot" style={{ backgroundColor: '#666666' }}></span>
              <span>停止/Kill</span>
            </div>
          </div>
          </DagCanvas>
        </div>

        <div className="wi-detail__right-panel">
          <div className="wi-panel__tabs">
            <button
              className={`wi-panel__tab ${rightPanelTab === 'info' ? 'wi-panel__tab--active' : ''}`}
              onClick={() => setRightPanelTab('info')}
            >
              实例信息
            </button>
            <button
              className={`wi-panel__tab ${rightPanelTab === 'tasks' ? 'wi-panel__tab--active' : ''}`}
              onClick={() => setRightPanelTab('tasks')}
            >
              任务列表 ({taskInstances.length})
            </button>
          </div>

          <div className="wi-panel__content">
            {rightPanelTab === 'info' && (
              <div className="wi-info">
                <div className="wi-info__section">
                  <h4 className="wi-info__title">基本信息</h4>
                  <div className="wi-info__row">
                    <span className="wi-info__label"><User size={12} /> 执行人</span>
                    <span className="wi-info__value">{curInstance.executorName || '-'}</span>
                  </div>
                  <div className="wi-info__row">
                    <span className="wi-info__label"><Clock size={12} /> 调度时间</span>
                    <span className="wi-info__value">{formatDateTime(curInstance.scheduleTime)}</span>
                  </div>
                  <div className="wi-info__row">
                    <span className="wi-info__label"><Clock size={12} /> 开始时间</span>
                    <span className="wi-info__value">{formatDateTime(curInstance.startTime)}</span>
                  </div>
                  <div className="wi-info__row">
                    <span className="wi-info__label"><Clock size={12} /> 结束时间</span>
                    <span className="wi-info__value">{formatDateTime(curInstance.endTime)}</span>
                  </div>
                  <div className="wi-info__row">
                    <span className="wi-info__label"><Clock size={12} /> 耗时</span>
                    <span className="wi-info__value">{curInstance.duration || '-'}</span>
                  </div>
                  <div className="wi-info__row">
                    <span className="wi-info__label"><RefreshCw size={12} /> 运行次数</span>
                    <span className="wi-info__value">{curInstance.runTimes}</span>
                  </div>
                  <div className="wi-info__row">
                    <span className="wi-info__label"><HardDrive size={12} /> Host</span>
                    <span className="wi-info__value">{curInstance.host || '-'}</span>
                  </div>
                </div>

                <div className="wi-info__section">
                  <h4 className="wi-info__title">工作流定义</h4>
                  <div className="wi-info__row">
                    <span className="wi-info__label">名称</span>
                    <span className="wi-info__value">{curInstance.processDefinitionName}</span>
                  </div>
                  <div className="wi-info__row">
                    <span className="wi-info__label">优先级</span>
                    <span className="wi-info__value">{curInstance.processInstancePriority}</span>
                  </div>
                  <div className="wi-info__row">
                    <span className="wi-info__label">Worker组</span>
                    <span className="wi-info__value">{curInstance.workerGroup || '-'}</span>
                  </div>
                </div>

                <div className="wi-info__section">
                  <h4 className="wi-info__title">运行统计</h4>
                  <div className="wi-info__stats">
                    <div className="wi-stat">
                      <span className="wi-stat__count" style={{ color: '#89d185' }}>
                        {taskInstances.filter(t => t.state === TaskExecutionStatus.SUCCESS).length}
                      </span>
                      <span className="wi-stat__label">成功</span>
                    </div>
                    <div className="wi-stat">
                      <span className="wi-stat__count" style={{ color: '#75beff' }}>
                        {taskInstances.filter(t => t.state === TaskExecutionStatus.RUNNING_EXECUTION).length}
                      </span>
                      <span className="wi-stat__label">运行中</span>
                    </div>
                    <div className="wi-stat">
                      <span className="wi-stat__count" style={{ color: '#f48771' }}>
                        {taskInstances.filter(t => t.state === TaskExecutionStatus.FAILURE).length}
                      </span>
                      <span className="wi-stat__label">失败</span>
                    </div>
                    <div className="wi-stat">
                      <span className="wi-stat__count" style={{ color: '#999999' }}>
                        {taskInstances.filter(t => t.state !== TaskExecutionStatus.SUCCESS && t.state !== TaskExecutionStatus.RUNNING_EXECUTION && t.state !== TaskExecutionStatus.FAILURE).length}
                      </span>
                      <span className="wi-stat__label">其他</span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {rightPanelTab === 'tasks' && (
              <div className="wi-tasks">
                {selectedTaskInstance && (
                  <div className="wi-tasks__selected">
                    <div className="wi-tasks__selected-header">
                      <span className="wi-tasks__selected-name">{selectedTaskInstance.name}</span>
                      <StatusBadge status={selectedTaskInstance.state} />
                    </div>
                    <div className="wi-tasks__selected-info">
                      <div className="wi-info__row">
                        <span className="wi-info__label">任务类型</span>
                        <span className="sm-task-type">{selectedTaskInstance.taskType}</span>
                      </div>
                      <div className="wi-info__row">
                        <span className="wi-info__label">开始时间</span>
                        <span className="wi-info__value">{formatDateTime(selectedTaskInstance.startTime)}</span>
                      </div>
                      <div className="wi-info__row">
                        <span className="wi-info__label">结束时间</span>
                        <span className="wi-info__value">{formatDateTime(selectedTaskInstance.endTime)}</span>
                      </div>
                      <div className="wi-info__row">
                        <span className="wi-info__label">耗时</span>
                        <span className="wi-info__value">{selectedTaskInstance.duration || '-'}</span>
                      </div>
                      <div className="wi-info__row">
                        <span className="wi-info__label">重试次数</span>
                        <span className="wi-info__value">{selectedTaskInstance.retryTimes}</span>
                      </div>
                      <div className="wi-info__row">
                        <span className="wi-info__label">Host</span>
                        <span className="wi-info__value">{selectedTaskInstance.host || '-'}</span>
                      </div>
                    </div>
                    <div className="wi-tasks__selected-actions">
                      <button className="sm-btn sm-btn--ghost sm-btn--xs" onClick={() => handleViewLog(selectedTaskInstance)}>
                        <Eye size={12} /> 查看日志
                      </button>
                      {(selectedTaskInstance.state === TaskExecutionStatus.FAILURE || selectedTaskInstance.state === TaskExecutionStatus.KILL || selectedTaskInstance.state === TaskExecutionStatus.NEED_FAULT_TOLERANCE) && (
                        <button className="sm-btn sm-btn--warning sm-btn--xs" onClick={() => onForceSuccessTask(selectedTaskInstance)}>
                          <CheckCircle size={12} /> 强制成功
                        </button>
                      )}
                    </div>
                  </div>
                )}

                <div className="wi-tasks__list">
                  {taskInstances.map(task => {
                    const cfg = TASK_STATUS_CONFIG[task.state];
                    return (
                      <div
                        key={task.id}
                        className={`wi-task-item ${selectedTaskCode === task.taskCode ? 'wi-task-item--selected' : ''}`}
                        onClick={() => { selectNodeByCode(task.taskCode); }}
                      >
                        <span className="wi-task-item__indicator" style={{ backgroundColor: cfg?.color || '#555' }}></span>
                        <span className="wi-task-item__name">{task.name}</span>
                        <span className="wi-task-item__type">{task.taskType}</span>
                        <span className="wi-task-item__duration">{task.duration || '-'}</span>
                      </div>
                    );
                  })}
                  {taskInstances.length === 0 && (
                    <div className="wi-tasks__empty">暂无任务实例</div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {logTaskId !== null && (
        <div className="wi-log-panel">
          <div className="wi-log-panel__header">
            <span>任务日志</span>
            <button className="sm-btn sm-btn--ghost sm-btn--xs" onClick={() => setLogTaskId(null)}>
              ×
            </button>
          </div>
          <div className="wi-log-panel__body">
            {logLoading ? (
              <div className="sm-loading">加载中...</div>
            ) : (
              <pre className="sm-log-content">{logContent || '暂无日志'}</pre>
            )}
          </div>
        </div>
      )}

      {viewingTaskNode && (
        <TaskConfigModal
          task={viewingTaskNode}
          allNodes={nodes}
          edges={edges}
          workflowDefinitions={[]}
          workerGroups={workerGroups}
          environments={environments}
          api={api}
          onSave={() => {}}
          onClose={() => setViewingTaskNode(null)}
          readonly
        />
      )}
    </div>
  );
};

function StatusBadge({ status }: { status: number }) {
  const cfg = TASK_STATUS_CONFIG[status];
  if (!cfg) return <span className="sm-status-badge">未知</span>;
  return (
    <span className="sm-status-badge" style={{ color: cfg.color, backgroundColor: cfg.bgColor }}>
      {cfg.isSpin && <RefreshCw size={10} className="sm-spin-icon" />}
      {cfg.label}
    </span>
  );
}

/** 渲染在 x6 节点上方 foreignObject 内的任务状态徽标（复用 NODE_STATUS_COLORS 色值）。 */
function TaskStatusBadge({ status }: { status: number }) {
  const colors = NODE_STATUS_COLORS[status];
  const cfg = TASK_STATUS_CONFIG[status];
  if (!colors || !cfg) return null;
  return (
    <div
      className="dag-node-status"
      style={{
        backgroundColor: colors.bg,
        border: `1px solid ${colors.border}`,
        color: colors.indicator,
      }}
    >
      <span className="dag-node-status__dot" />
      {cfg.isSpin && <RefreshCw size={10} className="sm-spin-icon" />}
      <span>{cfg.label}</span>
    </div>
  );
}

export default WorkflowInstanceDetail;
