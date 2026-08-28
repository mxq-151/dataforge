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

/**
 * 新增或更新会话（按 sessionId 覆写）。
 * 返回更新后的列表（若与当前 key 列表无关仍会写入本地）。
 */
export function upsertSessionHistory(key: string, entry: SessionHistoryEntry): SessionHistoryEntry[] {
  const list = loadSessionHistory(key).filter(e => e.sessionId !== entry.sessionId);
  list.push(entry);
  const next = list.sort((a, b) => b.updatedAt - a.updatedAt);
  saveSessionHistory(key, next);
  return next;
}

/** 删除指定会话，返回更新后的列表 */
export function removeSessionHistoryEntry(key: string, sessionId: string): SessionHistoryEntry[] {
  const next = loadSessionHistory(key).filter(e => e.sessionId !== sessionId);
  saveSessionHistory(key, next);
  return next;
}