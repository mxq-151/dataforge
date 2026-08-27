#!/usr/bin/env node
/**
 * METALS LSP 服务稳定性测试（stdio JSON-RPC 直连，无需 Electron）。
 *
 * 目标：验证「LSP 服务就绪后」指定延迟下对 org.apache.spark.sql.SparkSession
 * 的悬停（hover）结果是否稳定返回完整 scaladoc，而非冷窗口下的类型签名。
 *
 * 判定规则（悬停目标 = SparkSession）：
 *   - SUCCESS：返回文本包含成功标记 "The entry point to programming"（= 完整 scaladoc）
 *   - COLD_SIG / EMPTY：文本仅为 "object org.apache.spark.sql.SparkSession" 或为空 → 失败
 *   - OTHER：其它非空文本（既非完整文档也非冷签名）→ 记为不稳定，同样不算通过（文本会打印）
 *
 * 就绪（ready）定义：给服务端 didOpen 目标文件并自动应答「导入构建」等无头提示后，
 * 轮询首次拿到「非空 hover 结果」的时刻作为 ready；随后从 ready 起按 1/2/3/5/8s 采样。
 * 多轮（默认 3 轮）各自启动全新 Metals 进程，最后汇总输出各轮报错。
 *
 * 用法：
 *   node run-stability-test.js                // 默认 3 轮、延迟 1000,2000,3000,5000,8000
 *   ROUNDS=5 DELAYS=1000,2000,3000,5000,8000 node run-stability-test.js
 *   METALS_JAR=.../metals.jar JAVA_HOME=... WORKSPACE=... node run-stability-test.js
 */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// ── 配置 ──────────────────────────────────────────────────────────
const ROOT = path.resolve(__dirname, '..');
const METALS_JAR =
  process.env.METALS_JAR || path.join(ROOT, 'resources', 'metals', 'metals.jar');
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
// 采样结束后额外做一次「更晚」悬停（探测 scaladoc 是否最终加载），默认 20s 后
const PROBE_AFTER_MS = Number(process.env.PROBE_AFTER_MS || 20000);

// 悬停位置：SparkDemo.scala 第 16 行（0-based=15）的 "SparkSession" 类型名上
const HOVER_URI = `file://${WORKSPACE.replace(/ /g, '%20')}/src/main/scala/com/dataforge/SparkDemo.scala`;
const HOVER_POS = { line: 15, character: 15 };

const FILE_CONTENT = fs.readFileSync(
  path.join(WORKSPACE, 'src', 'main', 'scala', 'com', 'dataforge', 'SparkDemo.scala'),
  'utf8',
);

const SUCCESS_MARKER = 'The entry point to programming';
const COLD_SIG = 'object org.apache.spark.sql.SparkSession';

// ── Metals JVM 启动参数（与 lspBridge.buildMetalsArgs 对齐）─────────
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

// ── LSP Content-Length 分帧（stdout → 完整消息）───────────────────
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

// ── 文本摘取 / 判定 ───────────────────────────────────────────────
const hoverValue = (x) => (typeof x === 'string' ? x : (x && x.value) || '');
function hoverToText(contents) {
  if (contents == null) return '';
  const parts = typeof contents === 'string'
    ? [contents]
    : Array.isArray(contents)
      ? contents.map(hoverValue)
      : [hoverValue(contents)];
  const text = parts.join('\n');
  return text.trim();
}
function classify(text) {
  if (!text) return 'EMPTY';
  if (text.includes(SUCCESS_MARKER)) return 'SUCCESS';
  if (text === COLD_SIG) return 'COLD_SIG';
  if (text.includes('SparkSession') && !text.includes('The entry point')) return 'COLD_SIG';
  return 'OTHER';
}
const FAIL_VERDICTS = new Set(['EMPTY', 'COLD_SIG', 'OTHER']);

