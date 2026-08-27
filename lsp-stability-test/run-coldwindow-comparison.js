#!/usr/bin/env node
/**
 * METALS LSP 稳定性测试 —— 冷窗口（相对 didOpen 采样）复现真实 app 场景。
 *
 * 与 run-languageclient-test.js 的区别：后者在「就绪（=就绪轮询已焐热目标符号）」
 * 之后采样，掩盖了冷窗口失败。本脚本去掉就绪预处理，从 didOpen 起按绝对值采样，
 * 以复现用户在文件刚打开时的真实 hover 成功率。
 *
 * 两个模式（通过 MODE 选择，默认 B）：
 *   MODE=A  仅稳定化：每个采样点 = stabilizeIncompleteResult（递增退避重试）
 *   MODE=B  A + DataForge 完整预热三件套：
 *              - registerScalaHoverWarmup：didOpen 后 2s 踢醒 PC；6s 后依次 hover 前 15 个
 *                大写符号（间隔 300ms）；对未拿到文档的符号 4s/8s/12s 重试
 *              - scheduleHoverPositionWarmup：用户 hover 失败后 0/4/8/12s 后台补拉该位置
 *
 * 判定规则（悬停目标 = SparkSession）：SUCCESS = 文本包含 "The entry point to programming"，
 * 否则 COLD_SIG / EMPTY / OTHER / ERROR 均为失败。
 */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// DataForge 稳定化 + 完整性判定（transplant，与 src/services/lsp/stabilizeHover.ts 一致）
// ---------------------------------------------------------------------------
const hoverValue = (x) => (typeof x === 'string' ? x : (x?.value ?? ''));
function hoverContentLen(h) {
  if (!h?.contents) return 0;
  const c = h.contents;
  if (typeof c === 'string') return c.length;
  if (Array.isArray(c)) return c.reduce((n, x) => n + hoverValue(x).length, 0);
  return hoverValue(c).length;
}
function hoverIsComplete(h) {
  if (!h?.contents) return false;
  const c = h.contents;
  const texts = typeof c === 'string' ? [c] : Array.isArray(c) ? c.map(hoverValue) : [hoverValue(c)];
  return texts.some((v) => v.length >= 60 && v.includes('\n'));
}
async function stabilizeIncompleteResult(initial, request, contentLen, isComplete, delays, noProgressLim = 2, settleTime = 5000) {
  if (initial && isComplete(initial)) return initial;
  let result = initial;
  let lastLen = result ? contentLen(result) : 0;
  let noProgressStreak = 0;
  let elapsed = 0;
  for (const delay of delays) {
    await new Promise((res) => setTimeout(res, delay));
    elapsed += delay;
    const retried = await Promise.resolve(request()).catch(() => null);
    if (retried == null) continue;
    const len = contentLen(retried);
    if (isComplete(retried)) { result = retried; break; }
    if (len > lastLen) { result = retried; lastLen = len; noProgressStreak = 0; }
    else {
      noProgressStreak++;
      if (noProgressStreak >= noProgressLim && elapsed >= settleTime) break;
    }
  }
  return result;
}
const SUCCESS_MARKER = 'The entry point to programming';
const COLD_SIG = 'object org.apache.spark.sql.SparkSession';
function classify(text) {
  if (!text) return 'EMPTY';
  if (text.includes(SUCCESS_MARKER)) return 'SUCCESS';
  if (text === COLD_SIG) return 'COLD_SIG';
  if (text.includes('SparkSession') && !text.includes('The entry point')) return 'COLD_SIG';
  return 'OTHER';
}
const FAIL_VERDICTS = new Set(['EMPTY', 'COLD_SIG', 'OTHER']);

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
const ROOT = path.resolve(__dirname, '..');
const METALS_JAR = process.env.METALS_JAR || path.join(ROOT, 'resources', 'metals', 'metals.jar');
const WORKSPACE = process.env.WORKSPACE || path.resolve(__dirname);
const JAVA_HOME = process.env.JAVA_HOME || '';
const JAVA_BIN = JAVA_HOME ? path.join(JAVA_HOME, 'bin', 'java') : 'java';
const ROUNDS = Number(process.env.ROUNDS || 3);
// 冷窗口采样：相对首个 didOpen 的毫秒点
const SAMPLES_MS = (process.env.SAMPLES || '0,1000,2000,3000,5000')
  .split(',').map((s) => Number(s.trim())).filter(Number.isFinite);
