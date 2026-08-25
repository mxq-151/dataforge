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
 */

import React from 'react';
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

const ContextUsageBar: React.FC<ContextUsageBarProps> = ({ usage }) => {
  // input 已含 cache.read + cache.write，代表"当前实际上下文大小"。
  // 压缩完成时服务端会发送 session.compacted 事件，把 input 重置为 0，
  // 待用户发送下一条消息、LLM 响应后才会更新为压缩后的真实大小。
  const { input, contextLimit, ratio, total, cache } = usage;

  // 没有数据时不显示
  if (input === 0 && contextLimit === 0) return null;

  // 计算百分比（用于宽度）
  const percent = Math.min(ratio * 100, 100);

  // 颜色根据使用率变化
  const colorClass =
    ratio < 0.5 ? 'ai-panel__context-bar--ok' :
    ratio < 0.8 ? 'ai-panel__context-bar--warn' :
    'ai-panel__context-bar--danger';

  // title 展示明细：当前上下文（含缓存命中）+ 缓存明细 + 累计开销
  const cacheRead = cache?.read || 0;
  const cacheWrite = cache?.write || 0;
  const cacheLine = (cacheRead > 0 || cacheWrite > 0)
    ? `\n缓存命中: ${formatTokens(cacheRead)} 读 / ${formatTokens(cacheWrite)} 写`
    : '';

  return (
    <div
      className={`ai-panel__context-bar ${colorClass}`}
      title={`当前上下文: ${formatTokens(input)} / ${formatTokens(contextLimit)}（${(ratio * 100).toFixed(1)}%）${cacheLine}\n累计开销: ${formatTokens(total)} tokens`}
    >
      <Zap size={11} className="ai-panel__context-bar-icon" />
      <div className="ai-panel__context-bar-track">
        <div
          className="ai-panel__context-bar-fill"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
};

export default React.memo(ContextUsageBar);
