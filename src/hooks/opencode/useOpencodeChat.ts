/**
 * useOpencodeChat — 消息发送与对话控制
 */

import { useCallback } from 'react';
import type { OpencodeClient } from '@opencode-ai/sdk/v2/client';
import { getDeveloperInstructions } from './opencodeInstructions';
import type { LogEntry } from '../../types/opencode-backend';

export interface UseOpencodeChatOptions {
  username?: string;
  moduleId?: string;
  roleType?: string;
  currentSessionId: string | null;
  setCurrentSessionId: (id: string | null) => void;
  /**
   * 日志上报函数：用于将对话控制中的错误（中断失败、回滚失败等）上报到 UI 日志面板，
   * 而非仅 console.error。用户在 UI 上能看到明确的错误提示。
   */
  addLog?: (entry: LogEntry) => void;
}

export interface UseOpencodeChatReturn {
  sendMessage: (client: OpencodeClient | null, line: string, existingSessionId?: string | null, model?: { providerID: string; modelID: string }) => Promise<string | null>;
  sendInterrupt: (client: OpencodeClient | null) => Promise<void>;
  sendRollback: (client: OpencodeClient | null, messageId: string) => Promise<{ success: boolean }>;
  sendPermissionResponse: (client: OpencodeClient | null, requestId: string, response: 'once' | 'always' | 'reject') => void;
  /** 回复提问请求（client.question.reply） */
  sendQuestionReply: (client: OpencodeClient | null, requestId: string, answers: string[][]) => void;
  /** 拒绝提问请求（client.question.reject） */
  sendQuestionReject: (client: OpencodeClient | null, requestId: string) => void;
  /**
   * 调用 OpenCode session.summarize 压缩当前会话的历史消息。
   * 服务端会生成摘要并替换原历史，对应的 session.compacted 事件会推送回前端。
   */
  sendSummarize: (client: OpencodeClient | null, options?: { providerID?: string; modelID?: string }) => Promise<{ success: boolean }>;
}

