/**
 * 编译 / LSP 工程相关公共工具（lib.rs 与 lsp/mod.rs 对应逻辑的 TS 移植）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';

export const isWindows = process.platform === 'win32';

/** 将后端地址（如 http://localhost:8080）转换为安全的目录名（如 localhost_8080）。 */
export function hostLabel(host: string): string {
  let h = host.trim();
  if (!h) return 'default';
  const schemeIdx = h.indexOf('://');
  if (schemeIdx >= 0) h = h.slice(schemeIdx + 3);
  const cut = h.search(/[/?#]/);
  if (cut >= 0) h = h.slice(0, cut);
  const cleaned = h
    .split('')
    .map((c) => (/[A-Za-z0-9._-]/.test(c) ? c : '_'))
    .join('');
  return cleaned || 'default';
}

/** 生成 YYYYMMDD_HHmmss（UTC，与 Rust format_timestamp 的 UTS 日历算法一致）。 */
export function formatTimestamp(): string {
  const d = new Date();
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}_` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

/** 工作空间根目录（与 Rust 侧一致：$HOME/.dataforge）。 */
export function workspaceHome(): string {
  return path.join(os.homedir(), '.dataforge');
}

/** 解析 mvn 可执行文件路径（优先 mavenHome/bin，fallback 系统 PATH）。 */
export function resolveMvnBin(mavenHome: string): string {
  const mvnName = isWindows ? 'mvn.cmd' : 'mvn';
  if (mavenHome.trim()) {
    const p1 = path.join(mavenHome.trim(), 'bin', mvnName);
    if (fs.existsSync(p1)) return p1;
    const p2 = path.join(mavenHome.trim(), 'bin', 'mvn');
    if (fs.existsSync(p2)) return p2;
  }
  return mvnName;
}

/** canonicalize，失败时回退绝对路径（对应 Rust canonicalize().unwrap_or_else）。 */
function canonicalOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** 路径是否位于 base 范围内（规范化比较）。 */
function isWithin(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 运行命令，完整收集 stdout/stderr（等价 Rust Command::output()）。 */
export function runMvn(
  bin: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string; spawnError?: string }> {
  return new Promise((resolve) => {
    const cp = spawn(bin, args, {
      cwd,
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    cp.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    cp.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    cp.on('error', (err) => {
      resolve({ code: -1, stdout, stderr, spawnError: String(err) });
    });
    cp.on('close', (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * 校验文件路径在 $HOME/.dataforge 工作空间范围内（lib.rs validate_path_within_workspace 移植）。
 * 返回规范化后的绝对路径；超出范围抛错。
 */
export function validatePathWithinWorkspace(p: string): string {
  const raw = path.resolve(p);
  const workspaceDir = path.join(os.homedir(), '.dataforge');
  const workspaceCanonical = canonicalOrSelf(workspaceDir);

  if (fs.existsSync(raw)) {
    const canonical = canonicalOrSelf(raw);
    if (!isWithin(workspaceCanonical, canonical)) {
      throw new Error('路径不在允许的工作空间范围内');
    }
    return canonical;
  }

  // 路径不存在（新建文件/目录）：从末端向上收集不存在的组件，找到最近的已存在父目录
  const nonExisting: string[] = [];
  let current = raw;
  while (!fs.existsSync(current)) {
    const name = path.basename(current);
    if (!name) throw new Error(`路径解析失败: 无法找到有效的父目录 '${p}'`);
    nonExisting.push(name);
    const parent = path.dirname(current);
    if (!parent || path.dirname(parent) === parent) {
      throw new Error(`路径解析失败: 无法找到有效的父目录 '${p}'`);
    }
    current = parent;
  }

  const parentCanonical = canonicalOrSelf(current);
  if (!isWithin(workspaceCanonical, parentCanonical)) {
    throw new Error('路径不在允许的工作空间范围内');
  }

  return path.join(parentCanonical, ...nonExisting.reverse());
}