const MODE = (process.env.MODE || 'B').toUpperCase();
const DEBUG = process.env.DEBUG === '1';
const COLD_TIMEOUT = Number(process.env.COLD_TIMEOUT || 300000);
const STAB_DELAYS = [300, 600, 1000, 1500];
const STAB_NO_PROGRESS = 2;
const STAB_SETTLE = 1000;

const SRC_FILE = path.join(WORKSPACE, 'src', 'main', 'scala', 'com', 'dataforge', 'SparkDemo.scala');
const HOVER_URI = `file://${WORKSPACE.replace(/ /g, '%20')}/src/main/scala/com/dataforge/SparkDemo.scala`;
const HOVER_POS = { line: 15, character: 15 };
const FILE_CONTENT = fs.readFileSync(SRC_FILE, 'utf8');

const METALS_JVM_ARGS = [
  '-Xmx1G', '-XX:+UseG1GC', '-XX:+UseStringDeduplication', '-Xss4m', '-Xms100m',
  '--add-exports', 'jdk.compiler/com.sun.tools.javac.api=ALL-UNNAMED',
  '--add-exports', 'jdk.compiler/com.sun.tools.javac.file=ALL-UNNAMED',
  '--add-exports', 'jdk.compiler/com.sun.tools.javac.main=ALL-UNNAMED',
  '--add-exports', 'jdk.compiler/com.sun.tools.javac.model=ALL-UNNAMED',
  '--add-exports', 'jdk.compiler/com.sun.tools.javac.parser=ALL-UNNAMED',
  '--add-exports', 'jdk.compiler/com.sun.tools.javac.tree=ALL-UNNAMED',
  '--add-exports', 'jdk.compiler/com.sun.tools.javac.util=ALL-UNNAMED',
  '--add-exports', 'jdk.compiler/com.sun.tools.javac.code=ALL-UNNAMED',
  '--add-exports', 'jdk.compiler/com.sun.tools.javac.comp=ALL-UNNAMED',
  '--add-exports', 'jdk.compiler/com.sun.tools.javac.jvm=ALL-UNNAMED',
];

// ---------------------------------------------------------------------------
// stdio 分帧 + JSON-RPC
// ---------------------------------------------------------------------------
class LspParser {
  constructor() { this.buf = Buffer.alloc(0); }
  push(chunk) { this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]); }
  extract() {
    for (;;) {
      const headerEnd = this.buf.indexOf('\r\n\r\n');
      if (headerEnd === -1) { if (this.buf.length > 64 * 1024) this.buf = Buffer.alloc(0); return null; }
      const header = this.buf.subarray(0, headerEnd).toString('utf8');
      const m = header.match(/Content-Length:\s*(\d+)/i);
      if (!m) { this.buf = this.buf.subarray(headerEnd + 4); continue; }
      const len = parseInt(m[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.buf.length < bodyStart + len) return null;
      const body = this.buf.subarray(bodyStart, bodyStart + len).toString('utf8');
      this.buf = this.buf.subarray(bodyStart + len);
      return body;
    }
  }
}
function hoverToText(contents) {
  if (contents == null) return '';
  const parts = typeof contents === 'string'
    ? [contents]
    : Array.isArray(contents) ? contents.map(hoverValue) : [hoverValue(contents)];
  return parts.join('\n').trim();
}
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

