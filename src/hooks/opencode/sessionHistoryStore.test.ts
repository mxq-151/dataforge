// @vitest-environment jsdom
/**
 * sessionHistoryStore.test.ts — 会话历史本地存储 + 删除墓碑
 *
 * 覆盖点：
 * 1. 增删改查基本行为（按 sessionId 覆写、按 updatedAt 降序）
 * 2. 删除会话会给该 id 立墓碑（`{key}::deleted`），供服务端播种时过滤
 * 3. 会话被重新 upsert 时墓碑自动撤销（同 id 又出现在历史里）
 * 4. 墓碑数据损坏（非数组 / 脏值）时退化为空集，不抛错
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadSessionHistory,
  saveSessionHistory,
  upsertSessionHistory,
  removeSessionHistoryEntry,
  loadDeletedSessionIds,
  markSessionDeleted,
  clearSessionDeleted,
  buildSessionHistoryKey,
  type SessionHistoryEntry,
} from './sessionHistoryStore';

/** vitest/jsdom 未注入全局 localStorage，这里给一份内存实现 */
const storage = new Map<string, string>();
function installStorage() {
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
}
installStorage();

const KEY = 'http://localhost:8082/admin/dev-assistant/test_project';

function entry(sessionId: string, updatedAt: number, title = sessionId): SessionHistoryEntry {
  return { sessionId, title, createdAt: updatedAt, updatedAt };
}

describe('sessionHistoryStore', () => {
  beforeEach(() => {
    storage.clear();
  });

  it('upsert 覆写同 id 并按更新时间降序', () => {
    upsertSessionHistory(KEY, entry('a', 100));
    upsertSessionHistory(KEY, entry('b', 300));
    const list = upsertSessionHistory(KEY, { ...entry('a', 200), title: '改名' });

    expect(list.map(e => e.sessionId)).toEqual(['b', 'a']);
    expect(list[1].title).toBe('改名');
    expect(loadSessionHistory(KEY).map(e => e.sessionId)).toEqual(['b', 'a']);
  });

  it('删除会话：列表移除 + 立墓碑', () => {
    saveSessionHistory(KEY, [entry('a', 100), entry('b', 200)]);

    const next = removeSessionHistoryEntry(KEY, 'b');

    expect(next.map(e => e.sessionId)).toEqual(['a']);
    expect(loadSessionHistory(KEY).map(e => e.sessionId)).toEqual(['a']);
    expect(Array.from(loadDeletedSessionIds(KEY))).toEqual(['b']);
  });

  it('删除不存在的会话：列表不变，仍然记墓碑（服务端可能还留着它）', () => {
    saveSessionHistory(KEY, [entry('a', 100)]);

    removeSessionHistoryEntry(KEY, 'ghost');

    expect(loadSessionHistory(KEY).map(e => e.sessionId)).toEqual(['a']);
    expect(loadDeletedSessionIds(KEY).has('ghost')).toBe(true);
  });

  it('会话重新 upsert 时撤销墓碑', () => {
    saveSessionHistory(KEY, [entry('a', 100)]);
    removeSessionHistoryEntry(KEY, 'a');
    expect(loadDeletedSessionIds(KEY).has('a')).toBe(true);

    upsertSessionHistory(KEY, entry('a', 500));

    expect(loadDeletedSessionIds(KEY).has('a')).toBe(false);
    expect(loadSessionHistory(KEY).map(e => e.sessionId)).toEqual(['a']);
  });

  it('墓碑幂等：重复标记只记录一次', () => {
    markSessionDeleted(KEY, 'a');
    markSessionDeleted(KEY, 'a');
    expect(Array.from(loadDeletedSessionIds(KEY))).toEqual(['a']);

    clearSessionDeleted(KEY, 'a');
    clearSessionDeleted(KEY, 'a');
    expect(loadDeletedSessionIds(KEY).size).toBe(0);
  });

  it('墓碑数据损坏时退化为空集，不影响列表读取', () => {
    localStorage.setItem(`${KEY}::deleted`, '{ 不是数组 }');
    expect(loadDeletedSessionIds(KEY).size).toBe(0);

    localStorage.setItem(`${KEY}::deleted`, JSON.stringify(['ok', 3, null, '']));
    expect(Array.from(loadDeletedSessionIds(KEY))).toEqual(['ok']);

    localStorage.setItem(KEY, '不是 JSON');
    expect(loadSessionHistory(KEY)).toEqual([]);
  });

  it('墓碑按维度 key 隔离（不同项目互不影响）', () => {
    const other = buildSessionHistoryKey({
      host: 'http://localhost:8082',
      username: 'admin',
      modelId: 'dev-assistant',
      projectId: 'test_project2',
    });
    markSessionDeleted(KEY, 'a');
    expect(loadDeletedSessionIds(KEY).has('a')).toBe(true);
    expect(loadDeletedSessionIds(other).size).toBe(0);
  });
});
