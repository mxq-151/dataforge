/**
 * projection.ts — turn-based 行投影逻辑
 *
 * 对齐 opencode 桌面版 projection.ts + rows.ts 的 constructMessageRows，
 * 适配 React + TypeScript（不使用 effect/SolidJS）。
 *
 * 核心函数：
 * - constructMessageRows: 将一个 user message turn 展平为 TimelineRow[]
 * - groupParts: 合并连续 read/glob/grep/list 为 context 组
 * - renderable: 过滤不可渲染的 part
 * - reuseTimelineRows: 引用复用优化
 * - reasoningHeading: 提取 reasoning 首个标题
 * - assistantMessagesByParent: 按 parentID 分组 assistant 消息
 * - activeMessageID: 找当前活跃 turn 的 user message ID
 */

import type { Part, SessionStatus, SnapshotFileDiff, UserMessage, AssistantMessage } from '@opencode-ai/sdk/v2/client';
import type { MessageEntry } from '../../../types/opencode-backend';
import {
  TimelineRow,
  rowKey,
  rowEquals,
  type TimelineRow as TimelineRowType,
  type SummaryDiff,
  type PartRef,
  type PartGroup,
} from './rows';

// PartRef / PartGroup 已迁至 rows.ts（消除两文件的循环依赖），此处 re-export 保持兼容
export type { PartRef, PartGroup };

// ── 常量 ──────────────────────────────────────────────────────

const CONTEXT_GROUP_TOOLS = new Set(['read', 'glob', 'grep', 'list']);
const HIDDEN_TOOLS = new Set(['todowrite']);

// ── groupParts: 合并连续 read/glob/grep/list 为 context 组 ─────

export function groupParts(parts: { messageID: string; part: Part }[]): PartGroup[] {
  const result: PartGroup[] = [];
  let start = -1;

  const flush = (end: number) => {
    if (start < 0) return;
    const first = parts[start];
    const last = parts[end];
    if (!first || !last) {
      start = -1;
      return;
    }
    result.push({
      key: `context:${first.part.id}`,
      type: 'context',
      refs: parts.slice(start, end + 1).map((item) => ({
        messageID: item.messageID,
        partID: item.part.id,
      })),
    });
    start = -1;
  };

  parts.forEach((item, index) => {
    if (isContextGroupTool(item.part)) {
      if (start < 0) start = index;
      return;
    }

    flush(index - 1);
    result.push({
      key: `part:${item.messageID}:${item.part.id}`,
      type: 'part',
      ref: {
        messageID: item.messageID,
        partID: item.part.id,
      },
    });
  });

  flush(parts.length - 1);
  return result;
}

function isContextGroupTool(part: Part): boolean {
  return part.type === 'tool' && CONTEXT_GROUP_TOOLS.has((part as { tool: string }).tool);
}

// ── renderable: 过滤不可渲染的 part ────────────────────────────

export function renderable(part: Part, showReasoningSummaries = true): boolean {
  if (part.type === 'tool') {
    const toolPart = part as { tool: string; state: { status: string } };
    if (HIDDEN_TOOLS.has(toolPart.tool)) return false;
    if (toolPart.tool === 'question') {
      return toolPart.state.status !== 'pending' && toolPart.state.status !== 'running';
    }
    return true;
  }
  if (part.type === 'text') {
    return !!((part as { text: string }).text?.trim());
  }
  if (part.type === 'reasoning') {
    return showReasoningSummaries && !!((part as { text: string }).text?.trim());
  }
  // 对齐桌面版：只 compaction 可渲染；step-finish/snapshot/subtask/patch/retry 等不渲染
  return part.type === 'compaction';
}

// ── constructMessageRows: 将一个 user message turn 展平为行 ────

/**
 * @param userMessage 用户消息
 * @param getMessageParts 根据 messageID 获取 parts 的函数
 * @param assistantMessages 该 user message 对应的 assistant 消息列表
 * @param index 该 user message 在所有 user messages 中的索引
 * @param showReasoning 是否显示 reasoning
 * @param status 当前会话状态类型
 * @param isActive 该 turn 是否为活跃 turn
 */
