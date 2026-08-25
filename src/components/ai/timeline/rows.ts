/**
 * rows.ts — TimelineRow 类型定义 + key/equals 工具函数
 *
 * 对齐 opencode 桌面版 rows.ts，适配 React + TypeScript（不使用 effect 库）。
 * 9 种行类型以 user message 为 turn 锚点，把 assistant 消息的 parts 展平成行。
 */

import type { SnapshotFileDiff } from '@opencode-ai/sdk/v2/client';
import type { PartGroup } from './projection';

export type SummaryDiff = SnapshotFileDiff & { file: string };

// ── TimelineRow 判别联合 ──────────────────────────────────────

export interface TurnGapRow {
  _tag: 'TurnGap';
  userMessageID: string;
}

export interface CommentStripRow {
  _tag: 'CommentStrip';
  userMessageID: string;
}

export interface UserMessageRow {
  _tag: 'UserMessage';
  userMessageID: string;
  anchor: boolean;
}

export interface TurnDividerRow {
  _tag: 'TurnDivider';
  userMessageID: string;
  label: 'compaction' | 'interrupted';
}

export interface AssistantPartRow {
  _tag: 'AssistantPart';
  userMessageID: string;
  group: PartGroup;
  previousAssistantPart: boolean;
}

export interface ThinkingRow {
  _tag: 'Thinking';
  userMessageID: string;
  reasoningHeading?: string;
}

export interface RetryRow {
  _tag: 'Retry';
  userMessageID: string;
}

export interface DiffSummaryRow {
  _tag: 'DiffSummary';
  userMessageID: string;
  diffs: SummaryDiff[];
}

export interface ErrorRow {
  _tag: 'Error';
  userMessageID: string;
  text: string;
}

export type TimelineRow =
  | TurnGapRow
  | CommentStripRow
  | UserMessageRow
  | TurnDividerRow
  | AssistantPartRow
  | ThinkingRow
  | RetryRow
  | DiffSummaryRow
  | ErrorRow;

// ── 工厂函数 ──────────────────────────────────────────────────

export const TimelineRow = {
  TurnGap: (userMessageID: string): TurnGapRow => ({ _tag: 'TurnGap', userMessageID }),
  CommentStrip: (userMessageID: string): CommentStripRow => ({ _tag: 'CommentStrip', userMessageID }),
  UserMessage: (userMessageID: string, anchor: boolean): UserMessageRow => ({ _tag: 'UserMessage', userMessageID, anchor }),
  TurnDivider: (userMessageID: string, label: 'compaction' | 'interrupted'): TurnDividerRow => ({ _tag: 'TurnDivider', userMessageID, label }),
  AssistantPart: (userMessageID: string, group: PartGroup, previousAssistantPart: boolean): AssistantPartRow => ({ _tag: 'AssistantPart', userMessageID, group, previousAssistantPart }),
  Thinking: (userMessageID: string, reasoningHeading?: string): ThinkingRow => ({ _tag: 'Thinking', userMessageID, reasoningHeading }),
  Retry: (userMessageID: string): RetryRow => ({ _tag: 'Retry', userMessageID }),
  DiffSummary: (userMessageID: string, diffs: SummaryDiff[]): DiffSummaryRow => ({ _tag: 'DiffSummary', userMessageID, diffs }),
  Error: (userMessageID: string, text: string): ErrorRow => ({ _tag: 'Error', userMessageID, text }),
};

// ── key() — 生成稳定字符串 key（用于 React key prop 和 virtualizer getItemKey） ──

export function rowKey(row: TimelineRow): string {
  switch (row._tag) {
    case 'TurnGap':
      return `turn-gap:${row.userMessageID}`;
    case 'CommentStrip':
      return `comment-strip:${row.userMessageID}`;
    case 'UserMessage':
      return `user-message:${row.userMessageID}`;
    case 'TurnDivider':
      return `turn-divider:${row.userMessageID}:${row.label}`;
    case 'AssistantPart':
      return `assistant-part:${row.userMessageID}:${row.group.key}`;
    case 'Thinking':
      return `thinking:${row.userMessageID}`;
    case 'DiffSummary':
      return `diff-summary:${row.userMessageID}`;
    case 'Error':
      return `error:${row.userMessageID}`;
    case 'Retry':
      return `retry:${row.userMessageID}`;
  }
}

// ── equals() — 浅比较（用于 reuseTimelineRows 引用复用） ──────

export function rowEquals(a: TimelineRow, b: TimelineRow): boolean {
  if (a._tag !== b._tag) return false;
  switch (a._tag) {
    case 'TurnGap':
      return a.userMessageID === (b as TurnGapRow).userMessageID;
    case 'CommentStrip':
      return a.userMessageID === (b as CommentStripRow).userMessageID;
    case 'UserMessage': {
      const o = b as UserMessageRow;
      return a.userMessageID === o.userMessageID && a.anchor === o.anchor;
    }
    case 'TurnDivider': {
      const o = b as TurnDividerRow;
      return a.userMessageID === o.userMessageID && a.label === o.label;
    }
    case 'AssistantPart': {
      const o = b as AssistantPartRow;
      return (
        a.userMessageID === o.userMessageID &&
        a.previousAssistantPart === o.previousAssistantPart &&
        a.group.key === o.group.key &&
        a.group.type === o.group.type
      );
    }
    case 'Thinking': {
      const o = b as ThinkingRow;
      return a.userMessageID === o.userMessageID && a.reasoningHeading === o.reasoningHeading;
    }
    case 'Retry':
      return a.userMessageID === (b as RetryRow).userMessageID;
    case 'DiffSummary': {
      const o = b as DiffSummaryRow;
      return a.userMessageID === o.userMessageID && a.diffs.length === o.diffs.length;
    }
    case 'Error': {
      const o = b as ErrorRow;
      return a.userMessageID === o.userMessageID && a.text === o.text;
    }
  }
}

// ── 类型守卫 ──────────────────────────────────────────────────

export function hasUserMessageID(row: TimelineRow): row is TimelineRow & { userMessageID: string } {
  return 'userMessageID' in row;
}
