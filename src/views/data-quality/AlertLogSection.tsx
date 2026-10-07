/**
 * 告警记录（数据质量 → 告警订阅 → 告警记录区）
 *
 * ── 为什么需要它 ────────────────────────────────────────────
 * 渠道编码里「站内记录」（INBOX）的语义就是"落库即送达"，也就是说 `dq_alert_log` 本身就是告警箱。
 * 但在补上这个区段之前，告警记录写进去却没有任何界面能看到 —— 订阅配了、告警登记了，
 * 用户却无从判断"到底发了没有、发失败是什么原因"。
 *
 * ── 两个状态别混 ────────────────────────────────────────────
 * - **投递状态**（service 侧 status）：SENT 已送达 / PENDING 待发 / FAILED 投递失败；
 * - **触发状态**（checkStatus）：WARN 橙色异常 / ERROR 红色异常 / FAILED 校验失败，
 *   即"这条规则因为什么触发告警"。服务端按 runId + ruleId 回校验结果表取出。
 *
 * ── 渠道现状 ────────────────────────────────────────────────
 * INBOX 落表即送达；WEBHOOK 由服务端按 alert.webhook.url 配置投递；EMAIL 需 SMTP 配置，
 * 平台尚未接入 —— 这类记录会明确停在 PENDING 并写明原因，页面照实展示，不美化。
 */

import { useCallback, useEffect, useState } from 'react';
import { CircleAlert, RefreshCw } from 'lucide-react';
import { qualityApi } from '../../api/quality';
import type { QualityAlertLogVO } from '../../types/quality';

const PAGE_SIZE = 20;

/** 投递状态文案（衡量"通知发出去了没有"） */
const DELIVERY_LABEL: Record<string, string> = {
  SENT: '已送达',
  PENDING: '待发',
  FAILED: '投递失败',
};

const DELIVERY_TAG: Record<string, string> = {
  SENT: 'dq-tag dq-tag--success',
  PENDING: 'dq-tag dq-tag--default',
  FAILED: 'dq-tag dq-tag--danger',
};

/** 触发状态文案（衡量"因为什么触发"，与校验结果状态同一套取值） */
const CHECK_STATUS_LABEL: Record<string, string> = {
  WARN: '橙色异常',
  ERROR: '红色异常',
  FAILED: '校验失败',
};

const CHECK_STATUS_TAG: Record<string, string> = {
  WARN: 'dq-tag dq-tag--warn',
  ERROR: 'dq-tag dq-tag--danger',
  FAILED: 'dq-tag dq-tag--danger',
};

const CHANNEL_LABEL: Record<string, string> = {
  INBOX: '站内记录',
  EMAIL: '邮件',
  WEBHOOK: 'Webhook',
};

const AlertLogSection: React.FC = () => {
  const [items, setItems] = useState<QualityAlertLogVO[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const res = await qualityApi.listAlertLogs({
        current: page,
        size: PAGE_SIZE,
        status: status || undefined,
      });
      setItems(res?.data?.records ?? []);
      setTotal(res?.data?.total ?? 0);
    } catch {
      setItems([]);
      setTotal(0);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [page, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <section className="dq-section">
      <div className="dq-toolbar">
        <div className="dq-toolbar__lead">
          <h4 className="dq-section__title">告警记录</h4>
          <p className="dq-muted">
            命中订阅条件时产生的通知。「站内记录」落库即送达；Webhook 的投递结果与失败原因也在这里，
            待发的记录说明对应渠道尚未配置。
          </p>
        </div>
        <div className="dq-search-bar dq-search-bar--tight">
          <select
            className="dq-select"
            aria-label="按投递状态筛选"
            value={status}
            onChange={e => {
              setPage(1);
              setStatus(e.target.value);
            }}
          >
            <option value="">全部状态</option>
            <option value="SENT">已送达</option>
            <option value="PENDING">待发</option>
            <option value="FAILED">投递失败</option>
          </select>
          <button className="dq-btn" onClick={() => void load()}>
            <RefreshCw size={13} /> 刷新
          </button>
        </div>
      </div>

      {failed ? (
        <div className="dq-placeholder">
          <div className="dq-placeholder__head">
            <CircleAlert size={16} />
            <span>告警记录接口不可用，暂时无法加载记录。</span>
          </div>
          <p className="dq-placeholder__lead">请确认服务端 /api/quality/alert/log 已部署后重试。</p>
        </div>
      ) : (
        <>
          <table className="dq-table">
            <thead>
              <tr>
                <th>任务</th>
                <th>规则</th>
                <th>触发状态</th>
                <th>渠道</th>
                <th>接收人</th>
                <th>投递状态</th>
                <th>送达时间</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={8} className="dq-table-empty">
                    加载中…
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={8} className="dq-table-empty">
                    暂无告警记录。校验命中订阅条件后会在此留痕。
                  </td>
                </tr>
              ) : (
                items.map(row => (
                  <tr key={row.id}>
                    <td className="dq-table__strong">{row.taskName || `任务 #${row.taskId}`}</td>
                    <td>
                      {row.ruleName || '-'}
                      {row.ruleId ? null : <span className="dq-table__sub">规则未登记</span>}
                    </td>
                    <td>
                      <span className={CHECK_STATUS_TAG[row.checkStatus] ?? 'dq-tag dq-tag--default'}>
                        {CHECK_STATUS_LABEL[row.checkStatus] ?? row.checkStatus ?? '-'}
                      </span>
                    </td>
                    <td>{CHANNEL_LABEL[row.channel] ?? row.channel}</td>
                    <td className="dq-td-ellipsis" title={row.receiver}>
                      {row.receiver || '-'}
                    </td>
                    <td>
                      <span className={DELIVERY_TAG[row.status] ?? 'dq-tag dq-tag--default'}>
                        {DELIVERY_LABEL[row.status] ?? row.status}
                      </span>
                    </td>
                    <td>{row.sendTime || '—'}</td>
                    <td className="dq-td-ellipsis" title={row.failReason}>
                      {row.failReason || '—'}
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
        </>
      )}
    </section>
  );
};

export default AlertLogSection;
