/**
 * compile_java_scala 实现。
 * 流程：生成临时编译工程（源码 + utils 公共源 + pom.xml）→ mvn clean package -DskipTests →
 * 定位生成的 JAR。
 * 源码根统一为 src（Maven <sourceDirectory>src</sourceDirectory>），Java/Scala 源码均写入
 * {buildDir}/src/{包目录}；临时工程自包含，与工作区实际源码路径解耦。
 */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { formatTimestamp, hostLabel, resolveMvnBin, runMvn, workspaceHome } from './maven';

export interface MavenDependency {
  groupId: string;
  artifactId: string;
  version: string;
  scope: string;
  jarPath: string;
}

export interface CompileRequest {
  javaHome: string;
  scalaHome: string;
  mavenHome: string;
  codeContent: string;
  codeType: 'java' | 'scala';
  packageName: string;
  fileName?: string;
  filePath?: string | null;
  pomTemplate?: string | null;
  dependencies?: MavenDependency[];
  cwd?: string | null;
  backendHost?: string | null;
  projectCode?: string | null;
  scalaVersion?: string | null;
  mavenGroupId?: string | null;
  mavenArtifactId?: string | null;
}

export interface CompileResult {
  success: boolean;
  jarPath: string;
  output: string;
  error: string;
  packageName: string;
  className: string;
}

