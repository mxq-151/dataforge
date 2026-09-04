import { useState, useRef, useCallback, useEffect } from 'react';
import type { Graph, Node } from '@antv/x6';
import {
  ArrowLeft, Save, Trash2, ZoomIn, ZoomOut, Maximize2, Maximize,
  Move, Plus, X, Zap, Search, Download, LayoutGrid, GitBranch,
} from 'lucide-react';
import type {
  DSWorkflowTaskNode, DSWorkflowEdge, DSWorkflowGlobalParam,
  DSTaskType, DSWorkflowSaveForm, DSWorkflowTriggerForm,
  DSWorkerGroup, DSEnvironment, DSAlertGroup, DolphinSchedulerApi, DSTenant, DSStartParam,
} from '../../../types/dolphinscheduler';
import {
  TASK_TYPE_LABELS, ExecutionType, FailureStrategy,
  WarningType, Priority, EXECUTION_TYPE_OPTIONS, GLOBAL_PARAM_TYPE_OPTIONS,
  GLOBAL_PARAM_DIRECT_OPTIONS, getDefaultTaskParams,
} from '../../../types/dolphinscheduler';
import TaskConfigModal from './task-configs/TaskConfigModal';
import DagCanvas from '../dag/DagCanvas';
import DagSidebar from '../dag/DagSidebar';
import DagContextMenu from '../dag/DagContextMenu';
import DagAutoLayoutModal from '../dag/DagAutoLayoutModal';
import {
  buildNode, buildEdge, buildGraph, extractNodes, extractEdges,
  truncateText, getTaskTypeIcon,
} from '../dag/useCustomCellBuilder';
import { formatGraph, DEFAULT_LAYOUT_CONFIG } from '../dag/useGraphAutoLayout';
import type { LayoutConfig } from '../dag/useGraphAutoLayout';
import './WorkflowDefinitionEditor.css';

interface WorkflowDefinitionEditorProps {
  workflowName: string;
  description: string;
  existingNodes?: DSWorkflowTaskNode[];
  existingEdges?: DSWorkflowEdge[];
  existingGlobalParams?: DSWorkflowGlobalParam[];
  existingExecutionType?: ExecutionType;
  existingTimeout?: number;
  readonly?: boolean;
  workflowDefinitions?: { code: number; name: string }[];
  workerGroups?: DSWorkerGroup[];
  environments?: DSEnvironment[];
  alertGroups?: DSAlertGroup[];
  tenants?: DSTenant[];
  api?: DolphinSchedulerApi;
  onSave: (data: {
    name: string;
    description: string;
    executionType: ExecutionType;
    timeout: number;
    globalParams: DSWorkflowGlobalParam[];
    nodes: DSWorkflowTaskNode[];
    edges: DSWorkflowEdge[];
    release: boolean;
  }) => void;
  onTrigger?: (form: DSWorkflowTriggerForm) => void;
  onClose: () => void;
}

