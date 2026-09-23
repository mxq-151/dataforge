/**
 * 告警订阅页签（数据质量 → 告警订阅）
 *
 * ── 定位 ────────────────────────────────────────────────────
 * 订阅挂在质检任务上：命中哪些校验结果时告警（橙色异常 / 红色异常 / 校验失败）、
 * 发给谁、走哪些渠道。渠道第一期只落站内记录，Webhook 与邮件作为可选渠道保留编码，
 * 由服务端决定是否真正投递 —— 前端只负责订阅配置的采集与回显。
 *
 * ── 接口 ────────────────────────────────────────────────────
 * 走 api/quality 的 /quality/alert（suppressError: true），读失败在页签内呈现，
 * 写失败用 toast 提示。接口只提供 GET / POST：启停与编辑都通过 POST 覆盖保存。
 */

import { useCallback, useEffect, useState } from 'react';
import { Plus, Edit3, Power, CircleAlert } from 'lucide-react';
import { qualityApi } from '../../api/quality';
import type { QualityAlertSubscriptionVO, QualityTaskVO } from '../../types/quality';
import { useToast } from '../../components/Toast';

const PAGE_SIZE = 10;

/** 触发告警的结果状态，取值与 types/quality 的 QualityCheckStatus 一致 */
const NOTIFY_OPTIONS = [
  { code: 'WARN', label: '橙色异常' },
  { code: 'ERROR', label: '红色异常' },
  { code: 'FAILED', label: '校验失败' },
];

/** 渠道编码。第一期只落站内记录，其余渠道由服务端决定是否投递 */
const CHANNEL_OPTIONS = [
  { code: 'INBOX', label: '站内记录' },
  { code: 'EMAIL', label: '邮件' },
  { code: 'WEBHOOK', label: 'Webhook' },
];

const NOTIFY_LABEL: Record<string, string> = Object.fromEntries(NOTIFY_OPTIONS.map(o => [o.code, o.label]));
const CHANNEL_LABEL: Record<string, string> = Object.fromEntries(CHANNEL_OPTIONS.map(o => [o.code, o.label]));

/** 逗号分隔的编码串 → 展示文案（未知编码原样展示，便于排查后端新增取值） */
const splitCodes = (value: string) => (value ? value.split(',').map(s => s.trim()).filter(Boolean) : []);

interface AlertFormState {
  id?: number;
  taskId: number | null;
  notifyOn: string[];
  channels: string[];
  receivers: string;
  enabled: boolean;
}

const emptyForm = (): AlertFormState => ({
  taskId: null,
  notifyOn: ['ERROR', 'FAILED'],
  channels: ['INBOX'],
  receivers: '',
  enabled: true,
});

function toForm(row: QualityAlertSubscriptionVO): AlertFormState {
  return {
    id: row.id,
    taskId: row.taskId,
    notifyOn: splitCodes(row.notifyOn),
    channels: splitCodes(row.channels),
    receivers: row.receivers ?? '',
    enabled: row.enabled ?? true,
  };
}

/** 编码多选：用按钮组而非原生多选，避免下拉里「选中项不可见」的交互成本 */
const CodePicker: React.FC<{
  options: Array<{ code: string; label: string }>;
  selected: string[];
  onChange: (next: string[]) => void;
}> = ({ options, selected, onChange }) => (
  <div className="dq-check-group">
    {options.map(opt => {
      const on = selected.includes(opt.code);
      return (
        <button
          key={opt.code}
          type="button"
          aria-pressed={on}
          className={`dq-check ${on ? 'dq-check--on' : ''}`}
          onClick={() => onChange(on ? selected.filter(c => c !== opt.code) : [...selected, opt.code])}
        >
          {opt.label}
        </button>
      );
    })}
  </div>
);

