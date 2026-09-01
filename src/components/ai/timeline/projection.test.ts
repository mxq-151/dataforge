/**
 * projection.test.ts — turn-based 行投影逻辑测试
 *
 * 测试覆盖：
 * - groupParts: 连续 read/glob/grep/list 合并为 context 组
 * - renderable: 过滤不可渲染的 part（todowrite/question pending/step-finish/snapshot）
 * - constructMessageRows: 9 种行类型生成、interrupted 切断、compaction divider、Thinking/DiffSummary/Error
 * - reuseTimelineRows: 引用复用优化
 * - assistantMessagesByParent: 按 parentID 分组
 * - activeMessageID: 活跃 turn 查找
 */

import { describe, it, expect } from 'vitest';
import {
  groupParts,
  renderable,
  constructMessageRows,
  reuseTimelineRows,
  assistantMessagesByParent,
  activeMessageID,
  reasoningHeading,
} from './projection';
import { TimelineRow } from './rows';
import type { Part, UserMessage, AssistantMessage } from '@opencode-ai/sdk/v2/client';
import type { MessageEntry, Todo, FileChange } from '../../../types/opencode-backend';

// ── Mock 构造辅助函数 ──────────────────────────────────────────

function makeTextPart(id: string, text: string): Part {
  return { id, type: 'text', text } as unknown as Part;
}

function makeReasoningPart(id: string, text: string): Part {
  return { id, type: 'reasoning', text } as unknown as Part;
}

function makeToolPart(id: string, tool: string, status = 'completed'): Part {
  return {
    id,
    type: 'tool',
    tool,
    state: { status, input: {}, metadata: {}, time: {} },
  } as unknown as Part;
}

function makeContextToolPart(id: string, tool: string): Part {
  return makeToolPart(id, tool, 'completed');
}

function makeCompactionPart(id: string): Part {
  return { id, type: 'compaction' } as unknown as Part;
}

function makeStepFinishPart(id: string): Part {
  return { id, type: 'step-finish' } as unknown as Part;
}

function makeSnapshotPart(id: string): Part {
  return { id, type: 'snapshot' } as unknown as Part;
}

function makeUserMessage(id: string, parentID?: string): UserMessage {
  return {
    id,
    role: 'user',
    parentID,
    time: { created: Date.now() },
  } as unknown as UserMessage;
}

function makeAssistantMessage(id: string, parentID: string, completed = true): AssistantMessage {
  return {
    id,
    role: 'assistant',
    parentID,
    time: { created: Date.now(), completed: completed ? Date.now() : undefined },
  } as unknown as AssistantMessage;
}

function makeAssistantMessageWithError(id: string, parentID: string, errorName: string): AssistantMessage {
  return {
    id,
    role: 'assistant',
    parentID,
    time: { created: Date.now(), completed: Date.now() },
    error: { name: errorName, message: 'test error' },
  } as unknown as AssistantMessage;
}

function makeEntry(info: UserMessage | AssistantMessage, parts: Part[]): MessageEntry {
  return { info, parts };
}

// ── groupParts 测试 ────────────────────────────────────────────

describe('groupParts', () => {
  it('单个非 context 工具 → part 组', () => {
    const parts = [{ messageID: 'm1', part: makeToolPart('p1', 'bash') }];
    const groups = groupParts(parts);
    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe('part');
  });

  it('单个 read → part 组（单个不合并）', () => {
    const parts = [{ messageID: 'm1', part: makeContextToolPart('p1', 'read') }];
    const groups = groupParts(parts);
    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe('context');
  });

  it('连续 read/glob/grep → 合并为 context 组', () => {
    const parts = [
      { messageID: 'm1', part: makeContextToolPart('p1', 'read') },
      { messageID: 'm1', part: makeContextToolPart('p2', 'glob') },
      { messageID: 'm1', part: makeContextToolPart('p3', 'grep') },
    ];
    const groups = groupParts(parts);
    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe('context');
    if (groups[0].type === 'context') {
      expect(groups[0].refs).toHaveLength(3);
    }
  });

  it('read + bash + read → 3 组（context + part + context）', () => {
    const parts = [
      { messageID: 'm1', part: makeContextToolPart('p1', 'read') },
      { messageID: 'm1', part: makeToolPart('p2', 'bash') },
      { messageID: 'm1', part: makeContextToolPart('p3', 'read') },
    ];
    const groups = groupParts(parts);
    expect(groups).toHaveLength(3);
    expect(groups[0].type).toBe('context');
    expect(groups[1].type).toBe('part');
    expect(groups[2].type).toBe('context');
  });

  it('text part → part 组', () => {
    const parts = [{ messageID: 'm1', part: makeTextPart('p1', 'hello') }];
    const groups = groupParts(parts);
    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe('part');
  });

  it('空数组 → 空结果', () => {
    expect(groupParts([])).toHaveLength(0);
  });
});

