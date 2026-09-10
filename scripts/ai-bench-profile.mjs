/**
 * AI 流式渲染性能基准 — V8 CPU Profile 采集脚本
 *
 * 与 ai-bench.mjs 的区别：它只回答「界面卡不卡」（主线程阻塞 / 提交耗时），
 * 本脚本进一步回答「CPU 到底烧在哪个函数的哪一行」。
 *
 * 做法：用 CDP 的 Profiler 域在真实长回复流式场景下抓一份 V8 CPU Profile，
 * 按 (函数名 + 文件 + 行号) 聚合**自身耗时（self time）**，输出 Top-N 热点。
 * 采样器默认 100µs 一次，因此 self time 等价于该函数自身占用的 CPU 时间。
 *
 * 用法：
 *   node scripts/ai-bench-profile.mjs --preset long --out perf/profile-before.json --top 24
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
    out: 'perf/profile.json',
    preset: 'long',
    iterations: 2,
    top: 24,
    typing: true,
    port: 9334,
    profileDir: null,
    browser: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  };
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
    if (v === undefined) continue;
    if (k === 'url') args.url = v;
    else if (k === 'out') args.out = v;
    else if (k === 'preset') args.preset = v;
    else if (k === 'iterations') args.iterations = Number(v);
    else if (k === 'top') args.top = Number(v);
    else if (k === 'typing') args.typing = v !== 'false' && v !== '0';
    else if (k === 'port') args.port = Number(v);
    else if (k === 'profileDir') args.profileDir = v;
    else if (k === 'browser') args.browser = v;
  }
  return args;
}

const args = parseArgs(process.argv);
const T0 = Date.now();
const el = () => ((Date.now() - T0) / 1000).toFixed(1) + 's';
const log = (...m) => console.log(`[ai-profile +${el()}]`, ...m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 最小 CDP 客户端 ──
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
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params?.exceptionDetails;
        this.consoleErrors.push(d?.exception?.description ?? d?.text ?? 'unknown');
      }
    });
  }

  static async attach(wsUrl, timeoutMs = 20000) {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
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
    try { this.ws.close(); } catch { /* ignore */ }
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

// ── CPU Profile 聚合 ──────────────────────────────────────────
//
// V8 profile 结构：
//   nodes: [{ id, callFrame: { functionName, url, lineNumber, columnNumber }, children }]
//   samples: [nodeId, ...]（按采样顺序）
//   timeDeltas: [µs, ...]  samples[i] 对应的采样间隔 = timeDeltas[i]
//
// self time：把第 i 个采样的耗时计入 samples[i] 所属节点。
// total time（含子调用）：沿 parent 链累加。

/** 把 url 归一化成短名，便于阅读 */
function shortUrl(url) {
  if (!url) return '(native)';
  const clean = url.split('?')[0];
  const m = /\/src\/(.*)$/.exec(clean);
  if (m) return 'src/' + m[1];
  if (clean.startsWith('http://127.0.0.1:5173')) return clean.replace('http://127.0.0.1:5173', '');
  if (clean.startsWith('node_modules/.vite/deps/')) return clean.replace('node_modules/.vite/deps/', 'deps/');
  return clean.length > 70 ? '…' + clean.slice(-68) : clean;
}

