import { describe, it, expect } from 'vitest';
import {
  parseCrontab,
  validateCrontab,
  describeCrontab,
  nextFireTimes,
  isLocallyComputable,
  defaultScheduleRange,
  validateScheduleRange,
  formatScheduleDateTime,
  zonedParts,
  CRON_PRESETS,
} from './crontab';

/**
 * crontab 纯函数的边界测试。
 *
 * 重点覆盖三类容易出错的地方：
 * 1. Quartz 方言的两条硬约束（日/周必须有一个 ?、不能同时为 *）—— 照搬 Linux crontab 就会错；
 * 2. 字段展开的写法覆盖（区间 / 步长 / 列表 / 别名 / 超界）；
 * 3. 下次触发时间的匹配与**时区**处理（同一表达式在不同时区必须给出不同的墙上时间）。
 */

describe('parseCrontab 语法解析', () => {
  it('接受 6 段与 7 段表达式，段数不对时给出可读错误', () => {
    expect(parseCrontab('0 0 2 * * ?').ok).toBe(true);
    expect(parseCrontab('0 0 2 * * ? 2027').ok).toBe(true);

    const five = parseCrontab('0 2 * * *');
    expect(five.ok).toBe(false);
    if (!five.ok) expect(five.error).toContain('6 或 7 段');

    expect(validateCrontab('').valid).toBe(false);
  });

  it('展开区间、步长、列表与别名', () => {
    const parsed = parseCrontab('0 0/15 8-10 * * ?');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.cron.minutes).toEqual([0, 15, 30, 45]);
    expect(parsed.cron.hours).toEqual([8, 9, 10]);

    const aliased = parseCrontab('0 30 2 ? JAN,MAR MON-FRI');
    expect(aliased.ok).toBe(true);
    if (!aliased.ok) return;
    expect(aliased.cron.months).toEqual([1, 3]);
    // Quartz 周字段：1=周日，因此 MON-FRI = 2,3,4,5,6
    expect(aliased.cron.daysOfWeek).toEqual([2, 3, 4, 5, 6]);
    expect(aliased.cron.dayOfMonthRestricted).toBe(false);
    expect(aliased.cron.dayOfWeekRestricted).toBe(true);
  });

  it('拒绝超出字段范围的取值', () => {
    expect(validateCrontab('0 0 24 * * ?').valid).toBe(false);
    expect(validateCrontab('0 60 2 * * ?').valid).toBe(false);
    expect(validateCrontab('0 0 2 32 * ?').valid).toBe(false);
    expect(validateCrontab('0 0 2 * 13 ?').valid).toBe(false);
    expect(validateCrontab('0 0 2 * * 8').valid).toBe(false);
  });

  it('强制 Quartz 的「日/周必须有一个 ?」约束', () => {
    // 两者都被限定：Quartz 会直接拒绝
    const both = parseCrontab('0 0 2 1 * MON');
    expect(both.ok).toBe(false);
    if (!both.ok) expect(both.error).toContain('"?"');

    // 两者都是 * ：等价于「既是每天又是每周一」，同样非法
    expect(parseCrontab('0 0 2 * * *').ok).toBe(false);

    // 日字段用 ? 则合法
    expect(parseCrontab('0 0 2 ? * MON').ok).toBe(true);
    // 周字段用 ? 则合法
    expect(parseCrontab('0 0 2 1 * ?').ok).toBe(true);
  });

  it('只有「日」「周」允许问号，其余字段写 ? 报错', () => {
    const res = parseCrontab('0 0 ? * * ?');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('时');
  });

  it('L 只在日字段被识别为"当月最后一天"', () => {
    const res = parseCrontab('0 0 2 L * ?');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.cron.lastDayOfMonth).toBe(true);
    expect(res.cron.needsServerPreview).toBe(false);
    // 周字段写 L 不合法（本工具仅支持日字段的 L）
    expect(parseCrontab('0 0 2 ? * L').ok).toBe(false);
  });

  it('W / # / nL 语法接受但标记为需要服务端预览（避免本地算出错误时间）', () => {
    const workday = parseCrontab('0 0 9 15W * ?');
    expect(workday.ok).toBe(true);
    if (!workday.ok) return;
    expect(workday.cron.needsServerPreview).toBe(true);
    expect(isLocallyComputable('0 0 9 15W * ?')).toBe(false);

    const nth = parseCrontab('0 0 9 ? * 6#3');
    expect(nth.ok).toBe(true);
    if (!nth.ok) return;
    expect(nth.cron.needsServerPreview).toBe(true);

    expect(isLocallyComputable('0 0 2 * * ?')).toBe(true);
  });

  it('拒绝明显的非法写法', () => {
    expect(validateCrontab('0 0 2 * * ??').valid).toBe(false);
    expect(validateCrontab('0 abc 2 * * ?').valid).toBe(false);
    expect(validateCrontab('0 5-1 2 * * ?').valid).toBe(false);
    expect(validateCrontab('0 1/0 2 * * ?').valid).toBe(false);
    expect(validateCrontab('0,,5 0 2 * * ?').valid).toBe(false);
  });
});

