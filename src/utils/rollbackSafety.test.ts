import { describe, it, expect } from 'vitest';
import {
  assessRollbackSafety,
  formatTrashStamp,
  uniqueTrashName,
  isSameRoot,
  isMassFileLoss,
  pathCompareKey,
  MAX_DELETABLE_RATIO,
  MIN_FILES_FOR_RATIO_CHECK,
  MASS_LOSS_MIN_FILES,
  type WorkspaceSnapshot,
} from './rollbackSafety';

/**
 * 回归守卫：2026-09-13 工作区清空事故。
 *
 * 现场事实：test_project 工作树的 71 个已提交文件被一次性删除，磁盘只剩一个 83 字节的 .git。
 * 成因是 handleRollback 拿到一个「空快照」后，把全部现存文件当成「快照之后新增的文件」删掉。
 * 下面的用例逐条锁死这些判定，任何一条被放宽都必须是有意为之。
 */

const ROOT = '/Users/mxq/.dataforge/localhost_8082/code/test_project/src/test_project';

/** 构造事故现场的文件列表：olist 38 + ads 29 + 4 个杂项 = 71 */
const incidentFiles = (): string[] => {
  const files: string[] = [];
  for (let i = 0; i < 38; i++) files.push(`${ROOT}/olist/olist_task_${i}_f.sql`);
  for (let i = 0; i < 29; i++) files.push(`${ROOT}/ads/code/ads/ads_task_${i}_f.java`);
  files.push(`${ROOT}/pom.xml`, `${ROOT}/README.md`, `${ROOT}/.gitignore`, `${ROOT}/build.sh`);
  return files;
};

const snapshotOf = (root: string | null, paths: string[]): WorkspaceSnapshot => ({
  root,
  files: Object.fromEntries(paths.map(p => [p, `// ${p}`])),
});

describe('assessRollbackSafety — 事故现场回归', () => {
  it('事故快照（root 为 null 且内容为空）必须被拦截，且不允许删除任何文件', () => {
    const current = incidentFiles();
    const r = assessRollbackSafety({
      // 拍摄时文件树尚未加载完成 —— 真实成因
      snapshot: { root: null, files: {} },
      currentPaths: current,
      currentRoot: ROOT,
      force: true, // 即便用户点了确认也不能放行：这是数据不可信，不是「你确定吗」
    });

    expect(r.code).toBe('untrusted-snapshot');
    expect(r.allowed).toBe(false);
    // 待删除集合等于全部现存文件 —— 这正是灾难的形状，断言它被拦在 allowed 之外
    expect(r.toDelete).toHaveLength(71);
    expect(current).toHaveLength(71);
  });

  it('现场 71 个文件不允许被无确认放行', () => {
    const r = assessRollbackSafety({
      snapshot: { root: ROOT, files: {} }, // 根路径可信但确实为空 → 属可疑而非不可信
      currentPaths: incidentFiles(),
      currentRoot: ROOT,
    });
    expect(r.code).toBe('mass-deletion');
    expect(r.allowed).toBe(false);
    expect(r.message).toContain('71');
  });
});

describe('assessRollbackSafety — 基本分支', () => {
  it('无快照 → no-snapshot', () => {
    const r = assessRollbackSafety({ snapshot: undefined, currentPaths: [], currentRoot: ROOT });
    expect(r.code).toBe('no-snapshot');
    expect(r.allowed).toBe(false);
  });

  it('同源且只新增少量文件 → 放行，待删除集合精确', () => {
    const before = [`${ROOT}/a.sql`, `${ROOT}/b.sql`, `${ROOT}/olist/x.sql`];
    const current = [...before, `${ROOT}/new1.sql`, `${ROOT}/olist/new2.sql`];
    const r = assessRollbackSafety({
      snapshot: snapshotOf(ROOT, before),
      currentPaths: current,
      currentRoot: ROOT,
    });

    expect(r.code).toBe('ok');
    expect(r.allowed).toBe(true);
    expect(r.toDelete.sort()).toEqual([`${ROOT}/new1.sql`, `${ROOT}/olist/new2.sql`]);
    expect(r.toRestore.sort()).toEqual([...before].sort());
  });

  it('快照比磁盘多（AI 删过文件）→ 放行，不产生删除项', () => {
    const snapshotPaths = [`${ROOT}/a.sql`, `${ROOT}/b.sql`];
    const r = assessRollbackSafety({
      snapshot: snapshotOf(ROOT, snapshotPaths),
      currentPaths: [`${ROOT}/a.sql`],
      currentRoot: ROOT,
    });
    expect(r.allowed).toBe(true);
    expect(r.toDelete).toEqual([]);
  });

  it('不同源（换项目后残留的旧快照）→ root-mismatch', () => {
    const r = assessRollbackSafety({
      snapshot: snapshotOf('/Users/mxq/.dataforge/localhost_8082/code/other/src/other', [
        '/Users/mxq/.dataforge/localhost_8082/code/other/src/other/a.sql',
      ]),
      currentPaths: [`${ROOT}/a.sql`],
      currentRoot: ROOT,
    });
    expect(r.code).toBe('root-mismatch');
    expect(r.allowed).toBe(false);
  });

  it('小目录不做比例判定（避免误伤从零开始的会话）', () => {
    const r = assessRollbackSafety({
      // 空工作区起步：快照合法地为空，AI 建了 3 个文件，用户回滚 —— 应放行
      snapshot: snapshotOf(ROOT, []),
      currentPaths: [`${ROOT}/a.sql`, `${ROOT}/b.sql`, `${ROOT}/c.sql`],
      currentRoot: ROOT,
    });
    expect(r.code).toBe('ok');
    expect(r.allowed).toBe(true);
    expect(MIN_FILES_FOR_RATIO_CHECK).toBe(4);
  });

  it('大比例删除在用户确认后（force）放行', () => {
    const files = incidentFiles();
    const r = assessRollbackSafety({
      snapshot: snapshotOf(ROOT, []),
      currentPaths: files,
      currentRoot: ROOT,
      force: true,
    });
    expect(r.code).toBe('ok');
    expect(r.allowed).toBe(true);
    expect(r.toDelete).toHaveLength(71);
  });

  it('恰在阈值上：删除比例等于 50% 且文件数达标 → 判为可疑', () => {
    const current = [`${ROOT}/a`, `${ROOT}/b`, `${ROOT}/c`, `${ROOT}/d`];
    const r = assessRollbackSafety({
      snapshot: snapshotOf(ROOT, [`${ROOT}/a`, `${ROOT}/b`]),
      currentPaths: current,
      currentRoot: ROOT,
    });
    expect(MAX_DELETABLE_RATIO).toBe(0.5);
    expect(r.code).toBe('mass-deletion');
    expect(r.allowed).toBe(false);
  });

  it('略低于阈值 → 放行', () => {
    const current = [`${ROOT}/a`, `${ROOT}/b`, `${ROOT}/c`, `${ROOT}/d`, `${ROOT}/e`];
    const r = assessRollbackSafety({
      snapshot: snapshotOf(ROOT, [`${ROOT}/a`, `${ROOT}/b`, `${ROOT}/c`]),
      currentPaths: current,
      currentRoot: ROOT,
    });
    expect(r.code).toBe('ok'); // 2/5 = 40% < 50%
  });

  it('currentRoot 缺失时跳过同源校验，不误判', () => {
    const r = assessRollbackSafety({
      snapshot: snapshotOf(ROOT, [`${ROOT}/a.sql`]),
      currentPaths: [`${ROOT}/a.sql`],
      currentRoot: null,
    });
    expect(r.code).toBe('ok');
  });
});

