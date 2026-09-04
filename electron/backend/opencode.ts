/**
 * opencode 服务管理移植（opencode_manager.rs）。
 *
 * 职责：启动（默认沙箱 sandbox-exec 包装）、监督（就绪检测 + 健康检查）、
 * 终止（SIGTERM → 强制 kill → 端口孤儿清理）、崩溃事件通知前端。
 * 端口固定 4096，地址 http://127.0.0.1:4096。
 */
import { app } from 'electron';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { readStoreJSON } from './store';
import { getCompileServerEndpoint } from './serviceEndpoints';
import { emitToRenderer, getMainWindow } from '../eventBus';

const SERVER_PORT = 4096;
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;
const CONFIG_STORE = 'opencode-config.json';
const SECURE_STORE = 'secure-store.json';

// ─── 进程状态 ──────────────────────────────────────────────────
let childProc: ChildProcess | null = null;
let childPid: number | null = null;

// ─── 配置类型（对齐 SDK / 前端配置结构）────────────────────────────

interface StoredLLMModel {
  id?: string;
  name?: string;
  providerID?: string;
  providerId?: string;
  modelID?: string;
  modelId?: string;
  apiKey?: string;
  baseUrl?: string;
  useResponsesApi?: boolean;
  reasoningEffort?: string;
}

/** 前端 OpenCodeConfig 在 Store 中的存储格式（camelCase）。 */
interface StoredOpenCodeConfig {
  model?: string;
  modelProvider?: string;
  apiKey?: string;
  baseUrl?: string;
  cwd?: string;
  maxTurns?: number;
  backendHost?: string;
  marquezApiUrl?: string;
  llmModels?: StoredLLMModel[];
  javaHome?: string;
  scalaHome?: string;
  mavenHome?: string;
  enableSandbox?: boolean;
  authToken?: string;
  /** 登录用户名：用于沙箱将 hostBase 读写边界收紧到本用户实际工作目录 */
  username?: string;
  /** git 工作空间目录名（hostBase 下），沙箱需放行以保留 git 操作 */
  gitRepoDirName?: string;
}

/** 服务端配置（model 含 provider 前缀）。 */
interface OpenCodeServerConfig {
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  cwd?: string;
  maxTurns?: number;
  apiHost?: string;
  authToken?: string;
  marquezApiUrl?: string;
  llmModels?: StoredLLMModel[];
  javaHome?: string;
  mavenHome?: string;
  scalaHome?: string;
  username?: string;
  gitRepoDirName?: string;
}

function toServerConfig(s: StoredOpenCodeConfig): OpenCodeServerConfig {
  const topModel = s.modelProvider && s.model
    ? `${s.modelProvider}/${s.model}`
    : undefined;
  let model = topModel;
  let apiKey = s.apiKey;
  let baseUrl = s.baseUrl;
  if (!topModel) {
    const first = s.llmModels?.[0];
    if (first?.providerID && first.modelID) {
      model = `${first.providerID}/${first.modelID}`;
    } else if (first?.providerId && first.modelId) {
      model = `${first.providerId}/${first.modelId}`;
    }
    if (!s.apiKey) apiKey = first?.apiKey;
    if (!s.baseUrl) baseUrl = first?.baseUrl;
  }
  return {
    model,
    apiKey,
    baseUrl,
    cwd: s.cwd,
    maxTurns: s.maxTurns,
    apiHost: s.backendHost,
    authToken: s.authToken,
    marquezApiUrl: s.marquezApiUrl,
    llmModels: s.llmModels,
    javaHome: s.javaHome,
    mavenHome: s.mavenHome,
    scalaHome: s.scalaHome,
    username: s.username,
    gitRepoDirName: s.gitRepoDirName,
  };
}

