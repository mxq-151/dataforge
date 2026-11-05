/**
 * BasicTool — 通用工具卡片骨架
 *
 * 对齐 opencode 桌面版 BasicTool 组件（session-ui/src/components/basic-tool.tsx）。
 *
 * 功能：
 * - CollapsibleHeader 作为折叠头部（div role=button，避免 button 嵌套）
 * - TextShimmer 用于 pending/running 状态的标题扫光
 * - hideDetails 模式：仅显示 trigger，不渲染展开内容（webfetch/task/skill）
 * - locked 模式：禁止关闭
 * - forceOpen：强制展开
 * - 简单 CSS 高度过渡（替代桌面版 motion 库的 spring 动画）
 *
 * 简化项（相对桌面版）：
 * - deferred mount 用 React hooks 适配（scheduleDeferredMount + scheduleFrameMount）
 * - 无 motion 库 spring 动画（用 CSS max-height 过渡替代）
 * - 无 Kobalte Collapsible（用 CollapsibleHeader + 条件渲染替代）
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import CollapsibleHeader from './CollapsibleHeader';
import TextShimmer from './TextShimmer';
import { scheduleDeferredMount, scheduleFrameMount } from '../utils/deferredMount';

// ── TriggerTitle：结构化触发器标题 ─────────────────────────────

export interface TriggerTitle {
  /** 主标题 */
  title: string;
  /** 主标题额外 className */
  titleClass?: string;
  /** 副标题（如文件路径、命令等） */
  subtitle?: string;
  /** 副标题额外 className */
  subtitleClass?: string;
  /** 参数列表（如 offset=0, limit=100） */
  args?: string[];
  /** 参数额外 className */
  argsClass?: string;
  /** 右侧操作区（如复制按钮） */
  action?: React.ReactNode;
}

/** 判断值是否为 TriggerTitle 结构 */
function isTriggerTitle(val: unknown): val is TriggerTitle {
  return (
    typeof val === 'object' &&
    val !== null &&
    'title' in val &&
    typeof (val as TriggerTitle).title === 'string'
  );
}

// ── BasicToolProps ─────────────────────────────────────────────

export interface BasicToolProps {
  /** 触发器内容：结构化对象 / ReactNode / 函数 */
  trigger: TriggerTitle | React.ReactNode | ((open: boolean) => React.ReactNode);
  /** 展开内容 */
  children?: React.ReactNode;
  /** 工具状态：pending / running / completed / error */
  status?: string;
  /** 是否隐藏详情（仅显示 trigger，不渲染展开内容） */
  hideDetails?: boolean;
  /** 默认是否展开 */
  defaultOpen?: boolean;
  /** 受控展开状态 */
  open?: boolean;
  /** 展开状态变化回调 */
  onOpenChange?: (open: boolean) => void;
  /** 强制展开 */
  forceOpen?: boolean;
  /** 锁定（禁止关闭） */
  locked?: boolean;
  /** 延迟挂载（edit/write/apply_patch 等重 DOM 工具首屏按帧挂载，避免长会话首屏卡顿） */
  defer?: boolean;
  /** 副标题点击回调 */
  onSubtitleClick?: () => void;
  /** 触发器点击回调（携带 MouseEvent，用于修饰键判断 SPA 跳转 vs 新窗口） */
  onTriggerClick?: (e: React.MouseEvent<HTMLElement>) => void;
  /** 触发器链接地址（存在时 trigger 渲染为 <a href>，支持中键/Cmd 新窗口） */
  triggerHref?: string;
  /** 是否可点击（影响 cursor 样式） */
  clickable?: boolean;
  /** 额外 className */
  className?: string;
}

// ── BasicTool 组件 ─────────────────────────────────────────────

