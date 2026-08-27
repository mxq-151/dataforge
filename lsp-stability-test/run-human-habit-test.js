#!/usr/bin/env node
/**
 * METALS LSP 稳定性测试 —— 人类操作习惯模式，验证 languageClient.ts 的真实成功率。
 *
 * 与其它脚本的区别：本脚本**完整移植** languageClient.ts provideHover 的决策流
 * （绑定感知等待 + 自动重绑 + 稳定化 + 冷签名强制重绑 + 后台补拉），并按人类真实
 * 操作习惯采样：
 *
 *   人类打开 Spark 文件后，通常会在 build import 尚未完成时就移动鼠标悬停符号
 *   （尤其 SparkSession 这类依赖类）。此时 `buildTargetsReady=false`，provideHover
 *   会先限时等待（≤2000ms）build 就绪信号，就绪后再自动 didOpen 重绑文档再请求；
 *   若稳定化后仍是「未绑定冷签名」，则强制重绑后重试一次；都拿不到文档时再安排后台补拉。
 *
 * 采样点（相对首个 didOpen）模拟人类动作序列：
 *   - 打开后 ~0.8s  立即悬停（build 通常未就绪 → 触发绑定等待）     → 目标 A
 *   - 打开后 ~2.5s  继续悬停（可能仍在绑定窗口）                    → 目标 A
 *   - 打开后 ~5s    再次悬停                                        → 目标 A
 *   - 打开后 ~9s    鼠标移开再移回，重新悬停同一符号（吃预热/补拉）  → 目标 A
 *   - 打开后 ~15s   再次悬停                                        → 目标 A
 *
 * 每个样本都走完整的 provideHover 流程（含阻塞式绑定等待），判定
 * SUCCESS = 返回含 "The entry point to programming" 的完整 scaladoc。
 *
 * 用法：
 *   node run-human-habit-test.js
 *   ROUNDS=3 SAMPLES=800,2500,5000,9000,15000 node run-human-habit-test.js
 *   METALS_JAR=... JAVA_HOME=... WORKSPACE=... node run-human-habit-test.js
 */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
const ROOT = path.resolve(__dirname, '..');
const METALS_JAR = process.env.METALS_JAR || path.join(ROOT, 'resources', 'metals', 'metals.jar');
const WORKSPACE = process.env.WORKSPACE || path.resolve(__dirname);
const JAVA_HOME = process.env.JAVA_HOME || '';
const JAVA_BIN = JAVA_HOME ? path.join(JAVA_HOME, 'bin', 'java') : 'java';
const ROUNDS = Number(process.env.ROUNDS || 3);
// 人类操作采样点：相对「第一个 didOpen」（= 用户打开文件）的毫秒时刻。
// 前两个点通常落在 build import 完成前，用于复现「打开就悬停」的绑定等待路径。
const SAMPLES_MS = (process.env.SAMPLES || '800,2500,5000,9000,15000')
  .split(',').map((s) => Number(s.trim())).filter(Number.isFinite);
const DEBUG = process.env.DEBUG === '1';
// 恢复探测超时：单轮有界，避免 didChangeBuildTargets 信号不可靠造成长时间空等
const COLD_TIMEOUT = Number(process.env.COLD_TIMEOUT || 60000);
// 恢复阶段轮询间隔
const RECOVERY_POLL_MS = Number(process.env.RECOVERY_POLL_MS || 5000);

// 目标符号：SparkSession（依赖类，成功标记固定）
const HOVER_URI = `file://${WORKSPACE.replace(/ /g, '%20')}/src/main/scala/com/dataforge/SparkDemo.scala`;
// SparkSession：file 第 16 行（0-based=15）的"SparkSession"类型名起始
const HOVER_POS = { line: 15, character: 15 };
const SRC_FILE = path.join(WORKSPACE, 'src', 'main', 'scala', 'com', 'dataforge', 'SparkDemo.scala');
const FILE_CONTENT = fs.readFileSync(SRC_FILE, 'utf8');

