// @vitest-environment node
/**
 * agentLifecycle 单测：覆盖 opencode 生命周期修复（并发启动 / 旧进程退出 / 失败复位）。
 *
 * 这里直接对 agentLifecycle 的互斥与句柄归属断言，同时用与
 * startOpencodeServerLocked 相同的调用顺序模拟一次启动，确保「两个入口并发进入」
 * 只会 spawn 一个进程。
 */
import { describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import {
  currentAgentProcess,
  registerAgentProcess,
  releaseAgentProcessIfCurrent,
  runExclusive,
} from './agentLifecycle';

/** 最小可用的假进程：只实现生命周期代码真正读到的字段。 */
function fakeProcess(pid: number): ChildProcess & { kill: (signal?: string) => boolean } {
  return {
    pid,
    exitCode: null,
    killed: false,
    kill: () => true,
  } as unknown as ChildProcess & { kill: (signal?: string) => boolean };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('runExclusive', () => {
  it('串行化：前一次操作未完成时，后一次不得进入临界区', async () => {
    const events: string[] = [];
    await Promise.all([
      runExclusive(async () => {
        events.push('a:enter');
        await delay(20);
        events.push('a:exit');
      }),
      runExclusive(async () => {
        events.push('b:enter');
        await delay(1);
        events.push('b:exit');
      }),
    ]);

    expect(events).toEqual(['a:enter', 'a:exit', 'b:enter', 'b:exit']);
  });

  it('前一次失败不阻塞后续操作，且异常只抛给对应调用方', async () => {
    await expect(
      runExclusive(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    await expect(runExclusive(async () => 'ok')).resolves.toBe('ok');
  });
});

describe('并发启动只 spawn 一次', () => {
  it('两个入口同时进入「检查 → spawn → 登记」，第二个复用已启动实例', async () => {
    let spawnCount = 0;
    // 模拟 opencode：活着即健康（真实实现是 /health 探测）
    const healthCheck = async () => currentAgentProcess() !== null;

    // 与 startOpencodeServerLocked 相同的顺序：判活 → 复用或 spawn → 登记 → 就绪窗口
    const startLikeOpencode = async (): Promise<string> => {
      const running = currentAgentProcess();
      if (running && running.pid != null && (await healthCheck())) {
        return 'reuse';
      }
      const proc = fakeProcess(++spawnCount);
      registerAgentProcess(proc);
      await delay(20); // 就绪检测窗口：没有互斥时这里会被第二个调用插进来
      return 'started';
    };

    const results = await Promise.all([
      runExclusive(startLikeOpencode),
      runExclusive(startLikeOpencode),
    ]);

    expect(spawnCount).toBe(1);
    expect(results).toEqual(['started', 'reuse']);
    releaseAgentProcessIfCurrent(currentAgentProcess() as ChildProcess);
    expect(currentAgentProcess()).toBeNull();
  });

  it('启动失败会复位状态，下一次启动重新 spawn', async () => {
    let spawnCount = 0;

    // 失败路径：登记后判定未能就绪 → 丢弃 → 抛错（对应 discardSpawnedProcess）
    const failingStart = async (): Promise<void> => {
      const proc = fakeProcess(++spawnCount);
      registerAgentProcess(proc);
      releaseAgentProcessIfCurrent(proc);
      throw new Error('Agent 服务器启动超时');
    };

    await expect(runExclusive(failingStart)).rejects.toThrow('启动超时');
    expect(currentAgentProcess()).toBeNull();

    const second = fakeProcess(++spawnCount);
    await runExclusive(async () => {
      registerAgentProcess(second);
    });
    expect(spawnCount).toBe(2);
    expect(currentAgentProcess()).toBe(second);
  });
});

describe('旧进程退出不得影响新进程', () => {
  it('releaseIfCurrent 对旧句柄返回 false 且不清掉新句柄', () => {
    const oldProc = fakeProcess(1);
    const newProc = fakeProcess(2);

    registerAgentProcess(oldProc);
    registerAgentProcess(newProc); // 新实例接管

    // 旧进程此刻才收到 exit：不得清状态
    expect(releaseAgentProcessIfCurrent(oldProc)).toBe(false);
    expect(currentAgentProcess()).toBe(newProc);

    // 当前句柄退出才清状态
    expect(releaseAgentProcessIfCurrent(newProc)).toBe(true);
    expect(currentAgentProcess()).toBeNull();
  });

  it('重复释放同一句柄不会误清后续登记的进程', () => {
    const first = fakeProcess(1);
    registerAgentProcess(first);
    expect(releaseAgentProcessIfCurrent(first)).toBe(true);

    const second = fakeProcess(2);
    registerAgentProcess(second);
    // 第一个进程的 exit 事件迟到，再次尝试释放
    expect(releaseAgentProcessIfCurrent(first)).toBe(false);
    expect(currentAgentProcess()).toBe(second);
  });
});