describe('nextFireTimes 下次触发时间推导', () => {
  const tz = 'Asia/Shanghai';

  it('每天 02:00 在指定时刻后给出连续 3 天', () => {
    const from = new Date('2026-03-01T10:00:00+08:00');
    const times = nextFireTimes('0 0 2 * * ?', 3, tz, from);
    expect(times).toEqual([
      '2026-03-02 02:00:00',
      '2026-03-03 02:00:00',
      '2026-03-04 02:00:00',
    ]);
  });

  it('同一天内的 02:00 尚未到达时应落在当天', () => {
    const from = new Date('2026-03-01T01:00:00+08:00');
    expect(nextFireTimes('0 0 2 * * ?', 1, tz, from)).toEqual(['2026-03-01 02:00:00']);
  });

  it('时区参与计算：同一基准时刻在两个时区落到不同的日期', () => {
    // 2026-03-02T06:00:00Z = 上海 2026-03-02 14:00（当天 02:00 已过）/ 纽约 2026-03-02 01:00（尚未到）
    const from = new Date('2026-03-02T06:00:00Z');
    // 上海要等到次日；纽约当天 02:00 还没到，落在同一天
    expect(nextFireTimes('0 0 2 * * ?', 1, 'Asia/Shanghai', from)).toEqual(['2026-03-03 02:00:00']);
    expect(nextFireTimes('0 0 2 * * ?', 1, 'America/New_York', from)).toEqual(['2026-03-02 02:00:00']);
  });

  it('返回的是目标时区下的墙上时间（与本地时区无关）', () => {
    // 同一基准时刻，两个时区都返回「各自时区的下一次 02:00」，即同为 `02:00:00` ——
    // 说明格式化走的是目标时区，而不是宿主机本地时区
    const from = new Date('2026-03-01T10:00:00Z');
    for (const tz of ['Asia/Shanghai', 'America/New_York', 'UTC']) {
      const [first] = nextFireTimes('0 0 2 * * ?', 1, tz, from);
      expect(first, tz).toMatch(/^\d{4}-\d{2}-\d{2} 02:00:00$/);
    }
  });

  it('按分钟推进能扫到每小时内的多个分钟', () => {
    const from = new Date('2026-03-01T10:00:30+08:00');
    const times = nextFireTimes('0 0/30 * * * ?', 3, tz, from);
    expect(times).toEqual([
      '2026-03-01 10:30:00',
      '2026-03-01 11:00:00',
      '2026-03-01 11:30:00',
    ]);
  });

  it('固定秒字段会被保留在结果里', () => {
    const from = new Date('2026-03-01T10:00:00+08:00');
    expect(nextFireTimes('30 0 11 * * ?', 1, tz, from)).toEqual(['2026-03-01 11:00:30']);
  });

  it('每月最后一天能正确翻月（含 2 月与闰年）', () => {
    const feb = nextFireTimes('0 0 2 L * ?', 1, tz, new Date('2026-02-01T00:00:00+08:00'));
    expect(feb).toEqual(['2026-02-28 02:00:00']);

    // 2028 是闰年：2 月有 29 天
    const leap = nextFireTimes('0 0 2 L * ?', 1, tz, new Date('2028-02-01T00:00:00+08:00'));
    expect(leap).toEqual(['2028-02-29 02:00:00']);

    // 12 月最后一天之后应跨到次年 1 月
    const yearEnd = nextFireTimes('0 0 2 L * ?', 1, tz, new Date('2026-12-30T00:00:00+08:00'));
    expect(yearEnd).toEqual(['2026-12-31 02:00:00']);
  });

  it('周一 02:00 落在下一个周一（Quartz 周字段 1=周日）', () => {
    // 2026-03-01 是周日
    expect(new Date('2026-03-01T00:00:00+08:00').getDay()).toBe(0);
    const times = nextFireTimes('0 0 2 ? * MON', 2, tz, new Date('2026-03-01T00:00:00+08:00'));
    expect(times).toEqual(['2026-03-02 02:00:00', '2026-03-09 02:00:00']);
  });

  it('表达式非法或含高级语法时返回空数组（交由服务端预览兜底）', () => {
    expect(nextFireTimes('bad', 1, tz)).toEqual([]);
    expect(nextFireTimes('0 0 2 ? * 6#3', 1, tz)).toEqual([]);
  });

  it('年字段被限定时只在指定年份触发，且跨年那一刻不丢触发点', () => {
    // 2027-01-01 00:00 是年字段命中的第一个时刻：按天跳跃必须精确落在 TZ 的 00:00，
    // 否则用「+24h」硬跳会越过凌晨、把这一分钟漏掉
    const times = nextFireTimes('0 0 0 1 1 ? 2027', 1, tz, new Date('2026-06-01T00:00:00+08:00'));
    expect(times).toEqual(['2027-01-01 00:00:00']);

    // 年字段只允许 2027，过完 2027 之后一年内都找不到下一次 -> 返回空
    expect(nextFireTimes('0 0 0 1 1 ? 2027', 1, tz, new Date('2028-01-02T00:00:00+08:00'))).toEqual([]);
  });

  it('上限保护：一年内不可能触发的表达式不会死循环，且要够快', () => {
    // 2 月 30 日永远不存在；按天跳跃应把 366 天扫完的时间压到毫秒级
    const started = Date.now();
    const times = nextFireTimes('0 0 2 30 2 ?', 1, tz, new Date('2026-01-01T00:00:00+08:00'));
    const elapsed = Date.now() - started;

    expect(times).toEqual([]);
    // 逐分钟空转需要 ~2.5s，按天跳跃后应远小于此；阈值放宽到 500ms 只用于挡住性能回退
    expect(elapsed).toBeLessThan(500);
  });
});

