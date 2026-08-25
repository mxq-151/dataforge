import React, { useState, useCallback } from 'react';
import { Terminal, Database, Code2, Zap, Globe, GitBranch, GitMerge, Shuffle, Waves, Container, Coffee, ArrowRightLeft, Cloud, Brain, Radio, Server, Network, X } from 'lucide-react';
import type {
  DSWorkflowTaskNode, DSTaskType, DSWorkflowEdge,
  DSWorkerGroup, DSEnvironment, DolphinSchedulerApi,
} from '../../../../types/dolphinscheduler';
import {
  TASK_TYPE_LABELS, Priority, getDefaultTaskParams,
} from '../../../../types/dolphinscheduler';
import { TASK_FORM_MAP } from './task-forms';
import './task-config.css';

const TASK_TYPE_ICONS: Record<DSTaskType, React.ReactNode> = {
  SHELL: <Terminal size={16} />,
  SUB_PROCESS: <GitBranch size={16} />,
  PROCEDURE: <Database size={16} />,
  SQL: <Database size={16} />,
  SPARK: <Zap size={16} />,
  FLINK: <Waves size={16} />,
  FLINK_STREAM: <Waves size={16} />,
  MR: <Zap size={16} />,
  PYTHON: <Code2 size={16} />,
  DEPENDENT: <GitMerge size={16} />,
  HTTP: <Globe size={16} />,
  DATAX: <ArrowRightLeft size={16} />,
  SQOOP: <ArrowRightLeft size={16} />,
  CONDITIONS: <GitMerge size={16} />,
  SWITCH: <Shuffle size={16} />,
  SEATUNNEL: <Waves size={16} />,
  K8S: <Container size={16} />,
  JAVA: <Coffee size={16} />,
  GRPC: <Radio size={16} />,
  EMR: <Cloud size={16} />,
  ZEPPELIN: <Code2 size={16} />,
  JUPYTER: <Code2 size={16} />,
  MLFLOW: <Brain size={16} />,
  OPENMLDB: <Database size={16} />,
  DVC: <GitBranch size={16} />,
  DINKY: <Database size={16} />,
  SAGEMAKER: <Brain size={16} />,
  CHUNJUN: <ArrowRightLeft size={16} />,
  HIVECLI: <Database size={16} />,
  DMS: <Database size={16} />,
  DATASYNC: <ArrowRightLeft size={16} />,
  KUBEFLOW: <Container size={16} />,
  LINKIS: <Server size={16} />,
  DATA_FACTORY: <Network size={16} />,
  REMOTESHELL: <Terminal size={16} />,
  ALIYUN_SERVERLESS_SPARK: <Cloud size={16} />,
};

interface TaskConfigModalProps {
  task: DSWorkflowTaskNode;
  allNodes: DSWorkflowTaskNode[];
  edges: DSWorkflowEdge[];
  workflowDefinitions?: { code: number; name: string }[];
  workerGroups?: DSWorkerGroup[];
  environments?: DSEnvironment[];
  api?: DolphinSchedulerApi;
  onSave: (task: DSWorkflowTaskNode, newEdges?: DSWorkflowEdge[]) => void;
  onClose: () => void;
  readonly?: boolean;
}

function parseTaskParams(taskType: DSTaskType, taskParamsStr: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(taskParamsStr);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {}
  return getDefaultTaskParams(taskType);
}

