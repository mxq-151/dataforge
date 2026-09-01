import { isWindows as checkIsWindows, joinPath, normalizePath } from '../utils/pathUtils';
import { Command } from '../bridge/shell';

export interface GitFileStatus {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed';
  staged: boolean;
}

export interface GitStatusResult {
  branch: string;
  files: GitFileStatus[];
  ahead: number;
  behind: number;
}

export interface GitCloneResult {
  success: boolean;
  message: string;
  authRequired: boolean;
}

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  message: string;
}

export interface GitLogResult {
  entries: GitLogEntry[];
}

const isWindows = (): boolean => {
  return checkIsWindows();
};

const buildSshCommand = (sshKeyPath: string): string => {
  const normalizedKeyPath = normalizePath(sshKeyPath);
  const sshBinary = isWindows() ? 'ssh' : 'ssh';

  return `${sshBinary} -i ${normalizedKeyPath} -o StrictHostKeyChecking=accept-new -o BatchMode=yes`;
};

export const checkGitRepoExists = async (repoPath: string): Promise<boolean> => {
  try {
    const output = await Command.create('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: repoPath,
    }).execute();
    return output.code === 0;
  } catch {
    return false;
  }
};

export const gitClone = async (
  repoUrl: string,
  targetDir: string,
  sshKeyPath?: string
): Promise<GitCloneResult> => {
  try {
    const env: Record<string, string> = {};
    if (sshKeyPath) {
      env['SSH_ASKPASS'] = '';
      env['SSH_ASKPASS_REQUIRE'] = 'force';
      env['GIT_SSH_COMMAND'] = buildSshCommand(sshKeyPath);
    }

    const output = await Command.create('git', ['clone', repoUrl, targetDir, '--progress'], {
      env: Object.keys(env).length > 0 ? env : undefined,
    }).execute();

    if (output.code !== 0) {
      const stderr = output.stderr.toLowerCase();
      const stdout = output.stdout.toLowerCase();
      const combinedError = (stderr + stdout);

      const authRequired = combinedError.includes('authentication failed') ||
                          combinedError.includes('could not read from remote repository') ||
                          combinedError.includes('permission denied') ||
                          combinedError.includes('fatal: could not read password') ||
                          combinedError.includes('fatal: authentication failed') ||
                          combinedError.includes('support for password authentication');

      return {
        success: false,
        message: output.stderr || output.stdout || 'git clone failed',
        authRequired,
      };
    }

    return { success: true, message: 'Repository cloned successfully', authRequired: false };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const authRequired = errorMessage.toLowerCase().includes('authentication') ||
                        errorMessage.toLowerCase().includes('permission denied') ||
                        errorMessage.toLowerCase().includes('could not read');

    return {
      success: false,
      message: errorMessage,
      authRequired,
    };
  }
};

export const gitPull = async (
  repoPath: string,
  sshKeyPath?: string
): Promise<GitCloneResult> => {
  try {
    const env: Record<string, string> = {};
    if (sshKeyPath) {
      env['SSH_ASKPASS'] = '';
      env['SSH_ASKPASS_REQUIRE'] = 'force';
      env['GIT_SSH_COMMAND'] = buildSshCommand(sshKeyPath);
    }

    const output = await Command.create('git', ['pull', '--progress'], {
      cwd: repoPath,
      env: Object.keys(env).length > 0 ? env : undefined,
    }).execute();

    if (output.code !== 0) {
      const stderr = output.stderr.toLowerCase();
      const stdout = output.stdout.toLowerCase();
      const combinedError = (stderr + stdout);

      const authRequired = combinedError.includes('authentication failed') ||
                          combinedError.includes('could not read from remote repository') ||
                          combinedError.includes('permission denied') ||
                          combinedError.includes('fatal: could not read password') ||
                          combinedError.includes('fatal: authentication failed') ||
                          combinedError.includes('support for password authentication');

      return {
        success: false,
        message: output.stderr || output.stdout || 'git pull failed',
        authRequired,
      };
    }

    return { success: true, message: output.stdout || 'Pull successful', authRequired: false };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const authRequired = errorMessage.toLowerCase().includes('authentication') ||
                        errorMessage.toLowerCase().includes('permission denied') ||
                        errorMessage.toLowerCase().includes('could not read');

    return {
      success: false,
      message: errorMessage,
      authRequired,
    };
  }
};

