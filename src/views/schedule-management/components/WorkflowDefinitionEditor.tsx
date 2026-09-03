import { useState, useRef, useCallback, useEffect } from 'react';
import {
  ChevronDown, ChevronRight, Save, ArrowLeft, Trash2, ZoomIn, ZoomOut,
  Maximize2, Move, Plus, X, Terminal, Database, Code2,
  GitBranch, Zap, Globe, ArrowRightLeft, GitMerge, Shuffle, Waves,
  Container, Coffee, Cloud, Brain, Radio, Server, Network,
} from 'lucide-react';
import type {
  DSWorkflowTaskNode, DSWorkflowEdge, DSWorkflowGlobalParam,
  DSTaskType, DSWorkflowSaveForm, DSWorkflowTriggerForm,
  DSWorkerGroup, DSEnvironment, DSAlertGroup, DolphinSchedulerApi, DSTenant, DSStartParam,
} from '../../../types/dolphinscheduler';
import {
  TASK_CATEGORIES, TASK_TYPE_LABELS, ExecutionType, FailureStrategy,
  WarningType, Priority, EXECUTION_TYPE_OPTIONS, GLOBAL_PARAM_TYPE_OPTIONS,
  GLOBAL_PARAM_DIRECT_OPTIONS, getDefaultTaskParams,
} from '../../../types/dolphinscheduler';
import TaskConfigModal from './task-configs/TaskConfigModal';
import './WorkflowDefinitionEditor.css';

const TASK_TYPE_ICONS: Record<DSTaskType, React.ReactNode> = {
  SHELL: <Terminal size={14} />,
  SUB_PROCESS: <GitBranch size={14} />,
  PROCEDURE: <Database size={14} />,
  SQL: <Database size={14} />,
  SPARK: <Zap size={14} />,
  FLINK: <Waves size={14} />,
  FLINK_STREAM: <Waves size={14} />,
  MR: <Zap size={14} />,
  PYTHON: <Code2 size={14} />,
  DEPENDENT: <GitMerge size={14} />,
  HTTP: <Globe size={14} />,
  DATAX: <ArrowRightLeft size={14} />,
  SQOOP: <ArrowRightLeft size={14} />,
  CONDITIONS: <GitMerge size={14} />,
  SWITCH: <Shuffle size={14} />,
  SEATUNNEL: <Waves size={14} />,
  K8S: <Container size={14} />,
  JAVA: <Coffee size={14} />,
  GRPC: <Radio size={14} />,
  EMR: <Cloud size={14} />,
  ZEPPELIN: <Code2 size={14} />,
  JUPYTER: <Code2 size={14} />,
  MLFLOW: <Brain size={14} />,
  OPENMLDB: <Database size={14} />,
  DVC: <GitBranch size={14} />,
  DINKY: <Database size={14} />,
  SAGEMAKER: <Brain size={14} />,
  CHUNJUN: <ArrowRightLeft size={14} />,
  HIVECLI: <Database size={14} />,
  DMS: <Database size={14} />,
  DATASYNC: <ArrowRightLeft size={14} />,
  KUBEFLOW: <Container size={14} />,
  LINKIS: <Server size={14} />,
  DATA_FACTORY: <Network size={14} />,
  REMOTESHELL: <Terminal size={14} />,
  ALIYUN_SERVERLESS_SPARK: <Cloud size={14} />,
};

