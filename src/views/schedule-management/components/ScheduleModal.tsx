import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Clock, RefreshCw, Save, Trash2, ArrowUpCircle, ArrowDownCircle, AlertTriangle, ShieldAlert,
} from 'lucide-react';
import type {
  DolphinSchedulerApi,
  DSWorkflowDefinition,
  DSSchedule,
  DSScheduleForm,
  DSAlertGroup, DSWorkerGroup, DSEnvironment, DSTenant,
} from '../../../types/dolphinscheduler';
import {
  ReleaseState, parseReleaseState,
  FailureStrategy, WarningType, Priority,
  DEFAULT_SCHEDULE_TIMEZONE, SCHEDULE_TIMEZONE_OPTIONS,
} from '../../../types/dolphinscheduler';
import { useAuth } from '../../../contexts/AuthContext';
import { canManageSchedule } from '../../../utils/roleAccess';
import {
  CRON_PRESETS, validateCrontab, describeCrontab, nextFireTimes, isLocallyComputable,
  defaultScheduleRange, validateScheduleRange,
} from '../../../utils/crontab';
import { ConfirmModal } from '../shared';
import '../ScheduleManagementPanel.css';
import './ScheduleModal.css';

/**
 * 工作流「定时」配置弹窗。
 *
 * 设计要点：
 * 1. **一个工作流只允许一个定时**：DolphinScheduler 对同一工作流重复创建会返回
 *    `SCHEDULE_ALREADY_EXISTS`，所以这里先按 workflowDefinitionCode 查已有定时，
 *    有则进入「编辑既有定时」形态（可更新 / 上下线 / 删除），无则进入「新建」形态。
 * 2. **crontab 是 Quartz 方言**（6/7 段、周字段 1=周日、日/周必须有一个 `?`），
 *    与 Linux crontab 不同。即时反馈走 utils/crontab 的纯函数；
 *    权威口径仍是调度系统 —— 「从调度系统预览」会调用 `schedule.preview` 让 DS 自己算，
 *    遇到本地推导不支持的语法（W / # / nL）也由它兜底。
 * 3. **权限**：定时只对超级管理员与运维人员开放。入口按钮在父组件已做禁用，
 *    这里再做一次门禁（双重防御），避免绕过入口直接打开弹窗后仍能提交。
 * 4. 与模块内既有弹窗（TriggerWorkflowModal）保持同一套结构与样式类，
 *    包括「下拉/输入不做逐字符请求」的约定。
 */

export interface ScheduleModalProps {
  api: DolphinSchedulerApi;
  projectCode: number;
  /** 目标工作流定义 */
  workflow: DSWorkflowDefinition;
  workerGroups?: DSWorkerGroup[];
  environments?: DSEnvironment[];
  alertGroups?: DSAlertGroup[];
  tenants?: DSTenant[];
  onClose: () => void;
  /** 定时发生增删改（含上下线）后通知父级刷新工作流列表 */
  onChanged?: () => void;
}

const PRIORITY_ORDER: Priority[] = [
  Priority.HIGHEST, Priority.HIGH, Priority.MEDIUM, Priority.LOW, Priority.LOWEST,
];

/** 默认表单：每天 02:00、立即生效、长期有效 —— 数仓离线调度的最常见形态 */
export function buildDefaultScheduleForm(): DSScheduleForm {
  const range = defaultScheduleRange();
  return {
    crontab: '0 0 2 * * ?',
    startTime: range.startTime,
    endTime: range.endTime,
    timezoneId: DEFAULT_SCHEDULE_TIMEZONE,
    failureStrategy: FailureStrategy.CONTINUE,
    warningType: WarningType.NONE,
    warningGroupId: null,
    workflowInstancePriority: Priority.MEDIUM,
    workerGroup: 'default',
    environmentCode: null,
    tenantCode: null,
  };
}

/** 把既有的定时记录回填成表单，用于「编辑既有定时」 */
export function scheduleToForm(schedule: DSSchedule): DSScheduleForm {
  const base = buildDefaultScheduleForm();
  return {
    ...base,
    crontab: schedule.crontab || base.crontab,
    startTime: schedule.startTime || base.startTime,
    endTime: schedule.endTime || base.endTime,
    timezoneId: schedule.timezoneId || base.timezoneId,
  };
}

/** 从列表响应里取第一条定时（同一工作流只应有一条） */
function pickFirst(data: unknown): DSSchedule | null {
  if (!data) return null;
  if (Array.isArray(data)) return (data[0] as DSSchedule) ?? null;
  const list = (data as { totalList?: DSSchedule[] }).totalList;
  return Array.isArray(list) ? (list[0] ?? null) : null;
}

