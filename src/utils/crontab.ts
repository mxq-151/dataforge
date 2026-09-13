import { DEFAULT_SCHEDULE_TIMEZONE } from '../types/dolphinscheduler';

/**
 * DolphinScheduler 定时调度表达式（Quartz crontab）的纯函数工具集。
 *
 * 为什么要有这一层：
 * 1. DS 的 crontab 是 **Quartz** 方言（6 或 7 段、周字段 1=周日、日/周必须有一个为 `?`），
 *    与 Linux `crontab -e` 的 5 段格式不同，直接照搬会静默算出错误的时间；
 * 2. 表单需要在**不打扰后端**的前提下即时反馈语法是否合法、下次什么时候跑
 *    （与模块里「搜索框输入不自动请求」的约定一致，逐字符校验不发请求）；
 * 3. 这些规则是纯逻辑、边界多，抽成纯函数才好写单测把边界钉死。
 *
 * 权威口径仍然是调度系统本身：保存时由 DS 校验 crontab，`schedule.preview` 接口可拿到
 * 服务端算出的触发时间。本文件的 `nextFireTimes` 是**本地推导**，只覆盖 Quartz 的常用子集
 * （`* , - /` 与日字段的 `L`）；遇到 `W`、`#`、`周L` 这类高级语法时返回空数组并置
 * `needsServerPreview`，由调用方改走服务端预览，绝不给出可能错误的时间。
 */

/** Quartz 字段规格：索引 0..6 依次为 秒 分 时 日 月 周 [年] */
interface FieldSpec {
  key: string;
  label: string;
  min: number;
  max: number;
  /** 别名（仅月、周有） */
  aliases?: Record<string, number>;
  /** 是否允许 `?`（仅日、周允许） */
  allowQuestion: boolean;
  /** 是否允许 `L`（日字段表示当月最后一天） */
  allowLast?: boolean;
}

const MONTH_ALIASES: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

/** Quartz 周字段：1=周日 … 7=周六（与 JS 的 0=周日 差 1） */
const DOW_ALIASES: Record<string, number> = {
  SUN: 1, MON: 2, TUE: 3, WED: 4, THU: 5, FRI: 6, SAT: 7,
};

const DOW_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const FIELD_SPECS: FieldSpec[] = [
  { key: 'second', label: '秒', min: 0, max: 59, allowQuestion: false },
  { key: 'minute', label: '分', min: 0, max: 59, allowQuestion: false },
  { key: 'hour', label: '时', min: 0, max: 23, allowQuestion: false },
  { key: 'dayOfMonth', label: '日', min: 1, max: 31, allowQuestion: true, allowLast: true },
  { key: 'month', label: '月', min: 1, max: 12, aliases: MONTH_ALIASES, allowQuestion: false },
  { key: 'dayOfWeek', label: '周', min: 1, max: 7, aliases: DOW_ALIASES, allowQuestion: true },
  { key: 'year', label: '年', min: 1970, max: 2099, allowQuestion: false },
];

/** 单字段解析结果 */
interface FieldResult {
  /** 展开后的取值（升序去重） */
  values: number[];
  /** 是否为 `*` 或 `?`（即"全量"） */
  wildcard: boolean;
  /** 是否显式写了 `?` */
  question: boolean;
  /** 含本地推导不支持的语法（W / # / nL） */
  needsServerPreview: boolean;
  /** 日字段的 `L`（当月最后一天） */
  lastDayOfMonth: boolean;
  /** 原始文本，用于描述文本回显 */
  raw: string;
}

export interface ParsedCron {
  /** 去空格后的原始表达式 */
  expression: string;
  seconds: number[];
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
  /** 年字段（未写时为 null） */
  years: number[] | null;
  /** 日字段是否被限定（非 `?`），用于决定是否参与日期匹配 */
  dayOfMonthRestricted: boolean;
  /** 周字段是否被限定（非 `?`） */
  dayOfWeekRestricted: boolean;
  lastDayOfMonth: boolean;
  /** 需要改走服务端预览（本地推导无法覆盖该语法） */
  needsServerPreview: boolean;
}