async function loadServerConfig(): Promise<OpenCodeServerConfig> {
  const storedStore = await readStoreJSON<{ config?: StoredOpenCodeConfig }>(CONFIG_STORE);
  const stored = storedStore.config ?? {};
  const config = toServerConfig(stored);
  // auth_token 从 secure-store 读取
  const secure = await readStoreJSON<{ auth_token?: string }>(SECURE_STORE);
  if (secure.auth_token) config.authToken = secure.auth_token;
  return config;
}

// ─── 端口 / 进程工具 ────────────────────────────────────────────

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(true));
    srv.listen({ port, host: '127.0.0.1' }, () => {
      srv.close(() => resolve(false));
    });
  });
}

async function waitPortFree(port: number, maxMs: number, intervalMs = 100): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (!(await isPortInUse(port))) return;
    await sleep(intervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function execSyncCapture(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8' });
  } catch {
    return '';
  }
}

/** 强制终止占用指定端口的进程（macOS/Linux 用 lsof，Windows 用 netstat/taskkill）。 */
async function killProcessOnPort(port: number): Promise<void> {
  if (process.platform === 'darwin' || process.platform === 'linux') {
    const pids = execSyncCapture('lsof', ['-ti', `:${port}`]);
    for (const pid of pids.split('\n')) {
      const p = pid.trim();
      if (p) {
        console.log(`[opencode] 强制终止占用端口 ${port} 的进程 PID ${p}`);
        try { process.kill(Number(p), 'SIGKILL'); } catch { /* 忽略 */ }
      }
    }
  } else {
    const out = execSyncCapture('netstat', ['-ano']);
    for (const line of out.split('\n')) {
      if (line.includes(`:${port}`) && line.includes('LISTENING')) {
        const pid = line.trim().split(/\s+/).pop();
        if (pid) {
          console.log(`[opencode] 强制终止占用端口 ${port} 的进程 PID ${pid}`);
          execSyncCapture('taskkill', ['/F', '/PID', pid]);
        }
      }
    }
  }
}

// ─── SQLite 锁文件清理 ──────────────────────────────────────────

async function cleanupOpencodeDbLocks(cwd?: string): Promise<void> {
  const candidates: string[] = [];
  if (cwd) {
    candidates.push(path.join(cwd, '.opencode'));
    candidates.push(path.join(cwd, '.local', 'share', 'opencode'));
  }
  const home = os.homedir();
  candidates.push(path.join(home, '.local', 'share', 'opencode'));
  candidates.push(path.join(home, '.config', 'opencode'));
  candidates.push(path.join(home, '.opencode'));
  if (process.env.XDG_DATA_HOME) {
    candidates.push(path.join(process.env.XDG_DATA_HOME, 'opencode'));
  }

  let cleaned = 0;
  for (const base of candidates) {
    if (!fs.existsSync(base)) continue;
    await walkAndRemoveLocks(base, () => { cleaned += 1; });
  }
  if (cleaned > 0) console.log(`[opencode] 数据库锁清理完成，共删除 ${cleaned} 个锁文件`);
}

async function walkAndRemoveLocks(dir: string, onRemove: () => void): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walkAndRemoveLocks(p, onRemove);
    } else if (e.name.toLowerCase().endsWith('.lock')) {
      try {
        await fsp.rm(p, { force: true });
        console.log(`[opencode] 已清理锁文件: ${p}`);
        onRemove();
      } catch { /* 忽略 */ }
    }
  }
}

// ─── opencode 二进制解析 ────────────────────────────────────────

function findOnPath(name: string): string | null {
  const pathStr = process.env.PATH ?? '';
  for (const dir of pathStr.split(path.delimiter)) {
    if (!dir) continue;
    const cand = path.join(dir, name);
    try {
      if (fs.statSync(cand).isFile()) return cand;
    } catch { /* 忽略 */ }
  }
  return null;
}

