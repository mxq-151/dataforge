// @vitest-environment jsdom
/**
 * SessionSwitcher.delete.test.tsx — 任务历史下拉框「删除」的可用性
 *
 * 覆盖点（对应用户反馈「有些可以删除，有些删除不了」）：
 * 1. 列表里每一行都必须有删除按钮，且点击（含点在图标 SVG 上）只触发删除，
 *    不得冒泡成整行的「切换会话」——否则观感就是「点了没反应/删不掉」。
 * 2. 下拉框内部滚动（任务列表自身有滚动条：max-height 300px + overflow-y:auto）
 *    不得关闭下拉框；否则列表底部的会话永远够不着，也就永远删不掉。
 * 3. 下拉框之外的滚动仍然关闭下拉框（原有的防错位行为不能丢）。
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import SessionSwitcher from './SessionSwitcher';
import type { TaskRecord } from '../../hooks/opencode/useOpencodeClient';

function makeTasks(n: number): TaskRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    sessionId: `s${i + 1}`,
    title: `会话 ${i + 1}`,
    createdAt: 1_700_000_000_000 + i,
    updatedAt: 1_700_000_000_000 + i,
  }));
}

function renderSwitcher(tasks: TaskRecord[], currentSessionId: string | null = null) {
  const onDeleteSession = vi.fn();
  const onSwitchSession = vi.fn(async () => { /* noop */ });
  const onNewSession = vi.fn(async () => { /* noop */ });
  const onRenameSession = vi.fn();

  const utils = render(
    <SessionSwitcher
      currentSessionId={currentSessionId}
      tasks={tasks}
      onNewSession={onNewSession}
      onSwitchSession={onSwitchSession}
      onDeleteSession={onDeleteSession}
      onRenameSession={onRenameSession}
    />,
  );
  // 打开下拉框
  fireEvent.click(screen.getByTitle('切换任务'));
  return { ...utils, onDeleteSession, onSwitchSession, onNewSession, onRenameSession };
}

describe('SessionSwitcher 任务历史删除', () => {
  it('每一行都有删除按钮，点图标即删除且不触发切换会话', () => {
    const tasks = makeTasks(8);
    const { onDeleteSession, onSwitchSession } = renderSwitcher(tasks, 's1');

    const deleteButtons = screen.getAllByTitle('删除');
    expect(deleteButtons).toHaveLength(8);

    // 点最后一行（列表底部的会话）的删除图标
    const lastBtn = deleteButtons[7];
    const svg = lastBtn.querySelector('svg');
    expect(svg).not.toBeNull();
    fireEvent.click(svg!);

    expect(onDeleteSession).toHaveBeenCalledTimes(1);
    expect(onDeleteSession).toHaveBeenCalledWith('s8');
    expect(onSwitchSession).not.toHaveBeenCalled();
  });

  it('逐行点击删除：每一行都能删（不因位置/长标题失效）', () => {
    const tasks = makeTasks(6);
    const { onDeleteSession, onSwitchSession } = renderSwitcher(tasks);

    screen.getAllByTitle('删除').forEach(btn => {
      fireEvent.click(btn);
    });

    expect(onDeleteSession.mock.calls.map(c => c[0])).toEqual(['s1', 's2', 's3', 's4', 's5', 's6']);
    expect(onSwitchSession).not.toHaveBeenCalled();
  });

  it('下拉框内部滚动不关闭下拉框（否则底部会话无法操作）', () => {
    const { container } = renderSwitcher(makeTasks(8));

    const list = container.querySelector('.ai-panel__session-list') as HTMLElement;
    expect(list).not.toBeNull();

    fireEvent.scroll(list);

    // 仍然打开：删除按钮还能点到
    expect(screen.getAllByTitle('删除')).toHaveLength(8);
    expect(screen.getByTitle('切换任务')).toBeTruthy();
  });

  it('下拉框之外的滚动仍然关闭下拉框', () => {
    renderSwitcher(makeTasks(3));

    expect(screen.getAllByTitle('删除')).toHaveLength(3);

    fireEvent.scroll(window);

    expect(screen.queryByTitle('删除')).toBeNull();
  });

  it('点击行本身是切换会话（删除按钮除外），行内点击不会误触发删除', () => {
    const { container, onDeleteSession, onSwitchSession } = renderSwitcher(makeTasks(3));

    const rows = container.querySelectorAll('.ai-panel__session-item');
    fireEvent.click(rows[1]);

    expect(onSwitchSession).toHaveBeenCalledWith('s2');
    expect(onDeleteSession).not.toHaveBeenCalled();
  });

  it('进入重命名的那一行仍然保留删除按钮，且删除只删这一行', () => {
    const { onDeleteSession, onRenameSession, onSwitchSession } = renderSwitcher(makeTasks(3));

    // 点第 2 行的「重命名」→ 该行切换为编辑态
    fireEvent.click(screen.getAllByTitle('重命名')[1]);
    expect(screen.getAllByTitle('删除')).toHaveLength(3);
    expect(screen.getAllByTitle('重命名')).toHaveLength(2);

    fireEvent.click(screen.getAllByTitle('删除')[1]);

    expect(onDeleteSession).toHaveBeenCalledTimes(1);
    expect(onDeleteSession).toHaveBeenCalledWith('s2');
    expect(onRenameSession).not.toHaveBeenCalled();
    expect(onSwitchSession).not.toHaveBeenCalled();
  });
});

describe('SessionSwitcher 删除按钮命中区', () => {
  beforeEach(() => {
    // 用例只依赖 DOM 结构与事件，不加载 CSS；按下述类名断言结构约定
  });
  afterEach(() => {
    cleanup();
  });

  it('删除/重命名按钮都带 type=button（避免自定义容器内被当作提交按钮）', () => {
    renderSwitcher(makeTasks(2));

    expect(screen.getAllByTitle('删除').every(b => b.getAttribute('type') === 'button')).toBe(true);
    expect(screen.getAllByTitle('重命名').every(b => b.getAttribute('type') === 'button')).toBe(true);
  });
});
