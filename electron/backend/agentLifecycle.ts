/**
 * opencode 侧车进程的生命周期互斥与句柄归属（纯逻辑，零 electron/fs 依赖，可直接单测）。
 *
 * 背景：应用启动的 autoStartOpencode（main.ts）与登录后的 start_opencode_after_login
 * （渲染层 invoke）是两条独立触发路径，都可能并发进入「判断是否在跑 → spawn →
 * 登记句柄」这一段。没有互斥时两者都会通过判断、各 spawn 一次；后到者因端口 4096
 * 被占用而启动失败，却已经把句柄覆盖成自己的进程 —— 先启动那个健康进程的句柄丢失，
 * 之后 stop 再也杀不到它，重登一次就在端口上叠一层孤儿进程。
 *
 * 同理，旧进程的 exit 回调若不认身份，会在新进程已经接管之后把新句柄置空。
 *
 * 所以这里把两件事收敛到一处：
 *   - runExclusive：start / stop 排队执行，任一次生命周期操作不可与另一次交错；
 *   - register / releaseIfCurrent：句柄带身份，只有当前登记的那个进程退出才清状态。
 *
 * 注意：本模块是进程内状态，不做跨进程/持久化协调。
 */
import type { ChildProcess } from 'node:child_process';

/** 当前登记的侧车进程句柄；null 表示没有在跑。 */
let current: ChildProcess | null = null;

/**
 * 生命周期操作队列尾。
 *
 * 用 Promise 链实现互斥：后一次操作在前一次 settle 之后才开始，因此
 * 「读状态 → 判断 → 起进程 → 写状态」在逻辑上是一个原子的临界区。
 */
let tail: Promise<unknown> = Promise.resolve();

/**
 * 串行执行一次生命周期操作。
 *
 * 前一次失败不阻塞后续：`then(fn, fn)` 两个分支都接同一个 fn，异常只抛给
 * 对应的调用方，不会污染队列尾。
 */
export function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/** 读取当前登记的进程句柄（可能已被释放，调用方仍需自行判活）。 */
export function currentAgentProcess(): ChildProcess | null {
  return current;
}

/**
 * 取走并清空当前句柄，绕过 runExclusive。
 *
 * 仅供退出期的强制收尾使用：应用正在退出时不能排在业务队列后面等一次启动跑完，
 * 所以直接摘走句柄（之后排队中的 stop 看到 null 即跳过，不会对着死句柄二次操作）。
 */
export function takeAgentProcess(): ChildProcess | null {
  const proc = current;
  current = null;
  return proc;
}

/** 登记刚 spawn 出来的进程句柄。 */
export function registerAgentProcess(proc: ChildProcess): void {
  current = proc;
}

/**
 * 释放句柄，仅当它仍是当前登记的那个进程。
 *
 * @returns true 表示确实由本次调用清掉了状态；false 说明这是被新进程取代的旧句柄，
 *          调用方据此跳过后续的「进程已退出」通知，避免误伤新实例。
 */
export function releaseAgentProcessIfCurrent(proc: ChildProcess): boolean {
  if (current !== proc) return false;
  current = null;
  return true;
}
