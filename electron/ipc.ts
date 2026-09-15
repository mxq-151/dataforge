import { app, ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { compileJavaScala } from './backend/compile';
import { runLocalJava, abortLocalRun } from './backend/localRun';
import { readJarScalaSource, resolveJarSources, runMavenBloopInstall, writeWorkspacePom } from './backend/lspPom';
import {
  readMetalsSource,
  startJavaLspWs,
  startScalaLspWs,
  stopJavaLspWs,
  stopScalaLspWs,
} from './backend/lspBridge';
import { autoStartOpencode, startOpencodeAfterLogin, stopOpencode } from './backend/opencode';
import { exportSanitizedStores, readStoreJSON, writeStoreJSON } from './backend/store';
import { detectWsl, runtimeId, type RuntimeId } from './backend/platform';

// 事件桥（主进程 → 渲染层）统一迁至 eventBus.ts，此处仅转发导出
export { emitToRenderer } from './eventBus';

const execFileAsync = promisify(execFile);

// ────────────────────────────────────────────────────────────────
// Electron 后端命令注册表（electron/backend/）
// 调用方均可安全兜底（调用点均有 try/catch / 失败降级）
// ────────────────────────────────────────────────────────────────
const BACKEND_COMMANDS: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  // ── opencode 管理（已移植：backend/opencode.ts）─────────────────
  start_opencode_after_login: async () => startOpencodeAfterLogin(),
  stop_opencode: async () => stopOpencode(),
  auto_start_opencode: async () => autoStartOpencode(),
  // ── 编译 / Maven 工程（已移植：backend/compile.ts + lspPom.ts）───
  write_workspace_pom: async (args) =>
    writeWorkspacePom(String(args.workspaceRoot ?? ''), String(args.pomContent ?? '')),
  run_maven_bloop_install: async (args) =>
    runMavenBloopInstall(String(args.javaHome ?? ''), String(args.mavenHome ?? ''), String(args.workspaceRoot ?? '')),
  resolve_jar_sources: async (args) =>
    resolveJarSources(args as unknown as { jarPaths: string[] }),
  read_jar_scala_source: async (args) =>
    readJarScalaSource(args as unknown as { jarName: string; className: string }),
  compile_java_scala: async (args) => compileJavaScala(args as unknown as Parameters<typeof compileJavaScala>[0]),
  // ── 本地运行（后端：backend/localRun.ts）──────────────────────────────
  run_local_java: async (args) => runLocalJava(args as unknown as Parameters<typeof runLocalJava>[0]),
  run_local_abort: async (args) => {
    abortLocalRun(String((args as { sessionId?: string }).sessionId ?? ''));
    return null;
  },
  // ── LSP WebSocket 桥（已移植：backend/lspBridge.ts）────────────────
  start_java_lsp_ws: async (args) =>
    startJavaLspWs(args as unknown as { javaHome: string; workspaceRoot: string }),
  start_scala_lsp_ws: async (args) =>
    startScalaLspWs(args as unknown as { javaHome: string; workspaceRoot: string }),
  stop_java_lsp_ws: async (args) => stopJavaLspWs(args as unknown as { clientId: number }),
  stop_scala_lsp_ws: async (args) => stopScalaLspWs(args as unknown as { clientId: number }),
  read_metals_source: async (args) =>
    readMetalsSource(args as unknown as { path: string }),
  // 诊断用：把渲染层信息打印到主进程终端（npm run dev 时可见）
  trace_log: async (args) => {
    console.log(`[renderer] ${String(args.msg ?? '')}`);
    return null;
  },
};

// ────────────────────────────────────────────────────────────────
// 文件系统（主进程 Node fs）
// ────────────────────────────────────────────────────────────────

/**
 * 目录链接创建（跨平台）。
 *
 * Windows 上创建真正的符号链接需要 SeCreateSymbolicLinkPrivilege（管理员或
 *「开发者模式」），普通用户会直接 EPERM —— 本项目 code/{pc}/src/{pc} 与
 * {gitRepoDirName}/{pc} 的关联就因此建不起来，进而导致 git 工作树挂不上。
 * junction（目录联接）无需任何特权，且：
 *   - lstat() 仍报告 isSymbolicLink() === true，上层幂等判定无需改动；
 *   - Git for Windows 会把它当普通目录穿透，主工作树能照常看到真实源码；
 *   - 删除 junction 只删链接，不会动目标目录里的数据。
 * 因此 Windows 优先 junction，仅在 junction 也失败时退回标准目录软链。
 */
