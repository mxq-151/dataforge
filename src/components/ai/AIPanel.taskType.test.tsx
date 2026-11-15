// @vitest-environment jsdom
/**
 * AIPanel.taskType.test.tsx — 任务类型切换与会话隔离
 *
 * 任务类型已与用户角色解耦：开发助手的入口全部是 AgentKit 工作流，
 * 各自有独立的 command/agent 与产物目录，切换时新建会话，避免两套编排混在一条历史。
 * 数据探索的会话本身承载「新建时间戳工作目录」语义，切换任务类型同样新建会话。
 *
 * 覆盖点：
 * 1. 开发助手切换 kit 任务类型时新建会话，避免两套编排混在一条历史
 * 2. 数据探索模块切换任务类型仍新建会话（该模块会话=独立时间戳工作目录）
 * 3. 头部「新建会话」入口仍然可用（能力未被误删）
 * 4. 两个模块的任务类型下拉选项齐备
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
    taskType: 'AGENTKIT_DW_DEV',
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
function Harness({ moduleId = 'dev-assistant', initialTaskType = 'AGENTKIT_DW_DEV' }: {
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

  it('开发助手：切换任务类型时新建会话，避免两套 kit 编排混在同一条历史', () => {
    render(<Harness />);

    fireEvent.change(taskTypeSelect(), { target: { value: 'AGENTKIT_DIAG' } });

    expect(setTaskTypeSpy).toHaveBeenCalledTimes(1);
    expect(setTaskTypeSpy).toHaveBeenCalledWith('AGENTKIT_DIAG');
    expect(newSessionSpy).toHaveBeenCalledTimes(1);
  });

  it('开发助手：头部「新建会话」入口仍会新建会话（能力未被误删）', () => {
    render(<Harness />);

    fireEvent.click(screen.getByTestId('ss-new'));

    expect(newSessionSpy).toHaveBeenCalledTimes(1);
  });

  it('数据探索：维持原行为，切换任务类型仍新建会话', () => {
    render(<Harness moduleId="data-explore" initialTaskType="AGENTKIT_ANALYSIS" />);

    fireEvent.change(taskTypeSelect(), { target: { value: 'AGENTKIT_DIAG' } });

    expect(setTaskTypeSpy).toHaveBeenCalledWith('AGENTKIT_DIAG');
    expect(newSessionSpy).toHaveBeenCalledTimes(1);
  });

  it('开发助手下拉提供三种 kit 任务入口', () => {
    render(<Harness />);

    const options = Array.from(taskTypeSelect().options);
    expect(options.map(o => o.value)).toEqual([
      'AGENTKIT_REQ_DOC',
      'AGENTKIT_DW_DEV',
      'AGENTKIT_DIAG',
    ]);
    expect(options.map(o => o.textContent)).toEqual([
      '需求编写',
      '数仓开发',
      '任务智能诊断',
    ]);
  });

  it('数据探索下拉提供数据分析与运维管理', () => {
    render(<Harness moduleId="data-explore" initialTaskType="AGENTKIT_ANALYSIS" />);

    const options = Array.from(taskTypeSelect().options);
    expect(options.map(o => o.value)).toEqual(['AGENTKIT_ANALYSIS', 'AGENTKIT_DIAG']);
    expect(options.map(o => o.textContent)).toEqual(['数据分析', '运维管理']);
  });
});
