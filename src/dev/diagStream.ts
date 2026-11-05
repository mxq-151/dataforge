/**
 * diagStream — 临时诊断：把渲染进程 console 输出落到磁盘。
 *
 * 背景：数据探索「智能体回复不上屏」需要还原「连接/订阅目录」的先后顺序，
 * 但渲染进程日志只进 DevTools，不落盘（main.log 只有 sidecar 日志）。
 * 本模块拦截 console，把关键行写进固定文件，便于事后读盘分析。
 *
 * 仅 DEV 生效。排查结束后：删掉本文件 + main.tsx 里的一行 import 即可。
 */

const ENABLED = import.meta.env.DEV;
const FILE = '/tmp/dataforge-renderer.log';

/** 只保留与「连接 / 订阅 / 目录」相关的行，避免流式日志把文件撑爆 */
const KEEP = [
  '[OC][debug]',
  '[agent-events]',
  '[agent-client]',
  '[main]',
  '[datadiag]',
];

let installed = false;
let lines: string[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let writing = false;
let dirty = false;

function ts(): string {
  const d = new Date();
  return (
    String(d.getHours()).padStart(2, '0') + ':' +
    String(d.getMinutes()).padStart(2, '0') + ':' +
    String(d.getSeconds()).padStart(2, '0') + '.' +
    String(d.getMilliseconds()).padStart(3, '0')
  );
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function push(text: string): void {
  // 单行限长，避免巨大对象把文件写爆
  lines.push(`[${ts()}] ${text.slice(0, 600)}`);
  if (lines.length > 4000) lines = lines.slice(-3000);
  dirty = true;
  schedule();
}

function schedule(): void {
  if (timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, 400);
}

async function flush(): Promise<void> {
  if (!dirty || writing) return;
  writing = true;
  dirty = false;
  const payload = lines.join('\n') + '\n';
  try {
    const { writeFile } = await import('../bridge/fs');
    const bytes = new TextEncoder().encode(payload);
    await writeFile(FILE, bytes);
  } catch {
    /* 写盘失败不影响主流程 */
  } finally {
    writing = false;
    if (dirty) schedule();
  }
}

export function installDiagStream(): void {
  if (!ENABLED || installed) return;
  installed = true;

  lines.push(`[${ts()}] [datadiag] ==== 渲染进程诊断日志开始 (${location.href}) ====`);

  const wrap = (
    orig: (...a: unknown[]) => void,
    level: 'log' | 'warn' | 'error',
  ) => {
    return (...args: unknown[]) => {
      try {
        const text = args.map(stringify).join(' ');
        const interesting =
          level !== 'log' || KEEP.some((k) => text.includes(k));
        if (interesting) push(`[${level}] ${text}`);
      } catch {
        /* ignore */
      }
      try {
        orig.apply(console, args as never[]);
      } catch {
        /* ignore */
      }
    };
  };

  console.log = wrap(console.log.bind(console), 'log');
  console.warn = wrap(console.warn.bind(console), 'warn');
  console.error = wrap(console.error.bind(console), 'error');

  window.addEventListener('pagehide', () => { void flush(); });
  window.addEventListener('beforeunload', () => { void flush(); });

  push('[datadiag] 探针已安装，日志文件: /tmp/dataforge-renderer.log');
}
