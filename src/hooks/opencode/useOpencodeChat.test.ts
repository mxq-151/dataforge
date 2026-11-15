/**
 * useOpencodeChat.test.ts — 系统指令选择 + 会话复用
 *
 * 任务类型与用户角色已解耦，且不依赖 UI：
 * 1. AgentKit 任务改走 session.command，不注入旧 system
 * 2. 非 kit 任务只按任务类型/模块取指令：data-explore 用分析师提示词，其余模块不注入
 * 3. 传入 existingSessionId 时复用会话、不再 session.create ⇒ 历史得以保留
 * 4. 没有会话时才创建（首次对话）
 *
 * 服务端侧只取「最后一条用户消息」的 system 拼进系统提示
 * （opencode session/llm/request.ts::prepare → input.user.system），
 * 因此逐轮覆盖 system 不会污染历史轮次。
 */

import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useOpencodeChat } from './useOpencodeChat';

/** 构造只有 session.create / session.prompt / session.command 的最小 client 桩 */
function createClient() {
  const prompt = vi.fn().mockResolvedValue({ data: {} });
  const command = vi.fn().mockResolvedValue({ data: { info: {}, parts: [] } });
  const create = vi.fn().mockResolvedValue({ data: { id: 'sess-new' } });
  return { client: { session: { create, prompt, command } } as any, prompt, create, command };
}

/**
 * 构造带消息列表的回滚 client 桩。
 * messages: [{ info: { id, role }, parts: [] }]
 */
function createRollbackClient(messages: Array<{ id: string; role: string }>) {
  const revert = vi.fn().mockResolvedValue({ data: {} });
  const deleteMessage = vi.fn().mockResolvedValue({ data: true });
  const messagesApi = vi.fn().mockResolvedValue({
    data: messages.map(m => ({ info: { id: m.id, role: m.role }, parts: [] })),
    // 无 x-next-cursor：单页返回全部
    response: { headers: new Headers() },
  });
  const client = {
    session: {
      revert,
      deleteMessage,
      messages: messagesApi,
    },
  } as any;
  return { client, revert, deleteMessage, messagesApi };
}