export function useOpencodeChat(options: UseOpencodeChatOptions): UseOpencodeChatReturn {
  const { username, moduleId, roleType, currentSessionId, setCurrentSessionId, addLog } = options;

  /** 上报错误到 UI 日志面板（如果 addLog 可用）+ console.error */
  const reportError = useCallback((label: string, err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[useOpencodeChat] ${label}:`, err);
    if (addLog) {
      addLog({
        source: 'opencode',
        text: `${label}: ${msg}`,
        timestamp: new Date(),
        level: 'error',
      });
    }
  }, [addLog]);

  /**
   * 发送用户消息
   * @param existingSessionId 如果已提前创建了 session，传入 ID 可跳过创建步骤
   * @param model 可选，指定本次对话使用的模型（覆盖服务端默认配置）
   * @returns sessionId（可能是新创建的），用于调用方保存任务记录
   */
  const sendMessage = useCallback(async (
    client: OpencodeClient | null,
    line: string,
    existingSessionId?: string | null,
    model?: { providerID: string; modelID: string }
  ): Promise<string | null> => {
    if (!client) return null;

    const systemInstructions = getDeveloperInstructions(roleType ?? '', username ?? '', moduleId ?? '');

    // 如果没有 session，先创建一个
    let sessionId = existingSessionId || currentSessionId;
    if (!sessionId) {
      try {
        const result = await client.session.create({
          title: line.slice(0, 80),
        });
        if (result.data) {
          sessionId = result.data.id;
          setCurrentSessionId(sessionId);
        } else {
          throw new Error('Failed to create session: empty response');
        }
      } catch (err) {
        console.error('[useOpencodeChat] Failed to create session:', err);
        throw err;
      }
    }

    // 发送 prompt（v2 SDK 参数扁平化：sessionID/parts/system/model 直传）
    try {
      await client.session.prompt({
        sessionID: sessionId!,
        parts: [{ type: 'text', text: line }],
        ...(systemInstructions ? { system: systemInstructions } : {}),
        ...(model ? { model } : {}),
      });
    } catch (err) {
      console.error('[useOpencodeChat] Failed to send prompt:', err);
      throw err;
    }

    return sessionId || null;
  }, [username, moduleId, roleType, currentSessionId, setCurrentSessionId]);

  /**
   * 中断当前对话
   */
  const sendInterrupt = useCallback(async (client: OpencodeClient | null) => {
    if (!client || !currentSessionId) return;
    try {
      await client.session.abort({ sessionID: currentSessionId });
    } catch (err) {
      reportError('中断对话失败', err);
    }
  }, [currentSessionId, reportError]);

  /**
   * 回滚到指定消息
   */
  const sendRollback = useCallback(async (
    client: OpencodeClient | null,
    messageId: string
  ): Promise<{ success: boolean }> => {
    if (!client || !currentSessionId) return { success: false };
    try {
      await client.session.revert({
        sessionID: currentSessionId,
        messageID: messageId,
      });
      return { success: true };
    } catch (err) {
      reportError('回滚消息失败', err);
      return { success: false };
    }
  }, [currentSessionId, reportError]);

  /**
   * 响应权限请求
   *
   * v2 SDK 使用 client.permission.reply({ requestID, reply }) 全局权限响应 API。
   * requestID 直接来自 permission.asked 事件的 properties.id（纯 ID，无 sessionID 前缀）。
   */
  const sendPermissionResponse = useCallback((
    client: OpencodeClient | null,
    requestId: string,
    response: 'once' | 'always' | 'reject'
  ) => {
    if (!client) return;
    try {
      client.permission.reply({
        requestID: requestId,
        reply: response,
      });
    } catch (err) {
      reportError('权限响应失败', err);
    }
  }, [reportError]);

  /**
   * 回复提问请求
   *
   * v2 SDK 使用 client.question.reply({ requestID, answers }) API。
   * answers 是 string[][]，每个元素对应一个 question 的选中项数组（多 question 时按序对应）。
   */
  const sendQuestionReply = useCallback((
    client: OpencodeClient | null,
    requestId: string,
    answers: string[][],
  ) => {
    if (!client) return;
    try {
      client.question.reply({ requestID: requestId, answers });
    } catch (err) {
      reportError('回复提问失败', err);
    }
  }, [reportError]);

  /**
   * 拒绝提问请求
   *
   * v2 SDK 使用 client.question.reject({ requestID }) API。
   */
  const sendQuestionReject = useCallback((client: OpencodeClient | null, requestId: string) => {
    if (!client) return;
    try {
      client.question.reject({ requestID: requestId });
    } catch (err) {
      reportError('拒绝提问失败', err);
    }
  }, [reportError]);

  /**
   * 压缩当前会话的历史消息。
   * 调用 OpenCode session.summarize API，服务端会生成摘要并替换原历史。
   * 对应服务端事件：session.compacted（推送完成后会重新推送 message.updated 列表）。
   *
   * @param options.providerID 可选，压缩使用的 provider（默认沿用会话模型）
   * @param options.modelID 可选，压缩使用的 model
   */
  const sendSummarize = useCallback(async (
    client: OpencodeClient | null,
    options?: { providerID?: string; modelID?: string }
  ): Promise<{ success: boolean }> => {
    if (!client || !currentSessionId) {
      console.warn('[useOpencodeChat] sendSummarize skipped: client or sessionId missing');
      return { success: false };
    }
    try {
      await client.session.summarize({
        sessionID: currentSessionId,
        ...(options?.providerID ? { providerID: options.providerID } : {}),
        ...(options?.modelID ? { modelID: options.modelID } : {}),
      });
      return { success: true };
    } catch (err) {
      reportError('压缩会话失败', err);
      return { success: false };
    }
  }, [currentSessionId, reportError]);

  return {
    sendMessage,
    sendInterrupt,
    sendRollback,
    sendPermissionResponse,
    sendQuestionReply,
    sendQuestionReject,
    sendSummarize,
  };
}
