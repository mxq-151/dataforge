import { describe, it, expect, vi } from 'vitest';
import {
  stabilizeIncompleteResult,
  hoverIsComplete,
  hoverContentLen,
} from './stabilizeHover';

// 直接使用与 provideHover 完全一致的共享判定函数，保证单测验证的就是线上逻辑。
const isComplete = hoverIsComplete;
const contentLen = hoverContentLen;

// 用小退避做测试，只验证算法决策，不测真实时长。
const FAST_DELAYS = [1, 2, 4, 8];

// 单行内容（无换行）。短(<60)或长(>=60 但无换行)都可能被判「不完整」——后者正是本缺陷：
// 冷窗口返回的「长类型签名」长度为>=60 但无文档/无换行，绝不能误判为完整。
const single = (len: number) => ({ contents: 'x'.repeat(len) });

// 多行内容（有换行，模拟「签名 + scaladoc 文档」）→ 完整。
const doc = (sigLen: number, docLen: number) => ({
  contents: 'x'.repeat(sigLen) + '\n' + 'y'.repeat(docLen),
});

describe('hover 判定：hoverIsComplete/hoverContentLen', () => {
  it('多行且长度足够 → 完整', () => {
    expect(isComplete(doc(60, 40))).toBe(true);
  });

  it('短内容（<60）→ 不完整', () => {
    expect(isComplete(single(30))).toBe(false);
    expect(contentLen(single(30))).toBe(30);
  });

  it('长但单行无文档（>=60 无换行）→ 不完整（旧逻辑会误判为完整而固定）', () => {
    // 关键回归：这一条在「仅按长度>=60」的旧判定下会返回 true，
    // 从而被当作最终结果缓存 60s，导致同一符号重试内容都一样、一直看不到文档。
    expect(contentLen(single(70))).toBe(70);
    expect(contentLen(single(70)) >= 60).toBe(true);
    expect(isComplete(single(70))).toBe(false);
  });

  it('数组内容（MarkedString：字符串或 {value}）：任一元素完整即完整', () => {
    // 数组元素是 MarkedString：要么是字符串，要么是 {language, value}
    expect(isComplete({ contents: ['x'.repeat(30), 'x'.repeat(60) + '\n' + 'y'.repeat(40)] })).toBe(true);
    expect(isComplete({ contents: [{ value: 'x'.repeat(60) + '\n' + 'y'.repeat(40) }, 'x'.repeat(10)] })).toBe(true);
    // 长单行签名（>=60 无换行）+ 短文本 → 仍不完整
    expect(isComplete({ contents: ['x'.repeat(70), 'x'.repeat(30)] })).toBe(false);
    expect(isComplete({ contents: [{ value: 'x'.repeat(70) }, { value: 'x'.repeat(30) }] })).toBe(false);
  });
});