export function constructMessageRows(
  userMessage: UserMessage,
  getMessageParts: (messageID: string) => Part[],
  assistantMessages: AssistantMessage[],
  index: number,
  showReasoning: boolean,
  status: SessionStatus['type'],
  isActive: boolean,
): TimelineRowType[] {
  const rows: TimelineRowType[] = [];

  const previousUserMessage = index > 0;
  const userParts = getMessageParts(userMessage.id);
  const compaction = userParts.some((p) => p.type === 'compaction');
  const interruptedMessageIndex = assistantMessages.findIndex(
    (m) => m.error?.name === 'MessageAbortedError',
  );
  const interrupted = interruptedMessageIndex !== -1;
  const error = assistantMessages.find(
    (m) => m.error && m.error.name !== 'MessageAbortedError',
  )?.error;

  // 过滤可渲染的 assistant parts
  const assistantPartRefs = assistantMessages.flatMap((message, messageIndex) =>
    getMessageParts(message.id)
      .filter((part) => renderable(part, showReasoning))
      .map((part) => ({ messageID: message.id, messageIndex, part })),
  );

  // 分组 assistant parts，interrupted 时在断点处插入 interrupted divider
  const assistantItems: Array<{ type: 'part'; group: PartGroup } | { type: 'interrupted' }> =
    interrupted && !compaction
      ? [
          ...groupParts(assistantPartRefs.filter((ref) => ref.messageIndex <= interruptedMessageIndex)).map((group) => ({
            type: 'part' as const,
            group,
          })),
          { type: 'interrupted' as const },
          ...groupParts(assistantPartRefs.filter((ref) => ref.messageIndex > interruptedMessageIndex)).map((group) => ({
            type: 'part' as const,
            group,
          })),
        ]
      : groupParts(assistantPartRefs).map((group) => ({ type: 'part' as const, group }));

  // ── 按顺序构造行 ──

  if (previousUserMessage) {
    rows.push(TimelineRow.TurnGap(userMessage.id));
  }

  rows.push(TimelineRow.UserMessage(userMessage.id, true));

  if (compaction) {
    rows.push(TimelineRow.TurnDivider(userMessage.id, 'compaction'));
  }

  let assistantGroupIndex = 0;
  assistantItems.forEach((item) => {
    if (item.type === 'interrupted') {
      rows.push(TimelineRow.TurnDivider(userMessage.id, 'interrupted'));
      return;
    }

    rows.push(
      TimelineRow.AssistantPart(
        userMessage.id,
        item.group,
        assistantGroupIndex > 0,
      ),
    );
    assistantGroupIndex += 1;
  });

  // Thinking 行：活跃 + busy + 无错误
  if (isActive && status === 'busy' && !error && (showReasoning ? assistantPartRefs.length === 0 : true)) {
    const heading = assistantMessages
      .flatMap((message) => getMessageParts(message.id))
      .map((part) =>
        part.type === 'reasoning' && (part as { text: string }).text
          ? reasoningHeading((part as { text: string }).text)
          : undefined,
      )
      .find((value): value is string => !!value);

    rows.push(TimelineRow.Thinking(userMessage.id, heading));
  }

  // Retry 行：活跃 + retry
  if (isActive && status === 'retry') {
    rows.push(TimelineRow.Retry(userMessage.id));
  }

  // DiffSummary 行：turn 结束时（idle 或非活跃）
  const diffs = (userMessage.summary?.diffs ?? [])
    .reduceRight<SummaryDiff[]>((result, diff) => {
      if (!isSummaryDiff(diff)) return result;
      if (result.some((item) => item.file === diff.file)) return result;
      result.push(diff);
      return result;
    }, [])
    .reverse();
  if (diffs.length > 0 && (status === 'idle' || !isActive)) {
    rows.push(TimelineRow.DiffSummary(userMessage.id, diffs));
  }

  // Error 行
  if (error) {
    const data = error.data?.message;
    rows.push(
      TimelineRow.Error(
        userMessage.id,
        unwrapErrorMessage(
          typeof data === 'string' ? data : data === undefined || data === null ? '' : String(data),
        ),
      ),
    );
  }

  return rows;
}

function isSummaryDiff(value: SnapshotFileDiff): value is SummaryDiff {
  return typeof value.file === 'string';
}

// ── reasoningHeading: 提取 reasoning 首个标题 ──────────────────

