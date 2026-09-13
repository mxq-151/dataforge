/**
 * 回滚安全检查（纯函数，无副作用、无 DOM 依赖，便于穷举测试）。
 *
 * 背景事故（2026-09-13）：`DevAssistantView.handleRollback` 把「发消息前拍摄的整目录内容快照」
 * 当作权威清单 —— 先按快照还原文件，再删除磁盘上所有不在快照中的文件。
 * 当快照与当前工作区不同源、或拍摄于文件树尚未加载完成时，快照退化为空集，
 * 「待删除集合」随之退化为「全部现存文件」，一次点击即抹掉整个工作区
 * （现场：71 个已提交文件被 fs.remove 直删，无备份、无日志、无回收站）。
 *
 * 本模块把「这次回滚能不能执行」的判定从 React 组件里抽出来，做成可穷举测试的纯函数：
 * 只有快照存在、可信、且与当前工作区同源时，才允许进入删除阶段；
 * 大比例删除属于「可能是误删」的可疑区间，需要调用方二次确认后才放行。
 */

/** 一次工作区快照：拍摄时刻的文件集合 + 当时的文件系统根路径 */
export interface WorkspaceSnapshot {
  /**
   * 拍摄时刻的文件系统根路径。
   * `null` 表示当时工作区尚未就绪（文件树未装载）—— 此时快照必然为空，
   * 用它回滚会把整个工作区当成「快照之后新增的文件」删光，因此该快照不可信。
   */
  root: string | null;
  /** 文件绝对路径 → 文件内容。工作区确实为空时是空对象，属合法状态 */
  files: Record<string, string>;
}

export type RollbackSafetyCode =
  /** 通过检查，可以执行 */
  | 'ok'
  /** 这条消息压根没有快照（例如快照功能上线前发送的消息） */
  | 'no-snapshot'
  /** 快照拍摄时工作区未就绪，内容不可信 —— 2026-09-13 事故根因 */
  | 'untrusted-snapshot'
  /** 快照与当前工作区不同源（换过项目/用户，或 rootPath 已切换） */
  | 'root-mismatch'
  /** 待删除文件占现存文件比例过高，可能是误删，需二次确认 */
  | 'mass-deletion';

export interface RollbackAssessment {
  code: RollbackSafetyCode;
  /** 是否允许直接执行。`mass-deletion` 在用户确认后带 `force` 重跑即可放行 */
  allowed: boolean;
  /** 待删除文件：磁盘上存在、但不在快照中 */
  toDelete: string[];
  /** 待还原文件：快照中记录的全部路径 */
  toRestore: string[];
  /** 面向用户的中文说明，调用方可直接展示 */
  message: string;
}

/** 待删除文件占现存文件的最大允许比例，超过则判定为可疑 */
export const MAX_DELETABLE_RATIO = 0.5;

/** 现存文件少于该数量时不做比例判定（小目录的比例没有统计意义，易误伤） */
export const MIN_FILES_FOR_RATIO_CHECK = 4;

/** 判定「大面积缺失」所需的最少缺失文件数 */
export const MASS_LOSS_MIN_FILES = 5;

/** 判定「大面积缺失」所需的缺失比例 */
export const MASS_LOSS_RATIO = 0.5;

/**
 * 判断「已跟踪文件大面积缺失」是否属于损坏状态，而非用户在编辑器里的正常删除。
 *
 * 用于 git 工作树自愈：工作树的 `.git` 文件仍在、但内容被清空或大面积删除时，
 * git 只会报告一堆 ` D ` 而不会自动还原（2026-09-13 事故后目录一直空着）。
 * 但用户主动删掉一两个文件不该被「自动恢复」——所以只有全空、
 * 或缺失数达到 MASS_LOSS_MIN_FILES 且占比超过 MASS_LOSS_RATIO 才判定为损坏。
 */
export function isMassFileLoss(missingCount: number, totalCount: number): boolean {
  if (totalCount <= 0 || missingCount <= 0) return false;
  if (missingCount >= totalCount) return true; // 全空 = 明确损坏，无需再比比例
  return missingCount >= MASS_LOSS_MIN_FILES && missingCount / totalCount >= MASS_LOSS_RATIO;
}

/** 回收站目录名。以 `.` 开头，`buildFileTree` 会过滤掉，不会出现在文件树里 */
export const TRASH_DIR_NAME = '.dataforge-trash';

/**
 * 路径比较键：统一分隔符、抹掉尾部斜杠、忽略大小写。
 *
 * 大小写统一小写：macOS/Windows 的默认文件系统都大小写不敏感，
 * 而 git 常见把盘符写成 `C:/` 与 `c:/` 两种形式，直接字符串比较会误判为不同源。
 */
export const pathCompareKey = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** 两次快照是否指向同一个目录 */
export const isSameRoot = (a: string | null | undefined, b: string | null | undefined): boolean => {
  if (!a || !b) return false;
  return pathCompareKey(a) === pathCompareKey(b);
};