describe('stabilizeIncompleteResult（Scala/Metals hover 稳定化）', () => {
  it('首次结果已完整 → 零额外请求直接返回', async () => {
    const request = vi.fn();
    const r = await stabilizeIncompleteResult(doc(60, 40), request, contentLen, isComplete, FAST_DELAYS);
    expect(isComplete(r)).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it('冷窗口内内容逐次增长 → 重试到完整后提前返回（修复核心场景）', async () => {
    const calls: any[] = [single(20), single(35), doc(60, 40)];
    const request = vi.fn().mockImplementation(() => calls.shift() ?? doc(60, 40));
    const r = await stabilizeIncompleteResult(single(12), request, contentLen, isComplete, FAST_DELAYS);
    expect(isComplete(r)).toBe(true);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('内容持续增长但一直未完整 → 用尽所有退避后返回最佳结果', async () => {
    const seq = [single(20), single(30), single(40), single(50)];
    let i = 0;
    const request = vi.fn().mockImplementation(() => seq[Math.min(i++, seq.length - 1)]);
    const r = await stabilizeIncompleteResult(single(10), request, contentLen, isComplete, FAST_DELAYS);
    expect(request).toHaveBeenCalledTimes(FAST_DELAYS.length);
    expect(contentLen(r)).toBe(50);
    expect(isComplete(r)).toBe(false);
  });

  it('无文档符号（内容稳定不增长）→ 过了 settle 窗口后连续无增长即提前结束', async () => {
    const request = vi.fn().mockResolvedValue(single(30));
    const r = await stabilizeIncompleteResult(single(30), request, contentLen, isComplete, FAST_DELAYS, 2, 0);
    expect(request).toHaveBeenCalledTimes(2);
    expect(isComplete(r)).toBe(false);
    expect(contentLen(r)).toBe(30);
  });

  it('冷窗口内平台期后内容才出现 → 不能因连续无增长提前退出，须等到完整内容', async () => {
    const seq = [single(20), single(20), doc(60, 40)];
    const request = vi.fn().mockImplementation(() => seq.shift() ?? doc(60, 40));
    // 默认 settleTime=5000：前两个平台期未过冷启动窗口，不得提前退出，须等到完整内容
    const r = await stabilizeIncompleteResult(single(20), request, contentLen, isComplete, [100, 100, 800]);
    expect(isComplete(r)).toBe(true);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('无文档但停留未超过 settleTime → 不提前退出；越过 settleTime 后仍无增长才退出', async () => {
    const request = vi.fn().mockResolvedValue(single(20));
    const r = await stabilizeIncompleteResult(single(20), request, contentLen, isComplete, [100, 100, 100], 2, 300);
    expect(request).toHaveBeenCalledTimes(3);
    expect(isComplete(r)).toBe(false);
    expect(contentLen(r)).toBe(20);
  });

  it('长单行签名被误判为完整 → 不得停止重试，须重试到带文档内容（修复"重试都一样"）', async () => {
    // 冷窗口返回长度>=70 的单行类型签名（无 scaladoc），旧判定会误判为「完整」→ 立即返回并缓存固定
    const coldSig = single(70);
    const seq = [coldSig, doc(60, 40)];
    const request = vi.fn().mockImplementation(() => seq.shift() ?? doc(60, 40));
    const r = await stabilizeIncompleteResult(coldSig, request, contentLen, isComplete, FAST_DELAYS, 2, 0);
    expect(isComplete(r)).toBe(true);
    expect(contentLen(r)).toBeGreaterThan(70);
    expect(request).toHaveBeenCalled();
  });

  it('请求抛错不中断，继续后续重试', async () => {
    let calls = 0;
    const request = vi.fn().mockImplementation(() => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('boom'));
      return Promise.resolve(doc(60, 40));
    });
    const r = await stabilizeIncompleteResult(single(15), request, contentLen, isComplete, FAST_DELAYS);
    expect(isComplete(r)).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('首次即 null（服务器无返回）→ 仍重试直至拿到完整', async () => {
    const seq = [null, single(0), doc(60, 40)];
    const request = vi.fn().mockImplementation(() => seq.shift() ?? doc(60, 40));
    const r = await stabilizeIncompleteResult(null, request, contentLen, isComplete, FAST_DELAYS);
    expect(isComplete(r)).toBe(true);
  });
});

describe('provideHover 缓存不变式（仅完整结果入缓存，避免不完整被固定 60s）', () => {
  interface Entry {
    t: number;
    result: any;
    complete: boolean;
  }
  const TTL = 60_000;
  // 与 provideHover 相同的写入规则：只有完整结果才入缓存
  const put = (cache: Map<string, Entry>, key: string, result: any) => {
    if (result && hoverIsComplete(result)) {
      cache.set(key, { t: Date.now(), result, complete: true });
    }
  };
  const hit = (cache: Map<string, Entry>, key: string): any => {
    const e = cache.get(key);
    return e && e.complete && Date.now() - e.t < TTL ? e.result : null;
  };

  it('冷长签名（无文档）不会因被误判完整而进入缓存固定 → 再次悬停拿到完整文档', async () => {
    const cache = new Map<string, Entry>();
    const key = 'hover|a.scala#3:5';

    // 模拟一次完整的提供链：首次(initial)返回冷长签名，稳定化重试后返回带文档内容
    const next = (() => {
      let calls = 0;
      return async () => {
        calls += 1;
        return calls === 1 ? single(70) : doc(60, 40);
      };
    })();
    const r1 = await stabilizeIncompleteResult(await next(), next, contentLen, isComplete, FAST_DELAYS, 2, 0);
    put(cache, key, r1);

    // 缓存中只允许存在「完整」结果
    const cached = cache.get(key);
    expect(cached?.complete).toBe(true);
    expect(hoverIsComplete(cached!.result)).toBe(true);

    // 再次悬停：命中缓存，拿到的是完整文档
    const r2 = hit(cache, key);
    expect(hoverIsComplete(r2)).toBe(true);
    expect(hoverContentLen(r2)).toBeGreaterThan(70);
  });

  it('不完整结果绝不写入缓存（即使已过 settle 的稳定短内容）', async () => {
    const cache = new Map<string, Entry>();
    const key = 'hover|a.scala#9:2';
    put(cache, key, single(30)); // 无文档稳定短内容
    expect(cache.has(key)).toBe(false);
    expect(hit(cache, key)).toBeNull();
  });
});