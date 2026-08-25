import { isWindows as checkIsWindows, normalizePath } from '../utils/pathUtils';

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

const isTauri = async (): Promise<boolean> => {
  try {
    await import('@tauri-apps/api/app');
    return true;
  } catch {
    return false;
  }
};

const isWindows = (): boolean => {
  return checkIsWindows();
};

const buildSshCommand = (sshKeyPath: string): string => {
  const normalizedKeyPath = normalizePath(sshKeyPath);
  const sshBinary = isWindows() ? 'ssh' : 'ssh';

  return `${sshBinary} -i ${normalizedKeyPath} -o StrictHostKeyChecking=accept-new -o BatchMode=yes`;
};

export const checkGitRepoExists = async (repoPath: string): Promise<boolean> => {
  const tauriAvailable = await isTauri();
  if (!tauriAvailable) return false;

  try {
    const { Command } = await import('@tauri-apps/plugin-shell');
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
  const tauriAvailable = await isTauri();
  if (!tauriAvailable) return { success: false, message: 'Git operations require Tauri environment', authRequired: false };

  try {
    const { Command } = await import('@tauri-apps/plugin-shell');

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
  const tauriAvailable = await isTauri();
  if (!tauriAvailable) return { success: false, message: 'Git operations require Tauri environment', authRequired: false };

  try {
    const { Command } = await import('@tauri-apps/plugin-shell');

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
  const tauriAvailable = await isTauri();

  if (tauriAvailable) {
    try {
      const { Command } = await import('@tauri-apps/plugin-shell');
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
      console.error('Git status via Tauri failed:', err);
      throw err instanceof Error ? err : new Error('git status failed');
    }
  }

  return { branch: '', files: [], ahead: 0, behind: 0 };
};

export const gitAdd = async (rootPath: string, filePaths: string[]): Promise<void> => {
  const tauriAvailable = await isTauri();
  if (!tauriAvailable) return;

  try {
    const { Command } = await import('@tauri-apps/plugin-shell');
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
  const tauriAvailable = await isTauri();
  if (!tauriAvailable) throw new Error('Git operations require Tauri environment');

  try {
    const { Command } = await import('@tauri-apps/plugin-shell');
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
  const tauriAvailable = await isTauri();
  if (!tauriAvailable) return '';

  try {
    const { Command } = await import('@tauri-apps/plugin-shell');
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
  const tauriAvailable = await isTauri();
  if (!tauriAvailable) return { success: false, message: 'Git operations require Tauri environment', authRequired: false };

  try {
    const { Command } = await import('@tauri-apps/plugin-shell');

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
  const tauriAvailable = await isTauri();
  if (!tauriAvailable) return { entries: [] };

  try {
    const { Command } = await import('@tauri-apps/plugin-shell');
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
  const tauriAvailable = await isTauri();
  if (!tauriAvailable) return;

  try {
    const { Command } = await import('@tauri-apps/plugin-shell');
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
