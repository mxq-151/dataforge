/**
 * 回收站保留期与容量上限（纯函数，无副作用、无 DOM / IO 依赖）。
 *
 * 背景：删除与回滚不再直删磁盘，而是把目标移入 `<工作区>/.dataforge-trash/<批次>/`
 * （2026-09-13 事故后加的闸门）。但闸门只回答了「删得安不安全」，没回答
 * 「回收站本身无限增长怎么办」——批次目录只进不出，工作区会逐渐被历史副本撑大，
 * 且这些副本对 git 隐身（写进了 info/exclude），用户完全感知不到它在长。
 * 这是计划书风险 R5 的待补项。
 *
 * 本模块只做一件事：给定「回收站里有哪些批次、各多大」，算出该清哪些、为什么清。
 * 真正的删除交给调用方（见 trashCleanup.ts），因此这里可以穷举测试 ——
 * 与 `rollbackSafety` 同样的理由：删除决策绝不能藏在 React 组件或 IO 循环里。
 *
 * 安全取向（与 rollbackSafety 一致，宁可不删）：
 *   1. 最新 N 个批次永不清理 —— 用户刚误删的东西就在里面，那是回收站存在的意义；
 *   2. 名字不符合批次格式（`YYYYMMDD-HHmmss`）的条目一律不碰 —— 无法解析时间就无法
 *      判断新旧，宁可留着，也好过把用户手工放进去的东西清掉；
 *   3. 上限是软约束：若单批次体积本身就超上限，也只清到「只剩最小保留数」为止，
 *      不会为了满足数字而清空回收站。
 */

/** 一天的毫秒数 */
const DAY_MS = 24 * 60 * 60 * 1000;

/** 批次目录名格式，由 `formatTrashStamp` 生成 */
const BATCH_NAME_RE = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/;

export interface TrashRetentionPolicy {
  /** 保留天数；<= 0 表示不按时间清理 */
  retentionDays: number;
  /** 最多保留的批次数；<= 0 表示不按数量清理 */
  maxBatches: number;
  /** 回收站总容量上限（字节）；<= 0 表示不按容量清理 */
  maxTotalBytes: number;
  /** 无论怎么超限都至少保留的新批次数（下限，保护刚发生的误删） */
  minKeepBatches: number;
}

/**
 * 默认策略：30 天 / 50 批 / 2 GiB / 至少保留 2 批。
 *
 * 取值理由：数据开发工作区以代码与 SQL 为主，单文件 KB 级、单个批次 MB 级，
 * 2 GiB 相当于给回收站留出「上百次误删」的余量，同时挡住「误把大目录拖进回收站」
 * 这类会瞬间吃掉磁盘的操作；30 天覆盖「发现错了再回头找」的常见周期。
 */
export const DEFAULT_TRASH_RETENTION_POLICY: TrashRetentionPolicy = {
  retentionDays: 30,
  maxBatches: 50,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
  minKeepBatches: 2,
};

export interface TrashBatch {
  /** 批次目录名 */
  name: string;
  /** 该批次占用的字节数（由调用方递归统计） */
  bytes: number;
}

export type TrashPurgeReason = 'expired' | 'over-count' | 'over-size';

export interface TrashBatchStamp {
  name: string;
  at: number;
  bytes: number;
}

export interface TrashPurgeCandidate extends TrashBatchStamp {
  reason: TrashPurgeReason;
}

/**
 * 解析批次目录名的时间戳（毫秒）。解析不出或日期非法返回 null。
 *
 * 必须做「回读校验」：`new Date(2026, 12, 40)` 不会报错，而是自动进位成
 * 2027-02-09 —— 不校验就会把非法名字当成合法批次，等于绕过了保护规则。
 */
export function parseTrashBatchStamp(name: string): number | null {
  const m = BATCH_NAME_RE.exec(name);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const s = Number(m[6]);
  const date = new Date(y, mo - 1, d, h, mi, s);
  if (
    date.getFullYear() !== y ||
    date.getMonth() !== mo - 1 ||
    date.getDate() !== d ||
    date.getHours() !== h ||
    date.getMinutes() !== mi ||
    date.getSeconds() !== s
  ) {
    return null;
  }
  return date.getTime();
}

/**
 * 选出应当清理的批次（按时间从旧到新排列，便于调用方顺序执行与日志展示）。
 *
 * 判定顺序：先按保留期清过期批次，再看批次数，最后看总容量；
 * 后两步都从**最旧**的开始清，直到满足约束或触达最小保留数。
 */
export function selectTrashPurgeCandidates(
  batches: readonly TrashBatch[],
  policy: TrashRetentionPolicy = DEFAULT_TRASH_RETENTION_POLICY,
  now: number = Date.now()
): TrashPurgeCandidate[] {
  const keep = Math.max(0, Math.floor(policy.minKeepBatches));

  // 名字解析不出的批次不入候选池 —— 不猜、不碰
  const known: TrashBatchStamp[] = [];
  for (const b of batches) {
    const at = parseTrashBatchStamp(b.name);
    if (at === null) continue;
    known.push({ name: b.name, at, bytes: Math.max(0, b.bytes) });
  }
  if (known.length === 0) return [];

  // 新的在前。同一时刻（同秒）按名字倒序，保证顺序稳定、结果可复现
  known.sort((a, b) => (b.at - a.at) || (b.name < a.name ? -1 : 1));

  const protectedNames = new Set(known.slice(0, keep).map(b => b.name));
  const reasons = new Map<string, TrashPurgeReason>();

  // 1) 保留期
  if (policy.retentionDays > 0) {
    const deadline = now - policy.retentionDays * DAY_MS;
    for (const b of known) {
      if (protectedNames.has(b.name)) continue;
      if (b.at < deadline) reasons.set(b.name, 'expired');
    }
  }

  let kept = known.filter(b => !reasons.has(b.name));

  // 2) 批次数：从最旧的开始清，但不清到少于最小保留数
  if (policy.maxBatches > 0) {
    while (kept.length > policy.maxBatches && kept.length > keep) {
      const oldest = kept.pop()!;
      reasons.set(oldest.name, 'over-count');
    }
  }

  // 3) 总容量
  if (policy.maxTotalBytes > 0) {
    let total = kept.reduce((sum, b) => sum + b.bytes, 0);
    while (total > policy.maxTotalBytes && kept.length > keep) {
      const oldest = kept.pop()!;
      total -= oldest.bytes;
      reasons.set(oldest.name, 'over-size');
    }
  }

  return known
    .filter(b => reasons.has(b.name))
    .map(b => ({ ...b, reason: reasons.get(b.name)! }))
    .sort((a, b) => (a.at - b.at) || (a.name < b.name ? -1 : 1));
}
