/**
 * 应用退出期的统一强制收尾（审计 H4）。
 *
 * 与 stopOpencodeServer 的区别：那条走 runExclusive 业务队列，要等排队中的启动
 * 跑完（最长约 20s），退出时等不起，而且原实现是 fire-and-forget，进程一退就把
 * 等待与 SIGKILL 升级截断。这里绕开队列，直接对「当前在册的子进程」做
 * SIGTERM → 短宽限 → SIGKILL，并清理 4096 端口。
 *
 * 语义保证：
 *   - 幂等：重复触发复用同一次收尾（forceShutdownAll 缓存 in-flight Promise），
 *     进程已退出 / 表为空 / 端口本来没占用都直接返回；
 *   - 不抛错：任何一步异常都只记日志，调用方可以无保护地 await；
 *   - 有界：总耗时 = graceMs + 端口清理，不会无限等待。
 */
import { beginShutdown, terminateAllChildren, type ChildKind } from './childRegistry';
import { takeAgentProcess } from './agentLifecycle';
import { cleanupOpencodePort } from './opencode';

/**
 * 退出时按类型给的 SIGTERM 宽限（毫秒）。
 *
 * opencode 取 1500：实测（resources/binaries/opencode-darwin-arm64，写入 20 条会话后发
 * SIGTERM）三轮 SIGTERM→exit 都是 8–10ms，并留下 943KB 的 -wal 文件由下次启动重放 ——
 * 也就是说这个构建根本不在 SIGTERM 上做 WAL checkpoint，1500ms 不是"等 checkpoint"，
 * 而是给慢机器 / 更大的库 / 更重的会话流量留的余量，不必再往上加。
 *
 * mvn / localrun 维持 800：它们是 CPU/IO 型任务，退出时没有可等的一致性收尾。
 *
 * 总退出耗时的上界 = max(各类宽限) + 一次 50ms 轮询粒度 + 端口清理（本机一次 lsof）
 * ≈ 1.6s。各类宽限在同一个轮询循环里并发计时，不按类型累加，所以放宽 opencode
 * 不会让退出重新变慢；没有子进程在跑时仍然是毫秒级返回。
 */
const GRACE_MS_BY_KIND: Record<ChildKind, number> = {
  opencode: 1500,
  mvn: 800,
  localrun: 800,
};

let inFlight: Promise<void> | null = null;

/** 强制收尾全部在册子进程并清理端口。重复调用返回同一个 Promise。 */
export function forceShutdownAll(): Promise<void> {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    // 1) 关停闸：此后登记的新进程直接杀掉，避免退出过程中又 spawn 出孤儿
    beginShutdown();
    // 2) 摘掉 opencode 句柄（不排队）：之后排队中的 stop 看到 null 即跳过，
    //    不会对着已收尾的句柄再做一次 SIGTERM/端口轮询
    takeAgentProcess();
    // 3) 统一收尾：opencode / mvn / localrun 一起 SIGTERM → 各自宽限 → SIGKILL
    await terminateAllChildren({ graceMsByKind: GRACE_MS_BY_KIND });
    // 4) 端口兜底：进程被强杀后端口可能仍被别的孤儿占用（如上次异常退出的实例）
    await cleanupOpencodePort();
  })().catch((e) => {
    console.warn('[shutdown] 收尾异常（已忽略）:', e instanceof Error ? e.message : String(e));
  });

  return inFlight;
}