function launchMetals() {
  const proc = spawn(JAVA_BIN, [...METALS_JVM_ARGS, '-jar', METALS_JAR], {
    cwd: WORKSPACE,
    env: { ...process.env, JAVA_HOME: JAVA_HOME || undefined,
      COURSIER_REPOSITORIES: 'maven-local|ivy2-local|https://repo1.maven.org/maven2' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const parser = new LspParser();
  const pending = new Map();
  let nextId = 1;
  const stderrLines = [];
  let stderrTail = [];
  let onImportLine;
  const frame = (o) =>
    Buffer.from(`Content-Length: ${Buffer.byteLength(JSON.stringify(o), 'utf8')}\r\n\r\n${JSON.stringify(o)}`, 'utf8');
  const sendNotify = (method, params = {}) => {
    if (!proc.stdin.writable) return Promise.reject(new Error('stdin 已关闭'));
    proc.stdin.write(frame({ jsonrpc: '2.0', method, params }));
    return Promise.resolve();
  };
  const sendRequest = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      try { proc.stdin.write(frame({ jsonrpc: '2.0', id, method, params })); }
      catch (e) { pending.delete(id); reject(e); }
    });
  function autoAnswer(id, method, params) {
    const resp = { jsonrpc: '2.0', id };
    try {
      if (method === 'window/showMessageRequest') {
        const actions = (params && params.actions) || [];
        const imp = actions.find((a) => /import/i.test(a.title || ''));
        resp.result = (imp || actions[0] || { id: null }).id ?? null;
      } else if (method === 'metals/quickPick') {
        const items = (params && params.items) || [];
        const m = items.find((i) => /(bloop|maven)/i.test(i.label || ''));
        resp.result = { id: (m || items[0] || {}).id ?? null };
      } else resp.result = null;
    } catch (e) { resp.error = { code: -32603, message: String(e) }; }
    proc.stdin.write(frame(resp));
  }
  proc.stdout.on('data', (d) => {
    parser.push(d);
    let raw;
    while ((raw = parser.extract()) !== null) {
      let msg;
      try { msg = JSON.parse(raw); } catch { continue; }
      const isResponse = msg.id !== undefined && msg.method === undefined;
      if (isResponse) {
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); if (msg.error) p.reject(new Error(`LSP 错误 ${msg.error.code}: ${msg.error.message}`)); else p.resolve(msg.result); }
        continue;
      }
      if (msg.method === undefined) continue;
      const method = msg.method;
      if (msg.id !== undefined) { autoAnswer(msg.id, method, msg.params); continue; }
      if (typeof onImportLine === 'function') onImportLine(method, msg.params);
    }
  });
  proc.stderr.on('data', (d) => {
    for (const line of d.toString('utf8').split('\n')) {
      if (!line) continue;
      stderrLines.push(line); stderrTail.push(line);
      if (stderrTail.length > 30) stderrTail.shift();
    }
  });
  proc.on('error', (e) => { for (const p of [...pending.values()]) p.reject(e); pending.clear(); });
  return { proc, sendNotify, sendRequest, setOnImportLine: (fn) => { onImportLine = fn; },
    getStderrTail: () => stderrTail, getStderr: () => stderrLines, isAlive: () => proc.exitCode === null && !proc.killed };
}

// ---------------------------------------------------------------------------
// DataForge 预热 + 补拉三件套（transplant，与 languageClient.ts 一致）
// ---------------------------------------------------------------------------
// 每个预热/补拉定时器都需要能拿到最新的 sendRequest，通过 holder 间接引用。
/**
 * 返回一个 { warm, scheduleHoverWarmup }：依赖外部传入的按需 closure 发送 hover。
 * @param {() => Promise<any>} sendHoverFn 返回 hover 结果（或 null）
 * @param {string} uri 预热只针对该文档（真实 app 为当前打开的 scala 文件）
 */
