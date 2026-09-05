/**
 * MessageTimeline — 虚拟化时间线主组件
 *
 * 对齐 opencode 桌面版 message-timeline.tsx（app 包，1569 行），
 * 适配 React + @tanstack/react-virtual（桌面版用 @tanstack/solid-virtual）。
 *
 * 核心机制：
 * - useTimelineProjection 计算行投影（11 种 TimelineRow）
 * - useVirtualizer 虚拟化渲染（estimateSize 60, overscan 50, paddingEnd 64）
 * - getItemKey 用 rowKey(row) 稳定 key
 * - measureElement 动态测量行高（流式内容尺寸变化）
 * - follow 逻辑：用户在底部 80px 内时自动跟随滚动
 * - renderRow switch 分发到各行渲染组件
 * - renderAssistantPartGroup：context group → ContextToolGroup，part group → MessagePart
 * - PartsDataProvider 包裹，透传 navigateToSession/sessionHref/readPartText
 *
 * 简化项（相对桌面版）：
 * - 无 resize pin 防跳变逻辑（用 measureElement 自动测量替代）
 * - 无 prepend 历史锚定（切换 session 时重新滚到底）
 * - 无 timelineCache 缓存（每次切换 session 重建）
 * - rangeExtractor 用默认（不强制保留 active turn 最后一行，靠 overscan 覆盖）
 */

import React, { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Part, Session, SessionStatus } from '@opencode-ai/sdk/v2/client';
import type { MessageEntry, ToolPart, AssistantMessage, RetryState, Todo, FileChange } from '../../../types/opencode-backend';
import { useTimelineProjection } from './useTimelineProjection';
import { rowKey, type TimelineRow, type AssistantPartRow } from './rows';
import TimelineRowFrame from './TimelineRowFrame';
import TimelineThinkingRow from './TimelineThinkingRow';
import TimelineErrorRow from './TimelineErrorRow';
import TimelineDiffSummaryRow from './TimelineDiffSummaryRow';
import TimelineRetryRow from './TimelineRetryRow';
import MessagePart from '../parts/MessagePart';
import ContextToolGroup from '../parts/ContextToolGroup';
import UserMessageDisplay from '../parts/UserMessageDisplay';
import MessageDivider from '../parts/MessageDivider';
import TodoDock from '../TodoDock';
import FileReviewPanel from '../FileReviewPanel';
import { PartsDataProvider } from '../parts/PartsDataContext';

// ── MessageTimelineProps ──────────────────────────────────────

/** 执行计划面板状态（来自 useTodoDockState，内联 TodoRow 渲染用） */
export interface TimelineTodoDockProps {
  /** dock 是否可见（4 态状态机控制） */
  visible: boolean;
  /** 是否折叠 */
  collapsed: boolean;
  /** 是否正在关闭中 */
  closing?: boolean;
  /** 切换折叠 */
  onToggle: () => void;
}

/** 文件变更面板回调（内联 FileChangeRow 渲染用） */
export interface TimelineFileReviewProps {
  onApprove?: (partID: string) => void;
  onReject?: (filePath: string, change: { type: 'edit' | 'write' | 'apply_patch'; messageID?: string; partID?: string }) => void;
  onApproveAll?: () => void;
  onOpenFile?: (filePath: string) => void;
  onViewDiff?: (filePath: string, patch: string) => void;
}

export interface MessageTimelineProps {
  /** 消息列表 */
  messages: MessageEntry[];
  /** 会话状态类型（'idle' | 'busy' | 'retry'），对齐 SDK v2 SessionStatus */
  status: SessionStatus['type'];
  /** retry 状态信息（status==='retry' 时用于渲染倒计时行） */
  retry?: RetryState | null;
  /** 是否显示 reasoning（默认 true） */
  showReasoning?: boolean;
  /** 读取 part 流式文本（优先 accumDelta 累积值） */
  readPartText?: (partID: string, part: Part) => string;
  /** 跳转到子 session（task 工具点击行为） */
  navigateToSession?: (sessionID: string) => void;
  /** 生成 session 链接（用于 triggerHref 新窗口） */
  sessionHref?: (sessionID: string) => string | undefined;
  /** 当前 session ID（task 工具回退匹配用） */
  currentSessionID?: string;
  /** 全部 session 列表（task 工具回退匹配用） */
  sessions?: Session[];
  /** 回滚到指定消息 */
  onRevert?: (messageID: string) => void;
  /** 回滚按钮禁用（busy 时） */
  revertDisabled?: boolean;
  /** 执行计划数据（内联 TodoRow 投影用） */
  todos?: Todo[];
  /** 执行计划面板状态（内联 TodoRow 渲染用） */
  todoDock?: TimelineTodoDockProps;
  /** 文件变更数据（内联 FileChangeRow 投影用） */
  fileChanges?: FileChange[];
  /** 文件变更面板回调（内联 FileChangeRow 渲染用） */
  fileReview?: TimelineFileReviewProps;
}

