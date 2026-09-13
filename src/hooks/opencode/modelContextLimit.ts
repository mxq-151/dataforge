/**
 * modelContextLimit — 模型 context 窗口上限的解析（纯函数，无 React 依赖）
 *
 * 背景（2026-09-13 线上问题）：
 * 顶部进度条显示「当前上下文: 181.7k / 128.0k（142.0%）」，而实际使用的
 * deepseek/deepseek-flash（显示名 DeepSeek V4.1 Flash）官方 context 是 1,000,000。
 *
 * 根因有两条，缺一不可：
 * 1. `getHardcodedContextLimit('deepseek-flash')` 落进泛化的 `includes('deepseek')`
 *    分支 → 128_000。modelID 里既没有 `v3` 也没有 `v4`，只按 `deepseek-v4` 前缀
 *    匹配是漏的。
 * 2. API 侧本可以纠正它（sidecar 的 `/api/model` 对 `deepseek-flash` 返回
 *    `limit.context = 1000000`），但该接口按 location 惰性初始化实例，冷实例首次
 *    调用会返回空列表 / 报错，而调用方只查一次就回落硬编码 → 稳定拿到 128k。
 *
 * 因此这里把「表」抽成纯函数，便于单测固化 DeepSeek V4 家族的判定；
 * API 查询策略（location + 重试）见 useOpencodeClient.fetchModelContextLimit。
 */

/** 完全未知模型时的兜底值（与多数 OpenAI 兼容端点默认窗口一致） */
export const DEFAULT_CONTEXT_LIMIT = 128_000;

/** DeepSeek V4 家族（v4 / v4.1 / flash / pro / vision-exp）官方窗口 */
export const DEEPSEEK_V4_CONTEXT_LIMIT = 1_000_000;

/**
 * 已知模型的官方 context 窗口（硬编码表）。
 *
 * 用途：
 * 1. API `model.list()` 不可用（冷实例 / 接口失败 / 模型未登记）时的 fallback
 * 2. API 返回值低估时的下限保护（见 resolveContextLimit）
 *
 * 注意：值一律取「官方文档口径」。DeepSeek V4 系是 1,000,000 而非 1,048,576
 * （1MiB），取 1MiB 会通过 Math.max 盖掉 API 的正确值，让分母虚高 4.8%。
 */
export function getHardcodedContextLimit(modelID: string): number {
  const model = (modelID || '').toLowerCase();

  // ── OpenAI ──
  if (model.includes('gpt-4o') || model.includes('gpt-4-turbo') || model.includes('gpt-4.1')) {
    return 128_000;
  }
  if (model.includes('gpt-4')) return 8_192;
  if (model.includes('gpt-3.5')) return 16_385;

  // ── Anthropic ──
  if (model.includes('claude')) return 200_000;

  // ── DeepSeek ──
  // V4 家族判定必须放在下面的泛化 `deepseek` 之前。
  // 关键点：`deepseek-flash` 是 DeepSeek **V4.1** Flash 的 modelID，
  // 名字里既没有 v3 也没有 v4 字样，只认 `deepseek-v4` 会漏判成 128k。
  if (
    model.includes('deepseek-v4') ||
    model.includes('deepseek-flash') ||
    model.includes('deepseek-v4.1')
  ) {
    return DEEPSEEK_V4_CONTEXT_LIMIT;
  }
  // v3 / r1 / v2 / deepseek-chat / deepseek-reasoner 等老模型
  if (model.includes('deepseek')) return 128_000;

  // ── 阿里云通义 ──
  if (model.includes('qwen')) return 32_000;

  // ── Google ──
  if (model.includes('gemini-1.5-pro') || model.includes('gemini-2')) return 1_000_000;
  if (model.includes('gemini')) return 32_000;

  return DEFAULT_CONTEXT_LIMIT;
}

/**
 * 合并 API 返回值与硬编码值。
 *
 * 策略：取两者较大值。
 * - API 给出更准确的值（如 deepseek-flash 的 1,000,000）→ 用它
 * - API 未登记 / 低估（如返回 128,000 但模型实际支持 1M）→ 用硬编码下限兜住，
 *   避免进度条误报满载（142%）
 *
 * @param apiLimit API 返回的 limit.context；缺失时传 null/undefined
 * @param modelID 模型 ID，用于查硬编码表
 */
export function resolveContextLimit(
  apiLimit: number | null | undefined,
  modelID: string
): number {
  const hardcoded = getHardcodedContextLimit(modelID);
  if (typeof apiLimit !== 'number' || !Number.isFinite(apiLimit) || apiLimit <= 0) {
    return hardcoded;
  }
  return Math.max(apiLimit, hardcoded);
}
