/**
 * ContextUsageBar — 上下文使用量进度条
 *
 * 显示当前会话的实际上下文大小（即下次 LLM 调用会送入的 token 数）：
 * - input: 当前实际上下文大小 = 原始 input + cache.read + cache.write
 *   （启用 prompt caching 后，cache.read 是从缓存读取的输入 token，
 *    仍是 prompt 的一部分，占用 context 窗口）
 * - contextLimit: 模型 context 窗口
 * - ratio: 使用率（0-1）= input / contextLimit
 *
 * 注意：这里**不**使用 contextUsage.total（那是所有 step 累计的开销，反映的是
 * 整个会话累计消耗，不是当前上下文大小）。如果用 total，压缩后进度条反而会
 * 继续上涨（因为压缩步骤的 token 也会累加进去），体验很差。
 *
 * 颜色根据使用率自动变化：
 * - < 50%  → 绿色（健康）
 * - 50-80% → 黄色（注意）
 * - > 80%  → 红色（警告，可能需要压缩/新建会话）
 *
 * 明细提示用自定义 tooltip 而非原生 `title`：
 * 原生 tooltip 由浏览器/系统控制，悬停后要等 0.5~1s 才弹出，且样式不可控；
 * 这里改成 hover 立即显示（0 延迟），并用 position:fixed 定位，避免被
 * `.ai-panel { overflow: hidden }` 裁掉。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Zap } from 'lucide-react';
import type { ContextUsage } from '../../hooks/opencode/useOpencodeEvents';

interface ContextUsageBarProps {
  usage: ContextUsage;
}

/** 格式化 token 数为可读字符串（12345 → "12.3k"） */
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** tooltip 估算高度，用于贴底时上翻（3 行文案 + padding） */
const TIP_HEIGHT = 62;

/** 计算 tooltip 的 fixed 定位：右对齐进度条，默认落在其下方 */
function computeTipPosition(el: HTMLElement | null): { right: number; top: number } {
  const rect = el?.getBoundingClientRect?.();
  // jsdom / 节点已卸载时 rect 全为 0，退化为贴面板右上的固定位置
  if (!rect || rect.width === 0) return { right: 12, top: 34 };
  const viewportH = typeof window !== 'undefined' ? window.innerHeight : 800;
  const viewportW = typeof window !== 'undefined' ? window.innerWidth : 1200;
  return {
    right: Math.max(8, viewportW - rect.right),
    top: rect.bottom + TIP_HEIGHT + 8 > viewportH
      ? Math.max(8, rect.top - TIP_HEIGHT - 6)
      : rect.bottom + 6,
  };
}

const ContextUsageBar: React.FC<ContextUsageBarProps> = ({ usage }) => {
  // input 已含 cache.read + cache.write，代表"当前实际上下文大小"。
  // 压缩完成时服务端会发送 session.compacted 事件，把 input 重置为 0，
  // 待用户发送下一条消息、LLM 响应后才会更新为压缩后的真实大小。
  const { input, contextLimit, ratio, total, cache } = usage;

  const barRef = useRef<HTMLDivElement>(null);
  const [tipPos, setTipPos] = useState<{ right: number; top: number } | null>(null);

  // hover / 键盘聚焦都立即弹出；延迟为 0，不做节流（进度条是很小的目标，
  // 只有精准悬停才会进入）
  const showTip = useCallback(() => {
    setTipPos(computeTipPosition(barRef.current));
  }, []);
  const hideTip = useCallback(() => setTipPos(null), []);

  // 提示可见期间：窗口尺寸/滚动变化会让 fixed 定位失效，直接隐藏重算
  useEffect(() => {
    if (!tipPos) return;
    const onDismiss = () => setTipPos(null);
    window.addEventListener('resize', onDismiss);
    window.addEventListener('scroll', onDismiss, true);
    return () => {
      window.removeEventListener('resize', onDismiss);
      window.removeEventListener('scroll', onDismiss, true);
    };
  }, [tipPos]);

  // 没有数据时不显示
  if (input === 0 && contextLimit === 0) return null;

  // 计算百分比（用于宽度）
  const percent = Math.min(ratio * 100, 100);

  // 颜色根据使用率变化
  const colorClass =
    ratio < 0.5 ? 'ai-panel__context-bar--ok' :
    ratio < 0.8 ? 'ai-panel__context-bar--warn' :
    'ai-panel__context-bar--danger';

  // 明细：当前上下文（含缓存命中）+ 缓存明细 + 累计开销
  const cacheRead = cache?.read || 0;
  const cacheWrite = cache?.write || 0;
  const hasCache = cacheRead > 0 || cacheWrite > 0;

  const summary =
    `当前上下文: ${formatTokens(input)} / ${formatTokens(contextLimit)}（${(ratio * 100).toFixed(1)}%）`
    + (hasCache ? `\n缓存命中: ${formatTokens(cacheRead)} 读 / ${formatTokens(cacheWrite)} 写` : '')
    + `\n累计开销: ${formatTokens(total)} tokens`;

  return (
    <div
      ref={barRef}
      className={`ai-panel__context-bar ${colorClass}`}
      aria-label={summary}
      onMouseEnter={showTip}
      onMouseLeave={hideTip}
    >
      <Zap size={11} className="ai-panel__context-bar-icon" />
      <div className="ai-panel__context-bar-track">
        <div
          className="ai-panel__context-bar-fill"
          style={{ width: `${percent}%` }}
        />
      </div>

      {tipPos && (
        <div
          className="ai-panel__context-tip"
          role="tooltip"
          style={{ right: tipPos.right, top: tipPos.top }}
        >
          <span className="ai-panel__context-tip-line">
            当前上下文: {formatTokens(input)} / {formatTokens(contextLimit)}（{(ratio * 100).toFixed(1)}%）
          </span>
          {hasCache && (
            <span className="ai-panel__context-tip-line ai-panel__context-tip-line--dim">
              缓存命中: {formatTokens(cacheRead)} 读 / {formatTokens(cacheWrite)} 写
            </span>
          )}
          <span className="ai-panel__context-tip-line ai-panel__context-tip-line--dim">
            累计开销: {formatTokens(total)} tokens
          </span>
        </div>
      )}
    </div>
  );
};

export default React.memo(ContextUsageBar);