function createWarmupSystem(sendHoverFn, rawUri) {
  const warmupDoneUris = new Set();
  const scheduled = new Map(); // key -> 是否已安排
  const cooldownAt = new Map(); // key -> 上次补拉时间
  const HOVER_WARMUP_COOLDOWN = 60000;

  // 从文本提取前 maxCount 个大写开头的标识符位置
  const findSymbolPositions = () => {
    const positions = [];
    const seen = new Set();
    const re = /\b([A-Z][A-Za-z0-9_]*)\b/g;
    let m;
    while ((m = re.exec(FILE_CONTENT)) !== null && positions.length < 15) {
      const name = m[1];
      if (seen.has(name)) continue;
      seen.add(name);
      const offset = m.index;
      let line = 0, col = 0;
      for (let i = 0; i < offset; i++) { if (FILE_CONTENT[i] === '\n') { line++; col = 0; } else col++; }
      positions.push({ line, character: col });
    }
    return positions;
  };

  // 发送一次 hover，返回是否拿到文档（长度>60）
  const sendHover = async (pos) => {
    try {
      const r = await sendHoverFn(pos);
      const hasDoc = r?.contents && (typeof r.contents === 'string'
        ? r.contents.length > 60
        : Array.isArray(r.contents)
          ? r.contents.some((c) => (typeof c === 'string' ? c : c?.value)?.length > 60)
          : r.contents?.value?.length > 60);
      return hasDoc;
    } catch { return false; }
  };

  // 单个符号带重试预热：首次失败后 [4s,8s,12s] 重试，最多 3 次
  const warmupSymbolWithRetry = (pos, attempt = 0) => {
    const delays = [0, 4000, 8000, 12000];
    const d = delays[attempt] ?? 0;
    setTimeout(() => {
      if (!scheduled.has(keyOf(pos)) && attempt > 0) { /* 已被单次调度，继续 */ }
      sendHover(pos).then((ok) => { if (!ok && attempt < 3) warmupSymbolWithRetry(pos, attempt + 1); });
    }, d);
  };
  const keyOf = (pos) => `${pos.line}:${pos.character}`;

  // 打开文档时的三波预热
  const registerScalaHoverWarmup = () => {
    if (warmupDoneUris.has(rawUri)) return;
    warmupDoneUris.add(rawUri);
    const positions = findSymbolPositions();
    if (positions.length === 0) return;
    // 第 1 波：2s 踢醒 PC（不重试，交给第 2 波）
    setTimeout(() => { sendHover(positions[0]); }, 2000);
    // 第 2 波：6s 依次发前 15 个符号（间隔 300ms），对失败符号做第 3 波重试
    setTimeout(() => {
      let chain = Promise.resolve();
      const failed = [];
      positions.forEach((pos, i) => {
        chain = chain.then(() => sendHover(pos).then((ok) => {
          if (!ok) failed.push(pos);
          if (i === positions.length - 1) failed.forEach((p) => warmupSymbolWithRetry(p, 0));
          return new Promise((res) => setTimeout(res, 300));
        }));
      });
    }, 6000);
  };

  // 用户 hover 失败后安排后台补拉（0/4/8/12s，冷却 60s）
  const scheduleHoverPositionWarmup = (pos) => {
    const key = keyOf(pos);
    const last = cooldownAt.get(key);
    if (last !== undefined && Date.now() - last < HOVER_WARMUP_COOLDOWN) return;
    cooldownAt.set(key, Date.now());
    if (!scheduled.has(key)) { scheduled.set(key, true); warmupSymbolWithRetry(pos, 0); }
  };

  return { registerScalaHoverWarmup, scheduleHoverPositionWarmup, findSymbolPositions };
}

