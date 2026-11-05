/**
 * TextShimmer — 文字扫光效果
 *
 * 对齐 opencode 桌面版 TextShimmer 组件（@opencode-ai/ui/text-shimmer）。
 * 运行中的工具标题使用此组件呈现扫光动画，完成后延迟 220ms 停止（平滑过渡）。
 *
 * 桌面版采用双层文字叠加（base + shimmer），dataforge 简化为单元素 + background-clip 动画，
 * 视觉效果一致，DOM 结构更简单。
 */

import React, { useEffect, useRef, useState } from 'react';

export interface TextShimmerProps {
  /** 要显示的文本 */
  text: string;
  /** 是否激活跃光动画（pending/running 时为 true） */
  active?: boolean;
  /** 额外 className */
  className?: string;
}

/** 活跃→非活跃的延迟过渡时间（ms），与桌面版 swap=220 一致 */
const SWAP_MS = 220;

const TextShimmer: React.FC<TextShimmerProps> = ({ text, active = true, className = '' }) => {
  // run 比 active 延迟 220ms 变 false，让扫光淡出后再停动画
  const [run, setRun] = useState(active);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
    if (active) {
      setRun(true);
      return;
    }
    // active 变 false 后延迟 220ms 再停止动画
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined;
      setRun(false);
    }, SWAP_MS);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = undefined;
      }
    };
  }, [active]);

  return (
    <span
      data-component="text-shimmer"
      data-active={active ? 'true' : 'false'}
      data-run={run ? 'true' : 'false'}
      className={`ai-panel__text-shimmer ${run ? 'ai-panel__text-shimmer--active' : ''} ${className}`.trim()}
      aria-label={text}
    >
      {text}
    </span>
  );
};

export default React.memo(TextShimmer);