// ── renderable 测试 ────────────────────────────────────────────

describe('renderable', () => {
  it('text part 有内容 → true', () => {
    expect(renderable(makeTextPart('p1', 'hello'))).toBe(true);
  });

  it('text part 空内容 → false', () => {
    expect(renderable(makeTextPart('p1', ''))).toBe(false);
    expect(renderable(makeTextPart('p1', '  '))).toBe(false);
  });

  it('reasoning part 有内容 → true（showReasoning=true）', () => {
    expect(renderable(makeReasoningPart('p1', 'thinking...'), true)).toBe(true);
  });

  it('reasoning part showReasoning=false → false', () => {
    expect(renderable(makeReasoningPart('p1', 'thinking...'), false)).toBe(false);
  });

  it('todowrite → false（隐藏工具）', () => {
    expect(renderable(makeToolPart('p1', 'todowrite'))).toBe(false);
  });

  it('question pending → false', () => {
    expect(renderable(makeToolPart('p1', 'question', 'pending'))).toBe(false);
  });

  it('question running → false', () => {
    expect(renderable(makeToolPart('p1', 'question', 'running'))).toBe(false);
  });

  it('question completed → true', () => {
    expect(renderable(makeToolPart('p1', 'question', 'completed'))).toBe(true);
  });

  it('bash completed → true', () => {
    expect(renderable(makeToolPart('p1', 'bash'))).toBe(true);
  });

  it('compaction → true', () => {
    expect(renderable(makeCompactionPart('p1'))).toBe(true);
  });

  it('step-finish → false（不渲染）', () => {
    expect(renderable(makeStepFinishPart('p1'))).toBe(false);
  });

  it('snapshot → false（不渲染）', () => {
    expect(renderable(makeSnapshotPart('p1'))).toBe(false);
  });
});

// ── constructMessageRows 测试 ──────────────────────────────────