const BasicTool: React.FC<BasicToolProps> = ({
  trigger,
  children,
  status,
  hideDetails = false,
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
  forceOpen = false,
  locked = false,
  defer = false,
  onSubtitleClick,
  onTriggerClick,
  triggerHref,
  clickable = false,
  className = '',
}) => {
  // 内部展开状态（非受控模式）
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const open = controlledOpen ?? internalOpen;

  // pending/running 状态
  const pending = status === 'pending' || status === 'running';
  // 是否有子内容
  const hasChildren = React.Children.count(children) > 0;

  const setOpen = useCallback(
    (value: boolean) => {
      if (controlledOpen === undefined) setInternalOpen(value);
      onOpenChange?.(value);
    },
    [controlledOpen, onOpenChange],
  );

  // forceOpen 效果
  useEffect(() => {
    if (forceOpen && !open) {
      setOpen(true);
    }
  }, [forceOpen, open, setOpen]);

  const handleToggle = useCallback(() => {
    // pending/running 时禁止操作
    if (pending) return;
    // locked 时禁止关闭
    if (locked && open) return;
    setOpen(!open);
  }, [pending, locked, open, setOpen]);

  // 渲染触发器内容
  const triggerContent = useMemo(() => {
    // 函数形式：(open) => ReactNode
    if (typeof trigger === 'function') {
      return trigger(open);
    }

    // 结构化 TriggerTitle
    if (isTriggerTitle(trigger)) {
      return (
        <div className="ai-panel__basic-tool-info">
          <div className="ai-panel__basic-tool-info-main">
            <span className="ai-panel__type-badge ai-panel__type-badge--tool">工具</span>
            <span className={`ai-panel__basic-tool-title ${trigger.titleClass ?? ''}`.trim()}>
              <TextShimmer text={trigger.title} active={pending} />
            </span>
            {/* pending 时不显示 subtitle/args/action */}
            {!pending && (
              <>
                {trigger.subtitle && (
                  <span
                    className={`ai-panel__basic-tool-subtitle ${trigger.subtitleClass ?? ''} ${onSubtitleClick ? 'ai-panel__basic-tool-subtitle--clickable' : ''}`.trim()}
                    onClick={(e) => {
                      if (onSubtitleClick) {
                        e.stopPropagation();
                        onSubtitleClick();
                      }
                    }}
                  >
                    {trigger.subtitle}
                  </span>
                )}
                {trigger.args?.length ? (
                  <span className={`ai-panel__basic-tool-args ${trigger.argsClass ?? ''}`.trim()}>
                    {trigger.args.map((arg, i) => (
                      <span key={i} className="ai-panel__basic-tool-arg">{arg}</span>
                    ))}
                  </span>
                ) : null}
              </>
            )}
          </div>
          {!pending && trigger.action && (
            <span className="ai-panel__basic-tool-action">{trigger.action}</span>
          )}
        </div>
      );
    }

    // 纯 ReactNode
    return trigger;
  }, [trigger, open, pending, onSubtitleClick]);

  const showContent = hasChildren && !hideDetails;
  const showArrow = showContent && !pending;

  // ── deferred mount：重 DOM 工具首屏按帧分批挂载 ──────────────
  // 对齐桌面版 basic-tool.tsx 的 defer 机制，适配 React hooks。
  // - ready：children 是否已挂载（false 时渲染门控跳过 children）
  // - everReadyRef：是否曾经 ready（区分首次用 scheduleDeferredMount vs 后续用 scheduleFrameMount）
  // - 首次默认展开：进全局 LIFO 队列 + 双层 rAF，每帧 1 个，防首屏 jank
  // - 后续用户主动展开：单层 rAF，不排队，即时响应
  // - 关闭时重置 ready，下次展开重新调度
  // StrictMode 安全：cleanup 取消调度后，第二次挂载 effect 因 ready 仍为 false 重新调度
  const [ready, setReady] = useState(!defer && defaultOpen);
  const everReadyRef = useRef(ready);
  const cancelRef = useRef<(() => void) | undefined>(undefined);

  useEffect(() => {
    if (!defer) return;
    if (!open || !showContent) return;
    if (ready) return;
    const schedule = everReadyRef.current ? scheduleFrameMount : scheduleDeferredMount;
    cancelRef.current?.();
    cancelRef.current = schedule(() => {
      cancelRef.current = undefined;
      everReadyRef.current = true;
      setReady(true);
    });
    return () => {
      cancelRef.current?.();
      cancelRef.current = undefined;
    };
  }, [defer, open, showContent, ready]);

  // 关闭时重置 ready（下次展开重新调度）
  useEffect(() => {
    if (defer && !open && ready) {
      setReady(false);
    }
  }, [defer, open, ready]);

  return (
    <div
      className={`ai-panel__basic-tool ${pending ? 'ai-panel__basic-tool--pending' : ''} ${status ? `ai-panel__basic-tool--${status}` : ''} ${className}`.trim()}
      data-hide-details={hideDetails ? 'true' : undefined}
      data-clickable={clickable ? 'true' : undefined}
    >
      <CollapsibleHeader
        open={open}
        onToggle={(e) => {
          onTriggerClick?.(e);
          handleToggle();
        }}
        disabled={pending}
        showArrow={showArrow}
        href={triggerHref}
        className="ai-panel__basic-tool-trigger"
      >
        {triggerContent}
      </CollapsibleHeader>
      {showContent && open && (!defer || ready) && (
        <div className="ai-panel__basic-tool-content">
          {children}
        </div>
      )}
    </div>
  );
};

