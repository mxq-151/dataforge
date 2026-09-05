/**
 * CDP 可行性快速验证：启动 Edge headless，连接并求值 1+1。
 * 仅用于确认 scripts/ai-bench.mjs 的运行前置条件（浏览器 + CDP + ws）是否具备。
 */
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9333;
const userDataDir = 'C:\\Users\\57803\\Desktop\\dataforge\\.edge-bench-profile';

const proc = spawn(EDGE, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${userDataDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  'about:blank',
], { stdio: 'ignore', detached: false });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) {
        const json = await res.json();
        if (json.webSocketDebuggerUrl) return json.webSocketDebuggerUrl;
      }
    } catch {}
    await sleep(500);
  }
  throw new Error('无法连接 DevTools 端点');
}

try {
  const wsUrl = await getWsUrl();
  console.log('DevTools:', wsUrl);

  const listRes = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const targets = await listRes.json();
  const page = targets.find((t) => t.type === 'page');
  console.log('page target:', page?.url);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
    ws.send(JSON.stringify({ id: mid, method, params }));
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('timeout ' + method)); } }, 20000);
  });

  await send('Runtime.enable');
  const r = await send('Runtime.evaluate', { expression: '1+1', returnByValue: true });
  console.log('eval 1+1 =', r.result?.value);

  const nav = await send('Page.enable');
  await send('Page.navigate', { url: 'data:text/html,<h1 id=t>hello</h1>' });
  await sleep(1500);
  const r2 = await send('Runtime.evaluate', { expression: 'document.getElementById("t").textContent', returnByValue: true });
  console.log('dom read =', r2.result?.value);

  const r3 = await send('Runtime.evaluate', {
    expression: `(() => { const t0=performance.now(); let s=0; for(let i=0;i<3e6;i++) s+=i; return { ms: performance.now()-t0, s }; })()`,
    returnByValue: true,
  });
  console.log('cpu bench =', JSON.stringify(r3.result?.value));

  ws.close();
  console.log('CDP 可行性验证通过');
} catch (e) {
  console.error('失败:', e.message);
  process.exitCode = 1;
} finally {
  proc.kill();
  setTimeout(() => process.exit(process.exitCode ?? 0), 300);
}