/**
 * 初始化一个本地 git 仓库（无远程地址时的默认 warehouse 仓库）。
 * 幂等：仓库已存在则直接返回成功。初始化后确保存在一个 HEAD 提交，
 * 供后续 subtree split / worktree 挂载使用。
 */
export const gitInit = async (repoPath: string): Promise<{ success: boolean; message: string }> => {
  try {
    if (await checkGitRepoExists(repoPath)) {
      return { success: true, message: 'Repository already exists' };
    }
    // git init 不会创建父目录；仓库目录可能尚未创建（如 baseWorkspace 首次初始化时），先补齐
    try {
      const { mkdir } = await import('../bridge/fs');
      await mkdir(repoPath, { recursive: true });
    } catch {
      // fs 桥不可用时交给 git init 兜底（父目录存在时仍可创建）
    }
    const init = await Command.create('git', ['init', '-b', 'master', repoPath]).execute();
    if (init.code !== 0) {
      // 旧版 git 不支持 -b，回退到默认分支命名后置空提交
      if (!init.stderr?.includes('unknown option')) {
        return { success: false, message: init.stderr || init.stdout || 'git init failed' };
      }
      await Command.create('git', ['init', repoPath]).execute();
    }
    // 确保仓库存在 HEAD 提交（subtree split / worktree add 均依赖它）
    const hasHead = await Command.create('git', ['-C', repoPath, 'rev-parse', '--verify', 'HEAD']).execute();
    if (hasHead.code !== 0) {
      await Command.create('git', ['-C', repoPath, 'add', '-A']).execute();
      await Command.create('git', ['-C', repoPath, 'commit', '--allow-empty', '-m', 'init: local warehouse']).execute();
    }
    return { success: true, message: 'Local warehouse initialized' };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
};

export const gitStatus = async (rootPath: string): Promise<GitStatusResult> => {
  try {
    const output = await Command.create('git', ['-c', 'core.quotePath=false', 'status', '--porcelain=v2', '--branch', '-uall'], {
      cwd: rootPath,
    }).execute();

    if (output.code !== 0) {
      throw new Error(output.stderr || 'git status failed');
    }

    const lines = output.stdout.split('\n').filter(Boolean);
    const files: GitFileStatus[] = [];
    let branch = '';
    let ahead = 0;
    let behind = 0;

    for (const line of lines) {
      if (line.startsWith('# branch.head')) {
        branch = line.split(' ').pop() || '';
      } else if (line.startsWith('# branch.ab')) {
        const parts = line.split(' ');
        ahead = Math.abs(parseInt(parts.find(p => p.startsWith('+'))?.slice(1) || '0', 10));
        behind = Math.abs(parseInt(parts.find(p => p.startsWith('-'))?.slice(1) || '0', 10));
      } else if (line.startsWith('1 ') || line.startsWith('2 ') || line.startsWith('u ')) {
        const parts = line.split(' ');
        const xy = parts[1];
        const filePath = parts.slice(-1)[0];

        let status: GitFileStatus['status'] = 'modified';
        let staged = false;

        if (xy) {
          const indexStatus = xy[0];
          const workTreeStatus = xy[1];

          if (indexStatus === 'A') { status = 'added'; staged = true; }
          else if (indexStatus === 'D') { status = 'deleted'; staged = true; }
          else if (indexStatus === 'R') { status = 'renamed'; staged = true; }
          else if (indexStatus === 'M') { status = 'modified'; staged = true; }
          else if (workTreeStatus === 'M') { status = 'modified'; staged = false; }
          else if (workTreeStatus === 'D') { status = 'deleted'; staged = false; }
          else if (workTreeStatus === 'A' || indexStatus === '?') { status = 'untracked'; staged = false; }
        }

        files.push({ path: filePath, status, staged });
      } else if (line.startsWith('? ')) {
        files.push({
          path: line.slice(2),
          status: 'untracked',
          staged: false,
        });
      }
    }

    return { branch, files, ahead, behind };
  } catch (err) {
    console.error('Git status failed:', err);
    throw err instanceof Error ? err : new Error('git status failed');
  }
};

export const gitAdd = async (rootPath: string, filePaths: string[]): Promise<void> => {
  try {
    const output = await Command.create('git', ['add', ...filePaths], {
      cwd: rootPath,
    }).execute();

    if (output.code !== 0) {
      throw new Error(output.stderr || 'git add failed');
    }
  } catch (err) {
    console.error('Git add failed:', err);
    throw err;
  }
};

export const gitCommit = async (rootPath: string, message: string): Promise<string> => {
  try {
    const output = await Command.create('git', ['commit', '-m', message], {
      cwd: rootPath,
    }).execute();

    if (output.code !== 0) {
      throw new Error(output.stderr || 'git commit failed');
    }

    return output.stdout;
  } catch (err) {
    console.error('Git commit failed:', err);
    throw err;
  }
};

export const gitDiff = async (rootPath: string, filePath: string): Promise<string> => {
  try {
    const output = await Command.create('git', ['diff', filePath], {
      cwd: rootPath,
    }).execute();

    return output.stdout;
  } catch (err) {
    console.error('Git diff failed:', err);
    return '';
  }
};

export const gitPush = async (
  rootPath: string,
  sshKeyPath?: string
): Promise<GitCloneResult> => {
  try {
    const env: Record<string, string> = {};
    if (sshKeyPath) {
      env['SSH_ASKPASS'] = '';
      env['SSH_ASKPASS_REQUIRE'] = 'force';
      env['GIT_SSH_COMMAND'] = buildSshCommand(sshKeyPath);
    }

    // 分支可能无上游（如 subtree split 新建的 dataforge/{pc} 分支），
    // 启用 push.autoSetupRemote 使首次推送自动设置远程跟踪，避免 "no upstream branch" 报错。
    await Command.create('git', ['config', 'push.autoSetupRemote', 'true'], {
      cwd: rootPath,
    }).execute();

    const output = await Command.create('git', ['push', '--progress'], {
      cwd: rootPath,
      env: Object.keys(env).length > 0 ? env : undefined,
    }).execute();

    if (output.code !== 0) {
      const combinedError = (output.stderr + output.stdout).toLowerCase();
      const authRequired = combinedError.includes('authentication failed') ||
                          combinedError.includes('could not read from remote repository') ||
                          combinedError.includes('permission denied') ||
                          combinedError.includes('fatal: could not read password');

      return {
        success: false,
        message: output.stderr || output.stdout || 'git push failed',
        authRequired,
      };
    }

    return { success: true, message: output.stdout || 'Push successful', authRequired: false };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return { success: false, message: errorMessage, authRequired: false };
  }
};

export const gitLog = async (rootPath: string, maxCount = 50): Promise<GitLogResult> => {
  try {
    // 使用 || 作为字段分隔符，避免 commit message 中的空格影响解析
    const format = '%H||%h||%an||%ad||%s';
    const output = await Command.create('git', ['-c', 'core.quotePath=false', 'log', `--max-count=${maxCount}`, `--pretty=format:${format}`, '--date=short'], {
      cwd: rootPath,
    }).execute();

    if (output.code !== 0) {
      return { entries: [] };
    }

    const entries: GitLogEntry[] = output.stdout
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [hash, shortHash, author, date, ...messageParts] = line.split('||');
        return {
          hash: hash || '',
          shortHash: shortHash || '',
          author: author || '',
          date: date || '',
          message: (messageParts.join('||') || '').trim(),
        };
      });

    return { entries };
  } catch (err) {
    console.error('Git log failed:', err);
    return { entries: [] };
  }
};

