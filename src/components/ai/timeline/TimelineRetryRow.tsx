/**
 * TimelineRetryRow — retry 状态行（倒计时 + 错误信息）
 *
 * 对齐 opencode 桌面版 session-retry.tsx 的 SessionRetry 组件，
 * 适配 React 的 useState + useEffect 模式（替代 SolidJS createSignal + createEffect）。
 *
 * 功能：
 * - 显示重试次数（第 N 次）
 * - 显示错误消息（超 80 字符截断）
 * - 倒计时（基于 retry.next 时间戳，每 200ms 更新）
 * - 可选的 action 操作卡片（如切换 provider / 查看日志链接）
 */

import React, { useState, useEffect, useMemo } from 'react';
import type { RetryState } from '../../../types/opencode-backend';

/** 计算剩余秒数（基于 retry.next 时间戳） */
function computeRemaining(retry: RetryState): number {
  return Math.max(0, Math.ceil((retry.next - Date.now()) / 1000));
}

/** 裁剪错误消息（超 80 字符截断，对齐桌面版） */
function truncateMessage(message: string, max = 80): string {
  if (message.length <= max) return message;
  return message.slice(0, max) + '…';
}

export interface TimelineRetryRowProps {
  retry: RetryState | null;
}

const TimelineRetryRow: React.FC<TimelineRetryRowProps> = ({ retry }) => {
  const [remaining, setRemaining] = useState<number>(() => (retry ? computeRemaining(retry) : 0));

  useEffect(() => {
    if (!retry) {
      setRemaining(0);
      return;
    }
    setRemaining(computeRemaining(retry));
    const id = setInterval(() => {
      const r = computeRemaining(retry);
      setRemaining(r);
      if (r <= 0) clearInterval(id);
    }, 200);
    return () => clearInterval(id);
  }, [retry]);

  const info = useMemo(() => {
    if (!retry) return '';
    // 倒计时归零后只显示 "重试中 · 第 N 次"
    if (remaining <= 0) return `重试中 · 第 ${retry.attempt} 次`;
    return `重试中 · ${remaining}s 后重试 · 第 ${retry.attempt} 次`;
  }, [retry, remaining]);

  if (!retry) return null;

  const truncatedMessage = truncateMessage(retry.message);

  return (
    <div className="ai-panel__timeline-retry" data-timeline-row="Retry">
      <div className="ai-panel__timeline-retry-icon">
        {/* 旋转 spinner */}
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="ai-panel__timeline-retry-spinner">
          <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.4" strokeOpacity="0.25" />
          <path d="M12.5 7a5.5 5.5 0 0 0-5.5-5.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </div>
      <span className="ai-panel__timeline-error-badge">重试</span>
      <div className="ai-panel__timeline-retry-body">
        <div className="ai-panel__timeline-retry-message" title={retry.message}>
          {truncatedMessage}
        </div>
        <div className="ai-panel__timeline-retry-info">{info}</div>
      </div>
      {retry.action?.link && (
        <a
          className="ai-panel__timeline-retry-action"
          href={retry.action.link}
          target="_blank"
          rel="noreferrer"
          title={retry.action.title}
        >
          {retry.action.label}
        </a>
      )}
    </div>
  );
};

export default React.memo(TimelineRetryRow);