function aggregateProfile(profile, topN) {
  const nodeById = new Map();
  for (const n of profile.nodes) nodeById.set(n.id, n);

  const parentById = new Map();
  for (const n of profile.nodes) {
    for (const c of n.children ?? []) parentById.set(c, n.id);
  }

  const selfTime = new Map(); // nodeId → µs
  const { samples, timeDeltas } = profile;
  for (let i = 0; i < samples.length; i++) {
    const id = samples[i];
    // V8 用第一个 timeDelta 表示「到第一次采样之前」的耗时，语义上归给 samples[0]
    const dt = timeDeltas[i] ?? 0;
    selfTime.set(id, (selfTime.get(id) ?? 0) + dt);
  }

  // 按「函数 + 文件 + 行」聚合
  const grouped = new Map();
  let totalSelf = 0;
  for (const [id, us] of selfTime) {
    const node = nodeById.get(id);
    if (!node) continue;
    totalSelf += us;
    const cf = node.callFrame;
    const name = cf.functionName || '(anonymous)';
    const file = shortUrl(cf.url);
    const key = `${name}@${file}:${(cf.lineNumber ?? 0) + 1}`;
    const hit = grouped.get(key);
    if (hit) {
      hit.selfUs += us;
      hit.samples += 1;
    } else {
      grouped.set(key, {
        key,
        name,
        file,
        line: (cf.lineNumber ?? 0) + 1,
        selfUs: us,
        samples: 1,
        totalUs: 0,
      });
    }
  }

  // total（含子树）：把自身 self 沿父链上卷
  for (const [id, us] of selfTime) {
    let cur = parentById.get(id);
    const seen = new Set();
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      const node = nodeById.get(cur);
      if (node) {
        const cf = node.callFrame;
        const key = `${cf.functionName || '(anonymous)'}@${shortUrl(cf.url)}:${(cf.lineNumber ?? 0) + 1}`;
        const hit = grouped.get(key);
        if (hit) hit.totalUs += us;
      }
      cur = parentById.get(cur);
    }
  }

  const list = [...grouped.values()]
    .map((g) => ({
      ...g,
      selfMs: Math.round(g.selfUs / 100) / 10,
      totalMs: Math.round(g.totalUs / 100) / 10,
      selfPct: totalSelf > 0 ? Math.round((g.selfUs / totalSelf) * 10000) / 100 : 0,
      selfPctOfWall: 0,
    }))
    .sort((a, b) => b.selfUs - a.selfUs);

  // 按「文件」聚合，便于一眼看出开销集中在哪个模块
  const byFile = new Map();
  for (const g of grouped.values()) {
    const hit = byFile.get(g.file);
    if (hit) hit.selfUs += g.selfUs;
    else byFile.set(g.file, { file: g.file, selfUs: g.selfUs });
  }
  const files = [...byFile.values()]
    .map((f) => ({
      ...f,
      selfMs: Math.round(f.selfUs / 100) / 10,
      selfPct: totalSelf > 0 ? Math.round((f.selfUs / totalSelf) * 10000) / 100 : 0,
    }))
    .sort((a, b) => b.selfUs - a.selfUs)
    .slice(0, 14);

  // ── 应用代码 inclusive 归因 ──
  // 我们的组件（src/**）自身耗时往往不大，真正的开销发生在它们调用的
  // React / react-markdown 内部。所以按「应用函数」聚合**子树总耗时**
  // （self + 所有后代），才能看清「哪个组件负责的渲染最贵」。
  const appNodes = profile.nodes.filter((n) => /\/src\//.test(n.callFrame.url || ''));
  const childrenOf = new Map();
  for (const n of profile.nodes) childrenOf.set(n.id, n.children ?? []);

  // 后序累加子树 self 之和，避免对每个节点重复 DFS
  const subtreeSelf = new Map();
  const stack = [...appNodes];
  // 先用一次全树后序遍历算出每个节点的子树 self 总和
  const postOrder = [];
  (function dfs(id) {
    postOrder.push(id);
    for (const c of childrenOf.get(id) ?? []) dfs(c);
  })(profile.nodes[0].id);
  for (let i = postOrder.length - 1; i >= 0; i--) {
    const id = postOrder[i];
    let acc = selfTime.get(id) ?? 0;
    for (const c of childrenOf.get(id) ?? []) acc += subtreeSelf.get(c) ?? 0;
    subtreeSelf.set(id, acc);
  }

  const appAgg = new Map();
  for (const n of appNodes) {
    const cf = n.callFrame;
    const key = `${cf.functionName || '(anonymous)'}@${shortUrl(cf.url)}:${(cf.lineNumber ?? 0) + 1}`;
    const inc = subtreeSelf.get(n.id) ?? 0;
    const hit = appAgg.get(key);
    if (hit) {
      hit.inclusiveUs += inc;
      hit.instances += 1;
    } else {
      appAgg.set(key, {
        key,
        name: cf.functionName || '(anonymous)',
        file: shortUrl(cf.url),
        line: (cf.lineNumber ?? 0) + 1,
        inclusiveUs: inc,
        instances: 1,
      });
    }
  }
  const appFrames = [...appAgg.values()]
    .map((a) => ({
      ...a,
      inclusiveMs: Math.round(a.inclusiveUs / 100) / 10,
      inclusivePct: totalSelf > 0 ? Math.round((a.inclusiveUs / totalSelf) * 10000) / 100 : 0,
    }))
    .sort((a, b) => b.inclusiveUs - a.inclusiveUs)
    .slice(0, topN);

  return {
    totalSelfMs: Math.round(totalSelf / 100) / 10,
    top: list.slice(0, topN),
    files,
    appFrames,
    allGrouped: list,
  };
}