describe('describeCrontab 描述文本', () => {
  it('覆盖预设里的常见周期', () => {
    expect(describeCrontab('0 0 0 * * ?')).toBe('每天 00:00:00 执行');
    expect(describeCrontab('0 0 8 * * ?')).toBe('每天 08:00:00 执行');
    // 时间部分已表达周期时不再前置「每天」，避免读成「每天 每 5 分钟」
    expect(describeCrontab('0 0 * * * ?')).toBe('每小时第 0 分 执行');
    expect(describeCrontab('0 0/30 * * * ?')).toBe('每 30 分钟 执行');
    expect(describeCrontab('0 0/5 * * * ?')).toBe('每 5 分钟 执行');
  });

  it('描述周一与每月某日', () => {
    expect(describeCrontab('0 0 2 ? * MON')).toBe('每周一 02:00:00 执行');
    expect(describeCrontab('0 0 2 1 * ?')).toBe('每月 1 日 02:00:00 执行');
    expect(describeCrontab('0 0 2 L * ?')).toBe('每月最后一天 02:00:00 执行');
    expect(describeCrontab('0 0 2 ? * MON-FRI')).toBe('每个工作日 02:00:00 执行');
  });

  it('非法表达式返回空串而不是抛错', () => {
    expect(describeCrontab('nope')).toBe('');
  });
});

describe('生效区间与默认值', () => {
  it('默认区间为立即生效、长期有效', () => {
    const range = defaultScheduleRange(new Date('2026-03-01T10:20:30+08:00'), 'Asia/Shanghai');
    expect(range.startTime).toBe('2026-03-01 10:20:30');
    expect(range.endTime).toBe('2099-12-31 23:59:59');
  });

  it('校验起止时间格式与先后关系', () => {
    expect(validateScheduleRange('2026-03-01 00:00:00', '2026-03-02 00:00:00')).toBeNull();
    expect(validateScheduleRange('2026-3-1 0:0:0', '2026-03-02 00:00:00')).toContain('格式');
    expect(validateScheduleRange('2026-03-03 00:00:00', '2026-03-02 00:00:00')).toContain('不能晚于');
    expect(validateScheduleRange('2026-03-02 00:00:00', '2026-03-02 00:00:00')).toContain('不能相同');
    expect(validateScheduleRange('', '2026-03-02 00:00:00')).toContain('格式');
  });

  it('formatScheduleDateTime 按时区给出墙上时间', () => {
    const d = new Date('2026-03-01T00:00:00Z');
    expect(formatScheduleDateTime(d, 'UTC')).toBe('2026-03-01 00:00:00');
    expect(formatScheduleDateTime(d, 'Asia/Shanghai')).toBe('2026-03-01 08:00:00');
    expect(zonedParts(d, 'Asia/Shanghai').hour).toBe(8);
  });
});

describe('CRON_PRESETS', () => {
  it('每个预设本身都必须通过校验，且描述文本可用', () => {
    expect(CRON_PRESETS.length).toBeGreaterThan(0);
    for (const preset of CRON_PRESETS) {
      const res = validateCrontab(preset.value);
      expect(res.valid, `${preset.label} (${preset.value}) 应合法`).toBe(true);
      expect(describeCrontab(preset.value), `${preset.label} 应能生成描述`).not.toBe('');
    }
  });

  it('不含依赖服务端预览的高级语法，保证预设都能本地预览', () => {
    for (const preset of CRON_PRESETS) {
      expect(isLocallyComputable(preset.value), `${preset.label} 应可本地推导`).toBe(true);
    }
  });
});
