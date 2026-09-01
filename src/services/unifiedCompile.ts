import { compileJavaScala, type CompileResult, type MavenDependency } from './compileService';
import { fetchDependencyList, type DependencyRecord } from '../api/dependency';
import { fetchProjectConfigByFilePath } from '../api/devProject';
import type { SavedConfig } from '../utils/schedulerMapping';
import { mergeDependencyNames, type DependencyItemLite } from '../utils/dependencyMerge';
import { getBaseName } from '../utils/pathUtils';
import { getApiHost } from '../api/index';

export interface UnifiedCompileOptions {
  projectId: number;
  projectCode?: string;
  filePath: string;
  codeContent: string;
  rootPath?: string;
  envConfig: {
    javaHome: string;
    scalaHome: string;
    mavenHome: string;
    scalaVersion?: string;
    pomTemplate?: string;
    workspace?: string;
    mavenGroupId?: string;
    mavenArtifactId?: string;
  };
  savedConfig?: SavedConfig | null;
  /** 项目级依赖（作为默认依赖集合），与逐文件依赖合并后参与编译 */
  projectDependencies?: DependencyItemLite[];
}

export async function unifiedCompile(options: UnifiedCompileOptions): Promise<CompileResult> {
  const {
    projectId,
    projectCode,
    filePath,
    codeContent,
    rootPath,
    envConfig,
    savedConfig,
    projectDependencies,
  } = options;

  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const codeType = ext === 'scala' ? 'scala' : 'java';

  const fileName = getBaseName(filePath);

  let mavenDependencies: MavenDependency[] = [];
  try {
    const depRes = await fetchDependencyList();
    const depRecords: DependencyRecord[] = depRes?.data?.records || [];

    const autoChooseDeps = depRecords.filter(d => d.autoChoose === 1);

    // 项目级依赖作为默认集合，与逐文件依赖（savedConfig）合并；同名按集合去重，
    // 逐文件依赖在合并后可覆盖/追加项目级依赖。最终自动包含 autoChoose 依赖。
    const fileDepNames = (savedConfig?.dependencies || [])
      .filter(d => d.name)
      .map(d => d.name);
    const configuredDepNames = mergeDependencyNames(
      projectDependencies || [],
      fileDepNames.map(n => ({ id: n, name: n }))
    );

    if (configuredDepNames.length === 0 && projectId && filePath) {
      try {
        const relativePathForDep = rootPath && filePath.startsWith(rootPath + '/')
          ? filePath.slice(rootPath.length + 1)
          : filePath;
        const configRes = await fetchProjectConfigByFilePath(projectId, relativePathForDep);
        if (configRes.code === 200 && configRes.data?.jarDependencyCatalogs?.length) {
          // 后端返回 DevJarDependency 对象数组，取 artifactId || jarName 作为依赖名
          for (const dep of configRes.data.jarDependencyCatalogs) {
            const name = dep.artifactId || dep.jarName;
            if (name) configuredDepNames.push(name);
          }
        }
      } catch {
        console.warn('[unifiedCompile] 从后端获取配置参数失败');
      }
    }

    const allDepNames = new Set([...configuredDepNames]);
    autoChooseDeps.forEach(d => {
      allDepNames.add(d.artifactId || d.jarName);
    });

    if (allDepNames.size > 0) {
      mavenDependencies = depRecords
        .filter(d => allDepNames.has(d.artifactId) || allDepNames.has(d.jarName))
        .map(d => ({
          groupId: d.groupId || '',
          artifactId: d.artifactId || '',
          version: d.version || '',
          scope: d.scope || 'compile',
          jarPath: d.jarPath || '',
        }));

      const uniqueMap = new Map<string, MavenDependency>();
      mavenDependencies.forEach(d => {
        const key = `${d.groupId}:${d.artifactId}`;
        if (!uniqueMap.has(key)) uniqueMap.set(key, d);
      });
      mavenDependencies = Array.from(uniqueMap.values());
    }
  } catch (err) {
    console.warn('[unifiedCompile] 获取依赖列表失败:', err);
  }

  return compileJavaScala({
    javaHome: envConfig.javaHome,
    scalaHome: envConfig.scalaHome,
    mavenHome: envConfig.mavenHome,
    scalaVersion: envConfig.scalaVersion || undefined,
    codeContent,
    codeType,
    filePath,
    fileName,
    rootPath,
    dependencies: mavenDependencies,
    pomTemplate: envConfig.pomTemplate || undefined,
    workspace: envConfig.workspace || undefined,
    projectCode: projectCode || undefined,
    backendHost: getApiHost(),
    mavenGroupId: envConfig.mavenGroupId || undefined,
    mavenArtifactId: envConfig.mavenArtifactId || undefined,
  });
}