async function runOneRound(round) {
  const meta = { round, mode: MODE, startedAt: new Date().toISOString(), samples: [], errors: [] };
  const sess = launchMetals();
  let warmup;
  try {
    const initParams = {
      processId: process.pid, rootUri: `file://${WORKSPACE}`,
      capabilities: { workspace: { workspaceFolders: true },
        textDocument: { hover: { dynamicRegistration: true, contentFormat: ['markdown', 'plaintext'] } } },
      initializationOptions: { mavenSupport: true, metricEnabled: false, decorationProvider: false,
        inlineDecorationProvider: false, isHttpEnabled: false, showInferredType: true, showImplicitArguments: false },
      workspaceFolders: [{ uri: `file://${WORKSPACE}`, name: 'workspace' }],
    };
    await sess.sendRequest('initialize', initParams);
    await sess.sendNotify('initialized', {});

    // 预热系统依赖能随时发 hover（非阻塞，后台定时器调用）
    const sendHoverFn = (pos) => sess.sendRequest('textDocument/hover', {
      textDocument: { uri: HOVER_URI }, position: pos,
    }).catch(() => null);
    warmup = createWarmupSystem(sendHoverFn, HOVER_URI);

    // 首个 didOpen 触发 build import
    await sess.sendNotify('textDocument/didOpen', {
      textDocument: { uri: HOVER_URI, languageId: 'scala', version: 1, text: FILE_CONTENT },
    });

    // 等 import 完成 + 缓冲，确保已绑定正确 build target
    const importSignal = new Promise((resolve) => {
      sess.setOnImportLine((m) => { if (m === 'metals/didChangeBuildTargets') resolve(); });
    });
    await Promise.race([importSignal, delay(30000)]);
    await delay(1000);

    // 重新 didOpen(v2) 强制把文档绑定到 spark-demo target（冷窗口真正起点 t0）
    await sess.sendNotify('textDocument/didOpen', {
      textDocument: { uri: HOVER_URI, languageId: 'scala', version: 2, text: FILE_CONTENT },
    });
    if (MODE === 'B') warmup.registerScalaHoverWarmup();
    const didOpenAt = Date.now();

    // 冷窗口采样：在绑定后的 didOpen 绝对时刻直接 hover（不做就绪轮询）
    for (let i = 0; i < SAMPLES_MS.length; i++) {
      const sms = SAMPLES_MS[i];
      const targetAt = didOpenAt + sms;
      await delay(Math.max(0, targetAt - Date.now()));
      if (!sess.isAlive()) throw new Error('Metals 进程已退出');
      const s = { sampleMs: sms, raw: null, stab: null, full: null };
      const pos = HOVER_POS;
      const rawRequest = () => sess.sendRequest('textDocument/hover', { textDocument: { uri: HOVER_URI }, position: pos })
        .then((r) => r, (e) => { throw e; });

      // 裸 hover（一次）
      const t0 = Date.now();
      try { const h = await rawRequest(); s.raw = { verdict: classify(hoverToText(h && h.contents)), text: hoverToText(h && h.contents), latencyMs: Date.now() - t0 }; }
      catch (e) { s.raw = { verdict: 'ERROR', error: e.message }; }

      // 稳定化手势（方案 A 的判定源）
      const t1 = Date.now();
      try {
        const initial = await rawRequest();
        const stabilized = await stabilizeIncompleteResult(initial, rawRequest, hoverContentLen, hoverIsComplete, STAB_DELAYS, STAB_NO_PROGRESS, STAB_SETTLE);
        const text = hoverToText(stabilized && stabilized.contents);
        s.stab = { verdict: classify(text), text, latencyMs: Date.now() - t1 };
      } catch (e) { s.stab = { verdict: 'ERROR', error: e.message }; }
      // 若仍不完整且 MODE=B，安排后台补拉（影响后续采样点，模拟真实 app）
      if (MODE === 'B') {
        const t2 = Date.now();
        try {
          const initial = await rawRequest();
          const full = await stabilizeIncompleteResult(initial, rawRequest, hoverContentLen, hoverIsComplete, STAB_DELAYS, STAB_NO_PROGRESS, STAB_SETTLE);
          const text = hoverToText(full && full.contents);
          s.full = { verdict: classify(text), text, latencyMs: Date.now() - t2 };
          if (!hoverIsComplete(full)) warmup.scheduleHoverPositionWarmup(pos);
        } catch (e) { s.full = { verdict: 'ERROR', error: e.message }; }
      }
      meta.samples.push(s);
      if (DEBUG) console.log(`  [debug] t=+${sms}ms raw=${s.raw.verdict} | stab=${s.stab.verdict}${MODE === 'B' ? ` | full=${s.full.verdict}` : ''}`);
    }
    await delay(500);

    for (const s of meta.samples) {
      const verdicts = [s.stab, s.full ?? s.stab];
      if (verdicts.some((v) => v && (v.verdict === 'ERROR' || FAIL_VERDICTS.has(v.verdict)))) {
        meta.errors.push(`round=${round} t=+${s.sampleMs}ms mode=${MODE} => ${verdicts.map((v) => v && v.verdict).join('/')}`);
      }
    }
    return meta;
  } finally {
    try { await sess.sendNotify('shutdown'); } catch {}
    try { sess.proc.kill('SIGKILL'); } catch {}
    await delay(300);
  }
}

function fmtVerdict(v) {
  switch (v) {
    case 'SUCCESS': return 'SUCCESS';
    case 'COLD_SIG': return 'FAIL(冷签名)';
    case 'EMPTY': return 'FAIL(空)';
    case 'OTHER': return 'FAIL(其它)';
    case 'ERROR': return 'FAIL(请求错误)';
    default: return 'FAIL';
  }
}