const AlertTab: React.FC = () => {
  const toast = useToast();

  const [items, setItems] = useState<QualityAlertSubscriptionVO[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const [tasks, setTasks] = useState<QualityTaskVO[]>([]);
  const [tasksLoaded, setTasksLoaded] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<AlertFormState>(emptyForm);
  const [submitting, setSubmitting] = useState(false);

  const loadItems = useCallback(async () => {
    setLoading(true);
    try {
      const res = await qualityApi.listAlertSubscriptions({ current: page, size: PAGE_SIZE });
      setItems(res.data?.records ?? []);
      setTotal(res.data?.total ?? 0);
      setFailed(false);
    } catch {
      setItems([]);
      setTotal(0);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  /** 订阅必须选任务，任务候选只在弹窗打开时拉取（任务量大时不占用页签加载时间） */
  useEffect(() => {
    if (!dialogOpen) return;
    setTasksLoaded(false);
    (async () => {
      try {
        const res = await qualityApi.listTasks({ current: 1, size: 200 });
        setTasks(res.data?.records ?? []);
      } catch {
        setTasks([]);
      } finally {
        setTasksLoaded(true);
      }
    })();
  }, [dialogOpen]);

  const openCreate = () => {
    setForm(emptyForm());
    setDialogOpen(true);
  };

  const openEdit = (row: QualityAlertSubscriptionVO) => {
    setForm(toForm(row));
    setDialogOpen(true);
  };

  const handleToggleEnabled = async (row: QualityAlertSubscriptionVO) => {
    try {
      await qualityApi.saveAlertSubscription({
        id: row.id,
        taskId: row.taskId,
        notifyOn: row.notifyOn,
        channels: row.channels,
        receivers: row.receivers,
        enabled: !row.enabled,
      });
      toast.info(`「${row.taskName || row.taskId}」的订阅已${row.enabled ? '停用' : '启用'}`);
      loadItems();
    } catch (e) {
      toast.error(`操作失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleSubmit = async () => {
    if (!form.taskId) {
      toast.warning('请选择要订阅的质检任务');
      return;
    }
    if (form.notifyOn.length === 0) {
      toast.warning('请选择触发告警的校验结果');
      return;
    }
    if (form.channels.length === 0) {
      toast.warning('请选择至少一个告警渠道');
      return;
    }

    setSubmitting(true);
    try {
      await qualityApi.saveAlertSubscription({
        id: form.id,
        taskId: form.taskId,
        notifyOn: form.notifyOn.join(','),
        channels: form.channels.join(','),
        receivers: form.receivers.trim(),
        enabled: form.enabled,
      });
      setDialogOpen(false);
      toast.info(form.id ? '订阅已更新' : '订阅已创建');
      loadItems();
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
          <span>告警订阅接口不可用，暂时无法加载订阅清单。</span>
        </div>
        <p className="dq-placeholder__lead">
          请确认服务端 /api/quality/alert 已部署且当前账号有权限，然后点击右上角「重新加载」。
        </p>
      </div>
    );
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const selectedTask = tasks.find(t => t.id === form.taskId);

  return (
    <div>
      <div className="dq-toolbar">
        <p className="dq-muted dq-toolbar__lead">
          订阅挂在质检任务上：命中选定结果时按渠道通知接收人。第一期渠道只落站内记录，
          接收人支持逗号分隔多人。
        </p>
        <button className="dq-btn dq-btn--primary" onClick={openCreate}>
          <Plus size={14} /> 新增订阅
        </button>
      </div>

      <table className="dq-table">
        <thead>
          <tr>
            <th>订阅任务</th>
            <th>触发条件</th>
            <th>渠道</th>
            <th>接收人</th>
            <th>状态</th>
            <th className="dq-th-actions">操作</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td colSpan={6} className="dq-table-empty">
                加载中…
              </td>
            </tr>
          ) : items.length === 0 ? (
            <tr>
              <td colSpan={6} className="dq-table-empty">
                暂无告警订阅，点击「新增订阅」为质检任务配置通知。
              </td>
            </tr>
          ) : (
            items.map(row => (
              <tr key={row.id}>
                <td className="dq-table__strong">{row.taskName || `任务 #${row.taskId}`}</td>
                <td>
                  <div className="dq-chips">
                    {splitCodes(row.notifyOn).map(code => (
                      <span className="dq-tag dq-tag--warn" key={code}>
                        {NOTIFY_LABEL[code] ?? code}
                      </span>
                    ))}
                  </div>
                </td>
                <td>
                  <div className="dq-chips">
                    {splitCodes(row.channels).map(code => (
                      <span className="dq-tag" key={code}>
                        {CHANNEL_LABEL[code] ?? code}
                      </span>
                    ))}
                  </div>
                </td>
                <td>{row.receivers || '—'}</td>
                <td>
                  <span className={`dq-tag dq-tag--${row.enabled ? 'success' : 'danger'}`}>
                    {row.enabled ? '启用' : '停用'}
                  </span>
                </td>
                <td className="dq-td-actions">
                  <button className="dq-btn-link" onClick={() => openEdit(row)}>
                    <Edit3 size={12} /> 编辑
                  </button>
                  <button className="dq-btn-link" onClick={() => handleToggleEnabled(row)}>
                    <Power size={12} /> {row.enabled ? '停用' : '启用'}
                  </button>
                </td>
              </tr>
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
          <div className="dq-modal dq-modal--sm">
            <div className="dq-modal-header">
              <h3>{form.id ? '编辑告警订阅' : '新增告警订阅'}</h3>
              <button className="dq-modal-close" onClick={() => setDialogOpen(false)}>
                ×
              </button>
            </div>
            <div className="dq-modal-body">
              <div className="dq-form-group">
                <label>
                  质检任务 <span className="dq-required">*</span>
                </label>
                <select
                  className="dq-select"
                  value={form.taskId ?? ''}
                  onChange={e => setForm(f => ({ ...f, taskId: e.target.value ? Number(e.target.value) : null }))}
                >
                  <option value="">请选择质检任务</option>
                  {tasksLoaded && !selectedTask && form.taskId && (
                    <option value={form.taskId}>任务 #{form.taskId}（当前值）</option>
                  )}
                  {tasks.map(t => (
                    <option key={t.id} value={t.id}>
                      {t.taskName}
                    </option>
                  ))}
                </select>
              </div>

              <div className="dq-form-group">
                <label>
                  触发条件 <span className="dq-required">*</span>
                </label>
                <CodePicker
                  options={NOTIFY_OPTIONS}
                  selected={form.notifyOn}
                  onChange={next => setForm(f => ({ ...f, notifyOn: next }))}
                />
                <p className="dq-hint">「校验失败」指校验 SQL 未跑通，与「校验不通过」区分。</p>
              </div>

              <div className="dq-form-group">
                <label>
                  渠道 <span className="dq-required">*</span>
                </label>
                <CodePicker
                  options={CHANNEL_OPTIONS}
                  selected={form.channels}
                  onChange={next => setForm(f => ({ ...f, channels: next }))}
                />
                <p className="dq-hint">第一期只落站内记录，邮件与 Webhook 由服务端决定是否投递。</p>
              </div>

              <div className="dq-form-group">
                <label>接收人</label>
                <input
                  className="dq-input"
                  value={form.receivers}
                  maxLength={255}
                  placeholder="多人用英文逗号分隔，如 zhangsan,lisi"
                  onChange={e => setForm(f => ({ ...f, receivers: e.target.value }))}
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
    </div>
  );
};

export default AlertTab;