/** 解析 opencode 二进制路径（顺序：exe 同目录 → exe/binaries → resources/binaries → PATH）。 */
export function resolveOpencodeBin(): string | null {
  const name = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
  const exeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(exeDir, name),
    path.join(exeDir, 'binaries', name),
    path.join(process.resourcesPath, 'binaries', name),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) {
      try {
        return fs.realpathSync(c);
      } catch {
        return c;
      }
    }
  }
  // 开发模式：process.resourcesPath 指向 Electron 框架自身的 Resources，不含本项目二进制；
  // 改从项目 resources/binaries/ 查找（命名沿用目标平台三元组，如 opencode-aarch64-apple-darwin）。
  if (!app.isPackaged) {
    const devBinDir = path.join(app.getAppPath(), 'resources', 'binaries');
    const devBin = resolveBinFromDir(devBinDir, name);
    if (devBin) return devBin;
  }
  // dev 兜底：PATH 中的 opencode
  const onPath = findOnPath(name);
  if (onPath) return onPath;
  return null;
}

/** 在目录中查找 opencode 二进制：优先标准名，其次当前平台 triple 命名的构建产物。 */
function resolveBinFromDir(dir: string, name: string): string | null {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f === name || f.startsWith(`${name}-`));
  } catch {
    return null;
  }
  const triples: Record<string, string> = {
    'darwin-arm64': `${name}-aarch64-apple-darwin`,
    'darwin-x64': `opencode-darwin-x64`,
    'win32-x64': `opencode-windows-x64.exe`,
    'win32-arm64': `opencode-windows-arm64.exe`,
    'linux-x64': `opencode-linux-x64`,
    'linux-arm64': `opencode-linux-arm64`,
  };
  const triple = triples[`${process.platform}-${process.arch}`];
  const preferred = [name, triple].filter(Boolean);
  for (const p of [...preferred, ...files]) {
    if (!files.includes(p)) continue;
    const full = path.join(dir, p);
    if (fs.statSync(full).isFile()) {
      try {
        return fs.realpathSync(full);
      } catch {
        return full;
      }
    }
  }
  return null;
}

function sandboxProfilePath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'sandbox', 'opencode-macos.sb');
  }
  return path.join(app.getAppPath(), 'resources', 'sandbox', 'opencode-macos.sb');
}

// ─── SDK 配置构造 ───────────────────────────────────────────────

function buildSdkConfig(config: OpenCodeServerConfig): Record<string, unknown> {
  const sdk: Record<string, unknown> = {};
  if (config.model) sdk.model = config.model;

  // 权限：external_directory deny + bash 规则（最后匹配者优先）
  sdk.permission = {
    external_directory: 'deny',
    bash: {
      '*': 'allow',
      'mysql*': 'deny',
      'mysqldump*': 'deny',
      'mysqladmin*': 'deny',
      'mysqlimport*': 'deny',
      'mysqlsh*': 'deny',
      'spark*': 'deny',
      'spark-shell*': 'deny',
      'spark-submit*': 'deny',
      'spark-sql*': 'deny',
      'pyspark*': 'deny',
      'flink*': 'deny',
      // git 危险操作：禁止智能体清空/重置/丢弃源码（可导致仓库文件丢失）
      'git reset*': 'deny',
      'git clean*': 'deny',
      'git checkout --*': 'deny',
      'git checkout .*': 'deny',
      'git restore*': 'deny',
      'git rm*': 'deny',
      'git stash*': 'deny',
      'git push --force*': 'deny',
      'git push -f*': 'deny',
      'git branch -D*': 'deny',
      'git branch --delete*': 'deny',
    },
  };

  // 按 provider 注入 models options（Responses API / reasoningEffort），仅支持内置 provider
  const groups = new Map<string, { baseUrl?: string; apiKey?: string; models: Array<{ id: string; useResponses: boolean; effort?: string }> }>();
  for (const m of config.llmModels ?? []) {
    const pid = m.providerID || m.providerId;
    const mid = m.modelID || m.modelId;
    if (!pid || !mid) continue;
    let g = groups.get(pid);
    if (!g) {
      g = { models: [] };
      groups.set(pid, g);
    }
    if (!g.baseUrl && m.baseUrl) g.baseUrl = m.baseUrl;
    if (!g.apiKey && m.apiKey) g.apiKey = m.apiKey;
    g.models.push({
      id: mid,
      useResponses: !!m.useResponsesApi,
      effort: m.reasoningEffort?.trim() || 'high',
    });
  }

  for (const [pid, g] of groups) {
    if (pid !== 'deepseek' && pid !== 'qwen') continue; // 非内置 provider 暂不支持
    const modelsJson: Record<string, unknown> = {};
    for (const m of g.models) {
      const options: Record<string, unknown> = {};
      if (m.useResponses) options.apiType = 'responses';
      if (m.effort) options.reasoningEffort = m.effort;
      if (Object.keys(options).length > 0) {
        modelsJson[m.id] = { options };
      }
    }
    if (Object.keys(modelsJson).length > 0) {
      const provider = (sdk.provider as Record<string, unknown> | undefined) ?? {};
      provider[pid] = { models: modelsJson };
      sdk.provider = provider;
    }
  }
  return sdk;
}