export type CrontabParseResult =
  | { ok: true; cron: ParsedCron }
  | { ok: false; error: string };

function expandRange(min: number, max: number): number[] {
  const out: number[] = [];
  for (let v = min; v <= max; v++) out.push(v);
  return out;
}

function dedupeSorted(values: number[]): number[] {
  return Array.from(new Set(values)).sort((a, b) => a - b);
}

/** 解析单个数值 token（支持别名，大小写不敏感） */
function parseValueToken(token: string, spec: FieldSpec): number | null {
  const upper = token.toUpperCase();
  const aliased = spec.aliases?.[upper];
  if (aliased !== undefined) return aliased;
  if (!/^\d+$/.test(token)) return null;
  const n = Number(token);
  if (!Number.isInteger(n) || n < spec.min || n > spec.max) return null;
  return n;
}

/**
 * 解析单个字段。
 *
 * 支持的语法：`*` `?` 单值、`a-b` 区间、`a-b/n` 步长、`a/n`、「星号除 n」步长、逗号列表，
 * 以及日字段的 `L`。`W`、`#`、`nL`（周字段的"最后一个周几"）语法上接受但标记为
 * 需要服务端预览 —— 宁可让用户去问调度系统，也不本地算错时间。
 */
function parseField(raw: string, spec: FieldSpec): FieldResult | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { error: `${spec.label} 字段不能为空` };
  }

  if (trimmed === '?') {
    if (!spec.allowQuestion) {
      return { error: `${spec.label} 字段不支持 "?"（仅「日」「周」可用）` };
    }
    return {
      values: expandRange(spec.min, spec.max),
      wildcard: true,
      question: true,
      needsServerPreview: false,
      lastDayOfMonth: false,
      raw: trimmed,
    };
  }

  if (trimmed === '*') {
    return {
      values: expandRange(spec.min, spec.max),
      wildcard: true,
      question: false,
      needsServerPreview: false,
      lastDayOfMonth: false,
      raw: trimmed,
    };
  }

  const values: number[] = [];
  let needsServerPreview = false;
  let lastDayOfMonth = false;

  for (const part of trimmed.split(',')) {
    const token = part.trim();
    if (!token) {
      return { error: `${spec.label} 字段「${trimmed}」含空的列表项` };
    }

    // 日字段的 L：当月最后一天
    if (spec.allowLast && /^L$/i.test(token)) {
      lastDayOfMonth = true;
      needsServerPreview = false;
      continue;
    }

    // 高级语法：W（最近工作日）、#（第 n 个周几）、nL（最后一个周几）
    if (/^\d+W$/i.test(token) || /^\d+#\d+$/i.test(token) || /^\d+L$/i.test(token)) {
      if (!spec.allowQuestion) {
        return { error: `${spec.label} 字段不支持「${token}」` };
      }
      needsServerPreview = true;
      continue;
    }
    if (/^LW$/i.test(token) || /^L-\d+$/i.test(token)) {
      if (!spec.allowLast) {
        return { error: `${spec.label} 字段不支持「${token}」` };
      }
      needsServerPreview = true;
      continue;
    }

    // [起始值]-[结束值](/步长) | 起始值(/步长) | */步长
    const stepSplit = token.split('/');
    if (stepSplit.length > 2) {
      return { error: `${spec.label} 字段「${token}」步长写法不合法` };
    }
    const hasStep = stepSplit.length === 2;
    const [rangePart, stepPart] = stepSplit;

    let step = 1;
    if (hasStep) {
      if (!/^\d+$/.test(stepPart)) {
        return { error: `${spec.label} 字段「${token}」的步长必须是正整数` };
      }
      step = Number(stepPart);
      if (step < 1) {
        return { error: `${spec.label} 字段「${token}」的步长必须大于 0` };
      }
    }

    let start: number;
    let end: number;

    if (rangePart === '*') {
      if (!hasStep) {
        // 单独一个 * （与列表混写，如 "*,5"）等价于全量
        return {
          values: expandRange(spec.min, spec.max),
          wildcard: true,
          question: false,
          needsServerPreview: false,
          lastDayOfMonth: false,
          raw: trimmed,
        };
      }
      start = spec.min;
      end = spec.max;
    } else if (rangePart.includes('-')) {
      const bounds = rangePart.split('-');
      if (bounds.length !== 2) {
        return { error: `${spec.label} 字段「${token}」区间写法不合法` };
      }
      const lo = parseValueToken(bounds[0], spec);
      const hi = parseValueToken(bounds[1], spec);
      if (lo === null || hi === null) {
        return { error: `${spec.label} 字段「${token}」的取值超出 ${spec.min}-${spec.max}` };
      }
      if (lo > hi) {
        return { error: `${spec.label} 字段「${token}」区间起点不能大于终点` };
      }
      start = lo;
      end = hi;
    } else {
      const single = parseValueToken(rangePart, spec);
      if (single === null) {
        return { error: `${spec.label} 字段「${token}」不是合法取值（允许 ${spec.min}-${spec.max}）` };
      }
      start = single;
      end = hasStep ? spec.max : single;
    }

    for (let v = start; v <= end; v += step) {
      values.push(v);
    }
  }

  if (values.length === 0 && !lastDayOfMonth && !needsServerPreview) {
    return { error: `${spec.label} 字段「${trimmed}」没有可用的取值` };
  }

  return {
    values: dedupeSorted(values),
    wildcard: false,
    question: false,
    needsServerPreview,
    lastDayOfMonth,
    raw: trimmed,
  };
}

