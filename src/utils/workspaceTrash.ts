import { Command } from '../bridge/shell';
import { getDirName, joinPath } from './pathUtils';
import { TRASH_DIR_NAME } from './rollbackSafety';

/**
 * 工作区回收站对 git 隐身。
 *
 * 回收站目录建在工作区根下，若不处理会以 untracked 出现在 `git status` 中，引发两处真实故障：
 *   1. `syncWorktreeWithRemote` 的前置条件是「工作区干净」，它看到未跟踪条目就直接跳过，
 *      「拉取最新代码」从此静默失效；
 *   2. Git 面板的「全选提交」/ `git add -A` 会把回收站内容一起提交进版本库。
 *
 * 处理方式是写 `info/exclude`：这是 git 的本地私有排除文件，不随仓库分发、不参与提交，
 * 是官方的「本地产物忽略」入口（不污染项目 .gitignore，因为 .gitignore 会被提交）。
 *
 * ⚠️ 作用域已实测确认：`git rev-parse --git-path info/exclude` 对链接工作树返回的仍是
 * **主仓库那一份**（`.git/info/exclude`，取自 $GIT_COMMON_DIR，并非 per-worktree）。
 * 也就是说写一次即对该仓库下所有工作树生效——由于回收站目录名固定为 `.dataforge-trash`，
 * 这与预期一致（每个项目都该忽略它），但影响范围确实超出单个项目，故记录在此。
 * 实测（git 2.50.1）：写入后工作树 status 中的 `?? .dataforge-trash/` 消失，主仓库未变脏。
 *
 * 全程 best-effort：不是 git 仓库、或没有写权限时静默跳过，不影响删除主流程。
 */

/** 本进程内已处理过的工作区（同一目录只探测一次，避免逐个文件重复读写 exclude） */
const handled = new Set<string>();

/** 绝对路径判定：POSIX 的 `/` 与 Windows 的盘符 */
const isAbsolutePath = (p: string): boolean => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);

export const ensureTrashIgnored = async (workDir: string): Promise<void> => {
  if (!workDir || handled.has(workDir)) return;
  handled.add(workDir);

  try {
    const resolved = await Command.create(
      'git',
      ['-C', workDir, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude']
    ).execute();
    if (resolved.code !== 0) return; // 不是 git 仓库：回收站天然不会被 git 看到

    const reported = resolved.stdout.trim();
    if (!reported) return;
    const excludePath = isAbsolutePath(reported) ? reported : joinPath(workDir, reported);

    const { readFile, writeFile, mkdir, exists } = await import('../bridge/fs');
    const pattern = `${TRASH_DIR_NAME}/`;

    let current = '';
    if (await exists(excludePath)) {
      current = new TextDecoder().decode(await readFile(excludePath));
      if (current.split('\n').some(l => l.trim() === pattern || l.trim() === TRASH_DIR_NAME)) return;
    }

    await mkdir(getDirName(excludePath), { recursive: true });
    const next = !current ? `${pattern}\n` : `${current}${current.endsWith('\n') ? '' : '\n'}${pattern}\n`;
    await writeFile(excludePath, new TextEncoder().encode(next));
  } catch (err) {
    // 失败不致命：回收站只是会出现在 git status 里，稍后可用其它方式补
    console.warn('[trash] 写入 info/exclude 失败，回收站可能出现在 git status 中:', err);
  }
};

/** 仅供测试：清空「已处理」缓存 */
export const __resetTrashIgnoreCache = (): void => {
  handled.clear();
};
