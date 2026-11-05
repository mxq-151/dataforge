import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TRASH_RETENTION_POLICY,
  parseTrashBatchStamp,
  selectTrashPurgeCandidates,
  type TrashBatch,
  type TrashRetentionPolicy,
} from './trashRetention';

const NOW = new Date(2026, 8, 15, 12, 0, 0).getTime(); // 2026-09-15 12:00
const DAY = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;

/** 与 formatTrashStamp 同格式的批次名生成（避免测试与实现的耦合：这里独立实现） */
const stamp = (offsetDays: number, hour = 10): string => {
  const d = new Date(NOW - offsetDays * DAY);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(hour)}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
};

const policy = (partial: Partial<TrashRetentionPolicy>): TrashRetentionPolicy => ({
  ...DEFAULT_TRASH_RETENTION_POLICY,
  ...partial,
});

/** 全部约束关掉，只留最小保留数，便于逐个能力单独验证 */
const onlyRetention = (days: number, keep = 0) =>
  policy({ retentionDays: days, maxBatches: 0, maxTotalBytes: 0, minKeepBatches: keep });

const batch = (name: string, bytes = MB): TrashBatch => ({ name, bytes });

const names = (batches: TrashBatch[], p: TrashRetentionPolicy) =>
  selectTrashPurgeCandidates(batches, p, NOW).map(c => c.name);

describe('parseTrashBatchStamp', () => {
  it('解析合法批次名', () => {
    expect(parseTrashBatchStamp('20260915-101112')).toBe(new Date(2026, 8, 15, 10, 11, 12).getTime());
  });

  it.each([
    ['20260915-1011', '缺秒'],
    ['2026-09-15', '错格式'],
    ['20260915101112', '缺连字符'],
    [' 20260915-101112', '有前导空格'],
    ['abc', '非数字'],
    ['', '空串'],
    ['20260230-000000', '2 月 30 日（Date 会自动进位，必须回读校验）'],
    ['20261340-256161', '月日时分秒全越界'],
  ])('%s（%s）→ null', name => {
    expect(parseTrashBatchStamp(name)).toBeNull();
  });
});

describe('selectTrashPurgeCandidates - 保留期', () => {
  it('全部新鲜且未超限 → 不清理', () => {
    expect(names([batch(stamp(1)), batch(stamp(2))], DEFAULT_TRASH_RETENTION_POLICY)).toEqual([]);
  });

  it('空的回收站 → 不清理', () => {
    expect(selectTrashPurgeCandidates([], DEFAULT_TRASH_RETENTION_POLICY, NOW)).toEqual([]);
  });

  it('超过保留期的批次被清理，reason=expired', () => {
    const old = batch(stamp(40));
    const candidates = selectTrashPurgeCandidates([old, batch(stamp(1))], onlyRetention(30), NOW);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ name: old.name, reason: 'expired' });
  });

  it('边界：恰好达到保留期上限的批次不算过期', () => {
    // 30 天前同一时刻：deadline = at，判定用 at < deadline，不应命中
    const exact = stamp(30, 12);
    const parsed = parseTrashBatchStamp(exact) as number;
    expect(NOW - parsed).toBe(30 * DAY);
    expect(names([batch(exact)], onlyRetention(30))).toEqual([]);
  });

  it('超期 1 秒即过期（两侧都贴近边界）', () => {
    const older = new Date((parseTrashBatchStamp(stamp(30, 12)) as number) - 1000);
    const p = (n: number) => String(n).padStart(2, '0');
    const name =
      `${older.getFullYear()}${p(older.getMonth() + 1)}${p(older.getDate())}-` +
      `${p(older.getHours())}${p(older.getMinutes())}${p(older.getSeconds())}`;
    expect(names([batch(name)], onlyRetention(30))).toEqual([name]);
  });

  it('retentionDays <= 0 表示不按时间清理', () => {
    expect(names([batch(stamp(999))], onlyRetention(0))).toEqual([]);
  });

  it('最新 N 个批次受最小保留数保护，即使已过期', () => {
    const batches = [batch(stamp(100)), batch(stamp(90)), batch(stamp(80))];
    expect(names(batches, onlyRetention(30, 2))).toEqual([stamp(100)]);
  });

  it('最小保留数大于批次数时什么都不清', () => {
    expect(names([batch(stamp(100))], onlyRetention(1, 5))).toEqual([]);
  });
});

