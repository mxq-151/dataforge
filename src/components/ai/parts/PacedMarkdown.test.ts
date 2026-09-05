/**
 * PacedMarkdown.findStableSplit — 稳定前缀拆分逻辑单元测试
 *
 * 验证「空行（段落）边界优先 + 活动尾部上限 + 围栏代码块原子」的拆分规则，
 * 这是长回复下 Markdown 分块增量渲染正确性与性能的关键。
 */

import { describe, it, expect } from 'vitest';
import { findStableSplit, MAX_ACTIVE_CHARS } from './PacedMarkdown';

function split(text: string): { stable: string; active: string } {
  const s = findStableSplit(text);
  return { stable: text.slice(0, s), active: text.slice(s) };
}

describe('findStableSplit', () => {
  it('在空行边界拆分段落', () => {
    expect(split('para1\n\npara2')).toEqual({ stable: 'para1\n\n', active: 'para2' });
  });

  it('列表整体固化，不拆散成多个块', () => {
    expect(split('- a\n- b\n- c\n\nnext')).toEqual({
      stable: '- a\n- b\n- c\n\n',
      active: 'next',
    });
  });

  it('表格 + 空行整体固化', () => {
    expect(split('|a|b|\n|---|---|\n\n')).toEqual({
      stable: '|a|b|\n|---|---|\n\n',
      active: '',
    });
  });

  it('围栏代码块保持原子，不从中拆分', () => {
    expect(split('```java\ncode\n```\n\nnext')).toEqual({
      stable: '```java\ncode\n```\n\n',
      active: 'next',
    });
  });

  it('未闭合的围栏代码块整体留在活动尾部', () => {
    expect(split('```\nx\ny\n```')).toEqual({ stable: '', active: '```\nx\ny\n```' });
  });

  it('~~~ 波浪线围栏同样保持原子', () => {
    expect(split('~~~\ncode\n~~~\n\nafter')).toEqual({
      stable: '~~~\ncode\n~~~\n\n',
      active: 'after',
    });
  });

  it('四反引号围栏按完整开启标记闭合', () => {
    expect(split('````java\ncode\n````\n\nafter')).toEqual({
      stable: '````java\ncode\n````\n\n',
      active: 'after',
    });
  });

  it('无空行时退化为换行边界', () => {
    expect(split('a\nb\nc')).toEqual({ stable: 'a\nb\n', active: 'c' });
  });

  it('单行文本无安全边界', () => {
    expect(split('hello')).toEqual({ stable: '', active: 'hello' });
  });

  it('最后一个仍在增长的行不被固化', () => {
    expect(split('para\nnext line')).toEqual({ stable: 'para\n', active: 'next line' });
  });

  it('超长列表无空行时活动尾部被限制为最后一行', () => {
    const text = '- ' + Array(100).fill('item').join('\n- ');
    const { active } = split(text);
    expect(active).toBe('- item');
  });

  it('活动尾部超过上限时退化为换行边界', () => {
    // 超过 MAX_ACTIVE_CHARS 的长内容（无空行），前面有一个空行边界
    const body = Array.from({ length: 20 }, (_, i) => `line${i} ` + 'x'.repeat(80)).join('\n');
    expect(body.length).toBeGreaterThan(MAX_ACTIVE_CHARS);
    const { active } = split('para1\n\n' + body);
    expect(active.length).toBeLessThan(MAX_ACTIVE_CHARS);
    expect(active).not.toContain('\n'); // 活动尾部退化为最后一行
  });
});
