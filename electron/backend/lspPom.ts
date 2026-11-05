/**
 * LSP 工作区工程维护移植（lsp/mod.rs write_workspace_pom / run_maven_bloop_install）。
 */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import AdmZip from 'adm-zip';
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

// ─── referencedLibraries 源码 jar 解析 ────────────────────────────

export interface ResolveJarSourcesResult {
  /** 展开后的二进制 jar 文件路径（文件直通 / 目录展开为其中全部 .jar） */
  binaries: string[];
  /** 二进制 jar 路径 → 对应 -sources.jar 路径 */
  sources: Record<string, string>;
}

// ~/.m2/repository 的 -sources.jar 索引（按二进制 jar 文件名 → 源码 jar 全路径）。
// 扫描整个 m2 仓库较慢（数千文件），做模块级缓存 + TTL，避免每次 classpath 刷新都重扫。
const M2_SOURCES_INDEX_TTL = 60_000;
let m2SourcesIndex: Map<string, string> | null = null;
let m2SourcesIndexAt = 0;

/** 遍历 ~/.m2/repository，把每个 `xxx-sources.jar` 按「对应二进制 jar 名」建索引。 */
function buildM2SourcesIndex(): Map<string, string> {
  const map = new Map<string, string>();
  const m2 = path.join(os.homedir(), '.m2', 'repository');
  const walk = (dir: string, depth: number) => {
    // Maven 布局 groupId/artifactId/version/xxx.jar 深度约 4-6 层，6 层足够
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
      } else if (e.name.endsWith('-sources.jar')) {
        // 二进制 jar 名 = 去掉末尾 -sources.jar 再补 .jar
        const binaryName = e.name.slice(0, -'-sources.jar'.length) + '.jar';
        if (!map.has(binaryName)) map.set(binaryName, full);
      }
    }
  };
  walk(m2, 0);
  return map;
}

function getM2SourcesIndex(): Map<string, string> {
  const now = Date.now();
  if (!m2SourcesIndex || now - m2SourcesIndexAt > M2_SOURCES_INDEX_TTL) {
    m2SourcesIndex = buildM2SourcesIndex();
    m2SourcesIndexAt = now;
  }
  return m2SourcesIndex;
}

/**
 * 解析 referencedLibraries 需要的「二进制 jar + 源码 jar 映射」。
 *
 * 输入 jarPaths 可能来自依赖记录的 jarPath（本地目录 / 单个 jar 文件 / 远端 URI）。
 * 这里把可解析的本地路径展开为真实 jar 文件，并为每个 jar 找源码：
 *   1) 同目录 `{basename}-sources.jar`（JDT.LS 自动附件的约定，也覆盖自定义存储目录）；
 *   2) 否则回退到 ~/.m2/repository 里同名 `-sources.jar`（m2e 下载的源码）。
 * 远端路径（hdfs://、file://、http 等）无法本地解析源码，直接跳过。
 */
export function resolveJarSources(args: { jarPaths: string[] }): ResolveJarSourcesResult {
  const binaries: string[] = [];
  const sources: Record<string, string> = {};
  const seen = new Set<string>();

  const addJar = (jarFile: string) => {
    const lower = jarFile.toLowerCase();
    if (!lower.endsWith('.jar') || lower.endsWith('-sources.jar')) return;
    if (seen.has(jarFile)) return;
    seen.add(jarFile);
    binaries.push(jarFile);

    const base = jarFile.slice(0, -'.jar'.length);
    const sibling = base + '-sources.jar';
    if (fs.existsSync(sibling)) {
      sources[jarFile] = sibling;
    } else {
      const m2Hit = getM2SourcesIndex().get(path.basename(jarFile));
      if (m2Hit) sources[jarFile] = m2Hit;
    }
  };

  for (const raw of args.jarPaths) {
    const p = (raw ?? '').trim();
    if (!p) continue;
    // 跳过 URI 形态的远端路径（hdfs://、file://、http://…），仅处理本地盘符/相对路径
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(p) && !/^[a-zA-Z]:[\\/]/.test(p)) continue;

    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch {
      continue; // 路径不存在，跳过
    }
    if (st.isFile()) {
      addJar(p);
    } else if (st.isDirectory()) {
      let names: string[];
      try {
        names = fs.readdirSync(p);
      } catch {
        continue;
      }
      for (const name of names) {
        if (name.toLowerCase().endsWith('.jar')) {
          addJar(path.join(p, name));
        }
      }
    }
  }

  return { binaries, sources };
}

/**
 * 从本地 ~/.m2/repository 的 `-sources.jar` 里读取某个类的 `.scala` 源码。
 *
 * 背景：JDT.LS（Java LSP）对 Scala 写的库（如 Spark）做「定义跳转」时，即便源码附件
 * （sources jar）已就位，其 ClassFile.getBuffer() 也只认 .java、读不了 .scala，于是只能
 * FernFlower 反编译 .class。本函数绕开 JDT.LS，直接按「二进制 jar 名 + 类名」在 .m2 里
 * 定位 sources jar 并解出对应的 .scala 源码，让前端跳转时显示真实 Scala 源码而非反编译。
 *
 * @param jarName  二进制 jar 文件名（如 `spark-sql_2.12-3.5.9.jar`），来自 jdt:// URI。
 * @param className 全限定类名（如 `org.apache.spark.sql.SparkSession`）。
 * @returns 命中返回 .scala 源码文本；未找到 sources jar 或对应 .scala 文件返回 null。
 */
export function readJarScalaSource(args: { jarName: string; className: string }): string | null {
  const jarName = (args.jarName ?? '').trim();
  const className = (args.className ?? '').trim();
  if (!jarName.toLowerCase().endsWith('.jar') || !className) return null;

  // 按二进制 jar 名在 .m2 索引里找 sources jar（索引 key 即「二进制 jar 名」）
  const sourceJarPath = getM2SourcesIndex().get(jarName);
  if (!sourceJarPath) return null;

  // 顶层类名 → jar 内 .scala 相对路径（内部类/匿名类归到外部类文件）
  const topClass = className.split('$')[0];
  const internalPath = topClass.replace(/\./g, '/') + '.scala';

  try {
    const zip = new AdmZip(sourceJarPath);
    const entry = zip.getEntry(internalPath);
    if (!entry) return null;
    return entry.getData().toString('utf8');
  } catch {
    return null;
  }
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
  console.log(`[LSP] 运行 mvn bloop:bloopInstall, workspace=${workspaceRoot}`);

  // 1) bloop:bloopInstall（生成 .bloop 工程）。
  //    插件已声明在 workspace 的 pom.xml 中（含 downloadSources=true），
  //    故依赖源码会在此导出时一并下载，无需单独的 dependency:sources 步骤。
  const bloopR = await runMvn(
    mvnBin,
    ['bloop:bloopInstall', '-q'],
    workspace,
    { JAVA_HOME: javaHomeTrim },
  );
  if (bloopR.code !== 0) {
    throw new Error(`mvn bloop:bloopInstall 失败: ${bloopR.stderr}`);
  }
  console.log('[LSP] mvn bloop:bloopInstall 成功');

  // 2) 诊断 spark classpath / sources
  diagnoseBloopClasspath(workspace);

  return bloopR.stdout;
}