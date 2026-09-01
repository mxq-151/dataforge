import { invoke } from '../bridge/ipc';
import { fetchDependencyList } from '../api/dependency';
import { fetchProjectConfigByFilePath } from '../api/devProject';
import { trimTrailingSlash, getBaseName } from '../utils/pathUtils';

/** XML 转义：防止依赖字段注入恶意 XML 节点（如 exec-maven-plugin 导致 RCE） */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

let isGenerating = false;
let lastWorkspaceRoot: string | null = null;

export interface EnsurePomOptions {
  mavenGroupId?: string;
  mavenArtifactId?: string;
  scalaVersion?: string;
  /** 设置页的 POM 模板（与编译路径一致，支持 {group_id}/{artifact_id}/{scala_version}/{deps}/{scala_plugin}/{main_class}/{final_name} 占位符）。
   *  提供时 LSP pom 按模板生成；不提供时回退到下方 LSP 专用硬编码模板（含 scala-maven-plugin）。
 *  源码根统一为工作区内的 src（Maven <sourceDirectory>src</sourceDirectory>）。 */
  pomTemplate?: string;
  /** 项目 ID，用于并入「项目级依赖配置」（/params jarDependency Catalogs） */
  projectId?: number;
  /** 项目编码，作为项目级配置的 filePath 键 */
  projectCode?: string;
  /** 工作区根路径，用于把相对文件路径换算成后端存储路径 */
  rootPath?: string;
  /** 覆盖 bloop 输出目录（bloop.configDirectory）。缺省让 Maven 使用 <workspace>/.bloop。 */
  bloopConfigDirectory?: string;
  /** 是否在 bloop 导出时下载依赖源码（缺省 true，与以往 mvn dependency:sources 等价）。 */
  bloopDownloadSources?: boolean;
}

/** 把一条依赖记录拼成 <dependency> 片段（GAV 或 system 作用域的本地 jar） */
function buildDepXml(dep: {
  groupId?: string;
  artifactId?: string;
  version?: string;
  scope?: string;
  jarPath?: string;
}): string {
  const hasMavenCoords = dep.groupId && dep.artifactId && dep.version;
  const hasJarPath = dep.jarPath;
  const scope = dep.scope || 'compile';

  if (hasMavenCoords) {
    if (scope === 'system' && hasJarPath) {
      return `        <dependency>\n            <groupId>${escapeXml(dep.groupId!)}</groupId>\n            <artifactId>${escapeXml(dep.artifactId!)}</artifactId>\n            <version>${escapeXml(dep.version!)}</version>\n            <scope>system</scope>\n            <systemPath>${escapeXml(dep.jarPath!)}</systemPath>\n        </dependency>\n`;
    }
    return `        <dependency>\n            <groupId>${escapeXml(dep.groupId!)}</groupId>\n            <artifactId>${escapeXml(dep.artifactId!)}</artifactId>\n            <version>${escapeXml(dep.version!)}</version>\n            <scope>${escapeXml(scope)}</scope>\n        </dependency>\n`;
  }
  if (hasJarPath) {
    const fileName = getBaseName(dep.jarPath!);
    const artifact = fileName.replace(/\.jar$/i, '');
    return `        <dependency>\n            <groupId>local</groupId>\n            <artifactId>${escapeXml(artifact)}</artifactId>\n            <version>1.0</version>\n            <scope>system</scope>\n            <systemPath>${escapeXml(dep.jarPath!)}</systemPath>\n        </dependency>\n`;
  }
  return '';
}

/** 把形如 groupId:artifactId:version 的字符串解析为 GAV 依赖片段（兜底：项目配置里直接写了坐标） */
function buildGavDepXml(coord: string): string {
  const parts = coord.split(':');
  const groupId = parts[0] || 'local';
  const artifactId = parts[1] || coord;
  const version = parts[2] || '1.0';
  return `        <dependency>\n            <groupId>${escapeXml(groupId)}</groupId>\n            <artifactId>${escapeXml(artifactId)}</artifactId>\n            <version>${escapeXml(version)}</version>\n        </dependency>\n`;
}