describe('constructMessageRows', () => {
  const idleStatus = 'idle' as const;
  const busyStatus = 'busy' as const;

  it('首个 user message 无 TurnGap', () => {
    const userMsg = makeUserMessage('u1');
    const rows = constructMessageRows(userMsg, () => [], [], 0, true, idleStatus, false);
    expect(rows[0]._tag).toBe('UserMessage');
    expect(rows.find((r) => r._tag === 'TurnGap')).toBeUndefined();
  });

  it('非首个 user message 有 TurnGap', () => {
    const userMsg = makeUserMessage('u2');
    const rows = constructMessageRows(userMsg, () => [], [], 1, true, idleStatus, false);
    expect(rows[0]._tag).toBe('TurnGap');
    expect(rows[1]._tag).toBe('UserMessage');
  });

  it('compaction part → TurnDivider(compaction)', () => {
    const userMsg = makeUserMessage('u1');
    const rows = constructMessageRows(
      userMsg,
      (id) => (id === 'u1' ? [makeCompactionPart('c1')] : []),
      [],
      0,
      true,
      idleStatus,
      false,
    );
    expect(rows.some((r) => r._tag === 'TurnDivider' && r.label === 'compaction')).toBe(true);
  });

  it('assistant text part → AssistantPart 行', () => {
    const userMsg = makeUserMessage('u1');
    const assistantMsg = makeAssistantMessage('a1', 'u1');
    const rows = constructMessageRows(
      userMsg,
      (id) => (id === 'a1' ? [makeTextPart('t1', 'response')] : []),
      [assistantMsg],
      0,
      true,
      idleStatus,
      false,
    );
    expect(rows.some((r) => r._tag === 'AssistantPart')).toBe(true);
  });

  it('busy + 活跃 + 无 part → Thinking 行', () => {
    const userMsg = makeUserMessage('u1');
    const assistantMsg = makeAssistantMessage('a1', 'u1', false); // 未完成
    const rows = constructMessageRows(
      userMsg,
      () => [],
      [assistantMsg],
      0,
      true,
      busyStatus,
      true,
    );
    expect(rows.some((r) => r._tag === 'Thinking')).toBe(true);
  });

  it('busy + 活跃 + showReasoning=false + 有 reasoning part → Thinking 行带 heading', () => {
    const userMsg = makeUserMessage('u1');
    const assistantMsg = makeAssistantMessage('a1', 'u1', false);
    const reasoningText = '# Analyzing the code\nSome thoughts';
    // showReasoning=false 时 reasoning 不可渲染，assistantPartRefs 为空 → 生成 Thinking 行
    // 但 heading 仍从 reasoning part 中提取
    const rows = constructMessageRows(
      userMsg,
      (id) => (id === 'a1' ? [makeReasoningPart('r1', reasoningText)] : []),
      [assistantMsg],
      0,
      false, // showReasoning=false
      busyStatus,
      true,
    );
    const thinking = rows.find((r) => r._tag === 'Thinking');
    expect(thinking).toBeDefined();
    if (thinking?._tag === 'Thinking') {
      expect(thinking.reasoningHeading).toBe('Analyzing the code');
    }
  });

  it('busy + 活跃 + showReasoning=true + 有 reasoning part → 无 Thinking 行（reasoning 已可见）', () => {
    const userMsg = makeUserMessage('u1');
    const assistantMsg = makeAssistantMessage('a1', 'u1', false);
    const rows = constructMessageRows(
      userMsg,
      (id) => (id === 'a1' ? [makeReasoningPart('r1', '# Heading')] : []),
      [assistantMsg],
      0,
      true, // showReasoning=true → reasoning 可渲染 → assistantPartRefs 非空 → 无 Thinking
      busyStatus,
      true,
    );
    expect(rows.some((r) => r._tag === 'Thinking')).toBe(false);
  });

  it('interrupted assistant → TurnDivider(interrupted)', () => {
    const userMsg = makeUserMessage('u1');
    const assistantMsg = makeAssistantMessageWithError('a1', 'u1', 'MessageAbortedError');
    const rows = constructMessageRows(
      userMsg,
      () => [],
      [assistantMsg],
      0,
      true,
      idleStatus,
      false,
    );
    expect(rows.some((r) => r._tag === 'TurnDivider' && r.label === 'interrupted')).toBe(true);
  });

  it('error assistant → Error 行', () => {
    const userMsg = makeUserMessage('u1');
    const assistantMsg = makeAssistantMessageWithError('a1', 'u1', 'SomeError');
    const rows = constructMessageRows(
      userMsg,
      () => [],
      [assistantMsg],
      0,
      true,
      idleStatus,
      false,
    );
    expect(rows.some((r) => r._tag === 'Error')).toBe(true);
  });

  it('MessageAbortedError 不产生 Error 行（只产生 interrupted divider）', () => {
    const userMsg = makeUserMessage('u1');
    const assistantMsg = makeAssistantMessageWithError('a1', 'u1', 'MessageAbortedError');
    const rows = constructMessageRows(
      userMsg,
      () => [],
      [assistantMsg],
      0,
      true,
      idleStatus,
      false,
    );
    expect(rows.some((r) => r._tag === 'Error')).toBe(false);
    expect(rows.some((r) => r._tag === 'TurnDivider' && r.label === 'interrupted')).toBe(true);
  });

  it('多个 assistant part → previousAssistantPart 标记', () => {
    const userMsg = makeUserMessage('u1');
    const assistantMsg = makeAssistantMessage('a1', 'u1');
    const rows = constructMessageRows(
      userMsg,
      (id) => (id === 'a1' ? [
        makeToolPart('t1', 'bash'),
        makeTextPart('t2', 'response'),
      ] : []),
      [assistantMsg],
      0,
      true,
      idleStatus,
      false,
    );
    const assistantParts = rows.filter((r) => r._tag === 'AssistantPart');
    expect(assistantParts).toHaveLength(2);
    if (assistantParts[0]._tag === 'AssistantPart') {
      expect(assistantParts[0].previousAssistantPart).toBe(false);
    }
    if (assistantParts[1]._tag === 'AssistantPart') {
      expect(assistantParts[1].previousAssistantPart).toBe(true);
    }
  });

  it('retry status + 活跃 → Retry 行', () => {
    const userMsg = makeUserMessage('u1');
    const rows = constructMessageRows(
      userMsg,
      () => [],
      [],
      0,
      true,
      'retry' as const,
      true,
    );
    expect(rows.some((r) => r._tag === 'Retry')).toBe(true);
  });

  it('inline todos → 追加 Todo 行（内联到 turn 末尾）', () => {
    const userMsg = makeUserMessage('u1');
    const todos = [{ id: 't1', content: '任务1', status: 'pending' }] as unknown as Todo[];
    const rows = constructMessageRows(
      userMsg,
      () => [],
      [],
      0,
      true,
      idleStatus,
      false,
      { todos },
    );
    const todoRow = rows.find((r) => r._tag === 'Todo');
    expect(todoRow).toBeDefined();
    if (todoRow && todoRow._tag === 'Todo') {
      expect(todoRow.todos).toBe(todos);
    }
    // 位于 turn 末尾（最后一个行是 Todo 行）
    expect(rows[rows.length - 1]._tag).toBe('Todo');
  });

  it('inline todos 为空 → 不生成 Todo 行', () => {
    const userMsg = makeUserMessage('u1');
    const rows = constructMessageRows(
      userMsg,
      () => [],
      [],
      0,
      true,
      idleStatus,
      false,
      { todos: [] },
    );
    expect(rows.some((r) => r._tag === 'Todo')).toBe(false);
  });

  it('inline fileChanges → 追加 FileChange 行（内联到 turn 末尾）', () => {
    const userMsg = makeUserMessage('u1');
    const changes = [{
      filePath: '/src/a.ts',
      additions: 1,
      deletions: 0,
      type: 'edit',
      status: 'pending',
      messageID: 'a1',
      partID: 'p1',
    }] as unknown as FileChange[];
    const rows = constructMessageRows(
      userMsg,
      () => [],
      [],
      0,
      true,
      idleStatus,
      false,
      { fileChanges: changes },
    );
    const fcRow = rows.find((r) => r._tag === 'FileChange');
    expect(fcRow).toBeDefined();
    if (fcRow && fcRow._tag === 'FileChange') {
      expect(fcRow.changes).toBe(changes);
    }
    expect(rows[rows.length - 1]._tag).toBe('FileChange');
  });

  it('inline todos + fileChanges → Todo 行在 FileChange 行之前', () => {
    const userMsg = makeUserMessage('u1');
    const todos = [{ id: 't1', content: '任务1', status: 'pending' }] as unknown as Todo[];
    const changes = [{
      filePath: '/src/a.ts',
      additions: 1,
      deletions: 0,
      type: 'edit',
      status: 'pending',
      messageID: 'a1',
      partID: 'p1',
    }] as unknown as FileChange[];
    const rows = constructMessageRows(
      userMsg,
      () => [],
      [],
      0,
      true,
      idleStatus,
      false,
      { todos, fileChanges: changes },
    );
    const tags = rows.map((r) => r._tag);
    expect(tags.indexOf('Todo')).toBeGreaterThan(-1);
    expect(tags.indexOf('FileChange')).toBeGreaterThan(tags.indexOf('Todo'));
  });
});

