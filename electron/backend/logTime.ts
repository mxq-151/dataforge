/**
 * 日志时间本地化。
 *
 * 背景：主进程日志（终端 + userData/logs/main.log）里出现过两种 UTC 时间：
 *   1) logger.ts 的行首前缀，用的是 `new Date().toISOString()`；
 *   2) sidecar（opencode）自己打的行内字段 `timestamp=2026-10-11T16:41:37.108Z`
 *      —— 它是 Bun/Node 的 `toISOString()`，永远 UTC，尾缀 Z，给进程注入 TZ
 *      也不会变。
 * 两者都不跟随主机时区，排查问题需要心算时差，故统一改写为本地时区的
 * ISO 8601（带 ±HH:MM 偏移）：既跟随主机时区，又保持机器可解析。
 *
 * 注意：渲染进程界面里的日志时间本来就是本地时间（SettingsView 用
 * `toLocaleTimeString`），不走这里。
 */

/** 完整 ISO 8601 时间戳：带毫秒可选，尾缀 Z 或 ±HH:MM / ±HHMM。 */
const ISO_TS_RE =
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})/g;

function pad(n: number, len = 2): string {
  return String(Math.abs(n)).padStart(len, '0');
}

/**
 * Date → 本地时区的 ISO 8601 字符串，形如 `2026-10-12T00:41:37.108+08:00`。
 *
 * 与 `toISOString()` 的区别只在时区：值仍是同一时刻，可被 `new Date()` 解析。
 */
export function toLocalIsoString(date: Date = new Date()): string {
  const ms = date.getMilliseconds();
  // getTimezoneOffset() 返回「UTC - 本地」的分钟数（东八区为 -480），取反得标准偏移
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin < 0 ? '-' : '+';
  const offset = `${sign}${pad(Math.trunc(offsetMin / 60))}:${pad(offsetMin % 60)}`;

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(ms, 3)}${offset}`
  );
}

/**
 * 把一段日志文本里所有 ISO 8601 时间戳改写为本地时区表示。
 *
 * 用于转发 sidecar 输出：`timestamp=2026-10-11T16:41:37.108Z level=INFO ...`
 * → `timestamp=2026-10-12T00:41:37.108+08:00 level=INFO ...`。
 * 已经是本地偏移的字符串会得到同一时区的等价表示（幂等）；无法解析的保持原样。
 */
export function localizeLogTimestamps(text: string): string {
  return text.replace(ISO_TS_RE, (match) => {
    const d = new Date(match);
    if (Number.isNaN(d.getTime())) return match;
    return toLocalIsoString(d);
  });
}
