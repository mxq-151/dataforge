/**
 * LSP WebSocket 桥移植（lsp/ws.rs + lsp/mod.rs read_metals_source）。
 *
 * 设计：后端只负责「启动 JVM 语言服务器（JDT.LS / Metals）」并哑管道化——
 * 把子进程 stdio 透传为 ws://127.0.0.1:<临时端口>，前端 monaco-languageclient
 * 一个 WS 文本帧 = 一条 JSON-RPC 消息；桥接只做 Content-Length 分帧 ⇄ WS 文本帧
 * 的双向转换，不做任何协议语义解析（能力协商、自动应答全由前端 SDK 处理）。
 */
import { app } from 'electron';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import AdmZip from 'adm-zip';
import { emitToRenderer, getMainWindow } from '../eventBus';

const DEFAULT_METALS_VERSION = '1.6.7';
// JDT.LS 改为首次使用时按需下载：从 dirigiblelabs/jdtls-mirror（固定镜像，GitHub CDN）
// 拉取 jdt-language-server-<版本>.tar.gz 到 userData/jdtls，避免打进安装包。
const JDTLS_VERSION = '1.47.0.202505151856';
const JDTLS_DOWNLOAD_URL = `https://github.com/dirigiblelabs/jdtls-mirror/releases/download/${JDTLS_VERSION}/jdt-language-server-${JDTLS_VERSION}.tar.gz`;
const JDTLS_SHA256 = '354242694936016cd48635967cb28cd4b0735779dafe963077139d2823ccda3a';
const isWindows = process.platform === 'win32';

interface JdtlsProgress {
  stage: 'download' | 'verify' | 'extract' | 'done' | 'error';
  received?: number;
  total?: number;
  message?: string;
}

interface LspProcess {
  child: ChildProcess;
  wss: WebSocketServer;
}

const processes = new Map<number, LspProcess>();
let nextClientId = 1;

// ─── 资源路径解析 ──────────────────────────────────────────────

function hasJdtlsLauncher(dir: string): boolean {
  const pluginsDir = path.join(dir, 'plugins');
  if (!fs.existsSync(pluginsDir)) return false;
  try {
    return fs.readdirSync(pluginsDir).some((n) => n.startsWith('org.eclipse.equinox.launcher_'));
  } catch {
    return false;
  }
}

function hasMetalsArtifacts(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'metals.jar')) || fs.existsSync(path.join(dir, 'coursier.jar'));
}