/**
 * 解析 Quartz crontab（6 或 7 段）。
 *
 * 除语法外还校验两条 Quartz 硬约束，它们是最常见的踩坑点：
 * - 「日」与「周」必须至少有一个是 `?`（Quartz 不允许两者同时被限定）；
 * - 「日」与「周」不能同时为 `*`（等价于"既是每天又是每周几"，Quartz 同样拒绝）。
 */
export function parseCrontab(expression: string): CrontabParseResult {
  const expr = String(expression ?? '').trim();
  if (!expr) return { ok: false, error: '请输入 crontab 表达式' };

  const parts = expr.split(/\s+/);
  if (parts.length !== 6 && parts.length !== 7) {
    return {
      ok: false,
      error: `需要 6 或 7 段（秒 分 时 日 月 周 [年]），当前是 ${parts.length} 段`,
    };
  }

  const specs = parts.length === 6 ? FIELD_SPECS.slice(0, 6) : FIELD_SPECS;
  const results: FieldResult[] = [];

  for (let i = 0; i < parts.length; i++) {
    const parsed = parseField(parts[i], specs[i]);
    if ('error' in parsed) return { ok: false, error: parsed.error };
    results.push(parsed);
  }

  const dom = results[3];
  const dow = results[5];
  if (!dom.question && !dow.question) {
    return { ok: false, error: '「日」与「周」必须有一个为 "?"（Quartz 语法要求）' };
  }

  return {
    ok: true,
    cron: {
      expression: expr,
      seconds: results[0].values,
      minutes: results[1].values,
      hours: results[2].values,
      daysOfMonth: dom.values,
      months: results[4].values,
      daysOfWeek: dow.values,
      years: parts.length === 7 ? results[6].values : null,
      dayOfMonthRestricted: !dom.question,
      dayOfWeekRestricted: !dow.question,
      lastDayOfMonth: dom.lastDayOfMonth,
      needsServerPreview: results.some(r => r.needsServerPreview),
    },
  };
}

export interface CronValidationResult {
  valid: boolean;
  error?: string;
}

/** 表单即时校验：只返回是否合法与原因，成功时不含多余数据 */
export function validateCrontab(expression: string): CronValidationResult {
  const parsed = parseCrontab(expression);
  return parsed.ok ? { valid: true } : { valid: false, error: parsed.error };
}

/** 是否为本地可推导的表达式（含 W / # / nL 等高级语法时需走服务端预览） */
export function isLocallyComputable(expression: string): boolean {
  const parsed = parseCrontab(expression);
  return parsed.ok && !parsed.cron.needsServerPreview;
}