describe('useOpencodeChat 回滚（revert + 边界消息删除）', () => {
  it('回滚成功后立即删除边界消息及其后的全部消息（服务端暂存式 revert 的补齐）', async () => {
    const { client, revert, deleteMessage, messagesApi } = createRollbackClient([
      { id: 'u1', role: 'user' },
      { id: 'a1', role: 'assistant' },
      { id: 'u2', role: 'user' },
      { id: 'a2', role: 'assistant' },
      { id: 'a3', role: 'assistant' },
    ]);
    const { result } = renderHook(() =>
      useOpencodeChat({
        moduleId: 'dev-assistant',
        currentSessionId: 'sess-1',
        setCurrentSessionId: vi.fn(),
      }),
    );

    // 回滚到 u2：删除 u2、a2、a3（与服务端 cleanup 的 msgs.slice(index) 同范围）
    let res: { success: boolean } | undefined;
    await act(async () => { res = await result.current.sendRollback(client, 'u2'); });

    expect(res?.success).toBe(true);
    expect(revert).toHaveBeenCalledWith({ sessionID: 'sess-1', messageID: 'u2' });
    expect(messagesApi).toHaveBeenCalled();
    const deletedIds = deleteMessage.mock.calls.map(c => c[0].messageID);
    expect(deletedIds).toEqual(['u2', 'a2', 'a3']);
  });

  it('回滚到首条消息时删除全部消息', async () => {
    const { client, deleteMessage } = createRollbackClient([
      { id: 'u1', role: 'user' },
      { id: 'a1', role: 'assistant' },
    ]);
    const { result } = renderHook(() =>
      useOpencodeChat({
        moduleId: 'dev-assistant',
        currentSessionId: 'sess-1',
        setCurrentSessionId: vi.fn(),
      }),
    );

    await act(async () => { await result.current.sendRollback(client, 'u1'); });

    expect(deleteMessage.mock.calls.map(c => c[0].messageID)).toEqual(['u1', 'a1']);
  });

  it('revert 返回 HTTP 错误（result.error）时不删除消息并报失败', async () => {
    const messages = [
      { id: 'u1', role: 'user' },
      { id: 'a1', role: 'assistant' },
    ];
    const revert = vi.fn().mockResolvedValue({ data: undefined, error: { status: 500, message: 'boom' } });
    const deleteMessage = vi.fn();
    const client = {
      session: {
        revert,
        deleteMessage,
        messages: vi.fn(),
      },
    } as any;
    const { result } = renderHook(() =>
      useOpencodeChat({
        moduleId: 'dev-assistant',
        currentSessionId: 'sess-1',
        setCurrentSessionId: vi.fn(),
      }),
    );

    let res: { success: boolean } | undefined;
    await act(async () => { res = await result.current.sendRollback(client, 'u1'); });

    expect(res?.success).toBe(false);
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it('边界消息不在服务端消息列表中时安全跳过（不报错）', async () => {
    const { client, deleteMessage } = createRollbackClient([
      { id: 'u1', role: 'user' },
      { id: 'a1', role: 'assistant' },
    ]);
    const { result } = renderHook(() =>
      useOpencodeChat({
        moduleId: 'dev-assistant',
        currentSessionId: 'sess-1',
        setCurrentSessionId: vi.fn(),
      }),
    );

    let res: { success: boolean } | undefined;
    await act(async () => { res = await result.current.sendRollback(client, 'nonexistent'); });

    expect(res?.success).toBe(true);
    expect(deleteMessage).not.toHaveBeenCalled();
  });
});

describe('useOpencodeChat 系统指令 — 非 kit 任务不注入', () => {
  it.each(['data-explore', 'dev-assistant'])('%s 的非 kit 任务走 session.prompt 且不带 system', async (moduleId) => {
    const { client, prompt } = createClient();
    const { result } = renderHook(() =>
      useOpencodeChat({
        moduleId,
        taskType: 'UNKNOWN_TASK',
        currentSessionId: 'sess-1',
        setCurrentSessionId: vi.fn(),
      }),
    );

    await act(async () => { await result.current.sendMessage(client, 'hi', 'sess-1'); });

    expect(prompt.mock.calls[0][0].system).toBeUndefined();
  });

  it('没有会话时才创建新会话', async () => {

    const { client, prompt, create } = createClient();
    const setCurrentSessionId = vi.fn();
    const { result } = renderHook(() =>
      useOpencodeChat({
        moduleId: 'dev-assistant',
        currentSessionId: null,
        setCurrentSessionId,
      }),
    );

    await act(async () => { await result.current.sendMessage(client, 'hi', null); });

    expect(create).toHaveBeenCalledTimes(1);
    expect(prompt.mock.calls[0][0].sessionID).toBe('sess-new');
    expect(setCurrentSessionId).toHaveBeenCalledWith('sess-new');
  });
});

describe('useOpencodeChat AgentKit 路由', () => {
  it.each([
    ['AGENTKIT_REQ_DOC', 'write-req', 'doc-orchestrator'],
    ['AGENTKIT_DW_DEV', 'dw-dev', 'dw-orchestrator'],
    ['AGENTKIT_ANALYSIS', 'ana-analyze', 'ana-orchestrator'],
  ])('%s 走 session.command，携带 command 与 agent，且不再下发旧 system', async (taskType, expectedCommand, expectedAgent) => {
    const { client, prompt, command } = createClient();
    const addLog = vi.fn();
    const { result } = renderHook(() =>
      useOpencodeChat({
        moduleId: 'dev-assistant',
        taskType,
        currentSessionId: 'sess-1',
        setCurrentSessionId: vi.fn(),
        addLog,
      }),
    );

    await act(async () => { await result.current.sendMessage(client, '订单域', 'sess-1'); });

    expect(prompt).not.toHaveBeenCalled();
    expect(command).toHaveBeenCalledTimes(1);
    const body = command.mock.calls[0][0];
    expect(body).toMatchObject({
      sessionID: 'sess-1',
      command: expectedCommand,
      agent: expectedAgent,
      arguments: '订单域',
    });
    expect(body.system).toBeUndefined();
    // UI 日志里能直接看到实际路由目标（现场排查证据）
    expect(addLog).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining(`command=${expectedCommand} agent=${expectedAgent}`),
    }));
  });

  it('AgentKit 工作流带模型参数时把 model 转成 providerID/modelID', async () => {
    const { client, command } = createClient();
    const { result } = renderHook(() =>
      useOpencodeChat({
        moduleId: 'dev-assistant',
        taskType: 'AGENTKIT_DW_DEV',
        currentSessionId: 'sess-1',
        setCurrentSessionId: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.sendMessage(client, '订单域', 'sess-1', { providerID: 'anthropic', modelID: 'claude-sonnet-4' });
    });

    expect(command.mock.calls[0][0].model).toBe('anthropic/claude-sonnet-4');
  });

  it('非 AgentKit 任务仍走 session.prompt，且不注入 system', async () => {
    const { client, prompt, command } = createClient();
    const { result } = renderHook(() =>
      useOpencodeChat({
        moduleId: 'data-explore',
        taskType: 'UNKNOWN_TASK',
        currentSessionId: 'sess-1',
        setCurrentSessionId: vi.fn(),
      }),
    );

    await act(async () => { await result.current.sendMessage(client, '写需求', 'sess-1'); });

    expect(command).not.toHaveBeenCalled();
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt.mock.calls[0][0].system).toBeUndefined();
  });
});
