/**
 * 本地运行（仅 Java / Scala）：spawn `java -cp <编译产物>:<依赖jar> 主类 参数`，
 * 流式回传 stdout/stderr 到渲染层，支持中途取消。
 *
 * classpath 的依赖部分通过 `mvn dependency:build-classpath` 从编译产物所在
 * build 目录的 pom.xml 解析（本地 m2 中的绝对路径），因此无需额外打包 fat jar。
 * 依赖解析失败不阻断运行（自包含/无外部依赖的程序仍可执行），仅回传告警。
 */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { isWindows, resolveMvnBin, runMvn } from './maven';
import { emitToRenderer, getMainWindow } from '../eventBus';

export interface LocalRunRequest {
  javaHome: string;
  mavenHome: string;
  jarPath: string;
  mainClass: string;
  args?: string[];
  /** JVM 参数（如 -Xmx1g），插在 java 与 -cp 之间 */
  vmArgs?: string[];
}

const running = new Map<string, ChildProcess>();
let sessionSeq = 0;

function emit(channel: string, payload: unknown): void {
  emitToRenderer(getMainWindow(), channel, payload);
}

export async function runLocalJava(req: LocalRunRequest): Promise<{ sessionId: string }> {
  const javaHome = (req.javaHome || '').trim();
  if (!javaHome) throw new Error('JAVA_HOME 未配置，请在设置页面配置 JAVA_HOME');
  if (!fs.existsSync(javaHome)) throw new Error(`JAVA_HOME 目录不存在: ${javaHome}`);

  const jarPath = path.resolve(req.jarPath || '');
  if (!fs.existsSync(jarPath)) throw new Error(`编译产物 JAR 不存在: ${jarPath}`);

  // jarPath 形如 {buildDir}/target/{finalName}.jar，向上两级即 build 目录（含 pom.xml）
  const buildDir = path.dirname(path.dirname(jarPath));
  const pomPath = path.join(buildDir, 'pom.xml');

  // 1) 解析运行期依赖 classpath（m2 本地绝对路径）
  const cpEntries: string[] = [];
  if (fs.existsSync(pomPath)) {
    try {
      const mvnBin = resolveMvnBin(req.mavenHome || '');
      const r = await runMvn(
        mvnBin,
        ['-q', 'dependency:build-classpath', '-Dmdep.outputFile=cp-localrun.txt', '-DincludeScope=runtime'],
        buildDir,
        { JAVA_HOME: javaHome },
      );
      const cpOut = path.join(buildDir, 'cp-localrun.txt');
      if (r.code === 0 && fs.existsSync(cpOut)) {
        const cp = (await fsp.readFile(cpOut, 'utf8')).trim();
        if (cp) cpEntries.push(...cp.split(path.delimiter).filter(Boolean));
      } else {
        emit('local-run-status', { type: 'warn', message: `依赖 classpath 解析失败，可能缺少外部依赖：${(r.stderr || r.stdout || '').slice(0, 400)}` });
      }
    } catch (e) {
      emit('local-run-status', { type: 'warn', message: `依赖 classpath 解析失败：${e instanceof Error ? e.message : String(e)}` });
    }
  }

  // 2) 组装并运行 java -cp
  const javaBin = path.join(javaHome, 'bin', `java${isWindows ? '.exe' : ''}`);
  if (!fs.existsSync(javaBin)) throw new Error(`未找到 java 可执行文件: ${javaBin}`);

  const classpath = [jarPath, ...cpEntries].join(path.delimiter);
  const launchArgs = [...(req.vmArgs ?? []), '-cp', classpath, req.mainClass, ...(req.args ?? [])];

  const sessionId = `localrun_${Date.now()}_${++sessionSeq}`;
  const proc = spawn(javaBin, launchArgs, {
    cwd: buildDir,
    env: { ...process.env, JAVA_HOME: javaHome },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.set(sessionId, proc);

  emit('local-run-started', { sessionId });
  const collect = (chunk: Buffer): void => {
    const text = chunk.toString('utf8');
    if (text) emit('local-run-log', { sessionId, text });
  };
  proc.stdout.on('data', collect);
  proc.stderr.on('data', collect);
  proc.on('error', (err) => {
    running.delete(sessionId);
    emit('local-run-status', { type: 'error', sessionId, message: String(err) });
  });
  proc.on('close', (code, signal) => {
    running.delete(sessionId);
    emit('local-run-exit', { sessionId, code: code ?? (signal ? -1 : -1) });
  });

  return { sessionId };
}

export function abortLocalRun(sessionId: string): void {
  const proc = running.get(sessionId);
  if (proc) {
    proc.kill();
    running.delete(sessionId);
  }
}