async function linkDirectory(target: string, linkPath: string): Promise<void> {
  if (process.platform === 'win32') {
    try {
      await fsp.symlink(target, linkPath, 'junction');
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // junction 需要目标为已存在的目录；其余错误（如父目录缺失）原样上抛
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EINVAL') throw err;
    }
  }
  await fsp.symlink(target, linkPath, 'dir');
}

/**
 * 同一 linkPath 的软链操作串行化。
 *
 * 渲染层会对「当前项目」和「已访问项目列表」各触发一次初始化（同一个项目出现两次），
 * 两个并发请求都会通过 lstat 的"不存在"检查，然后同时创建 → 后到者 EEXIST。
 */
const linkLocks = new Map<string, Promise<unknown>>();
function withLinkLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = linkLocks.get(key) ?? Promise.resolve();
  // prev 无论成功失败都要继续排队（不因前一次失败而中断后续请求）
  const next = prev.then(fn, fn);
  const guard = next.then(
    () => undefined,
    () => undefined
  );
  linkLocks.set(key, guard);
  // 队列排空后清理：仅当自己仍是该 key 的最新登记项时才移除
  void guard.then(() => {
    if (linkLocks.get(key) === guard) linkLocks.delete(key);
  });
  return next;
}

interface FsRequest {
  op: string;
  args: Record<string, unknown>;
}

async function handleFs(req: FsRequest): Promise<unknown> {
  const { op, args } = req;
  switch (op) {
    case 'readDir': {
      const entries = await fsp.readdir(String(args.path), { withFileTypes: true });
      return entries.map((d) => ({
        name: d.name,
        isDirectory: d.isDirectory(),
        isFile: d.isFile(),
        isSymlink: d.isSymbolicLink(),
      }));
    }
    case 'du': {
      // 递归统计目录占用（供回收站按容量上限清理）。
      // 上限 maxEntries 是防御性的：回收站理论上可能被塞进一个巨大的目录，
      // 统计本身不该变成一次无界遍历 —— 超限即返回 truncated，调用方按已统计值决策。
      const root = String(args.path);
      const maxEntries = Number(args.maxEntries ?? 20000);
      let bytes = 0;
      let files = 0;
      let truncated = false;
      const stack: string[] = [root];
      while (stack.length > 0 && !truncated) {
        const dir = stack.pop() as string;
        let entries: import('node:fs').Dirent[];
        try {
          entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
          continue; // 目录在统计过程中被并发删除：跳过
        }
        for (const d of entries) {
          if (files >= maxEntries) {
            truncated = true;
            break;
          }
          const full = path.join(dir, d.name);
          if (d.isDirectory()) {
            stack.push(full);
            continue;
          }
          if (!d.isFile()) continue; // 软链不跟随，避免穿透到工作区外
          try {
            bytes += (await fsp.stat(full)).size;
            files += 1;
          } catch {
            // 单文件读不到不影响整体估算
          }
        }
      }
      return { bytes, files, truncated };
    }
    case 'readFile': {
      const buf = await fsp.readFile(String(args.path));
      return buf.toString('base64');
    }
    case 'writeFile': {
      const p = String(args.path);
      await fsp.mkdir(path.dirname(p), { recursive: true });
      await fsp.writeFile(p, Buffer.from(String(args.data), 'base64'));
      return null;
    }
    case 'mkdir': {
      await fsp.mkdir(String(args.path), { recursive: !!(args.recursive ?? false) });
      return null;
    }
    case 'exists': {
      try {
        await fsp.access(String(args.path));
        return true;
      } catch {
        return false;
      }
    }
    case 'remove': {
      await fsp.rm(String(args.path), { recursive: !!(args.recursive ?? false), force: true });
      return null;
    }
    case 'rename': {
      await fsp.rename(String(args.oldPath), String(args.newPath));
      return null;
    }
    case 'copy': {
      await fsp.cp(String(args.src), String(args.dest), { recursive: true });
      return null;
    }
    case 'symlink': {
      // 创建/修复目录链接：linkPath -> target。
      // 幂等：linkPath 已是指向 target 的链接则跳过；指向别处则先解除再重建；
      // 已是普通目录/文件则视为数据目录，保留不动（不覆盖）；空目录则直接顶掉换成链接。
      // 注意：target 是数据真身，必须是真实目录；若它当前是符号链接（如翻转方向前的旧软链，
      // 常为悬空链接），先解除再建真实目录。
      const linkPath = String(args.linkPath);
      const target = String(args.target);
      return withLinkLock(linkPath, async () => {
        try {
          const tst = await fsp.lstat(target);
          if (tst.isSymbolicLink()) {
            await fsp.unlink(target);
          }
        } catch {
          // target 不存在，稍后 mkdir
        }
        await fsp.mkdir(path.dirname(linkPath), { recursive: true });
        await fsp.mkdir(target, { recursive: true });
        try {
          const st = await fsp.lstat(linkPath);
          if (st.isSymbolicLink()) {
            const [linkReal, targetReal] = await Promise.all([
              fsp.realpath(linkPath).catch(() => ''),
              fsp.realpath(target).catch(() => target),
            ]);
            if (linkReal && linkReal === targetReal) return null; // 已正确，幂等
            await fsp.unlink(linkPath); // 指向别处，解除后重建
          } else if (st.isDirectory()) {
            // 已有真实目录：非空则保留（可能是数据目录，不能丢数据）；
            // 空目录说明是历史遗留的空壳，顶掉换成链接，让下次启动能自愈
            const entries = await fsp.readdir(linkPath).catch(() => ['']);
            if (entries.length > 0) return null;
            await fsp.rmdir(linkPath);
          } else {
            return null; // 已存在普通文件，不覆盖
          }
        } catch {
          // linkPath 不存在，直接创建
        }
        await linkDirectory(target, linkPath);
        return null;
      });
    }
    default:
      throw new Error(`未知 fs 操作: ${op}`);
  }
}

