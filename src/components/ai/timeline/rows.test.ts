/**
 * rows.test.ts — TimelineRow 类型 + key/equals 工具函数测试
 *
 * 测试覆盖：
 * - 工厂函数创建正确的行类型
 * - rowKey 生成稳定且唯一的字符串 key
 * - rowEquals 浅比较逻辑
 * - hasUserMessageID 类型守卫
 */

import { describe, it, expect } from 'vitest';
import {
  TimelineRow,
  rowKey,
  rowEquals,
  hasUserMessageID,
} from './rows';
import type { PartGroup } from './projection';

// ── 辅助构造函数 ───────────────────────────────────────────────

const partGroup: PartGroup = { key: 'part:msg1:p1', type: 'part', ref: { messageID: 'msg1', partID: 'p1' } };

// ── 工厂函数测试 ───────────────────────────────────────────────

describe('TimelineRow 工厂函数', () => {
  it('TurnGap', () => {
    const row = TimelineRow.TurnGap('u1');
    expect(row._tag).toBe('TurnGap');
    expect(row.userMessageID).toBe('u1');
  });

  it('CommentStrip', () => {
    const row = TimelineRow.CommentStrip('u1');
    expect(row._tag).toBe('CommentStrip');
    expect(row.userMessageID).toBe('u1');
  });

  it('UserMessage with anchor', () => {
    const row = TimelineRow.UserMessage('u1', true);
    expect(row._tag).toBe('UserMessage');
    expect(row.userMessageID).toBe('u1');
    expect(row.anchor).toBe(true);
  });

  it('TurnDivider compaction', () => {
    const row = TimelineRow.TurnDivider('u1', 'compaction');
    expect(row._tag).toBe('TurnDivider');
    expect(row.label).toBe('compaction');
  });

  it('TurnDivider interrupted', () => {
    const row = TimelineRow.TurnDivider('u1', 'interrupted');
    expect(row._tag).toBe('TurnDivider');
    expect(row.label).toBe('interrupted');
  });

  it('AssistantPart', () => {
    const row = TimelineRow.AssistantPart('u1', partGroup, false);
    expect(row._tag).toBe('AssistantPart');
    expect(row.group).toBe(partGroup);
    expect(row.previousAssistantPart).toBe(false);
  });

  it('Thinking with heading', () => {
    const row = TimelineRow.Thinking('u1', 'Analyzing code');
    expect(row._tag).toBe('Thinking');
    expect(row.reasoningHeading).toBe('Analyzing code');
  });

  it('Thinking without heading', () => {
    const row = TimelineRow.Thinking('u1');
    expect(row._tag).toBe('Thinking');
    expect(row.reasoningHeading).toBeUndefined();
  });

  it('Retry', () => {
    const row = TimelineRow.Retry('u1');
    expect(row._tag).toBe('Retry');
    expect(row.userMessageID).toBe('u1');
  });

  it('DiffSummary', () => {
    const diffs = [{ file: 'src/app.ts', additions: 10, deletions: 2, patch: '' } as never];
    const row = TimelineRow.DiffSummary('u1', diffs);
    expect(row._tag).toBe('DiffSummary');
    expect(row.diffs).toHaveLength(1);
  });

  it('Error', () => {
    const row = TimelineRow.Error('u1', 'Something went wrong');
    expect(row._tag).toBe('Error');
    expect(row.text).toBe('Something went wrong');
  });
});

// ── rowKey 测试 ────────────────────────────────────────────────

describe('rowKey', () => {
  it('TurnGap key', () => {
    expect(rowKey(TimelineRow.TurnGap('u1'))).toBe('turn-gap:u1');
  });

  it('CommentStrip key', () => {
    expect(rowKey(TimelineRow.CommentStrip('u1'))).toBe('comment-strip:u1');
  });

  it('UserMessage key', () => {
    expect(rowKey(TimelineRow.UserMessage('u1', true))).toBe('user-message:u1');
  });

  it('TurnDivider key 包含 label', () => {
    expect(rowKey(TimelineRow.TurnDivider('u1', 'compaction'))).toBe('turn-divider:u1:compaction');
    expect(rowKey(TimelineRow.TurnDivider('u1', 'interrupted'))).toBe('turn-divider:u1:interrupted');
  });

  it('AssistantPart key 包含 group.key', () => {
    expect(rowKey(TimelineRow.AssistantPart('u1', partGroup, false))).toBe('assistant-part:u1:part:msg1:p1');
  });

  it('Thinking key', () => {
    expect(rowKey(TimelineRow.Thinking('u1'))).toBe('thinking:u1');
  });

  it('DiffSummary key', () => {
    expect(rowKey(TimelineRow.DiffSummary('u1', []))).toBe('diff-summary:u1');
  });

  it('Error key', () => {
    expect(rowKey(TimelineRow.Error('u1', 'err'))).toBe('error:u1');
  });

  it('Retry key', () => {
    expect(rowKey(TimelineRow.Retry('u1'))).toBe('retry:u1');
  });

  it('不同行类型 key 不冲突', () => {
    const keys = new Set<string>();
    keys.add(rowKey(TimelineRow.TurnGap('u1')));
    keys.add(rowKey(TimelineRow.CommentStrip('u1')));
    keys.add(rowKey(TimelineRow.UserMessage('u1', true)));
    keys.add(rowKey(TimelineRow.TurnDivider('u1', 'compaction')));
    keys.add(rowKey(TimelineRow.AssistantPart('u1', partGroup, false)));
    keys.add(rowKey(TimelineRow.Thinking('u1')));
    keys.add(rowKey(TimelineRow.DiffSummary('u1', [])));
    keys.add(rowKey(TimelineRow.Error('u1', 'err')));
    keys.add(rowKey(TimelineRow.Retry('u1')));
    expect(keys.size).toBe(9);
  });
});

