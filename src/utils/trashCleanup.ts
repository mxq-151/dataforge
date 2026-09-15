/**
 * 回收站清理执行器：把「该清哪些批次」的决策（trashRetention.ts）落到磁盘操作上。
 *
 * 与删除主流程同样的安全取向 —— 这是又一个会删东西的地方，所以：
 *   1. 删除目标必须是 `<工作区>/.dataforge-trash` 的**直接子目录**，且名字能被
 *      解析为批次时间戳（`selectTrashPurgeCandidates` 已保证，这里再校验一次：
 *      决策与执行分属两个模块，任何一方的改动都不该让另一方越界）；
 *   2. 全程 best-effort：单个批次删不掉只记日志，绝不抛错影响调用方的删除主流程；
 *   3. 批量操作（如回滚会连续移入上百个文件）走 `scheduleTrashRetention` 合并执行，
 *      避免「每移一个文件就统计一次整个回收站」。
 */

import { dirUsage, exists, readDir, remove } from '../bridge/fs';
import { getDirName, joinPath } from './pathUtils';
import { TRASH_DIR_NAME, pathCompareKey } from './rollbackSafety';
import {
  DEFAULT_TRASH_RETENTION_POLICY,
  parseTrashBatchStamp,
  selectTrashPurgeCandidates,
  type TrashBatch,
  type TrashPurgeReason,
  type TrashRetentionPolicy,
} from './trashRetention';

export interface TrashCleanupOptions {
  policy?: TrashRetentionPolicy;
  /** 注入「当前时间」便于测试 */
  now?: number;
}

export interface TrashCleanupResult {
  purged: Array<{ name: string; reason: TrashPurgeReason; bytes: number }>;
  /** 清理后回收站仍占用的字节数（估算；命中统计上限时为下界） */
  keptBytes: number;
  /** 被安全闸门拦下的目标（正常为 0，非 0 说明有异常输入） */
  blocked: string[];
  errors: string[];
}

const emptyResult = (): TrashCleanupResult => ({ purged: [], keptBytes: 0, blocked: [], errors: [] });

/** 目标是否恰好是回收站目录的直接子项 */
const isDirectChild = (target: string, trashDir: string): boolean => {
  const name = target.slice(target.lastIndexOf('/') + 1).slice(target.lastIndexOf('\\') + 1);
  if (!name || name === '.' || name === '..' || name.includes('..')) return false;
  return pathCompareKey(getDirName(target)) === pathCompareKey(trashDir);
};

/**
 * 立即执行一次回收站清理。返回清理明细，供测试与调用方日志使用。
 * 任何 IO 失败都收进 `errors`，不抛出。
 */
export async function enforceTrashRetention(
  rootPath: string,
  options: TrashCleanupOptions = {}
): Promise<TrashCleanupResult> {
  const result = emptyResult();
  if (!rootPath) return result;

  const policy = options.policy ?? DEFAULT_TRASH_RETENTION_POLICY;
  const trashDir = joinPath(rootPath, TRASH_DIR_NAME);

  try {
    if (!(await exists(trashDir))) return result;
  } catch {
    return result;
  }

  let entries: Array<{ name: string; isDirectory: boolean; isSymlink: boolean }>;
  try {
    entries = await readDir(trashDir);
  } catch (err) {
    result.errors.push(`回收站不可读: ${String(err)}`);
    return result;
  }

  // 名字解析不出的条目直接跳过：不统计、不参与清理决策
  const batches: TrashBatch[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory || entry.isSymlink) continue;
    if (parseTrashBatchStamp(entry.name) === null) continue;
    const usage = await dirUsage(joinPath(trashDir, entry.name));
    batches.push({ name: entry.name, bytes: usage.bytes });
  }

  let totalBytes = batches.reduce((sum, b) => sum + b.bytes, 0);
  const candidates = selectTrashPurgeCandidates(batches, policy, options.now ?? Date.now());

  for (const c of candidates) {
    const target = joinPath(trashDir, c.name);
    // 防御性二次校验：决策与执行分属两个模块，宁可拦下也不要越界删除
    if (!isDirectChild(target, trashDir)) {
      result.blocked.push(target);
      continue;
    }
    try {
      await remove(target, { recursive: true });
      result.purged.push({ name: c.name, reason: c.reason, bytes: c.bytes });
      totalBytes -= c.bytes;
    } catch (err) {
      // 目录可能正被并发删除，或文件被其它进程占用（Windows 常见）
      result.errors.push(`${c.name}: ${String(err)}`);
    }
  }

  result.keptBytes = Math.max(0, totalBytes);

  if (result.purged.length > 0 || result.errors.length > 0) {
    const detail = result.purged.map(p => `${p.name}(${p.reason})`).join(', ');
    console.log(
      `🗑️ [trash] 回收站清理：清理 ${result.purged.length} 个批次 [${detail}]，` +
        `保留 ${(result.keptBytes / 1024 / 1024).toFixed(1)} MB` +
        (result.errors.length > 0 ? `，${result.errors.length} 个批次失败` : '')
    );
  }

  return result;
}

/** 待执行的清理任务：同一工作区合并为一次 */
const pending = new Map<string, ReturnType<typeof setTimeout>>();
/** 正在执行的工作区，避免重入 */
const running = new Set<string>();

/** 合并窗口：批量移入回收站（回滚可能连续上百次）只在结束后统计一次 */
export const TRASH_RETENTION_DEBOUNCE_MS = 5000;

/**
 * 安排一次延迟清理（fire-and-forget）。
 *
 * 调用时机是「刚往回收站里放了东西之后」，因此不需要同步完成；
 * 同一工作区在窗口内的多次调用只执行一次，避免逐个文件统计整站体积。
 */
export function scheduleTrashRetention(
  rootPath: string,
  delayMs: number = TRASH_RETENTION_DEBOUNCE_MS
): void {
  if (!rootPath) return;
  const existing = pending.get(rootPath);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    pending.delete(rootPath);
    if (running.has(rootPath)) return; // 上一轮还没跑完：本轮跳过，由下一轮兜底
    running.add(rootPath);
    void enforceTrashRetention(rootPath)
      .catch(() => {
        /* 清理失败不影响主流程 */
      })
      .finally(() => running.delete(rootPath));
  }, delayMs);

  // Node（测试环境）下不该因为一个后台清理让进程无法退出；
  // 渲染层 setTimeout 返回 number，没有 unref，故按可选能力探测
  (timer as unknown as { unref?: () => void }).unref?.();

  pending.set(rootPath, timer);
}

/** 仅供测试：清空待执行队列与执行态 */
export const __resetTrashRetentionSchedule = (): void => {
  for (const timer of pending.values()) clearTimeout(timer);
  pending.clear();
  running.clear();
};
