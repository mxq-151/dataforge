/**
 * CollapsibleHeader — 通用折叠头部
 *
 * 对齐 opencode 桌面版 Collapsible.Trigger 的功能，但使用 <div role="button"> 替代 <button>，
 * 避免 button 嵌套 button 导致的 hydration 错误（项目历史教训）。
 *
 * 使用方式：
 * <CollapsibleHeader open={open} onToggle={() => setOpen(!open)}>
 *   {headerContent}
 * </CollapsibleHeader>
 *
 * 支持键盘操作：Enter / Space 触发 toggle。
 */

import React, { useCallback } from 'react';

export interface CollapsibleHeaderProps {
  /** 是否展开 */
  open: boolean;
  /** 切换展开/折叠的回调（携带原始 MouseEvent，用于修饰键判断） */
  onToggle: (e: React.MouseEvent<HTMLElement>) => void;
  /** 头部内容 */
  children: React.ReactNode;
  /** 额外 className */
  className?: string;
  /** 是否禁用交互（running/pending 时禁止折叠） */
  disabled?: boolean;
  /** 是否显示展开箭头（默认 true） */
  showArrow?: boolean;
  /** aria-label 无障碍标签 */
  ariaLabel?: string;
  /** 链接地址（存在时渲染为 <a href>，支持中键/Cmd 新窗口打开） */
  href?: string;
}

const CollapsibleHeader: React.FC<CollapsibleHeaderProps> = ({
  open,
  onToggle,
  children,
  className = '',
  disabled = false,
  showArrow = true,
  ariaLabel,
  href,
}) => {
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      if (disabled) return;
      onToggle(e);
    },
    [disabled, onToggle],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      if (disabled) return;
      // Enter 或 Space 触发 toggle（对齐 <button> 的默认键盘行为）
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onToggle({ preventDefault: () => {}, stopPropagation: () => {} } as unknown as React.MouseEvent<HTMLElement>);
      }
    },
    [disabled, onToggle],
  );

  const commonProps = {
    role: 'button',
    tabIndex: disabled ? -1 : 0,
    'aria-expanded': open,
    'aria-disabled': disabled || undefined,
    'aria-label': ariaLabel,
    className: `ai-panel__collapsible-header ${disabled ? 'ai-panel__collapsible-header--disabled' : ''} ${className}`.trim(),
    onClick: handleClick,
    onKeyDown: handleKeyDown,
  };

  const inner = (
    <>
      <div className="ai-panel__collapsible-header-content">{children}</div>
      {showArrow && !disabled && (
        <span
          className={`ai-panel__collapsible-arrow ${open ? 'ai-panel__collapsible-arrow--open' : ''}`}
          aria-hidden="true"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path
              d="M3 4.5L6 7.5L9 4.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      )}
    </>
  );

  // href 存在时渲染为 <a>（支持中键/Cmd 点击新窗口打开），否则渲染 <div role="button">
  if (href) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" {...commonProps}>
        {inner}
      </a>
    );
  }
  return <div {...commonProps}>{inner}</div>;
};

export default React.memo(CollapsibleHeader);