describe('selectTrashPurgeCandidates - 容量与数量', () => {
  it('超过最大批次数：从最旧的开始清到刚好达标', () => {
    const batches = [1, 2, 3, 4, 5].map(d => batch(stamp(d)));
    const purged = names(batches, policy({ retentionDays: 0, maxBatches: 3, maxTotalBytes: 0, minKeepBatches: 0 }));
    expect(purged).toEqual([stamp(5), stamp(4)]);
  });

  it('超过总容量：从最旧的开始清到进入预算', () => {
    const batches = [batch(stamp(1), 3 * MB), batch(stamp(2), 3 * MB), batch(stamp(3), 3 * MB)];
    const purged = names(batches, policy({ retentionDays: 0, maxBatches: 0, maxTotalBytes: 7 * MB, minKeepBatches: 0 }));
    expect(purged).toEqual([stamp(3)]);
  });

  it('单批次就超过容量上限时，也只清到最小保留数为止（上限是软约束）', () => {
    const batches = [batch(stamp(1), 100 * MB), batch(stamp(2), MB)];
    const purged = names(batches, policy({ retentionDays: 0, maxBatches: 0, maxTotalBytes: MB, minKeepBatches: 1 }));
    expect(purged).toEqual([stamp(2)]);
  });

  it('maxBatches / maxTotalBytes <= 0 表示该项不启用', () => {
    const batches = [batch(stamp(1), 500 * MB), batch(stamp(2), 500 * MB)];
    expect(names(batches, policy({ retentionDays: 0, maxBatches: 0, maxTotalBytes: 0, minKeepBatches: 0 }))).toEqual([]);
  });

  it('数量与容量同时超限时，两者都会被满足', () => {
    const batches = [1, 2, 3, 4].map(d => batch(stamp(d), 2 * MB));
    const purged = names(
      batches,
      policy({ retentionDays: 0, maxBatches: 2, maxTotalBytes: 6 * MB, minKeepBatches: 0 })
    );
    expect(purged).toEqual([stamp(4), stamp(3)]);
  });
});

describe('selectTrashPurgeCandidates - 安全边界', () => {
  it('名字不符合批次格式的条目不参与清理（不在候选池内）', () => {
    const batches = [batch('mydata'), batch('2026-09-15'), batch(stamp(999))];
    const purged = names(batches, onlyRetention(30));
    expect(purged).toEqual([stamp(999)]);
    expect(purged).not.toContain('mydata');
  });

  it('负数字节归一为 0，不会把容量算成负数', () => {
    const batches = [batch(stamp(1), -100), batch(stamp(2), 500)];
    const candidates = selectTrashPurgeCandidates(batches, policy({ retentionDays: 0, maxBatches: 0, maxTotalBytes: 400, minKeepBatches: 0 }), NOW);
    expect(candidates.map(c => c.bytes)).toEqual([500]);
  });

  it('结果按时间从旧到新排列，便于顺序执行与日志展示', () => {
    const batches = [batch(stamp(10)), batch(stamp(50)), batch(stamp(30))];
    expect(names(batches, onlyRetention(5))).toEqual([stamp(50), stamp(30), stamp(10)]);
  });

  it('结果不依赖输入顺序（目录列举顺序在不同文件系统上并不一致）', () => {
    const batches = [batch(stamp(10)), batch(stamp(50)), batch(stamp(30))];
    const reversed = [...batches].reverse();
    expect(names(batches, onlyRetention(5))).toEqual(names(reversed, onlyRetention(5)));
  });

  it('reason 区分三种清理原因', () => {
    const batches = [batch(stamp(60)), batch(stamp(20)), batch(stamp(10))];
    const candidates = selectTrashPurgeCandidates(
      batches,
      policy({ retentionDays: 30, maxBatches: 1, maxTotalBytes: 0, minKeepBatches: 0 }),
      NOW
    );
    expect(candidates.map(c => [c.name, c.reason])).toEqual([
      [stamp(60), 'expired'],
      [stamp(20), 'over-count'],
    ]);
  });
});
