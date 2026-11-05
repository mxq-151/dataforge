// @vitest-environment jsdom
/**
 * useOpencodeClient.deleteHistory.test.tsx — 删除会话必须「立即生效且不复活」
 *
 * 对应用户反馈「智能体对话历史下拉框列表有些可以删除，有些删除不了」。两条硬约束：
 *
 * 1. **本地先删**：任务列表的唯一事实来源是本地会话历史，
 *    所以 deleteSession() 必须在任何 await 之前把这一行从列表里去掉。
 *    原先实现是 `await deleteSession(sdk) → setTasks(remove...)`：只要服务端那次
 *    session.delete 挂起（sidecar 忙）或抛错，这一行就永远留在下拉框里。
 *    本用例把 SDK 的 session.delete 桩成**永不 resolve**，断言 deleteSession()
 *    仍然按时返回、且该行已从列表与本地历史中消失（回归时用例会超时失败）。
 *
 * 2. **不复活**：服务端仍持有该会话（删除请求失败/挂起，或按目录隔离的会话
 *    被别的目录列表带回来）时，下一次播种不得把它放回列表。
 *    本用例清空本地历史后重挂 Provider，断言被删的会话不会回来、其余会话照常回填。
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { OpencodeBackendProvider } from './useOpencodeBackend';
import {
  OpencodeClientProvider,
  useOpencodeClient,
  type OpencodeClientBackend,
} from './useOpencodeClient';
import {
  buildSessionHistoryKey,
  loadSessionHistory,
  saveSessionHistory,
} from './sessionHistoryStore';

/** 服务端返回的会话列表（用例可改） */
let serverSessions: Array<{ id: string; title: string; time: { created: number; updated: number } }> = [];
/** session.delete 被调用的次数 */
let deleteCallCount = 0;

vi.mock('@opencode-ai/sdk/v2/client', () => ({
  createOpencodeClient: () => ({
    global: {
      // 永不 resolve：模拟一条一直开着的事件流
      event: () => new Promise(() => { /* never */ }),
    },
    v2: {
      model: {
        list: async () => ({
          data: { data: [{ id: 'deepseek-flash', providerID: 'deepseek', limit: { context: 1_000_000 } }] },
        }),
      },
    },
    session: {
      list: async () => ({ data: serverSessions }),
      get: async () => ({ data: { id: 'sess-a', time: {} } }),
      messages: async () => ({ data: [], response: { headers: new Headers() } }),
      todo: async () => ({ data: [] }),
      create: async () => ({ data: { id: 'sess-new' } }),
      // 关键桩：删除请求永不返回（挂起），删除结果不允许依赖它
      delete: () => {
        deleteCallCount++;
        return new Promise(() => { /* never */ });
      },
      update: async () => ({ data: {} }),
    },
  }),
}));

vi.mock('../../bridge/event', () => ({ listen: vi.fn(async () => () => { /* noop */ }) }));
vi.mock('../../bridge/fs', () => ({
  exists: vi.fn(async () => true),
  mkdir: vi.fn(async () => undefined),
}));
vi.mock('../../api/index', () => ({
  getAuthToken: vi.fn(async () => 'token'),
  getApiHost: vi.fn(async () => 'http://localhost:8082'),
}));

/** 内存版 localStorage */
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

/** 与 hook 内部同构的维度 key（host 取 getApiHost() 默认值） */
const HISTORY_KEY = buildSessionHistoryKey({
  username: 'admin',
  modelId: 'dev-assistant',
  projectId: 'test_project',
});

let backendRef: OpencodeClientBackend | null = null;

function Capture() {
  backendRef = useOpencodeClient();
  return null;
}

function mountProvider() {
  const config = { model: 'deepseek-flash', modelProvider: 'deepseek' } as never;
  return render(
    <OpencodeBackendProvider
      options={{ serverUrl: 'http://127.0.0.1:4096', permissionMode: 'auto', config }}
    >
      <OpencodeClientProvider
        config={config}
        username="admin"
        moduleId="dev-assistant"
        roleType="DATA_ARCHITECT"
        projectId="test_project"
        directory="/tmp/project"
      >
        <Capture />
      </OpencodeClientProvider>
    </OpencodeBackendProvider>,
  );
}

describe('删除会话：本地立即生效 + 不复活', () => {
  beforeEach(() => {
    storage.clear();
    backendRef = null;
    deleteCallCount = 0;
    serverSessions = [
      { id: 'sess-a', title: '会话 A', time: { created: 100, updated: 200 } },
      { id: 'sess-b', title: '会话 B', time: { created: 100, updated: 300 } },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 })));
  });

  afterEach(() => {
    cleanup();
  });

  it('服务端删除挂起时，deleteSession 仍立即从列表与本地历史移除该行', async () => {
    saveSessionHistory(HISTORY_KEY, [
      { sessionId: 'sess-a', title: '会话 A', createdAt: 100, updatedAt: 200 },
      { sessionId: 'sess-b', title: '会话 B', createdAt: 100, updatedAt: 300 },
    ]);

    mountProvider();
    await act(async () => {
      await backendRef!.start();
    });
    expect(backendRef!.tasks.map(t => t.sessionId)).toEqual(['sess-b', 'sess-a']);

    // 若实现里 await 了永不 resolve 的 session.delete，这一步会挂起 → 用例超时失败
    await act(async () => {
      await backendRef!.deleteSession('sess-b');
    });

    expect(backendRef!.tasks.map(t => t.sessionId)).toEqual(['sess-a']);
    expect(loadSessionHistory(HISTORY_KEY).map(t => t.sessionId)).toEqual(['sess-a']);
    expect(deleteCallCount).toBe(1);
  });

  it('被删会话不会因服务端播种而复活，其余会话照常回填', async () => {
    saveSessionHistory(HISTORY_KEY, [
      { sessionId: 'sess-a', title: '会话 A', createdAt: 100, updatedAt: 200 },
      { sessionId: 'sess-b', title: '会话 B', createdAt: 100, updatedAt: 300 },
    ]);

    const first = mountProvider();
    await act(async () => {
      await backendRef!.start();
    });
    await act(async () => {
      await backendRef!.deleteSession('sess-b');
    });
    expect(backendRef!.tasks.map(t => t.sessionId)).toEqual(['sess-a']);
    first.unmount();

    // 模拟「本地历史被清空 + 重新进入模块」：全新 hook 实例、无播种标记，
    // 于是会走服务端回填（服务端仍持有 sess-b）
    storage.delete(HISTORY_KEY);
    backendRef = null;
    mountProvider();
    await act(async () => {
      await backendRef!.start();
    });

    expect(backendRef!.tasks.map(t => t.sessionId)).toEqual(['sess-a']);
    expect(loadSessionHistory(HISTORY_KEY).map(t => t.sessionId)).toEqual(['sess-a']);
  });

  it('删除当前会话时清空当前会话，避免继续往已删会话发消息', async () => {
    saveSessionHistory(HISTORY_KEY, [
      { sessionId: 'sess-a', title: '会话 A', createdAt: 100, updatedAt: 200 },
    ]);

    mountProvider();
    await act(async () => {
      await backendRef!.start();
    });
    await act(async () => {
      await backendRef!.loadSession('sess-a');
    });
    expect(backendRef!.currentSessionId).toBe('sess-a');

    await act(async () => {
      await backendRef!.deleteSession('sess-a');
    });

    expect(backendRef!.currentSessionId).toBeNull();
    expect(backendRef!.tasks).toEqual([]);
  });
});
