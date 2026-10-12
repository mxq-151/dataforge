/**
 * client/useFileReview.ts — 文件变更提取与审批（模块无关）
 *
 * 从消息里的 edit/write/apply_patch 工具调用中提取文件变更，并维护
 * 「已通过 / 已拒绝」状态集合（按 partID 标识，即每个工具调用独立审批）。
 * 审批状态按会话维度持久化在 fileReviewStore，重连/切会话后不丢。
 */

import { useCallback, useEffect, useState } from 'react';
import type { OpencodeClient } from '@opencode-ai/sdk/v2/client';
import * as fileReviewStore from '../fileReviewStore';
import type { FileChange, MessageEntry } from '../../../types/opencode-backend';

export interface UseFileReviewOptions {
  messages: MessageEntry[];
  currentSessionId: string | null;
  /** 当前 SDK 客户端（拒绝变更时调用 session.revert 回退文件） */
  client: OpencodeClient | null;
}

export interface UseFileReviewReturn {
  fileChanges: FileChange[];
  approveFileChange: (partID: string) => void;
  rejectFileChange: (
    filePath: string,
    change: { type: 'edit' | 'write' | 'apply_patch'; messageID?: string; partID?: string },
  ) => void | Promise<void>;
  approveAllFileChanges: () => void;
}

