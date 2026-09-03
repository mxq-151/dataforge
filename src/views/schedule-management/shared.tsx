import { useState } from 'react';
import {
  Search, Plus, ChevronLeft, ChevronRight, FileText, RefreshCw,
  AlertTriangle, GitBranch, Play, ArrowRight,
} from 'lucide-react';
import {
  ReleaseState, parseReleaseState,
  WorkflowExecutionStatus, TaskExecutionStatus,
} from '../../types/dolphinscheduler';

/**
 * 调度管理模块的共享层。
 *
 * 多标签页改造后，项目列表页（ProjectListView）与项目详情页（ProjectDetailView）
 * 会同时存在多个实例，两者都要用到状态枚举映射、状态徽标、搜索栏、分页和各类弹窗。
 * 把这些无状态依赖（或仅含自身内部状态）的片段集中到这里，避免在两个组件里各复制一份。
 * 这里只做展示与交互片段，不承担任何数据请求。
 */

export const PAGE_SIZE = 10;

/** 后端返回的工作流实例状态是字符串枚举，需要映射成数字后才能查表取样式。 */
export const WORKFLOW_STATE_STRING_TO_ENUM: Record<string, WorkflowExecutionStatus> = {
  'SUBMITTED_SUCCESS': WorkflowExecutionStatus.SUBMITTED_SUCCESS,
  'RUNNING_EXECUTION': WorkflowExecutionStatus.RUNNING_EXECUTION,
  'READY_PAUSE': WorkflowExecutionStatus.READY_PAUSE,
  'PAUSE': WorkflowExecutionStatus.PAUSE,
  'READY_STOP': WorkflowExecutionStatus.READY_STOP,
  'STOP': WorkflowExecutionStatus.STOP,
  'FAILURE': WorkflowExecutionStatus.FAILURE,
  'SUCCESS': WorkflowExecutionStatus.SUCCESS,
};

export const TASK_STATE_STRING_TO_ENUM: Record<string, TaskExecutionStatus> = {
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

export interface StatusConfig {
  label: string;
  color: string;
  bgColor: string;
  isSpin?: boolean;
}

export const WORKFLOW_STATUS_CONFIG: Record<number, StatusConfig> = {
  [WorkflowExecutionStatus.SUBMITTED_SUCCESS]: { label: '提交成功', color: '#75beff', bgColor: '#1e3a5f' },
  [WorkflowExecutionStatus.RUNNING_EXECUTION]: { label: '运行中', color: '#89d185', bgColor: '#1e4d1e', isSpin: true },
  [WorkflowExecutionStatus.READY_PAUSE]: { label: '准备暂停', color: '#d1d185', bgColor: '#4d4d1e' },
  [WorkflowExecutionStatus.PAUSE]: { label: '已暂停', color: '#d1a855', bgColor: '#4d3a1e' },
  [WorkflowExecutionStatus.READY_STOP]: { label: '准备停止', color: '#d18555', bgColor: '#4d2d1e' },
  [WorkflowExecutionStatus.STOP]: { label: '已停止', color: '#999999', bgColor: '#3c3c3c' },
  [WorkflowExecutionStatus.FAILURE]: { label: '失败', color: '#f48771', bgColor: '#5a1d1d' },
  [WorkflowExecutionStatus.SUCCESS]: { label: '成功', color: '#89d185', bgColor: '#1e4d1e' },
};

export const TASK_STATUS_CONFIG: Record<number, StatusConfig> = {
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

export const RELEASE_STATE_CONFIG: Record<number, StatusConfig> = {
  [ReleaseState.OFFLINE]: { label: '下线', color: '#999999', bgColor: '#3c3c3c' },
  [ReleaseState.ONLINE]: { label: '上线', color: '#89d185', bgColor: '#1e4d1e' },
};

export type ProjectSubTab = 'workflowDefinitions' | 'workflowInstances' | 'taskInstances';

/** 项目详情页内的三个子 Tab。抽到这里是为了让详情页组件保持精简，也便于将来复用到别处。 */
export const PROJECT_SUB_TAB_META: { id: ProjectSubTab; label: string; icon: React.ReactNode }[] = [
  { id: 'workflowDefinitions', label: '工作流定义', icon: <GitBranch size={14} /> },
  { id: 'workflowInstances', label: '工作流实例', icon: <Play size={14} /> },
  { id: 'taskInstances', label: '任务实例', icon: <FileText size={14} /> },
];

export function formatDateTime(dt: string | null | undefined): string {
  if (!dt) return '-';
  try {
    return new Date(dt).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return dt;
  }
}

export function formatDuration(dur: string | null | undefined): string {
  if (!dur) return '-';
  return dur;
}

export function ErrorBar({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className="sm-error-bar">
      <AlertTriangle size={14} />
      <span>{message}</span>
      <button className="sm-error-bar__close" onClick={onClose} title="关闭提示">×</button>
    </div>
  );
}

export function StatusBadge({ status, configMap }: { status: number; configMap: Record<number, StatusConfig> }) {
  const cfg = configMap[status];
  if (!cfg) return <span className="sm-status-badge">未知</span>;
  return (
    <span className="sm-status-badge" style={{ color: cfg.color, backgroundColor: cfg.bgColor }}>
      {cfg.isSpin && <RefreshCw size={10} className="sm-spin-icon" />}
      {cfg.label}
    </span>
  );
}

export function ReleaseBadge({ state }: { state: ReleaseState | string }) {
  const normalized = parseReleaseState(state);
  const cfg = RELEASE_STATE_CONFIG[normalized];
  if (!cfg) return <span className="sm-status-badge">未知</span>;
  return <span className="sm-status-badge" style={{ color: cfg.color, backgroundColor: cfg.bgColor }}>{cfg.label}</span>;
}

export function TaskTypeBadge({ type }: { type: string }) {
  return <span className="sm-task-type">{type}</span>;
}

export function SearchBar({
  value,
  onChange,
  onSearch,
  placeholder = '搜索...',
}: {
  value: string;
  onChange: (v: string) => void;
  onSearch: () => void;
  placeholder?: string;
}) {
  return (
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
      {/* 输入不自动查询（避免每敲一个字就打一次接口），用回车或这个按钮提交 */}
      <button type="button" className="sm-search-bar__submit" onClick={onSearch} title="搜索（回车）">
        <ArrowRight size={13} />
      </button>
    </div>
  );
}

export function Pagination({
  current,
  total,
  onPageChange,
}: {
  current: number;
  total: number;
  onPageChange: (p: number) => void;
}) {
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
}

export function ConfirmModal({
  message,
  onConfirm,
  onCancel,
}: {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
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

export interface InputModalField {
  key: string;
  label: string;
  placeholder?: string;
  required?: boolean;
  defaultValue?: string;
  type?: string;
}

export interface InputModalProps {
  title: string;
  fields: InputModalField[];
  onConfirm: (values: Record<string, string>) => void;
  onCancel: () => void;
}

export function InputModal({ title, fields, onConfirm, onCancel }: InputModalProps) {
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

export function LogModal({
  log,
  loading,
  onClose,
}: {
  log: string;
  loading: boolean;
  onClose: () => void;
}) {
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