/** 判断数组是否为等差数列（步长一致），返回步长；否则返回 0 */
function arithmeticStep(values: number[]): number {
  if (values.length < 2) return 0;
  const step = values[1] - values[0];
  if (step <= 0) return 0;
  for (let i = 2; i < values.length; i++) {
    if (values[i] - values[i - 1] !== step) return 0;
  }
  return step;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** Quartz 语义的周几：1=周日 … 7=周六 */
  quartzDow: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour12: false,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        weekday: 'short',
      });
    } catch {
      // 非法时区名（用户手输）时退回本地时区，避免整个预览崩掉
      fmt = new Intl.DateTimeFormat('en-US', {
        hour12: false,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        weekday: 'short',
      });
    }
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/** 取某时刻在指定时区下的「墙上时间」各分量 */
export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const fmt = getFormatter(timeZone);
  const parts = fmt.formatToParts(date);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  const weekdayName = get('weekday');
  const jsDay = WEEKDAY_INDEX[weekdayName] ?? date.getDay();
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
    quartzDow: jsDay + 1,
  };
}

/** 按 `yyyy-MM-dd HH:mm:ss` 格式化某时刻在指定时区下的墙上时间 */
export function formatScheduleDateTime(date: Date, timeZone = DEFAULT_SCHEDULE_TIMEZONE): string {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}`;
}

/** 某年某月的天数（用于日字段 `L` 的匹配） */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 某时区下「墙上时间」的日期分量 */
interface WallDate {
  year: number;
  month: number;
  day: number;
}

/**
 * 把「某时区下的墙上时间」换算回 UTC 时间戳。
 *
 * 时区到 UTC 没有闭式解（偏移量本身随夏令时变化），用迭代逼近：先用 UTC 当猜测值，
 * 量出该猜测在目标时区下的墙上时间与期望值的偏差，再回补。跨夏令时的时区两轮即可收敛，
 * 这里最多逼近 3 轮并在偏差归零时提前退出。
 */
function wallTimeToUtc(target: WallDate, timeZone: string): number {
  const wanted = Date.UTC(target.year, target.month - 1, target.day, 0, 0, 0);
  let guess = wanted;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(guess), timeZone);
    // 必须带上时分秒一起比对：只比日期的话，猜测值落在当天任意时刻都会「看起来已收敛」，
    // 返回值会整体偏移一个时区偏移量（曾因此让按天跳跃落到当天 08:00，漏掉凌晨的触发点）。
    const actual = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const diff = actual - wanted;
    if (diff === 0) break;
    guess -= diff;
  }
  return guess;
}

/** 下一个日历日（纯日期运算，不涉及时区） */
function nextCalendarDay(date: WallDate): WallDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day) + 86400000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

/**
 * 本地推导接下来的 N 次触发时间。
 *
 * 匹配算法：按**分钟**推进游标（按秒推进会多扫 60 倍的时间点），命中后再枚举该分钟内
 * 允许的秒。扫描上限 366 天，超出即放弃（返回已找到的部分）—— 定时调度的周期通常远小于
 * 一天，这个上限既保证快速返回，也不会误报。
 *
 * 遇到本地不支持的语法（`W` / `#` / `nL`）直接返回空数组，调用方应改用服务端预览。
 */