export const gitReset = async (rootPath: string, commitHash: string, mode: 'hard' | 'soft' = 'hard'): Promise<void> => {
  try {
    const output = await Command.create('git', ['reset', `--${mode}`, commitHash], {
      cwd: rootPath,
    }).execute();

    if (output.code !== 0) {
      throw new Error(output.stderr || 'git reset failed');
    }
  } catch (err) {
    console.error('Git reset failed:', err);
    throw err;
  }
};

/** 判断某目录是否位于（仓库或链接工作树的）git 工作树内 */
const isInsideWorkTree = async (dir: string): Promise<boolean> => {
  try {
    const output = await Command.create('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree']).execute();
    return output.code === 0;
  } catch {
    return false;
  }
};

const sanitizeBranchSegment = (s: string): string => s.replace(/[^a-zA-Z0-9_.\-/]/g, '_').replace(/\/{2,}/g, '/');

/** 路径比较用归一化：统一分隔符、去尾部斜杠；Windows 再忽略大小写 */
const comparePathKey = (p: string): string => {
  const key = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return isWindows() ? key.toLowerCase() : key;
};

const samePath = (a: string, b: string): boolean => comparePathKey(a) === comparePathKey(b);

interface WorktreeEntry {
  path: string;
  branch: string;
  prunable: boolean;
}

