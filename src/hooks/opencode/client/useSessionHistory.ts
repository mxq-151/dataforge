/**
 * client/useSessionHistory.ts — 任务历史（模块无关）
 *
 * 任务列表的唯一事实来源是**本地会话历史**（localStorage，按 host/user/module/project
 * 四维隔离）。服务端 session.list() 只在「本地为空且该 key 从未播种过」时用于回填，
 * 且回填前必须剔除已删除会话（墓碑），否则被删掉的会话会复活成「删不掉的那一行」。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { OpencodeClient, Session } from '@opencode-ai/sdk/v2/client';
import {
  buildSessionHistoryKey,
  loadDeletedSessionIds,
  loadSessionHistory,
  removeSessionHistoryEntry,
  saveSessionHistory,
  upsertSessionHistory,
} from '../sessionHistoryStore';
import type { LogEntry } from '../../../types/opencode-backend';
import type { TaskRecord } from './types';

export interface UseSessionHistoryOptions {
  username?: string;
  moduleId?: string;
  projectId?: string;
  clientRef: MutableRefObject<OpencodeClient | null>;
  listSessions: (client: OpencodeClient | null) => Promise<Session[]>;
  addLog: (entry: LogEntry) => void;
}

export interface UseSessionHistoryReturn {
  tasks: TaskRecord[];
  setTasks: Dispatch<SetStateAction<TaskRecord[]>>;
  /** 清空任务列表（断开连接时调用） */
  clearTasks: () => void;
  /** 会话历史存储 key：{host}/{user}/{module}/{project} */
  sessionHistoryKey: string;
  refreshTasks: () => Promise<void>;
  /** 新增/更新一条本地历史（新建会话后调用） */
  upsertTask: (sessionId: string, title: string) => void;
  /** 本地删除一条历史并立墓碑（返回后本地列表已更新） */
  removeTask: (sessionId: string) => void;
  /** 就地重命名（乐观更新 + 持久化） */
  updateTaskTitleLocal: (sessionId: string, title: string) => void;
}

export function useSessionHistory(options: UseSessionHistoryOptions): UseSessionHistoryReturn {
  const { username, moduleId, projectId, clientRef, listSessions, addLog } = options;

  const [tasks, setTasks] = useState<TaskRecord[]>([]);

  // 会话历史存储 key：{backend_host}/{user}/{model_id}/{project_id}
  // model_id 为模块标识（数据探索=data-explore / 开发助手=dev-assistant），host 由
  // buildSessionHistoryKey 内部从当前全局 apiHost 读取
  const sessionHistoryKey = useMemo(
    () => buildSessionHistoryKey({ username, modelId: moduleId, projectId }),
    [username, moduleId, projectId],
  );

  // 已从服务端做过初始播种的存储 key：本地被清空（如删除全部会话）后不再从
  // 服务端回填，避免把已删除但服务端仍存在（尤其 data-explore 按目录隔离）的会话复活。
  const seededHistoryKeysRef = useRef<Set<string>>(new Set());

  /** 从 SDK Session[] 映射为 TaskRecord[] */
  const mapSessionsToTasks = useCallback((sessions: any[]): TaskRecord[] => {
    return sessions.map(s => ({
      sessionId: s.id,
      title: s.title || '新对话',
      createdAt: s.time?.created ?? 0,
      updatedAt: s.time?.updated ?? 0,
    })).sort((a, b) => b.updatedAt - a.updatedAt); // 按更新时间降序
  }, []);

  /** 刷新任务列表：优先读取本地会话历史；仅当本地为空且该 key 尚未播种时才回退服务端 */
  const refreshTasks = useCallback(async () => {
    const key = sessionHistoryKey;
    const local = loadSessionHistory(key);
    if (local.length > 0) {
      setTasks(local);
      return;
    }
    // 本地为空：若该 key 已播种过（曾真实出现过历史），一律视为「已删空/无历史」，
    // 不再回退服务端，防止复用已删除会话。
    if (seededHistoryKeysRef.current.has(key)) {
      setTasks([]);
      return;
    }
    const c = clientRef.current;
    if (!c) return;
    try {
      const sessions = await listSessions(c);
      // 播种前先剔除「被用户删除过」的会话：本地删除是最终结果，服务端可能仍持有
      // 该会话（删除请求失败/挂起，或该会话属于别的目录），不能把它们放回列表。
      const deletedIds = loadDeletedSessionIds(key);
      const mapped = mapSessionsToTasks(sessions).filter(t => !deletedIds.has(t.sessionId));
      setTasks(mapped);
      saveSessionHistory(key, mapped);
      seededHistoryKeysRef.current.add(key);
    } catch (err) {
      addLog({ source: 'agent', text: `刷新任务列表失败: ${err instanceof Error ? err.message : String(err)}`, timestamp: new Date(), level: 'warn' });
    }
  }, [sessionHistoryKey, clientRef, listSessions, mapSessionsToTasks, addLog]);

  // 存储 key（模型/host/用户/项目变化）变化时重新加载对应维度的会话历史
  useEffect(() => {
    refreshTasks();
  }, [sessionHistoryKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const clearTasks = useCallback(() => setTasks([]), []);

  const upsertTask = useCallback((sessionId: string, title: string) => {
    const now = Date.now();
    setTasks(upsertSessionHistory(sessionHistoryKey, {
      sessionId,
      title,
      createdAt: now,
      updatedAt: now,
    }));
  }, [sessionHistoryKey]);

  /**
   * 删除指定会话的本地记录并立即生效（含墓碑）。
   * 任务列表的唯一事实来源是本地历史，所以这一步不做任何 await。
   */
  const removeTask = useCallback((sessionId: string) => {
    setTasks(removeSessionHistoryEntry(sessionHistoryKey, sessionId));
  }, [sessionHistoryKey]);

  const updateTaskTitleLocal = useCallback((sessionId: string, title: string) => {
    setTasks(prev => {
      const next = prev.map(t =>
        t.sessionId === sessionId ? { ...t, title, updatedAt: Date.now() } : t
      );
      saveSessionHistory(sessionHistoryKey, next);
      return next;
    });
  }, [sessionHistoryKey]);

  return {
    tasks,
    setTasks,
    clearTasks,
    sessionHistoryKey,
    refreshTasks,
    upsertTask,
    removeTask,
    updateTaskTitleLocal,
  };
}