// provideHover 内稳定化退避 —— 与 languageClient.ts 完全一致
const STAB_DELAYS = [300, 600, 1000, 1500];
const STAB_NO_PROGRESS = 2;
const STAB_SETTLE = 1000;

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
// stdio 分帧 + JSON-RPC（与其它测试脚本一致）
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
const hoverValue = (x) => (typeof x === 'string' ? x : (x?.value ?? ''));
function hoverToText(contents) {
  if (contents == null) return '';
  const parts = typeof contents === 'string'
    ? [contents]
    : Array.isArray(contents) ? contents.map(hoverValue) : [hoverValue(contents)];
  return parts.join('\n').trim();
}
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
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }
// 稳定化 —— 移植自 stabilizeHover.ts
async function stabilizeIncompleteResult(initial, request, contentLen, isComplete, delays, noProgressLim = 2, settleTime = 1000) {
  if (initial && isComplete(initial)) return initial;
  let result = initial;
  let lastLen = result ? contentLen(result) : 0;
  let noProgressStreak = 0;
  let elapsed = 0;
  for (const delayMs of delays) {
    await new Promise((res) => setTimeout(res, delayMs));
    elapsed += delayMs;
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
  const stderrTail = [];
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
    try { proc.stdin.write(frame(resp)); } catch {}
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
      stderrTail.push(line);
      if (stderrTail.length > 30) stderrTail.shift();
    }
  });
  proc.on('error', (e) => { for (const p of [...pending.values()]) p.reject(e); pending.clear(); });
  return { proc, sendNotify, sendRequest, setOnImportLine: (fn) => { onImportLine = fn; },
    getStderrTail: () => stderrTail, isAlive: () => proc.exitCode === null && !proc.killed };
}

// ---------------------------------------------------------------------------
// languageClient.ts 的 provideHover 决策流移植（含新增的绑定感知等逻辑）
// ---------------------------------------------------------------------------
// 模块级状态镜像（新会话随 round 重建，模拟 registerMetalsSourceProvider 的 reset）
function createProvideHoverState() {
  return {
    buildTargetsReady: false,
    docNotifyVersion: new Map(),
    lastRebindAtByUri: new Map(), // 时间兜底：每 URI 最近一次强制重绑（冷却节流）
  };
}

const REBIND_COOLDOWN_MS = 5000;
// 时间兜底的持续探测预算（与 languageClient.ts 修复后一致）：
// 后台补拉改为周期探测，间隔对齐重绑冷却，总预算 ~90s，覆盖远超 24s 的冷导入窗口。
const BACKFILL_INTERVAL_MS = REBIND_COOLDOWN_MS;
const BACKFILL_MAX_ATTEMPTS = 18;
// 冷却节流式重绑（与 languageClient.ts 修复后的 rebindDocument 一致）
function rebindDoc(sess, st, uri, text) {
  const last = st.lastRebindAtByUri.get(uri) ?? -Infinity;
  if (Date.now() - last < REBIND_COOLDOWN_MS) return false;
  st.lastRebindAtByUri.set(uri, Date.now());
  const v = (st.docNotifyVersion.get(uri) ?? 1) + 1;
  st.docNotifyVersion.set(uri, v);
  sess.sendNotify('textDocument/didOpen', { textDocument: { uri, languageId: 'scala', version: v, text } }).catch(() => {});
  return true;
}

/**
 * 完整复刻 provideHover（修复后）：绑定感知等待 → 稳定化 → 冷签名强制重绑（时间兜底，不依赖信号）→ 后台补拉。
 * @param {object} sess LSP 会话
 * @param {object} st  状态镜像（含 buildTargetsReady / docNotifyVersion / lastRebindAtByUri）
 * @param {object} warmup 后台补拉系统（createWarmupSystem 返回值）
 * @returns {Promise<{verdict, text}>}
 */
