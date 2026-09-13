// @vitest-environment jsdom
/**
 * ContextUsageBar.test.tsx — 上下文使用量进度条 + 明细提示
 *
 * 覆盖点：
 * 1. 无数据（input=0 且 contextLimit=0）时不渲染
 * 2. 进度条宽度/颜色随使用率变化
 * 3. **明细提示改为自定义 tooltip**：悬停立即出现（不再依赖原生 title 的
 *    0.5~1s 延迟），鼠标移出 / 窗口 resize 后消失
 * 4. 不再输出原生 title 属性（否则会与自定义 tooltip 双重提示）
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import ContextUsageBar from './ContextUsageBar';
import type { ContextUsage } from '../../hooks/opencode/useOpencodeEvents';

function makeUsage(over: Partial<ContextUsage> = {}): ContextUsage {
  return {
    input: 181_700,
    output: 0,
    reasoning: 0,
    cache: { read: 181_700, write: 0 },
    total: 7_310_000,
    contextLimit: 1_000_000,
    ratio: 0.1817,
    ...over,
  };
}

describe('ContextUsageBar', () => {
  it('无数据时不渲染', () => {
    const { container } = render(
      <ContextUsageBar usage={makeUsage({ input: 0, contextLimit: 0, ratio: 0 })} />
    );
    expect(container.querySelector('.ai-panel__context-bar')).toBeNull();
  });

  it('按使用率切换宽度与颜色', () => {
    const { container: ok } = render(<ContextUsageBar usage={makeUsage({ ratio: 0.2 })} />);
    expect(ok.querySelector('.ai-panel__context-bar--ok')).not.toBeNull();

    const { container: warn } = render(<ContextUsageBar usage={makeUsage({ ratio: 0.6 })} />);
    expect(warn.querySelector('.ai-panel__context-bar--warn')).not.toBeNull();

    const { container: danger } = render(<ContextUsageBar usage={makeUsage({ ratio: 1.42 })} />);
    expect(danger.querySelector('.ai-panel__context-bar--danger')).not.toBeNull();
    // 超过 100% 时宽度封顶，不溢出容器
    const fill = danger.querySelector('.ai-panel__context-bar-fill') as HTMLElement;
    expect(fill.style.width).toBe('100%');
  });

  it('默认不显示明细提示，也没有原生 title 属性', () => {
    const { container } = render(<ContextUsageBar usage={makeUsage()} />);
    const bar = container.querySelector('.ai-panel__context-bar') as HTMLElement;
    expect(screen.queryByRole('tooltip')).toBeNull();
    // 原生 title 会带来 0.5~1s 的悬停延迟，必须彻底移除
    expect(bar.getAttribute('title')).toBeNull();
    expect(container.querySelector('.ai-panel__context-tip')).toBeNull();
  });

  it('悬停立即弹出提示，并展示当前上下文 / 缓存 / 累计开销三行', () => {
    const { container } = render(<ContextUsageBar usage={makeUsage()} />);
    const bar = container.querySelector('.ai-panel__context-bar') as HTMLElement;

    fireEvent.mouseEnter(bar);

    const tip = container.querySelector('.ai-panel__context-tip') as HTMLElement;
    expect(tip).not.toBeNull();
    // fireEvent 同步派发 → 说明是「零延迟」的即时提示，不走原生 tooltip 的等待
    expect(tip.textContent).toContain('当前上下文: 181.7k / 1.00M（18.2%）');
    expect(tip.textContent).toContain('缓存命中: 181.7k 读 / 0 写');
    expect(tip.textContent).toContain('累计开销: 7.31M tokens');

    // 位置由内联 right/top 驱动（CSS 里是 position: fixed）
    const style = tip.getAttribute('style') || '';
    expect(style).toContain('right:');
    expect(style).toContain('top:');
    expect(tip.className).toContain('ai-panel__context-tip');
  });

  it('无缓存命中时不显示缓存行', () => {
    const { container } = render(
      <ContextUsageBar usage={makeUsage({ cache: { read: 0, write: 0 } })} />
    );
    fireEvent.mouseEnter(container.querySelector('.ai-panel__context-bar') as HTMLElement);
    const tip = container.querySelector('.ai-panel__context-tip') as HTMLElement;
    expect(tip.textContent).not.toContain('缓存命中');
    expect(tip.textContent).toContain('累计开销');
  });

  it('鼠标移出后提示消失', () => {
    const { container } = render(<ContextUsageBar usage={makeUsage()} />);
    const bar = container.querySelector('.ai-panel__context-bar') as HTMLElement;

    fireEvent.mouseEnter(bar);
    expect(container.querySelector('.ai-panel__context-tip')).not.toBeNull();

    fireEvent.mouseLeave(bar);
    expect(container.querySelector('.ai-panel__context-tip')).toBeNull();
  });

  it('提示可见时窗口 resize 会关闭提示（fixed 定位已失效）', () => {
    const { container } = render(<ContextUsageBar usage={makeUsage()} />);
    const bar = container.querySelector('.ai-panel__context-bar') as HTMLElement;

    fireEvent.mouseEnter(bar);
    expect(container.querySelector('.ai-panel__context-tip')).not.toBeNull();

    fireEvent(window, new Event('resize'));
    expect(container.querySelector('.ai-panel__context-tip')).toBeNull();
  });

  it('aria-label 携带与提示一致的明细（可访问性）', () => {
    const { container } = render(<ContextUsageBar usage={makeUsage()} />);
    const bar = container.querySelector('.ai-panel__context-bar') as HTMLElement;
    const label = bar.getAttribute('aria-label') || '';
    expect(label).toContain('当前上下文: 181.7k / 1.00M（18.2%）');
    expect(label).toContain('累计开销: 7.31M tokens');
  });
});
