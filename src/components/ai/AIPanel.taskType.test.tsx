// @vitest-environment jsdom
/**
 * AIPanel.taskType.test.tsx — 任务类型切换与会话上下文保留
 *
 * 背景（2026-09-13）：任务类型的系统指令是「逐轮下发」的 —— useOpencodeChat 每次 sendMessage
 * 都重算 getDeveloperInstructions(roleType) 并作为 session.prompt 的 body.system 传入；服务端
 * 只取「最后一条用户消息」的 system 拼进系统提示（opencode session/llm/request.ts::prepare
 * → input.user.system），历史消息的 system 不参与回放。
 *
 * 因此开发助手切换任务类型**不需要**新建会话：只更新 taskType，新角色从下一轮生效，
 * 而历史对话与工具调用结果全部保留，智能体仍能看到「之前做了什么」。
 *
 * 覆盖点：
 * 1. 开发助手切换任务类型只更新 taskType，不调用 newSession（上下文不被清空）
 * 2. 切换后当前会话 ID 与消息历史保持不变
 * 3. 头部「新建会话」入口仍然可用（能力未被误删）
 * 4. 数据探索模块维持原行为：切换任务类型仍新建会话（该模块的提示词按模块短路、
 *    与 roleType 无关，且 newSession 承担「新建时间戳工作目录」的语义）
 * 5. 两个模块的任务类型下拉选项齐备
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

// AIPanel 依赖登录态：直接桩掉，避免 AuthProvider 触发真实鉴权请求
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: null }),
}));

// 自动补全依赖 DataSourceContext，与本用例无关
vi.mock('../../hooks/opencode/useAutoCompleteData', () => ({
  default: () => [],
}));

// 时间线：暴露 messages 长度，用于断言历史未被清空
vi.mock('./timeline/MessageTimeline', () => ({
  default: ({ messages }: any) => (
    <div data-testid="ai-panel-timeline" data-count={messages.length} />
  ),
}));

// 会话切换器：暴露 currentSessionId 与「新建会话」入口
vi.mock('./SessionSwitcher', () => ({
  default: ({ currentSessionId, onNewSession }: any) => (
    <div>
      <span data-testid="ss-current">{currentSessionId ?? 'none'}</span>
      <button data-testid="ss-new" onClick={() => onNewSession()}>新建会话</button>
    </div>
  ),
}));

import AIPanel from './AIPanel';

/** jsdom 环境未注入全局 localStorage，提供内存版实现 */
const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
    setItem: (k: string, v: string) => { storage.set(k, String(v)); },
    removeItem: (k: string) => { storage.delete(k); },
    clear: () => { storage.clear(); },
    key: (i: number) => Array.from(storage.keys())[i] ?? null,
    get length() { return storage.size; },
  },
  configurable: true,
  writable: true,
});

const setTaskTypeSpy = vi.fn();
const newSessionSpy = vi.fn();
const loadSessionSpy = vi.fn();

/** 构造最小可用的 chatBackend 桩：带 1 条历史消息与一个已建立的会话 */
function createBackend(overrides: Record<string, unknown> = {}) {
  return {
    messages: [
      { info: { id: 'u1', role: 'user' }, parts: [{ type: 'text', text: '之前的需求描述' }] },
    ],
    busy: false,
    retry: false,
    connected: true,
    error: null,
    modals: [],
    currentSessionId: 'sess-1',
    contextUsage: {
      input: 100, output: 0, reasoning: 0, contextLimit: 1000,
      ratio: 0.1, total: 100, cache: { read: 0, write: 0 },
    },
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
    newSession: newSessionSpy,
    loadSession: loadSessionSpy,
    deleteSession: vi.fn(),
    renameTask: vi.fn(),
    setActiveLLMModel: vi.fn(),
    taskType: 'DATA_ARCHITECT',
    setTaskType: setTaskTypeSpy,
    client: null,
    readPartText: vi.fn(),
    subscribePartText: vi.fn(),
    listSessions: vi.fn().mockResolvedValue([]),
    currentDirectory: undefined,
    dataExploreDirs: [],
    dataExploreTaskFiles: [],
    dataExploreToggleSession: vi.fn(),
    ...overrides,
  } as any;
}

