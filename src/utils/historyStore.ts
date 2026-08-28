import { getSyncedStore } from './syncedStore';

/**
 * 执行/查询历史的统一持久化。
 *
 * 原先 DataExploreEditor 与 useProgramRunner 各自实现了一套几乎相同的
 * localStorage 读写（同样的 load/save 模式、同样的 scoped key、同样的 Date 反序列化），
 * 且历史条数上限 2000 意味着单条体积大时容易逼近 localStorage 的 5MB 配额。
 * 统一收口到 SyncedStore（主进程磁盘文件），两处共用同一套读写与迁移逻辑。
 */

const HISTORY_STORE_FILE = 'execution-history.json';

/** 每个作用域最多保留的历史条数 */
export const MAX_HISTORY_ITEMS = 2000;

const historyStore = getSyncedStore(HISTORY_STORE_FILE);

/** 确保历史库已从磁盘预热（可并发调用，内部共享同一次加载） */
export function ensureHistoryStore(): Promise<void> {
  return historyStore.init();
}

/**
 * 一次性迁移：把旧版本留在 localStorage 的历史搬到磁盘库后清除。
 * Store 中已有该键的数据时以 Store 为准，不覆盖。
 */
function migrateLegacy(key: string): void {
  try {
    if (historyStore.get(key) !== undefined) return;
    const raw = localStorage.getItem(key);
    if (!raw) return;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed != null) {
      historyStore.set(key, parsed);
    }
    localStorage.removeItem(key);
  } catch {
    // 迁移失败忽略，历史丢失不影响主流程
  }
}

/**
 * 读取某个作用域的历史记录。
 * revive 负责把反序列化后的原始对象还原成领域对象（如把 ISO 字符串转回 Date），
 * 返回 null 的条目会被丢弃。
 */
export function readHistory<T>(key: string, revive: (raw: unknown) => T | null): T[] {
  try {
    migrateLegacy(key);
    const raw = historyStore.get<unknown>(key);
    if (!Array.isArray(raw)) return [];
    const out: T[] = [];
    for (const item of raw) {
      const revived = revive(item);
      if (revived !== null) out.push(revived);
    }
    return out;
  } catch {
    return [];
  }
}

/** 写入某个作用域的历史记录（超出上限会截断） */
export function writeHistory<T>(key: string, records: T[]): void {
  try {
    historyStore.set(key, records.slice(0, MAX_HISTORY_ITEMS));
  } catch {
    // 持久化不可用时静默忽略
  }
}
