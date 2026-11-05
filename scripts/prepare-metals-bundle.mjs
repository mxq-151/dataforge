#!/usr/bin/env node
/**
 * 构建期准备 Scala（Metals）离线运行时包 —— 生成物随代码一起提交。
 *
 * 背景：Scala LSP 以前是「首次使用时用 coursier launch 拉取 Metals + 依赖（约 150MB）」，
 * 首启依赖网络、慢网易超时。改为构建期把整套运行时固化到仓库内，随安装包分发：
 *
 *   resources/metals/lib/            Metals 主程序 + 全部运行时依赖（.jar）
 *   resources/metals/coursier-cache/ Bloop 构建服务器构件（Metals 内部用 coursier 取，
 *                                    运行时通过 COURSIER_CACHE 指向它，命中即不联网）
 *   resources/metals/bundle.json     版本/条目清单（运行时用于判断包是否完整）
 *
 * 运行时（electron/backend/lspBridge.ts）只用这两份资源启动，不再触发任何下载。
 *
 * 用法：
 *   node scripts/prepare-metals-bundle.mjs [--force]
 * 可覆盖环境变量：
 *   DATAFORGE_METALS_VERSION  Metals 版本（默认 1.6.7，需与 lspBridge.DEFAULT_METALS_VERSION 一致）
 *   DATAFORGE_BLOOP_VERSION   Bloop 版本（默认从 bloop-rifle 中读取 Metals 内置默认值）
 *   DATAFORGE_BLOOP_MODULE    Bloop 引导模块（默认从 bloop-rifle 读取，如 ch.epfl.scala:bloopgun-core_2.12）
 *   JAVA_HOME / MAVEN_HOME    本机 JDK / Maven；本机无 Maven 时自动下载到 .cache/tools/
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const METALS_DIR = path.join(ROOT, 'resources', 'metals');
const LIB_DIR = path.join(METALS_DIR, 'lib');
const CACHE_DIR = path.join(METALS_DIR, 'coursier-cache');
const MANIFEST = path.join(METALS_DIR, 'bundle.json');
const WORK_DIR = path.join(ROOT, '.cache', 'metals-bundle');

const METALS_VERSION = (process.env.DATAFORGE_METALS_VERSION || '1.6.7').trim();
const METALS_MAIN_CLASS = 'scala.meta.metals.Main';
const COURSIER_VERSION = (process.env.DATAFORGE_COURSIER_VERSION || '2.1.24').trim();
const MAVEN_VERSION = (process.env.DATAFORGE_MAVEN_VERSION || '3.9.9').trim();
const CENTRAL = (process.env.DATAFORGE_MAVEN_MIRROR || 'https://repo1.maven.org/maven2').replace(/\/+$/, '');

const force = process.argv.includes('--force');
const isWindows = process.platform === 'win32';

function log(msg) {
  console.log(`[metals-bundle] ${msg}`);
}

function fail(msg) {
  console.error(`[metals-bundle] 失败：${msg}`);
  process.exit(1);
}

// ─── 下载 / 解压 ────────────────────────────────────────────────

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error(`重定向次数过多: ${url}`));
    https
      .get(url, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return resolve(download(new URL(res.headers.location, url).toString(), dest, redirects + 1));
        }
        if (status !== 200) {
          res.resume();
          return reject(new Error(`下载失败 HTTP ${status}: ${url}`));
        }
        const total = parseInt(res.headers['content-length'] ?? '0', 10) || 0;
        let received = 0;
        let lastLog = 0;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const out = fs.createWriteStream(dest);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (process.stdout.isTTY && received - lastLog > 8 * 1024 * 1024) {
            lastLog = received;
            const pct = total ? ` (${Math.floor((received / total) * 100)}%)` : '';
            process.stdout.write(`\r[metals-bundle] 下载中 ${(received / 1048576).toFixed(0)}MB${pct}`);
          }
        });
        out.on('finish', () => {
          if (process.stdout.isTTY) process.stdout.write('\r');
          out.close(resolve);
        });
        out.on('error', reject);
        res.on('error', reject);
        res.pipe(out);
      })
      .on('error', reject);
  });
}

function unzipTo(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  new AdmZip(zipPath).extractAllTo(destDir, true);
}

// ─── JDK / Maven 解析 ──────────────────────────────────────────

function resolveJavaHome() {
  const fromEnv = (process.env.JAVA_HOME || '').trim();
  if (fromEnv && fs.existsSync(path.join(fromEnv, 'bin', isWindows ? 'java.exe' : 'java'))) return fromEnv;
  return null; // 交给 PATH 上的 java / javap
}

function javaExe(name) {
  const javaHome = resolveJavaHome();
  const exe = isWindows ? `${name}.exe` : name;
  if (javaHome) {
    const p = path.join(javaHome, 'bin', exe);
    if (fs.existsSync(p)) return p;
  }
  return exe; // PATH
}

function mvnExeIn(dir) {
  return path.join(dir, 'bin', isWindows ? 'mvn.cmd' : 'mvn');
}

/** 解析可用的 mvn：MAVEN_HOME/M2_HOME → PATH → 下载 Apache Maven 到 .cache/tools。 */
async function resolveMvn() {
  for (const key of ['MAVEN_HOME', 'M2_HOME']) {
    const home = (process.env[key] || '').trim();
    if (home) {
      const exe = mvnExeIn(home);
      if (fs.existsSync(exe)) return exe;
    }
  }
  try {
    execFileSync(isWindows ? 'mvn.cmd' : 'mvn', ['-v'], { stdio: 'ignore' });
    return isWindows ? 'mvn.cmd' : 'mvn';
  } catch {
    /* 本机无 Maven，走下载 */
  }

  const toolsDir = path.join(ROOT, '.cache', 'tools');
  const mavenHome = path.join(toolsDir, `apache-maven-${MAVEN_VERSION}`);
  const exe = mvnExeIn(mavenHome);
  if (fs.existsSync(exe)) return exe;

  const zipPath = path.join(toolsDir, `apache-maven-${MAVEN_VERSION}-bin.zip`);
  if (!fs.existsSync(zipPath)) {
    log(`本机未安装 Maven，下载 Apache Maven ${MAVEN_VERSION}（仅构建机使用，见 .cache/）`);
    await download(`${CENTRAL}/org/apache/maven/apache-maven/${MAVEN_VERSION}/apache-maven-${MAVEN_VERSION}-bin.zip`, zipPath);
  }
  unzipTo(zipPath, toolsDir);
  if (!fs.existsSync(exe)) fail(`Maven 解压后未找到可执行文件: ${exe}`);
  if (!isWindows) fs.chmodSync(exe, 0o755);
  return exe;
}