/**
 * 有状态挂具：让 setTaskType 真正更新受控 select 的 value，
 * 从而能断言「切换后选中项变了」而不只是「回调被调用」。
 */
function Harness({ moduleId = 'dev-assistant', initialTaskType = 'DATA_ARCHITECT' }: {
  moduleId?: string;
  initialTaskType?: string;
}) {
  const [taskType, setLocal] = React.useState(initialTaskType);
  const backend = React.useMemo(
    () => createBackend({
      taskType,
      setTaskType: (t: string) => { setTaskTypeSpy(t); setLocal(t); },
    }),
    [taskType],
  );
  return <AIPanel chatBackend={backend} moduleId={moduleId} projectId="1" />;
}

const taskTypeSelect = () => screen.getByTitle('任务类型') as HTMLSelectElement;

describe('AIPanel 任务类型切换', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('开发助手：切换任务类型只更新 taskType，不新建会话', () => {
    render(<Harness />);

    fireEvent.change(taskTypeSelect(), { target: { value: 'DATA_DEV_ENGINEER' } });

    expect(setTaskTypeSpy).toHaveBeenCalledTimes(1);
    expect(setTaskTypeSpy).toHaveBeenCalledWith('DATA_DEV_ENGINEER');
    // 关键断言：不再清空会话，否则上下文会被整体丢弃
    expect(newSessionSpy).not.toHaveBeenCalled();
  });

  it('开发助手：切换后当前会话与消息历史保持不变', () => {
    render(<Harness />);
    expect(screen.getByTestId('ss-current').textContent).toBe('sess-1');
    expect(screen.getByTestId('ai-panel-timeline').getAttribute('data-count')).toBe('1');

    fireEvent.change(taskTypeSelect(), { target: { value: 'BUSINESS_REQUESTER' } });

    // 会话 ID 未被置空、历史消息仍在 ⇒ 智能体仍能看到「之前做了什么」
    expect(screen.getByTestId('ss-current').textContent).toBe('sess-1');
    expect(screen.getByTestId('ai-panel-timeline').getAttribute('data-count')).toBe('1');
    expect(newSessionSpy).not.toHaveBeenCalled();
    expect(loadSessionSpy).not.toHaveBeenCalled();
  });

  it('开发助手：头部「新建会话」入口仍会新建会话（能力未被误删）', () => {
    render(<Harness />);

    fireEvent.click(screen.getByTestId('ss-new'));

    expect(newSessionSpy).toHaveBeenCalledTimes(1);
  });

  it('数据探索：维持原行为，切换任务类型仍新建会话', () => {
    render(<Harness moduleId="data-explore" initialTaskType="DATA_ANALYST" />);

    fireEvent.change(taskTypeSelect(), { target: { value: 'SUPER_ADMIN' } });

    expect(setTaskTypeSpy).toHaveBeenCalledWith('SUPER_ADMIN');
    expect(newSessionSpy).toHaveBeenCalledTimes(1);
  });

  it('开发助手下拉提供三种角色', () => {
    render(<Harness />);

    const options = Array.from(taskTypeSelect().options);
    expect(options.map(o => o.value)).toEqual([
      'BUSINESS_REQUESTER', 'DATA_ARCHITECT', 'DATA_DEV_ENGINEER',
    ]);
    expect(options.map(o => o.textContent)).toEqual(['需求编写', '数仓设计', '数据开发']);
  });

  it('数据探索下拉提供数据分析与运维管理', () => {
    render(<Harness moduleId="data-explore" initialTaskType="DATA_ANALYST" />);

    const options = Array.from(taskTypeSelect().options);
    expect(options.map(o => o.value)).toEqual(['DATA_ANALYST', 'SUPER_ADMIN']);
    expect(options.map(o => o.textContent)).toEqual(['数据分析', '运维管理']);
  });
});
