import { isWindows as checkIsWindows, normalizePath } from '../utils/pathUtils';
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

/**
 * 为项目建立「链接工作树」并挂到项目源码目录 workTreeDir（如 code/{pc}/src/main/java/{pc}），
 * 使 git 直接读取/提交 workTreeDir 里的真实文件。
 *
 * 背景：git 仓库位于 hostBase/{gitRepoDirName}（share 仓库），仓库按 {project_code}/ 子目录组织各项目；
 * 而智能体/文件浏览器的源码目录为 code/{project_code}/src/main/java/{project_code}。git 不跟随目录软链递归提交内容，
 * 因此对每个项目用 `git subtree split` 把 {project_code} 子树切成独立分支（该分支根 = 项目源码根），
 * 再用 `git worktree add` 把该分支挂到 workTreeDir，即把仓库 {project_code} 子树与源码目录关联起来。
 * 之后从 workTreeDir 发起的 status/add/commit/push 均直接操作真实源码并提交进 share 仓库。
 *
 * 幂等：workTreeDir 已是链接工作树则直接复用；若该分支此前挂在旧路径（迁移目录结构后遗留），
 * 会先移除旧工作树再挂到新 workTreeDir，避免 "branch is already checked out" 导致拉取失败。
 */
export const ensureGitWorktree = async (
  repoRoot: string,
  workTreeDir: string,
  projectCode: string,
): Promise<void> => {
  if (!repoRoot || !workTreeDir || !projectCode) return;
  // 仓库未就绪（未配置 gitRepoDirName / 尚未 clone）时不处理
  if (!(await checkGitRepoExists(repoRoot))) return;
  // 已是链接工作树 → 复用
  if (await isInsideWorkTree(workTreeDir)) return;

  const branch = `dataforge/${sanitizeBranchSegment(projectCode)}`;
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

    // 2) 清理旧的 prunable 工作树，并定位该分支当前挂载的工作树路径（可能有迁移目录结构后遗留的旧路径）
    await Command.create('git', ['-C', repoRoot, 'worktree', 'prune']).execute();
    let existing = '';
    const wl = await Command.create('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain']).execute();
    if (wl.code === 0) {
      let cur = '';
      for (const line of wl.stdout.split('\n')) {
        if (line.startsWith('worktree ')) {
          cur = line.slice('worktree '.length).trim();
        } else if (line.startsWith('branch ') && line.slice('branch '.length).trim() === `refs/heads/${branch}`) {
          existing = cur;
        } else if (line.trim() === '') {
          cur = '';
        }
      }
    }

    // 3) 若该分支挂在旧路径（≠ workTreeDir），先移除旧工作树，释放分支
    if (existing && existing !== workTreeDir) {
      const rm = await Command.create('git', ['-C', repoRoot, 'worktree', 'remove', '--force', existing]).execute();
      if (rm.code !== 0) {
        console.warn('[git] 移除旧工作树失败，无法迁移挂载点:', existing, rm.stderr);
        return;
      }
      console.log(`[git] 已移除旧工作树 ${existing}，将在新位置重新挂载: ${workTreeDir}`);
    }

    // 4) 把该分支挂为 workTreeDir 的链接工作树
    const addRes = await Command.create('git', ['-C', repoRoot, 'worktree', 'add', '--force', workTreeDir, branch]).execute();
    if (addRes.code !== 0) {
      console.warn('[git] 挂载链接工作树失败:', addRes.stderr);
      return;
    }
    console.log(`[git] 已为 ${projectCode} 挂载链接工作树: ${workTreeDir} -> ${repoRoot} (${branch})`);
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
