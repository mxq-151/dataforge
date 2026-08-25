/**
 * LSP 工作区工程维护移植（lsp/mod.rs write_workspace_pom / run_maven_bloop_install）。
 */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveMvnBin, runMvn, validatePathWithinWorkspace } from './maven';

export interface WorkspacePomStatus {
  changed: boolean;
  bloopReady: boolean;
}

/** 判断 .bloop 下是否存在工程配置（排除 bloop.settings.json）。 */
function bloopProjectConfigsExist(root: string): boolean {
  const bloopDir = path.join(root, '.bloop');
  try {
    const entries = fs.readdirSync(bloopDir);
    return entries.some((n) => n.endsWith('.json') && n !== 'bloop.settings.json');
  } catch {
    return false;
  }
}

/**
 * write_workspace_pom：写入（或比对跳过）工作区 pom.xml，必要时清理过时 .bloop 配置。
 */
export async function writeWorkspacePom(workspaceRoot: string, pomContent: string): Promise<WorkspacePomStatus> {
  const validatedRoot = validatePathWithinWorkspace(workspaceRoot);
  if (!fs.existsSync(validatedRoot)) {
    await fsp.mkdir(validatedRoot, { recursive: true });
  }

  const pomPath = path.join(validatedRoot, 'pom.xml');

  // 关键优化：pom 内容未变化时不重写（保持 mtime），也不清空 .bloop，
  // 复用 Bloop/Metals 上一次的导入与 zinc 分析缓存。
  let unchanged = false;
  try {
    unchanged = (await fsp.readFile(pomPath, 'utf8')) === pomContent;
  } catch {
    unchanged = false;
  }
  if (unchanged) {
    const bloopReady = bloopProjectConfigsExist(validatedRoot);
    console.log(`[LSP] pom.xml 内容未变化，跳过写入（复用既有 .bloop 索引），bloop_ready=${bloopReady}`);
    return { changed: false, bloopReady };
  }

  // pom 变化 → 清除过时 .bloop 工程配置
  const bloopDir = path.join(validatedRoot, '.bloop');
  if (fs.existsSync(bloopDir)) {
    const entries = await fsp.readdir(bloopDir);
    for (const name of entries.filter((n) => n.endsWith('.json') && n !== 'bloop.settings.json')) {
      await fsp.rm(path.join(bloopDir, name), { force: true });
      console.log(`[LSP] 删除过时 bloop 配置: ${name}`);
    }
  }

  await fsp.writeFile(pomPath, pomContent, 'utf8');
  console.log(`[LSP] pom.xml 已写入: ${pomPath}`);
  return { changed: true, bloopReady: false };
}

/** 读取 .bloop 下各工程配置并统计 spark 是否出现在编译 classpath；同时检查 ~/.m2 的 -sources.jar。 */
export function diagnoseBloopClasspath(workspace: string): void {
  const bloopDir = path.join(workspace, '.bloop');
  let classpathSparkHits = 0;
  let configCount = 0;
  try {
    const entries = fs.readdirSync(bloopDir);
    for (const name of entries.filter((n) => n.endsWith('.json') && n !== 'bloop.settings.json')) {
      configCount += 1;
      try {
        const cfg = JSON.parse(fs.readFileSync(path.join(bloopDir, name), 'utf8'));
        const cp: unknown[] = cfg?.classpath ?? [];
        classpathSparkHits += cp.filter((c) => /spark/i.test(String(c))).length;
      } catch { /* 单个配置解析失败忽略 */ }
    }
  } catch { /* .bloop 不存在 */ }

  const m2Spark = countSparkSourcesInM2();
  console.log(
    `[LSP] bloop 诊断: 工程配置=${configCount}, classpath 中 spark jar=${classpathSparkHits}, ` +
      `~/.m2 中 spark -sources.jar=${m2Spark}（Metals 跳转库源码依赖其为非 0）`
  );
}

function countSparkSourcesInM2(): number {
  const m2 = path.join(os.homedir(), '.m2', 'repository');
  let count = 0;
  const search = (dir: string, depth: number) => {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        search(path.join(dir, e.name), depth + 1);
      } else if (/spark.*-sources\.jar$/i.test(e.name)) {
        count += 1;
      }
    }
  };
  search(m2, 0);
  return count;
}

/**
 * run_maven_bloop_install：mvn bloopInstall 生成 .bloop 工程，随后尽力下载依赖源码。
 */
export async function runMavenBloopInstall(javaHome: string, mavenHome: string, workspaceRoot: string): Promise<string> {
  const javaHomeTrim = javaHome.trim();
  const mavenHomeTrim = mavenHome.trim();
  if (!javaHomeTrim) {
    throw new Error('JAVA_HOME 未配置');
  }
  const mvnBin = resolveMvnBin(mavenHomeTrim);

  const workspace = path.resolve(workspaceRoot);
  const pomPath = path.join(workspace, 'pom.xml');
  if (!fs.existsSync(pomPath)) {
    throw new Error(`pom.xml 不存在: ${pomPath}`);
  }
  console.log(`[LSP] 运行 mvn bloop:install, workspace=${workspaceRoot}`);

  // 1) bloop:install（生成 .bloop 工程）
  const bloopR = await runMvn(
    mvnBin,
    ['ch.epfl.scala:bloop-maven-plugin:2.0.4:bloopInstall', '-q'],
    workspace,
    { JAVA_HOME: javaHomeTrim },
  );
  if (bloopR.code !== 0) {
    throw new Error(`mvn bloop:install 失败: ${bloopR.stderr}`);
  }
  console.log('[LSP] mvn bloop:install 成功');

  // 2) 尽力下载依赖源码（-sources.jar），失败不阻塞
  const sourcesR = await runMvn(
    mvnBin,
    ['dependency:sources', '-q', '-DincludeScope=compile'],
    workspace,
    { JAVA_HOME: javaHomeTrim },
  );
  if (sourcesR.code === 0) {
    console.log('[LSP] mvn dependency:sources 成功（依赖源码已下载到 ~/.m2）');
  } else {
    console.log(`[LSP] mvn dependency:sources 未全部成功（可忽略）: ${sourcesR.stderr.slice(0, 300)}`);
  }

  // 3) 诊断 spark classpath / sources
  diagnoseBloopClasspath(workspace);

  return bloopR.stdout;
}