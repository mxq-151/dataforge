// @vitest-environment jsdom
/**
 * useOpencodeClient.dataExploreDir.test.tsx
 * 数据探索「切会话后连接被拉回基础目录」回归测试
 *
 * ── 现象（2026-10-12 渲染进程日志实证）──
 *   00:35:27.905  connected working dir: .../admin/individual/1791736527892   ← 切到会话目录
 *   00:35:27.918  connected working dir: .../admin/individual                 ← 13ms 后被拉回
 *   00:35:27.926  订阅 SSE 事件流 — directory=.../admin/individual             ← 订阅跟着跑掉
 * 会话目录那次连接**从未产生自己的订阅**（日志里没有 directory=...1791736527892 的订阅行）。
 * 前端按「事件目录 == 订阅目录」过滤 SSE（useOpencodeEvents.ts；子代理会话共享父目录，
 * 故不能改按 sessionID 过滤），于是该会话的事件被整条丢弃：
 *   用户消息有本地回显、智能体回复永不上屏；切到别的会话再切回来（loadSession 直读
 *   服务端 session.messages）才看得到回复。
 *
 * ── 触发链 ──
 * App.tsx::DataExploreClientSlot 的自动启动 effect 依赖 backend.connected：
 *     if (!backend.connected && !backend.starting) start()
 * 而 setWorkingDirectory（数据探索切会话）内部先 doDisconnect ⇒ connected 瞬时为 false，
 * 该 effect 因此在切换**完成之后**才跑到（实测相隔 13ms），调用**不带 cwd** 的 start()，
 * 而 start() 的目标是模块基础目录 individual/ ⇒ 覆盖掉刚切到的会话目录。
 *
 * ── 本测试的关键（上一版测试的缺陷）──
 * 上一版在与 setWorkingDirectory **并发**的位置调用 start()，被闸门挡下就判定修好了；
 * 但真实时序是 start() 在切换**完成之后**才被调用 —— 那一刻闸门已释放，仍然会覆盖。
 * 所以下面的用例把 start() 放在 await setWorkingDirectory 之后调用，并且同时覆盖
 * 「切换进行中」和「切换完成后」两种时序。
 */

import React, { useEffect, useRef } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { OpencodeBackendProvider } from './useOpencodeBackend';
import {
  OpencodeClientProvider,
  useOpencodeClient,
  type OpencodeClientBackend,
} from './useOpencodeClient';

// ── SDK 桩：记录每个客户端绑定的目录，并记录每次开启的 SSE 流 ──
const createdDirs: Array<string | undefined> = [];
const openedStreams: Array<string | undefined> = [];

vi.mock('@opencode-ai/sdk/v2/client', () => ({
  createOpencodeClient: (config: { directory?: string }) => {
    const dir = config?.directory;
    createdDirs.push(dir);
    return {
      __dir: dir,
      global: {
        event: () => {
          openedStreams.push(dir);
          // 永不 resolve：模拟一条一直开着的事件流（不触发重连循环）
          return new Promise(() => { /* never */ });
        },
      },
      // 模型列表：直接命中，避免 modelContextLimit 的重试定时器
      v2: {
        model: {
          list: async () => ({
            data: { data: [{ id: 'deepseek-flash', providerID: 'deepseek', limit: { context: 1_000_000 } }] },
          }),
        },
      },
      session: {
        list: async () => ({ data: [] }),
        get: async () => ({ data: { id: 'sess-x', time: {} } }),
        messages: async () => ({ data: [], response: { headers: new Headers() } }),
        todo: async () => ({ data: [] }),
        create: async () => ({ data: { id: 'sess-new' } }),
      },
    };
  },
}));

// ── Electron 桥 / api 全桩（jsdom 下不存在）──
vi.mock('../../bridge/event', () => ({ listen: vi.fn(async () => () => { /* noop */ }) }));
vi.mock('../../bridge/fs', () => ({
  exists: vi.fn(async () => true),
  mkdir: vi.fn(async () => undefined),
}));
vi.mock('../../api/index', () => ({
  getAuthToken: vi.fn(async () => 'token'),
  getApiHost: vi.fn(async () => 'http://localhost:8082'),
}));

/** 内存版 localStorage（jsdom 环境未注入） */
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

const BASE_DIR = '/home/u/.dataforge/host/u/individual';
const SESSION_DIR = `${BASE_DIR}/1791736527892`;

/** 捕获 provider 暴露的 backend，供用例直接调用 */
let backendRef: OpencodeClientBackend | null = null;

/**
 * 复刻 App.tsx::DataExploreClientSlot 的自动启动 effect —— 抢跑的来源。
 * 生产环境里它会在 connected 翻转时自行调用 start()；jsdom + act 会把整段更新
 * 合并成一次提交，effect 不一定真的在窗口里触发，因此用例另外显式调用 start()
 * 来还原生产环境中的那一枪（两种时序都覆盖）。
 */