async function main() {
  const profileDir = args.profileDir ?? resolve(process.cwd(), '.chrome-profile-bench');
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
      } catch { /* 启动中 */ }
      if (!wsUrl) await sleep(500);
    }
    if (!wsUrl) throw new Error('无法获取 DevTools 端点');

    const targets = await (await fetch(`http://127.0.0.1:${args.port}/json/list`)).json();
    const page = targets.find((t) => t.type === 'page');
    cdp = await Cdp.attach(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Profiler.enable');

    log('打开基准页...');
    await cdp.send('Page.navigate', { url: args.url });

    const readyDeadline = Date.now() + 240000;
    let ready = false;
    while (Date.now() < readyDeadline) {
      try {
        ready = await cdp.evaluate('!!(window.__AI_BENCH__ && window.__AI_BENCH__.ready)', false);
      } catch { /* 导航中 */ }
      if (ready) break;
      await sleep(1000);
    }
    if (!ready) throw new Error('基准页未在 240s 内就绪');
    log('基准页就绪，等待预热...');
    await sleep(8000);

    // V8 采样间隔 100µs；同时采集采样点的时间戳（精确到 µs）便于按窗口切分
    await cdp.send('Profiler.setSamplingInterval', { interval: 100 });

    const rounds = [];
    const rawProfiles = [];
    for (let i = 0; i < args.iterations; i++) {
      log(`[${i + 1}/${args.iterations}] 采集中（preset=${args.preset}）...`);
      await cdp.send('Profiler.start');
      const result = await cdp.evaluate(
        `window.__AI_BENCH__.run({ preset: ${JSON.stringify(args.preset)}, typing: ${args.typing} })`,
      );
      const { profile } = await cdp.send('Profiler.stop');
      rawProfiles.push(profile);
      const agg = aggregateProfile(profile, args.top);
      rounds.push({
        iteration: i + 1,
        wallMs: result.wallMs,
        blockedMs: result.heartbeat.blockedMs,
        aiCommitCount: result.commits['ai-timeline']?.count ?? 0,
        aiCommitTotalMs: result.commits['ai-timeline']?.total ?? 0,
        editorCommitCount: result.commits['editor-area']?.count ?? 0,
        totalSelfMs: agg.totalSelfMs,
        top: agg.top,
        files: agg.files,
        appFrames: agg.appFrames,
      });
      log(
        `  ⟶ wall=${result.wallMs}ms 阻塞=${result.heartbeat.blockedMs}ms ` +
          `AI提交=${result.commits['ai-timeline']?.count ?? 0}次/${result.commits['ai-timeline']?.total ?? 0}ms ` +
          `采样总时长=${agg.totalSelfMs}ms`,
      );
      log(`  Top5 自耗时：`);
      for (const t of agg.top.slice(0, 5)) {
        log(`    ${t.selfMs}ms (${t.selfPct}%)  ${t.name}  ${t.file}:${t.line}`);
      }
      await sleep(1500);
    }

    // 取采样总时长中位数那一次作为代表
    const sorted = [...rounds].sort((a, b) => a.totalSelfMs - b.totalSelfMs);
    const representative = sorted[Math.floor(sorted.length / 2)];

    const rawPath = args.out.replace(/\.json$/, '.raw.json');
    await mkdir(dirname(resolve(process.cwd(), rawPath)), { recursive: true });
    await writeFile(resolve(process.cwd(), rawPath), JSON.stringify(rawProfiles), 'utf8');

    const out = {
      meta: {
        generatedAt: new Date().toISOString(),
        url: args.url,
        preset: args.preset,
        typing: args.typing,
        iterations: args.iterations,
        userAgent: await cdp.evaluate('navigator.userAgent', false),
        note: 'selfMs = V8 采样器归因到该函数的自身 CPU 时间（100µs 采样间隔）',
      },
      rounds,
      representative,
      consoleErrors: cdp.consoleErrors.slice(0, 20),
    };

    const outPath = resolve(process.cwd(), args.out);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(out, null, 2), 'utf8');
    log(`CPU Profile 已写入 ${outPath}`);

    // ── 控制台摘要 ──
    console.log('\n================ 代表轮次 CPU 热点 Top ' + args.top + ' ================');
    console.log(`采样窗口总 CPU：${representative.totalSelfMs}ms（wall=${representative.wallMs}ms）`);
    for (const t of representative.top) {
      console.log(
        `  ${String(t.selfMs).padStart(8)}ms  ${String(t.selfPct).padStart(6)}%  ${t.name}  ${t.file}:${t.line}`,
      );
    }
    console.log('\n================ 按文件聚合 ================');
    for (const f of representative.files) {
      console.log(`  ${String(f.selfMs).padStart(8)}ms  ${String(f.selfPct).padStart(6)}%  ${f.file}`);
    }
    console.log('\n================ 应用代码（src/**）子树耗时 Top ' + args.top + ' ================');
    for (const a of representative.appFrames) {
      console.log(
        `  ${String(a.inclusiveMs).padStart(8)}ms  ${String(a.inclusivePct).padStart(6)}%  ${a.name}  ${a.file}:${a.line}  (×${a.instances})`,
      );
    }
  } finally {
    cdp?.close();
    browser.kill();
    await sleep(500);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[ai-profile] 失败:', err.message);
    process.exit(1);
  });