async function provideHover(sess, st, warmup) {
  const uri = HOVER_URI;
  const pos = HOVER_POS;
  const rawRequest = () => sess.sendRequest('textDocument/hover', { textDocument: { uri }, position: pos })
    .then((r) => r, (e) => { throw e; });

  // —— 绑定感知等待（≤2000ms，等 build 就绪信号 + 重绑）——
  if (!st.buildTargetsReady) {
    const bindDeadline = Date.now() + 2000;
    while (!st.buildTargetsReady && Date.now() < bindDeadline) {
      await delay(100);
      if (!sess.isAlive()) throw new Error('Metals 进程已退出');
    }
    // 就绪后立即重绑文档（冷却节流），确保后续请求打到正确 build target
    if (st.buildTargetsReady) rebindDoc(sess, st, uri, FILE_CONTENT);
  }

  // 首次请求 + 稳定化
  let initial = await rawRequest();
  let lspResult = await stabilizeIncompleteResult(
    initial, rawRequest, hoverContentLen, hoverIsComplete,
    STAB_DELAYS, STAB_NO_PROGRESS, STAB_SETTLE,
  );

  // —— 未绑定冷签名诊断 + 强制重绑（时间兜底：不依赖 buildTargetsReady）——
  // 需容忍 markdown 代码围栏（Metals 返回 ```scala\nclass SparkSession: SparkSession\n```），
  // 先剥围栏并折叠空白为单行再锚定匹配，避免漏判导致重绑不触发。
  const text0 = hoverToText(lspResult && lspResult.contents);
  const coldCode = text0
    .replace(/```[a-zA-Z0-9_-]*/g, '')
    .replace(/```/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const looksUnboundColdSig = !!coldCode && /^(object|class|trait)\s+[\w.$]+(\s*:\s*[\w.$]+)?$/.test(coldCode);
  if (looksUnboundColdSig && rebindDoc(sess, st, uri, FILE_CONTENT)) {
    initial = await rawRequest();
    lspResult = await stabilizeIncompleteResult(
      initial, rawRequest, hoverContentLen, hoverIsComplete,
      STAB_DELAYS, STAB_NO_PROGRESS, STAB_SETTLE,
    );
  }

  // 仍未完整 → 后台补拉（人下次再悬停即可命中缓存）
  if (lspResult && !hoverIsComplete(lspResult)) {
    warmup.scheduleHoverPositionWarmup(pos);
  }

  return { verdict: classify(hoverToText(lspResult && lspResult.contents)), text: hoverToText(lspResult && lspResult.contents) };
}

// 后台补拉系统（移植自 languageClient.ts registerScalaHoverWarmup + scheduleHoverPositionWarmup）
function createWarmupSystem(sendHoverFn, onRetryRebind) {
  const keyOf = (pos) => `${pos.line}:${pos.character}`;
  const scheduled = new Set();
  const cooldownAt = new Map();
  const HOVER_WARMUP_COOLDOWN = 60000;

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
  const warmupSymbolWithRetry = (pos, attempt = 0) => {
    const d = attempt === 0 ? 0 : BACKFILL_INTERVAL_MS;
    setTimeout(() => {
      // 后台重试的定时兜底：重试前先强制重绑（冷却节流，不依赖 build 信号）
      if (attempt > 0 && onRetryRebind) onRetryRebind();
      sendHover(pos).then((ok) => { if (!ok && attempt < BACKFILL_MAX_ATTEMPTS) warmupSymbolWithRetry(pos, attempt + 1); });
    }, d);
  };
  const scheduleHoverPositionWarmup = (pos) => {
    const key = keyOf(pos);
    const last = cooldownAt.get(key);
    if (last !== undefined && Date.now() - last < HOVER_WARMUP_COOLDOWN) return;
    cooldownAt.set(key, Date.now());
    if (!scheduled.has(key)) { scheduled.add(key); warmupSymbolWithRetry(pos, 0); }
  };
  return { scheduleHoverPositionWarmup };
}

// ---------------------------------------------------------------------------
// 单轮
// ---------------------------------------------------------------------------
async function runOneRound(round) {
  const meta = { round, mode: 'HUMAN', startedAt: new Date().toISOString(), samples: [], errors: [] };
  const sess = launchMetals();
  const st = createProvideHoverState();
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

    // 后台补拉系统：随时能发 hover（非阻塞）
    const sendHoverFn = (pos) => sess.sendRequest('textDocument/hover', { textDocument: { uri: HOVER_URI }, position: pos }).catch(() => null);
    // 后台重试前先强制重绑（时间兜底，与 provideHover 一致）
    const warmup = createWarmupSystem(sendHoverFn, () => rebindDoc(sess, st, HOVER_URI, FILE_CONTENT));

    // didChangeBuildTargets → 置位 buildTargetsReady（模拟 registerMetalsSourceProvider 的监听）
    sess.setOnImportLine((m) => {
      if (m === 'metals/didChangeBuildTargets') st.buildTargetsReady = true;
    });

    // 人类打开文件（触发 build import）
    await sess.sendNotify('textDocument/didOpen', {
      textDocument: { uri: HOVER_URI, languageId: 'scala', version: 1, text: FILE_CONTENT },
    });
    const didOpenAt = Date.now();

    // 记录一次悬停样本（走完整 provideHover），返回样本对象
    // @param kind 'early'（相对打开文件）| 'ready'（build 就绪后立即，无等待）
    // @param whenMs kind='early' 时为相对 didOpen 的毫秒刻度；kind='ready' 时忽略
    const sampleAt = async (kind, whenMs) => {
      if (kind === 'early') await delay(Math.max(0, didOpenAt + whenMs - Date.now()));
      if (!sess.isAlive()) throw new Error('Metals 进程已退出');
      const s = { phase: kind, whenMs, verdict: null, text: '', latencyMs: null };
      const t0 = Date.now();
      try {
        const r = await provideHover(sess, st, warmup); // 含阻塞式绑定等待
        s.verdict = r.verdict;
        s.text = r.text;
        s.latencyMs = Date.now() - t0;
      } catch (e) {
        s.verdict = 'ERROR';
        s.error = e.message;
        s.latencyMs = Date.now() - t0;
      }
      s.buildTargetsReadyAtSample = st.buildTargetsReady;
      meta.samples.push(s);
      if (DEBUG) console.log(`  [debug] ${kind} ${whenMs}ms buildReady=${st.buildTargetsReady} verdict=${s.verdict} latency=${s.latencyMs}ms text=${(s.text || s.error || '').replace(/\n/g, ' ').slice(0, 120)}`);
      return s;
    };

    // 第 1 阶段：早期悬停（build 通常未就绪 → 复现"打开就悬停"，走绑定等待路径）
    for (const sms of SAMPLES_MS) {
      await sampleAt('early', sms);
    }

    // 第 2 阶段：恢复探测 —— 人类继续操作/等待，轮询悬停是否恢复成功。
    // 不依赖 didChangeBuildTargets 标志（headless 下可能不触发），直接用真实 hover
    // 判定恢复；有界超时避免长时间空等。
    const deadline = Date.now() + COLD_TIMEOUT;
    let recovered = false;
    while (Date.now() < deadline) {
      if (!sess.isAlive()) throw new Error('Metals 进程已退出');
      const r = await sampleAt('recover', Date.now() - didOpenAt);
      if (r.verdict === 'SUCCESS') { recovered = true; break; }
      await delay(RECOVERY_POLL_MS);
    }
    meta.buildReadyDelayMs = recovered ? Date.now() - didOpenAt : -1;
    meta.buildReady = recovered || st.buildTargetsReady;

    // 若恢复成功（或 build 就绪），再做 2 次确认悬停（人类持续使用 → 稳定命中）
    if (recovered || st.buildTargetsReady) {
      await delay(1500);
      await sampleAt('settle', Date.now() - didOpenAt);
      await delay(2000);
      await sampleAt('settle', Date.now() - didOpenAt);
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
  console.log('METALS LSP —— languageClient.ts 成功率（人类操作习惯）');
  console.log(`  Metals jar : ${METALS_JAR}`);
  console.log(`  目标符号   : SparkSession @${HOVER_POS.line}:${HOVER_POS.character}`);
  console.log(`  成功标记   : "${SUCCESS_MARKER}"`);
  console.log(`  轮数       : ${ROUNDS}`);
  console.log(`  操作采样   : 打开后 ${SAMPLES_MS.join(' / ')}ms 悬停（冷窗口）; 其后轮询恢复至成功或超时 ${COLD_TIMEOUT}ms`);
  console.log('  每次悬停   : 完整 provideHover（绑定等待/自动重绑/稳定化/冷签名强制重绑/补拉）');
  console.log('==========================================================');

  const allErrors = [];
  const allSamples = [];
  const earlyByMs = {};
  let settleSamples = 0;
  let settlePass = 0;
  let firstRecovery = -1;

  for (let r = 1; r <= ROUNDS; r++) {
    process.stdout.write(`\n[round ${r}/${ROUNDS}] 人类操作采样...`);
    let meta;
    try { meta = await runOneRound(r); }
    catch (e) { allErrors.push(`[round ${r}] 执行失败: ${e.message}`); console.log(`\n[round ${r}] 执行失败: ${e.message}`); continue; }
    if (meta.buildReadyDelayMs >= 0 && (firstRecovery === -1 || meta.buildReadyDelayMs < firstRecovery)) firstRecovery = meta.buildReadyDelayMs;
    allSamples.push(...meta.samples.map((s) => ({ round: r, ...s })));
    console.log('');
    console.log(`  [round ${r}] 悬停恢复耗时=${meta.buildReadyDelayMs}ms${meta.buildReady ? '' : '（超时未恢复）'}`);
    console.log(`  阶段      | 判定        | build就绪 | 耗时(ms) | 内容预览`);
    for (const s of meta.samples) {
      const preview = (s.text || s.error || '').replace(/\n/g, ' ').slice(0, 46);
      const when = s.phase === 'early' ? `+${s.whenMs}` : s.phase;
      console.log(`   ${when.padEnd(9)} | ${fmtVerdict(s.verdict).padEnd(11)} | ${String(s.buildTargetsReadyAtSample).padEnd(10)} | ${String(s.latencyMs).padEnd(8)} | ${preview}`);
    }
    // 统计
    for (const s of meta.samples) {
      if (s.phase === 'early') {
        if (!earlyByMs[s.whenMs]) earlyByMs[s.whenMs] = [];
        earlyByMs[s.whenMs].push(s.verdict);
      } else if (s.phase === 'settle') {
        settleSamples++;
        if (s.verdict === 'SUCCESS') settlePass++;
      }
      // recover 轮询样本仅用于探测恢复时刻，不计入成功/失败率，避免被探测期失败稀释
      if (s.verdict === 'ERROR') allErrors.push(`[round ${r}] ${s.phase} => ERROR ${(s.error || '').slice(0, 100)}`);
    }
    if (meta.buildReady === false) allErrors.push(`[round ${r}] build 在 ${COLD_TIMEOUT}ms 内未恢复`);
  }

  const cnt = (arr, v) => (arr || []).filter((x) => x === v).length;
  const allEarly = allSamples.filter((s) => s.phase === 'early');
  const earlyPass = cnt(allEarly.map((s) => s.verdict), 'SUCCESS');
  console.log('\n==========================================================');
  console.log('汇总（多轮 / 人类操作习惯）');
  console.log(`  悬停恢复耗时(最先成功轮) : ${firstRecovery < 0 ? '未恢复' : firstRecovery + 'ms'}`);
  console.log('  ① 早期悬停（打开后恒定时采样，通常在 build 就绪前 → 绑定等待路径）:');
  console.log(`     采样 ${allEarly.length}  SUCCESS ${earlyPass}  (${((earlyPass / allEarly.length) * 100).toFixed(1)}%)`);
  for (const ms of SAMPLES_MS) {
    const list = earlyByMs[ms] || [];
    if (!list.length) continue;
    const p = cnt(list, 'SUCCESS');
    console.log(`       +${String(ms).padEnd(6)}ms: ${p}/${list.length}  (${((p / list.length) * 100).toFixed(1)}%)`);
  }
  console.log('  ② 恢复后持续悬停（恢复成功后的确认样本 → 稳定命中率）:');
  console.log(`     采样 ${settleSamples}  SUCCESS ${settlePass}  (${settleSamples ? ((settlePass / settleSamples) * 100).toFixed(1) : 'N/A'}%)`);
  console.log('\n  运行期报错（errors）:');
  if (allErrors.length === 0) console.log('    （无）');
  else for (const e of allErrors) console.log(`    - ${e}`);
  console.log('==========================================================\n');

  const out = path.join(WORKSPACE, `human-habit-report-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify({ mode: 'human-habit', successMarker: SUCCESS_MARKER, allErrors, allSamples }, null, 2));
  console.log(`详细报告已写入: ${out}`);
  process.exit(allErrors.length > 0 ? 1 : 0);
}

main().catch((e) => { console.error('\n[测试主流程异常]', e); process.exit(2); });