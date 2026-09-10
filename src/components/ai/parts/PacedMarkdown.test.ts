/**
 * PacedMarkdown.findStableSplit — 稳定前缀拆分逻辑单元测试
 *
 * 验证「空行（段落）边界优先 + 活动尾部上限 + 围栏代码块原子」的拆分规则，
 * 这是长回复下 Markdown 分块增量渲染正确性与性能的关键。
 */

import { describe, it, expect } from 'vitest';
import { findStableSplit, splitStableBlocks, MAX_ACTIVE_CHARS } from './PacedMarkdown';

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

describe('splitStableBlocks — 稳定前缀分块', () => {
  // 分块的意义：前缀前进时只需解析新增的块，历史块复用元素，把
  // 「前缀每前进一段就整段重解析」的 O(n²) 降为 O(n)。
  // 这里重点验证「分块不破坏 Markdown 语义」的保守规则。

  it('按空行把段落切成多块', () => {
    expect(splitStableBlocks('p1\n\np2\n\np3\n\n')).toEqual(['p1\n\n', 'p2\n\n', 'p3\n\n']);
  });

  it('块的拼接结果与原文本完全一致（不丢字符）', () => {
    const text = '# 标题\n\n段落一\n\n- a\n- b\n\n```java\ncode\n```\n\n|a|b|\n|---|---|\n\n尾部\n\n';
    expect(splitStableBlocks(text).join('')).toBe(text);
  });

  it('围栏代码块内的空行不切分（代码块保持单块）', () => {
    const text = '```java\na\n\nb\n```\n\nafter\n\n';
    expect(splitStableBlocks(text)).toEqual(['```java\na\n\nb\n```\n\n', 'after\n\n']);
  });

  it('列表整体保留在同一块内（不拆成多个 <ul>）', () => {
    expect(splitStableBlocks('- a\n- b\n- c\n\nnext\n\n')).toEqual(['- a\n- b\n- c\n\n', 'next\n\n']);
  });

  it('缩进 1~3 空格的续行块与前一块合并（避免拆散列表续行）', () => {
    expect(splitStableBlocks('para\n\n  continued\n\n')).toEqual(['para\n\n  continued\n\n']);
  });

  it('引用式链接定义所在块与其后续块合并（避免引用解析失败）', () => {
    const text = '[ref]: https://example.com\n\n正文\n\n';
    expect(splitStableBlocks(text)).toEqual([text]);
  });

  it('GFM 脚注定义同样触发合并', () => {
    const text = '[^1]: 脚注内容\n\n正文\n\n';
    expect(splitStableBlocks(text)).toEqual([text]);
  });

  it('缩进 4 空格是独立代码块，不与前一块合并', () => {
    expect(splitStableBlocks('para\n\n    code\n\n')).toEqual(['para\n\n', '    code\n\n']);
  });

  it('空文本返回空数组', () => {
    expect(splitStableBlocks('')).toEqual([]);
  });

  it('后缀增长时既有前缀的块划分保持不变', () => {
    // 这是分块缓存生效的前提：文本追加后，前面的块必须逐字不变，
    // 才能命中缓存、避免重解析。
    const head = 'p1\n\np2\n\n';
    const before = splitStableBlocks(head);
    const after = splitStableBlocks(head + 'p3\n\n');
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toHaveLength(before.length + 1);
  });
});
