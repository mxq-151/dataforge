/**
 * compile HTTP server 移植（lib.rs start_compile_server / compile_handler /
 * sql_validate_handler / fetch_dependencies / compile_file_sync）。
 *
 * 职责：为本机 opencode 提供本地编译能力——
 *   GET  /health                      健康检查（"ok"）
 *   POST /compile      {filePath,cwd} 读文件 → 拉依赖 → mvn 编译 → CompileResult JSON
 *   POST /sql-validate {filePath,cwd,datasources,engineType}
 *                                     读 SQL → 转发后端 /development/execution/validate
 * 鉴权：请求头 Authorization: Bearer <随机 token>（每次启动生成）。
 * opencode 启动时经 DATAFORGE_COMPILE_PORT / DATAFORGE_COMPILE_TOKEN 环境变量注入端点。
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { compileJavaScala } from './compile';
import { validatePathWithinWorkspace } from './maven';
import { readStoreJSON } from './store';

let server: http.Server | null = null;
let serverPort = 0;
let serverToken = '';

export function getCompileServerEndpoint(): { port: number; token: string } | null {
  if (!server || serverPort === 0) return null;
  return { port: serverPort, token: serverToken };
}

export function startCompileServer(): void {
  if (server) return;
  serverToken = randomUUID();
  server = http.createServer((req, res) => {
    void route(req, res).catch((e) => {
      sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
    });
  });
  server.on('error', (e) => {
    console.warn('[compile-server] 服务错误:', e);
  });
  server.listen(0, '127.0.0.1', () => {
    const addr = server?.address();
    if (addr && typeof addr === 'object') {
      serverPort = addr.port;
      console.log(`[compile-server] 监听 127.0.0.1:${serverPort} (token=${serverToken.slice(0, 8)}…)`);
    }
  });
}

export function stopCompileServer(): void {
  if (server) {
    server.close();
    server = null;
  }
  serverPort = 0;
  serverToken = '';
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body ?? {});
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
      if (data.length > 10 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function isAuthorized(req: http.IncomingMessage): boolean {
  const auth = req.headers['authorization'] ?? '';
  return auth === `Bearer ${serverToken}`;
}

async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = (req.url ?? '').split('?')[0];
  const method = req.method ?? 'GET';

  if (url === '/health' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (!isAuthorized(req)) {
    sendJson(res, 401, { error: 'invalid compile token' });
    return;
  }

  if (url === '/compile' && method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    console.log(`[compile] HTTP 请求体: filePath=${body.filePath}, cwd=${body.cwd ?? null}`);
    try {
      const result = await handleCompile(body.filePath ?? '', body.cwd ?? null);
      sendJson(res, 200, result);
    } catch (e) {
      sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
    return;
  }

  if (url === '/sql-validate' && method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    try {
      const result = await handleSqlValidate(
        body.filePath ?? '',
        body.cwd ?? null,
        body.datasources ?? [],
        body.engineType ?? '',
      );
      sendJson(res, 200, result);
    } catch (e) {
      sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

// ─── 配置 / 依赖 ────────────────────────────────────────────────

interface StoredCompileConfig {
  javaHome?: string;
  scalaHome?: string;
  mavenHome?: string;
  cwd?: string;
  backendHost?: string;
  scalaVersion?: string;
  pomTemplate?: string;
  mavenGroupId?: string;
  mavenArtifactId?: string;
}

async function readCompileConfig(): Promise<StoredCompileConfig> {
  const store = await readStoreJSON<{ config?: StoredCompileConfig }>('opencode-config.json');
  const config = store.config ?? {};
  if (!config.javaHome) {
    throw new Error('JAVA_HOME 未配置，请在设置页面完成配置');
  }
  return config;
}

async function readAuthToken(): Promise<string> {
  const secure = await readStoreJSON<{ auth_token?: string }>('secure-store.json');
  return secure.auth_token ?? '';
}

function normalizeApiHost(host: string | undefined): string {
  if (host?.trim()) {
    const h = host.trim();
    return h.endsWith('/api') ? h : `${h.replace(/\/+$/, '')}/api`;
  }
  // 与 Rust 一致：仅在某用户未配置 backend_host 时的 fallback
  return 'http://localhost:8082/api';
}

/** 从 DataForge 后端拉取 autoChoose=1 的依赖列表（对齐 fetchDependencies）。 */
async function fetchDependencies(apiHost: string, authToken: string): Promise<import('./compile').MavenDependency[]> {
  try {
    const url = `${apiHost}/devops/dependency/list?current=1&size=10000`;
    const headers: Record<string, string> = { 'X-AI-Request': 'true', 'Content-Type': 'application/json' };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    console.log(`[compile] 拉取依赖: url=${url}, token=${authToken ? '已设置' : '空'}`);
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    console.log(`[compile] 依赖列表响应状态: ${resp.status}`);
    if (!resp.ok) return [];
    const json = (await resp.json()) as { code?: number; data?: { records?: Array<Record<string, unknown>> } };
    const code = json.code ?? 0;
    if (code !== 200 && code !== 0) return [];
    const seen = new Set<string>();
    const deps: import('./compile').MavenDependency[] = [];
    for (const record of json.data?.records ?? []) {
      if (record.autoChoose !== 1) continue;
      const groupId = String(record.groupId ?? '');
      const artifactId = String(record.artifactId ?? '');
      const key = `${groupId}:${artifactId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deps.push({
        groupId,
        artifactId,
        version: String(record.version ?? ''),
        scope: String(record.scope ?? 'compile'),
        jarPath: String(record.jarPath ?? ''),
      });
    }
    return deps;
  } catch (e) {
    console.warn('[compile] 拉取依赖异常，跳过依赖:', e instanceof Error ? e.message : e);
    return [];
  }
}

// ─── 处理函数 ───────────────────────────────────────────────────

async function handleCompile(filePath: string, sessionCwd: string | null): Promise<import('./compile').CompileResult> {
  const stored = await readCompileConfig();
  console.log(`[compile] 收到请求: filePath=${filePath}, sessionCwd=${sessionCwd}`);

  const workspace = sessionCwd || stored.cwd || process.cwd();
  const buildWorkspace = stored.cwd || process.cwd();
  const apiHost = normalizeApiHost(stored.backendHost);

  const absPath = path.isAbsolute(filePath) ? filePath : path.join(workspace, filePath);
  let validatedPath: string;
  try {
    validatedPath = validatePathWithinWorkspace(absPath);
  } catch (e) {
    throw new Error(`路径安全校验失败: ${e instanceof Error ? e.message : e} (路径: ${absPath})`);
  }
  console.log(`[compile] absPath=${absPath}, validated=${validatedPath}, exists=${fs.existsSync(validatedPath)}`);
  if (!fs.existsSync(validatedPath)) {
    throw new Error(`源文件不存在: ${filePath}`);
  }

  const codeContent = fs.readFileSync(validatedPath, 'utf8');
  if (!codeContent.trim()) {
    throw new Error(`源文件内容为空: ${filePath}`);
  }

  const ext = (path.extname(absPath) || '').slice(1).toLowerCase();
  const codeType = ext === 'scala' ? 'scala' : 'java';
  const fileName = path.basename(absPath) || 'App';
  const packageName = extractPackageName(codeContent);

  const authToken = await readAuthToken();
  const dependencies = await fetchDependencies(apiHost, authToken);
  console.log(`[compile] 依赖数量: ${dependencies.length}`);

  return compileJavaScala({
    javaHome: stored.javaHome ?? '',
    scalaHome: stored.scalaHome ?? '',
    mavenHome: stored.mavenHome ?? '',
    codeContent,
    codeType,
    packageName,
    fileName,
    filePath: absPath,
    pomTemplate: stored.pomTemplate ?? null,
    dependencies,
    cwd: buildWorkspace,
    backendHost: apiHost,
    projectCode: null,
    scalaVersion: stored.scalaVersion ?? null,
    mavenGroupId: stored.mavenGroupId ?? null,
    mavenArtifactId: stored.mavenArtifactId ?? null,
  });
}

async function handleSqlValidate(
  filePath: string,
  sessionCwd: string | null,
  datasources: string[],
  engineType: string,
): Promise<unknown> {
  const stored = await readCompileConfig();
  const apiHost = normalizeApiHost(stored.backendHost);
  const authToken = await readAuthToken();

  const workspace = sessionCwd || stored.cwd || process.cwd();
  const absPath = path.isAbsolute(filePath) ? filePath : path.join(workspace, filePath);
  let validatedPath: string;
  try {
    validatedPath = validatePathWithinWorkspace(absPath);
  } catch (e) {
    throw new Error(`路径安全校验失败: ${e instanceof Error ? e.message : e} (路径: ${absPath})`);
  }
  if (!fs.existsSync(validatedPath)) {
    throw new Error(`SQL 文件不存在: ${filePath}`);
  }

  const sql = fs.readFileSync(validatedPath, 'utf8');
  if (!sql.trim()) {
    throw new Error(`SQL 文件内容为空: ${filePath}`);
  }

  const url = `${apiHost}/development/execution/validate`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-AI-Request': 'true' };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  console.log(`[sql-validate] url=${url}, sql 长度=${sql.length}, 数据源=${JSON.stringify(datasources)}`);

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ codeContent: sql, codeType: 'sql', engineType, datasources }),
    signal: AbortSignal.timeout(60_000),
  });
  console.log(`[sql-validate] 后端响应状态: ${resp.status}`);
  return resp.json();
}

/** 解析包名：首个 `package xxx;` 声明（与 Rust extract_package_name 一致）。 */
function extractPackageName(code: string): string {
  for (const lineRaw of code.split('\n')) {
    const trimmed = lineRaw.trim();
    if (trimmed.startsWith('package ')) {
      const name = trimmed.slice('package '.length).trim().replace(/;+$/, '').trim();
      if (name) return name;
    }
  }
  return 'default';
}