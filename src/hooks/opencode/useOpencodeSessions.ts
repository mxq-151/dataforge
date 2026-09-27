/**
 * useOpencodeSessions — OpenCode 会话管理
 *
 * 参考 OpenCode 官方 app 的实现（packages/app/src/context/directory-sync.ts）：
 * session.messages API 支持游标分页（before 参数 + x-next-cursor 响应头），
 * 默认每页 50 条。需要循环加载直到游标为空才能获取完整历史消息。
 */

import { useState, useCallback } from 'react';
import type { OpencodeClient, Session } from '@opencode-ai/sdk/v2/client';
import type { MessageEntry } from '../../types/opencode-backend';

export interface UseOpencodeSessionsReturn {
  currentSessionId: string | null;
  setCurrentSessionId: (id: string | null) => void;
  /**
   * 当前加载会话是否为「子代理会话」（opencode 会话树里带 parentID 的子会话）。
   *
   * 子代理会话的首条 user 消息是主会话发起 task 时注入的任务 prompt，
   * 并非用户输入；时间线据此把它标注为「子代理任务」而不是「用户」。
   * 值由 loadSession 读取 session.get 的 parentID 得出，新建/断开/删除会话时重置。
   */
  currentSessionParentID: string | null;
  setCurrentSessionParentID: (id: string | null) => void;
  newSession: (client: OpencodeClient | null) => Promise<string | null>;
  loadSession: (client: OpencodeClient | null, sessionId: string) => Promise<MessageEntry[]>;
  listSessions: (client: OpencodeClient | null) => Promise<Session[]>;
  deleteSession: (client: OpencodeClient | null, sessionId: string) => Promise<void>;
  /** 获取子会话列表（用于 subagent 内联展开加载子 session） */
  getSessionChildren: (client: OpencodeClient | null, sessionId: string) => Promise<Session[]>;
}

/**
 * 服务端 session.messages API 的 limit 参数上限为 200（packages/server/src/groups/message.ts:10）。
 * 但官方 app 默认每页 80 条，历史加载 200 条。为兼容新版/旧版服务端，设为保守值。
 */
const MESSAGE_PAGE_SIZE = 200;

export function useOpencodeSessions(): UseOpencodeSessionsReturn {
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [currentSessionParentID, setCurrentSessionParentID] = useState<string | null>(null);

  const newSession = useCallback(async (client: OpencodeClient | null): Promise<string | null> => {
    if (!client) return null;
    try {
      const result = await client.session.create({
        title: '',
      });
      if (result.data) {
        setCurrentSessionId(result.data.id);
        setCurrentSessionParentID(null);
        return result.data.id;
      }
      return null;
    } catch (err) {
      console.error('[useOpencodeSessions] newSession error:', err);
      return null;
    }
  }, []);

  /**
   * 加载会话的全部历史消息。
   *
   * 借鉴 OpenCode 官方 app 的游标分页机制：
   * 1. 调用 session.messages({ sessionID, limit, before }) 获取消息页
   * 2. 从 HTTP 响应头 x-next-cursor 获取下一页游标
   * 3. 循环加载直到游标为空（所有消息已加载完毕）
   *
   * v2 SDK 的 messages 参数已扁平化：sessionID/limit/before 直传，无需 path/query 包裹。
   */
  const loadSession = useCallback(async (
    client: OpencodeClient | null,
    sessionId: string
  ): Promise<MessageEntry[]> => {
    if (!client) return [];
    try {
      // 获取 session 元信息（同时取出 parentID：带 parentID 表示这是子代理会话，
      // 其首条 user 消息是主会话注入的任务 prompt，前端需改标展示）
      const sessionResult = await client.session.get({ sessionID: sessionId });
      setCurrentSessionId(sessionId);
      setCurrentSessionParentID(sessionResult.data?.parentID ?? null);

      const allEntries: MessageEntry[] = [];
      let cursor: string | undefined = undefined;
      let pageNum = 0;
      const maxPages = 50; // 安全上限：最多加载 50 页 = 10000 条消息

      while (pageNum < maxPages) {
        const messagesParams: { sessionID: string; limit: number; before?: string } = {
          sessionID: sessionId,
          limit: MESSAGE_PAGE_SIZE,
        };
        if (cursor) messagesParams.before = cursor;
        const result = await client.session.messages(messagesParams);

        // 数据在 result.data 中（HeyApiClient 自动解包）
        const page: MessageEntry[] = Array.isArray(result.data) ? result.data : [];
        allEntries.push(...page);

        // 检查下一页游标（参考 OpenCode app 的 directory-sync.ts:307）
        const nextCursor: string | undefined =
          result.response?.headers?.get("x-next-cursor") ?? undefined;

        if (!nextCursor) break; // 所有消息已加载完毕

        cursor = nextCursor;
        pageNum++;
      }

      return allEntries;
    } catch (err) {
      console.error('[useOpencodeSessions] loadSession error:', err);
      return [];
    }
  }, []);

  const listSessions = useCallback(async (client: OpencodeClient | null): Promise<Session[]> => {
    if (!client) return [];
    try {
      const result = await client.session.list({});
      if (result.data) {
        return result.data;
      }
      return [];
    } catch (err) {
      console.error('[useOpencodeSessions] listSessions error:', err);
      return [];
    }
  }, []);

  const deleteSession = useCallback(async (client: OpencodeClient | null, sessionId: string) => {
    if (!client) return;
    try {
      await client.session.delete({ sessionID: sessionId });
      if (currentSessionId === sessionId) {
        setCurrentSessionId(null);
        setCurrentSessionParentID(null);
      }
    } catch (err) {
      console.error('[useOpencodeSessions] deleteSession error:', err);
    }
  }, [currentSessionId]);

  /**
   * 获取子会话列表（用于 subagent 内联展开加载子 session）。
   * v2 SDK 的 session.children 返回从父 session fork 出的所有子 session。
   */
  const getSessionChildren = useCallback(async (
    client: OpencodeClient | null,
    sessionId: string
  ): Promise<Session[]> => {
    if (!client) return [];
    try {
      const result = await client.session.children({ sessionID: sessionId });
      if (result.data) {
        return result.data;
      }
      return [];
    } catch (err) {
      console.error('[useOpencodeSessions] getSessionChildren error:', err);
      return [];
    }
  }, []);

  return {
    currentSessionId,
    setCurrentSessionId,
    currentSessionParentID,
    setCurrentSessionParentID,
    newSession,
    loadSession,
    listSessions,
    deleteSession,
    getSessionChildren,
  };
}