// ── GenericTool：通用兜底工具 ──────────────────────────────────

/** 从 input 中提取标签（按优先级键） */
function label(input: Record<string, unknown> | undefined): string | undefined {
  const keys = ['description', 'query', 'url', 'filePath', 'path', 'pattern', 'name'];
  for (const key of keys) {
    const value = input?.[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/** 从 input 中提取参数（排除 label 键，最多 3 个） */
function extractArgs(input: Record<string, unknown> | undefined): string[] {
  if (!input) return [];
  const skip = new Set(['description', 'query', 'url', 'filePath', 'path', 'pattern', 'name']);
  return Object.entries(input)
    .filter(([key]) => !skip.has(key))
    .flatMap(([key, value]) => {
      if (typeof value === 'string') return [`${key}=${value}`];
      if (typeof value === 'number') return [`${key}=${value}`];
      if (typeof value === 'boolean') return [`${key}=${value}`];
      return [];
    })
    .slice(0, 3);
}

/** 将任意值格式化为可展示字符串 */
function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** 提取全部输入参数键值对（含复杂类型），用于展开后完整展示 */
function extractAllArgs(input: Record<string, unknown> | undefined): Array<{ key: string; value: string }> {
  if (!input) return [];
  return Object.entries(input).map(([key, value]) => ({ key, value: formatValue(value) }));
}

export interface GenericToolProps {
  /** 工具名称 */
  tool: string;
  /** 工具状态 */
  status?: string;
  /** 是否隐藏详情 */
  hideDetails?: boolean;
  /** 工具输入参数 */
  input?: Record<string, unknown>;
  /** 工具执行结果 */
  output?: string;
  /** 默认展开 */
  defaultOpen?: boolean;
}

/** GenericTool — 未注册专用渲染器时的兜底 */
export const GenericTool: React.FC<GenericToolProps> = ({ tool, status, hideDetails, input, output, defaultOpen }) => {
  const subtitle = label(input);
  const args = extractArgs(input);
  const allArgs = extractAllArgs(input);
  const hasOutput = typeof output === 'string' && output.length > 0;

  return (
    <BasicTool
      status={status}
      hideDetails={hideDetails}
      defaultOpen={defaultOpen}
      trigger={{
        title: `Called ${tool}`,
        subtitle,
        args,
      }}
    >
      {allArgs.length > 0 && (
        <div className="ai-panel__tool-card-section">
          <div className="ai-panel__basic-tool-content-label">执行参数</div>
          <pre className="ai-panel__tool-card-output">
            <code>{allArgs.map((a) => `${a.key}=${a.value}`).join('\n')}</code>
          </pre>
        </div>
      )}
      {hasOutput && (
        <div className="ai-panel__tool-card-section">
          <div className="ai-panel__basic-tool-content-label">执行结果</div>
          <pre className="ai-panel__tool-card-output">
            <code>{output}</code>
          </pre>
        </div>
      )}
    </BasicTool>
  );
};

export default React.memo(BasicTool);