const WorkflowDefinitionEditor: React.FC<WorkflowDefinitionEditorProps> = ({
  workflowName: initialName,
  description: initialDescription,
  existingNodes,
  existingEdges,
  existingGlobalParams,
  existingExecutionType,
  existingTimeout,
  readonly = false,
  workflowDefinitions,
  workerGroups,
  environments,
  alertGroups,
  tenants,
  api,
  onSave,
  onTrigger,
  onClose,
}) => {
  // 节点/边状态由 graph 事件同步而来，供弹窗等消费
  const [nodes, setNodes] = useState<DSWorkflowTaskNode[]>(existingNodes || []);
  const [edges, setEdges] = useState<DSWorkflowEdge[]>(existingEdges || []);
  const graphRef = useRef<Graph | null>(null);
  const taskCodeCounter = useRef(1);
  const nextTaskCode = useCallback(() => Date.now() + taskCodeCounter.current++, []);
  const [selectedCellIds, setSelectedCellIds] = useState<string[]>([]);
  const [zoom, setZoom] = useState(1);

  const [showTaskModal, setShowTaskModal] = useState(false);
  const [editingTask, setEditingTask] = useState<DSWorkflowTaskNode | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; cellId: string } | null>(null);
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchValue, setSearchValue] = useState('');
  const [layoutModalVisible, setLayoutModalVisible] = useState(false);
  const [layoutForm, setLayoutForm] = useState<LayoutConfig>({ ...DEFAULT_LAYOUT_CONFIG });

  const [showSaveModal, setShowSaveModal] = useState(false);
  const [showTriggerModal, setShowTriggerModal] = useState(false);

  const [saveForm, setSaveForm] = useState<DSWorkflowSaveForm>({
    name: initialName || '',
    description: initialDescription || '',
    executionType: existingExecutionType ?? ExecutionType.PARALLEL,
    timeoutFlag: (existingTimeout ?? 0) > 0,
    timeout: existingTimeout ?? 0,
    globalParams: existingGlobalParams || [],
    release: false,
  });

  useEffect(() => {
    setSaveForm(prev => ({
      ...prev,
      name: initialName || '',
      description: initialDescription || '',
      executionType: existingExecutionType ?? prev.executionType,
      timeoutFlag: (existingTimeout ?? 0) > 0,
      timeout: existingTimeout ?? prev.timeout,
      globalParams: existingGlobalParams && existingGlobalParams.length > 0 ? existingGlobalParams : prev.globalParams,
    }));
  }, [initialName, initialDescription, existingExecutionType, existingTimeout, existingGlobalParams]);

  const [triggerForm, setTriggerForm] = useState<DSWorkflowTriggerForm>({
    failureStrategy: FailureStrategy.CONTINUE,
    warningType: WarningType.NONE,
    warningGroupId: null,
    processInstancePriority: Priority.MEDIUM,
    workerGroup: 'default',
    environmentCode: null,
    tenantCode: null,
    dryRun: 0,
    complementRun: false,
    startParams: [],
  });

  const editorRef = useRef<HTMLDivElement>(null);

  // ---------- graph 就绪后接线 ----------
  const handleGraphReady = useCallback((graph: Graph) => {
    graphRef.current = graph;

    const syncNodes = () => setNodes(extractNodes(graph.getNodes()));
    const syncEdges = () => setEdges(extractEdges(graph.getEdges()));

    graph.on('node:added', syncNodes);
    graph.on('node:removed', syncNodes);
    graph.on('node:move:end', syncNodes);
    graph.on('edge:added', syncEdges);
    graph.on('edge:removed', syncEdges);
    graph.on('scale', ({ sx }) => setZoom(Math.round(sx * 100) / 100));
    graph.on('selection:changed', ({ selected }) =>
      setSelectedCellIds(selected.map((c) => c.id))
    );

    // 双击节点 → 编辑
    graph.on('node:dblclick', ({ node }) => {
      const data = node.getData() as { task?: DSWorkflowTaskNode } | undefined;
      if (data?.task) handleEditNode(data.task);
    });

    // 右键节点 → 上下文菜单
    graph.on('node:contextmenu', ({ node, x, y }) => {
      const p = graph.localToPage(x, y);
      graph.select(node);
      graph.lockScroller();
      setContextMenu({ x: p.x, y: p.y, cellId: node.id });
    });
    graph.on('blank:contextmenu', () => closeContextMenu());

    // 回填已有节点/边（StrictMode 双挂载时每次 graph 就绪都执行，幂等）
    if (existingNodes && existingNodes.length > 0) {
      graph.fromJSON(buildGraph(existingNodes, existingEdges || []));
    }
  }, [existingNodes, existingEdges]);

  const handleEditNode = useCallback((node: DSWorkflowTaskNode) => {
    if (readonly) return;
    setEditingTask({ ...node });
    setShowTaskModal(true);
  }, [readonly]);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
    graphRef.current?.unlockScroller();
  }, []);

  // ---------- 节点操作 ----------
  const makeDefaultNode = useCallback((taskType: DSTaskType, x: number, y: number, nameSuffix?: string): DSWorkflowTaskNode => {
    const newCode = nextTaskCode();
    const count = nodes.length;
    return {
      code: newCode,
      name: nameSuffix || `${TASK_TYPE_LABELS[taskType]}_${count + 1}`,
      taskType,
      description: '',
      taskParams: JSON.stringify(getDefaultTaskParams(taskType)),
      flag: 'YES',
      taskPriority: Priority.MEDIUM,
      workerGroup: 'default',
      environmentCode: -1,
      failRetryTimes: 0,
      failRetryInterval: 1,
      timeoutFlag: 'CLOSE',
      timeout: 0,
      delayTime: 0,
      x,
      y,
    };
  }, [nextTaskCode, nodes.length]);

  const handleAddNode = useCallback((taskType: DSTaskType) => {
    if (readonly) return;
    const graph = graphRef.current;
    if (!graph) return;
    const offset = nodes.length * 30;
    const node = makeDefaultNode(taskType, 100 + offset, 100 + offset);
    graph.addNode(buildNode(node, { x: node.x, y: node.y }));
    setSelectedCellIds([String(node.code)]);
  }, [readonly, nodes.length, makeDefaultNode]);

  // 侧栏拖入画布
  const handleCanvasDrop = useCallback((e: React.DragEvent) => {
    const taskType = e.dataTransfer.getData('taskType') as DSTaskType;
    if (!taskType || readonly) return;
    e.preventDefault();
    const graph = graphRef.current;
    if (!graph) return;
    const { x, y } = graph.clientToLocal(e.clientX, e.clientY);
    const node = makeDefaultNode(taskType, Math.max(0, Math.round(x)), Math.max(0, Math.round(y)));
    graph.addNode(buildNode(node, { x: node.x, y: node.y }));
    setSelectedCellIds([String(node.code)]);
  }, [readonly, makeDefaultNode]);

  // ---------- 任务配置保存 ----------
  const handleSaveTask = useCallback((task: DSWorkflowTaskNode, newEdges?: DSWorkflowEdge[]) => {
    const graph = graphRef.current;
    if (graph) {
      const cell = graph.getCellById(String(task.code)) as Node | undefined;
      if (cell) {
        cell.setData({
          ...cell.getData(),
          task,
          taskType: task.taskType,
          taskName: task.name,
          flag: task.flag,
        });
        cell.attr('title/text', truncateText(task.name));
        cell.attr('image/href', getTaskTypeIcon(task.taskType));
      }
      if (newEdges) {
        // 重建全部边（modal 返回的是全量边列表）
        graph.clearCells({ edges: true, nodes: false });
        newEdges.forEach((edge) => {
          graph.addEdge(buildEdge(String(edge.sourceCode), String(edge.targetCode)));
        });
      }
    }
    setShowTaskModal(false);
    setEditingTask(null);
  }, []);

  // ---------- 删除 ----------
  const handleDeleteSelected = useCallback(() => {
    if (readonly) return;
    const graph = graphRef.current;
    if (!graph) return;
    graph.removeCells(graph.getSelectedCells());
    setSelectedCellIds([]);
  }, [readonly]);

  const deleteNode = useCallback((cellId: string) => {
    const graph = graphRef.current;
    if (!graph) return;
    const cell = graph.getCellById(cellId);
    if (cell) graph.removeCell(cell);
  }, []);

  // ---------- 复制 ----------
  const copyNode = useCallback((cellId: string) => {
    const graph = graphRef.current;
    if (!graph) return;
    const cell = graph.getCellById(cellId) as Node | undefined;
    if (!cell) return;
    const data = cell.getData() as { task?: DSWorkflowTaskNode } | undefined;
    if (!data?.task) return;
    const pos = cell.getPosition();
    const copy = makeDefaultNode(data.task.taskType, pos.x + 100, pos.y + 100, `${data.task.name}_复制`);
    const copiedTask: DSWorkflowTaskNode = {
      ...data.task,
      code: copy.code,
      name: copy.name,
      x: copy.x,
      y: copy.y,
    };
    graph.addNode(buildNode(copiedTask, { x: copiedTask.x, y: copiedTask.y }));
  }, [makeDefaultNode]);

  // ---------- 视图 ----------
  const handleZoomIn = () => graphRef.current?.zoom(0.1);
  const handleZoomOut = () => graphRef.current?.zoom(-0.1);
  const handleResetView = () => {
    const graph = graphRef.current;
    if (!graph) return;
    graph.zoomTo(1);
    graph.centerContent();
  };

  const handleDownloadPng = () => {
    const graph = graphRef.current;
    if (!graph) return;
    graph.toPNG((dataUri: string) => {
      const link = document.createElement('a');
      link.download = `${initialName || 'workflow'}.png`;
      link.href = dataUri;
      link.click();
    }, { backgroundColor: '#1e1e1e' });
  };

  const handleFullscreen = () => {
    const el = editorRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      el.requestFullscreen();
    }
  };

  const handleSearchNavigate = (code: string) => {
    const graph = graphRef.current;
    if (!graph) return;
    const cell = graph.getCellById(code);
    if (cell) {
      graph.scrollToCell(cell, { animation: { duration: 600 } });
      graph.cleanSelection();
      graph.select(cell);
    }
    setSearchValue(code);
    setSearchVisible(false);
  };

  // ---------- 键盘快捷键 ----------
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!showTaskModal && !showSaveModal && !showTriggerModal) {
          handleDeleteSelected();
        }
      }
      if (e.key === 'Escape') {
        closeContextMenu();
        graphRef.current?.cleanSelection();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleDeleteSelected, closeContextMenu, showTaskModal, showSaveModal, showTriggerModal]);

  // ---------- 上下文菜单项 ----------
  const contextMenuItems = [
    { key: 'edit', label: '编辑', onClick: () => {
      const cell = graphRef.current?.getCellById(contextMenu?.cellId || '');
      const task = (cell as Node)?.getData()?.task as DSWorkflowTaskNode | undefined;
      if (task) handleEditNode(task);
    }, disabled: readonly },
    { key: 'copy', label: '复制', onClick: () => contextMenu && copyNode(contextMenu.cellId), disabled: readonly },
    { key: 'delete', label: '删除', onClick: () => contextMenu && deleteNode(contextMenu.cellId), disabled: readonly },
  ];

  return (
    <div className="wf-editor" ref={editorRef}>
      <div className="wf-editor__toolbar">
        <div className="wf-toolbar__left">
          <button className="sm-btn sm-btn--ghost" onClick={onClose} title="返回">
            <ArrowLeft size={14} />
          </button>
          <span className="wf-toolbar__name">{initialName}</span>
          {readonly && <span className="wf-toolbar__readonly-badge">只读</span>}
        </div>
        <div className="wf-toolbar__center">
          <button className="sm-btn sm-btn--ghost sm-btn--xs" onClick={handleZoomOut} title="缩小">
            <ZoomOut size={14} />
          </button>
          <span className="wf-toolbar__zoom">{Math.round(zoom * 100)}%</span>
          <button className="sm-btn sm-btn--ghost sm-btn--xs" onClick={handleZoomIn} title="放大">
            <ZoomIn size={14} />
          </button>
          <button className="sm-btn sm-btn--ghost sm-btn--xs" onClick={handleResetView} title="重置视图">
            <Maximize2 size={14} />
          </button>
          <button className="sm-btn sm-btn--ghost sm-btn--xs" onClick={handleFullscreen} title="全屏">
            <Maximize size={14} />
          </button>
          <div className="wf-toolbar__separator" />
          <button className="sm-btn sm-btn--ghost sm-btn--xs" onClick={() => setSearchVisible(v => !v)} title="节点搜索">
            <Search size={14} />
          </button>
          <button className="sm-btn sm-btn--ghost sm-btn--xs" onClick={handleDownloadPng} title="下载 PNG">
            <Download size={14} />
          </button>
          {!readonly && (
            <button className="sm-btn sm-btn--ghost sm-btn--xs" onClick={() => setLayoutModalVisible(true)} title="自动布局">
              <LayoutGrid size={14} />
            </button>
          )}
          <button className="sm-btn sm-btn--ghost sm-btn--xs" onClick={handleDeleteSelected} disabled={selectedCellIds.length === 0 || readonly} title="删除选中">
            <Trash2 size={14} />
          </button>
          <button className="sm-btn sm-btn--ghost sm-btn--xs" title="移动画布：滚轮平移 / Ctrl+滚轮缩放 / 拖拽空白处框选">
            <Move size={14} />
          </button>
        </div>
        <div className="wf-toolbar__right">
          {searchVisible && (
            <div className="wf-toolbar__search">
              <input
                value={searchValue}
                onChange={e => setSearchValue(e.target.value)}
                placeholder="搜索节点..."
                autoFocus
              />
              <div className="wf-toolbar__search-list">
                {nodes
                  .filter(n => n.name.toLowerCase().includes(searchValue.toLowerCase()))
                  .map(n => (
                    <button key={n.code} onClick={() => handleSearchNavigate(String(n.code))}>
                      {n.name}
                    </button>
                  ))}
              </div>
            </div>
          )}
          {!readonly && (
            <button className="sm-btn sm-btn--primary sm-btn--xs" onClick={() => setShowSaveModal(true)}>
              <Save size={14} /> 保存
            </button>
          )}
          {onTrigger && (
            <button className="sm-btn sm-btn--success sm-btn--xs" onClick={() => setShowTriggerModal(true)}>
              <Zap size={14} /> 运行
            </button>
          )}
        </div>
      </div>

      <div className="wf-editor__body">
        {!readonly && <DagSidebar onAddTask={handleAddNode} />}

        <div
          className="wf-editor__canvas-container"
          onDrop={handleCanvasDrop}
          onDragOver={e => e.preventDefault()}
        >
          <DagCanvas readonly={readonly} onGraphReady={handleGraphReady}>
            {nodes.length === 0 && (
              <div className="wf-canvas__empty">
                <GitBranch size={48} strokeWidth={1} />
                <p>点击左侧任务节点添加到画布</p>
                <span>双击节点编辑配置，拖拽节点底部端口创建连线</span>
              </div>
            )}
          </DagCanvas>
        </div>
      </div>

      <DagContextMenu
        visible={!!contextMenu}
        x={contextMenu?.x ?? 0}
        y={contextMenu?.y ?? 0}
        items={contextMenuItems}
        onClose={closeContextMenu}
      />

      <DagAutoLayoutModal
        visible={layoutModalVisible}
        formValue={layoutForm}
        onChange={setLayoutForm}
        onConfirm={() => {
          const graph = graphRef.current;
          if (graph) {
            formatGraph(graph, layoutForm);
          }
          setLayoutModalVisible(false);
        }}
        onClose={() => setLayoutModalVisible(false)}
      />

      {showTaskModal && editingTask && (
        <TaskConfigModal
          task={editingTask}
          allNodes={nodes}
          edges={edges}
          workflowDefinitions={workflowDefinitions}
          workerGroups={workerGroups}
          environments={environments}
          api={api}
          onSave={handleSaveTask}
          onClose={() => { setShowTaskModal(false); setEditingTask(null); }}
        />
      )}

      {showSaveModal && (
        <SaveWorkflowModal
          form={saveForm}
          onChange={setSaveForm}
          onConfirm={() => {
            const graph = graphRef.current;
            onSave({
              name: saveForm.name || '',
              description: saveForm.description || '',
              executionType: saveForm.executionType,
              timeout: saveForm.timeoutFlag ? saveForm.timeout : 0,
              globalParams: saveForm.globalParams,
              nodes: graph ? extractNodes(graph.getNodes()) : nodes,
              edges: graph ? extractEdges(graph.getEdges()) : edges,
              release: saveForm.release,
            });
            setShowSaveModal(false);
          }}
          onClose={() => setShowSaveModal(false)}
        />
      )}

      {showTriggerModal && onTrigger && (
        <TriggerWorkflowModal
          workflowName={initialName}
          form={triggerForm}
          onChange={setTriggerForm}
          onConfirm={() => {
            onTrigger(triggerForm);
            setShowTriggerModal(false);
          }}
          onClose={() => setShowTriggerModal(false)}
          workerGroups={workerGroups}
          environments={environments}
          alertGroups={alertGroups}
          tenants={tenants}
        />
      )}
    </div>
  );
};

