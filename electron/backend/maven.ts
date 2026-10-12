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

/** 生成 YYYYMMDD_HHmmss（UTC）。 */
export function formatTimestamp(): string {
  const d = new Date();
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}_` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

/** 工作空间根目录（$HOME/.dataforge）。 */
export function workspaceHome(): string {
  return path.join(os.homedir(), '.dataforge');
}

/** 解析 mvn 可执行文件路径（优先 mavenHome/bin，fallback 系统 PATH）。 */
export function resolveMvnBin(mavenHome: string): string {
  const mvnName = isWindows ? 'mvn.cmd' : 'mvn';
  if (mavenHome.trim()) {
    const home = mavenHome.trim();
    const p1 = path.join(home, 'bin', mvnName);
    if (fs.existsSync(p1)) return p1;
    const p2 = path.join(home, 'bin', 'mvn');
    if (fs.existsSync(p2)) return p2;
    // mavenHome 已配置但找不到 mvn：明确报错，避免静默回退到 PATH 上的同名命令
    // （往往也不存在，最终得到难以排查的 spawn 失败）
    throw new Error(`mavenHome 下未找到 Maven 可执行文件: ${path.join(home, 'bin', mvnName)}`);
  }
  return mvnName;
}

/** canonicalize，失败时回退绝对路径。 */
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

/** 触发 cmd.exe 加引号的字符：空白 + cmd 元字符。 */
const CMD_QUOTE_TRIGGER = /[\s"&|<>^()]/;

/**
 * 为 cmd.exe 命令行转义单个 token：含空白或元字符时整体包双引号，内部双引号成对转义。
 * 不含特殊字符时原样返回，避免给普通参数引入多余引号。
 */
export function quoteCmdArg(arg: string): string {
  if (arg === '') return '""';
  if (!CMD_QUOTE_TRIGGER.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

/** 拼出完整的 cmd.exe 命令行（bin 与 args 逐个转义）。 */
export function buildCmdCommandLine(bin: string, args: string[]): string {
  return [bin, ...args].map(quoteCmdArg).join(' ');
}

/** 是否需要经 cmd.exe 包装执行（Windows 的 .cmd/.bat 无法被 spawn 直接执行）。 */
export function needsCmdShell(bin: string): boolean {
  return isWindows && /\.(cmd|bat)$/i.test(bin);
}

/** 运行命令，完整收集 stdout/stderr。 */
export function runMvn(
  bin: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string; spawnError?: string }> {
  return new Promise((resolve) => {
    const childEnv = { ...process.env, ...env };
    // Windows 下 .cmd/.bat 无法被 spawn 直接执行（会同步抛 EINVAL -4071），
    // 必须由 cmd.exe 经 shell 包装执行（Node 官方文档要求）。仅对脚本类
    // 可执行文件启用 shell，避免普通 exe 因 shell 解析引入引号/元字符问题。
    //
    // ⚠️ shell 模式下 Node 只是把 file 与 args 用空格**裸拼**成命令行、不做任何转义
    //（官方 DEP0190 即提示这一点），于是含空格的路径会被 cmd.exe 在空格处截断：
    // `C:\Program Files\...\mvn.cmd` → 报 "'C:\Program' is not recognized as an
    // internal or external command"。因此这里自己拼好带引号的命令行，并以「单个字符串」
    // 形式交给 shell（不再传 args 数组，同时消除 DEP0190 警告）。
    // 注：两条分支的 options 必须各自写成字面量，否则 TS 无法把 stdio 收窄成
    // 非空管道元组，cp.stdout/stderr 会退化成可空类型。
    const cp = needsCmdShell(bin)
      ? spawn(buildCmdCommandLine(bin, args), {
          cwd,
          env: childEnv,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: true,
        })
      : spawn(bin, args, {
          cwd,
          env: childEnv,
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