// ─── 启动 / 监督 / 终止 ─────────────────────────────────────────

async function healthCheck(): Promise<boolean> {
  try {
    const res = await fetch(`${SERVER_URL}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

interface SpawnSpec {
  exe: string;
  args: string[];
  /** 是否走沙箱包装（用于启动失败时回退非沙箱重试）。 */
  sandboxed: boolean;
}

/** opencode 运行所需的用户可写目录。首启时可能不存在，须先创建再 bind，
 *  否则 bwrap 会因 "Can't find source path" 直接退出导致智能体无法启动。 */
function opencodeRuntimeDirs(home: string): string[] {
  return [
    `${home}/.local/share/opencode`,
    `${home}/.local/state/opencode`,
    `${home}/.config/opencode`,
    `${home}/.cache/opencode`,
    `${home}/.opencode`,
  ];
}

/** 探测 bubblewrap 是否真的可用：内核/发行版禁用非特权 user namespace 或限制挂载时，
 *  bwrap 即使安装了也会启动失败，此时必须回退非沙箱，否则智能体启动即崩。 */
function bwrapUsable(bwrap: string): boolean {
  try {
    execFileSync(
      bwrap,
      ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--tmpfs', '/dev/shm', '/bin/true'],
      { stdio: 'ignore', timeout: 5000 },
    );
    return true;
  } catch {
    return false;
  }
}

function makeSpawnSpec(config: OpenCodeServerConfig, noSandbox = false): SpawnSpec {
  const bin = resolveOpencodeBin();
  if (!bin) {
    throw new Error('无法解析 opencode 二进制路径（请确认已安装 opencode 或在 resources/binaries 下放置）');
  }
  // AI 助手始终在沙箱中执行（无需用户配置）。
  // 开发逃生阀：DATAFORGE_DISABLE_SANDBOX=1 跳过沙箱（受限终端/调试环境使用，桌面正常启动不受影响）。
  const wantSandbox = !noSandbox && process.env.DATAFORGE_DISABLE_SANDBOX !== '1';

  if (process.platform === 'darwin' && wantSandbox) {
    const profile = sandboxProfilePath();
    if (fs.existsSync(profile)) {
      const binDir = path.dirname(bin);
      const cwd = config.cwd?.trim() || '/dev/null';
      const home = os.homedir();
      const args = [
        '-f', profile,
        '-D', `PROJECT=${cwd}`,
        '-D', `HOME=${home}`,
        '-D', `TMPDIR=${os.tmpdir()}`,
        '-D', `JAVA_HOME=${config.javaHome?.trim() || '/usr/local'}`,
        '-D', `MAVEN_HOME=${config.mavenHome?.trim() || '/usr/local'}`,
        '-D', `SCALA_HOME=${config.scalaHome?.trim() || '/usr/local'}`,
        '-D', `OPENCODE_BIN_DIR=${binDir}`,
        // 登录用户名：沙箱据此将 hostBase 读写边界收紧到该用户实际工作目录
        '-D', `USERNAME=${config.username?.trim() || ''}`,
        // git 工作空间目录名（hostBase 下），沙箱放行 git 仓库/工作树读写
        '-D', `GITREPO=${config.gitRepoDirName?.trim() || ''}`,
        '--',
        bin,
      ];
      console.log(`[opencode] 沙箱模式启动: sandbox-exec -f ${profile} -- ${bin}`);
      return { exe: 'sandbox-exec', args, sandboxed: true };
    }
    console.warn(`[opencode] 警告: 沙箱 profile 不存在 (${profile})，回退非沙箱启动`);
  } else if (process.platform === 'linux' && wantSandbox) {
    const bwrap = '/usr/bin/bwrap';
    if (fs.existsSync(bwrap) && bwrapUsable(bwrap)) {
      const home = os.homedir();
      const cwd = config.cwd?.trim() || '';
      const args = [
        '--ro-bind', '/', '/',
        '--dev', '/dev',
        '--proc', '/proc',
        '--tmpfs', '/tmp',
        '--tmpfs', '/dev/shm',
      ];
      if (cwd && fs.existsSync(cwd)) args.push('--bind', cwd, cwd);
      for (const dir of opencodeRuntimeDirs(home)) {
        try {
          fs.mkdirSync(dir, { recursive: true });
          args.push('--bind', dir, dir);
        } catch {
          console.warn(`[opencode] 忽略不可用的沙箱绑定目录: ${dir}`);
        }
      }
      args.push('--', bin);
      console.log(`[opencode] 沙箱模式启动: ${bwrap} ${args.join(' ')}`);
      return { exe: bwrap, args, sandboxed: true };
    }
    console.warn('[opencode] 警告: bubblewrap 不可用（未安装或内核命名空间受限），回退非沙箱启动');
  }

  return { exe: bin, args: [], sandboxed: false };
}

function validateCwd(cwd: string): void {
  if (!path.isAbsolute(cwd)) throw new Error('工作目录必须为绝对路径');
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`工作目录不存在或不是目录: ${cwd}`);
  }
}

/**
 * 启动 opencode 服务核心逻辑。幂等：已有健康进程则复用；
 * 登录后调用前应先 stop，确保新配置生效。
 */
export async function startOpencodeServerCore(
  config: OpenCodeServerConfig,
  opts: { noSandbox?: boolean } = {},
): Promise<string> {
  // ── 幂等性检查 ──
  if (childProc && childPid != null) {
    if (await healthCheck()) {
      console.log('[opencode] 服务进程已在运行且健康，复用现有实例');
      return SERVER_URL;
    }
    console.warn('[opencode] 子句柄存在但健康检查失败，进程可能已崩溃，清理后重新启动...');
    await stopOpencodeServer();
  }

  console.log(`[opencode] === 开始启动流程，目标 cwd: ${config.cwd ?? '(未设置)'} ===`);
  await stopOpencodeServer();

  await cleanupOpencodeDbLocks(config.cwd);
  await waitPortFree(SERVER_PORT, 2000);
  if (await isPortInUse(SERVER_PORT)) {
    console.log('[opencode] 端口 4096 仍被占用，尝试强制清理...');
    await killProcessOnPort(SERVER_PORT);
    await sleep(300);
    await waitPortFree(SERVER_PORT, 3000);
  }
  if (await isPortInUse(SERVER_PORT)) {
    throw new Error('端口 4096 被其他程序占用，请手动关闭后重试');
  }

  // ── 校验工作目录并构造启动命令 ──
  const cwd = config.cwd?.trim();
  let spawnCwd: string | undefined;
  if (cwd && fs.existsSync(cwd)) {
    validateCwd(cwd);
    spawnCwd = cwd;
  }

  const { exe: opencodeExe, args: sandboxArgs, sandboxed } = makeSpawnSpec(config, opts.noSandbox === true);

  // ── 环境变量 ──
  const env: Record<string, string> = {};
  const providerName = config.model?.split('/')[0] ?? '';
  if (config.apiKey && providerName) {
    env[`${providerName.toUpperCase()}_API_KEY`] = config.apiKey;
  }
  if (config.apiHost) env.DATAFORGE_API_HOST = config.apiHost;
  if (config.authToken) env.DATAFORGE_AUTH_TOKEN = config.authToken;
  if (config.marquezApiUrl) env.MARQUEZ_API_URL = config.marquezApiUrl;
  if (cwd && fs.existsSync(cwd)) {
    env.OPENCODE_CONFIG_DIR = cwd;
  }

  // 注入本地 compile server 端点（供 opencode 工具调用编译/SQL 校验）
  const compileEndpoint = getCompileServerEndpoint();
  if (compileEndpoint) {
    env.DATAFORGE_COMPILE_PORT = String(compileEndpoint.port);
    env.DATAFORGE_COMPILE_TOKEN = compileEndpoint.token;
  }

  const sdkConfig = buildSdkConfig(config);
  const configContent = JSON.stringify(sdkConfig);
  env.OPENCODE_CONFIG_CONTENT = configContent;
  console.log(`[opencode] OPENCODE_CONFIG_CONTENT = ${configContent}`);

  // opencode serve 固定参数
  const serveArgs = [
    ...sandboxArgs,
    'serve',
    '--hostname=127.0.0.1',
    `--port=${SERVER_PORT}`,
    '--print-logs',
    '--log-level',
    'DEBUG',
  ];

  console.log(`[opencode] 启动命令: ${opencodeExe} ${serveArgs.slice(0, -2).join(' ')} ...`);

  const proc = spawn(opencodeExe, serveArgs, {
    cwd: spawnCwd,
    env: { ...process.env, ...env },
    shell: false,
    windowsHide: true,
  });
  childProc = proc;
  childPid = proc.pid ?? null;

  console.log(`[opencode] sidecar 进程已 spawn, PID: ${proc.pid}`);

  // ── 就绪检测（stdout 出现 listening/ready，最长 15s）──
  const stderrLines: string[] = [];
  let ready = false;
  const readyPromise = (() => {
    return new Promise<boolean>((resolve) => {
      const onStdout = (d: Buffer) => {
        const line = d.toString('utf8');
        console.log(`[opencode-out] ${line.trimEnd()}`);
        if (line.includes('listening') || line.includes('ready')) {
          proc.stdout?.off('data', onStdout);
          resolve(true);
        }
      };
      proc.stdout?.on('data', onStdout);
      proc.stderr?.on('data', (d: Buffer) => {
        const line = d.toString('utf8');
        console.log(`[opencode-log] ${line.trimEnd()}`);
        stderrLines.push(line);
        if (stderrLines.length > 500) stderrLines.shift();
      });
      proc.on('error', (err) => {
        console.error('[opencode] 启动进程错误:', err);
        resolve(false);
      });
      proc.on('exit', (code, signal) => {
        console.log(`[opencode] 进程已退出 (code=${code}, signal=${signal})`);
        resolve(false);
      });
      setTimeout(() => resolve(false), 15_000);
    });
  })();

  ready = await readyPromise;

  // ── 健康检查确认 ──
  const verifyStart = Date.now();
  const verifyTimeout = ready ? 3000 : 5000;
  while (Date.now() - verifyStart < verifyTimeout) {
    if (await healthCheck()) {
      ready = true;
      break;
    }
    await sleep(300);
  }

  if (!ready) {
    if (sandboxed) {
      // 沙箱包装导致启动失败时回退非沙箱重试，保证智能体可用（如 bwrap 命名空间受限、
      // 绑定目录异常等）。仅回退一次，重试再失败则报真实错误。
      const detail = stderrLines.length > 0 ? `\nstderr:\n${stderrLines.slice(-20).join('\n')}` : '';
      console.warn(`[opencode] 沙箱模式启动失败，回退非沙箱模式重试${detail}`);
      await stopOpencodeServer();
      return startOpencodeServerCore(config, { noSandbox: true });
    }
    const detail = stderrLines.length > 0 ? `\nstderr:\n${stderrLines.join('\n')}` : '';
    throw new Error(`OpenCode 服务器启动超时${detail}`);
  }

  console.log(`[opencode] 健康检查通过，服务已就绪: ${SERVER_URL}`);

  // ── 后台监督：进程退出时通知前端 ──
  proc.on('exit', (code, signal) => {
    const detail = stderrLines.length > 0
      ? `OpenCode 进程已退出 (code: ${code ?? '?'}, signal: ${signal ?? '?'})\nstderr:\n${stderrLines.join('\n')}`
      : `OpenCode 进程已退出 (code: ${code ?? '?'}, signal: ${signal ?? '?'})`;
    console.log(`[opencode] ${detail}`);
    emitToRenderer(getMainWindow(), 'opencode-process-terminated', detail);
    childProc = null;
    childPid = null;
  });

  console.log(`[opencode] 服务器已启动，PID: ${proc.pid}，地址: ${SERVER_URL}`);
  return SERVER_URL;
}

/** 停止 opencode：SIGTERM → 等端口释放（5s）→ 强制 kill → 端口孤儿清理。 */
export async function stopOpencodeServer(): Promise<void> {
  const proc = childProc;
  childProc = null;
  childPid = null;
  if (!proc || !proc.pid) {
    console.log('[opencode] 没有运行中的服务器进程需要停止');
  }

  if (proc && proc.pid) {
    console.log(`[opencode] 正在优雅终止服务器进程 PID ${proc.pid}...`);
    try {
      proc.kill('SIGTERM');
    } catch {
      /* 进程可能已退出 */
    }
    // 等待进程自行退出（最多 5s），给足时间做 WAL checkpoint
    for (let i = 0; i < 50; i++) {
      await sleep(100);
      if (!(await isPortInUse(SERVER_PORT))) {
        console.log('[opencode] 服务器进程已优雅退出（端口已释放）');
        break;
      }
    }
    if (proc.exitCode === null && !proc.killed) {
      try { proc.kill('SIGKILL'); } catch { /* 忽略 */ }
    }
  }

  if (await isPortInUse(SERVER_PORT)) {
    console.log('[opencode] 端口 4096 仍被占用，尝试清理孤儿进程...');
    await killProcessOnPort(SERVER_PORT);
    await sleep(500);
  }
}

/** 已知配置存在时自动启动（应用启动时调用）。 */
export async function autoStartOpencode(): Promise<void> {
  try {
    const config = await loadServerConfig();
    if (!config.model) {
      console.log('[opencode] 配置不完整（缺少 model），跳过自动启动');
      return;
    }
    if (!config.authToken) {
      console.log('[opencode] 用户未登录（缺少 auth_token），跳过自动启动');
      return;
    }
    console.log(`[opencode] 从存储中读取到配置，尝试自动启动服务... (model: ${config.model})`);
    await startOpencodeServerCore(config);
    console.log('[opencode] 自动启动成功');
  } catch (e) {
    console.warn(`[opencode] 自动启动失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 用户登录后启动（由前端 invoke）。先停旧进程，确保登录页新配置生效。 */
export async function startOpencodeAfterLogin(): Promise<string> {
  console.log('[opencode] 用户登录后尝试启动 opencode...');
  const config = await loadServerConfig();
  if (!config.model) throw new Error('配置不完整（缺少 model）');
  if (!config.authToken) throw new Error('auth_token 不存在，请先登录');

  // 先停后启，强制使用最新配置
  await stopOpencodeServer();
  await startOpencodeServerCore(config).catch((e) => {
    console.warn(`[opencode] 登录后启动失败: ${e instanceof Error ? e.message : String(e)}`);
  });
  return '启动请求已提交';
}

/** 登出时停止（幂等）。 */
export async function stopOpencode(): Promise<void> {
  await stopOpencodeServer();
}