export default function TaskConfigModal({ task, allNodes, edges, workflowDefinitions, workerGroups, environments, api, onSave, onClose, readonly }: TaskConfigModalProps) {
  const [form, setForm] = useState<DSWorkflowTaskNode>({ ...task });
  const [taskParamsObj, setTaskParamsObj] = useState<Record<string, unknown>>(() =>
    parseTaskParams(form.taskType, form.taskParams)
  );
  const [activeTab, setActiveTab] = useState<'basic' | 'advanced'>('basic');
  const [selectedPreTasks, setSelectedPreTasks] = useState<number[]>([]);

  React.useEffect(() => {
    const upstreamCodes = new Set<number>();
    edges.forEach(e => {
      if (e.targetCode === form.code) upstreamCodes.add(e.sourceCode);
    });
    setSelectedPreTasks(Array.from(upstreamCodes));
  }, [edges, form.code]);

  const upstreamNodes = React.useMemo(() => {
    return allNodes.filter(n => selectedPreTasks.includes(n.code));
  }, [allNodes, selectedPreTasks]);

  const otherNodes = allNodes.filter(n => n.code !== form.code && !selectedPreTasks.includes(n.code));

  const setFormField = useCallback(<K extends keyof DSWorkflowTaskNode>(key: K, val: DSWorkflowTaskNode[K]) => {
    setForm(prev => ({ ...prev, [key]: val }));
  }, []);

  const handleTaskParamsChange = useCallback((newParams: Record<string, unknown>) => {
    setTaskParamsObj(newParams);
  }, []);

  const handleSave = () => {
    const updatedTask: DSWorkflowTaskNode = {
      ...form,
      taskParams: JSON.stringify(taskParamsObj),
    };

    const newEdges = edges.filter(e => !(e.targetCode === form.code));
    selectedPreTasks.forEach(preTaskCode => {
      newEdges.push({
        id: `edge-${preTaskCode}-${form.code}-${Date.now()}`,
        sourceCode: preTaskCode,
        targetCode: form.code,
      });
    });

    onSave(updatedTask, newEdges);
  };

  const TaskFormComponent = TASK_FORM_MAP[form.taskType];

  const hasNoAdvanced = form.taskType === 'DEPENDENT' || form.taskType === 'CONDITIONS' || form.taskType === 'SWITCH' || form.taskType === 'SUB_PROCESS';

  return (
    <div className="sm-modal-overlay" onClick={onClose}>
      <div className={`sm-modal tc-modal ${readonly ? 'tc-modal--readonly' : ''}`} onClick={e => e.stopPropagation()}>
        <div className="sm-modal__header">
          {TASK_TYPE_ICONS[form.taskType]}
          <span>{readonly ? '任务详情' : '任务配置'} - {TASK_TYPE_LABELS[form.taskType]}</span>
          {readonly && <span className="wf-toolbar__readonly-badge">只读</span>}
        </div>

        <div className="tc-tabs">
          <button
            className={`tc-tab ${activeTab === 'basic' ? 'tc-tab--active' : ''}`}
            onClick={() => setActiveTab('basic')}
          >
            基本配置
          </button>
          {!hasNoAdvanced && (
            <button
              className={`tc-tab ${activeTab === 'advanced' ? 'tc-tab--active' : ''}`}
              onClick={() => setActiveTab('advanced')}
            >
              高级设置
            </button>
          )}
        </div>

        <div className="sm-modal__body tc-modal__body">
          {activeTab === 'basic' && (
            <>
              <div className="tc-section">
                <div className="tc-section__header">
                  <Terminal size={14} />
                  <span>基础信息</span>
                </div>
                <div className="tc-row">
                  <div className="tc-field">
                    <label>任务名称<span className="sm-required">*</span></label>
                    <input
                      type="text"
                      value={form.name}
                      onChange={e => setFormField('name', e.target.value)}
                      placeholder="请输入任务名称"
                    />
                  </div>
                  <div className="tc-field">
                    <label>任务类型</label>
                    <input type="text" value={TASK_TYPE_LABELS[form.taskType]} disabled />
                  </div>
                </div>
                <div className="tc-field">
                  <label>描述</label>
                  <textarea
                    value={form.description}
                    onChange={e => setFormField('description', e.target.value)}
                    placeholder="请输入任务描述"
                    rows={2}
                  />
                </div>
                <div className="tc-field">
                  <label>运行标志</label>
                  <div className="tc-radio-group">
                    <label className="tc-radio">
                      <input
                        type="radio"
                        name="runFlag"
                        checked={form.flag === 'YES'}
                        onChange={() => setFormField('flag', 'YES')}
                      />
                      <span>正常执行</span>
                    </label>
                    <label className="tc-radio">
                      <input
                        type="radio"
                        name="runFlag"
                        checked={form.flag === 'NO'}
                        onChange={() => setFormField('flag', 'NO')}
                      />
                      <span>禁止执行</span>
                    </label>
                  </div>
                </div>
              </div>

              <div className="tc-section">
                <div className="tc-section__header">
                  {TASK_TYPE_ICONS[form.taskType]}
                  <span>{TASK_TYPE_LABELS[form.taskType]} 配置</span>
                </div>
                {TaskFormComponent && (
                  <TaskFormComponent
                    params={taskParamsObj}
                    onChange={handleTaskParamsChange}
                    allNodes={otherNodes}
                    currentCode={form.code}
                    workflowDefinitions={workflowDefinitions}
                    api={api}
                  />
                )}
              </div>

              <div className="tc-section">
                <div className="tc-section__header">
                  <GitMerge size={14} />
                  <span>前置任务</span>
                </div>
                {!readonly && (
                  <div className="tc-field">
                    <label>添加前置任务</label>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <select
                        value=""
                        onChange={(e) => {
                          const code = Number(e.target.value);
                          if (code && !selectedPreTasks.includes(code)) {
                            setSelectedPreTasks(prev => [...prev, code]);
                          }
                        }}
                        style={{ flex: 1, height: 32 }}
                      >
                        <option value="">选择要添加的前置任务</option>
                        {otherNodes.map(n => (
                          <option key={n.code} value={n.code}>{n.name}</option>
                        ))}
                      </select>
                    </div>
                    <div className="tc-help-text">选择其他任务作为当前任务的前置依赖</div>
                  </div>
                )}
                {upstreamNodes.length > 0 && (
                  <div className="tc-field">
                    <label>已选前置任务</label>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {upstreamNodes.map(n => (
                        <span
                          key={n.code}
                          style={{
                            padding: '4px 10px',
                            background: '#2d2d30',
                            border: '1px solid #0078d4',
                            borderRadius: 4,
                            fontSize: 12,
                            color: '#cccccc',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 6,
                          }}
                        >
                          {n.name}
                          {!readonly && (
                            <button
                              onClick={() => setSelectedPreTasks(prev => prev.filter(code => code !== n.code))}
                              style={{
                                background: 'none',
                                border: 'none',
                                color: '#ff6b6b',
                                cursor: 'pointer',
                                padding: 0,
                                display: 'flex',
                                alignItems: 'center',
                              }}
                              title="移除此前置任务"
                            >
                              <X size={12} />
                            </button>
                          )}
                        </span>
                      ))}
                    </div>
                    {upstreamNodes.length === 0 && readonly && (
                      <div style={{ fontSize: 12, color: '#888' }}>无前置任务</div>
                    )}
                  </div>
                )}
                {upstreamNodes.length === 0 && !readonly && (
                  <div style={{ fontSize: 12, color: '#888', padding: '8px 0' }}>
                    暂未配置前置任务，可以从上方下拉框添加
                  </div>
                )}
              </div>
            </>
          )}

          {activeTab === 'advanced' && !hasNoAdvanced && (
            <>
              <div className="tc-section">
                <div className="tc-section__header">
                  <Zap size={14} />
                  <span>执行配置</span>
                </div>
                <div className="tc-row">
                  <div className="tc-field">
                    <label>任务优先级</label>
                    <select
                      value={form.taskPriority}
                      onChange={e => setFormField('taskPriority', e.target.value as Priority)}
                    >
                      <option value="HIGHEST">HIGHEST</option>
                      <option value="HIGH">HIGH</option>
                      <option value="MEDIUM">MEDIUM</option>
                      <option value="LOW">LOW</option>
                      <option value="LOWEST">LOWEST</option>
                    </select>
                  </div>
                  <div className="tc-field">
                    <label>Worker组</label>
                    <select
                      value={form.workerGroup}
                      onChange={e => setFormField('workerGroup', e.target.value)}
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
                </div>
                <div className="tc-row">
                  <div className="tc-field">
                    <label>失败重试次数</label>
                    <input
                      type="number"
                      value={form.failRetryTimes}
                      onChange={e => setFormField('failRetryTimes', parseInt(e.target.value) || 0)}
                      min={0}
                    />
                  </div>
                  <div className="tc-field">
                    <label>失败重试间隔(秒)</label>
                    <input
                      type="number"
                      value={form.failRetryInterval}
                      onChange={e => setFormField('failRetryInterval', parseInt(e.target.value) || 1)}
                      min={1}
                    />
                  </div>
                </div>
              </div>

              <div className="tc-section">
                <div className="tc-section__header">
                  <Container size={14} />
                  <span>超时与延迟</span>
                </div>
                <div className="tc-row">
                  <div className="tc-field">
                    <label>超时告警</label>
                    <select
                      value={form.timeoutFlag}
                      onChange={e => setFormField('timeoutFlag', e.target.value as 'OPEN' | 'CLOSE')}
                    >
                      <option value="CLOSE">关闭</option>
                      <option value="OPEN">开启</option>
                    </select>
                  </div>
                  {form.timeoutFlag === 'OPEN' && (
                    <div className="tc-field">
                      <label>超时时间(分钟)</label>
                      <input
                        type="number"
                        value={form.timeout}
                        onChange={e => setFormField('timeout', parseInt(e.target.value) || 0)}
                        min={1}
                      />
                    </div>
                  )}
                </div>
                <div className="tc-field">
                  <label>延迟执行时间(分钟)</label>
                  <input
                    type="number"
                    value={form.delayTime}
                    onChange={e => setFormField('delayTime', parseInt(e.target.value) || 0)}
                    min={0}
                  />
                </div>
              </div>

              <div className="tc-section">
                <div className="tc-section__header">
                  <Code2 size={14} />
                  <span>环境配置</span>
                </div>
                <div className="tc-field">
                  <label>环境</label>
                  <select
                    value={form.environmentCode}
                    onChange={e => setFormField('environmentCode', parseInt(e.target.value))}
                  >
                    <option value={-1}>默认环境</option>
                    {environments && environments
                      .filter(env => !form.workerGroup || !env.workerGroups || env.workerGroups.length === 0 || env.workerGroups.includes(form.workerGroup))
                      .map(env => (
                        <option key={env.code} value={env.code}>{env.name}{env.description ? ` (${env.description})` : ''}</option>
                      ))}
                  </select>
                  {form.workerGroup && environments && environments.some(env => env.workerGroups && env.workerGroups.length > 0 && !env.workerGroups.includes(form.workerGroup)) && (
                    <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
                      仅显示「{form.workerGroup}」Worker组可用的环境
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        <div className="sm-modal__footer">
          <button className="sm-btn sm-btn--secondary" onClick={onClose}>{readonly ? '关闭' : '取消'}</button>
          {!readonly && (
            <button className="sm-btn sm-btn--primary" onClick={handleSave} disabled={!form.name.trim()}>
              确认
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
