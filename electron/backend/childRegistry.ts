/**
 * 子进程登记表 + 退出期强制收尾（纯逻辑，零 electron 依赖，可直接单测）。
 *
 * 背景（审计 H4）：应用退出时原实现只 `void stopOpencodeServer()`，而 stop 要走
 * runExclusive 业务队列（可能排在一次启动之后，最长约 20s），进程一退就把它截断；
 * 同时编译用的 mvn 与本地运行用的 java 从未被登记，退出后继续跑。
 *
 * 这里提供两件事：
 *   1. 主进程 spawn 的长生命周期子进程统一登记在册（opencode / mvn / localrun），
 *      收到 exit / error 时自动摘除，表不随运行时长增长；
 *   2. terminateAllChildren：退出期专用，绕开任何业务队列，直接对当前在册进程执行
 *      SIGTERM → 短宽限 → SIGKILL；幂等，不抛错，不改变调用方状态。
 */
import type { ChildProcess } from 'node:child_process';

export type ChildKind = 'opencode' | 'mvn' | 'localrun';

interface Entry {
  proc: ChildProcess;
  kind: ChildKind;
}

const entries = new Map<ChildProcess, Entry>();

/**
 * 是否已真正退出。
 *
 * 只认 exitCode / signalCode：`proc.killed` 在 SIGTERM 成功发出后立即变 true，
 * 用它做 SIGKILL 升级判断会永远跳过升级（审计 H4 的第三点）。
 */
export function hasExited(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
}

let shuttingDown = false;

/**
 * 进入退出收尾：此后不再接受新登记。
 * 退出流程中途仍可能有人 spawn（例如排队中的启动刚好走到这一步），那些进程没人会再管，
 * 必须在登记时就杀掉，否则又留下一个新的孤儿。
 */
export function beginShutdown(): void {
  shuttingDown = true;
}

/** 登记子进程；同一句柄重复登记是幂等的。 */
export function registerChild(proc: ChildProcess, kind: ChildKind): void {
  if (shuttingDown) {
    signal(proc, 'SIGKILL');
    return;
  }
  if (entries.has(proc)) return;
  entries.set(proc, { proc, kind });
  // 正常退出即自行摘除，避免登记表无限增长
  const drop = () => {
    entries.delete(proc);
  };
  proc.once('exit', drop);
  proc.once('error', drop);
}

/** 当前在册且尚未退出的子进程快照。 */
export function liveChildren(): Array<{ proc: ChildProcess; kind: ChildKind }> {
  return [...entries.values()].filter((entry) => !hasExited(entry.proc));
}

function signal(proc: ChildProcess, sig: NodeJS.Signals): void {
  try {
    proc.kill(sig);
  } catch {
    /* 进程可能已退出、或本来就没 spawn 成功：退出路径不允许抛错 */
  }
}

/** 轮询粒度：决定"到期后多久真正强杀"，也是总耗时上界里的抖动项。 */
const POLL_INTERVAL_MS = 50;

export interface TerminateOptions {
  /** 按进程类型指定 SIGTERM 宽限（毫秒）；未列出的类型使用 defaultGraceMs。 */
  graceMsByKind?: Partial<Record<ChildKind, number>>;
  /** 兜底宽限，默认 800ms。 */
  defaultGraceMs?: number;
}

/**
 * 对当前在册的全部子进程执行 SIGTERM → 各自的宽限 → SIGKILL。
 *
 * 宽限按类型区分（见 TerminateOptions），但所有类型共享同一个轮询循环：
 * 各类的计时是并发的，因此总等待 = max(各类宽限)，不是求和。
 *
 * 幂等：进程已退出、表已空、重复调用都直接返回；任何 kill 异常都被吞掉，
 * 因此可以在退出路径上无保护地重复触发。
 */
export async function terminateAllChildren(opts: TerminateOptions = {}): Promise<void> {
  const defaultGraceMs = Math.max(0, opts.defaultGraceMs ?? 800);
  const pending = new Map<ChildProcess, number>();
  const startedAt = Date.now();

  for (const [proc, entry] of entries) {
    if (hasExited(proc)) {
      entries.delete(proc);
      continue;
    }
    const graceMs = Math.max(0, opts.graceMsByKind?.[entry.kind] ?? defaultGraceMs);
    pending.set(proc, startedAt + graceMs);
    signal(proc, 'SIGTERM');
  }

  while (pending.size > 0) {
    const now = Date.now();
    let nextWake = Infinity;

    for (const proc of [...pending.keys()]) {
      // 已自行退出（exit 事件已把它从表里摘掉）就不用再管
      if (hasExited(proc) || !entries.has(proc)) {
        pending.delete(proc);
        continue;
      }
      const deadline = pending.get(proc)!;
      if (now >= deadline) {
        signal(proc, 'SIGKILL');
        // 强杀后立即摘除：即使 exit 事件还没送达，也不让后续收尾再处理它一次
        entries.delete(proc);
        pending.delete(proc);
        continue;
      }
      nextWake = Math.min(nextWake, deadline - now);
    }

    if (pending.size === 0) break;
    const sleepMs = Number.isFinite(nextWake) ? Math.min(POLL_INTERVAL_MS, Math.max(1, nextWake)) : POLL_INTERVAL_MS;
    await new Promise((r) => setTimeout(r, sleepMs));
  }
}