/** 解析 `git worktree list --porcelain` 输出 */
const parseWorktreeList = (stdout: string): WorktreeEntry[] => {
  const entries: WorktreeEntry[] = [];
  let cur: WorktreeEntry | null = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length).trim(), branch: '', prunable: false };
      entries.push(cur);
    } else if (cur && line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).trim();
    } else if (cur && line.startsWith('prunable')) {
      cur.prunable = true;
    }
  }
  return entries;
};

/** 源码目录的状态，决定能否就地挂载 git 工作树（git 要求目标目录不存在或为空） */
type DirState = 'missing' | 'empty' | 'staleGitOnly' | 'occupied';

const inspectMountDir = async (dir: string): Promise<DirState> => {
  let names: string[];
  try {
    const { readDir } = await import('../bridge/fs');
    names = (await readDir(dir)).map(e => e.name);
  } catch {
    return 'missing';
  }
  const rest = names.filter(n => n !== '.git');
  if (rest.length > 0) return 'occupied';
  if (names.length === 0) return 'empty';
  return 'staleGitOnly';
};

/**
 * 工作树已挂载但源码文件全部缺失时，从 index 恢复。
 *
 * 典型成因：链接工作树的 `.git` 文件丢失后目录被清空（或被误删），
 * git 侧仍完整持有 index 与 HEAD，此时目录里一个文件都没有，
 * 属于明确的损坏状态（正常项目的目录不可能为空而分支又有内容），直接恢复即可。
 */
const restoreMissingWorktreeFiles = async (workTreeDir: string): Promise<void> => {
  try {
    const { readDir } = await import('../bridge/fs');
    const names = (await readDir(workTreeDir)).map(e => e.name).filter(n => n !== '.git');
    if (names.length > 0) return;
    const lsTree = await Command.create('git', ['-C', workTreeDir, 'ls-tree', '-r', '--name-only', 'HEAD']).execute();
    if (lsTree.code !== 0 || !lsTree.stdout.trim()) return; // 分支本来就没有内容，无需恢复
    const checkout = await Command.create('git', ['-C', workTreeDir, 'checkout', '--', '.']).execute();
    if (checkout.code !== 0) {
      console.warn('[git] 恢复工作树缺失文件失败:', checkout.stderr);
      return;
    }
    console.log(`[git] 已恢复工作树缺失的源码文件: ${workTreeDir}`);
  } catch (err) {
    console.warn('[git] restoreMissingWorktreeFiles 异常:', err);
  }
};

/** 串行化 fetch（避免多个项目并发 fetch 撞同一仓库的 .git 锁） */
let fetchQueue: Promise<void> = Promise.resolve();
const fetchOrigin = (repoRoot: string): Promise<void> => {
  const task = fetchQueue.then(() =>
    Command.create('git', ['-C', repoRoot, 'fetch', 'origin'])
      .execute()
      .then(() => undefined)
  );
  fetchQueue = task.catch(() => undefined);
  return task;
};