export function resolveJdtlsPath(): string {
  const devAppPath = app.getAppPath();
  const candidates = [
    process.env.DATAFORGE_JDTLS_PATH ?? '',
    app.isPackaged ? path.join(process.resourcesPath, 'jdtls') : '',
    path.join(app.getPath('userData'), 'jdtls'), // 按需下载位置（首次使用自动拉取）
    path.join(devAppPath, 'resources', 'jdtls'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (hasJdtlsLauncher(c)) return c;
  }
  throw new Error(
    `JDT.LS 未安装。请运行 download-jdtls.sh（macOS/Linux）或 download-jdtls.bat（Windows），或手动解压到: ${path.join(devAppPath, 'resources', 'jdtls')}`,
  );
}

export function resolveMetalsPath(): string {
  const devAppPath = app.getAppPath();
  const candidates = [
    process.env.DATAFORGE_METALS_PATH ?? '',
    app.isPackaged ? path.join(process.resourcesPath, 'metals') : '',
    path.join(devAppPath, 'resources', 'metals'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (hasMetalsArtifacts(c)) return c;
  }
  throw new Error(
    `Metals 未安装。请在 ${path.join(devAppPath, 'resources', 'metals')} 中放置 coursier.jar（首次启动会自动下载 Metals 及其依赖），或直接放置 metals.jar`,
  );
}

/** 归一化 JAVA_HOME 输入（去掉 JAVA_HOME= 前缀 / 末尾 /bin/java）。 */
export function cleanJavaHome(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('JAVA_HOME=')) return cleanJavaHome(trimmed.slice('JAVA_HOME='.length));
  if (trimmed.startsWith('JAVA_HOME =')) return cleanJavaHome(trimmed.slice('JAVA_HOME ='.length));
  if (trimmed.endsWith('/bin/java')) return trimmed.slice(0, -'/bin/java'.length);
  if (trimmed.endsWith('\\bin\\java.exe')) return trimmed.slice(0, -'\\bin\\java.exe'.length);
  return trimmed;
}

/** 由 workspace_root 派生稳定短哈希（FNV-1a 64），作为 JDT.LS/Metals 的 -data 子目录。 */
function workspaceDataSubdir(workspaceRoot: string): string {
  if (!workspaceRoot) return 'default';
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (const ch of Buffer.from(workspaceRoot, 'utf8')) {
    hash ^= BigInt(ch);
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

function javaBin(javaHome: string): string {
  const bin = path.join(javaHome, 'bin', isWindows ? 'java.exe' : 'java');
  if (!fs.existsSync(bin)) {
    throw new Error(`Java 可执行文件不存在: ${bin}`);
  }
  return bin;
}

function copyDirRecursive(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

// ─── JDT.LS 按需下载 ────────────────────────────────────────────

function emitJdtlsProgress(p: JdtlsProgress): void {
  try {
    emitToRenderer(getMainWindow(), 'lsp-jdtls-progress', p);
  } catch {
    /* 忽略（无窗口时） */
  }
}

/** 下载文件到本地（自动跟随重定向，按块回报进度）。 */
function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const doGet = (u: string, redirects = 0) => {
      if (redirects > 5) return reject(new Error('下载重定向次数过多'));
      const req = https.get(u, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return doGet(new URL(res.headers.location, u).toString(), redirects + 1);
        }
        if (status !== 200) {
          res.resume();
          return reject(new Error(`下载失败：HTTP ${status}`));
        }
        const total = parseInt(res.headers['content-length'] ?? '0', 10) || 0;
        let received = 0;
        const out = fs.createWriteStream(dest);
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          // 约每 1MB 回报一次进度，避免高频 IPC
          if (received - Math.floor(received / (1024 * 1024)) * (1024 * 1024) < 64 * 1024) {
            emitJdtlsProgress({ stage: 'download', received, total });
          }
        });
        out.on('finish', () => {
          out.close();
          resolve();
        });
        out.on('error', reject);
        res.on('error', reject);
        res.pipe(out);
      });
      req.on('error', reject);
    };
    doGet(url);
  });
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/** 用系统 tar 解压 .tar.gz（macOS/Linux 用 tar，Windows 10+ 自带 bsdtar），返回含 launcher 的服务器目录。 */
function extractTarGz(tgzPath: string, destParent: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const bin = isWindows ? 'tar.exe' : 'tar';
    execFile(bin, ['-xzf', tgzPath, '-C', destParent], { maxBuffer: 256 * 1024 * 1024, timeout: 600_000 }, (err) => {
      if (err) return reject(new Error(`解压失败：${err.message}`));
      const entries = fs.readdirSync(destParent).map((n) => path.join(destParent, n));
      const serverDir = entries.find((p) => {
        try {
          return fs.statSync(p).isDirectory() && hasJdtlsLauncher(p);
        } catch {
          return false;
        }
      });
      resolve(serverDir ?? destParent);
    });
  });
}

/**
 * 确保 JDT.LS 已就绪：若 userData/jdtls 已有 launcher 则直接返回；
 * 否则从固定镜像下载 tar.gz → 校验 SHA-256 → 解压 → 落位到 userData/jdtls。
 */
