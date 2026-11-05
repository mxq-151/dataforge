/**
 * Scala/Metals hover 稳定化重试（纯函数，无外部依赖，便于单元测试）。
 *
 * background：Metals 的 hover 有两层惰性——PC（Presentation Compiler）冷启动 +
 * scaladoc 异步解压，二者在文件刚打开的前几秒（尤其 ~2s 内）通常尚未就绪，导致首次
 * hover 某符号只返回类型签名（简单内容），异步解析完后再请求才返回带文档的完整内容。
 * 这会造成"打开文件 2s 内 hover 简单、5s 后 hover 完整"的抖动。
 *
 * 该函数在首次拿到不完整内容时，按递增退避再次请求，直到：
 *   - 拿到完整结果（`isComplete` 为真）→ 提前返回（已温符号零额外延迟）；
 *   - 连续 `noProgressLim` 次重试内容长度无增长，**且累计等待已超过 `settleTime`
 *     （冷启动/settle 窗口）** → 内容稳定，短期不会再有文档，提前结束（有界时延）。
 *
 * 为什么要有 `settleTime` 门槛：冷启动窗口内（Metals PC 冷启动 + scaladoc 解压通常需
 * 数秒），内容可能呈现"短暂平台期（同一长度停留几百 ms）→ 之后才继续增长"。若仅凭
 * 连续几次无增长就提前退出，会在文档真正解压出来之前就返回不完整内容——这正是
 * "打开文件后快速悬停 → 拿到短签名，且重试多次都一样不完整"的原因（冷窗口内每次重新
 * 悬停都会在平台期再次提前退出）。加上 settle 门槛后，单次悬停会持续轮询至文档出现，
 * 或确认过了冷启动窗口仍无内容后才返回最佳结果。
 *
 * @param initial        第一次请求的结果
 * @param request        再次请求的函数（每次调用返回一个新的 hover 结果）
 * @param contentLen     提取内容长度（判断是否"在增长"）
 * @param isComplete     判断结果是否已完整（命中即提前返回）
 * @param delays         每次重试前的递增退避（毫秒）
 * @param noProgressLim  连续无增长多少次后（且已过 settle 窗口）提前结束
 * @param settleTime     冷启动/settle 窗口（毫秒）：累计等待未超过它之前不因无增长而提前退出
 */
export async function stabilizeIncompleteResult(
  initial: any,
  request: () => Promise<any | null | undefined>,
  contentLen: (r: any) => number,
  isComplete: (r: any) => boolean,
  delays: number[],
  noProgressLim = 2,
  settleTime = 5000,
): Promise<any | null | undefined> {
  if (initial && isComplete(initial)) return initial;
  let result = initial;
  let lastLen = result ? contentLen(result) : 0;
  let noProgressStreak = 0;
  let elapsed = 0;
  for (const delay of delays) {
    await new Promise((res) => setTimeout(res, delay));
    elapsed += delay;
    const retried = await Promise.resolve(request()).catch(() => null);
    if (retried == null) continue;
    const len = contentLen(retried);
    if (isComplete(retried)) {
      result = retried;
      break;
    }
    if (len > lastLen) {
      result = retried;
      lastLen = len;
      noProgressStreak = 0;
    } else {
      noProgressStreak++;
      // 同时满足「连续多次无增长」与「已累计等待超过冷启动窗口」才提前结束；
      // 冷窗口内出现的"平台期后继续增长"不触发提前退出，避免快速悬停拿到不完整内容。
      if (noProgressStreak >= noProgressLim && elapsed >= settleTime) break;
    }
  }
  return result;
}

// ==== hover 完整性判定（Scala/Metals 专用，provideHover 与预热共用，便于单元测试）====

// 提取一条 hover 内容的纯文本（兼容 string / MarkupContent{kind,value} / MarkedString 数组）。
const hoverValue = (x: any): string => (typeof x === 'string' ? x : (x?.value ?? ''));

// 计算 hover 内容的总长度。
export function hoverContentLen(h: any): number {
  if (!h?.contents) return 0;
  const c = h.contents;
  if (typeof c === 'string') return c.length;
  if (Array.isArray(c)) return c.reduce((n: number, x: any) => n + hoverValue(x).length, 0);
  return hoverValue(c).length;
}

// 判定一条 hover 结果是否「完整」（已附带 scaladoc 文档）。
// 仅凭「长度 >= 60」不够：Metals 冷窗口返回的**长类型签名**（单行、无文档）也能超过 60 字，
// 若被误判为完整，会被 provideHover 当成最终结论缓存固定，导致「同一符号多次重试内容都一样、
// 一直看不到文档」。真正的完整结果（签名 + 文档）几乎总是多行的，故要求 长度 >= 60 且含换行。
export function hoverIsComplete(h: any): boolean {
  if (!h?.contents) return false;
  const c = h.contents;
  const texts = typeof c === 'string' ? [c] : Array.isArray(c) ? c.map(hoverValue) : [hoverValue(c)];
  return texts.some((v) => v.length >= 60 && v.includes('\n'));
}