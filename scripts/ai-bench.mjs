/**
 * AI 流式渲染性能基准 — CDP 驱动脚本
 *
 * 用真实 Chromium（Edge headless）打开 vite 开发服务器的 ?page=ai-bench 基准页，
 * 调用页面内暴露的 window.__AI_BENCH__ 跑合成流式场景，采集指标后落盘 JSON。
 *
 * 用法：
 *   node scripts/ai-bench.mjs --out perf/before.json --presets medium,long --iterations 3
 *
 * 前置条件：vite 开发服务器已在 5173 端口运行（npm run dev:renderer）。
 */

import { spawn } from 'node:child_process';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import WebSocket from 'ws';

// ── 参数解析 ──
function parseArgs(argv) {
  const args = {
    url: 'http://127.0.0.1:5173/bench.html',
    out: 'perf/bench.json',
    iterations: 3,
    presets: 'medium,long',
    port: 9333,
    readyTimeoutMs: 240000,
    profileDir: null,
    browser: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  };
  // 同时支持 --key=value 与 --key value
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    let k = token.replace(/^--/, '');
    let v;
    const eq = k.indexOf('=');
    if (eq >= 0) {
      v = k.slice(eq + 1);
      k = k.slice(0, eq);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      v = argv[++i];
    }
    if (k === 'url') args.url = v;
    else if (k === 'out') args.out = v;
    else if (k === 'iterations') args.iterations = Number(v);
    else if (k === 'presets') args.presets = v;
    else if (k === 'port') args.port = Number(v);
    else if (k === 'readyTimeoutMs') args.readyTimeoutMs = Number(v);
    else if (k === 'profileDir') args.profileDir = v;
    else if (k === 'browser') args.browser = v;
    else console.warn(`[ai-bench] 忽略未知参数 --${k}`);
  }
  for (const numKey of ['iterations', 'port', 'readyTimeoutMs']) {
    if (!Number.isFinite(args[numKey])) throw new Error(`参数 --${numKey} 必须是数字，当前值: ${args[numKey]}`);
  }
  return args;
}

const args = parseArgs(process.argv);
const T0 = Date.now();
const el = () => ((Date.now() - T0) / 1000).toFixed(1) + 's';
const log = (...m) => console.log(`[ai-bench +${el()}]`, ...m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── CDP 客户端 ──
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.consoleErrors = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method === 'Runtime.consoleAPICalled') {
        const type = msg.params?.type;
        if (type === 'error') {
          const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
          this.consoleErrors.push(text);
        }
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params?.exceptionDetails;
        this.consoleErrors.push(d?.exception?.description ?? d?.text ?? 'unknown exception');
      }
    });
  }

  static async attach(wsUrl, timeoutMs = 20000) {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    await new Promise((res, rej) => {
      ws.on('open', res);
      ws.on('error', rej);
      setTimeout(() => rej(new Error('WebSocket 连接超时')), timeoutMs);
    });
    return new Cdp(ws);
  }

  send(method, params = {}, timeoutMs = 600000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, timeoutMs);
    });
  }

  async evaluate(expression, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      allowUnsafeEvalBlockedByCSP: true,
    });
    if (r.exceptionDetails) {
      throw new Error('页面求值异常: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    }
    return r.result?.value;
  }

  close() {
    try {
      this.ws.close();
    } catch { /* ignore */ }
  }
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'GET' });
      if (res.ok) return true;
    } catch { /* 服务器尚未就绪 */ }
    await sleep(1000);
  }
  return false;
}

function medianBy(values, pick) {
  const sorted = [...values].sort((a, b) => pick(a) - pick(b));
  return sorted[Math.floor(sorted.length / 2)];
}

