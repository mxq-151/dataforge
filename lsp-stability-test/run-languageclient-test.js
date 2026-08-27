#!/usr/bin/env node
/**
 * METALS LSP 服务稳定性测试 —— 复用 DataForge 的 languageClient 稳定化方案。
 *
 * 与 run-stability-test.js 的不同：后者在每个采样点「发送一次裸 hover」后直接判定；
 * 本脚本在每个采样点模拟 DataForge 的一次用户悬停手势——即复用 DataForge 在
 * languageClient.ts provideHover 中使用的 stabilizeIncompleteResult（递增退避重试），
 * 若首轮 hover 不完整则持续重试，最终返回该手势的最佳结果再判定。
 *
 * 判定规则（悬停目标 = SparkSession）：
 *   - SUCCESS：文本包含 "The entry point to programming"（完整 scaladoc）
 *   - COLD_SIG / EMPTY / OTHER / ERROR：失败
 * 既生成本方案（稳定化）的判定，也生成对照（裸 hover 一次）判定，便于对比。
 *
 * 用法：与 run-stability-test.js 相同（ROUNDS / DELAYS / WORKSPACE / DEBUG）。
 */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// DataForge languageClient 稳定化逻辑（transplant，与 src/services/lsp/stabilizeHover.ts 一致）
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

// ---------------------------------------------------------------------------
// 配置（与 run-stability-test.js 对齐）
// ---------------------------------------------------------------------------
const ROOT = path.resolve(__dirname, '..');
const METALS_JAR = process.env.METALS_JAR || path.join(ROOT, 'resources', 'metals', 'metals.jar');
const WORKSPACE = process.env.WORKSPACE || path.resolve(__dirname);
const JAVA_HOME = process.env.JAVA_HOME || '';
const JAVA_BIN = JAVA_HOME ? path.join(JAVA_HOME, 'bin', 'java') : 'java';

const ROUNDS = Number(process.env.ROUNDS || 3);
const DELAYS_MS = (process.env.DELAYS || '1000,2000,3000,5000,8000')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter(Number.isFinite);
const HOVER_POLL_INTERVAL = Number(process.env.HOVER_POLL_INTERVAL || 700);
const READY_TIMEOUT = Number(process.env.READY_TIMEOUT || 300000);
const DEBUG = process.env.DEBUG === '1';
// DataForge provideHover 稳定化实际使用的参数
const STAB_DELAYS = [300, 600, 1000, 1500];
const STAB_NO_PROGRESS = 2;
const STAB_SETTLE = 1000;

const HOVER_URI = `file://${WORKSPACE.replace(/ /g, '%20')}/src/main/scala/com/dataforge/SparkDemo.scala`;
const HOVER_POS = { line: 15, character: 15 };
const FILE_CONTENT = fs.readFileSync(
  path.join(WORKSPACE, 'src', 'main', 'scala', 'com', 'dataforge', 'SparkDemo.scala'),
  'utf8',
);
const SUCCESS_MARKER = 'The entry point to programming';
const COLD_SIG = 'object org.apache.spark.sql.SparkSession';

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
  push(chunk) {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
  }
  extract() {
    for (;;) {
      const headerEnd = this.buf.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        if (this.buf.length > 64 * 1024) this.buf = Buffer.alloc(0);
        return null;
      }
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
    : Array.isArray(contents)
      ? contents.map(hoverValue)
      : [hoverValue(contents)];
  return parts.join('\n').trim();
}
function classify(text) {
  if (!text) return 'EMPTY';
  if (text.includes(SUCCESS_MARKER)) return 'SUCCESS';
  if (text === COLD_SIG) return 'COLD_SIG';
  if (text.includes('SparkSession') && !text.includes('The entry point')) return 'COLD_SIG';
  return 'OTHER';
}
const FAIL_VERDICTS = new Set(['EMPTY', 'COLD_SIG', 'OTHER']);

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

function launchMetals() {
  const proc = spawn(JAVA_BIN, [...METALS_JVM_ARGS, '-jar', METALS_JAR], {
    cwd: WORKSPACE,
    env: {
      ...process.env,
      JAVA_HOME: JAVA_HOME || undefined,
      COURSIER_REPOSITORIES: 'maven-local|ivy2-local|https://repo1.maven.org/maven2',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const parser = new LspParser();
  const pending = new Map();
  let nextId = 1;
  const log = [];
  const stderrLines = [];
  let stderrTail = [];

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
      } else {
        resp.result = null;
      }
    } catch (e) {
      resp.error = { code: -32603, message: String(e) };
    }
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
        if (p) {
          pending.delete(msg.id);
          if (msg.error) p.reject(new Error(`LSP 错误 ${msg.error.code}: ${msg.error.message}`));
          else p.resolve(msg.result);
        }
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
      stderrLines.push(line);
      stderrTail.push(line);
      if (stderrTail.length > 30) stderrTail.shift();
    }
  });
  proc.on('error', (e) => {
    for (const p of [...pending.values()]) p.reject(e);
    pending.clear();
  });

  let onImportLine;

  return {
    proc, sendNotify, sendRequest, getLog: () => log, getStderrTail: () => stderrTail,
    setOnImportLine: (fn) => { onImportLine = fn; },
    isAlive: () => proc.exitCode === null && !proc.killed,
  };
}

