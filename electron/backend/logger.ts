/**
 * 主进程文件日志。
 *
 * 打包版（尤其 Windows）没有控制台，主进程 console 输出会被直接丢弃，
 * 导致 opencode 等模块的启动/就绪/崩溃日志无法排查。此模块在启动时包装
 * console.log/warn/error，在保留原有终端输出的同时，把日志追加写入
 * userData/logs/main.log，方便用户直接查看。
 */
import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

let logStream: fs.WriteStream | null = null;
let installed = false;

function logFilePath(): string {
  return path.join(app.getPath('userData'), 'logs', 'main.log');
}

/** 懒初始化写流：路径在首次写日志时才解析，避免 app 生命周期时序问题。 */
function ensureStream(): void {
  if (logStream) return;
  try {
    const fp = logFilePath();
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    logStream = fs.createWriteStream(fp, { flags: 'a' });
    logStream.on('error', () => { /* 忽略写日志异常，避免影响主流程 */ });
  } catch {
    /* 忽略 */
  }
}

function stringifyArg(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.stack ?? v.message;
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s;
  } catch {
    return String(v);
  }
}

function writeLine(level: 'log' | 'warn' | 'error', args: unknown[]): void {
  ensureStream();
  if (!logStream) return;
  const ts = new Date().toISOString();
  const msg = args.map(stringifyArg).join(' ');
  logStream.write(`[${ts}] [${level}] [pid:${process.pid}] ${msg}\n`);
}

/** 包装 console 三件套：同时输出到控制台与 userData/logs/main.log。 */
export function installMainLogger(): void {
  if (installed) return;
  installed = true;
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args: unknown[]) => {
    orig.log(...args);
    writeLine('log', args);
  };
  console.warn = (...args: unknown[]) => {
    orig.warn(...args);
    writeLine('warn', args);
  };
  console.error = (...args: unknown[]) => {
    orig.error(...args);
    writeLine('error', args);
  };
}