function extractClassName(code: string, codeType: string): string {
  for (const lineRaw of code.split('\n')) {
    const trimmed = lineRaw.trim();
    if (codeType === 'scala') {
      for (const prefix of ['object ', 'class ']) {
        if (trimmed.startsWith(prefix)) {
          const name = trimmed.slice(prefix.length).trim().split(/\s+/)[0];
          if (name) return name;
        }
      }
    } else {
      const withoutPublic = trimmed.startsWith('public ') ? trimmed.slice('public '.length).trim() : trimmed;
      for (const prefix of ['class ', 'interface ', 'enum ']) {
        if (withoutPublic.startsWith(prefix)) {
          const name = withoutPublic.slice(prefix.length).trim().split(/\s+/)[0];
          if (name && /^[A-Za-z_]/.test(name)) return name;
        }
      }
    }
  }
  return 'App';
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 根据源码文件路径与包名推导项目包根目录（首段包名为项目根目录名）。 */
function findProjectPkgRoot(filePath: string, packageName: string): string | null {
  const segs = packageName.split('.').filter(Boolean);
  if (segs.length < 2) return null;
  let dir = path.dirname(path.resolve(filePath));
  for (let i = 1; i < segs.length; i++) {
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return dir;
}

/**
 * 从源码文件所在目录向上定位项目中的 utils 目录。
 * utils 可能位于不同层级（如 {pkgRoot}/code/utils 或 {srcRoot}/test_project/ads/code/utils），
 * 因此从即可源码文件所在目录逐级向上、在 srcRoot 范围内查找名为 utils 的目录，
 * 避免硬编码首段包名拼接 code/utils 导致定位失败。
 */
function locateUtilsDir(startDir: string, srcRoot: string): string | null {
  let dir = path.resolve(startDir);
  const srcRootResolved = path.resolve(srcRoot);
  while (true) {
    const cand = path.join(dir, 'utils');
    if (fs.existsSync(cand) && fs.statSync(cand).isDirectory()) {
      return cand;
    }
    if (dir === srcRootResolved) break; // 不越过 Maven sourceDirectory 根
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * 将项目 code/utils 目录下的常用工具类源码递归拷贝进编译工程 src 目录，
 * 返回拷贝数量。utils 目录为扁平结构（java/scala 工具类同放 code/utils，
 * 不再按语言分子目录），按扩展名过滤目标语言。
 */
async function copyUtilSources(opts: {
  /** 编译工程源码根 {buildDir}/src */
  destSrc: string;
  /** utils 相对 Maven sourceDirectory 根的包路径（如 test_project/ads/code/utils） */
  relPkgDir: string;
  /** utils 源码目录（工作区中定位到的真实路径） */
  utilsSrcDir: string;
  /** 要拷贝的语言扩展名，如 ['java'] / ['scala'] */
  exts: string[];
}): Promise<number> {
  const { destSrc, relPkgDir, utilsSrcDir, exts } = opts;
  const destBase = path.join(destSrc, relPkgDir);
  let copied = 0;
  const stack = [utilsSrcDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(p);
        continue;
      }
      const ext = path.extname(entry.name).slice(1);
      if (!exts.includes(ext.toLowerCase())) continue;
      const rel = path.relative(utilsSrcDir, p);
      const target = path.join(destBase, rel);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      try {
        await fsp.copyFile(p, target);
        copied += 1;
      } catch {
        /* 忽略单个文件拷贝失败 */
      }
    }
  }
  return copied;
}

function generatePomXml(opts: {
  packageName: string;
  scalaVersion: string;
  depsXml: string;
  scalaPlugin: string;
  finalName: string;
  className: string;
  groupId: string;
  artifactId: string;
}): string {
  const mainClass = `${opts.packageName}.${opts.className}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <groupId>${opts.groupId}</groupId>
    <artifactId>${opts.artifactId}</artifactId>
    <version>1.0-SNAPSHOT</version>
    <packaging>jar</packaging>

    <properties>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
        <maven.compiler.source>17</maven.compiler.source>
        <maven.compiler.target>17</maven.compiler.target>
        <scala.version>${opts.scalaVersion}</scala.version>
    </properties>

    <dependencies>
${opts.depsXml.trimEnd()}
    </dependencies>

    <build>
        <sourceDirectory>\${project.basedir}/src</sourceDirectory>
        <plugins>
${opts.scalaPlugin.trimEnd()}            <plugin>
                <groupId>org.apache.maven.plugins</groupId>
                <artifactId>maven-jar-plugin</artifactId>
                <version>3.3.0</version>
                <configuration>
                    <archive>
                        <manifest>
                            <mainClass>${mainClass}</mainClass>
                        </manifest>
                    </archive>
                    <finalName>${opts.finalName}</finalName>
                </configuration>
            </plugin>
        </plugins>
    </build>
</project>
`;
}

export async function compileJavaScala(req: CompileRequest): Promise<CompileResult> {
  const javaHome = req.javaHome.trim();
  const scalaHome = req.scalaHome.trim();
  const mavenHome = req.mavenHome.trim();

  if (!javaHome) {
    throw new Error('JAVA_HOME 未配置，请在设置页面配置 JAVA_HOME');
  }
  if (!fs.existsSync(javaHome)) {
    throw new Error(`JAVA_HOME 目录不存在: ${javaHome}`);
  }

  const mvnBin = resolveMvnBin(mavenHome);
  const timestamp = formatTimestamp();

  // build 目录：~/.dataforge/{后端host标签}/build/{projectCode?}/{timestamp}
  const hostLabel_ = hostLabel(req.backendHost ?? '');
  let buildDir = path.join(workspaceHome(), hostLabel_, 'build');
  if (req.projectCode) {
    buildDir = path.join(buildDir, req.projectCode);
  }
  buildDir = path.join(buildDir, timestamp);
  await fsp.mkdir(buildDir, { recursive: true });

  // ── 源码根：{buildDir}/src（Maven sourceDirectory），Java 与 Scala 源码共用 ──
  const srcMain = path.join(buildDir, 'src');
  const packageDir = req.packageName.split('.').reduce((acc, seg) => path.join(acc, seg), srcMain);
  await fsp.mkdir(packageDir, { recursive: true });

  const ext = req.codeType === 'scala' ? 'scala' : 'java';
  const className = extractClassName(req.codeContent, req.codeType);
  const sourceFile = path.join(packageDir, `${className}.${ext}`);
  await fsp.writeFile(sourceFile, req.codeContent, 'utf8');

  // ── 将项目 code/utils 目录下的公共工具类源码一并编译（扁平结构，java/scala 同放）──
  let hasUtilsScala = false;
  let hasUtilsJava = false;
  if (req.filePath && req.packageName && req.packageName !== 'default') {
    const pkgRoot = findProjectPkgRoot(req.filePath, req.packageName);
    if (pkgRoot) {
      // 工作区 Maven sourceDirectory 根（首包目录的父目录），utils 相对路径按此根推导
      const srcRoot = path.dirname(pkgRoot);
      const srcOut = path.join(buildDir, 'src');
      // 从源码文件所在目录向上定位真实 utils 目录，并保持其相对 src 根的包路径，
      // 使工具类与其源码 import 的包（如 test_project.ads.code.utils）一致。
      const utilsSrc = locateUtilsDir(path.dirname(req.filePath), srcRoot);
      if (utilsSrc) {
        const relPkgDir = path.relative(srcRoot, utilsSrc).split(path.sep).join('/');
        hasUtilsScala = (await copyUtilSources({ destSrc: srcOut, relPkgDir, utilsSrcDir: utilsSrc, exts: ['scala'] })) > 0;
        hasUtilsJava = (await copyUtilSources({ destSrc: srcOut, relPkgDir, utilsSrcDir: utilsSrc, exts: ['java'] })) > 0;
      }
    }
  }

  const needsScala = req.codeType === 'scala' || hasUtilsScala;

  // Scala 版本：用户配置 > SCALA_HOME/lib 检测 > 默认 2.13.18
  let scalaVersion = '';
  if (needsScala) {
    if (req.scalaVersion?.trim()) {
      scalaVersion = req.scalaVersion.trim();
    } else if (scalaHome) {
      const libDir = path.join(scalaHome, 'lib');
      let detected = '2.13.18';
      try {
        const entries = await fsp.readdir(libDir);
        for (const name of entries) {
          if (name.startsWith('scala-library-') && name.endsWith('.jar')) {
            detected = name.slice('scala-library-'.length, -'.jar'.length);
            break;
          }
        }
      } catch { /* 忽略 */ }
      scalaVersion = detected;
    } else {
      scalaVersion = '2.13.18';
    }
  }

  const parts = req.packageName.split('.');
  const derivedGroupId = parts.length > 1 ? parts.slice(0, -1).join('.') : req.packageName;
  const derivedArtifactId = parts[parts.length - 1] || 'app';
  const groupId = req.mavenGroupId?.trim() || derivedGroupId;
  const artifactId = req.mavenArtifactId?.trim() || derivedArtifactId;

  let depsXml = '';
  if (needsScala) {
    depsXml += `        <dependency>\n            <groupId>org.scala-lang</groupId>\n            <artifactId>scala-library</artifactId>\n            <version>${scalaVersion}</version>\n        </dependency>\n`;
  }
  for (const dep of req.dependencies ?? []) {
    const hasMavenCoords = !!(dep.groupId && dep.artifactId && dep.version);
    const hasJarPath = !!dep.jarPath;
    if (hasMavenCoords) {
      const scope = dep.scope || 'compile';
      if (scope === 'system' && hasJarPath) {
        depsXml += `        <dependency>\n            <groupId>${xmlEscape(dep.groupId)}</groupId>\n            <artifactId>${xmlEscape(dep.artifactId)}</artifactId>\n            <version>${xmlEscape(dep.version)}</version>\n            <scope>system</scope>\n            <systemPath>${xmlEscape(dep.jarPath)}</systemPath>\n        </dependency>\n`;
      } else {
        depsXml += `        <dependency>\n            <groupId>${xmlEscape(dep.groupId)}</groupId>\n            <artifactId>${xmlEscape(dep.artifactId)}</artifactId>\n            <version>${xmlEscape(dep.version)}</version>\n            <scope>${xmlEscape(scope)}</scope>\n        </dependency>\n`;
      }
    } else if (hasJarPath) {
      const fileName = path.basename(dep.jarPath);
      const artifact = fileName.replace(/\.jar$/i, '');
      depsXml += `        <dependency>\n            <groupId>local</groupId>\n            <artifactId>${xmlEscape(artifact)}</artifactId>\n            <version>1.0</version>\n            <scope>system</scope>\n            <systemPath>${xmlEscape(dep.jarPath)}</systemPath>\n        </dependency>\n`;
    }
  }

  const scalaPluginSnippet = needsScala
    ? `            <plugin>\n                <groupId>net.alchim31.maven</groupId>\n                <artifactId>scala-maven-plugin</artifactId>\n                <version>4.8.1</version>\n                <executions>\n                    <execution>\n                        <phase>process-resources</phase>\n                        <goals>\n                            <goal>compile</goal>\n                            <goal>testCompile</goal>\n                        </goals>\n                    </execution>\n                </executions>\n                <configuration>\n                    <scalaVersion>${scalaVersion}</scalaVersion>\n                </configuration>\n            </plugin>\n`
    : '';

  let scalaPlugin = '';
  if (needsScala) {
    if (req.codeType === 'scala' && hasUtilsJava) {
      scalaPlugin +=
        '            <plugin>\n                <groupId>org.apache.maven.plugins</groupId>\n                <artifactId>maven-compiler-plugin</artifactId>\n                <version>3.11.0</version>\n                <executions>\n                    <execution>\n                        <id>compile-java-early</id>\n                        <phase>process-resources</phase>\n                        <goals>\n                            <goal>compile</goal>\n                        </goals>\n                    </execution>\n                </executions>\n            </plugin>\n';
    }
    scalaPlugin += scalaPluginSnippet;
  }

  const resolvedFileName = req.fileName || (req.filePath ? path.basename(req.filePath) : 'App');
  const finalName = path.basename(resolvedFileName, path.extname(resolvedFileName)) || 'App';

  const pomDefault = generatePomXml({
    packageName: req.packageName,
    scalaVersion,
    depsXml,
    scalaPlugin,
    finalName,
    className,
    groupId,
    artifactId,
  });
  const pomContent = req.pomTemplate?.trim()
    ? (req.pomTemplate
        .replace('{group_id}', groupId)
        .replace('{artifact_id}', artifactId)
        .replace('{main_class}', `${req.packageName}.${className}`)
        .replace('{final_name}', finalName)
        .replace('{scala_version}', scalaVersion)
        .replace('{deps}', depsXml.trimEnd())
        .replace('{scala_plugin}', scalaPlugin.trimEnd()))
    : pomDefault;

  // 源码统一写入 {buildDir}/src，若 pom 未显式声明 <sourceDirectory>，则强制注入
  // Maven 默认只扫描 src/main/java 与 src/main/scala，缺失该配置会导致源码不被编译、
  // 打包出的 jar 不含字节文件（只有 manifest）。与 ensurePomReady 的注入逻辑保持一致。
  const sourceDirInject = `<sourceDirectory>\${project.basedir}/src</sourceDirectory>`;
  let injectedPom = pomContent;
  if (!/<sourceDirectory\b/.test(injectedPom)) {
    if (/<build\b[^>]*>/.test(injectedPom)) {
      injectedPom = injectedPom.replace(/(<build\b[^>]*>)/, `$1\n        ${sourceDirInject}`);
    } else {
      injectedPom = injectedPom.replace(/<\/project>\s*$/, `    <build>\n        ${sourceDirInject}\n    </build>\n</project>`);
    }
  }

  await fsp.writeFile(path.join(buildDir, 'pom.xml'), injectedPom, 'utf8');

  const cmdStr = `JAVA_HOME=${javaHome} ${mvnBin} clean package -DskipTests`;
  const r = await runMvn(mvnBin, ['clean', 'package', '-DskipTests'], buildDir, { JAVA_HOME: javaHome });

  if (r.spawnError) {
    return {
      success: false,
      jarPath: '',
      output: '',
      error: `执行 mvn 失败: ${r.spawnError}。请确认已安装 Maven 并配置了 MAVEN_HOME 或 mvn 在系统 PATH 中`,
      packageName: req.packageName,
      className,
    };
  }
  if (r.code !== 0) {
    const fullError = r.stderr && r.stdout ? `${r.stderr}\n\n${r.stdout}` : r.stderr || r.stdout;
    return {
      success: false,
      jarPath: '',
      output: `命令: ${cmdStr}\n工作目录: ${buildDir}`,
      error: fullError,
      packageName: req.packageName,
      className,
    };
  }

  const targetDir = path.join(buildDir, 'target');
  const defaultJar = path.join(targetDir, `${finalName}.jar`);
  let jarPath = '';
  if (fs.existsSync(defaultJar)) {
    jarPath = defaultJar;
  } else {
    let found: string | null = null;
    const allJars: string[] = [];
    if (fs.existsSync(targetDir)) {
      const entries = await fsp.readdir(targetDir);
      for (const name of entries.filter((n) => n.endsWith('.jar'))) {
        allJars.push(`${name} (${path.join(targetDir, name)})`);
        if (!name.includes('original') && !found) {
          found = path.join(targetDir, name);
        }
      }
    }
    if (!found) {
      return {
        success: false,
        jarPath: '',
        output: `命令: ${cmdStr}\n工作目录: ${buildDir}\n\n编译输出:\n${r.stdout}`,
        error: `编译成功但未找到生成的 JAR 文件。expected=${finalName}.jar, target目录中的文件: ${JSON.stringify(allJars)}`,
        packageName: req.packageName,
        className,
      };
    }
    jarPath = found;
  }

  return {
    success: true,
    jarPath,
    output: `命令: ${cmdStr}\n工作目录: ${buildDir}\n${r.stdout}`.trim(),
    error: '',
    packageName: req.packageName,
    className,
  };
}