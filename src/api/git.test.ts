/**
 * git.test.ts — ensureGitWorktree 的挂载 / 自愈行为
 *
 * 背景（Windows 上反复出现的「git 仓库初始化有问题」）：
 *   1. 链接工作树的 .git 文件丢失后，git 把它标记为 prunable，
 *      此时 worktree remove 校验失败、worktree add 又报 "already exists"，永久卡死；
 *   2. worktree remove 会连目录一起删除，若把「当前源码目录」误判成旧挂载点就会误删源码；
 *   3. git 要求 worktree add 的目标目录为空或非 git 工作树，非空目录必须跳过而不是清空。
 *
 * 本测试用假的 shell 桥（mock '../bridge/shell'）与假的文件系统桥（mock '../bridge/fs'），
 * 只断言「按什么顺序发起了哪些 git 命令」，不真跑 git。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const executeMock = vi.fn();

vi.mock('../bridge/shell', () => ({
  Command: {
    create: (_program: string, args: string[], options?: { cwd?: string }) => ({
      execute: () => executeMock(args, options ?? {}),
    }),
  },
}));

const readDirMock = vi.fn();
const removeMock = vi.fn();

vi.mock('../bridge/fs', () => ({
  readDir: (dir: string) => readDirMock(dir),
  remove: (dir: string, options?: { recursive?: boolean }) => removeMock(dir, options),
}));

import { ensureGitWorktree } from './git';

const REPO = 'C:/host/warehouse';
const SRC = 'C:/host/code/p1/src/p1';

interface Call {
  args: string[];
  cwd?: string;
}

let calls: Call[] = [];
/** 被视为「位于 git 工作树内」的目录（rev-parse --is-inside-work-tree 返回 true） */
let inWorkTree: Set<string>;
/** 按命令自定义响应，返回 null 表示走默认 */
let responder: (call: Call) => { code: number; stdout?: string; stderr?: string } | null;

const isRevParse = (args: string[]) => args.includes('--is-inside-work-tree');
/** rev-parse 的作用目录：优先 -C 参数，否则取 cwd */
const revParseTarget = (call: Call) => (call.args[0] === '-C' ? call.args[1] : call.cwd) || '';