const ScheduleModal: React.FC<ScheduleModalProps> = ({
  api,
  projectCode,
  workflow,
  workerGroups,
  environments,
  alertGroups,
  tenants,
  onClose,
  onChanged,
}) => {
  const { user } = useAuth();
  const allowed = canManageSchedule(user);

  const [form, setForm] = useState<DSScheduleForm>(buildDefaultScheduleForm);
  const [existing, setExisting] = useState<DSSchedule | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ message: string; onConfirm: () => void } | null>(null);

  /** 服务端算出的下次触发时间（点「从调度系统预览」后填入） */
  const [serverPreview, setServerPreview] = useState<string[] | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  /** 手工改动 crontab / 时区后，之前拿到的服务端预览就过期了 */
  const invalidateServerPreview = useCallback(() => {
    setServerPreview(null);
    setPreviewError(null);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.schedule.list(projectCode, {
        pageNo: 1,
        pageSize: 50,
        workflowDefinitionCode: workflow.code,
      });
      if (res.code === 0) {
        const found = pickFirst(res.data);
        setExisting(found);
        if (found) setForm(scheduleToForm(found));
      } else {
        setError(res.msg || '获取定时信息失败');
      }
    } catch (e: any) {
      setError(e.message || '获取定时信息失败');
    } finally {
      setLoading(false);
    }
  }, [api, projectCode, workflow.code]);

  useEffect(() => { refresh(); }, [refresh]);

  const cronValidation = useMemo(() => validateCrontab(form.crontab), [form.crontab]);
  const cronDescription = useMemo(
    () => (cronValidation.valid ? describeCrontab(form.crontab) : ''),
    [cronValidation.valid, form.crontab],
  );
  const locallyComputable = useMemo(() => isLocallyComputable(form.crontab), [form.crontab]);
  /** 本地推导的下次触发时间：即时反馈用，不发请求（与模块内「输入不自动查询」一致） */
  const localPreview = useMemo(
    () => (cronValidation.valid ? nextFireTimes(form.crontab, 5, form.timezoneId) : []),
    [cronValidation.valid, form.crontab, form.timezoneId],
  );

  const rangeError = useMemo(
    () => validateScheduleRange(form.startTime, form.endTime),
    [form.startTime, form.endTime],
  );
  const needAlertGroup = form.warningType !== WarningType.NONE && form.warningGroupId === null;

  const workflowOnline = parseReleaseState(workflow.releaseState) === ReleaseState.ONLINE;
  const scheduleOnline = existing ? parseReleaseState(existing.releaseState) === ReleaseState.ONLINE : false;

  const patch = (next: Partial<DSScheduleForm>) => setForm(prev => ({ ...prev, ...next }));

  const handleServerPreview = async () => {
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const res = await api.schedule.preview(projectCode, {
        startTime: form.startTime,
        endTime: form.endTime,
        crontab: form.crontab.trim(),
        timezoneId: form.timezoneId,
      });
      if (res.code === 0) {
        const times = Array.isArray(res.data) ? res.data : [];
        setServerPreview(times);
        if (times.length === 0) setPreviewError('调度系统未返回触发时间，请确认表达式与生效区间');
      } else {
        setPreviewError(res.msg || '预览失败');
      }
    } catch (e: any) {
      setPreviewError(e.message || '预览失败');
    } finally {
      setPreviewLoading(false);
    }
  };

  /** 提交前的闸门：与按钮禁用同源，避免"看起来能点但提交报错" */
  const blockingError = useMemo(() => {
    if (!allowed) return '当前账号无权配置定时调度（仅超级管理员与运维人员可用）';
    if (!cronValidation.valid) return cronValidation.error || 'crontab 表达式不合法';
    if (rangeError) return rangeError;
    if (needAlertGroup) return '已开启通知，请选择告警组';
    return null;
  }, [allowed, cronValidation, rangeError, needAlertGroup]);

  const handleSave = async () => {
    if (blockingError) { setError(blockingError); return; }
    setSaving(true);
    setError(null);
    // 通知策略为「都不发」时清掉告警组，避免把无意义的 id 一起提交
    const payload: DSScheduleForm = {
      ...form,
      crontab: form.crontab.trim(),
      warningGroupId: form.warningType === WarningType.NONE ? null : form.warningGroupId,
    };
    try {
      const res = existing
        ? await api.schedule.update(projectCode, existing.id, workflow.code, payload)
        : await api.schedule.create(projectCode, workflow.code, payload);
      if (res.code === 0) {
        invalidateServerPreview();
        await refresh();
        onChanged?.();
      } else {
        setError(res.msg || (existing ? '更新定时失败' : '创建定时失败'));
      }
    } catch (e: any) {
      setError(e.message || '保存定时失败');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleOnline = () => {
    if (!existing) return;
    const goingOnline = !scheduleOnline;
    if (goingOnline && !workflowOnline) {
      setError('工作流未上线，无法启用定时；请先上线该工作流');
      return;
    }
    setConfirm({
      message: goingOnline
        ? `确定要启用「${workflow.name}」的定时调度吗？启用后将按 crontab 周期自动生成工作流实例。`
        : `确定要停用「${workflow.name}」的定时调度吗？停用后不再自动生成实例，已生成的实例不受影响。`,
      onConfirm: async () => {
        setConfirm(null);
        try {
          const res = goingOnline
            ? await api.schedule.online(projectCode, existing.id)
            : await api.schedule.offline(projectCode, existing.id);
          if (res.code === 0) {
            await refresh();
            onChanged?.();
          } else {
            setError(res.msg || (goingOnline ? '启用定时失败' : '停用定时失败'));
          }
        } catch (e: any) {
          setError(e.message || (goingOnline ? '启用定时失败' : '停用定时失败'));
        }
      },
    });
  };

  const handleDelete = () => {
    if (!existing) return;
    setConfirm({
      message: `确定要删除「${workflow.name}」的定时调度吗？此操作不可恢复。`,
      onConfirm: async () => {
        setConfirm(null);
        try {
          const res = await api.schedule.delete(projectCode, existing.id);
          if (res.code === 0) {
            setExisting(null);
            setForm(buildDefaultScheduleForm());
            invalidateServerPreview();
            await refresh();
            onChanged?.();
          } else {
            setError(res.msg || '删除定时失败');
          }
        } catch (e: any) {
          setError(e.message || '删除定时失败');
        }
      },
    });
  };

  const previewList = serverPreview ?? localPreview;
  const previewSource = serverPreview ? '调度系统' : '本地推算';

  return (
    <div className="sm-modal-overlay" onClick={onClose}>
      <div className="sm-modal sm-modal--schedule" onClick={e => e.stopPropagation()}>
        <div className="sm-modal__header">
          <Clock size={18} />
          <span>定时调度</span>
          <span className="sm-schedule__workflow">{workflow.name}</span>
        </div>

        <div className="sm-modal__body sm-modal__body--schedule">
          {error && (
            <div className="sm-schedule__error" role="alert">
              <AlertTriangle size={14} />
              <span>{error}</span>
            </div>
          )}

          {!allowed && (
            <div className="sm-schedule__notice" role="alert">
              <ShieldAlert size={14} />
              <span>定时调度仅超级管理员与运维人员可配置，当前账号为只读。</span>
            </div>
          )}

          {loading ? (
            <div className="sm-loading">加载中...</div>
          ) : (
            <>
              <div className="sm-schedule__status" data-testid="schedule-status">
                <span>当前状态</span>
                <strong className={scheduleOnline ? 'sm-schedule__status--on' : 'sm-schedule__status--off'}>
                  {existing ? (scheduleOnline ? '已启用' : '已停用') : '未配置定时'}
                </strong>
                {existing && (
                  <span className="sm-schedule__meta">
                    ID {existing.id} · 更新于 {existing.updateTime || '-'}
                  </span>
                )}
              </div>

              {scheduleOnline && (
                <div className="sm-schedule__notice">
                  <AlertTriangle size={14} />
                  <span>定时处于启用状态：部分变更（含 crontab）需要先停用定时才能保存，若保存被拒请先点「停用定时」。</span>
                </div>
              )}

              {/* ---- crontab ---- */}
              <div className="sm-modal__field">
                <label>crontab 表达式<span className="sm-required">*</span></label>
                <input
                  type="text"
                  data-testid="schedule-crontab"
                  value={form.crontab}
                  placeholder="如 0 0 2 * * ?"
                  disabled={!allowed}
                  onChange={e => { patch({ crontab: e.target.value }); invalidateServerPreview(); }}
                />
                <div className="sm-cron-presets">
                  {CRON_PRESETS.map(p => (
                    <button
                      key={p.value}
                      type="button"
                      className={`sm-cron-preset ${form.crontab.trim() === p.value ? 'sm-cron-preset--active' : ''}`}
                      disabled={!allowed}
                      onClick={() => { patch({ crontab: p.value }); invalidateServerPreview(); }}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                {!cronValidation.valid && form.crontab.trim() !== '' && (
                  <div className="sm-field-error">{cronValidation.error}</div>
                )}
                {cronDescription && <div className="sm-field-hint" data-testid="cron-desc">{cronDescription}</div>}
                <div className="sm-field-hint">
                  格式为 Quartz（秒 分 时 日 月 周 [年]），「日」「周」必须有一个写 ?，周字段 1=周日。
                </div>
              </div>

              {/* ---- 下次触发时间 ---- */}
              <div className="sm-modal__field">
                <label>下次触发时间</label>
                <div className="sm-cron-preview" data-testid="cron-preview">
                  {previewList.length === 0 ? (
                    <div className="sm-cron-preview__empty">
                      {locallyComputable
                        ? '暂无法推算，请检查表达式与生效区间'
                        : '该表达式含本地不支持的语法，请点右侧按钮由调度系统预览'}
                    </div>
                  ) : (
                    <ol className="sm-cron-preview__list">
                      {previewList.map((t, i) => <li key={`${t}-${i}`}>{t}</li>)}
                    </ol>
                  )}
                  <div className="sm-cron-preview__side">
                    <button
                      type="button"
                      className="sm-btn sm-btn--ghost"
                      onClick={handleServerPreview}
                      disabled={previewLoading || !cronValidation.valid || !!rangeError}
                    >
                      <RefreshCw size={12} className={previewLoading ? 'sm-spin-icon' : undefined} />
                      从调度系统预览
                    </button>
                    <span className="sm-field-hint">来源：{previewSource}</span>
                    {previewError && <div className="sm-field-error">{previewError}</div>}
                  </div>
                </div>
              </div>

              {/* ---- 生效区间 ---- */}
              <div className="sm-schedule__row">
                <div className="sm-modal__field">
                  <label>生效开始时间<span className="sm-required">*</span></label>
                  <input
                    type="text"
                    value={form.startTime}
                    placeholder="yyyy-MM-dd HH:mm:ss"
                    disabled={!allowed}
                    onChange={e => { patch({ startTime: e.target.value }); invalidateServerPreview(); }}
                  />
                </div>
                <div className="sm-modal__field">
                  <label>生效结束时间<span className="sm-required">*</span></label>
                  <input
                    type="text"
                    value={form.endTime}
                    placeholder="yyyy-MM-dd HH:mm:ss"
                    disabled={!allowed}
                    onChange={e => { patch({ endTime: e.target.value }); invalidateServerPreview(); }}
                  />
                </div>
              </div>
              {rangeError && <div className="sm-field-error">{rangeError}</div>}

              <div className="sm-modal__field">
                <label>时区</label>
                <select
                  className="sm-select"
                  value={form.timezoneId}
                  disabled={!allowed}
                  onChange={e => { patch({ timezoneId: e.target.value }); invalidateServerPreview(); }}
                >
                  {SCHEDULE_TIMEZONE_OPTIONS.map(tz => (
                    <option key={tz.value} value={tz.value}>{tz.label}</option>
                  ))}
                  {/* 历史数据里的自定义时区不在预置列表内，保留为可选项避免被静默改掉 */}
                  {!SCHEDULE_TIMEZONE_OPTIONS.some(tz => tz.value === form.timezoneId) && (
                    <option value={form.timezoneId}>{form.timezoneId}</option>
                  )}
                </select>
              </div>

              {/* ---- 调度属性 ---- */}
              <div className="sm-modal__field">
                <label>失败策略</label>
                <div className="sm-modal__radio-group">
                  <label className="sm-modal__radio">
                    <input
                      type="radio"
                      name="scheduleFailureStrategy"
                      checked={form.failureStrategy === FailureStrategy.CONTINUE}
                      disabled={!allowed}
                      onChange={() => patch({ failureStrategy: FailureStrategy.CONTINUE })}
                    />
                    <span>继续</span>
                  </label>
                  <label className="sm-modal__radio">
                    <input
                      type="radio"
                      name="scheduleFailureStrategy"
                      checked={form.failureStrategy === FailureStrategy.END}
                      disabled={!allowed}
                      onChange={() => patch({ failureStrategy: FailureStrategy.END })}
                    />
                    <span>结束</span>
                  </label>
                </div>
              </div>

              <div className="sm-modal__field">
                <label>通知策略</label>
                <select
                  className="sm-select"
                  data-testid="schedule-warning-type"
                  value={form.warningType}
                  disabled={!allowed}
                  onChange={e => patch({
                    warningType: e.target.value as WarningType,
                    warningGroupId: e.target.value === WarningType.NONE ? null : form.warningGroupId,
                  })}
                >
                  <option value={WarningType.NONE}>都不发</option>
                  <option value={WarningType.SUCCESS}>成功发</option>
                  <option value={WarningType.FAILURE}>失败发</option>
                  <option value={WarningType.ALL}>成功失败都发</option>
                </select>
              </div>

              {form.warningType !== WarningType.NONE && (
                <div className="sm-modal__field">
                  <label>告警组<span className="sm-required">*</span></label>
                  <select
                    className="sm-select"
                    data-testid="schedule-warning-group"
                    value={form.warningGroupId ?? ''}
                    disabled={!allowed}
                    onChange={e => patch({ warningGroupId: e.target.value ? Number(e.target.value) : null })}
                  >
                    <option value="">请选择告警组</option>
                    {(alertGroups ?? []).map(ag => (
                      <option key={ag.id} value={ag.id}>
                        {ag.groupName}{ag.description ? ` (${ag.description})` : ''}
                      </option>
                    ))}
                  </select>
                  {needAlertGroup && <div className="sm-field-error">已开启通知，请选择告警组</div>}
                </div>
              )}

              <div className="sm-modal__field">
                <label>工作流优先级</label>
                <select
                  className="sm-select"
                  value={form.workflowInstancePriority}
                  disabled={!allowed}
                  onChange={e => patch({ workflowInstancePriority: e.target.value as Priority })}
                >
                  {PRIORITY_ORDER.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>

              <div className="sm-modal__field">
                <label>Worker 分组</label>
                <select
                  className="sm-select"
                  value={form.workerGroup}
                  disabled={!allowed}
                  onChange={e => patch({ workerGroup: e.target.value })}
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
                <label>环境名称</label>
                <select
                  className="sm-select"
                  value={form.environmentCode ?? ''}
                  disabled={!allowed}
                  onChange={e => patch({ environmentCode: e.target.value ? Number(e.target.value) : null })}
                >
                  <option value="">默认环境</option>
                  {(environments ?? [])
                    .filter(env => !form.workerGroup || !env.workerGroups || env.workerGroups.length === 0 || env.workerGroups.includes(form.workerGroup))
                    .map(env => (
                      <option key={env.code} value={env.code}>{env.name}</option>
                    ))}
                </select>
              </div>

              <div className="sm-modal__field">
                <label>租户</label>
                <select
                  className="sm-select"
                  value={form.tenantCode ?? ''}
                  disabled={!allowed}
                  onChange={e => patch({ tenantCode: e.target.value || null })}
                >
                  <option value="">请选择租户</option>
                  {(tenants ?? []).map(t => (
                    <option key={t.tenantCode} value={t.tenantCode}>
                      {t.tenantCode}{t.description ? ` (${t.description})` : ''}
                    </option>
                  ))}
                </select>
              </div>

              {existing && !workflowOnline && (
                <div className="sm-schedule__notice">
                  <AlertTriangle size={14} />
                  <span>该工作流当前未上线，定时无法启用；请先上线工作流，再回来启用定时。</span>
                </div>
              )}
            </>
          )}
        </div>

        <div className="sm-modal__footer">
          {existing && allowed && (
            <>
              <button
                className={`sm-btn ${scheduleOnline ? 'sm-btn--warning' : 'sm-btn--success'}`}
                onClick={handleToggleOnline}
                disabled={loading}
              >
                {scheduleOnline ? <ArrowDownCircle size={12} /> : <ArrowUpCircle size={12} />}
                {scheduleOnline ? '停用定时' : '启用定时'}
              </button>
              <button className="sm-btn sm-btn--danger" onClick={handleDelete} disabled={loading}>
                <Trash2 size={12} /> 删除定时
              </button>
              <span className="sm-modal__footer-spacer" />
            </>
          )}
          <button className="sm-btn sm-btn--secondary" onClick={onClose}>关闭</button>
          <button
            className="sm-btn sm-btn--primary"
            onClick={handleSave}
            disabled={!allowed || saving || loading || !!blockingError}
            title={blockingError ?? undefined}
            data-testid="schedule-save"
          >
            <Save size={12} /> {saving ? '保存中...' : existing ? '保存定时' : '创建定时'}
          </button>
        </div>
      </div>

      {confirm && (
        <ConfirmModal
          message={confirm.message}
          onConfirm={confirm.onConfirm}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
};

export default ScheduleModal;