/**
 * 工作树已挂载时，把其分支 fast-forward 到远端最新。
 *
 * 背景：App 启动的自动同步只在主仓库上 `git pull`（更新 master），
 * 而工作树挂载的 dataforge/{pc} 分支不会自动前进，导致「拉取最新代码」后
 * 工作树仍停留在旧提交。这里在工作树干净且可 fast-forward 时，主动
 * fetch 远端并把工作树前进到 origin/{branch}，让拉取真正生效。
 *
 * 安全边界（任一不满足就跳过，绝不丢数据）：
 *   - 工作树有未提交改动（status 非空）→ 跳过，交由用户手动 pull；
 *   - 本地分支领先远端或与远端分叉 → merge --ff-only 失败 → 跳过；
 *   - 无 origin/{branch} 远端分支 → 跳过。
 */
const syncWorktreeWithRemote = async (
  repoRoot: string,
  workTreeDir: string,
  branch: string,
): Promise<void> => {
  try {
    // 工作树必须干净，否则不自动前进（避免覆盖智能体的未提交改动）
    const status = await Command.create('git', ['-C', workTreeDir, 'status', '--porcelain']).execute();
    if (status.code !== 0 || status.stdout.trim()) return;

    // fetch 远端（默认 refspec 会更新所有 origin/* 跟踪分支）
    await fetchOrigin(repoRoot);

    const upstream = `origin/${branch}`;
    const verify = await Command.create('git', ['-C', repoRoot, 'rev-parse', '--verify', upstream]).execute();
    if (verify.code !== 0) return; // 无远端分支，跳过

    // 仅 fast-forward：本地落后时前进；已最新/领先/分叉则跳过（不覆盖本地提交）
    const ff = await Command.create('git', ['-C', workTreeDir, 'merge', '--ff-only', upstream]).execute();
    if (ff.code === 0) {
      console.log(`[git] 已同步工作树到远端最新: ${workTreeDir} -> ${upstream}`);
    }
  } catch (err) {
    console.warn('[git] syncWorktreeWithRemote 异常:', err);
  }
};

/**
 * 为项目建立「链接工作树」并挂到项目源码目录 workTreeDir（如 code/{pc}/src/{pc}），
 * 使 git 直接读取/提交 workTreeDir 里的真实文件。
 *
 * 背景：git 仓库位于 hostBase/{gitRepoDirName}（share 仓库），仓库按 {project_code}/ 子目录组织各项目；
 * 而智能体/文件浏览器的源码目录为 code/{project_code}/src/{project_code}。git 不跟随目录软链递归提交内容，
 * 因此对每个项目用 `git subtree split` 把 {project_code} 子树切成独立分支（该分支根 = 项目源码根），
 * 再用 `git worktree add` 把该分支挂到 workTreeDir，即把仓库 {project_code} 子树与源码目录关联起来。
 * 之后从 workTreeDir 发起的 status/add/commit/push 均直接操作真实源码并提交进 share 仓库。
 *
 * 幂等：workTreeDir 已是链接工作树则直接复用；若该分支此前挂在旧路径（迁移目录结构后遗留），
 * 会先移除旧工作树再挂到新 workTreeDir，避免 "branch is already checked out" 导致拉取失败。
 *
 * 自愈：链接工作树的 `.git` 文件一旦丢失（目录被清空等），该工作树会变成 prunable ——
 * worktree remove 校验失败、worktree add 又报 "already exists"，永久卡住。
 * 这里先跑 `git worktree repair` 重建 .git 文件，成功则复用原工作树并恢复缺失的源码文件。
 */