function mvnEnv() {
  const env = { ...process.env };
  const javaHome = resolveJavaHome();
  if (javaHome) env.JAVA_HOME = javaHome;
  return env;
}

function runMvn(mvn, args, cwd) {
  log(`mvn ${args.join(' ')}`);
  execFileSync(mvn, args, { cwd, env: mvnEnv(), stdio: 'inherit' });
}

function writePom(file, dependencies) {
  const deps = dependencies
    .map(
      (d) => `    <dependency>
      <groupId>${d.groupId}</groupId>
      <artifactId>${d.artifactId}</artifactId>
      <version>${d.version}</version>
    </dependency>`,
    )
    .join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.dataforge</groupId>
  <artifactId>metals-offline-bundle</artifactId>
  <version>1.0.0</version>
  <packaging>jar</packaging>
  <repositories>
    <repository>
      <id>central</id>
      <url>${CENTRAL}</url>
      <releases><enabled>true</enabled></releases>
      <snapshots><enabled>false</enabled></snapshots>
    </repository>
  </repositories>
  <dependencies>
${deps}
  </dependencies>
</project>
`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, xml, 'utf8');
}

// ─── 从 bloop-rifle 读取 Metals 内置的 Bloop 默认版本 / 模块 ─────────

/** 读取 class 常量池里的可打印字符串（javap 不可用时的兜底）。 */
function classStrings(buf) {
  const latin = buf.toString('latin1');
  const out = [];
  for (const m of latin.matchAll(/[\x20-\x7e]{4,}/g)) out.push(m[0]);
  return out;
}

function javapClass(jar, className) {
  return execFileSync(
    javaExe('javap'),
    ['-p', '-c', '-constants', '-classpath', jar, className],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
}

/** 某个方法体内出现的全部 `// String xxx` 常量。 */
function methodStrings(javapText, methodName) {
  const lines = javapText.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`\\b${methodName}\\(`).test(l));
  if (start === -1) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    // 下一个方法定义 → 结束
    if (/^\s{2}(public|private|protected|static|final)\s/.test(line)) break;
    const m = line.match(/\/\/\s*String\s+(\S+)/);
    if (m) out.push(m[1]);
  }
  return out;
}