export async function ensurePomReady(
  javaHome: string,
  mavenHome: string,
  workspaceRootRaw: string,
  options?: EnsurePomOptions,
): Promise<void> {
  const workspaceRoot = trimTrailingSlash(workspaceRootRaw);

  if (isGenerating) {
    console.log('[ensurePomReady] pom.xml 正在生成中，等待完成...');
    while (isGenerating) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    return;
  }

  if (lastWorkspaceRoot === workspaceRoot) {
    console.log('[ensurePomReady] pom.xml 已是最新 (同一 workspace)，跳过');
    return;
  }

  isGenerating = true;
  try {
    const depRes = await fetchDependencyList();
    const depRecords = depRes?.data?.records || [];

    const scalaVer = options?.scalaVersion?.trim() || '2.13.18';
    const groupId = options?.mavenGroupId?.trim() || 'com.dataforge';
    const artifactId = options?.mavenArtifactId?.trim() || 'data_procs';

    let depsXml = '';
    depsXml += `        <dependency>\n            <groupId>org.scala-lang</groupId>\n            <artifactId>scala-library</artifactId>\n            <version>${scalaVer}</version>\n        </dependency>\n`;

    // 1) 全局依赖目录中的全部记录（与编译路径一致：autoChoose 与普通依赖都在内）
    for (const dep of depRecords) {
      depsXml += buildDepXml(dep);
    }

    // 2) 并入「项目级依赖配置」（/params 的 jarDependencyCatalogs），与编译路径保持一致：
    //    编译能拿到项目级依赖，LSP 的 pom/.bloop 也必须包含，否则其中类
    //    （如 spark-sql 的 SaveMode）在编辑器里无法跳转，尽管编译能过。
    if (options?.projectId != null) {
      try {
        const fp = options.projectCode || '';
        const cfg = await fetchProjectConfigByFilePath(options.projectId, fp);
        // 后端返回的是 DevJarDependency 对象数组，取 artifactId || jarName 作为依赖名
        const names: string[] = (cfg?.data?.jarDependencyCatalogs || [])
          .map(dep => dep.artifactId || dep.jarName || '')
          .filter(Boolean);
        if (names.length > 0) {
          const seen = new Set<string>();
          for (const name of names) {
            if (!name || seen.has(name)) continue;
            seen.add(name);
            const rec = depRecords.find(
              (d: any) => d.artifactId === name || d.jarName === name
            );
            if (rec) {
              const xml = buildDepXml(rec);
              if (xml) depsXml += xml;
            } else if (name.includes(':')) {
              // 项目配置直接写了 GAV 坐标，兜底写入
              depsXml += buildGavDepXml(name);
            } else {
              console.warn(`[ensurePomReady] 项目依赖「${name}」未在依赖目录匹配到记录，已忽略`);
            }
          }
          console.log(`[ensurePomReady] 已并入项目级依赖 ${names.length} 项`);
        }
      } catch (e) {
        console.warn('[ensurePomReady] 读取项目级依赖配置失败（不影响全局目录依赖）:', e);
      }
    }

    const sparkDeps = (depsXml.match(/spark/gi) || []).length;
    console.log(
      `[ensurePomReady] 生成 pom：依赖片段共 ${depsXml.split('<dependency>').length - 1} 个，其中含 "spark" 的 ${sparkDeps} 处`
    );
    if (sparkDeps === 0) {
      console.warn(
        '[ensurePomReady] 生成的 pom 中未包含任何 spark 依赖（SaveMode 所在）。\n' +
          '          请确认 spark-sql / spark-core 已加入「依赖目录」或「项目级依赖配置」，否则无法跳转其类。'
      );
    }

    // scala-maven-plugin 片段：用于填充模板 {scala_plugin} 占位符（与编译路径语义一致）。
    // 内部 ${scala.version} 是 Maven 属性引用（编译期由 <properties> 解析），不是 JS 模板。
    const scalaPluginXml = `            <plugin>
                <groupId>net.alchim31.maven</groupId>
                <artifactId>scala-maven-plugin</artifactId>
                <version>4.8.1</version>
                <executions>
                    <execution>
                        <goals>
                            <goal>compile</goal>
                            <goal>testCompile</goal>
                        </goals>
                    </execution>
                </executions>
                <configuration>
                    <scalaVersion>\${scala.version}</scalaVersion>
                </configuration>
            </plugin>
`;

    // ── 按项目解析 bloop 参数 ──────────────────────────────
    // bloop.configDirectory：缺省让 Maven 输出到 <workspace>/.bloop（与 lspPom 诊断目录一致）。
    const bloopConfigDir = options?.bloopConfigDirectory?.trim();
    // downloadSources：缺省 true，与以往 mvn dependency:sources 行为一致。
    const bloopDownloadSources = options?.bloopDownloadSources !== false;

    // bloop-maven-plugin 片段：声明在 pom.xml 中，bloop:install 生成 .bloop 工程，
    // 并按项目动态生成 bloop.configDirectory / downloadSources。
    // 源码根统一为工作区 src：Bloop 依据 pom 的 <sourceDirectory> 推导源码目录，
    // 不在 bloop 插件上单独设置 sourceDir 覆盖。
    // 版本与 lspPom.ts 保持一致。
    const bloopPluginLines = [
        `            <plugin>`,
        `                <groupId>ch.epfl.scala</groupId>`,
        `                <artifactId>bloop-maven-plugin</artifactId>`,
        `                <version>2.0.4</version>`,
        `                <configuration>`,
    ];
    if (bloopConfigDir) bloopPluginLines.push(`                    <bloop.configDirectory>${escapeXml(bloopConfigDir)}</bloop.configDirectory>`);
    bloopPluginLines.push(`                    <downloadSources>${bloopDownloadSources}</downloadSources>`);
    bloopPluginLines.push(`                    </configuration>`, `            </plugin>`);
    const bloopPluginXml = bloopPluginLines.join('\n');

    // 向 <plugins> 注入 bloop 插件（若模板/硬编码中已有 bloop-maven-plugin 则跳过）。
    const ensureBloopPlugin = (xml: string): string => {
        if (/bloop-maven-plugin/i.test(xml)) return xml;
        // $1 含 <plugins> 及其后换行+缩进；在其后紧跟一个 bloop plugin 的独立行，再保留原有 <plugin>。
        return xml.replace(/(<plugins\b[^>]*>\s*)(<plugin>)/, `$1${bloopPluginXml}\n            $2`);
    };

    // 源码根统一为工作区 src：若 pom 尚未声明 <sourceDirectory>，则注入
    // <build><sourceDirectory>${project.basedir}/src</sourceDirectory></build>，
    // 否则 Maven/Bloop 默认从 src/main/java|scala 找源码而漏掉工作区 src/ 下的包结构。
    const ensureSourceDir = (xml: string): string => {
        if (/<sourceDirectory\b/.test(xml)) return xml;
        const sourceDir = '${project.basedir}/src';
        if (/<build\b/.test(xml)) {
            return xml.replace(/(<build\b[^>]*>)/, `$1\n        <sourceDirectory>${sourceDir}</sourceDirectory>`);
        }
        return xml.replace(/<\/project>\s*$/, `    <build>\n        <sourceDirectory>${sourceDir}</sourceDirectory>\n    </build>\n</project>`);
    };

    // 生成 pom 内容：优先使用设置页模板（占位符替换，与编译路径一致）；
    // 未提供模板时回退到下方 LSP 专用硬编码模板。
    // 源码根统一为 src：两分支生成后统一注入 <sourceDirectory>src</sourceDirectory>。

    let pomContent: string;
    if (options?.pomTemplate?.trim()) {
        pomContent = ensureBloopPlugin(
            options.pomTemplate
                .replace('{group_id}', groupId)
                .replace('{artifact_id}', artifactId)
                .replace('{main_class}', '') // LSP pom 为工作区级，无主类概念；留空不影响 bloop:install
                .replace('{final_name}', artifactId)
                .replace('{scala_version}', scalaVer)
                .replace('{deps}', depsXml.trimEnd())
                .replace('{scala_plugin}', scalaPluginXml.trimEnd()),
        );
        console.log('[ensurePomReady] 使用设置页 pomTemplate 生成 pom（已注入 bloop 或跳过若已存在）');
    } else {
        pomContent = ensureBloopPlugin(`<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <groupId>${groupId}</groupId>
    <artifactId>${artifactId}</artifactId>
    <version>1.0-SNAPSHOT</version>
    <packaging>jar</packaging>

    <properties>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
        <maven.compiler.source>1.8</maven.compiler.source>
        <maven.compiler.target>1.8</maven.compiler.target>
        <scala.version>${scalaVer}</scala.version>
    </properties>

    <dependencies>
${depsXml.trimEnd()}
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>net.alchim31.maven</groupId>
                <artifactId>scala-maven-plugin</artifactId>
                <version>4.8.1</version>
                <executions>
                    <execution>
                        <goals>
                            <goal>compile</goal>
                            <goal>testCompile</goal>
                        </goals>
                    </execution>
                </executions>
                <configuration>
                    <scalaVersion>\${scala.version}</scalaVersion>
                </configuration>
            </plugin>
        </plugins>
    </build>
</project>`);
        console.log('[ensurePomReady] 未提供 pomTemplate，回退到 LSP 硬编码模板');
    }

    // 统一注入 <build><sourceDirectory>src</sourceDirectory></build>（若模板中显式声明则保留）
    pomContent = ensureSourceDir(pomContent);

    const pomStatus = await invoke<{ changed: boolean; bloopReady: boolean }>(
      'write_workspace_pom',
      {
        workspaceRoot,
        pomContent,
      },
    );

    // 复用既有索引：pom 内容未变化且 .bloop 工程配置仍在 → 跳过 mvn bloop:install。
    // 之前每次 app 重启（模块内缓存丢失）都会重跑 Maven（bloop:bloopInstall，数十秒），
    // 且 .bloop 被重建导致 Metals/Bloop 无法复用上一次的导入与 zinc 分析缓存，
    // 悬停要等整个流程重来。比对落在磁盘上，跨 app 重启依然命中，重启后 LSP 秒级就绪、悬停立即可用。
    if (!pomStatus.changed && pomStatus.bloopReady) {
      console.log('[ensurePomReady] pom.xml 与 .bloop 均未变化，跳过 mvn bloop:install（复用既有索引）');
      lastWorkspaceRoot = workspaceRoot;
      return;
    }

    try {
      console.log('[ensurePomReady] 运行 mvn bloop:install...');
      await invoke('run_maven_bloop_install', {
        javaHome,
        mavenHome: mavenHome || '',
        workspaceRoot,
      });
      console.log('[ensurePomReady] mvn bloop:install 成功');
    } catch (bloopErr) {
      console.warn('[ensurePomReady] mvn bloop:install 失败:', bloopErr);
      throw bloopErr;
    }

    lastWorkspaceRoot = workspaceRoot;
  } finally {
    isGenerating = false;
  }
}

export function clearPomCache(): void {
  lastWorkspaceRoot = null;
}