async function main() {
  console.log('==========================================================');
  console.log(`METALS LSP 稳定性测试 —— 冷窗口复现 (MODE=${MODE})`);
  console.log(`  Metals jar : ${METALS_JAR}`);
  console.log(`  目标符号   : SparkSession @${HOVER_POS.line}:${HOVER_POS.character}`);
  console.log(`  成功标记   : "${SUCCESS_MARKER}"`);
  console.log(`  轮数       : ${ROUNDS}`);
  console.log(`  采样点(didOpen后ms) : ${SAMPLES_MS.join(' / ')}`);
  console.log(`  方案       : ${MODE === 'A'
    ? 'A：仅稳定化（stabilizeIncompleteResult）'
    : 'A：仅稳定化 + B：完整预热三件套'} `);
  console.log('==========================================================');

  const allErrors = [];
  const allSamples = [];
  const rawByMs = {}; const stabByMs = {}; const fullByMs = {};

  for (let r = 1; r <= ROUNDS; r++) {
    process.stdout.write(`\n[round ${r}/${ROUNDS}] 冷窗口采样...`);
    let meta;
    try { meta = await runOneRound(r); }
    catch (e) { allErrors.push(`[round ${r}] 执行失败: ${e.message}`); console.log(`\n[round ${r}] 执行失败: ${e.message}`); continue; }
    allSamples.push(...meta.samples.map((s) => ({ round: r, ...s })));
    console.log('');
    console.log(`  t(didOpen后) | 裸hover        | 稳定化        ${MODE === 'B' ? '| 完整方案' : ''}`);
    for (const s of meta.samples) {
      const rawV = fmtVerdict(s.raw.verdict);
      const stabV = fmtVerdict(s.stab.verdict);
      const row = `   ${String(s.sampleMs).padEnd(11)} | ${rawV.padEnd(14)} | ${stabV.padEnd(14)}`;
      if (MODE === 'B') { row + (s.full ? ` | ${fmtVerdict(s.full.verdict).padEnd(14)}` : ''); }
      console.log(MODE === 'B'
        ? `${row} | ${fmtVerdict(s.full ? s.full.verdict : 'EMPTY').padEnd(12)}`
        : row);
      if (!rawByMs[s.sampleMs]) { rawByMs[s.sampleMs] = []; stabByMs[s.sampleMs] = []; fullByMs[s.sampleMs] = []; }
      rawByMs[s.sampleMs].push(s.raw.verdict);
      stabByMs[s.sampleMs].push(s.stab.verdict);
      if (s.full) fullByMs[s.sampleMs].push(s.full.verdict);
    }
    if (meta.errors.length) allErrors.push(...meta.errors);
  }

  const cnt = (arr, v) => (arr || []).filter((x) => x === v).length;
  const total = allSamples.length;
  console.log('\n==========================================================');
  console.log('汇总（多轮）');
  console.log(`  采样总数 : ${total}`);
  console.log(`  裸 hover   : SUCCESS=${cnt(allSamples.map((s) => s.raw.verdict), 'SUCCESS')}/${total}`);
  console.log(`  仅稳定化   : SUCCESS=${cnt(allSamples.map((s) => s.stab.verdict), 'SUCCESS')}/${total}`);
  if (MODE === 'B') console.log(`  完整方案   : SUCCESS=${cnt(allSamples.map((s) => s.full && s.full.verdict), 'SUCCESS')}/${total}`);
  console.log('  按采样时刻统计:');
  for (const ms of SAMPLES_MS) {
    const line = `    +${String(ms).padEnd(6)}ms: 裸hover ${cnt(rawByMs[ms], 'SUCCESS')}/${rawByMs[ms].length}  稳定化 ${cnt(stabByMs[ms], 'SUCCESS')}/${stabByMs[ms].length}`;
    console.log(MODE === 'B' ? `${line}  完整方案 ${cnt(fullByMs[ms], 'SUCCESS')}/${fullByMs[ms].length}` : line);
  }
  console.log('\n  测试报错（errors）:');
  if (allErrors.length === 0) console.log('    （无）');
  else for (const e of allErrors) console.log(`    - ${e}`);
  console.log('==========================================================\n');

  const out = path.join(WORKSPACE, `coldwindow-mode-${MODE}-report-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify({ mode: MODE, successMarker: SUCCESS_MARKER, allErrors, allSamples }, null, 2));
  console.log(`详细报告已写入: ${out}`);
  process.exit(0);
}

main().catch((e) => { console.error('\n[测试主流程异常]', e); process.exit(2); });