interface SaveWorkflowModalProps {
  form: DSWorkflowSaveForm;
  onChange: (form: DSWorkflowSaveForm) => void;
  onConfirm: () => void;
  onClose: () => void;
}

function SaveWorkflowModal({ form, onChange, onConfirm, onClose }: SaveWorkflowModalProps) {
  const addGlobalParam = () => {
    onChange({
      ...form,
      globalParams: [...form.globalParams, { key: '', direct: 'IN', type: 'VARCHAR', value: '' }],
    });
  };

  const removeGlobalParam = (index: number) => {
    onChange({
      ...form,
      globalParams: form.globalParams.filter((_, i) => i !== index),
    });
  };

  const updateGlobalParam = (index: number, field: keyof DSWorkflowGlobalParam, value: string) => {
    const newParams = [...form.globalParams];
    newParams[index] = { ...newParams[index], [field]: value };
    onChange({ ...form, globalParams: newParams });
  };

  return (
    <div className="sm-modal-overlay" onClick={onClose}>
      <div className="sm-modal sm-modal--save" onClick={e => e.stopPropagation()}>
        <div className="sm-modal__header">
          <Save size={18} />
          <span>保存工作流</span>
        </div>
        <div className="sm-modal__body sm-modal__body--scroll">
          <div className="sm-modal__field">
            <label>工作流名称<span className="sm-required">*</span></label>
            <input
              value={form.name}
              onChange={e => onChange({ ...form, name: e.target.value })}
              placeholder="请输入工作流名称"
            />
          </div>
          <div className="sm-modal__field">
            <label>描述</label>
            <textarea
              value={form.description}
              onChange={e => onChange({ ...form, description: e.target.value })}
              placeholder="请输入工作流描述"
              rows={3}
              className="sm-modal__textarea"
            />
          </div>
          <div className="sm-modal__row">
            <div className="sm-modal__field sm-modal__field--half">
              <label>执行类型</label>
              <select
                value={form.executionType}
                onChange={e => onChange({ ...form, executionType: Number(e.target.value) as ExecutionType })}
                className="sm-select"
              >
                {EXECUTION_TYPE_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            <div className="sm-modal__field sm-modal__field--half">
              <label>超时告警</label>
              <div className="sm-modal__toggle-row">
                <label className="sm-modal__toggle">
                  <input
                    type="checkbox"
                    checked={form.timeoutFlag}
                    onChange={e => onChange({ ...form, timeoutFlag: e.target.checked })}
                  />
                  <span>启用</span>
                </label>
                {form.timeoutFlag && (
                  <input
                    type="number"
                    value={form.timeout}
                    onChange={e => onChange({ ...form, timeout: parseInt(e.target.value) || 0 })}
                    min={1}
                    placeholder="分钟"
                    className="sm-modal__timeout-input"
                  />
                )}
              </div>
            </div>
          </div>

          <div className="sm-modal__field sm-modal__field--section">
            <label>全局参数</label>
            <div className="wf-global-params">
              <div className="wf-global-param__header">
                <span>参数名</span>
                <span>方向</span>
                <span>类型</span>
                <span>参数值</span>
                <span className="wf-global-param__col-action">操作</span>
              </div>
              {form.globalParams.map((param, idx) => (
                <div key={idx} className="wf-global-param__row">
                  <input
                    value={param.key}
                    onChange={e => updateGlobalParam(idx, 'key', e.target.value)}
                    placeholder="参数名"
                    className="wf-global-param__input"
                  />
                  <select
                    value={param.direct}
                    onChange={e => updateGlobalParam(idx, 'direct', e.target.value)}
                    className="sm-select wf-global-param__select"
                  >
                    {GLOBAL_PARAM_DIRECT_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                  <select
                    value={param.type}
                    onChange={e => updateGlobalParam(idx, 'type', e.target.value)}
                    className="sm-select wf-global-param__select"
                  >
                    {GLOBAL_PARAM_TYPE_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                  <input
                    value={param.value}
                    onChange={e => updateGlobalParam(idx, 'value', e.target.value)}
                    placeholder="参数值"
                    className="wf-global-param__input"
                  />
                  <button className="sm-btn sm-btn--danger sm-btn--xs wf-global-param__btn-action" onClick={() => removeGlobalParam(idx)}>
                    <X size={12} />
                  </button>
                </div>
              ))}
              <button className="sm-btn sm-btn--ghost sm-btn--xs wf-global-param__add-btn" onClick={addGlobalParam}>
                <Plus size={12} /> 添加参数
              </button>
            </div>
          </div>

          <div className="sm-modal__field">
            <label>是否直接上线</label>
            <div className="sm-modal__toggle-row">
              <label className="sm-modal__toggle">
                <input
                  type="checkbox"
                  checked={form.release}
                  onChange={e => onChange({ ...form, release: e.target.checked })}
                />
                <span>保存后自动上线</span>
              </label>
            </div>
          </div>
        </div>
        <div className="sm-modal__footer">
          <button className="sm-btn sm-btn--secondary" onClick={onClose}>取消</button>
          <button className="sm-btn sm-btn--primary" onClick={onConfirm} disabled={!form.name?.trim()}>确认保存</button>
        </div>
      </div>
    </div>
  );
}

export interface TriggerWorkflowModalProps {
  workflowName: string;
  form: DSWorkflowTriggerForm;
  onChange: (form: DSWorkflowTriggerForm) => void;
  onConfirm: () => void;
  onClose: () => void;
  workerGroups?: DSWorkerGroup[];
  environments?: DSEnvironment[];
  alertGroups?: DSAlertGroup[];
  tenants?: DSTenant[];
}

export function TriggerWorkflowModal({ workflowName, form, onChange, onConfirm, onClose, workerGroups, environments, alertGroups, tenants }: TriggerWorkflowModalProps) {
  const addStartParam = () => {
    onChange({
      ...form,
      startParams: [...form.startParams, { key: '', value: '' } as DSStartParam],
    });
  };

  const removeStartParam = (index: number) => {
    onChange({
      ...form,
      startParams: form.startParams.filter((_, i) => i !== index),
    });
  };

  const updateStartParam = (index: number, field: keyof DSStartParam, value: string) => {
    const newParams = [...form.startParams];
    newParams[index] = { ...newParams[index], [field]: value };
    onChange({ ...form, startParams: newParams });
  };

  const priorityOrder: Priority[] = [Priority.HIGHEST, Priority.HIGH, Priority.MEDIUM, Priority.LOW, Priority.LOWEST];

  return (
    <div className="sm-modal-overlay" onClick={onClose}>
      <div className="sm-modal sm-modal--trigger" onClick={e => e.stopPropagation()}>
        <div className="sm-modal__header">
          <Zap size={18} />
          <span>启动前请设置参数</span>
        </div>
        <div className="sm-modal__body sm-modal__body--scroll">
          <div className="sm-modal__field">
            <label>工作流名称</label>
            <div className="sm-modal__readonly-text">{workflowName || '-'}</div>
          </div>

          <div className="sm-modal__field">
            <label>失败策略</label>
            <div className="sm-modal__radio-group">
              <label className="sm-modal__radio">
                <input
                  type="radio"
                  name="failureStrategy"
                  value={FailureStrategy.CONTINUE}
                  checked={form.failureStrategy === FailureStrategy.CONTINUE}
                  onChange={() => onChange({ ...form, failureStrategy: FailureStrategy.CONTINUE })}
                />
                <span>继续</span>
              </label>
              <label className="sm-modal__radio">
                <input
                  type="radio"
                  name="failureStrategy"
                  value={FailureStrategy.END}
                  checked={form.failureStrategy === FailureStrategy.END}
                  onChange={() => onChange({ ...form, failureStrategy: FailureStrategy.END })}
                />
                <span>结束</span>
              </label>
            </div>
          </div>

          <div className="sm-modal__field">
            <label>通知策略</label>
            <select
              value={form.warningType}
              onChange={e => onChange({ ...form, warningType: e.target.value as WarningType })}
              className="sm-select"
            >
              <option value={WarningType.NONE}>都不发</option>
              <option value={WarningType.SUCCESS}>成功发</option>
              <option value={WarningType.FAILURE}>失败发</option>
              <option value={WarningType.ALL}>成功失败都发</option>
            </select>
          </div>

          {form.warningType !== WarningType.NONE && (
            <div className="sm-modal__field">
              <label>告警组</label>
              <select
                value={form.warningGroupId ?? ''}
                onChange={e => onChange({ ...form, warningGroupId: e.target.value ? Number(e.target.value) : null })}
                className="sm-select"
              >
                <option value="">请选择告警组</option>
                {alertGroups && alertGroups.map(ag => (
                  <option key={ag.id} value={ag.id}>
                    {ag.groupName}{ag.description ? ` (${ag.description})` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="sm-modal__field">
            <label>流程优先级</label>
            <select
              value={form.processInstancePriority}
              onChange={e => onChange({ ...form, processInstancePriority: e.target.value as Priority })}
              className="sm-select sm-select--with-icon"
            >
              {priorityOrder.map(p => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>

          <div className="sm-modal__field">
            <label>Worker分组</label>
            <select
              value={form.workerGroup}
              onChange={e => onChange({ ...form, workerGroup: e.target.value })}
              className="sm-select"
            >
              {workerGroups && workerGroups.length > 0 ? (
                workerGroups.map(wg => (
                  <option key={wg.workerGroup} value={wg.workerGroup}>{wg.workerGroup}</option>
                ))
              ) : (
                <option value="default">default</option>
              )}
            </select>
          </div>

          <div className="sm-modal__field">
            <label>租户</label>
            <select
              value={form.tenantCode ?? ''}
              onChange={e => onChange({ ...form, tenantCode: e.target.value || null })}
              className="sm-select"
            >
              <option value="">请选择租户</option>
              {tenants && tenants.map(t => (
                <option key={t.tenantCode} value={t.tenantCode}>
                  {t.tenantCode}{t.description ? ` (${t.description})` : ''}
                </option>
              ))}
            </select>
          </div>

          <div className="sm-modal__field">
            <label>环境名称</label>
            <select
              value={form.environmentCode ?? ''}
              onChange={e => onChange({ ...form, environmentCode: e.target.value ? Number(e.target.value) : null })}
              className="sm-select"
            >
              <option value="">默认环境</option>
              {environments && environments
                .filter(env => !form.workerGroup || !env.workerGroups || env.workerGroups.length === 0 || env.workerGroups.includes(form.workerGroup))
                .map(env => (
                  <option key={env.code} value={env.code}>{env.name}</option>
                ))}
            </select>
          </div>

          <div className="sm-modal__field">
            <label>补数</label>
            <div className="sm-modal__checkbox-row">
              <label className="sm-modal__checkbox">
                <input
                  type="checkbox"
                  checked={form.complementRun}
                  onChange={e => onChange({ ...form, complementRun: e.target.checked })}
                />
                <span>是否是补数</span>
              </label>
            </div>
          </div>

          <div className="sm-modal__field">
            <label>启动参数</label>
            <div className="wf-start-params">
              {form.startParams.length === 0 ? null : (
                <div className="wf-start-param__list">
                  {form.startParams.map((p, idx) => (
                    <div key={idx} className="wf-start-param__row">
                      <input
                        value={p.key}
                        onChange={e => updateStartParam(idx, 'key', e.target.value)}
                        placeholder="参数名"
                        className="wf-start-param__input"
                      />
                      <span className="wf-start-param__eq">=</span>
                      <input
                        value={p.value}
                        onChange={e => updateStartParam(idx, 'value', e.target.value)}
                        placeholder="参数值"
                        className="wf-start-param__input"
                      />
                      <button
                        className="sm-btn sm-btn--danger sm-btn--xs wf-start-param__btn-action"
                        onClick={() => removeStartParam(idx)}
                        title="删除"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <button className="sm-btn sm-btn--ghost sm-btn--block wf-start-param__add-btn" onClick={addStartParam}>
                <Plus size={12} /> 添加
              </button>
            </div>
          </div>

          <div className="sm-modal__field">
            <label>是否空跑</label>
            <div className="sm-modal__switch-row">
              <label className={`sm-switch ${form.dryRun === 1 ? 'sm-switch--on' : ''}`}>
                <input
                  type="checkbox"
                  checked={form.dryRun === 1}
                  onChange={e => onChange({ ...form, dryRun: e.target.checked ? 1 : 0 })}
                />
                <span className="sm-switch__slider" />
              </label>
            </div>
          </div>
        </div>
        <div className="sm-modal__footer">
          <button className="sm-btn sm-btn--secondary" onClick={onClose}>取消</button>
          <button className="sm-btn sm-btn--primary" onClick={onConfirm}>确定</button>
        </div>
      </div>
    </div>
  );
}

export default WorkflowDefinitionEditor;
