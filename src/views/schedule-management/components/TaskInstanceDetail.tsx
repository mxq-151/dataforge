import { useState, useEffect } from 'react';
import {
  ArrowLeft, Eye, CheckCircle, Clock, User, HardDrive,
  RefreshCw, FileText, Code2, GitBranch,
} from 'lucide-react';
import type { DSTaskInstance, DolphinSchedulerApi } from '../../../types/dolphinscheduler';
import { TaskExecutionStatus } from '../../../types/dolphinscheduler';
import './TaskInstanceDetail.css';

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

function formatDateTime(dt: string | null | undefined): string {
  if (!dt) return '-';
  try {
    return new Date(dt).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return dt;
  }
}

interface TaskInstanceDetailViewProps {
  task: DSTaskInstance;
  api: DolphinSchedulerApi;
  onBack: () => void;
  onViewLog: (task: DSTaskInstance) => void;
  onForceSuccess: (task: DSTaskInstance) => void;
  onViewWorkflowInstance?: (processInstanceId: number) => void;
}

const TaskInstanceDetailView: React.FC<TaskInstanceDetailViewProps> = ({
  task,
  api,
  onBack,
  onViewLog,
  onForceSuccess,
  onViewWorkflowInstance,
}) => {
  const [logContent, setLogContent] = useState<string>('');
  const [logLoading, setLogLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'info' | 'params' | 'log'>('info');

  useEffect(() => {
    if (activeTab === 'log') {
      setLogLoading(true);
      setLogContent('');
      console.log('[TaskInstanceDetail] Fetching log for task:', task.id, 'projectCode:', task.projectCode);
      api.taskInstance.log(task.projectCode, task.id)
        .then(res => {
          console.log('[TaskInstanceDetail] Log response:', res);
          if (res.code === 0) {
            const logData = res.data as { message?: string } | undefined;
            setLogContent(logData?.message || '暂无日志');
            if (!res.data) {
              console.warn('[TaskInstanceDetail] Log data is empty for task:', task.id);
            }
          } else {
            const errorMsg = res.msg || `获取日志失败 (code: ${res.code})`;
            console.error('[TaskInstanceDetail] Log fetch error:', errorMsg);
            setLogContent(`错误: ${errorMsg}`);
          }
        })
        .catch((e: any) => {
          const errMsg = e.message || e.toString() || '未知错误';
          console.error('[TaskInstanceDetail] Log fetch exception:', e);
          setLogContent(`异常: ${errMsg}`);
        })
        .finally(() => setLogLoading(false));
    }
  }, [activeTab, task, api]);

  const statusCfg = TASK_STATUS_CONFIG[task.state];
  let taskParams: Record<string, unknown> = {};
  try {
    taskParams = task.taskParams ? JSON.parse(task.taskParams) : {};
  } catch { /* ignore */ }

  return (
    <div className="ti-detail">
      <div className="ti-detail__toolbar">
        <div className="ti-toolbar__left">
          <button className="sm-btn sm-btn--ghost" onClick={onBack} title="返回列表">
            <ArrowLeft size={14} />
          </button>
          <span className="ti-toolbar__name">{task.name}</span>
          {statusCfg && (
            <span className="sm-status-badge" style={{ color: statusCfg.color, backgroundColor: statusCfg.bgColor }}>
              {statusCfg.isSpin && <RefreshCw size={10} className="sm-spin-icon" />}
              {statusCfg.label}
            </span>
          )}
          <span className="sm-task-type">{task.taskType}</span>
        </div>
        <div className="ti-toolbar__right">
          <button className="sm-btn sm-btn--ghost sm-btn--xs" onClick={() => onViewLog(task)}>
            <Eye size={12} /> 查看日志
          </button>
          {(task.state === TaskExecutionStatus.FAILURE || task.state === TaskExecutionStatus.KILL || task.state === TaskExecutionStatus.NEED_FAULT_TOLERANCE) && (
            <button className="sm-btn sm-btn--warning sm-btn--xs" onClick={() => onForceSuccess(task)}>
              <CheckCircle size={12} /> 强制成功
            </button>
          )}
        </div>
      </div>

      <div className="ti-detail__tabs">
        <button
          className={`ti-detail__tab ${activeTab === 'info' ? 'ti-detail__tab--active' : ''}`}
          onClick={() => setActiveTab('info')}
        >
          <FileText size={14} /> 执行信息
        </button>
        <button
          className={`ti-detail__tab ${activeTab === 'params' ? 'ti-detail__tab--active' : ''}`}
          onClick={() => setActiveTab('params')}
        >
          <Code2 size={14} /> 任务参数
        </button>
        <button
          className={`ti-detail__tab ${activeTab === 'log' ? 'ti-detail__tab--active' : ''}`}
          onClick={() => setActiveTab('log')}
        >
          <FileText size={14} /> 运行日志
        </button>
      </div>

      <div className="ti-detail__content">
        {activeTab === 'info' && (
          <div className="ti-info">
            <div className="ti-info__section">
              <h4 className="ti-info__title">基本信息</h4>
              <div className="ti-info__grid">
                <div className="ti-info__item">
                  <span className="ti-info__label"><User size={12} /> 执行人</span>
                  <span className="ti-info__value">{task.executorName || '-'}</span>
                </div>
                <div className="ti-info__item">
                  <span className="ti-info__label"><Clock size={12} /> 开始时间</span>
                  <span className="ti-info__value">{formatDateTime(task.startTime)}</span>
                </div>
                <div className="ti-info__item">
                  <span className="ti-info__label"><Clock size={12} /> 结束时间</span>
                  <span className="ti-info__value">{formatDateTime(task.endTime)}</span>
                </div>
                <div className="ti-info__item">
                  <span className="ti-info__label"><Clock size={12} /> 耗时</span>
                  <span className="ti-info__value">{task.duration || '-'}</span>
                </div>
                <div className="ti-info__item">
                  <span className="ti-info__label"><RefreshCw size={12} /> 重试次数</span>
                  <span className="ti-info__value">{task.retryTimes}</span>
                </div>
                <div className="ti-info__item">
                  <span className="ti-info__label"><HardDrive size={12} /> Host</span>
                  <span className="ti-info__value">{task.host || '-'}</span>
                </div>
                <div className="ti-info__item">
                  <span className="ti-info__label">PID</span>
                  <span className="ti-info__value">{task.pid || '-'}</span>
                </div>
                <div className="ti-info__item">
                  <span className="ti-info__label">App IDs</span>
                  <span className="ti-info__value ti-info__value--break">{task.appIds || '-'}</span>
                </div>
              </div>
            </div>

            <div className="ti-info__section">
              <h4 className="ti-info__title">工作流信息</h4>
              <div className="ti-info__grid">
                <div className="ti-info__item">
                  <span className="ti-info__label">工作流实例</span>
                  <span className="ti-info__value">
                    {task.processInstanceName || '-'}
                    {onViewWorkflowInstance && (
                      <button className="sm-btn sm-btn--ghost sm-btn--xs" style={{ marginLeft: 4, padding: '1px 6px' }} onClick={() => onViewWorkflowInstance(task.processInstanceId)} title="查看工作流实例">
                        <GitBranch size={10} />
                      </button>
                    )}
                  </span>
                </div>
                <div className="ti-info__item">
                  <span className="ti-info__label">工作流定义</span>
                  <span className="ti-info__value">{task.processDefinitionName || '-'}</span>
                </div>
                <div className="ti-info__item">
                  <span className="ti-info__label">Worker组</span>
                  <span className="ti-info__value">{task.workerGroup || '-'}</span>
                </div>
                <div className="ti-info__item">
                  <span className="ti-info__label">优先级</span>
                  <span className="ti-info__value">{task.taskInstancePriority}</span>
                </div>
                <div className="ti-info__item">
                  <span className="ti-info__label">延迟时间</span>
                  <span className="ti-info__value">{task.delayTime}s</span>
                </div>
                <div className="ti-info__item">
                  <span className="ti-info__label">Dry Run</span>
                  <span className="ti-info__value">{task.dryRun === 1 ? '是' : '否'}</span>
                </div>
              </div>
            </div>

            <div className="ti-info__section">
              <h4 className="ti-info__title">路径信息</h4>
              <div className="ti-info__grid">
                <div className="ti-info__item ti-info__item--full">
                  <span className="ti-info__label">日志路径</span>
                  <span className="ti-info__value ti-info__value--break ti-info__value--path">{task.logPath || '-'}</span>
                </div>
                <div className="ti-info__item ti-info__item--full">
                  <span className="ti-info__label">执行路径</span>
                  <span className="ti-info__value ti-info__value--break ti-info__value--path">{task.executePath || '-'}</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'params' && (
          <div className="ti-params">
            <div className="ti-params__section">
              <h4 className="ti-params__title">任务参数</h4>
              <pre className="ti-params__code">
                {JSON.stringify(taskParams, null, 2)}
              </pre>
            </div>
          </div>
        )}

        {activeTab === 'log' && (
          <div className="ti-log">
            {logLoading ? (
              <div className="sm-loading">
                <RefreshCw size={14} className="sm-spin" />
                <span>加载日志中...</span>
              </div>
            ) : (
              <pre className="ti-log__content">{logContent || '暂无日志'}</pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default TaskInstanceDetailView;