describe('assessRollbackSafety — 路径归一化', () => {
  it('分隔符与大小写差异不产生虚假删除项', () => {
    const win = 'C:\\work\\proj';
    const r = assessRollbackSafety({
      snapshot: snapshotOf('C:/Work/Proj', ['C:\\work\\proj\\olist\\a.sql']),
      currentPaths: ['c:/work/proj/olist/a.sql'],
      currentRoot: win,
    });
    expect(r.toDelete).toEqual([]);
    expect(r.code).toBe('ok');
  });

  it('尾部斜杠不影响同源判定', () => {
    expect(isSameRoot(`${ROOT}/`, ROOT)).toBe(true);
    expect(isSameRoot(ROOT, `${ROOT}/olist`)).toBe(false);
    expect(isSameRoot(null, ROOT)).toBe(false);
  });

  it('pathCompareKey 统一分隔符、去除尾斜杠、忽略大小写', () => {
    expect(pathCompareKey('C:\\A\\B\\')).toBe('c:/a/b');
    expect(pathCompareKey('/a/b///')).toBe('/a/b');
  });
});

describe('isMassFileLoss — 工作树自愈判定', () => {
  it('全空必然判定为损坏（事故现场：71/71 缺失）', () => {
    expect(isMassFileLoss(71, 71)).toBe(true);
    expect(isMassFileLoss(1, 1)).toBe(true);
  });

  it('用户在编辑器里删掉个别文件不算损坏，不触发自动恢复', () => {
    expect(isMassFileLoss(0, 71)).toBe(false);
    expect(isMassFileLoss(1, 71)).toBe(false);
    expect(isMassFileLoss(4, 71)).toBe(false); // 未达 MASS_LOSS_MIN_FILES
    expect(MASS_LOSS_MIN_FILES).toBe(5);
  });

  it('达到数量且过半才判定为损坏', () => {
    expect(isMassFileLoss(5, 10)).toBe(true); // 恰 50% 且达标
    expect(isMassFileLoss(4, 10)).toBe(false); // 40% 未达比例
    expect(isMassFileLoss(5, 20)).toBe(false); // 25% 未达比例
    expect(isMassFileLoss(60, 71)).toBe(true);
  });

  it('退化输入不误判', () => {
    expect(isMassFileLoss(0, 0)).toBe(false);
    expect(isMassFileLoss(5, 0)).toBe(false);
  });
});

describe('回收站工具', () => {
  it('formatTrashStamp 生成可排序的 YYYYMMDD-HHmmss', () => {
    const d = new Date(2026, 8, 13, 10, 57, 4); // 2026-09-13 10:57:04
    expect(formatTrashStamp(d)).toBe('20260913-105704');
  });

  it('uniqueTrashName 处理同名冲突', () => {
    const taken = new Set(['a.sql']);
    expect(uniqueTrashName('a.sql', taken)).toBe('a.sql-1');
    expect(uniqueTrashName('b.sql', taken)).toBe('b.sql');
    expect(uniqueTrashName('a.sql', new Set(['a.sql', 'a.sql-1']))).toBe('a.sql-2');
  });
});
