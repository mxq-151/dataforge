/**
 * 共享 Markdown 组件映射
 *
 * 用于 PacedMarkdown / TextPartDisplay / ReasoningPartDisplay，
 * 统一代码块、表格、链接等元素的渲染样式。
 */

import type { Components } from 'react-markdown';

/** 代码块语言标签图标 */
function CodeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}

/**
 * ReactMarkdown 自定义组件映射。
 *
 * - code: 区分行内代码与代码块，代码块添加语言标签头部
 * - table: 包装在可横向滚动的容器中，避免宽表格撑爆面板
 * - a: 外部链接在新标签页打开
 */
export const markdownComponents: Components = {
  code({ node, className, children, ...props }) {
    const match = /language-(\w+)/.exec(className || '');
    const text = String(children ?? '');
    // 行内代码：无 language class 且不含换行
    const isInline = !match && !className && !text.includes('\n');
    if (isInline) {
      return (
        <code className="ai-panel__md-inline-code" {...props}>
          {children}
        </code>
      );
    }
    return (
      <div className="ai-panel__code-block">
        <div className="ai-panel__code-block-header">
          <CodeIcon />
          <span>{match?.[1] || 'text'}</span>
        </div>
        <pre>
          <code className={className} {...props}>
            {text.replace(/\n$/, '')}
          </code>
        </pre>
      </div>
    );
  },
  table({ children }) {
    return (
      <div className="ai-panel__table-wrapper">
        <table>{children}</table>
      </div>
    );
  },
  a({ children, ...props }) {
    return (
      <a {...props} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
};