export const ensureGitWorktree = async (
  repoRoot: string,
  workTreeDir: string,
  projectCode: string,
): Promise<void> => {
  if (!repoRoot || !workTreeDir || !projectCode) return;
  // 仓库未就绪（未配置 gitRepoDirName / 尚未 clone）时不处理
  if (!(await checkGitRepoExists(repoRoot))) return;

  const branch = `dataforge/${sanitizeBranchSegment(projectCode)}`;

  // 已是链接工作树 → 复用，并尝试 fast-forward 到远端最新（让「拉取最新代码」生效）
  if (await isInsideWorkTree(workTreeDir)) {
    await syncWorktreeWithRemote(repoRoot, workTreeDir, branch);
    return;
  }

  try {
    // 1) 确保 per-project 分支存在（根 = 项目源码）。分支已存在则跳过切分。
    const listRes = await Command.create('git', ['-C', repoRoot, 'branch', '--list', branch]).execute();
    if (listRes.code !== 0 || !listRes.stdout.trim()) {
      const splitRes = await Command.create('git', ['-C', repoRoot, 'subtree', 'split', '--prefix', projectCode, '--branch', branch, 'HEAD']).execute();
      if (splitRes.code !== 0) {
        console.warn(`[git] subtree split 失败（仓库缺少 ${projectCode}/ 子树?）:`, splitRes.stderr);
        return; // 无法建立工作树，交由 Git 操作侧提示
      }
    }

    // 2) 清理无效工作树登记，并定位该分支当前挂载路径（可能有迁移目录结构后遗留的旧路径）
    await Command.create('git', ['-C', repoRoot, 'worktree', 'prune']).execute();
    const wl = await Command.create('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain']).execute();
    const entries = wl.code === 0 ? parseWorktreeList(wl.stdout) : [];
    // 路径比较必须归一化：git 输出形如 C:/a/b，而渲染层拼出来可能是 C:\a\b（且大小写可能不同），
    // 直接字符串比较会误判为「挂在旧路径」，进而 worktree remove 掉正在使用的源码目录。
    const existing = entries.find(e => e.branch === `refs/heads/${branch}`)?.path || '';

    // 3) 若该分支挂在别的路径，先移除旧工作树，释放分支（remove 会连目录一起删，故只在路径确实不同时才做）
    if (existing && !samePath(existing, workTreeDir)) {
      const rm = await Command.create('git', ['-C', repoRoot, 'worktree', 'remove', '--force', existing]).execute();
      if (rm.code !== 0) {
        console.warn('[git] 移除旧工作树失败，无法迁移挂载点:', existing, rm.stderr);
        return;
      }
      console.log(`[git] 已移除旧工作树 ${existing}，将在新位置重新挂载: ${workTreeDir}`);
    }

    // 4) 自愈 prunable 工作树：链接工作树的 `.git` 文件丢失后，
    //    既无法 worktree remove（校验失败）也无法 worktree add（分支已检出 / 目录已存在），会永久卡死。
    //    git worktree repair 会重建该 .git 文件；它即使报错也可能已完成修复，故忽略退出码后复查。
    if (existing) {
      await Command.create('git', ['-C', repoRoot, 'worktree', 'repair', workTreeDir]).execute();
      if (await isInsideWorkTree(workTreeDir)) {
        console.log(`[git] 已修复链接工作树: ${workTreeDir} (${branch})`);
        await restoreMissingWorktreeFiles(workTreeDir);
        return;
      }
    }

    // 5) 挂载链接工作树：git 要求目标目录不存在或为空，非空目录会报 "already exists"
    const dirState = await inspectMountDir(workTreeDir);
    if (dirState === 'occupied') {
      console.warn(`[git] 源码目录非空且不是 git 工作树，跳过挂载以免覆盖已有文件: ${workTreeDir}`);
      return;
    }
    if (dirState === 'staleGitOnly') {
      // 只剩一个失效的 .git（文件或目录），清掉后重新挂载
      const { remove } = await import('../bridge/fs');
      await remove(joinPath(workTreeDir, '.git'), { recursive: true });
    }

    const addRes = await Command.create('git', ['-C', repoRoot, 'worktree', 'add', '--force', workTreeDir, branch]).execute();
    if (addRes.code !== 0) {
      console.warn('[git] 挂载链接工作树失败:', addRes.stderr);
      return;
    }
    console.log(`[git] 已为 ${projectCode} 挂载链接工作树: ${workTreeDir} -> ${repoRoot} (${branch})`);
    await restoreMissingWorktreeFiles(workTreeDir);
    // 挂载后立即同步到远端最新：分支可能早已存在且落后远端，worktree add 会挂到旧提交
    await syncWorktreeWithRemote(repoRoot, workTreeDir, branch);
  } catch (err) {
    console.warn('[git] ensureGitWorktree 异常:', err);
  }
};