async function ensureJdtlsDownloaded(): Promise<string> {
  const userData = app.getPath('userData');
  const targetDir = path.join(userData, 'jdtls');
  if (hasJdtlsLauncher(targetDir)) return targetDir;

  const tmpDir = path.join(userData, '.jdtls-download-tmp');
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    emitJdtlsProgress({
      stage: 'download',
      message: `首次使用自动下载 JDT.LS ${JDTLS_VERSION}（约 47MB，仅需一次）`,
    });
    console.log(`[JDT.LS] 首次使用自动下载 ${JDTLS_DOWNLOAD_URL} ...`);
    const tgzPath = path.join(tmpDir, `jdt-language-server-${JDTLS_VERSION}.tar.gz`);
    await downloadFile(JDTLS_DOWNLOAD_URL, tgzPath);

    emitJdtlsProgress({ stage: 'verify', message: '校验下载完整性（SHA-256）' });
    const sha = await sha256File(tgzPath);
    if (sha !== JDTLS_SHA256) {
      throw new Error(`JDT.LS 下载校验失败（sha256=${sha}，预期=${JDTLS_SHA256}）`);
    }

    emitJdtlsProgress({ stage: 'extract', message: '解压中' });
    const extracted = await extractTarGz(tgzPath, tmpDir);
    if (!hasJdtlsLauncher(extracted)) {
      throw new Error(`解压后未找到 JDT.LS launcher：${extracted}`);
    }

    // 解压后立即删除 tar.gz，避免走「无顶层目录」兜底复制时把它一并带入目标目录
    fs.rmSync(tgzPath, { force: true });

    if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
    if (extracted === tmpDir) {
      // 兜底：tarball 无顶层目录时整体复制
      fs.mkdirSync(targetDir, { recursive: true });
      copyDirRecursive(tmpDir, targetDir);
    } else {
      fs.renameSync(extracted, targetDir);
    }
    emitJdtlsProgress({ stage: 'done', message: 'JDT.LS 就绪' });
    console.log(`[JDT.LS] 已就绪：${targetDir}`);
    return targetDir;
  } finally {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function findLauncherJar(pluginsDir: string): string {
  const entries = fs.readdirSync(pluginsDir);
  const jar = entries.find((n) => n.startsWith('org.eclipse.equinox.launcher_') && n.endsWith('.jar'));
  if (!jar) throw new Error(`Launcher JAR not found in ${pluginsDir}`);
  return path.join(pluginsDir, jar);
}

/** 构造 JDT.LS 启动参数（与 VS Code Red Hat Java 扩展 jdtls 启动脚本一致）。 */
function buildJdtlsArgs(javaHome: string, jdtlsPath: string, dataDir: string): { bin: string; args: string[]; env: Record<string, string> } {
  const pluginsDir = path.join(jdtlsPath, 'plugins');
  if (!fs.existsSync(pluginsDir)) {
    throw new Error(`JDT.LS plugins 目录不存在: ${pluginsDir}`);
  }
  const launcherJar = findLauncherJar(pluginsDir);

  const configDirName = process.platform === 'darwin' ? 'config_mac'
    : isWindows ? 'config_win'
    : 'config_linux';
  const sourceConfig = path.join(jdtlsPath, configDirName);
  if (!fs.existsSync(sourceConfig)) {
    throw new Error(`JDT.LS 配置目录不存在: ${sourceConfig}`);
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const writableConfig = path.join(dataDir, 'config');
  if (!fs.existsSync(writableConfig)) {
    copyDirRecursive(sourceConfig, writableConfig);
  }

  const args = [
    '-Declipse.application=org.eclipse.jdt.ls.core.id1',
    '-Dosgi.bundles.defaultStartLevel=4',
    '-Declipse.product=org.eclipse.jdt.ls.core.product',
    '-Dlog.protocol=true',
    '-Dlog.level=ALL',
    '-Xmx1G',
    '--add-modules=ALL-SYSTEM',
    '--add-opens', 'java.base/java.util=ALL-UNNAMED',
    '--add-opens', 'java.base/java.lang=ALL-UNNAMED',
    '-DDetectVMInstallationsJob.disabled=true',
    '-Dfile.encoding=utf8',
    '-Xms100m',
    '-Xlog:disable',
    '-XX:+UseParallelGC',
    '-XX:GCTimeRatio=4',
    '-XX:AdaptiveSizePolicyWeight=90',
    '-Dsun.zip.disableMemoryMapping=true',
    '-Djava.import.generatesMetadataFilesAtProjectRoot=false',
    '-Daether.dependencyCollector.impl=bf',
  ];
  if (isWindows) {
    args.push('--add-opens', 'java.base/sun.nio.fs=ALL-UNNAMED');
  }
  args.push('-jar', launcherJar, '-configuration', writableConfig, '-data', dataDir);

  return { bin: javaBin(javaHome), args, env: { JAVA_HOME: javaHome } };
}

/** 构造 Metals 启动参数（与 VS Code Scala (Metals) 扩展一致）。 */
function buildMetalsArgs(javaHome: string, metalsPath: string, dataDir: string, metalsVersion: string): { bin: string; args: string[]; env: Record<string, string> } {
  const metalsJar = path.join(metalsPath, 'metals.jar');
  const coursierJar = path.join(metalsPath, 'coursier.jar');
  fs.mkdirSync(dataDir, { recursive: true });

  const args = [
    '-Xmx1G', '-XX:+UseG1GC', '-XX:+UseStringDeduplication', '-Xss4m', '-Xms100m',
    '--add-exports', 'jdk.compiler/com.sun.tools.javac.api=ALL-UNNAMED',
    '--add-exports', 'jdk.compiler/com.sun.tools.javac.file=ALL-UNNAMED',
    '--add-exports', 'jdk.compiler/com.sun.tools.javac.main=ALL-UNNAMED',
    '--add-exports', 'jdk.compiler/com.sun.tools.javac.model=ALL-UNNAMED',
    '--add-exports', 'jdk.compiler/com.sun.tools.javac.parser=ALL-UNNAMED',
    '--add-exports', 'jdk.compiler/com.sun.tools.javac.tree=ALL-UNNAMED',
    '--add-exports', 'jdk.compiler/com.sun.tools.javac.util=ALL-UNNAMED',
    '--add-exports', 'jdk.compiler/com.sun.tools.javac.code=ALL-UNNAMED',
    '--add-exports', 'jdk.compiler/com.sun.tools.javac.comp=ALL-UNNAMED',
    '--add-exports', 'jdk.compiler/com.sun.tools.javac.jvm=ALL-UNNAMED',
  ];
  if (fs.existsSync(metalsJar)) {
    args.push('-jar', metalsJar);
  } else if (fs.existsSync(coursierJar)) {
    console.log(
      `[Metals] 使用 coursier 启动（首次使用会自动下载 Metals v${metalsVersion} 及其依赖，约 150MB，仅需一次）`,
    );
    args.push('-jar', coursierJar, 'launch', `org.scalameta:metals_2.13:${metalsVersion}`, '-M', 'scala.meta.metals.Main');
  } else {
    throw new Error(`Metals 未安装。在 ${metalsPath} 中未找到 metals.jar 或 coursier.jar`);
  }

  const env: Record<string, string> = { JAVA_HOME: javaHome };
  // 让 coursier 优先复用本机 Maven 已下载到 ~/.m2/repository 的依赖（maven-local 放最前）
  const m2 = path.join(os.homedir(), '.m2', 'repository');
  if (fs.existsSync(m2)) {
    const existing = process.env.COURSIER_REPOSITORIES ?? '';
    const newVal = !existing.trim() ? 'maven-local|ivy2-local|https://repo1.maven.org/maven2'
      : existing.includes('maven-local') ? existing
      : `maven-local|ivy2-local|${existing}`;
    env.COURSIER_REPOSITORIES = newVal;
    console.log(`[Metals] 注入 COURSIER_REPOSITORIES（优先复用 ${m2}）: ${newVal}`);
  }

  return { bin: javaBin(javaHome), args, env };
}

// ─── LSP Content-Length 分帧解析（stdout → 完整消息）──────────────

/** 增量解析器：累积 Buffer，尝试从头部提取一条完整 LSP 消息。 */
class LspFrameParser {
  private buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  tryExtract(): string | null {
    for (;;) {
      const headerEnd = this.buf.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        // 超过头最大长度说明出错，丢弃（防御）
        if (this.buf.length > 64 * 1024) this.buf = Buffer.alloc(0);
        return null;
      }
      const header = this.buf.subarray(0, headerEnd).toString('utf8');
      const lengthMatch = header.match(/(?:Content-Length|Content-Length\s):\s*(\d+)/i);
      if (!lengthMatch) {
        this.buf = this.buf.subarray(headerEnd + 4);
        continue;
      }
      const length = parseInt(lengthMatch[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.buf.length < bodyStart + length) return null;
      const body = this.buf.subarray(bodyStart, bodyStart + length).toString('utf8');
      this.buf = this.buf.subarray(bodyStart + length);
      return body;
    }
  }
  push(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
  }
}

function lspFrame(message: string): Uint8Array {
  return Buffer.from(`Content-Length: ${Buffer.byteLength(message, 'utf8')}\r\n\r\n${message}`, 'utf8');
}

// ─── WS 桥 ─────────────────────────────────────────────────────

/**
 * 运行桥接：绑定临时端口的 WS 服务，接受唯一连接后做双向透传；
 * 连接断开/子进程退出时回收 JVM，并向前端发送 lsp-exit-{id} / lsp-ws-closed-{id}。
 */
function runBridge(clientId: number, child: ChildProcess, wss: WebSocketServer): void {
  const stderrLog: string[] = [];
  const emitExit = (tail: string[]) => {
    emitToRenderer(getMainWindow(), `lsp-exit-${clientId}`, { stderrTail: tail });
  };

  // stderr 排空 + 环形缓冲（200 行），Metals 退出时回传最后 30 行
  if (child.stderr) {
    child.stderr.on('data', (d: Buffer) => {
      for (const line of d.toString('utf8').split('\n')) {
        if (!line) continue;
        console.log(`[LSP-WS:${clientId}] server stderr: ${line}`);
        stderrLog.push(line);
        if (stderrLog.length > 200) stderrLog.shift();
        emitToRenderer(getMainWindow(), `lsp-stderr-${clientId}`, line);
      }
    });
  }

  // 子进程在 WS 连接前就退出（如启动即失败）→ 通知前端
  let wsConnected = false;
  child.on('exit', (code, signal) => {
    if (!wsConnected) {
      const tail = stderrLog.slice(-30);
      emitExit(tail);
      emitToRenderer(getMainWindow(), `lsp-ws-closed-${clientId}`, {});
      try { wss.close(); } catch { /* 忽略 */ }
      processes.delete(clientId);
      console.log(`[LSP-WS:${clientId}] 桥接进程已退出 (code=${code}, signal=${signal})`);
    }
  });

  wss.once('connection', (ws) => {
    wsConnected = true;
    console.log(`[LSP-WS] client_id=${clientId} 已建立连接`);

    let closed = false;
    const cleanup = () => {
      try { child.kill('SIGKILL'); } catch { /* 忽略 */ }
      emitExit(stderrLog.slice(-30));
      emitToRenderer(getMainWindow(), `lsp-ws-closed-${clientId}`, {});
      try { wss.close(); } catch { /* 忽略 */ }
      processes.delete(clientId);
    };
    const closeAll = () => {
      if (closed) return;
      closed = true;
      try { ws.close(); } catch { /* 忽略 */ }
      cleanup();
    };

    // WS -> stdin
    ws.on('message', (data) => {
      const text = data.toString();
      try {
        if (child.stdin?.writable) child.stdin.write(lspFrame(text));
      } catch (e) {
        console.warn(`[LSP-WS:${clientId}] stdin 写入失败:`, e);
      }
    });
    ws.on('close', () => {
      console.log(`[LSP-WS] client_id=${clientId} 连接结束，回收 JVM`);
      closeAll();
    });
    ws.on('error', () => closeAll());

    // stdout -> WS（Content-Length 分帧读取）
    const parser = new LspFrameParser();
    if (child.stdout) {
      child.stdout.on('data', (d: Buffer) => {
        parser.push(d);
        for (;;) {
          const msg = parser.tryExtract();
          if (msg === null) break;
          try {
            if (ws.readyState === WebSocket.OPEN) ws.send(msg);
          } catch (e) {
            console.warn(`[LSP-WS:${clientId}] WS 写入失败:`, e);
            closeAll();
            break;
          }
        }
      });
      child.stdout.on('end', () => {
        if (!closed) {
          console.log(`[LSP-WS:${clientId}] stdout 结束，回收 JVM`);
          closeAll();
        }
      });
    }

    // 子进程退出兜底（WS 已连接但进程死亡）
    child.on('exit', (code, signal) => {
      console.log(`[LSP-WS:${clientId}] 桥接进程已退出 (code=${code}, signal=${signal})`);
      closeAll();
    });
  });

  wss.on('error', (err) => {
    console.warn(`[LSP-WS:${clientId}] WS 服务错误:`, err);
  });
}

async function startLspWs(
  buildSpec: { bin: string; args: string[]; env: Record<string, string> },
  label: string,
): Promise<{ clientId: number; wsUrl: string }> {
  console.log(`[${label}-WS] 启动命令: ${buildSpec.bin} ${buildSpec.args.join(' ')}`);

  const child = spawn(buildSpec.bin, buildSpec.args, {
    env: { ...process.env, ...buildSpec.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const clientId = nextClientId++;

  // 绑定临时端口（WebSocketServer port:0）
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const port = await new Promise<number>((resolve, reject) => {
    wss.once('listening', () => {
      const addr = wss.address();
      if (addr && typeof addr === 'object') resolve(addr.port);
      else reject(new Error('LSP WS 端口分配失败'));
    });
    wss.once('error', reject);
  });

  processes.set(clientId, { child, wss });
  runBridge(clientId, child, wss);

  return { clientId, wsUrl: `ws://127.0.0.1:${port}` };
}

// ─── 对外命令 ──────────────────────────────────────────────────

export async function startJavaLspWs(args: { javaHome: string; workspaceRoot: string }): Promise<{ client_id: number; ws_url: string }> {
  const javaHome = cleanJavaHome(args.javaHome);
  if (!javaHome) throw new Error('JAVA_HOME 未配置');
  // 优先使用已有安装（env / 打包资源 / userData / dev resources），缺失则按需下载
  let jdtlsPath: string;
  try {
    jdtlsPath = resolveJdtlsPath();
  } catch {
    jdtlsPath = await ensureJdtlsDownloaded();
  }
  const dataDir = path.join(app.getPath('userData'), 'jdtls-workspace', workspaceDataSubdir(args.workspaceRoot));
  const spec = buildJdtlsArgs(javaHome, jdtlsPath, dataDir);
  const { clientId, wsUrl } = await startLspWs(spec, 'JDT.LS');
  return { client_id: clientId, ws_url: wsUrl };
}

export async function startScalaLspWs(args: { javaHome: string; workspaceRoot: string; metalsVersion?: string }): Promise<{ client_id: number; ws_url: string }> {
  const javaHome = cleanJavaHome(args.javaHome);
  if (!javaHome) throw new Error('JAVA_HOME 未配置');
  const metalsVersion = args.metalsVersion?.trim() || DEFAULT_METALS_VERSION;
  const metalsPath = resolveMetalsPath();
  const dataDir = path.join(app.getPath('userData'), 'metals-workspace', workspaceDataSubdir(args.workspaceRoot));
  const spec = buildMetalsArgs(javaHome, metalsPath, dataDir, metalsVersion);
  const { clientId, wsUrl } = await startLspWs(spec, 'Metals');
  return { client_id: clientId, ws_url: wsUrl };
}

export function stopJavaLspWs(args: { clientId: number }): void {
  const proc = processes.get(args.clientId);
  if (proc) {
    try { proc.child.kill('SIGKILL'); } catch { /* 忽略 */ }
    try { proc.wss.close(); } catch { /* 忽略 */ }
    processes.delete(args.clientId);
    console.log(`[LSP-WS] 已停止, client_id=${args.clientId}`);
  }
}

export function stopScalaLspWs(args: { clientId: number }): void {
  stopJavaLspWs(args);
}

/** 应用退出时回收全部 LSP 进程。 */
export function stopAllLspBridges(): void {
  for (const [id, proc] of [...processes]) {
    try { proc.child.kill('SIGKILL'); } catch { /* 忽略 */ }
    try { proc.wss.close(); } catch { /* 忽略 */ }
    processes.delete(id);
  }
}

// ─── read_metals_source：从 Metals 依赖源码读取（纯内存、不落盘）─────

function normalizeMetalsSourcePath(p: string): string {
  const trimmed = p.trim();
  let start = 0;
  while (start < trimmed.length && trimmed[start] === '/') start++;
  if (start === 0) return trimmed;
  const rest = trimmed.slice(start);
  if (rest.length >= 2 && rest[1] === ':' && /[a-zA-Z]/.test(rest[0])) return rest;
  return trimmed;
}

const metalsSourceCache = new Map<string, string>();

export async function readMetalsSource(args: { path: string }): Promise<string> {
  const raw = normalizeMetalsSourcePath(args.path);
  const cached = metalsSourceCache.get(raw);
  if (cached !== undefined) return cached;

  // Metals 把依赖源码解压成真实文件（.metals/readonly/dependencies/<name>-sources.jar/<pkg>/<Class>.scala），
  // 这里的 "-sources.jar" 是目录，路径本身即磁盘真实文件。
  try {
    const content = await fsp.readFile(raw, 'utf8');
    metalsSourceCache.set(raw, content);
    return content;
  } catch {
    /* 落到 ZIP 兜底 */
  }

  // 兜底：极少数环境未解压、<name>-sources.jar 为真实 ZIP 时，按 JAR 内部路径读取
  const jarMarker = '.jar/';
  const jarPos = raw.indexOf(jarMarker);
  if (jarPos !== -1) {
    const jarPath = raw.slice(0, jarPos + 4);
    const internalPath = raw.slice(jarPos + 5);
    if (fs.existsSync(jarPath) && fs.statSync(jarPath).isFile()) {
      try {
        const zip = new AdmZip(jarPath);
        const entry = zip.getEntry(internalPath);
        if (entry) {
          const content = entry.getData().toString('utf8');
          metalsSourceCache.set(raw, content);
          return content;
        }
        throw new Error(`JAR 内未找到条目: ${internalPath}`);
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('JAR 内未找到')) throw e;
        throw new Error(`从 JAR 读取源码失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  throw new Error(`依赖源码文件不存在（且非 JAR 内部路径）: ${raw}`);
}