/** 临时调试：打开基准页，打印页面状态与全部控制台输出 */
import { spawn } from 'node:child_process';
import process from 'node:process';
import WebSocket from 'ws';

const PORT = 9334;
const url = process.argv[2] ?? 'http://127.0.0.1:5173/?page=ai-bench';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proc = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  '--user-data-dir=C:\\Users\\57803\\Desktop\\dataforge\\.edge-debug-profile',
  '--no-first-run', '--disable-gpu', 'about:blank',
], { stdio: 'ignore' });

try {
  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) wsUrl = (await r.json()).webSocketDebuggerUrl; } catch {}
    if (!wsUrl) await sleep(500);
  }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  let id = 0; const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled') {
      console.log('[console:%s]', m.params.type, (m.params.args || []).map(a => a.value ?? a.description ?? a.type).join(' ').slice(0, 300));
    } else if (m.method === 'Runtime.exceptionThrown') {
      console.log('[exception]', (m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? '').slice(0, 800));
    } else if (m.method === 'Log.entryAdded') {
      console.log('[log:%s]', m.params.entry.level, m.params.entry.text.slice(0, 300));
    }
  });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id; pending.set(mid, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
    ws.send(JSON.stringify({ id: mid, method, params }));
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('timeout ' + method)); } }, 60000);
  });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: false });
    if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  };

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Page.navigate', { url });
  await sleep(Number(process.argv[3] ?? 25000));
  console.log('readyState:', await evaluate('document.readyState'));
  console.log('root html len:', await evaluate("document.getElementById('root')?.innerHTML.length ?? -1"));
  console.log('body text:', await evaluate('(document.body?.innerText||"").slice(0,300)'));
  console.log('AI_BENCH:', await evaluate('!!window.__AI_BENCH__'));
  ws.close();
} catch (e) {
  console.error('err', e.message);
} finally {
  proc.kill();
  setTimeout(() => process.exit(0), 300);
}