export function reasoningHeading(text: string): string | undefined {
  const markdown = text.replace(/\r\n?/g, '\n');

  // HTML 标题
  const html = markdown.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i);
  if (html?.[1]) {
    const value = cleanHeading(html[1].replace(/<[^>]+>/g, ' '));
    if (value) return value;
  }

  // ATX 标题 (# Title)
  const atx = markdown.match(/^\s{0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/m);
  if (atx?.[1]) {
    const value = cleanHeading(atx[1]);
    if (value) return value;
  }

  // Setext 标题 (Title\n=====)
  const setext = markdown.match(/^([^\n]+)\n(?:=+|-+)\s*$/m);
  if (setext?.[1]) {
    const value = cleanHeading(setext[1]);
    if (value) return value;
  }

  // Strong 标题 (**Title**)
  const strong = markdown.match(/^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*$/m);
  if (strong?.[1]) {
    const value = cleanHeading(strong[1]);
    if (value) return value;
  }

  return undefined;
}

function cleanHeading(value: string): string {
  return value
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_~]+/g, '')
    .trim();
}

// ── unwrapErrorMessage: 从 JSON 错误中提取消息 ─────────────────

function unwrapErrorMessage(message: string): string {
  const text = message.replace(/^Error:\s*/, '').trim();

  const parse = (value: string) => {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  };

  const read = (value: string) => {
    const first = parse(value);
    if (typeof first !== 'string') return first;
    return parse(first.trim());
  };

  let json = read(text);

  if (json === undefined) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) json = read(text.slice(start, end + 1));
  }

  if (!record(json)) return message;

  const err = record(json.error) ? json.error : undefined;
  if (err) {
    const type = typeof err.type === 'string' ? err.type : undefined;
    const msg = typeof err.message === 'string' ? err.message : undefined;
    if (type && msg) return `${type}: ${msg}`;
    if (msg) return msg;
    if (type) return type;
    const code = typeof err.code === 'string' ? err.code : undefined;
    if (code) return code;
  }

  const msg = typeof json.message === 'string' ? json.message : undefined;
  if (msg) return msg;

  const reason = typeof json.error === 'string' ? json.error : undefined;
  if (reason) return reason;

  return message;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// ── reuseTimelineRows: 引用复用优化 ───────────────────────────

export function reuseTimelineRows(
  previous: TimelineRowType[] | undefined,
  rows: TimelineRowType[],
): TimelineRowType[] {
  if (!previous?.length) return rows;
  const byKey = new Map(previous.map((row) => [rowKey(row), row] as const));
  const next = rows.map((row) => {
    const existing = byKey.get(rowKey(row));
    if (!existing) return row;
    return rowEquals(existing, row) ? existing : row;
  });
  if (previous.length === next.length && previous.every((row, index) => row === next[index])) {
    return previous;
  }
  return next;
}

// ── assistantMessagesByParent: 按 parentID 分组 assistant 消息 ─

export function assistantMessagesByParent(messages: MessageEntry[]): Map<string, AssistantMessage[]> {
  const result = new Map<string, AssistantMessage[]>();
  messages.forEach((entry) => {
    if (entry.info.role !== 'assistant') return;
    const assistantMsg = entry.info as AssistantMessage;
    const parentID = assistantMsg.parentID;
    if (!parentID) return;
    const list = result.get(parentID);
    if (list) {
      list.push(assistantMsg);
    } else {
      result.set(parentID, [assistantMsg]);
    }
  });
  return result;
}

// ── activeMessageID: 找当前活跃 turn 的 user message ID ────────

export function activeMessageID(
  messages: MessageEntry[],
  status: SessionStatus['type'],
): string | undefined {
  // 找最后一个 time.completed 未定义的 assistant 消息
  const lastActiveAssistant = [...messages]
    .reverse()
    .find((entry) => {
      if (entry.info.role !== 'assistant') return false;
      const assistantMsg = entry.info as AssistantMessage;
      return typeof assistantMsg.time.completed !== 'number';
    });

  if (lastActiveAssistant) {
    const assistantMsg = lastActiveAssistant.info as AssistantMessage;
    const parentID = assistantMsg.parentID;
    if (parentID) {
      const parentEntry = messages.find((entry) => entry.info.id === parentID);
      if (parentEntry?.info.role === 'user') return parentEntry.info.id;
    }
  }

  // idle 时不返回 fallback
  if (status === 'idle') return undefined;

  // 回退到最后一个 user message
  const lastUser = [...messages].reverse().find((entry) => entry.info.role === 'user');
  return lastUser?.info.id;
}
