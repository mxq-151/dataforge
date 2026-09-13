/**
 * workspaceTrash.test.ts — 回收站对 git 隐身的实现
 *
 * 为什么要测：这段逻辑会往用户的 git 本地排除文件（$GIT_DIR/info/exclude）里追加内容，
 * 写坏了会让用户整个仓库的忽略规则变形，所以逐条锁死「写什么、什么时候不写」。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const executeMock = vi.fn();

vi.mock('../bridge/shell', () => ({
  Command: {
    create: (_program: string, args: string[]) => ({
      execute: () => executeMock(args),
    }),
  },
}));

/** 假的文件系统：路径 → 内容 */
const files = new Map<string, string>();
const mkdirCalls: string[] = [];

vi.mock('../bridge/fs', () => ({
  exists: async (p: string) => files.has(p),
  readFile: async (p: string) => new TextEncoder().encode(files.get(p) ?? ''),
  writeFile: async (p: string, data: Uint8Array) => {
    files.set(p, new TextDecoder().decode(data));
  },
  mkdir: async (p: string) => {
    mkdirCalls.push(p);
  },
}));

import { ensureTrashIgnored, __resetTrashIgnoreCache } from './workspaceTrash';

const WORK = '/repo/worktree';
const EXCLUDE = '/repo/.git/worktrees/wt/info/exclude';

beforeEach(() => {
  files.clear();
  mkdirCalls.length = 0;
  __resetTrashIgnoreCache();
  executeMock.mockReset();
  // 默认：是 git 仓库，排除文件解析为绝对路径
  executeMock.mockResolvedValue({ code: 0, stdout: `${EXCLUDE}\n`, stderr: '' });
});

describe('ensureTrashIgnored', () => {
  it('非 git 仓库时静默跳过（回收站天然不会被 git 看到）', async () => {
    executeMock.mockResolvedValue({ code: 128, stdout: '', stderr: 'not a git repository' });

    await ensureTrashIgnored(WORK);

    expect(files.size).toBe(0);
  });

  it('排除文件不存在时新建，并只写回收站目录一行', async () => {
    await ensureTrashIgnored(WORK);

    expect(files.get(EXCLUDE)).toBe('.dataforge-trash/\n');
    expect(mkdirCalls).toContain('/repo/.git/worktrees/wt/info'); // 父目录先建出来
  });

  it('已有其它规则且文件不以换行结尾时，先补换行再追加（不把两条规则粘成一行）', async () => {
    files.set(EXCLUDE, '*.log');

    await ensureTrashIgnored(WORK);

    expect(files.get(EXCLUDE)).toBe('*.log\n.dataforge-trash/\n');
  });

  it('已有其它规则且以换行结尾时直接追加', async () => {
    files.set(EXCLUDE, '*.log\n');

    await ensureTrashIgnored(WORK);

    expect(files.get(EXCLUDE)).toBe('*.log\n.dataforge-trash/\n');
  });

  it('已包含该规则时不再重复写入', async () => {
    files.set(EXCLUDE, '*.log\n.dataforge-trash/\n');

    await ensureTrashIgnored(WORK);

    expect(files.get(EXCLUDE)).toBe('*.log\n.dataforge-trash/\n');
  });

  it('规则写成不带斜杠的目录名也视为已忽略', async () => {
    files.set(EXCLUDE, '.dataforge-trash\n');

    await ensureTrashIgnored(WORK);

    expect(files.get(EXCLUDE)).toBe('.dataforge-trash\n');
  });

  it('同一工作区只探测一次（避免逐个文件重复读写排除文件）', async () => {
    await ensureTrashIgnored(WORK);
    await ensureTrashIgnored(WORK);
    await ensureTrashIgnored(WORK);

    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it('git 返回相对路径时按工作区解析', async () => {
    executeMock.mockResolvedValue({ code: 0, stdout: '.git/worktrees/wt/info/exclude\n', stderr: '' });

    await ensureTrashIgnored(WORK);

    expect(files.get(`${WORK}/.git/worktrees/wt/info/exclude`)).toBe('.dataforge-trash/\n');
  });

  it('写排除文件抛错时不向上冒泡（best-effort，不影响删除主流程）', async () => {
    executeMock.mockRejectedValue(new Error('boom'));

    await expect(ensureTrashIgnored(WORK)).resolves.toBeUndefined();
    expect(files.size).toBe(0);
  });
});