/**
 * 评估一次回滚是否安全。
 *
 * @param snapshot    目标消息对应的快照
 * @param currentPaths 当前磁盘上的文件路径列表
 * @param currentRoot  当前文件系统根路径
 * @param force       用户已对「大比例删除」警告确认过
 */
export function assessRollbackSafety(params: {
  snapshot: WorkspaceSnapshot | undefined;
  currentPaths: string[];
  currentRoot: string | null;
  force?: boolean;
}): RollbackAssessment {
  const { snapshot, currentPaths, currentRoot, force = false } = params;

  if (!snapshot) {
    return {
      code: 'no-snapshot',
      allowed: false,
      toDelete: [],
      toRestore: [],
      message: '这条消息没有对应的文件快照，无法回滚文件。为避免误删，已中止操作。',
    };
  }

  const snapshotPaths = Object.keys(snapshot.files);
  const snapshotKeys = new Set(snapshotPaths.map(pathCompareKey));
  const toDelete = currentPaths.filter(p => !snapshotKeys.has(pathCompareKey(p)));
  const base = { toDelete, toRestore: snapshotPaths.slice() };

  // 1) 快照拍摄时工作区未就绪 → 内容不可信。
  //    这是 2026-09-13 事故的直接成因：空快照 + 覆盖率护栏缺失 = 删除集合等于全部现存文件。
  if (!snapshot.root) {
    return {
      ...base,
      code: 'untrusted-snapshot',
      allowed: false,
      message:
        '这条消息的文件快照不完整（拍摄时工作区尚未加载完成），回滚会误删文件。为避免数据丢失，已中止操作。',
    };
  }

  // 2) 快照与当前工作区不同源：典型是换了项目/用户后残留的旧快照。
  if (currentRoot && !isSameRoot(snapshot.root, currentRoot)) {
    return {
      ...base,
      code: 'root-mismatch',
      allowed: false,
      message: '文件快照属于另一个工作区，与当前项目不匹配。为避免误删，已中止操作。',
    };
  }

  // 3) 大比例删除：进入可疑区间，需二次确认。
  if (currentPaths.length >= MIN_FILES_FOR_RATIO_CHECK) {
    const ratio = toDelete.length / currentPaths.length;
    if (ratio >= MAX_DELETABLE_RATIO && !force) {
      const pct = Math.round(ratio * 100);
      return {
        ...base,
        code: 'mass-deletion',
        allowed: false,
        message:
          `本次回滚将删除 ${toDelete.length} 个文件，占当前工作区 ${currentPaths.length} 个文件的 ${pct}%。` +
          `大比例删除通常意味着快照异常，请确认这是你期望的结果。`,
      };
    }
  }

  return {
    ...base,
    code: 'ok',
    allowed: true,
    message: `将还原 ${snapshotPaths.length} 个文件、删除 ${toDelete.length} 个快照之后新增的文件。`,
  };
}

/**
 * 由文件路径集合推导所有祖先目录，返回统一为 pathCompareKey 的集合。
 *
 * 回滚删除「快照之后新增的文件夹」时，需要判断当前工作区的某个文件夹是否出现在
 * 快照的祖先目录中。2026-09-13 二次事故：组件内旧实现用 `splitPath(...).join('/')`
 * 生成的是**无前导斜杠**的路径（如 `Users/mxq/.../src/a`），而文件树节点 path 是
 * **带前导斜杠的绝对路径**（如 `/Users/mxq/.../src/a`），两种格式永远不相等 ——
 * 全部文件夹被误判为「快照中不存在」，整棵目录树连文件一起被搬进回收站。
 *
 * 本函数输出与 `collectFolderPaths(tree).map(pathCompareKey)` 同键可直接求差集；
 * 逐级向上的推导不依赖外部模块，保持本文件零依赖。
 */
export function deriveFolderKeys(filePaths: string[]): Set<string> {
  const keys = new Set<string>();
  for (const fp of filePaths) {
    const norm = fp.replace(/\\/g, '/').replace(/\/+$/, '');
    let dir = norm.slice(0, norm.lastIndexOf('/'));
    while (dir) {
      keys.add(pathCompareKey(dir));
      if (!dir.includes('/')) break; // 已到顶部（如 'C:'）
      const parent = dir.slice(0, dir.lastIndexOf('/'));
      if (parent === dir) break;
      dir = parent;
    }
  }
  return keys;
}

/** 回收站批次目录名：YYYYMMDD-HHmmss */
export function formatTrashStamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 回收站内目标名：同名冲突时追加 `-1`、`-2`…
 *
 * 同一秒内回滚两次、或目录里同时存在 `a` 与 `a.sql` 时，
 * 直接把相对路径拼进回收站会互相覆盖，必须去重。
 */
export function uniqueTrashName(desired: string, taken: ReadonlySet<string>): string {
  if (!taken.has(desired)) return desired;
  for (let i = 1; i < 1000; i++) {
    const candidate = `${desired}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${desired}-${Date.now()}`;
}