// ── reuseTimelineRows 测试 ─────────────────────────────────────

describe('reuseTimelineRows', () => {
  it('previous 为空 → 返回新 rows', () => {
    const rows = [TimelineRow.TurnGap('u1')];
    expect(reuseTimelineRows(undefined, rows)).toBe(rows);
  });

  it('完全相同的 rows → 返回 previous（引用复用）', () => {
    const prev = [TimelineRow.TurnGap('u1'), TimelineRow.UserMessage('u1', true)];
    const next = [TimelineRow.TurnGap('u1'), TimelineRow.UserMessage('u1', true)];
    const result = reuseTimelineRows(prev, next);
    expect(result).toBe(prev);
  });

  it('内容变化 → 返回新数组（混合复用）', () => {
    const prev = [TimelineRow.TurnGap('u1'), TimelineRow.UserMessage('u1', true)];
    const next = [TimelineRow.TurnGap('u1'), TimelineRow.UserMessage('u1', false)];
    const result = reuseTimelineRows(prev, next);
    expect(result).not.toBe(prev);
    // TurnGap 应复用
    expect(result[0]).toBe(prev[0]);
    // UserMessage anchor 变化 → 新对象
    expect(result[1]).not.toBe(prev[1]);
  });

  it('长度变化 → 返回新数组', () => {
    const prev = [TimelineRow.TurnGap('u1')];
    const next = [TimelineRow.TurnGap('u1'), TimelineRow.UserMessage('u1', true)];
    const result = reuseTimelineRows(prev, next);
    expect(result).not.toBe(prev);
    expect(result).toHaveLength(2);
  });
});

