/**
 * useOpencodeChat.test.ts — 角色指令逐轮下发 + 会话复用
 *
 * 这是「中途切换任务类型仍保留上下文」的机制基础，且不依赖 UI：
 * 1. 每次 sendMessage 都按**当前** roleType 重算 system ⇒ 新角色从下一轮生效
 * 2. 传入 existingSessionId 时复用会话、不再 session.create ⇒ 历史得以保留
 * 3. 没有会话时才创建（首次对话）
 *
 * 服务端侧只取「最后一条用户消息」的 system 拼进系统提示
 * （opencode session/llm/request.ts::prepare → input.user.system），
 * 因此逐轮覆盖 system 不会污染历史轮次。
 */

import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useOpencodeChat } from './useOpencodeChat';

/** 构造只有 session.create / session.prompt 的最小 client 桩 */
function createClient() {
  const prompt = vi.fn().mockResolvedValue({ data: {} });
  const create = vi.fn().mockResolvedValue({ data: { id: 'sess-new' } });
  return { client: { session: { create, prompt } } as any, prompt, create };
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
        username: 'u',
        moduleId: 'dev-assistant',
        roleType: 'DATA_ARCHITECT',
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
        username: 'u',
        moduleId: 'dev-assistant',
        roleType: 'DATA_ARCHITECT',
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
        username: 'u',
        moduleId: 'dev-assistant',
        roleType: 'DATA_ARCHITECT',
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
        username: 'u',
        moduleId: 'dev-assistant',
        roleType: 'DATA_ARCHITECT',
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

describe('useOpencodeChat 角色指令逐轮下发', () => {
  it('切换 roleType 后下一轮 prompt 带新角色的 system，且会话被复用', async () => {
    const { client, prompt, create } = createClient();
    const { result, rerender } = renderHook(
      ({ roleType }: { roleType: string }) =>
        useOpencodeChat({
          username: 'u',
          moduleId: 'dev-assistant',
          roleType,
          currentSessionId: 'sess-1',
          setCurrentSessionId: vi.fn(),
        }),
      { initialProps: { roleType: 'DATA_ARCHITECT' } },
    );

    await act(async () => { await result.current.sendMessage(client, '第一条', 'sess-1'); });
    const firstSystem = prompt.mock.calls[0][0].system as string;

    // 中途切换任务类型（等价于 AIPanel 只调用 setTaskType）
    rerender({ roleType: 'DATA_DEV_ENGINEER' });

    await act(async () => { await result.current.sendMessage(client, '第二条', 'sess-1'); });
    const secondSystem = prompt.mock.calls[1][0].system as string;

    expect(firstSystem).toBeTruthy();
    expect(secondSystem).toBeTruthy();
    // 新角色从下一轮生效
    expect(secondSystem).not.toBe(firstSystem);
    // 两次都落在同一个会话上 ⇒ 历史保留
    expect(prompt.mock.calls[0][0].sessionID).toBe('sess-1');
    expect(prompt.mock.calls[1][0].sessionID).toBe('sess-1');
    expect(create).not.toHaveBeenCalled();
  });

  it('三种开发角色的 system 互不相同', async () => {
    const systems: string[] = [];
    for (const roleType of ['BUSINESS_REQUESTER', 'DATA_ARCHITECT', 'DATA_DEV_ENGINEER']) {
      const { client, prompt } = createClient();
      const { result } = renderHook(() =>
        useOpencodeChat({
          username: 'u',
          moduleId: 'dev-assistant',
          roleType,
          currentSessionId: 'sess-1',
          setCurrentSessionId: vi.fn(),
        }),
      );
      await act(async () => { await result.current.sendMessage(client, 'x', 'sess-1'); });
      systems.push(prompt.mock.calls[0][0].system as string);
    }

    expect(new Set(systems).size).toBe(3);
  });

  it('质量规则模板改由 quality-template 工具现拉：S3 system 只给调用约束，不带 SQL 骨架', async () => {
    const systemOf = async (roleType: string): Promise<string> => {
      const { client, prompt } = createClient();
      const { result } = renderHook(() =>
        useOpencodeChat({
          username: 'u',
          moduleId: 'dev-assistant',
          roleType,
          currentSessionId: 'sess-1',
          setCurrentSessionId: vi.fn(),
        }),
      );
      await act(async () => { await result.current.sendMessage(client, 'x', 'sess-1'); });
      return prompt.mock.calls[0][0].system as string;
    };

    const dev = await systemOf('DATA_DEV_ENGINEER');
    // 工具调用约束随 S3 提示词下发
    expect(dev).toContain('## 质量规则模板获取（强约束）');
    expect(dev).toContain('quality-template');
    expect(dev).toContain('PRIMARY_KEY_UNIQUE');
    // 模板 SQL 骨架不再内嵌（改由工具按规则类型现拉）
    expect(dev).not.toContain('HAVING COUNT(1) > 1');
    // 回传规范里新加的字段必须随提示词下发，否则 S3 不知道要带 ruleId / execSql
    expect(dev).toContain('execSql');
    expect(dev).toContain('ruleId');

    const architect = await systemOf('DATA_ARCHITECT');
    expect(architect).not.toContain('## 质量规则模板获取');
  });

  it('没有会话时才创建新会话', async () => {
    const { client, prompt, create } = createClient();
    const setCurrentSessionId = vi.fn();
    const { result } = renderHook(() =>
      useOpencodeChat({
        username: 'u',
        moduleId: 'dev-assistant',
        roleType: 'DATA_ARCHITECT',
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
