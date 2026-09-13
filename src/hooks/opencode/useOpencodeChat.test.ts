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