// ────────────────────────────────────────────────────────────────
// shell 执行（主进程 child_process）
// ────────────────────────────────────────────────────────────────
interface ShellExecuteRequest {
  program: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

async function handleShell(req: ShellExecuteRequest): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(req.program, req.args ?? [], {
      cwd: req.cwd || undefined,
      env: { ...process.env, ...(req.env ?? {}) },
      timeout: req.timeoutMs ?? 120_000,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    return { code: 0, stdout: stdout ?? '', stderr: stderr ?? '' };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: unknown };
    if (typeof e.code === 'number') {
      // 子进程以非零码退出：与 CommandOutput 语义一致
      return { code: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
    throw err;
  }
}

// ────────────────────────────────────────────────────────────────
// 跨域 HTTP（主进程代理绕过 CORS）
// ────────────────────────────────────────────────────────────────
interface HttpFetchRequest {
  id: number;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

const httpControllers = new Map<number, AbortController>();

async function handleHttpFetch(req: HttpFetchRequest): Promise<{
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  url: string;
}> {
  const controller = new AbortController();
  httpControllers.set(req.id, controller);
  try {
    const res = await fetch(req.url, {
      method: req.method ?? 'GET',
      headers: req.headers,
      body: req.body,
      signal: controller.signal,
      redirect: 'follow',
    });
    const body = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    return { status: res.status, statusText: res.statusText, headers, body, url: res.url || req.url };
  } finally {
    httpControllers.delete(req.id);
  }
}

// ────────────────────────────────────────────────────────────────
// Store 持久化（userData/df-stores/）
// 实现统一在 backend/store.ts（主进程与 opencode 模块共用同一路径）
// ────────────────────────────────────────────────────────────────

// 安装协议同意标记
// 该标记文件存放在应用自身安装目录（app.getAppPath()）下，而非持久化的 userData，
// 因此在「全新安装/重装」时整个安装目录被替换、标记随之消失，用户必须重新同意协议。
// 注：置于安装目录需该目录可写（当前未签名、asar 开启着 false，dev 与自分发目录通常可写）。
function getInstallMarkerPath(): string {
  return path.join(app.getAppPath(), '.df-install-token');
}

async function readInstallToken(): Promise<string | null> {
  try {
    const raw = await fsp.readFile(getInstallMarkerPath(), 'utf-8');
    return raw.trim() || null;
  } catch {
    return null;
  }
}

// 生成并写入安装标记；返回生成的 token。写入失败（目录不可写）返回 null。
async function writeInstallToken(): Promise<string | null> {
  const token = randomUUID();
  try {
    await fsp.writeFile(getInstallMarkerPath(), token, 'utf-8');
    return token;
  } catch {
    return null;
  }
}

// 注册全部 IPC handler
export function registerIpcHandlers(): void {
  ipcMain.handle('df:invoke', async (_e, payload: { cmd: string; args: Record<string, unknown> }) => {
    const handler = BACKEND_COMMANDS[payload.cmd];
    if (!handler) {
      throw new Error(`[Electron] 未知后端命令: ${payload.cmd}（尚未迁移到 Electron）`);
    }
    return handler(payload.args ?? {});
  });

  ipcMain.handle('df:homeDir', () => app.getPath('home'));

  ipcMain.handle('df:tempDir', () => app.getPath('temp'));

  ipcMain.handle('df:fs', (_e, req: FsRequest) => handleFs(req));

  ipcMain.handle('df:shell:execute', (_e, req: ShellExecuteRequest) => handleShell(req));

  ipcMain.handle('df:http:fetch', (_e, req: HttpFetchRequest) => handleHttpFetch(req));

  ipcMain.on('df:http:abort', (_e, id: number) => {
    httpControllers.get(id)?.abort();
  });

  ipcMain.handle('df:store:read', (_e, file: string) => readStoreJSON(file));

  ipcMain.handle('df:store:write', (_e, payload: { file: string; data: unknown }) =>
    writeStoreJSON(payload.file, payload.data),
  );

  // 导出诊断配置：主进程侧剥离凭据后返回，明文凭据不经过渲染层
  ipcMain.handle('df:store:export', () => exportSanitizedStores());

  // 数据上报所需的环境信息：操作系统类型+版本 + 应用版本（应用版本以打包时 package.json version 为准）
  ipcMain.handle('df:report:meta', (): { os_version: string; platform: RuntimeId; wsl: boolean; dataforge_version: string } => {
    const PLATFORM_NAMES: Record<string, string> = {
      darwin: 'macOS',
      win32: 'Windows',
      linux: 'Linux',
    };
    let osName: string;
    try {
      osName = PLATFORM_NAMES[process.platform] || process.platform;
    } catch {
      osName = '';
    }
    let osVersion = '';
    try {
      osVersion = (process.getSystemVersion && process.getSystemVersion()) || '';
    } catch {
      // ignore
    }
    // 合并操作系统类型与版本号，便于后端直接展示（后端 os_version 单字段存储）
    const os_version = [osName, osVersion].filter(Boolean).join(' ');
    // 精确区分裸 Linux 与 WSL：runtimeId 返回 linux / wsl，detectWsl 提供布尔标记
    const platform = runtimeId();
    const wsl = detectWsl();
    console.log(`[platform] runtime=${platform} (wsl=${wsl}) platform=${process.platform} arch=${process.arch} os_version=${os_version}`);
    return { os_version, platform, wsl, dataforge_version: app.getVersion() };
  });

  // 应用退出：供渲染层在用户拒绝安装协议时调用（未同意协议前不进入任何界面）
  ipcMain.on('df:quit', () => app.quit());

  // 安装标记：读取当前安装的协议同意标记（无则视为全新安装，需重新同意）
  ipcMain.handle('df:license:installToken', () => readInstallToken());
  // 安装标记：写入本次同意的标记，返回生成的 token（写失败返回 null）
  ipcMain.handle('df:license:markInstall', () => writeInstallToken());

  // 渲染层 → 主进程事件（预留：后续模块可能监听）
  ipcMain.on('df:emit:unknown', () => { /* noop */ });
}