async function main() {
  const profileDir = args.profileDir ?? resolve(process.cwd(), '.edge-bench-profile');
  // 每次用全新 profile，避免缓存/扩展影响测量
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});

  log(`目标页面: ${args.url}`);
  const ok = await waitForServer(args.url, 300000);
  if (!ok) throw new Error('开发服务器未就绪，请先运行 npm run dev:renderer');

  const browser = spawn(
    args.browser,
    [
      '--headless=new',
      `--remote-debugging-port=${args.port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--window-size=1600,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let cdp;
  try {
    const versionUrl = `http://127.0.0.1:${args.port}/json/version`;
    let wsUrl = null;
    for (let i = 0; i < 60 && !wsUrl; i++) {
      try {
        const res = await fetch(versionUrl);
        if (res.ok) wsUrl = (await res.json()).webSocketDebuggerUrl;
      } catch { /* 浏览器启动中 */ }
      if (!wsUrl) await sleep(500);
    }
    if (!wsUrl) throw new Error('无法获取 DevTools 端点');

    const listRes = await fetch(`http://127.0.0.1:${args.port}/json/list`);
    const targets = await listRes.json();
    const page = targets.find((t) => t.type === 'page');
    cdp = await Cdp.attach(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    log('打开基准页...');
    await cdp.send('Page.navigate', { url: args.url });

    // ── 等待基准页就绪（monaco-vscode-api 运行时启动较慢）──
    const readyDeadline = Date.now() + args.readyTimeoutMs;
    let ready = false;
    while (Date.now() < readyDeadline) {
      try {
        ready = await cdp.evaluate('!!(window.__AI_BENCH__ && window.__AI_BENCH__.ready)', false);
      } catch { /* 页面导航中，忽略求值异常 */ }
      if (ready) break;
      await sleep(1000);
    }
    if (!ready) {
      const dump = await cdp
        .evaluate(
          'JSON.stringify({ state: document.readyState, text: (document.body?.innerText || "").slice(0, 400), err: window.__AI_BENCH_ERROR__ || null })',
          false,
        )
        .catch(() => 'n/a');
      throw new Error(`基准页未在 ${args.readyTimeoutMs}ms 内就绪，页面状态: ${dump}\n控制台错误: ${cdp.consoleErrors.slice(0, 10).join(' | ')}`);
    }
    log('基准页就绪');

    // 首屏加载完成后静默一段时间，避开模块编译 / TextMate 预热（约 2-3s）/ Monaco 首次布局等噪声
    await sleep(8000);

    const report = {
      meta: {
        generatedAt: new Date().toISOString(),
        url: args.url,
        browser: args.browser,
        userAgent: await cdp.evaluate('navigator.userAgent', false),
        iterations: args.iterations,
        note: '主线程阻塞 = 8ms 心跳定时器的累计延迟；提交耗时来自 React Profiler',
      },
      presets: {},
      consoleErrors: [],
    };

    // ── 空闲基线 ──
    log('采集空闲基线...');
    report.idleBaseline = await cdp.evaluate('window.__AI_BENCH__.idleBaseline(2500)');

    // ── 各场景 ──
    const presetList = args.presets.split(',').map((s) => s.trim()).filter(Boolean);
    for (const preset of presetList) {
      const runs = [];
      for (let i = 0; i < args.iterations; i++) {
        const result = await cdp.evaluate(
          `window.__AI_BENCH__.run({ preset: ${JSON.stringify(preset)} })`,
        );
        log(
          `[${preset} ${i + 1}/${args.iterations}] wall=${result.wallMs}ms 阻塞=${result.heartbeat.blockedMs}ms ` +
            `长任务=${result.longTask.count} AI提交=${result.commits['ai-timeline']?.count ?? 0}次/${result.commits['ai-timeline']?.total ?? 0}ms ` +
            `编辑器提交=${result.commits['editor-area']?.count ?? 0}次 输入延迟p95=${result.editorTyping.p95}ms`,
        );
        runs.push(result);
        await sleep(1200);
      }
      const med = medianBy(runs, (r) => r.heartbeat.blockedMs);
      report.presets[preset] = { median: med, runs };
    }

    report.consoleErrors = cdp.consoleErrors.slice(0, 50);

    const outPath = resolve(process.cwd(), args.out);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
    log(`报告已写入 ${outPath}`);
  } finally {
    cdp?.close();
    browser.kill();
    await sleep(500);
  }
}

main()
  .then(() => {
    // 明确退出：Windows 下 Edge 子进程可能残留句柄导致 Node 不自动退出
    process.exit(0);
  })
  .catch((err) => {
    console.error('[ai-bench] 失败:', err.message);
    process.exit(1);
  });