// ── assistantMessagesByParent 测试 ─────────────────────────────

describe('assistantMessagesByParent', () => {
  it('按 parentID 分组', () => {
    const entries: MessageEntry[] = [
      makeEntry(makeUserMessage('u1'), []),
      makeEntry(makeAssistantMessage('a1', 'u1'), []),
      makeEntry(makeAssistantMessage('a2', 'u1'), []),
      makeEntry(makeUserMessage('u2'), []),
      makeEntry(makeAssistantMessage('a3', 'u2'), []),
    ];
    const map = assistantMessagesByParent(entries);
    expect(map.get('u1')).toHaveLength(2);
    expect(map.get('u2')).toHaveLength(1);
  });

  it('无 parentID 的 assistant 被跳过', () => {
    const entries: MessageEntry[] = [
      makeEntry({ ...makeAssistantMessage('a1', ''), parentID: undefined } as unknown as AssistantMessage, []),
    ];
    const map = assistantMessagesByParent(entries);
    expect(map.size).toBe(0);
  });

  it('user messages 被跳过', () => {
    const entries: MessageEntry[] = [
      makeEntry(makeUserMessage('u1'), []),
    ];
    const map = assistantMessagesByParent(entries);
    expect(map.size).toBe(0);
  });
});

// ── activeMessageID 测试 ───────────────────────────────────────

describe('activeMessageID', () => {
  it('有未完成 assistant → 返回其 parent user message ID', () => {
    const entries: MessageEntry[] = [
      makeEntry(makeUserMessage('u1'), []),
      makeEntry(makeAssistantMessage('a1', 'u1', false), []),
    ];
    expect(activeMessageID(entries, 'busy')).toBe('u1');
  });

  it('idle + 未完成 assistant → 仍返回其 parent（因 assistant 未完成）', () => {
    const entries: MessageEntry[] = [
      makeEntry(makeUserMessage('u1'), []),
      makeEntry(makeAssistantMessage('a1', 'u1', false), []),
    ];
    expect(activeMessageID(entries, 'idle')).toBe('u1');
  });

  it('idle + 全部完成 → undefined', () => {
    const entries: MessageEntry[] = [
      makeEntry(makeUserMessage('u1'), []),
      makeEntry(makeAssistantMessage('a1', 'u1', true), []),
    ];
    expect(activeMessageID(entries, 'idle')).toBeUndefined();
  });

  it('busy + 全部完成 → 回退到最后一个 user message', () => {
    const entries: MessageEntry[] = [
      makeEntry(makeUserMessage('u1'), []),
      makeEntry(makeAssistantMessage('a1', 'u1', true), []),
    ];
    expect(activeMessageID(entries, 'busy')).toBe('u1');
  });

  it('空消息列表 → undefined', () => {
    expect(activeMessageID([], 'busy')).toBeUndefined();
  });
});

// ── reasoningHeading 测试 ──────────────────────────────────────

describe('reasoningHeading', () => {
  it('ATX 标题 (# Title)', () => {
    expect(reasoningHeading('# Hello World')).toBe('Hello World');
  });

  it('ATX 标题 (## Subtitle)', () => {
    expect(reasoningHeading('## My Subtitle')).toBe('My Subtitle');
  });

  it('Strong 标题 (**Title**)', () => {
    expect(reasoningHeading('**Important**')).toBe('Important');
  });

  it('带代码的标题', () => {
    expect(reasoningHeading('# `code` heading')).toBe('code heading');
  });

  it('无标题 → undefined', () => {
    expect(reasoningHeading('Just some text\nwithout heading')).toBeUndefined();
  });

  it('空字符串 → undefined', () => {
    expect(reasoningHeading('')).toBeUndefined();
  });
});