// ── rowEquals 测试 ─────────────────────────────────────────────

describe('rowEquals', () => {
  it('不同 _tag 不相等', () => {
    expect(rowEquals(TimelineRow.TurnGap('u1'), TimelineRow.CommentStrip('u1'))).toBe(false);
  });

  it('TurnGap 相等', () => {
    expect(rowEquals(TimelineRow.TurnGap('u1'), TimelineRow.TurnGap('u1'))).toBe(true);
    expect(rowEquals(TimelineRow.TurnGap('u1'), TimelineRow.TurnGap('u2'))).toBe(false);
  });

  it('UserMessage anchor 不同时不相等', () => {
    expect(rowEquals(TimelineRow.UserMessage('u1', true), TimelineRow.UserMessage('u1', true))).toBe(true);
    expect(rowEquals(TimelineRow.UserMessage('u1', true), TimelineRow.UserMessage('u1', false))).toBe(false);
  });

  it('TurnDivider label 不同时不相等', () => {
    expect(rowEquals(TimelineRow.TurnDivider('u1', 'compaction'), TimelineRow.TurnDivider('u1', 'compaction'))).toBe(true);
    expect(rowEquals(TimelineRow.TurnDivider('u1', 'compaction'), TimelineRow.TurnDivider('u1', 'interrupted'))).toBe(false);
  });

  it('AssistantPart previousAssistantPart 不同时不相等', () => {
    const r1 = TimelineRow.AssistantPart('u1', partGroup, false);
    const r2 = TimelineRow.AssistantPart('u1', partGroup, true);
    expect(rowEquals(r1, r1)).toBe(true);
    expect(rowEquals(r1, r2)).toBe(false);
  });

  it('AssistantPart group.key 不同时不相等', () => {
    const g1: PartGroup = { key: 'part:m1:p1', type: 'part', ref: { messageID: 'm1', partID: 'p1' } };
    const g2: PartGroup = { key: 'part:m1:p2', type: 'part', ref: { messageID: 'm1', partID: 'p2' } };
    expect(rowEquals(
      TimelineRow.AssistantPart('u1', g1, false),
      TimelineRow.AssistantPart('u1', g2, false),
    )).toBe(false);
  });

  it('Thinking heading 不同时不相等', () => {
    expect(rowEquals(TimelineRow.Thinking('u1', 'a'), TimelineRow.Thinking('u1', 'a'))).toBe(true);
    expect(rowEquals(TimelineRow.Thinking('u1', 'a'), TimelineRow.Thinking('u1', 'b'))).toBe(false);
  });

  it('Error text 不同时不相等', () => {
    expect(rowEquals(TimelineRow.Error('u1', 'err1'), TimelineRow.Error('u1', 'err1'))).toBe(true);
    expect(rowEquals(TimelineRow.Error('u1', 'err1'), TimelineRow.Error('u1', 'err2'))).toBe(false);
  });

  it('DiffSummary 只比较长度（浅比较）', () => {
    const d1 = [{ file: 'a.ts' } as never];
    const d2 = [{ file: 'b.ts' } as never];
    expect(rowEquals(TimelineRow.DiffSummary('u1', d1), TimelineRow.DiffSummary('u1', d2))).toBe(true);
    expect(rowEquals(TimelineRow.DiffSummary('u1', d1), TimelineRow.DiffSummary('u1', []))).toBe(false);
  });
});

// ── hasUserMessageID 类型守卫 ──────────────────────────────────

describe('hasUserMessageID', () => {
  it('所有带 userMessageID 的行返回 true', () => {
    const rows: TimelineRow[] = [
      TimelineRow.TurnGap('u1'),
      TimelineRow.CommentStrip('u1'),
      TimelineRow.UserMessage('u1', true),
      TimelineRow.TurnDivider('u1', 'compaction'),
      TimelineRow.AssistantPart('u1', partGroup, false),
      TimelineRow.Thinking('u1'),
      TimelineRow.Retry('u1'),
      TimelineRow.DiffSummary('u1', []),
      TimelineRow.Error('u1', 'err'),
    ];
    for (const row of rows) {
      expect(hasUserMessageID(row)).toBe(true);
    }
  });
});
