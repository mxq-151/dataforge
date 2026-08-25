/**
 * fileReviewStore — 文件审批状态持久化
 *
 * 使用 Tauri Store（磁盘文件）保存文件审批状态，替代 localStorage。
 * Tauri Store 无 5MB 配额限制，适合存储含长绝对路径的文件列表。
 *
 * 存储文件: file-review.json
 * Key: {sessionId}:{type}   (type = approved | rejected)
 * Value: string[]           (partID 数组，每个工具调用对应一个独立 part)
 */

import { Store } from '@tauri-apps/plugin-store';

const STORE_FILE = 'file-review.json';

// ── Store 单例 ──

let storeInstance: Store | null = null;

async function getStore(): Promise<Store> {
  if (!storeInstance) {
    storeInstance = await Store.load(STORE_FILE);
  }
  return storeInstance;
}

function makeKey(sessionId: string, type: 'approved' | 'rejected'): string {
  return `${sessionId}:${type}`;
}

// ── 公开 API ──

/**
 * 从 Tauri Store 加载指定 session 的审批状态。
 * 返回 partID 数组；如果 key 不存在或读取失败，返回空数组。
 */
export async function load(sessionId: string, type: 'approved' | 'rejected'): Promise<string[]> {
  try {
    const store = await getStore();
    const arr = await store.get<string[]>(makeKey(sessionId, type));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/**
 * 保存指定 session 的审批状态到 Tauri Store。
 * 写入失败静默忽略（不影响 UI 交互）。
 */
export async function save(sessionId: string, type: 'approved' | 'rejected', partIDs: string[]): Promise<void> {
  if (!sessionId) return;
  try {
    const store = await getStore();
    await store.set(makeKey(sessionId, type), partIDs);
  } catch (e) {
    console.warn(`[file-review] Tauri Store 写入失败 (sessionId=${sessionId}, type=${type}):`, e);
  }
}
