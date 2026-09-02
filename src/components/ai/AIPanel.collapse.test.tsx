// @vitest-environment jsdom
/**
 * AIPanel.collapse.test.tsx — 面板「向左缩进」折叠按钮
 *
 * 覆盖点：
 * 1. 面板右上角渲染折叠按钮，独立定位、不挤进头部 inline 流
 * 2. 点击后容器加 ai-panel-wrapper--collapsed 类，按钮切换为「展开面板」
 * 3. 折叠后不再使用拖拽百分比宽度（inline width 清空）、拖拽手柄移除
 * 4. 折叠状态按 moduleId 隔离持久化到 localStorage，刷新后恢复
 * 5. 再次点击可展开还原
 *
 * 说明：折叠后隐藏其余头部元素/内容区由 CSS 类（AIPanel.css）控制，
 * jsdom 不加载样式文件，因此这里只断言类名与 DOM 结构，不做可见性断言。
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

// AIPanel 依赖登录态：直接桩掉，避免 AuthProvider 触发真实鉴权请求
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: null }),
}));

// 时间线与输入区与本用例无关，桩掉以隔离折叠逻辑
vi.mock('./timeline/MessageTimeline', () => ({
  default: () => <div data-testid="ai-panel-timeline" />,
}));
vi.mock('./ChatInput', () => ({
  default: () => <div data-testid="ai-panel-chat-input" />,
}));

import AIPanel from './AIPanel';

/** 构造最小可用的 chatBackend 桩 */
function createBackend() {
  return {
    messages: [],
    busy: false,
    retry: false,
    connected: true,
    error: null,
    modals: [],
    currentSessionId: null,
    contextUsage: { input: 100, contextLimit: 1000, ratio: 0.1, total: 100, cache: { read: 0, write: 0 } },
    tasks: [],
    todos: [],
    fileChanges: [],
    sendMessage: vi.fn(),
    sendInterrupt: vi.fn(),
    sendRollback: vi.fn(),
    sendPermissionResponse: vi.fn(),
    sendQuestionReply: vi.fn(),
    sendQuestionReject: vi.fn(),
    compressSession: vi.fn(),
    compressing: false,
    approveFileChange: vi.fn(),
    rejectFileChange: vi.fn(),
    approveAllFileChanges: vi.fn(),
    newSession: vi.fn(),
    loadSession: vi.fn(),
    deleteSession: vi.fn(),
    renameTask: vi.fn(),
    setActiveLLMModel: vi.fn(),
    taskType: 'default',
    setTaskType: vi.fn(),
    client: null,
    readPartText: vi.fn(),
    listSessions: vi.fn().mockResolvedValue([]),
    currentDirectory: undefined,
  } as any;
}

function renderPanel(moduleId = 'dev-assistant') {
  const utils = render(<AIPanel chatBackend={createBackend()} moduleId={moduleId} projectId="1" />);
  const wrapper = utils.container.firstElementChild as HTMLElement;
  return { ...utils, wrapper };
}

describe('AIPanel 向左缩进按钮', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('面板渲染「向左缩进」按钮', () => {
    renderPanel();
    const btn = screen.getByTitle('向左缩进');
    expect(btn).toBeTruthy();
    expect(btn.classList.contains('ai-panel__collapse-btn')).toBe(true);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
  });

  it('按钮独立定位到面板右上角，不在头部 inline 流内', () => {
    const { container } = renderPanel();
    const btn = screen.getByTitle('向左缩进');
    const header = container.querySelector('.ai-panel__header');
    const contextBar = container.querySelector('.ai-panel__context-bar');
    const innerPanel = container.querySelector('.ai-panel');

    expect(header).toBeTruthy();
    expect(contextBar).toBeTruthy();
    expect(innerPanel).toBeTruthy();

    // 按钮不能塞进头部 inline 流，避免窄面板下挤压会话切换器
    expect(header!.contains(btn)).toBe(false);
    // 按钮挂在 .ai-panel（内层面板）里，由其作为绝对定位容器
    expect(innerPanel!.contains(btn)).toBe(true);
    // 同 panel 内，按钮在上下文使用量之后
    expect(contextBar!.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('点击后容器进入折叠态，按钮切换为「展开面板」', () => {
    const { wrapper } = renderPanel();
    expect(wrapper.classList.contains('ai-panel-wrapper--collapsed')).toBe(false);

    fireEvent.click(screen.getByTitle('向左缩进'));

    expect(wrapper.classList.contains('ai-panel-wrapper--collapsed')).toBe(true);
    expect(screen.getByTitle('展开面板')).toBeTruthy();
    expect(screen.queryByTitle('向左缩进')).toBeNull();
  });

  it('折叠后清空 inline 宽度并移除拖拽手柄', () => {
    const { container, wrapper } = renderPanel();
    expect(wrapper.style.width).toBeTruthy();
    expect(container.querySelector('.ai-panel__resize-handle')).toBeTruthy();

    fireEvent.click(screen.getByTitle('向左缩进'));

    expect(wrapper.style.width).toBe('');
    expect(container.querySelector('.ai-panel__resize-handle')).toBeNull();
  });

  it('折叠状态按 moduleId 持久化，且不同模块互不影响', () => {
    const first = renderPanel('dev-assistant');
    fireEvent.click(screen.getByTitle('向左缩进'));
    expect(localStorage.getItem('ai-panel-collapsed:dev-assistant')).toBe('true');
    expect(localStorage.getItem('ai-panel-collapsed:data-explore')).toBeNull();
    cleanup();

    // 重新挂载同一模块：恢复为折叠态
    const second = renderPanel('dev-assistant');
    expect(second.wrapper.classList.contains('ai-panel-wrapper--collapsed')).toBe(true);
    cleanup();

    // 另一模块不受影响：默认展开
    const third = renderPanel('data-explore');
    expect(third.wrapper.classList.contains('ai-panel-wrapper--collapsed')).toBe(false);
    expect(first.wrapper).toBeTruthy();
  });

  it('再次点击可展开还原', () => {
    const { container, wrapper } = renderPanel();
    fireEvent.click(screen.getByTitle('向左缩进'));
    fireEvent.click(screen.getByTitle('展开面板'));

    expect(wrapper.classList.contains('ai-panel-wrapper--collapsed')).toBe(false);
    expect(wrapper.style.width).toBeTruthy();
    expect(container.querySelector('.ai-panel__resize-handle')).toBeTruthy();
    expect(localStorage.getItem('ai-panel-collapsed:dev-assistant')).toBe('false');
  });
});