const NODE_WIDTH = 180;
const NODE_HEIGHT = 44;
const GRID_SIZE = 20;

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
  const [nodes, setNodes] = useState<DSWorkflowTaskNode[]>(existingNodes || []);
  const [edges, setEdges] = useState<DSWorkflowEdge[]>(existingEdges || []);
  const taskCodeCounter = useRef(1);
  const nextTaskCode = useCallback(() => Date.now() + taskCodeCounter.current++, []);
  const [selectedNodeCode, setSelectedNodeCode] = useState<number | null>(null);
  const [connectingFrom, setConnectingFrom] = useState<number | null>(null);
  const [connectingMousePos, setConnectingMousePos] = useState<{ x: number; y: number } | null>(null);
  const [canvasOffset, setCanvasOffset] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const [draggingNode, setDraggingNode] = useState<number | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set(['universal']));

  const [showSaveModal, setShowSaveModal] = useState(false);
  const [showTaskModal, setShowTaskModal] = useState(false);
  const [showTriggerModal, setShowTriggerModal] = useState(false);
  const [editingTask, setEditingTask] = useState<DSWorkflowTaskNode | null>(null);

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

  const canvasRef = useRef<HTMLDivElement>(null);

  const toggleCategory = (catId: string) => {
    setExpandedCategories(prev => {
      const next = new Set(prev);
      if (next.has(catId)) next.delete(catId);
      else next.add(catId);
      return next;
    });
  };

  const handleAddNode = useCallback((taskType: DSTaskType) => {
    if (readonly) return;
    const newCode = nextTaskCode();
    const offset = nodes.length * 30;
    const newNode: DSWorkflowTaskNode = {
      code: newCode,
      name: `${TASK_TYPE_LABELS[taskType]}_${nodes.length + 1}`,
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
      x: 100 + offset,
      y: 100 + offset,
    };
    setNodes(prev => [...prev, newNode]);
    setSelectedNodeCode(newCode);
  }, [nodes, readonly]);

  const handleNodeDragStart = useCallback((e: React.MouseEvent, nodeCode: number) => {
    if (readonly) return;
    e.stopPropagation();
    const node = nodes.find(n => n.code === nodeCode);
    if (!node) return;
    setDraggingNode(nodeCode);
    const rect = canvasRef.current?.getBoundingClientRect();
    if (rect) {
      setDragOffset({
        x: e.clientX - rect.left - node.x * zoom + canvasOffset.x,
        y: e.clientY - rect.top - node.y * zoom + canvasOffset.y,
      });
    }
  }, [nodes, readonly, zoom, canvasOffset]);

  const handleCanvasMouseMove = useCallback((e: React.MouseEvent) => {
    if (draggingNode !== null) {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const rawX = (e.clientX - rect.left - canvasOffset.x - dragOffset.x) / zoom;
      const rawY = (e.clientY - rect.top - canvasOffset.y - dragOffset.y) / zoom;
      const x = Math.max(0, Math.round(rawX / GRID_SIZE) * GRID_SIZE);
      const y = Math.max(0, Math.round(rawY / GRID_SIZE) * GRID_SIZE);
      setNodes(prev => prev.map(n => n.code === draggingNode ? { ...n, x, y } : n));
    }
    if (isPanning) {
      const dx = e.clientX - panStart.x;
      const dy = e.clientY - panStart.y;
      setCanvasOffset(prev => ({ x: prev.x + dx, y: prev.y + dy }));
      setPanStart({ x: e.clientX, y: e.clientY });
    }
    if (connectingFrom !== null) {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (rect) {
        const svgX = (e.clientX - rect.left - canvasOffset.x) / zoom;
        const svgY = (e.clientY - rect.top - canvasOffset.y) / zoom;
        setConnectingMousePos({ x: svgX, y: svgY });
      }
    }
  }, [draggingNode, isPanning, panStart, dragOffset, zoom, canvasOffset, connectingFrom]);

  const handleCanvasMouseUp = useCallback(() => {
    setDraggingNode(null);
    setIsPanning(false);
    if (connectingFrom !== null) {
      setConnectingFrom(null);
      setConnectingMousePos(null);
    }
  }, [connectingFrom]);

  const handleCanvasMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.target === canvasRef.current || (e.target as HTMLElement).classList.contains('wf-canvas__grid')) {
      setSelectedNodeCode(null);
      setConnectingFrom(null);
      setConnectingMousePos(null);
      if (e.button === 1 || (e.button === 0 && e.altKey)) {
        setIsPanning(true);
        setPanStart({ x: e.clientX, y: e.clientY });
      }
    }
  }, []);

  const handleNodeClick = useCallback((e: React.MouseEvent, nodeCode: number) => {
    e.stopPropagation();
    if (connectingFrom !== null && connectingFrom !== nodeCode) {
      const exists = edges.some(e => e.sourceCode === connectingFrom && e.targetCode === nodeCode);
      const selfLoop = connectingFrom === nodeCode;
      if (!exists && !selfLoop) {
        setEdges(prev => [...prev, {
          id: `edge_${connectingFrom}_${nodeCode}`,
          sourceCode: connectingFrom,
          targetCode: nodeCode,
        }]);
      }
      setConnectingFrom(null);
      setConnectingMousePos(null);
    } else if (connectingFrom === null) {
      setSelectedNodeCode(nodeCode);
    }
  }, [connectingFrom, edges]);

  const handleNodeRightClick = useCallback((e: React.MouseEvent, nodeCode: number) => {
    e.preventDefault();
    e.stopPropagation();
    if (readonly) return;
    setConnectingFrom(nodeCode);
  }, [readonly]);

  const handleOutputPortMouseDown = useCallback((e: React.MouseEvent, nodeCode: number) => {
    if (readonly) return;
    e.stopPropagation();
    e.preventDefault();
    setConnectingFrom(nodeCode);
    const rect = canvasRef.current?.getBoundingClientRect();
    if (rect) {
      const svgX = (e.clientX - rect.left - canvasOffset.x) / zoom;
      const svgY = (e.clientY - rect.top - canvasOffset.y) / zoom;
      setConnectingMousePos({ x: svgX, y: svgY });
    }
  }, [readonly, canvasOffset, zoom]);

  const handleNodeMouseUp = useCallback((e: React.MouseEvent, nodeCode: number) => {
    if (connectingFrom !== null && connectingFrom !== nodeCode) {
      e.stopPropagation();
      const exists = edges.some(e => e.sourceCode === connectingFrom && e.targetCode === nodeCode);
      if (!exists) {
        setEdges(prev => [...prev, {
          id: `edge_${connectingFrom}_${nodeCode}`,
          sourceCode: connectingFrom,
          targetCode: nodeCode,
        }]);
      }
      setConnectingFrom(null);
      setConnectingMousePos(null);
    }
  }, [connectingFrom, edges]);

  const handleDeleteSelected = useCallback(() => {
    if (readonly || selectedNodeCode === null) return;
    setNodes(prev => prev.filter(n => n.code !== selectedNodeCode));
    setEdges(prev => prev.filter(e => e.sourceCode !== selectedNodeCode && e.targetCode !== selectedNodeCode));
    setSelectedNodeCode(null);
  }, [readonly, selectedNodeCode]);

  const handleDeleteEdge = useCallback((edgeId: string) => {
    if (readonly) return;
    setEdges(prev => prev.filter(e => e.id !== edgeId));
  }, [readonly]);

  const handleEditNode = useCallback((node: DSWorkflowTaskNode) => {
    if (readonly) return;
    setEditingTask({ ...node });
    setShowTaskModal(true);
  }, [readonly]);

  const handleSaveTask = useCallback((task: DSWorkflowTaskNode, newEdges?: DSWorkflowEdge[]) => {
    setNodes(prev => prev.map(n => n.code === task.code ? task : n));
    if (newEdges) {
      setEdges(newEdges);
    }
    setShowTaskModal(false);
    setEditingTask(null);
  }, []);

  const handleZoomIn = () => setZoom(prev => Math.min(prev + 0.1, 2));
  const handleZoomOut = () => setZoom(prev => Math.max(prev - 0.1, 0.3));
  const handleResetView = () => { setZoom(1); setCanvasOffset({ x: 0, y: 0 }); };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedNodeCode !== null && !showTaskModal && !showSaveModal && !showTriggerModal) {
          handleDeleteSelected();
        }
      }
      if (e.key === 'Escape') {
        setConnectingFrom(null);
        setConnectingMousePos(null);
        setSelectedNodeCode(null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedNodeCode, handleDeleteSelected, showTaskModal, showSaveModal, showTriggerModal]);

  const renderEdge = (edge: DSWorkflowEdge) => {
    const sourceNode = nodes.find(n => n.code === edge.sourceCode);
    const targetNode = nodes.find(n => n.code === edge.targetCode);
    if (!sourceNode || !targetNode) return null;

    const sx = sourceNode.x + NODE_WIDTH / 2;
    const sy = sourceNode.y + NODE_HEIGHT;
    const tx = targetNode.x + NODE_WIDTH / 2;
    const ty = targetNode.y;

    const midY = (sy + ty) / 2;
    const path = `M ${sx} ${sy} C ${sx} ${midY}, ${tx} ${midY}, ${tx} ${ty}`;

    const angle = Math.atan2(ty - midY, 0);
    const arrowSize = 16;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const p1x = tx + (-arrowSize / 2) * cos - (-arrowSize) * sin;
    const p1y = ty + (-arrowSize / 2) * sin + (-arrowSize) * cos;
    const p2x = tx + (arrowSize / 2) * cos - (-arrowSize) * sin;
    const p2y = ty + (arrowSize / 2) * sin + (-arrowSize) * cos;
    const arrowPoints = `${p1x},${p1y} ${p2x},${p2y} ${tx},${ty}`;

    return (
      <g key={edge.id} className="wf-edge" onDoubleClick={() => handleDeleteEdge(edge.id)}>
        <path d={path} className="wf-edge__hitarea" />
        <path d={path} className="wf-edge__line" />
        <polygon points={arrowPoints} className="wf-edge__arrow" />
      </g>
    );
  };

  const renderTempConnection = () => {
    if (connectingFrom === null || connectingMousePos === null) return null;
    const sourceNode = nodes.find(n => n.code === connectingFrom);
    if (!sourceNode) return null;

    const sx = sourceNode.x + NODE_WIDTH / 2;
    const sy = sourceNode.y + NODE_HEIGHT;
    const tx = connectingMousePos.x;
    const ty = connectingMousePos.y;

    const midY = (sy + ty) / 2;
    const path = `M ${sx} ${sy} C ${sx} ${midY}, ${tx} ${midY}, ${tx} ${ty}`;

    return (
      <path d={path} className="wf-edge__temp" />
    );
  };

  const renderNode = (node: DSWorkflowTaskNode) => {
    const isSelected = selectedNodeCode === node.code;
    const isConnecting = connectingFrom === node.code;
    const isConnectingTarget = connectingFrom !== null && connectingFrom !== node.code;
    const icon = TASK_TYPE_ICONS[node.taskType] || <Terminal size={14} />;

    return (
      <g
        key={node.code}
        className={`wf-node ${isSelected ? 'wf-node--selected' : ''} ${isConnecting ? 'wf-node--connecting' : ''} ${isConnectingTarget ? 'wf-node--connect-target' : ''}`}
        transform={`translate(${node.x}, ${node.y})`}
        onMouseDown={e => handleNodeDragStart(e, node.code)}
        onClick={e => handleNodeClick(e, node.code)}
        onContextMenu={e => handleNodeRightClick(e, node.code)}
        onDoubleClick={() => handleEditNode(node)}
        onMouseUp={e => handleNodeMouseUp(e, node.code)}
      >
        <rect
          width={NODE_WIDTH}
          height={NODE_HEIGHT}
          rx={6}
          ry={6}
          className="wf-node__bg"
        />
        <rect
          width={4}
          height={NODE_HEIGHT}
          rx={2}
          ry={2}
          className="wf-node__indicator"
        />
        <g transform={`translate(12, ${(NODE_HEIGHT - 14) / 2})`}>
          {icon}
        </g>
        <text x={32} y={NODE_HEIGHT / 2} className="wf-node__name" dominantBaseline="middle">
          {node.name}
        </text>
        <text x={NODE_WIDTH - 8} y={NODE_HEIGHT / 2} className="wf-node__type" dominantBaseline="middle" textAnchor="end">
          {node.taskType}
        </text>
        {isSelected && (
          <rect
            width={NODE_WIDTH}
            height={NODE_HEIGHT}
            rx={6}
            ry={6}
            className="wf-node__selection"
          />
        )}
        {!readonly && (
          <>
            <circle
              cx={NODE_WIDTH / 2}
              cy={NODE_HEIGHT}
              r={6}
              className="wf-node__port wf-node__port--out"
              onMouseDown={e => handleOutputPortMouseDown(e, node.code)}
            />
            <circle
              cx={NODE_WIDTH / 2}
              cy={NODE_HEIGHT}
              r={14}
              className="wf-node__port-hitarea"
              onMouseDown={e => handleOutputPortMouseDown(e, node.code)}
            />
          </>
        )}
        {isConnectingTarget && (
          <circle
            cx={NODE_WIDTH / 2}
            cy={0}
            r={6}
            className="wf-node__port wf-node__port--in"
          />
        )}
      </g>
    );
  };

  return (
    <div className="wf-editor">
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
          <div className="wf-toolbar__separator" />
          <button className="sm-btn sm-btn--ghost sm-btn--xs" onClick={handleDeleteSelected} disabled={selectedNodeCode === null || readonly} title="删除选中">
            <Trash2 size={14} />
          </button>
          <button className="sm-btn sm-btn--ghost sm-btn--xs" title="移动画布 (Alt+拖拽)">
            <Move size={14} />
          </button>
        </div>
        <div className="wf-toolbar__right">
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
        {!readonly && (
          <div className="wf-editor__sidebar">
            <div className="wf-sidebar__header">
              <span>任务节点</span>
            </div>
            <div className="wf-sidebar__content">
              {TASK_CATEGORIES.map(cat => (
                <div key={cat.id} className="wf-sidebar__category">
                  <button
                    className="wf-sidebar__category-header"
                    onClick={() => toggleCategory(cat.id)}
                  >
                    {expandedCategories.has(cat.id) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <span>{cat.label}</span>
                    <span className="wf-sidebar__count">{cat.tasks.length}</span>
                  </button>
                  {expandedCategories.has(cat.id) && (
                    <div className="wf-sidebar__category-tasks">
                      {cat.tasks.map(taskType => (
                        <button
                          key={taskType}
                          className="wf-sidebar__task-item"
                          onDoubleClick={() => handleAddNode(taskType)}
                          draggable
                          onDragStart={e => {
                            e.dataTransfer.setData('taskType', taskType);
                          }}
                        >
                          <span className="wf-sidebar__task-icon">
                            {TASK_TYPE_ICONS[taskType] || <Terminal size={14} />}
                          </span>
                          <span className="wf-sidebar__task-name">{TASK_TYPE_LABELS[taskType]}</span>
                          <Plus size={12} className="wf-sidebar__task-add" />
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
            {connectingFrom !== null && (
              <div className="wf-sidebar__hint">
                点击目标节点完成连线，按 Esc 取消
              </div>
            )}
          </div>
        )}

        <div
          className="wf-editor__canvas-container"
          ref={canvasRef}
          onMouseDown={handleCanvasMouseDown}
          onMouseMove={handleCanvasMouseMove}
          onMouseUp={handleCanvasMouseUp}
          onMouseLeave={handleCanvasMouseUp}
          onDrop={e => {
            e.preventDefault();
            const taskType = e.dataTransfer.getData('taskType') as DSTaskType;
            if (taskType) handleAddNode(taskType);
          }}
          onDragOver={e => e.preventDefault()}
        >
          <svg
            className="wf-canvas"
            style={{
              transform: `translate(${canvasOffset.x}px, ${canvasOffset.y}px) scale(${zoom})`,
              transformOrigin: '0 0',
            }}
          >
            <defs>
              <pattern id="grid" width={GRID_SIZE} height={GRID_SIZE} patternUnits="userSpaceOnUse">
                <path d={`M ${GRID_SIZE} 0 L 0 0 0 ${GRID_SIZE}`} fill="none" stroke="#2a2d2e" strokeWidth="0.5" />
              </pattern>
            </defs>
            <rect className="wf-canvas__grid" width="10000" height="10000" fill="url(#grid)" />
            {edges.map(renderEdge)}
            {renderTempConnection()}
            {nodes.map(renderNode)}
          </svg>

          {nodes.length === 0 && (
            <div className="wf-canvas__empty">
              <GitBranch size={48} strokeWidth={1} />
              <p>点击左侧任务节点添加到画布</p>
              <span>双击节点编辑配置，拖拽底部端口创建连线</span>
            </div>
          )}
        </div>
      </div>

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
            onSave({
              name: saveForm.name || '',
              description: saveForm.description || '',
              executionType: saveForm.executionType,
              timeout: saveForm.timeoutFlag ? saveForm.timeout : 0,
              globalParams: saveForm.globalParams,
              nodes,
              edges,
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