function AutoStartSlot() {
  const backend = useOpencodeClient();
  backendRef = backend;
  const startRef = useRef(backend.start);
  startRef.current = backend.start;
  useEffect(() => {
    if (!backend.connected && !backend.starting) {
      startRef.current().catch(() => { /* noop */ });
    }
  }, [backend.connected, backend.starting]);
  return null;
}

function mountProvider() {
  const config = {
    model: 'deepseek-flash',
    modelProvider: 'deepseek',
  } as never;

  return render(
    <OpencodeBackendProvider
      options={{ serverUrl: 'http://127.0.0.1:4096', permissionMode: 'auto', config }}
    >
      <OpencodeClientProvider
        config={config}
        username="admin"
        moduleId="data-explore"
        roleType="DATA_ANALYST"
        projectId="__data_explore__"
        directory={BASE_DIR}
        dataExploreService={{
          baseDir: BASE_DIR,
          listDirs: async () => [],
          createDir: async () => null,
          removeDir: async () => { /* noop */ },
        }}
      >
        <AutoStartSlot />
      </OpencodeClientProvider>
    </OpencodeBackendProvider>,
  );
}

describe('数据探索切会话：连接与 SSE 订阅必须停留在会话目录', () => {
  beforeEach(() => {
    createdDirs.length = 0;
    openedStreams.length = 0;
    backendRef = null;
    storage.clear();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 })));
  });

  it('切换完成后触发自动启动（真实时序）：不得被拉回基础目录', async () => {
    mountProvider();

    // 1) 首次连接：绑定模块基础目录，订阅一次
    await act(async () => {
      await backendRef!.start();
    });
    expect(backendRef!.currentDirectory).toBe(BASE_DIR);
    expect(openedStreams).toEqual([BASE_DIR]);

    // 2) 切到会话目录（点「新建会话」或首次发问时发生）
    await act(async () => {
      await backendRef!.setWorkingDirectory(SESSION_DIR);
    });
    expect(backendRef!.currentDirectory).toBe(SESSION_DIR);
    expect(openedStreams).toEqual([BASE_DIR, SESSION_DIR]);

    // 3) App 层自动启动 effect 迟到的这一枪 —— 实测发生在切换完成后约 13ms
    await act(async () => {
      await backendRef!.start();
    });

    // 必须保持会话目录：不得多建基础目录客户端，也不得把订阅拉走
    expect(backendRef!.currentDirectory).toBe(SESSION_DIR);
    expect(createdDirs).toEqual([BASE_DIR, SESSION_DIR]);
    expect(openedStreams).toEqual([BASE_DIR, SESSION_DIR]);
  });

  it('切换进行中触发自动启动：闸门挡下，不得产生基础目录客户端', async () => {
    mountProvider();

    await act(async () => {
      await backendRef!.start();
    });

    await act(async () => {
      const switching = backendRef!.setWorkingDirectory(SESSION_DIR);
      // 窗口内抢跑（不 await 切换完成）
      await backendRef!.start();
      await switching;
    });

    expect(backendRef!.currentDirectory).toBe(SESSION_DIR);
    expect(createdDirs).toEqual([BASE_DIR, SESSION_DIR]);
    expect(openedStreams).toEqual([BASE_DIR, SESSION_DIR]);
  });

  it('已连接且未指定目录时 start() 不改动目录、不重建客户端', async () => {
    mountProvider();

    await act(async () => {
      await backendRef!.start();
    });
    expect(createdDirs).toEqual([BASE_DIR]);

    await act(async () => {
      await backendRef!.setWorkingDirectory(SESSION_DIR);
    });
    expect(createdDirs).toEqual([BASE_DIR, SESSION_DIR]);

    // 连续多次自动启动：全部应为空操作
    await act(async () => {
      await backendRef!.start();
      await backendRef!.start();
    });

    expect(backendRef!.currentDirectory).toBe(SESSION_DIR);
    expect(createdDirs).toEqual([BASE_DIR, SESSION_DIR]);
    expect(openedStreams).toEqual([BASE_DIR, SESSION_DIR]);
  });

  it('切到同一目录：不重建连接、不重开事件流', async () => {
    mountProvider();

    await act(async () => {
      await backendRef!.start();
    });

    await act(async () => {
      await backendRef!.setWorkingDirectory(SESSION_DIR);
    });
    expect(createdDirs).toEqual([BASE_DIR, SESSION_DIR]);
    expect(openedStreams).toEqual([BASE_DIR, SESSION_DIR]);

    await act(async () => {
      await backendRef!.setWorkingDirectory(SESSION_DIR);
    });
    expect(createdDirs).toEqual([BASE_DIR, SESSION_DIR]);
    expect(openedStreams).toEqual([BASE_DIR, SESSION_DIR]);
  });
});
