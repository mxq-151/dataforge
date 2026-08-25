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
  scalaVersion?: string;
  codeContent: string;
  codeType: 'java' | 'scala';
  filePath: string;
  fileName?: string;
  rootPath?: string;
  dependencies: MavenDependency[];
  pomTemplate?: string;
  workspace?: string;
  projectCode?: string;
  backendHost?: string;
  mavenGroupId?: string;
  mavenArtifactId?: string;
}

export interface CompileResult {
  success: boolean;
  jarPath: string;
  output: string;
  error: string;
  packageName: string;
  className: string;
}


function extractPackageName(code: string): string {
  const match = code.match(/^package\s+([\w.]+)\s*;?\s*$/m);
  return match ? match[1] : 'default';
}

function cleanEnvPath(value: string, prefix: string): string {
  let cleaned = value.trim();
  if (cleaned.startsWith(prefix + '=')) {
    cleaned = cleaned.replace(prefix + '=', '').trim();
  }
  return cleaned;
}

export async function compileJavaScala(req: CompileRequest): Promise<CompileResult> {

  const packageName = extractPackageName(req.codeContent);
  const transformedCode = req.codeContent;

  const javaHome = cleanEnvPath(req.javaHome, 'JAVA_HOME');
  const scalaHome = cleanEnvPath(req.scalaHome, 'SCALA_HOME');
  const mavenHome = cleanEnvPath(req.mavenHome, 'MAVEN_HOME');
  
  let resolvedFileName = req.fileName || '';
  if (!resolvedFileName && req.filePath) {
    resolvedFileName = req.filePath.split(/[/\\]/).pop() || '';
  }
  console.log('[compileService] fileName 解析:', { raw: req.fileName, filePath: req.filePath, resolved: resolvedFileName });

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await invoke<CompileResult>('compile_java_scala', {
      javaHome,
      scalaHome,
      mavenHome,
      codeContent: transformedCode,
      codeType: req.codeType,
      packageName,
      fileName: resolvedFileName,
      filePath: req.filePath || null,
      pomTemplate: req.pomTemplate || null,
      dependencies: req.dependencies.map(d => ({
        groupId: d.groupId,
        artifactId: d.artifactId,
        version: d.version,
        scope: d.scope || 'compile',
        jarPath: d.jarPath || '',
      })),
      cwd: req.workspace || req.rootPath || null,
      backendHost: req.backendHost || null,
      projectCode: req.projectCode || null,
      scalaVersion: req.scalaVersion || null,
      mavenGroupId: req.mavenGroupId || null,
      mavenArtifactId: req.mavenArtifactId || null,
    });
    console.log('[compileService] Rust 后端返回 CompileResult:', {
      success: result.success,
      jarPath: result.jarPath,
      packageName: result.packageName,
      className: result.className,
      hasClassName: !!result.className,
    });
    return {
      success: result.success,
      jarPath: result.jarPath || '',
      output: result.output || '',
      error: result.error || '',
      packageName: result.packageName || packageName,
      className: result.className || 'App',
    };
  } catch (e) {
    let errorMsg = '未知错误';
    if (e instanceof Error) {
      errorMsg = e.message || String(e);
    } else if (typeof e === 'string') {
      errorMsg = e;
    } else if (e && typeof e === 'object') {
      const errObj = e as Record<string, unknown>;
      if (typeof errObj.message === 'string' && errObj.message) {
        errorMsg = errObj.message;
      } else if (typeof errObj.error === 'string' && errObj.error) {
        errorMsg = errObj.error;
      } else if (typeof errObj.stderr === 'string' && errObj.stderr) {
        errorMsg = errObj.stderr;
      } else if (typeof errObj.output === 'string' && errObj.output) {
        errorMsg = errObj.output;
      } else {
        errorMsg = JSON.stringify(e);
      }
    }
    console.error('[compileService] 编译异常详情:', e);
    return {
      success: false,
      jarPath: '',
      output: '',
      error: errorMsg,
      packageName,
      className: 'App',
    };
  }
}