export function nextFireTimes(
  expression: string,
  count = 5,
  timezoneId: string = DEFAULT_SCHEDULE_TIMEZONE,
  from: Date = new Date(),
): string[] {
  const parsed = parseCrontab(expression);
  if (!parsed.ok) return [];
  const cron = parsed.cron;
  if (cron.needsServerPreview) return [];

  const maxMinutes = 366 * 24 * 60;
  // 从下一分钟整点开始扫：当前这一分钟可能已经过去了若干秒，Quartz 语义下不应再触发
  let cursorMs = Math.floor(from.getTime() / 60000) * 60000 + 60000;

  const results: string[] = [];
  let scanned = 0;
  let cachedMonthKey = '';
  let cachedLastDay = 31;

  while (scanned < maxMinutes && results.length < count) {
    const parts = zonedParts(new Date(cursorMs), timezoneId);

    if (cron.years && !cron.years.includes(parts.year)) {
      // 年份被限定且不匹配：这一天内不可能命中，整日跳到次日 00:00。
      // 必须用「次日 00:00」而不是简单 +24h —— 否则跨年那一刻会落到年内的任意时刻，
      // 可能把次年 1 月 1 日凌晨本该命中的分钟漏掉。
      cursorMs = wallTimeToUtc(nextCalendarDay(parts), timezoneId);
      scanned += 1440;
      continue;
    }

    const monthKey = `${parts.year}-${parts.month}`;
    if (monthKey !== cachedMonthKey) {
      cachedMonthKey = monthKey;
      cachedLastDay = daysInMonth(parts.year, parts.month);
    }

    const monthOk = cron.months.includes(parts.month);
    const domOk = cron.dayOfMonthRestricted
      ? (cron.lastDayOfMonth
          ? parts.day === cachedLastDay
          : cron.daysOfMonth.includes(parts.day))
      : true;
    const dowOk = cron.dayOfWeekRestricted ? cron.daysOfWeek.includes(parts.quartzDow) : true;

    if (!monthOk || !domOk || !dowOk) {
      // 日期不匹配：这一天内不可能命中，整日跳到目标时区次日 00:00。
      // 逐分钟空转 1440 次会被「2 月 30 日」这类永不成立的表达式放大成秒级卡顿，
      // 而按天跳跃把最坏情况压到 366 次迭代。
      cursorMs = wallTimeToUtc(nextCalendarDay(parts), timezoneId);
      scanned += 1440;
      continue;
    }

    const match = cron.hours.includes(parts.hour) && cron.minutes.includes(parts.minute);

    if (match) {
      for (const sec of cron.seconds) {
        if (results.length >= count) break;
        results.push(
          `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)} ${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(sec)}`,
        );
      }
    }

    cursorMs += 60000;
    scanned++;
  }

  return results;
}

/**
 * 把 crontab 翻译成一句人话。
 *
 * 只覆盖常见形态（每天 / 每周几 / 每月某日 / 每小时 / 每 n 分钟 / 固定时刻），
 * 更复杂的表达式返回各字段的原样拼接 —— 宁可不美化，也不要给出会误导的描述。
 */
