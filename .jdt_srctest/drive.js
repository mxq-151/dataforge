// 独立 jdtls 驱动：完全复刻 lspBridge.buildJdtlsArgs 启动参数 + 应用初始化参数，
// 走 referencedLibraries.sources（应用核心源码附加机制）验证「跳到 Java 类」返回源码还是反编译。
// 用法: node drive.js [workspaceDir]
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const javaHome = '/opt/homebrew/Cellar/openjdk@17/17.0.19/libexec/openjdk.jdk/Contents/Home';
const jdtlsPath = '/Users/mxq/Desktop/dataforge/resources/jdtls';
const workspace = process.argv[2] || '/Users/mxq/Desktop/dataforge/.jdt_nopom';
const dataDir = workspace + '/.data';

const home = process.env.HOME;
const guava = path.join(home, '.m2/repository/com/google/guava/guava/32.0.0-jre/guava-32.0.0-jre.jar');
const guavaSrc = guava.replace('.jar', '-sources.jar');
const spark = path.join(home, '.m2/repository/org/apache/spark/spark-core_2.12/3.5.9/spark-core_2.12-3.5.9.jar');
const sparkSrc = spark.replace('.jar', '-sources.jar');

const pluginsDir = jdtlsPath + '/plugins';
const launcherJar = fs.readdirSync(pluginsDir).filter((n) => /^org\.eclipse\.equinox\.launcher_\d.*\.jar$/.test(n))[0];
const configDir = jdtlsPath + '/config_mac';
const args = [
  '-Declipse.application=org.eclipse.jdt.ls.core.id1',
  '-Dosgi.bundles.defaultStartLevel=4',
  '-Declipse.product=org.eclipse.jdt.ls.core.product',
  '-Dlog.protocol=true', '-Dlog.level=ALL', '-Xmx1G',
  '--add-modules=ALL-SYSTEM', '--add-opens', 'java.base/java.util=ALL-UNNAMED',
  '--add-opens', 'java.base/java.lang=ALL-UNNAMED',
  '-DDetectVMInstallationsJob.disabled=true', '-Dfile.encoding=utf8', '-Xms100m',
  '-Xlog:disable', '-XX:+UseParallelGC', '-XX:GCTimeRatio=4', '-XX:AdaptiveSizePolicyWeight=90',
  '-Dsun.zip.disableMemoryMapping=true', '-Djava.import.generatesMetadataFilesAtProjectRoot=false',
  '-Daether.dependencyCollector.impl=bf',
  '-jar', path.join(pluginsDir, launcherJar), '-configuration', configDir, '-data', dataDir,
];
const child = spawn(javaHome + '/bin/java', args, { env: { ...process.env, JAVA_HOME: javaHome }, stdio: ['pipe', 'pipe', 'pipe'] });
const diag = [];

