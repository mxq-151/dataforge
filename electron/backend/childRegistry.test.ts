// @vitest-environment node
/**
 * childRegistry 单测：覆盖审计 H4 的退出收尾行为。
 *
 * 用例按顺序执行（beginShutdown 是单向的，放在最后一组）。
 */
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  beginShutdown,
  liveChildren,
  hasExited,
  registerChild,
  terminateAllChildren,
} from './childRegistry';

/**
 * 假子进程：kill 时把 killed 置 true（真实 Node 也是这个语义），
 * 用来验证升级判断不依赖 killed —— 这正是原实现的 bug 点。
 */
class FakeChild extends EventEmitter {
  pid = 1;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  signals: string[] = [];
  behavior: 'graceful' | 'ignore' = 'graceful';

  kill(sig?: NodeJS.Signals | number): boolean {
    const signal = typeof sig === 'string' ? sig : 'SIGTERM';
    this.signals.push(signal);
    this.killed = true;
    if (this.behavior === 'graceful') {
      this.exitCode = 0;
      this.emit('exit', 0, null);
    }
    return true;
  }
}

/** 记录每次信号的时间点，用于断言"按类型分别到期"。 */
class TimedChild extends FakeChild {
  at: Array<{ signal: string; t: number }> = [];

  kill(sig?: NodeJS.Signals | number): boolean {
    const signal = typeof sig === 'string' ? sig : 'SIGTERM';
    this.at.push({ signal, t: Date.now() });
    return super.kill(sig);
  }
}

function fakeProc(behavior: 'graceful' | 'ignore' = 'graceful'): FakeChild {
  const proc = new FakeChild();
  proc.behavior = behavior;
  return proc;
}

const asChild = (proc: FakeChild): ChildProcess => proc as unknown as ChildProcess;

/** 让假进程走一次正常退出，把它从登记表里摘掉（表本身没有对外暴露删除接口）。 */
function markExited(proc: FakeChild): void {
  proc.exitCode = 0;
  proc.emit('exit', 0, null);
}

afterEach(() => {
  for (const { proc } of liveChildren()) markExited(proc as unknown as FakeChild);
});

describe('登记与自动摘除', () => {
  it('登记后出现在在册列表，退出事件到达后自动摘除', () => {
    const proc = fakeProc();
    registerChild(asChild(proc), 'mvn');
    expect(liveChildren().map((e) => e.kind)).toEqual(['mvn']);

    markExited(proc);

    // 表不会随运行时长增长：正常退出的进程自行摘除
    expect(liveChildren()).toEqual([]);
  });

  it('同一句柄重复登记是幂等的', () => {
    const proc = fakeProc();
    registerChild(asChild(proc), 'opencode');
    registerChild(asChild(proc), 'opencode');
    expect(liveChildren()).toHaveLength(1);
  });

  it('hasExited 只看 exitCode/signalCode，不看 killed', () => {
    const proc = fakeProc('ignore');
    proc.kill('SIGTERM');
    // SIGTERM 已发出（killed=true），但进程还活着 —— 此时必须判为「未退出」，
    // 否则 SIGKILL 升级会被永久跳过（原实现的 bug）
    expect(proc.killed).toBe(true);
    expect(hasExited(asChild(proc))).toBe(false);

    proc.signalCode = 'SIGKILL';
    expect(hasExited(asChild(proc))).toBe(true);
  });
});

describe('terminateAllChildren', () => {
  it('先 SIGTERM，宽限内不退出的升级为 SIGKILL', async () => {
    const graceful = fakeProc('graceful');
    const stubborn = fakeProc('ignore');
    registerChild(asChild(graceful), 'opencode');
    registerChild(asChild(stubborn), 'localrun');

    await terminateAllChildren({ defaultGraceMs: 60 });

    expect(graceful.signals).toEqual(['SIGTERM']);
    expect(stubborn.signals).toEqual(['SIGTERM', 'SIGKILL']);
    // 强杀后立即摘除，后续收尾不会再处理它
    expect(liveChildren()).toEqual([]);
  });

  it('宽限按类型区分，且各类并发计时（总等待取最大档，不累加）', async () => {
    const opencode = new TimedChild();
    opencode.behavior = 'ignore';
    const mvn = new TimedChild();
    mvn.behavior = 'ignore';
    registerChild(asChild(opencode), 'opencode');
    registerChild(asChild(mvn), 'mvn');

    const t0 = Date.now();
    await terminateAllChildren({
      graceMsByKind: { opencode: 200, mvn: 20 },
      defaultGraceMs: 800,
    });
    const elapsed = Date.now() - t0;

    const killAt = (c: TimedChild) => c.at.find((s) => s.signal === 'SIGKILL')!.t - t0;
    // mvn 先到期先强杀，opencode 等满自己那档
    expect(killAt(mvn)).toBeLessThan(120);
    expect(killAt(opencode)).toBeGreaterThanOrEqual(190);
    // 并发计时：总耗时接近最大档（200ms），远小于两档之和（220ms）+ 两次轮询
    expect(elapsed).toBeLessThan(300);
  });

  it('幂等：重复调用不抛错且第二次是 no-op', async () => {
    const stubborn = fakeProc('ignore');
    registerChild(asChild(stubborn), 'mvn');

    await terminateAllChildren({ defaultGraceMs: 10 });
    const afterFirst = [...stubborn.signals];

    await expect(terminateAllChildren({ defaultGraceMs: 10 })).resolves.toBeUndefined();
    expect(stubborn.signals).toEqual(afterFirst);
  });

  it('表为空时直接返回', async () => {
    expect(liveChildren()).toEqual([]);
    await expect(terminateAllChildren({ defaultGraceMs: 10 })).resolves.toBeUndefined();
  });

  it('已经退出的进程不会被再次发信号', async () => {
    const proc = fakeProc();
    registerChild(asChild(proc), 'mvn');
    proc.exitCode = 0; // 已退出但 exit 事件还没派发到表里
    await terminateAllChildren({ defaultGraceMs: 10 });
    expect(proc.signals).toEqual([]);
  });
});

// 必须在最后：beginShutdown 是单向的
describe('退出闸', () => {
  it('进入退出门后新登记的进程被立刻强杀且不入表', () => {
    beginShutdown();
    const late = fakeProc('ignore');
    registerChild(asChild(late), 'opencode');

    expect(late.signals).toEqual(['SIGKILL']);
    expect(liveChildren()).toEqual([]);
  });
});
