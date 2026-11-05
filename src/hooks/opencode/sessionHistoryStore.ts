/**
 * sessionHistoryStore — OpenCode 会话历史本地持久化
 *
 * key 格式: {backend_host}/{user}/{model_id}/{project_id}
 * value: 会话列表数组，每项 { sessionId, title, createdAt, updatedAt }。
 *
 * 与依赖服务端 session.list() 的方案相比，本地存储能确保会话历史在
 * （后端 session.list 可能为空 / 会话分散在按目录隔离的工作区）时也能可靠恢复。
 */
import { getApiHost } from '../../session';

/** 一条会话历史记录（title / createdAt / sessionId 为必要字段，updatedAt 供时间显示与排序） */
export interface SessionHistoryEntry {
  /** OpenCode session ID */
  sessionId: string;
  /** 任务标题 */
  title: string;
  /** 创建时间戳（ms） */
  createdAt: number;
  /** 最后更新时间戳（ms） */
  updatedAt: number;
}

/**
 * 按「后端host / 用户 / 模型 / 项目」四维隔离构建存储 key。
 * host 未显式传入时取自当前全局 apiHost。
 */
export function buildSessionHistoryKey(opts: {
  host?: string;
  username?: string;
  modelId?: string;
  projectId?: string;
}): string {
  const host = opts.host || getApiHost() || '';
  const user = opts.username || 'unknown-user';
  const modelId = opts.modelId || 'unknown-model';
  const projectId = opts.projectId || '';
  return `${host}/${user}/${modelId}/${projectId}`;
}

/** 读取会话历史（解析失败或非数组时返回 []，并保证按更新时间降序） */
export function loadSessionHistory(key: string): SessionHistoryEntry[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return (arr as SessionHistoryEntry[])
      .filter((e): e is SessionHistoryEntry => !!e && typeof e.sessionId === 'string')
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  } catch {
    return [];
  }
}

/** 全量保存会话历史 */
export function saveSessionHistory(key: string, list: SessionHistoryEntry[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    // localStorage 不可用或超限时静默忽略
  }
}

// ── 墓碑（已删除会话）─────────────────────────────────────────
//
// 任务列表的唯一事实来源是本地历史，但服务端仍可能在「本地为空」时回填会话
// （refreshTasks 的回退播种：新建会话前的老数据、按目录隔离的 data-explore 会话、
// 以及删除请求失败/挂起时服务端根本没删掉的会话）。若不做记录，被删掉的会话
// 会在下一次播种时复活，用户看到的就是「删了又回来 / 这条删不掉」。
//
// 墓碑按同一维度 key 单独存放（`{key}::deleted`），只记录 sessionId；
// 会话被重新 upsert（例如同 id 又被使用）时自动清除该墓碑。

/** 墓碑存储 key：与历史列表同维度，但独立一项，避免污染列表结构 */
function deletedIdsKey(key: string): string {
  return `${key}::deleted`;
}

/** 墓碑容量上限（超出后丢弃最早的记录，避免无限增长） */
const MAX_TOMBSTONES = 500;

/** 读取被显式删除的会话 id 集合（解析失败/非数组时返回空集） */
export function loadDeletedSessionIds(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(deletedIdsKey(key));
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === 'string' && x !== ''));
  } catch {
    return new Set();
  }
}

function saveDeletedSessionIds(key: string, ids: string[]): void {
  try {
    localStorage.setItem(deletedIdsKey(key), JSON.stringify(ids.slice(-MAX_TOMBSTONES)));
  } catch {
    // localStorage 不可用时静默忽略：墓碑失效只会让回填多出已删会话，不影响本地删除
  }
}

/** 为被删除的会话立墓碑（幂等） */
export function markSessionDeleted(key: string, sessionId: string): void {
  if (!sessionId) return;
  const ids = loadDeletedSessionIds(key);
  if (ids.has(sessionId)) return;
  ids.add(sessionId);
  saveDeletedSessionIds(key, Array.from(ids));
}

/** 清除墓碑（会话被重新创建/写入本地历史时调用） */
export function clearSessionDeleted(key: string, sessionId: string): void {
  const ids = loadDeletedSessionIds(key);
  if (!ids.delete(sessionId)) return;
  saveDeletedSessionIds(key, Array.from(ids));
}

/**
 * 新增或更新会话（按 sessionId 覆写）。
 * 返回更新后的列表（若与当前 key 列表无关仍会写入本地）。
 */
export function upsertSessionHistory(key: string, entry: SessionHistoryEntry): SessionHistoryEntry[] {
  const list = loadSessionHistory(key).filter(e => e.sessionId !== entry.sessionId);
  list.push(entry);
  const next = list.sort((a, b) => b.updatedAt - a.updatedAt);
  saveSessionHistory(key, next);
  // 该会话重新出现在本地历史里 ⇒ 撤销墓碑，避免后续播种时被误过滤
  clearSessionDeleted(key, entry.sessionId);
  return next;
}

/**
 * 删除指定会话，返回更新后的列表。
 * 同时给该 sessionId 立墓碑：本地删除是最终结果，后续服务端播种不得复活它。
 */
export function removeSessionHistoryEntry(key: string, sessionId: string): SessionHistoryEntry[] {
  const next = loadSessionHistory(key).filter(e => e.sessionId !== sessionId);
  saveSessionHistory(key, next);
  markSessionDeleted(key, sessionId);
  return next;
}