// ── MessageTimeline 组件 ─────────────────────────────────────

const MessageTimeline: React.FC<MessageTimelineProps> = ({
  messages,
  status,
  retry,
  showReasoning = true,
  readPartText,
  navigateToSession,
  sessionHref,
  currentSessionID,
  sessions,
  onRevert,
  revertDisabled,
  todos,
  todoDock,
  fileChanges,
  fileReview,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { rows } = useTimelineProjection(messages, status, showReasoning, todos, fileChanges);

  // entryByID 查找表：messageID → MessageEntry，把 renderRow / getMsgPart / assistantCopyPartID
  // 里的 O(n) 的 messages.find 都换成 O(1) 的 Map 索引，降低长会话下每次刷新的开销。
  const entryByID = useMemo(() => {
    const map = new Map<string, MessageEntry>();
    for (const entry of messages) map.set(entry.info.id, entry);
    return map;
  }, [messages]);

  // getMsgPart：根据 messageID + partID 查找 part（O(1) 索引 + 该消息 parts 内线性查找）
  const getMsgPart = useCallback(
    (messageID: string, partID: string): Part | undefined => {
      return entryByID.get(messageID)?.parts.find((p) => p.id === partID);
    },
    [entryByID],
  );

  // toolOpen 状态管理（受控展开/折叠）
  const [toolOpen, setToolOpen] = useState<Map<string, boolean>>(new Map());
  const handleToolOpenChange = useCallback((partID: string, open: boolean) => {
    setToolOpen((prev) => {
      const next = new Map(prev);
      next.set(partID, open);
      return next;
    });
  }, []);

  // assistantCopyPartID：每个 userMessage 对应最后一条 assistant 消息的首个非空 text part
  const assistantCopyPartID = useMemo(() => {
    const map = new Map<string, string | undefined>();
    const byParent = new Map<string, AssistantMessage[]>();
    for (const entry of messages) {
      if (entry.info.role !== 'assistant') continue;
      const am = entry.info as AssistantMessage;
      if (!am.parentID) continue;
      const list = byParent.get(am.parentID);
      if (list) list.push(am);
      else byParent.set(am.parentID, [am]);
    }
    for (const [parentID, list] of byParent) {
      const last = list[list.length - 1];
      const parts = entryByID.get(last.id)?.parts ?? [];
      const textPart = [...parts]
        .reverse()
        .find((p) => p.type === 'text' && ((p as any).text?.trim()));
      map.set(parentID, textPart?.id);
    }
    return map;
  }, [messages, entryByID]);

  // partDefaultOpen：所有 tool 执行参数与结果默认折叠
  // 不区分状态/是否有输出，统一收起；用户点击 trigger 后展开（展开状态由 toolOpen 记忆）
  const partDefaultOpen = useCallback((_part: Part): boolean => {
    return false;
  }, []);

  // follow 逻辑：用户在底部 80px 内时标记 atBottom
  const [atBottom, setAtBottom] = useState(true);
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAtBottom(distance < 80);
  }, []);

  // 虚拟化器
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 60,
    // overscan 8：仅预渲染视口外 8 行。原先 50 在 React 下会渲染过多离屏组件，
    // 导致滚动和流式更新时 CPU 飙升（SolidJS 桌面版用 50 因其渲染开销更低）。
    overscan: 8,
    paddingEnd: 64,
    getItemKey: (index) => rowKey(rows[index]),
  });

  // 追加行时若用户在底部则跟随滚动（滚到最底部，保持最新内容可见）
  const prevCountRef = useRef(rows.length);
  useEffect(() => {
    if (rows.length > prevCountRef.current && atBottom) {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
    prevCountRef.current = rows.length;
  }, [rows.length, atBottom]);

  // 渲染 AssistantPart 的 group（context group 或 part group）
  const renderAssistantPartGroup = useCallback(
    (row: AssistantPartRow) => {
      const group = row.group;
      if (group.type === 'context') {
        const parts = group.refs
          .map((ref) => getMsgPart(ref.messageID, ref.partID))
          .filter((p): p is ToolPart => p?.type === 'tool');
        return <ContextToolGroup parts={parts} />;
      }
      // part group
      const entry = entryByID.get(group.ref.messageID);
      const message = entry?.info;
      const part = getMsgPart(group.ref.messageID, group.ref.partID);
      if (!message || !part) return null;
      const copyID = assistantCopyPartID.get(row.userMessageID);
      const defaultOpen = partDefaultOpen(part);
      return (
        <MessagePart
          part={part}
          message={message}
          defaultOpen={defaultOpen}
          toolOpen={toolOpen.get(part.id) ?? defaultOpen}
          onToolOpenChange={(open: boolean) => handleToolOpenChange(part.id, open)}
          showAssistantCopyPartID={copyID}
        />
      );
    },
    [getMsgPart, entryByID, assistantCopyPartID, partDefaultOpen, toolOpen, handleToolOpenChange],
  );

  // 渲染单行（switch 分发）
  const renderRow = useCallback(
    (row: TimelineRow) => {
      switch (row._tag) {
        case 'TurnGap':
          return <div className="ai-panel__timeline-turn-gap" aria-hidden="true" />;
        case 'CommentStrip':
          // comment 元数据暂不支持，渲染空占位
          return null;
        case 'UserMessage': {
          const entry = entryByID.get(row.userMessageID);
          if (!entry) return null;
          const message = entry.info as any;
          const text = entry.parts
            .filter((p) => p.type === 'text')
            .map((p) => (p as any).text ?? '')
            .join('\n');
          return (
            <TimelineRowFrame row={row}>
              <UserMessageDisplay
                message={message}
                text={text}
                onRevert={onRevert ? () => onRevert(row.userMessageID) : undefined}
                revertDisabled={revertDisabled}
              />
            </TimelineRowFrame>
          );
        }
        case 'TurnDivider':
          return (
            <TimelineRowFrame row={row}>
              <MessageDivider label={row.label} />
            </TimelineRowFrame>
          );
        case 'AssistantPart':
          return (
            <TimelineRowFrame row={row}>
              <div className="ai-panel__timeline-assistant-content">
                {renderAssistantPartGroup(row)}
              </div>
            </TimelineRowFrame>
          );
        case 'Thinking':
          return (
            <TimelineRowFrame row={row}>
              <TimelineThinkingRow reasoningHeading={row.reasoningHeading} />
            </TimelineRowFrame>
          );
        case 'Retry':
          return (
            <TimelineRowFrame row={row}>
              <TimelineRetryRow retry={retry ?? null} />
            </TimelineRowFrame>
          );
        case 'DiffSummary':
          return (
            <TimelineRowFrame row={row}>
              <TimelineDiffSummaryRow diffs={row.diffs} />
            </TimelineRowFrame>
          );
        case 'Error':
          return (
            <TimelineRowFrame row={row}>
              <TimelineErrorRow text={row.text} />
            </TimelineRowFrame>
          );
        case 'Todo':
          // dock 状态机未开启时隐藏（如 session 切换的短暂窗口）
          if (!todoDock?.visible) return null;
          return (
            <TimelineRowFrame row={row}>
              <TodoDock
                todos={row.todos}
                collapsed={todoDock.collapsed}
                onToggle={todoDock.onToggle}
                closing={todoDock.closing}
              />
            </TimelineRowFrame>
          );
        case 'FileChange':
          return (
            <TimelineRowFrame row={row}>
              <FileReviewPanel
                changes={row.changes}
                onApprove={fileReview?.onApprove}
                onReject={fileReview?.onReject}
                onApproveAll={fileReview?.onApproveAll}
                onOpenFile={fileReview?.onOpenFile}
                onViewDiff={fileReview?.onViewDiff}
              />
            </TimelineRowFrame>
          );
        default:
          return null;
      }
    },
    [entryByID, onRevert, revertDisabled, renderAssistantPartGroup, retry, todoDock, fileReview],
  );

  // PartsDataProvider 值（透传导航和流式文本读取）
  const partsDataValue = useMemo(
    () => ({ navigateToSession, sessionHref, currentSessionID, sessions, readPartText }),
    [navigateToSession, sessionHref, currentSessionID, sessions, readPartText],
  );

  // 空状态
  if (rows.length === 0) {
    return (
      <PartsDataProvider {...partsDataValue}>
        <div
          className="ai-panel__timeline ai-panel__timeline--empty"
          ref={scrollRef}
          style={{ overflowY: 'auto', contain: 'layout paint' }}
        >
          <div className="ai-panel__timeline-empty">暂无消息</div>
        </div>
      </PartsDataProvider>
    );
  }

  return (
    <PartsDataProvider {...partsDataValue}>
      <div
        className="ai-panel__timeline"
        ref={scrollRef}
        onScroll={handleScroll}
        style={{ overflowY: 'auto', contain: 'layout paint' }}
      >
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const row = rows[virtualItem.index];
            if (!row) return null;
            return (
              <div
                key={virtualItem.key}
                data-index={virtualItem.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualItem.start}px)`,
                }}
              >
                {renderRow(row)}
              </div>
            );
          })}
        </div>
      </div>
    </PartsDataProvider>
  );
};

export default React.memo(MessageTimeline);
