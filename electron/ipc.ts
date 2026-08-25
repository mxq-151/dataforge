import { app, ipcMain } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { compileJavaScala } from './backend/compile';
import { runMavenBloopInstall, writeWorkspacePom } from './backend/lspPom';
import {
  readMetalsSource,
  startJavaLspWs,
  startScalaLspWs,
  stopJavaLspWs,
  stopScalaLspWs,
} from './backend/lspBridge';
import { autoStartOpencode, startOpencodeAfterLogin, stopOpencode } from './backend/opencode';
import { readStoreJSON, writeStoreJSON } from './backend/store';

// 事件桥（主进程 → 渲染层）统一迁至 eventBus.ts，此处仅转发导出
export { emitToRenderer } from './eventBus';

const execFileAsync = promisify(execFile);

// ────────────────────────────────────────────────────────────────
// Rust 后端命令注册表（按模块逐个移植到 electron/backend/）
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
  compile_java_scala: async (args) => compileJavaScala(args as unknown as Parameters<typeof compileJavaScala>[0]),
  // ── LSP WebSocket 桥（已移植：backend/lspBridge.ts）────────────────
  start_java_lsp_ws: async (args) =>
    startJavaLspWs(args as unknown as { javaHome: string; workspaceRoot: string }),
  start_scala_lsp_ws: async (args) =>
    startScalaLspWs(args as unknown as { javaHome: string; workspaceRoot: string }),
  stop_java_lsp_ws: async (args) => stopJavaLspWs(args as unknown as { clientId: number }),
  stop_scala_lsp_ws: async (args) => stopScalaLspWs(args as unknown as { clientId: number }),
  read_metals_source: async (args) =>
    readMetalsSource(args as unknown as { path: string }),
};

// ────────────────────────────────────────────────────────────────
// 文件系统（对应 @tauri-apps/plugin-fs）
// ────────────────────────────────────────────────────────────────
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
    default:
      throw new Error(`未知 fs 操作: ${op}`);
  }
}

// ────────────────────────────────────────────────────────────────
// shell 执行（对应 @tauri-apps/plugin-shell Command.execute）
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
      // 子进程以非零码退出：与 Tauri CommandOutput 语义一致
      return { code: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
    throw err;
  }
}

// ────────────────────────────────────────────────────────────────
// 跨域 HTTP（对应 @tauri-apps/plugin-http，主进程代理绕过 CORS）
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
// Store 持久化（对应 @tauri-apps/plugin-store，userData/df-stores/）
// 实现统一在 backend/store.ts（主进程与 opencode 模块共用同一路径）
// ────────────────────────────────────────────────────────────────

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

  // 渲染层 → 主进程事件（预留：后续模块可能监听）
  ipcMain.on('df:emit:unknown', () => { /* noop */ });
}