beforeEach(() => {
  calls = [];
  inWorkTree = new Set([REPO]); // 默认只有仓库本身是工作树，源码目录还没挂载
  responder = () => null;
  executeMock.mockReset();
  executeMock.mockImplementation(async (args: string[], options: { cwd?: string }) => {
    const call: Call = { args, cwd: options.cwd };
    calls.push(call);
    const custom = responder(call);
    if (custom) return { code: custom.code, stdout: custom.stdout ?? '', stderr: custom.stderr ?? '' };
    if (isRevParse(args)) {
      return inWorkTree.has(revParseTarget(call))
        ? { code: 0, stdout: 'true', stderr: '' }
        : { code: 128, stdout: '', stderr: 'not a git repository' };
    }
    return { code: 0, stdout: '', stderr: '' };
  });
  readDirMock.mockReset();
  readDirMock.mockResolvedValue([]);
  removeMock.mockReset();
  removeMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const has = (...sub: string[]) => calls.some(c => sub.every(s => c.args.includes(s)));
const indexOf = (sub: string) => calls.findIndex(c => c.args.includes(sub));
const cmdList = () => calls.map(c => c.args.join(' '));

/** 临时把 UA 伪装成 Windows（pathUtils.isWindows 依赖 navigator.userAgent） */
const stubWindowsUserAgent = (): (() => void) => {
  const original = window.navigator.userAgent;
  Object.defineProperty(window.navigator, 'userAgent', {
    value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    configurable: true,
  });
  return () => {
    Object.defineProperty(window.navigator, 'userAgent', { value: original, configurable: true });
  };
};

/** 让 `git worktree list --porcelain` 返回给定条目 */
const setWorktreeList = (lines: string[]) => {
  responder = (call) =>
    call.args[2] === 'worktree' && call.args[3] === 'list'
      ? { code: 0, stdout: lines.join('\n') }
      : null;
};

describe('ensureGitWorktree', () => {
  it('源码目录已是 git 工作树时不重新挂载（不发 subtree/worktree 命令）', async () => {
    inWorkTree = new Set([REPO, SRC]);

    await ensureGitWorktree(REPO, SRC, 'p1');

    expect(has('subtree')).toBe(false);
    expect(has('worktree')).toBe(false);
  });

  it('工作树已挂载且干净时，fast-forward 到远端最新', async () => {
    inWorkTree = new Set([REPO, SRC]);

    await ensureGitWorktree(REPO, SRC, 'p1');

    // 发起 fetch 与 merge --ff-only origin/dataforge/p1，但不重新挂载
    expect(has('fetch')).toBe(true);
    expect(calls.some(c => c.args.includes('--ff-only') && c.args.includes('origin/dataforge/p1'))).toBe(true);
    expect(has('subtree')).toBe(false);
    expect(has('worktree')).toBe(false);
  });

  it('工作树有未提交改动时不自动前进（不 merge）', async () => {
    inWorkTree = new Set([REPO, SRC]);
    const base = responder;
    responder = (call) => {
      if (call.args.includes('status') && call.args.includes('--porcelain')) {
        return { code: 0, stdout: ' M pom.xml\n' };
      }
      return base(call);
    };

    await ensureGitWorktree(REPO, SRC, 'p1');

    expect(has('merge')).toBe(false);
  });

  it('无远端分支时跳过同步', async () => {
    inWorkTree = new Set([REPO, SRC]);
    const base = responder;
    responder = (call) => {
      if (call.args.includes('rev-parse') && call.args.includes('--verify')) {
        return { code: 128, stdout: '', stderr: 'unknown revision' };
      }
      return base(call);
    };

    await ensureGitWorktree(REPO, SRC, 'p1');

    expect(has('merge')).toBe(false);
  });

  it('仓库不存在（尚未 clone）时完全不处理', async () => {
    inWorkTree = new Set();

    await ensureGitWorktree(REPO, SRC, 'p1');

    expect(has('subtree')).toBe(false);
    expect(has('worktree')).toBe(false);
  });

  it('prunable 工作树：先用 worktree repair 自愈并恢复缺失源码，不重复 add', async () => {
    setWorktreeList([
      `worktree ${REPO}`,
      'HEAD 0000000000000000000000000000000000000000',
      'branch refs/heads/master',
      '',
      `worktree ${SRC}`,
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/dataforge/p1',
      'prunable gitdir file points to non-existent location',
      '',
    ]);
    // 目录里只剩 .git（源码文件已丢失），HEAD 仍有内容
    readDirMock.mockResolvedValue([{ name: '.git', isDirectory: false, isFile: true, isSymlink: false }]);
    const base = responder;
    responder = (call) => {
      if (call.args[2] === 'worktree' && call.args[3] === 'list') {
        return { code: 0, stdout: [
          `worktree ${REPO}`,
          'HEAD 0000000000000000000000000000000000000000',
          'branch refs/heads/master',
          '',
          `worktree ${SRC}`,
          'HEAD 1111111111111111111111111111111111111111',
          'branch refs/heads/dataforge/p1',
          'prunable gitdir file points to non-existent location',
          '',
        ].join('\n') };
      }
      if (call.args[2] === 'worktree' && call.args[3] === 'repair') {
        // repair 即使退出码非 0，.git 文件也可能已经补回来
        inWorkTree.add(SRC);
        return { code: 1, stdout: '', stderr: 'error: unable to locate repository' };
      }
      if (call.args[2] === 'ls-tree') return { code: 0, stdout: 'ddls/ads_ddl.sql\n' };
      return base(call);
    };

    await ensureGitWorktree(REPO, SRC, 'p1');

    expect(cmdList().some(c => c.includes('worktree repair'))).toBe(true);
    expect(cmdList().some(c => c.includes('worktree add'))).toBe(false);
    expect(cmdList().some(c => c.includes('checkout'))).toBe(true);
  });

  it('分支挂在旧路径（仅分隔符不同）时不 remove，不误删源码目录', async () => {
    setWorktreeList([
      `worktree ${REPO}`,
      'HEAD 0000000000000000000000000000000000000000',
      'branch refs/heads/master',
      '',
      'worktree C:\\host\\code\\p1\\src\\p1',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/dataforge/p1',
      '',
    ]);

    await ensureGitWorktree(REPO, SRC, 'p1');

    expect(has('remove')).toBe(false);
    expect(has('add')).toBe(true);
  });

  it('Windows 下路径大小写不同也视为同一路径，不 remove', async () => {
    const restore = stubWindowsUserAgent();
    try {
      setWorktreeList([
        `worktree ${REPO}`,
        'HEAD 0000000000000000000000000000000000000000',
        'branch refs/heads/master',
        '',
        'worktree c:/HOST/Code/p1/src/p1',
        'HEAD 1111111111111111111111111111111111111111',
        'branch refs/heads/dataforge/p1',
        '',
      ]);

      await ensureGitWorktree(REPO, SRC, 'p1');

      expect(has('remove')).toBe(false);
      expect(has('add')).toBe(true);
    } finally {
      restore();
    }
  });

  it('分支挂在真正的旧路径时先 remove 再 add', async () => {
    setWorktreeList([
      `worktree ${REPO}`,
      'HEAD 0000000000000000000000000000000000000000',
      'branch refs/heads/master',
      '',
      'worktree C:/host/old/p1/src/p1',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/dataforge/p1',
      '',
    ]);

    await ensureGitWorktree(REPO, SRC, 'p1');

    expect(indexOf('remove')).toBeGreaterThan(-1);
    expect(indexOf('add')).toBeGreaterThan(indexOf('remove'));
  });

  it('源码目录非空且不是工作树时跳过挂载，绝不删用户文件', async () => {
    setWorktreeList([]);
    readDirMock.mockResolvedValue([
      { name: 'ddls', isDirectory: true, isFile: false, isSymlink: false },
      { name: 'pom.xml', isDirectory: false, isFile: true, isSymlink: false },
    ]);

    await ensureGitWorktree(REPO, SRC, 'p1');

    expect(has('add')).toBe(false);
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('目录里只剩失效 .git 时清掉它再挂载', async () => {
    setWorktreeList([]);
    readDirMock.mockResolvedValue([{ name: '.git', isDirectory: false, isFile: true, isSymlink: false }]);

    await ensureGitWorktree(REPO, SRC, 'p1');

    expect(removeMock).toHaveBeenCalledWith('C:/host/code/p1/src/p1/.git', { recursive: true });
    expect(has('add')).toBe(true);
  });

  it('分支不存在时先 subtree split 再挂载', async () => {
    setWorktreeList([]);

    await ensureGitWorktree(REPO, SRC, 'p1');

    // branch --list 默认返回空 stdout → 需要切分
    expect(has('subtree')).toBe(true);
    expect(indexOf('add')).toBeGreaterThan(indexOf('subtree'));
  });

  it('subtree split 失败（仓库无该子树）时不继续挂载', async () => {
    const base = responder;
    responder = (call) => {
      if (call.args.includes('subtree')) return { code: 128, stdout: '', stderr: "prefix 'p1' not found" };
      return base(call);
    };

    await ensureGitWorktree(REPO, SRC, 'p1');

    expect(has('subtree')).toBe(true);
    expect(has('add')).toBe(false);
  });
});