/**
 * 列出某个文件在 git 历史中的提交记录（含删除/改名历史，--follow）。
 * relPath 为相对仓库根的路径（POSIX 分隔符）。
 */
export const gitLogFile = async (
  rootPath: string,
  relPath: string,
  maxCount = 200
): Promise<GitLogResult> => {
  try {
    const format = '%H||%h||%an||%ad||%s';
    const output = await Command.create(
      'git',
      ['-c', 'core.quotePath=false', 'log', '--follow', `--max-count=${maxCount}`, `--pretty=format:${format}`, '--date=format:%Y-%m-%d %H:%M:%S', '--', relPath],
      { cwd: rootPath }
    ).execute();

    if (output.code !== 0) {
      return { entries: [] };
    }

    const entries: GitLogEntry[] = output.stdout
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [hash, shortHash, author, date, ...messageParts] = line.split('||');
        return {
          hash: hash || '',
          shortHash: shortHash || '',
          author: author || '',
          date: date || '',
          message: (messageParts.join('||') || '').trim(),
        };
      });

    return { entries };
  } catch (err) {
    console.error('Git file log failed:', err);
    return { entries: [] };
  }
};

/**
 * 读取指定提交中某文件的完整内容。
 * relPath 为相对仓库根的路径。若该提交中文件不存在（如提交时文件已被删除）则返回 null。
 */
export const gitShowFileContent = async (
  rootPath: string,
  commitHash: string,
  relPath: string
): Promise<string | null> => {
  try {
    const output = await Command.create(
      'git',
      ['-C', rootPath, 'show', `${commitHash}:${relPath}`]
    ).execute();

    if (output.code !== 0) {
      return null;
    }
    return output.stdout;
  } catch (err) {
    console.error('Git show file content failed:', err);
    return null;
  }
};

/**
 * 撤销（还原）某个文件的所有未提交改动（含已暂存与未暂存），恢复到上次提交(HEAD)状态。
 * relPath 为相对仓库根的 POSIX 路径。文件未被 git 跟踪或无可撤销改动时返回 false。
 */
export const gitRestoreFile = async (
  rootPath: string,
  relPath: string
): Promise<boolean> => {
  try {
    const output = await Command.create(
      'git',
      ['-C', rootPath, 'restore', '--staged', '--worktree', '--', relPath]
    ).execute();
    return output.code === 0;
  } catch (err) {
    console.error('Git restore file failed:', err);
    return false;
  }
};

/** 判断文件是否有未提交的变更（已跟踪文件的改动；untracked/未纳入管理视为无可撤销变更） */
export const gitFileHasChanges = async (
  rootPath: string,
  relPath: string
): Promise<boolean> => {
  try {
    const output = await Command.create(
      'git',
      ['-C', rootPath, 'status', '--porcelain', '--', relPath]
    ).execute();
    if (output.code !== 0) return false;
    const lines = output.stdout.split('\n').map(l => l.trim()).filter(Boolean);
    return lines.some(l => !l.startsWith('??'));
  } catch (err) {
    console.error('Git check file changes failed:', err);
    return false;
  }
};

/** 计算磁盘绝对路径相对仓库根的 POSIX 相对路径 */
export const toRepoRelativePath = (filePath: string, repoPath: string): string => {
  const sep = filePath.includes('\\') ? '\\' : '/';
  const parts = filePath.split(sep);
  const repoParts = repoPath.split(sep);
  const diff: string[] = [];
  const max = Math.max(parts.length, repoParts.length);
  for (let i = 0; i < max; i++) {
    if (parts[i] !== repoParts[i]) {
      for (let j = i; j < parts.length; j++) diff.push(parts[j]);
      break;
    }
  }
  return diff.length > 0 ? diff.join('/') : (filePath.split(/[/\\]/).pop() || filePath);
};