function allStringConstants(javapText) {
  const out = [];
  for (const m of javapText.matchAll(/\/\/\s*String\s+(\S+)/g)) out.push(m[1]);
  return out;
}

/**
 * 读取 Metals 内置的 Bloop 默认模块 / 版本（bloop-rifle 在编入 Metals 时已固定）。
 *
 * bloop-rifle 2.x：hardCodedDefaultModule = bloopOrg + ":bloop-frontend_2.12"，
 * hardCodedDefaultVersion = BuildInfo.version（1.x 时代是 bloopgun-core_2.12）。
 */
function readBloopDefaults() {
  const jars = fs.readdirSync(LIB_DIR).filter((n) => /^bloop-rifle_2\.1[23]-.*\.jar$/.test(n));
  if (jars.length === 0) fail(`resources/metals/lib 下未找到 bloop-rifle，无法确定 Bloop 版本（${LIB_DIR}）`);
  const jar = path.join(LIB_DIR, jars[0]);

  let module = (process.env.DATAFORGE_BLOOP_MODULE || '').trim() || null;
  let version = (process.env.DATAFORGE_BLOOP_VERSION || '').trim() || null;

  if (!module || !version) {
    try {
      const cfg = javapClass(jar, 'bloop.rifle.BloopRifleConfig$');
      if (!module) {
        const org = methodStrings(cfg, 'bloopOrg')[0] || 'ch.epfl.scala';
        const suffix = methodStrings(cfg, 'hardCodedDefaultModule').find((s) => s.startsWith(':bloop-'));
        if (suffix) module = `${org}${suffix}`;
      }
      if (!version) {
        const v = methodStrings(cfg, 'hardCodedDefaultVersion').find((s) => /^\d+\.\d+\.\d+$/.test(s));
        if (v) version = v;
      }
      if (!version) {
        // 版本实际来自 BuildInfo.version
        const info = javapClass(jar, 'bloop.rifle.internal.BuildInfo$');
        version = allStringConstants(info).find((s) => /^\d+\.\d+\.\d+$/.test(s)) || null;
      }
    } catch (e) {
      log(`javap 解析 bloop-rifle 失败（改用常量池扫描）: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (!module || !version) {
    // 兜底：直接从 class 常量池上扫描
    const zip = new AdmZip(jar);
    const entry = zip.getEntry('bloop/rifle/BloopRifleConfig$.class');
    if (entry) {
      const strings = classStrings(entry.getData());
      module = module || strings.find((s) => /^:?bloop-(frontend|gun)/.test(s) && s.includes(':bloop-')) || null;
      version = version || strings.find((s) => /^\d+\.\d+\.\d+$/.test(s)) || null;
    }
  }

  if (!version) {
    fail('无法从 bloop-rifle 推断 Bloop 版本，请显式设置 DATAFORGE_BLOOP_VERSION');
  }
  if (!module) {
    // bloop-rifle 2.x 的固定默认值
    module = 'ch.epfl.scala:bloop-frontend_2.12';
    log(`未解析到默认模块，回退为 ${module}`);
  }
  // "ch.epfl.scala::bloopgun-core" 形式 → 补 Scala 2.12 后缀（与 BloopServers.fetchBloop 一致）
  if (module.includes('::')) module = module.replace('::', ':').replace(/bloopgun-core$|bloop-frontend$/, '$&_2.12');
  return { module, version };
}

// ─── 主流程 ────────────────────────────────────────────────────

function libJars() {
  try {
    return fs.readdirSync(LIB_DIR).filter((n) => n.toLowerCase().endsWith('.jar'));
  } catch {
    return [];
  }
}

function dirSize(p) {
  let total = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const full = path.join(p, e.name);
    if (e.isDirectory()) total += dirSize(full);
    else if (e.isFile()) total += fs.statSync(full).size;
  }
  return total;
}

function bundleUpToDate() {
  if (force) return false;
  try {
    const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    return (
      m.metalsVersion === METALS_VERSION &&
      m.bloopVersion &&
      libJars().length > 0 &&
      fs.existsSync(CACHE_DIR) &&
      dirSize(CACHE_DIR) > 0
    );
  } catch {
    return false;
  }
}

async function main() {
  if (bundleUpToDate()) {
    const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    log(`离线包已就绪（Metals ${m.metalsVersion} / Bloop ${m.bloopVersion}），跳过。需要重建请加 --force`);
    return;
  }

  fs.mkdirSync(WORK_DIR, { recursive: true });
  const mvn = await resolveMvn();

  // 1) Metals 运行时依赖 → resources/metals/lib
  fs.rmSync(LIB_DIR, { recursive: true, force: true });
  const metalsPom = path.join(WORK_DIR, 'pom-metals.xml');
  writePom(metalsPom, [{ groupId: 'org.scalameta', artifactId: 'metals_2.13', version: METALS_VERSION }]);
  log(`解析 Metals ${METALS_VERSION} 运行时依赖（约 150MB，仅构建机联网）`);
  runMvn(
    mvn,
    ['-B', '-q', '-f', metalsPom, 'dependency:copy-dependencies', `-DoutputDirectory=${LIB_DIR}`, '-DincludeScope=runtime'],
    WORK_DIR,
  );
  const jars = libJars();
  if (jars.length === 0) fail(`未解析出任何 jar: ${LIB_DIR}`);
  if (!jars.some((n) => n.startsWith('metals_2.13-'))) fail(`lib 中缺少 metals 主 jar（${METALS_VERSION}）`);
  log(`Metals 依赖就绪：${jars.length} 个 jar`);

  // 2) Bloop 引导构件 → resources/metals/coursier-cache
  const bloop = readBloopDefaults();
  // 2.x 直接是 bloop-frontend；1.x 是先拉 bloopgun-core 再由它拉 frontend，两者都预置
  const bloopDeps = [`${bloop.module}:${bloop.version}`];
  if (/bloopgun-core/.test(bloop.module)) {
    bloopDeps.push(`${bloop.module.replace('bloopgun-core', 'bloop-frontend')}:${bloop.version}`);
  }
  log(`解析 Bloop ${bloop.version}（${bloopDeps.join(' + ')}）到内置 coursier 缓存`);

  const csPom = path.join(WORK_DIR, 'pom-coursier.xml');
  const csLibDir = path.join(WORK_DIR, 'coursier-lib');
  writePom(csPom, [{ groupId: 'io.get-coursier', artifactId: 'coursier-cli_2.13', version: COURSIER_VERSION }]);
  fs.rmSync(csLibDir, { recursive: true, force: true });
  runMvn(
    mvn,
    ['-B', '-q', '-f', csPom, 'dependency:copy-dependencies', `-DoutputDirectory=${csLibDir}`, '-DincludeScope=runtime'],
    WORK_DIR,
  );
  if (!fs.existsSync(path.join(csLibDir, 'coursier-cli_2.13-' + COURSIER_VERSION + '.jar'))) {
    fail(`coursier-cli ${COURSIER_VERSION} 未解析成功: ${csLibDir}`);
  }

  fs.rmSync(CACHE_DIR, { recursive: true, force: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  execFileSync(
    javaExe('java'),
    ['-cp', path.join(csLibDir, '*'), 'coursier.cli.Coursier', 'fetch', '--cache', CACHE_DIR, ...bloopDeps],
    { stdio: 'inherit', env: { ...process.env, COURSIER_CACHE: CACHE_DIR } },
  );
  if (dirSize(CACHE_DIR) === 0) fail(`Bloop 构件未落入内置缓存: ${CACHE_DIR}`);

  // 3) 清单
  const manifest = {
    metalsVersion: METALS_VERSION,
    mainClass: METALS_MAIN_CLASS,
    bloopVersion: bloop.version,
    bloopModule: bloop.module,
    libJars: jars.length,
    libBytes: dirSize(LIB_DIR),
    cacheBytes: dirSize(CACHE_DIR),
    generatedAt: new Date().toISOString(),
    generatedBy: 'scripts/prepare-metals-bundle.mjs',
  };
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  log(
    `完成：lib ${(manifest.libBytes / 1048576).toFixed(0)}MB / coursier-cache ${(manifest.cacheBytes / 1048576).toFixed(0)}MB`,
  );
  log('resources/metals 已随仓库提交（npm run pack / dist 会原样打进安装包）。');
}

main().catch((e) => fail(e instanceof Error ? e.stack || e.message : String(e)));