export function useFileReview(options: UseFileReviewOptions): UseFileReviewReturn {
  const { messages, currentSessionId, client } = options;

  const [fileChanges, setFileChanges] = useState<FileChange[]>([]);
  const [fileChangesApproved, setFileChangesApproved] = useState<Set<string>>(new Set());
  const [fileChangesRejected, setFileChangesRejected] = useState<Set<string>>(new Set());
  // 异步加载标记：Store 读取是异步的，加载完成前不触发 status 计算
  const [reviewStateLoaded, setReviewStateLoaded] = useState(false);

  /**
   * 从消息列表中提取文件变更，根据审批状态集合确定 status。
   *
   * 变更唯一键使用 partID（每个工具调用对应一个独立 part）：
   * - 同一文件在不同轮次的变更各自保留为独立条目，不会按 filePath 合并
   * - 审批状态绑定 partID，新轮次的变更不会继承旧轮次的"已通过/已拒绝"状态
   * - changeMap 按 partID 去重（同一 part 被多次更新时只保留最新状态）
   */
  const extractFileChangesFromMessages = useCallback((
    msgs: MessageEntry[],
    approved: Set<string>,
    rejected: Set<string>,
  ): FileChange[] => {
    const changeMap = new Map<string, FileChange>();
    const FILE_TOOLS = new Set(['edit', 'write', 'apply_patch']);

    for (const entry of msgs) {
      if (entry.info.role !== 'assistant') continue;
      for (const part of entry.parts) {
        if (part.type !== 'tool') continue;
        const toolPart = part as any;
        if (!FILE_TOOLS.has(toolPart.tool)) continue;

        const state = toolPart.state as any;
        const filePath = state?.input?.filePath
          || state?.metadata?.filediff?.file
          || '';
        if (!filePath) continue;

        // partID 是每个工具调用的全局唯一标识，用作变更唯一键
        const partID = (part as any).id || '';
        if (!partID) continue;

        const patch = state?.metadata?.filediff?.patch || '';
        let additions = 0;
        let deletions = 0;
        if (patch) {
          for (const line of patch.split('\n')) {
            if (line.startsWith('+') && !line.startsWith('+++')) additions++;
            if (line.startsWith('-') && !line.startsWith('---')) deletions++;
          }
        }

        const status: FileChange['status'] = rejected.has(partID) ? 'rejected'
          : approved.has(partID) ? 'approved'
          : 'pending';

        changeMap.set(partID, {
          filePath,
          patch: patch || undefined,
          additions,
          deletions,
          type: toolPart.tool,
          status,
          messageID: entry.info.id,
          partID,
        });
      }
    }
    return Array.from(changeMap.values());
  }, []);

  // session 变化时，从 Store 异步加载审批状态，然后提取文件变更
  useEffect(() => {
    if (!currentSessionId) {
      setFileChangesApproved(new Set());
      setFileChangesRejected(new Set());
      setFileChanges([]);
      setReviewStateLoaded(true);
      return;
    }

    let cancelled = false;
    setReviewStateLoaded(false);

    async function loadAndRefresh() {
      try {
        const sid = currentSessionId!;
        const [approvedArr, rejectedArr] = await Promise.all([
          fileReviewStore.load(sid, 'approved'),
          fileReviewStore.load(sid, 'rejected'),
        ]);
        if (cancelled) return;

        const approved = new Set<string>(approvedArr);
        const rejected = new Set<string>(rejectedArr);
        setFileChangesApproved(approved);
        setFileChangesRejected(rejected);
        setReviewStateLoaded(true);

        console.log(`[file-review] 从 Store 加载完成: approved=${approved.size}, rejected=${rejected.size}`);
      } catch (e) {
        console.warn('[file-review] Store 加载失败，使用空状态:', e);
        setFileChangesApproved(new Set());
        setFileChangesRejected(new Set());
        setReviewStateLoaded(true);
      }
    }

    loadAndRefresh();
    return () => { cancelled = true; };
  }, [currentSessionId]);

  // 审批状态加载完成后，消息变化时重新提取文件变更
  useEffect(() => {
    if (!reviewStateLoaded) return;
    const changes = extractFileChangesFromMessages(messages, fileChangesApproved, fileChangesRejected);
    setFileChanges(changes);
  }, [messages, fileChangesApproved, fileChangesRejected, reviewStateLoaded, extractFileChangesFromMessages]);

  const approveFileChange = useCallback((partID: string) => {
    const newApproved = new Set(fileChangesApproved);
    newApproved.add(partID);
    const newRejected = new Set(fileChangesRejected);
    newRejected.delete(partID);
    setFileChangesApproved(newApproved);
    setFileChangesRejected(newRejected);
    setFileChanges(extractFileChangesFromMessages(messages, newApproved, newRejected));
    const sid = currentSessionId;
    if (sid) {
      fileReviewStore.save(sid, 'approved', Array.from(newApproved));
      fileReviewStore.save(sid, 'rejected', Array.from(newRejected));
    }
  }, [fileChangesApproved, fileChangesRejected, messages, extractFileChangesFromMessages, currentSessionId]);

  const rejectFileChange = useCallback(async (filePath: string, change: { type: 'edit' | 'write' | 'apply_patch'; messageID?: string; partID?: string }) => {
    // 审批状态按 partID 追踪（每个工具调用独立审批，不继承同文件旧轮次的状态）
    const changeKey = change.partID || filePath;
    const newRejected = new Set(fileChangesRejected);
    newRejected.add(changeKey);
    const newApproved = new Set(fileChangesApproved);
    newApproved.delete(changeKey);
    setFileChangesRejected(newRejected);
    setFileChangesApproved(newApproved);
    setFileChanges(extractFileChangesFromMessages(messages, newApproved, newRejected));
    const sid = currentSessionId;
    if (sid) {
      fileReviewStore.save(sid, 'approved', Array.from(newApproved));
      fileReviewStore.save(sid, 'rejected', Array.from(newRejected));
    }
    // 通过 SDK session.revert API 回退文件，让「拒绝」真正撤销该部分对应的文件变更。
    // 这是通用实现（dev-assistant 在视图层另有覆盖，此处作为各智能体对话模块的兜底）。
    if (!client || !sid || !change.messageID) {
      // 无法通过 SDK 回退时（无 client / 无会话 / 无 messageID），仅更新审批状态，
      // 由视图层决定降级处理（如新建文件直接删除）。
      return;
    }
    try {
      await client.session.revert({
        sessionID: sid,
        messageID: change.messageID,
        partID: change.partID,
      });
    } catch (err) {
      console.warn('[agent] 拒绝文件变更回退失败:', err);
    }
  }, [fileChangesApproved, fileChangesRejected, messages, extractFileChangesFromMessages, currentSessionId, client]);

  const approveAllFileChanges = useCallback(() => {
    const newApproved = new Set(fileChangesApproved);
    for (const c of fileChanges) {
      if (c.partID) newApproved.add(c.partID);
    }
    const newRejected = new Set<string>();
    setFileChangesApproved(newApproved);
    setFileChangesRejected(newRejected);
    setFileChanges(extractFileChangesFromMessages(messages, newApproved, newRejected));
    const sid = currentSessionId;
    if (sid) {
      fileReviewStore.save(sid, 'approved', Array.from(newApproved));
      fileReviewStore.save(sid, 'rejected', Array.from(newRejected));
    }
  }, [fileChanges, fileChangesApproved, messages, extractFileChangesFromMessages, currentSessionId]);

  return { fileChanges, approveFileChange, rejectFileChange, approveAllFileChanges };
}