// ── 单轮 Metals 会话 ──────────────────────────────────────────────
function launchMetals() {
  const proc = spawn(JAVA_BIN, [...METALS_JVM_ARGS, '-jar', METALS_JAR], {
    cwd: WORKSPACE,
    env: {
      ...process.env,
      JAVA_HOME: JAVA_HOME || undefined,
      // 复用本机 ~/.m2 已下载的 Spark/scala 依赖与 -sources.jar，避免重复下载
      COURSIER_REPOSITORIES: 'maven-local|ivy2-local|https://repo1.maven.org/maven2',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const parser = new LspParser();
  const pending = new Map(); // id -> {resolve, reject}
  let nextId = 1;
  const log = [];
  const stderrLines = [];
  let stderrTail = [];

  const frame = (o) =>
    Buffer.from(`Content-Length: ${Buffer.byteLength(JSON.stringify(o), 'utf8')}\r\n\r\n${JSON.stringify(o)}`, 'utf8');
  const sendNotify = (method, params = {}) => {
    const o = { jsonrpc: '2.0', method, params };
    log.push(`>> ${method}`);
    if (!proc.stdin.writable) return Promise.reject(new Error('stdin 已关闭'));
    proc.stdin.write(frame(o));
    return Promise.resolve();
  };
  const sendRequest = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      log.push(`>> ${method}#${id}`);
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
        log.push(`<< showMessageRequest -> ${resp.result} (对应导入构建)`);
      } else if (method === 'metals/quickPick') {
        const items = (params && params.items) || [];
        const m = items.find((i) => /(bloop|maven)/i.test(i.label || ''));
        resp.result = { id: (m || items[0] || {}).id ?? null };
        log.push(`<< quickPick -> ${JSON.stringify(resp.result)}`);
      } else if (method === 'metals/inputBox') {
        resp.result = null;
        log.push('<< inputBox -> null');
      } else {
        resp.result = null;
        log.push(`<< 未知请求 ${method} -> null`);
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
      // notifications（仅记录关键信号）
      const logThis = ['window/logMessage', 'metals/logMessage', 'metals/importBuild',
        'metals/didChangeBuildTargets', 'metals/compilation.finished', 'metals/status',
        'window/showMessage', 'window/_metals', 'metals/indexer'].includes(method);
      if (logThis) {
        log.push(`<< ${method} ${JSON.stringify(msg.params)?.slice(0, 300)}`);
      }
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

  // 等待构建导入完成（收到 'Imported build' 日志 或 didChangeBuildTargets 通知即视为完成）
  let parseImportDoneResolve;
  const parseImportDone = new Promise((resolve) => {
    parseImportDoneResolve = resolve;
  });
  const importState = { resolved: false };
  const onImportLine = (method, params) => {
    const fin = () => { if (!importState.resolved) { importState.resolved = true; parseImportDoneResolve(); } };
    if (method === 'metals/logMessage' || method === 'window/logMessage') {
      const s = (params && (params.message || JSON.stringify(params))) || '';
      if (/(Imported build|Importing build|import complete|indexed workspace)/i.test(s)) fin();
    } else if (method === 'metals/didChangeBuildTargets' || method === 'metals/compilation.finished') {
      fin();
    }
  };

  return {
    proc,
    sendNotify,
    sendRequest,
    onImportLine,
    getLog: () => log,
    getStderrTail: () => stderrTail,
    getStderr: () => stderrLines,
    isAlive: () => proc.exitCode === null && !proc.killed,
  };
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }
function uriToWorkspacePath() { return WORKSPACE; }

// ── 单轮执行 ──────────────────────────────────────────────────────
async function runOneRound(round) {
  const meta = { round, startedAt: new Date().toISOString(), delays: DELAYS_MS, samples: [], errors: [] };
  const sess = launchMetals();
  try {
    // 1) initialize
    const initParams = {
      processId: process.pid,
      rootUri: `file://${uriToWorkspacePath()}`,
      capabilities: {
        workspace: { workspaceFolders: true },
        textDocument: {
          hover: { dynamicRegistration: true, contentFormat: ['markdown', 'plaintext'] },
          definition: { dynamicRegistration: true },
        },
      },
      initializationOptions: {
        mavenSupport: true, metricEnabled: false, decorationProvider: false,
        inlineDecorationProvider: false, isHttpEnabled: false,
        showInferredType: true, showImplicitArguments: false,
      },
      workspaceFolders: [{ uri: `file://${uriToWorkspacePath()}`, name: 'workspace' }],
    };
    await sess.sendRequest('initialize', initParams);
    await sess.sendNotify('initialized', {});
    meta.readyHandshake = true;

    // 2) 打开目标 scala 文件（触发 Metals 检测构建工具并 import 构建）
    await sess.sendNotify('textDocument/didOpen', {
      textDocument: {
        uri: HOVER_URI, languageId: 'scala', version: 1, text: FILE_CONTENT,
      },
    });

    // 3) 等待构建导入完成（Metals 会因 .bloop 目录自动启动 Bloop 并导入 build）。
    //    用信号 + 兜底超时：首次需启动 Bloop daemon、编译、scaladoc 解压。
    const importSignal = new Promise((resolve) => {
      const prev = sess.onImportLine;
      sess.onImportLine = (m, p) => {
        if (typeof prev === 'function') prev(m, p);
        if (m === 'metals/didChangeBuildTargets') resolve();
      };
    });
    await Promise.race([importSignal, delay(25000)]);
    if (DEBUG) console.log('  [debug] build import wait done');
    // 暂停片刻，确保 build 已绑定
    await delay(1500);

    // 4) import 完成后再重新 didOpen（新 version），强制把文档绑定到 spark-demo build target
    //    （否则文件会一直卡在用 Scala 3.3.7 演示编译器的旧上下文，hover 只得冷签名）。
    await sess.sendNotify('textDocument/didOpen', {
      textDocument: {
        uri: HOVER_URI, languageId: 'scala', version: 2, text: FILE_CONTENT,
      },
    });

    // 5) 就一直绪判定：轮询首个「非空 hover」结果
    let readyAt = null;
    let readyText = '';
    const readyDeadline = Date.now() + READY_TIMEOUT;
    while (Date.now() < readyDeadline) {
      if (!sess.isAlive()) throw new Error('Metals 进程已退出（见 stderr 尾部）');
      try {
        const h = await sess.sendRequest('textDocument/hover', {
          textDocument: { uri: HOVER_URI }, position: HOVER_POS,
        });
        const t = hoverToText(h && h.contents);
        if (t) { readyAt = Date.now(); readyText = t; break; }
      } catch { /* 服务端尚未就绪，继续轮询 */ }
      await delay(HOVER_POLL_INTERVAL);
    }
    if (readyAt === null) {
      throw new Error(`就绪超时（${READY_TIMEOUT}ms）：始终未获得非空 hover 结果`);
    }
    meta.readyAt = new Date(readyAt).toISOString();
    meta.readyText = readyText.slice(0, 160);

    // 4) 按 1/2/3/5/8s 相对 ready 采样
    for (const dMs of DELAYS_MS) {
      try {
        await delay(Math.max(0, readyAt + dMs - Date.now()));
      } catch {}
      const s = { delayMs: dMs, verdict: null, text: '', latencyMs: null };
      const t0 = Date.now();
      try {
        const h = await sess.sendRequest('textDocument/hover', {
          textDocument: { uri: HOVER_URI }, position: HOVER_POS,
        });
        s.latencyMs = Date.now() - t0;
        s.text = hoverToText(h && h.contents);
        s.verdict = classify(s.text);
      } catch (e) {
        s.verdict = 'ERROR';
        s.error = e.message;
      }
      if (FAIL_VERDICTS.has(s.verdict)) {
        meta.errors.push(`round=${round} delay=${dMs}ms => ${s.verdict}`);
      }
      meta.samples.push(s);
      if (DEBUG) console.log(`\n  [debug] delay=${dMs}ms verdict=${s.verdict}\n${s.text.slice(0, 900)}`);
    }

    // 探测：更晚一次悬停，判断 scaladoc 是否只是「加载得慢」而非「无法加载」
    const probe = { delayMs: PROBE_AFTER_MS, probe: true, verdict: null, text: '' };
    try {
      await delay(Math.max(0, readyAt + PROBE_AFTER_MS - Date.now()));
      const h = await sess.sendRequest('textDocument/hover', {
        textDocument: { uri: HOVER_URI }, position: HOVER_POS,
      });
      probe.text = hoverToText(h && h.contents);
      probe.verdict = classify(probe.text);
    } catch (e) {
      probe.verdict = 'ERROR';
      probe.error = e.message;
    }
    meta.probe = probe;
    if (DEBUG) console.log(`\n  [debug] probe(+${PROBE_AFTER_MS}ms) verdict=${probe.verdict}\n${probe.text.slice(0, 900)}`);
    if (DEBUG && sess.getStderrTail().length) {
      console.log('\n  [debug] Metals stderr tail:\n' + sess.getStderrTail().join('\n'));
    }
    return meta;
  } finally {
    // 5) 回收
    try { await sess.sendNotify('shutdown'); } catch {}
    try { sess.proc.kill('SIGKILL'); } catch {}
    await delay(300);
  }
}

// ── 汇总输出 ──────────────────────────────────────────────────────
function fmtVerdict(v) {
  switch (v) {
    case 'SUCCESS': return 'SUCCESS';
    case 'COLD_SIG': return 'FAIL(冷签名)';
    case 'EMPTY': return 'FAIL(空)';
    case 'OTHER': return 'FAIL(其它文本)';
    case 'ERROR': return 'FAIL(请求错误)';
    default: return v;
  }
}

async function main() {
  console.log('==========================================================');
  console.log('METALS LSP 服务稳定性测试');
  console.log(`  Metals jar : ${METALS_JAR}`);
  console.log(`  Workspace  : ${WORKSPACE}`);
  console.log(`  目标符号   : org.apache.spark.sql.SparkSession @${HOVER_POS.line}:${HOVER_POS.character}`);
  console.log(`  成功标记   : "${SUCCESS_MARKER}"`);
  console.log(`  轮数       : ${ROUNDS}`);
  console.log(`  采样延迟   : ${DELAYS_MS.map((d) => d + 'ms').join(' / ')}`);
  console.log('==========================================================');

  const allErrors = [];
  const allSamples = [];

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
    console.log(`\n[round ${r}] 就绪(ready)@准备首个非空hover=${meta.readyAt} 启动到ready=见日志`);
    // 表格
    console.log('   延迟    | 判定        | 内容预览');
    for (const s of meta.samples) {
      const preview = (s.text || s.error || '').replace(/\n/g, ' ').slice(0, 70);
      console.log(`   ${String(s.delayMs).padEnd(7)} | ${fmtVerdict(s.verdict).padEnd(11)} | ${preview}`);
    }
    if (meta.probe) {
      console.log(`   [探测+${meta.probe.delayMs}ms] | ${fmtVerdict(meta.probe.verdict).padEnd(11)} | ${(meta.probe.text || meta.probe.error || '').replace(/\n/g, ' ').slice(0, 70)}`);
    }
    if (meta.errors.length) allErrors.push(...meta.errors);
  }

  // 汇总
  console.log('\n==========================================================');
  console.log('汇总（多轮）');
  const pass = allSamples.filter((s) => s.verdict === 'SUCCESS').length;
  const fail = allSamples.filter((s) => FAIL_VERDICTS.has(s.verdict) || s.verdict === 'ERROR').length;
  console.log(`  采样总数: ${allSamples.length}  通过(SUCCESS): ${pass}  未通过: ${fail}`);
  // 按延迟统计
  console.log('  按延迟统计:');
  for (const d of DELAYS_MS) {
    const list = allSamples.filter((s) => s.delayMs === d);
    const p = list.filter((s) => s.verdict === 'SUCCESS').length;
    console.log(`    ${String(d).padEnd(6)}ms: 通过 ${p}/${list.length}`);
  }
  console.log('\n  测试报错（errors）:');
  if (allErrors.length === 0) {
    console.log('    （无）');
  } else {
    for (const e of allErrors) console.log(`    - ${e}`);
  }
  console.log('==========================================================\n');

  // 落盘 JSON 记录
  const out = path.join(WORKSPACE, `stability-report-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify({ allErrors, allSamples, successMarker: SUCCESS_MARKER }, null, 2));
  console.log(`详细报告已写入: ${out}`);

  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('\n[测试主流程异常]', e);
  process.exit(2);
});