export function describeCrontab(expression: string): string {
  const parsed = parseCrontab(expression);
  if (!parsed.ok) return '';
  const cron = parsed.cron;

  // ---- 时间部分 ----
  let timePart: string;
  const secSingle = cron.seconds.length === 1 ? cron.seconds[0] : null;
  const minSingle = cron.minutes.length === 1 ? cron.minutes[0] : null;
  const hourSingle = cron.hours.length === 1 ? cron.hours[0] : null;

  if (cron.hours.length === 24 && cron.minutes.length === 60) {
    timePart = secSingle === null ? '每秒' : `每分钟第 ${secSingle} 秒`;
  } else if (cron.hours.length === 24 && minSingle !== null) {
    timePart = `每小时第 ${minSingle} 分${secSingle ? ` ${secSingle} 秒` : ''}`;
  } else if (cron.hours.length === 24) {
    const step = arithmeticStep(cron.minutes);
    timePart = step > 0 ? `每 ${step} 分钟` : `每小时的第 ${cron.minutes.join('、')} 分`;
  } else if (hourSingle !== null && minSingle !== null) {
    timePart = `${pad2(hourSingle)}:${pad2(minSingle)}:${pad2(secSingle ?? 0)}`;
  } else if (hourSingle !== null && cron.minutes.length === 60) {
    timePart = `${pad2(hourSingle)} 时每分钟`;
  } else {
    timePart = `分 ${cron.minutes.join('、')} 时 ${cron.hours.join('、')}${
      secSingle === null ? ` 秒 ${cron.seconds.join('、')}` : secSingle === 0 ? '' : ` 第 ${secSingle} 秒`
    }`;
  }

  // ---- 日期部分 ----
  let datePart: string;
  const monthAll = cron.months.length === 12;
  const isMonthlyLast = cron.lastDayOfMonth;

  if (cron.dayOfWeekRestricted) {
    const set = new Set(cron.daysOfWeek);
    if (set.size === 7) {
      datePart = '每天';
    } else if (set.size === 5 && [2, 3, 4, 5, 6].every(d => set.has(d))) {
      datePart = '每个工作日';
    } else {
      datePart = `每${Array.from(set).sort((a, b) => a - b).map(d => DOW_LABELS[d - 1]).join('、')}`;
    }
  } else if (isMonthlyLast) {
    datePart = monthAll ? '每月最后一天' : `${cron.months.join('、')} 月的最后一天`;
  } else if (!cron.dayOfMonthRestricted || cron.daysOfMonth.length === 31) {
    datePart = monthAll ? '每天' : `每年 ${cron.months.join('、')} 月`;
  } else if (monthAll) {
    datePart = `每月 ${cron.daysOfMonth.join('、')} 日`;
  } else {
    datePart = `每年 ${cron.months.join('、')} 月 ${cron.daysOfMonth.join('、')} 日`;
  }

  // 时间部分自身已经表达了「每小时 / 每 n 分钟 / 每分」这类周期时，
  // 再前置一个「每天」会读成「每天 每 5 分钟」（叠加且冗余），此时直接用时间部分
  if (datePart === '每天' && timePart.startsWith('每')) {
    datePart = '';
  }

  const suffix = cron.years ? `（仅 ${cron.years.length === 1 ? cron.years[0] : `${cron.years[0]}-${cron.years[cron.years.length - 1]}`} 年）` : '';
  return `${[datePart, timePart].filter(Boolean).join(' ')} 执行${suffix}`;
}

export interface CronPreset {
  label: string;
  value: string;
}

/** 常用周期预设：覆盖数仓调度的绝大多数场景，避免用户手写表达式 */
export const CRON_PRESETS: CronPreset[] = [
  { label: '每天 00:00', value: '0 0 0 * * ?' },
  { label: '每天 02:00', value: '0 0 2 * * ?' },
  { label: '每天 08:00', value: '0 0 8 * * ?' },
  { label: '每小时整点', value: '0 0 * * * ?' },
  { label: '每 30 分钟', value: '0 0/30 * * * ?' },
  { label: '每 5 分钟', value: '0 0/5 * * * ?' },
  { label: '每个工作日 02:00', value: '0 0 2 ? * MON-FRI' },
  { label: '每周一 02:00', value: '0 0 2 ? * MON' },
  { label: '每月 1 日 02:00', value: '0 0 2 1 * ?' },
  { label: '每月最后一天 02:00', value: '0 0 2 L * ?' },
];

/** 定时的默认生效区间：立即生效、长期有效（2099 年底） */
export function defaultScheduleRange(now: Date = new Date(), timezoneId = DEFAULT_SCHEDULE_TIMEZONE): {
  startTime: string;
  endTime: string;
} {
  return {
    startTime: formatScheduleDateTime(now, timezoneId),
    endTime: '2099-12-31 23:59:59',
  };
}

/** 校验生效区间：返回错误信息，合法时返回 null */
export function validateScheduleRange(startTime: string, endTime: string): string | null {
  const parse = (v: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(v.trim());
    if (!m) return null;
    const [, y, mo, d, h, mi, s] = m.map(Number) as unknown as number[];
    return Date.UTC(y, mo - 1, d, h, mi, s);
  };
  const start = parse(startTime);
  const end = parse(endTime);
  if (!startTime.trim() || start === null) return '生效开始时间格式应为 yyyy-MM-dd HH:mm:ss';
  if (!endTime.trim() || end === null) return '生效结束时间格式应为 yyyy-MM-dd HH:mm:ss';
  if (start > end) return '生效开始时间不能晚于结束时间';
  if (start === end) return '生效开始时间与结束时间不能相同';
  return null;
}