async function runOneRound(round) {
  const meta = { round, startedAt: new Date().toISOString(), delays: DELAYS_MS, samples: [], errors: [] };
  const sess = launchMetals();
  try {
    const initParams = {
      processId: process.pid,
      rootUri: `file://${WORKSPACE}`,
      capabilities: {
        workspace: { workspaceFolders: true },
        textDocument: { hover: { dynamicRegistration: true, contentFormat: ['markdown', 'plaintext'] } },
      },
      initializationOptions: {
        mavenSupport: true, metricEnabled: false, decorationProvider: false,
        inlineDecorationProvider: false, isHttpEnabled: false,
        showInferredType: true, showImplicitArguments: false,
      },
      workspaceFolders: [{ uri: `file://${WORKSPACE}`, name: 'workspace' }],
    };
    await sess.sendRequest('initialize', initParams);
    await sess.sendNotify('initialized', {});

    await sess.sendNotify('textDocument/didOpen', {
      textDocument: { uri: HOVER_URI, languageId: 'scala', version: 1, text: FILE_CONTENT },
    });

    // 等待 build import（信号 + 兜底超时），随后重新 didOpen 强制绑定 spark-demo target
    const importSignal = new Promise((resolve) => {
      sess.setOnImportLine((m) => {
        if (m === 'metals/didChangeBuildTargets') resolve();
      });
    });
    await Promise.race([importSignal, delay(25000)]);
    await delay(1500);
    await sess.sendNotify('textDocument/didOpen', {
      textDocument: { uri: HOVER_URI, languageId: 'scala', version: 2, text: FILE_CONTENT },
    });

    // 就绪：首次非空 hover
    let readyAt = null;
    const readyDeadline = Date.now() + READY_TIMEOUT;
    while (Date.now() < readyDeadline) {
      if (!sess.isAlive()) throw new Error('Metals 进程已退出');
      try {
        const h = await sess.sendRequest('textDocument/hover', {
          textDocument: { uri: HOVER_URI }, position: HOVER_POS,
        });
        if (hoverToText(h && h.contents)) { readyAt = Date.now(); break; }
      } catch { /* 未就绪 */ }
      await delay(HOVER_POLL_INTERVAL);
    }
    if (readyAt === null) throw new Error(`就绪超时（${READY_TIMEOUT}ms）`);

    // 采样：每个延迟点同时评估「裸 hover」与「DataForge 稳定化手势」
    for (const dMs of DELAYS_MS) {
      await delay(Math.max(0, readyAt + dMs - Date.now()));
      const s = { delayMs: dMs, raw: null, stab: null };
      const uri = HOVER_URI, pos = HOVER_POS;
      const rawRequest = async () => {
        try { return await sess.sendRequest('textDocument/hover', { textDocument: { uri }, position: pos }); }
        catch (e) { throw e; }
      };

      // 裸 hover（单次请求）
      const t0 = Date.now();
      try {
        const h = await rawRequest();
        s.raw = { verdict: classify(hoverToText(h && h.contents)), text: hoverToText(h && h.contents), latencyMs: Date.now() - t0 };
      } catch (e) { s.raw = { verdict: 'ERROR', error: e.message }; }

      // DataForge 稳定化手势（retry until complete）
      const t1 = Date.now();
      try {
        const initial = await rawRequest();
        const stabilized = await stabilizeIncompleteResult(
          initial, rawRequest, hoverContentLen, hoverIsComplete,
          STAB_DELAYS, STAB_NO_PROGRESS, STAB_SETTLE,
        );
        const text = hoverToText(stabilized && stabilized.contents);
        s.stab = { verdict: classify(text), text, latencyMs: Date.now() - t1, retried: initial !== stabilized };
      } catch (e) { s.stab = { verdict: 'ERROR', error: e.message }; }

      if (s.stab.verdict === 'ERROR' || FAIL_VERDICTS.has(s.stab.verdict)) {
        meta.errors.push(`round=${round} delay=${dMs}ms (stable) => ${s.stab.verdict}`);
      }
      if (s.raw.verdict === 'ERROR' || FAIL_VERDICTS.has(s.raw.verdict)) {
        meta.errors.push(`round=${round} delay=${dMs}ms (raw) => ${s.raw.verdict}`);
      }
      meta.samples.push(s);
      if (DEBUG) {
        console.log(`\n  [debug] delay=${dMs}ms raw=${s.raw.verdict} | stab=${s.stab.verdict}${s.stab.retried ? ' (retried)' : ''}`);
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
    default: return v;
  }
}

async function main() {
  console.log('==========================================================');
  console.log('METALS LSP 稳定性测试 —— 复用 DataForge languageClient 稳定化方案');
  console.log(`  Metals jar : ${METALS_JAR}`);
  console.log(`  Workspace  : ${WORKSPACE}`);
  console.log(`  目标符号   : org.apache.spark.sql.SparkSession @${HOVER_POS.line}:${HOVER_POS.character}`);
  console.log(`  成功标记   : "${SUCCESS_MARKER}"`);
  console.log(`  轮数       : ${ROUNDS}`);
  console.log(`  采样延迟   : ${DELAYS_MS.map((d) => d + 'ms').join(' / ')}`);
  console.log(`  稳定化参数 : delays=${JSON.stringify(STAB_DELAYS)} noProgress=${STAB_NO_PROGRESS} settle=${STAB_SETTLE}ms`);
  console.log('==========================================================');

  const allErrors = [];
  const allSamples = [];
  const byDelayStab = {}; const byDelayRaw = {};

  for (let r = 1; r <= ROUNDS; r++) {
    process.stdout.write(`\n[round ${r}/${ROUNDS}] 等待 Metals 就绪并采样...`);
    let meta;
    try {
      meta = await runOneRound(r);
    } catch (e) {
      allErrors.push(`[round ${r}] 执行失败: ${e.message}`);
      console.log(`\n[round ${r}] 执行失败: ${e.message}`);
      continue;
    }
    allSamples.push(...meta.samples.map((s) => ({ round: r, ...s })));
    console.log(`\n[round ${r}] 就绪完成`);
    console.log('   延迟    | 裸hover          | 稳定化(DataForge)');
    for (const s of meta.samples) {
      const rawPrev = (s.raw.text || s.raw.error || '').replace(/\n/g, ' ').slice(0, 40);
      const stabPrev = (s.stab.text || s.stab.error || '').replace(/\n/g, ' ').slice(0, 40);
      const rawT = s.raw.latencyMs != null ? `[${s.raw.latencyMs}ms]` : '';
      const stabT = s.stab.latencyMs != null ? `[${s.stab.latencyMs}ms]${s.stab.retried ? '+r' : ''}` : '';
      console.log(`   ${String(s.delayMs).padEnd(7)} | ${fmtVerdict(s.raw.verdict).padEnd(14)} ${rawT} | ${fmtVerdict(s.stab.verdict).padEnd(14)} ${stabT}  ${stabPrev}`);
      if (!byDelayStab[s.delayMs]) { byDelayStab[s.delayMs] = []; byDelayRaw[s.delayMs] = []; }
      byDelayStab[s.delayMs].push(s.stab.verdict);
      byDelayRaw[s.delayMs].push(s.raw.verdict);
    }
    if (meta.errors.length) allErrors.push(...meta.errors);
  }

  console.log('\n==========================================================');
  console.log('汇总（多轮）');
  const stabAll = allSamples.map((s) => s.stab.verdict);
  const rawAll = allSamples.map((s) => s.raw.verdict);
  const cnt = (arr, v) => arr.filter((x) => x === v).length;
  console.log(`  采样总数          : ${stabAll.length}`);
  console.log(`  稳定化(DataForge)  : SUCCESS=${cnt(stabAll, 'SUCCESS')}  失败=${stabAll.length - cnt(stabAll, 'SUCCESS')}`);
  console.log(`  裸 hover(对照)    : SUCCESS=${cnt(rawAll, 'SUCCESS')}  失败=${rawAll.length - cnt(rawAll, 'SUCCESS')}`);
  console.log('  按延迟统计:');
  for (const d of DELAYS_MS) {
    const ss = byDelayStab[d] || []; const rs = byDelayRaw[d] || [];
    console.log(`    ${String(d).padEnd(6)}ms: 稳定化 ${cnt(ss, 'SUCCESS')}/${ss.length}  裸hover ${cnt(rs, 'SUCCESS')}/${rs.length}`);
  }
  console.log('\n  测试报错（errors）:');
  if (allErrors.length === 0) console.log('    （无）');
  else for (const e of allErrors) console.log(`    - ${e}`);
  console.log('==========================================================\n');

  const out = path.join(WORKSPACE, `languageclient-stability-report-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify({
    mode: 'DataForge languageClient 稳定化方案', successMarker: SUCCESS_MARKER,
    stabParams: { delays: STAB_DELAYS, noProgressLim: STAB_NO_PROGRESS, settleTime: STAB_SETTLE },
    allErrors, allSamples,
  }, null, 2));
  console.log(`详细报告已写入: ${out}`);

  process.exit(cnt(stabAll, 'SUCCESS') < stabAll.length ? 1 : 0);
}

main().catch((e) => { console.error('\n[测试主流程异常]', e); process.exit(2); });