let buf = Buffer.alloc(0);
const pending = new Map();
const notifHandlers = [];
function send(msg) { const s = JSON.stringify(msg); child.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`); }
child.stdout.on('data', (d) => {
  buf = buf.length === 0 ? d : Buffer.concat([buf, d]);
  for (;;) {
    const h = buf.indexOf('\r\n\r\n');
    if (h === -1) return;
    const m = /Content-Length: (\d+)/i.exec(buf.subarray(0, h).toString());
    if (!m) { buf = buf.subarray(h + 4); continue; }
    const len = parseInt(m[1], 10);
    const start = h + 4;
    if (buf.length < start + len) return;
    const body = buf.subarray(start, start + len).toString('utf8');
    buf = buf.subarray(start + len);
    let obj; try { obj = JSON.parse(body); } catch { continue; }
    if (obj.id !== undefined && pending.has(obj.id)) { pending.get(obj.id)(obj); pending.delete(obj.id); }
    else if (obj.method) {
      for (const f of notifHandlers) f(obj);
      if (obj.method === 'window/showMessage' || obj.method === 'window/logMessage' || obj.method === '$/progress' || obj.method === 'telemetry/event') {
        diag.push(obj.method + ' ' + JSON.stringify(obj.params).slice(0, 300));
      }
    }
  }
});
child.stderr.on('data', (d) => { if (process.env.VERBOSE) process.stderr.write('[jdtls] ' + d.toString()); });
function req(id, method, params) { return new Promise((res) => { pending.set(id, res); send({ jsonrpc: '2.0', id, method, params }); }); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  const initOpts = {
    settings: {
      java: {
        autobuild: { enabled: true },
        import: { maven: { enabled: true }, gradle: { enabled: false } },
        maven: { downloadSources: true },
        project: { sourcePaths: ['src'], referencedLibraries: [] },
        completion: { filteredTypes: [] },
      },
    },
    bundles: [],
    extendedClientCapabilities: { classFileContentsSupport: true },
  };
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { processId: null, rootUri: 'file://' + workspace, capabilities: {}, initializationOptions: initOpts } });
  const initResp = await new Promise((res) => pending.set(1, res));
  console.log('### INIT ok:', !!initResp.result, ' server:', initResp.result && initResp.result.serverInfo && initResp.result.serverInfo.version);
  send({ jsonrpc: '2.0', method: 'initialized', params: {} });

  if (process.env.REFLIB !== '0') {
    const refLibraries = { include: [guava, spark], sources: { [guava]: guavaSrc, [spark]: sparkSrc } };
    send({ jsonrpc: '2.0', method: 'workspace/didChangeConfiguration', params: { settings: { java: { project: { referencedLibraries: refLibraries } } } } });
    console.log('### [已推送 referencedLibraries include+sources]');
  } else {
    console.log('### [跳过 referencedLibraries，仅用 Maven import + downloadSources]');
  }

  const filePath = workspace + '/src/main/java/demo/SparkDemo.java';
  const text = fs.readFileSync(filePath, 'utf8');
  const uri = 'file://' + filePath;
  send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'java', version: 1, text } } });

  console.log('### 等待服务器处理 (' + (process.env.SLEEP || '10') + 's) ...');
  await sleep((parseInt(process.env.SLEEP || '10', 10)) * 1000);

  const targets = [
    { name: 'import行', term: 'com.google.common.base.Preconditions' },
    { name: '用法行', term: 'Preconditions.checkNotNull' },
  ];
  const posOf = (term) => {
    const pIdx = text.indexOf(term);
    if (pIdx < 0) return null;
    const lineStart = text.lastIndexOf('\n', pIdx) + 1;
    const lineEnd = text.indexOf('\n', pIdx);
    const lineText = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    const identStart = lineStart + lineText.lastIndexOf('Preconditions');
    const line = text.slice(0, identStart).split('\n').length; // 1-based
    const col = identStart - text.slice(0, identStart).lastIndexOf('\n') - 1;
    return { line, col };
  };

  let id = 2;
  for (const tgt of targets) {
    const pos = posOf(tgt.term);
    if (!pos) { console.log('### [' + tgt.name + '] 文本未找到'); continue; }
    console.log('### [' + tgt.name + '] definition @ line=' + pos.line + ' col=' + pos.col);
    const def = await req(id++, 'textDocument/definition', { textDocument: { uri }, position: pos });
    let target = def.result;
    if (Array.isArray(target)) target = target[0];
    if (!target) { console.log('###   -> 无结果'); continue; }
    console.log('###   -> target.uri =', target.uri);

    const cf = await req(id++, 'java/classFileContents', { uri: target.uri });
    const content = cf.result && cf.result.content !== undefined ? cf.result.content : JSON.stringify(cf.result);
    if (typeof content !== 'string') { console.log('###   -> classFileContents 非字符串:', JSON.stringify(cf).slice(0, 200)); continue; }
    const lines = content.split('\n');
    const isSourcesJarOrSource = /com\.google\.common\.base|class Precondition\b/.test(content.slice(0, 6000));
    const isJdk = /jdk\.internal\.util\.Preconditions|outOfBoundsExceptionFormatter/.test(content.slice(0, 2000));
    console.log('###   -> 命中源码(guava):', isSourcesJarOrSource, ' JDK内部类:', isJdk, ' 行数:', lines.length);
    console.log('###   前 4 行:\n   ' + lines.slice(0, 4).join('\n   ').slice(0, 600));
  }

  console.log('### === 服务器消息(diag) ===');
  console.log(diag.join('\n').slice(0, 4000));
  process.exit(0);
})().catch((e) => { console.log('### ERROR', e && e.message, e && e.stack); process.exit(8); });