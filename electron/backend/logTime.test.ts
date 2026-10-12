// @vitest-environment node
/**
 * 日志时间本地化单测。
 *
 * 断言全部按「运行时主机时区」推导期望值（用 getTimezoneOffset 现算偏移），
 * 这样在任何时区的机器/CI 上都成立，不会写死 +08:00。
 */
import { describe, it, expect } from 'vitest';
import { toLocalIsoString, localizeLogTimestamps } from './logTime';

function pad(n: number, len = 2): string {
  return String(Math.abs(n)).padStart(len, '0');
}

/** 按主机时区拼出期望值，避免写死时区。 */
function expectedLocal(d: Date): string {
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin < 0 ? '-' : '+';
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `.${pad(d.getMilliseconds(), 3)}${sign}${pad(Math.trunc(offsetMin / 60))}:${pad(offsetMin % 60)}`
  );
}

describe('toLocalIsoString', () => {
  it('按主机时区渲染，带 ±HH:MM 偏移而非 Z', () => {
    const d = new Date('2026-10-11T16:41:37.108Z');
    const out = toLocalIsoString(d);
    expect(out).toBe(expectedLocal(d));
    expect(out.endsWith('Z')).toBe(false);
    expect(out).toMatch(/[+-]\d{2}:\d{2}$/);
  });

  it('毫秒补足 3 位', () => {
    const d = new Date('2026-10-11T16:41:37.008Z');
    expect(toLocalIsoString(d)).toBe(expectedLocal(d));
    expect(toLocalIsoString(d)).toContain('.008');
  });

  it('与原时刻等价，可被 Date 解析回同一时间戳', () => {
    const d = new Date('2026-01-02T03:04:05.678Z');
    expect(new Date(toLocalIsoString(d)).getTime()).toBe(d.getTime());
  });

  it('默认参数为当前时间', () => {
    const before = Date.now();
    const parsed = new Date(toLocalIsoString()).getTime();
    expect(parsed).toBeGreaterThanOrEqual(before - 1000);
    expect(parsed).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe('localizeLogTimestamps', () => {
  it('改写 sidecar 行内 UTC timestamp 为本地时区', () => {
    const line =
      'timestamp=2026-10-11T16:41:37.108Z level=INFO run=06093b0a message=loop session.id=ses_ed42';
    const out = localizeLogTimestamps(line);
    const expected = toLocalIsoString(new Date('2026-10-11T16:41:37.108Z'));
    expect(out).toBe(
      `timestamp=${expected} level=INFO run=06093b0a message=loop session.id=ses_ed42`,
    );
    expect(out).not.toContain('Z level=INFO');
  });

  it('改写带显式偏移的时间戳（转到主机时区）', () => {
    const out = localizeLogTimestamps('at 2026-10-11T16:41:37Z and 2026-10-11T16:41:37+00:00');
    // 无毫秒的输入补足 .000
    const expected = toLocalIsoString(new Date('2026-10-11T16:41:37Z'));
    expect(out).toBe(`at ${expected} and ${expected}`);
  });

  it('幂等：已经是本地偏移的字符串不再变化', () => {
    const once = localizeLogTimestamps('timestamp=2026-10-11T16:41:37.108Z msg=ok');
    expect(localizeLogTimestamps(once)).toBe(once);
  });

  it('无时间戳的文本原样返回', () => {
    const plain = 'message="global event connected" session.id=ses_1';
    expect(localizeLogTimestamps(plain)).toBe(plain);
  });

  it('一整行多字段只换时间戳，其余字段不动', () => {
    const src =
      'timestamp=2026-10-11T16:41:42.736Z level=INFO run=06093b0a message="global event connected"';
    const out = localizeLogTimestamps(src);
    expect(out).toContain('level=INFO run=06093b0a message="global event connected"');
  });

  it('不匹配裸日期与不含秒的片段', () => {
    expect(localizeLogTimestamps('build 2026-10-11 done')).toBe('build 2026-10-11 done');
    expect(localizeLogTimestamps('2026-10-11T16:41 session')).toBe('2026-10-11T16:41 session');
  });
});
