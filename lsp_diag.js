// 诊断harness：直接走后端 start_java_lsp_ws 桥，做一次完整 initialize 握手，输出失败点。
const { app } = require('electron');
const WebSocket = require('ws');
const { startJavaLspWs, stopJavaLspWs } = require('/Users/mxq/Desktop/dataforge/dist-electron/backend/lspBridge.js');

app.whenReady().then(async () => {
  try {
    const javaHome = '/opt/homebrew/Cellar/openjdk@17/17.0.19/libexec/openjdk.jdk/Contents/Home';
    const workspaceRoot = '/Users/mxq/.dataforge/localhost_8082/code/demo_java';
    console.log('[h] call startJavaLspWs...');
    const res = await startJavaLspWs({ javaHome, workspaceRoot });
    console.log('[h] got', JSON.stringify(res));
    const ws = new WebSocket(res.ws_url);
    const timeout = setTimeout(() => {
      console.log('[h] TIMEOUT waiting initialize');
      ws.close(); process.exit(2);
    }, 40000);
    ws.on('open', () => {
      console.log('[h] ws open, sending initialize');
      const init = {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: {
          processId: null, rootUri: 'file://' + workspaceRoot,
          capabilities: {},
          initializationOptions: {
            settings: { java: { autobuild: { enabled: true }, import: { maven: { enabled: true }, gradle: { enabled: false } }, project: { sourcePaths: ['src'], referencedLibraries: [] }, completion: { filteredTypes: [] } } },
            bundles: [],
          },
        },
      };
      ws.send(JSON.stringify(init));
    });
    const logLines = [];
    ws.on('message', (d) => {
      const t = d.toString();
      logLines.push(t.slice(0, 200));
      if (logLines.length > 20) logLines.shift();
      try {
        const m = JSON.parse(t);
        if (m.id === 1) {
          clearTimeout(timeout);
          console.log('[h] INITIALIZE RESPONSE id=1 ->', JSON.stringify(m).slice(0, 300));
          // 收 context/serverReady 2~3s
          setTimeout(() => {
            console.log('[h] recent frames:\n' + logLines.join('\n---\n'));
            ws.close(); process.exit(0);
          }, 3000);
        }
        if (m.method === 'window/logMessage') console.log('[h] server log:', m.params?.message);
      } catch { /* partial frame not expected */ }
    });
    ws.on('error', (e) => { clearTimeout(timeout); console.log('[h] ws error', e.message); process.exit(3); });
    ws.on('close', () => { clearTimeout(timeout); console.log('[h] ws closed unexpectedly'); process.exit(4); });
  } catch (e) {
    console.log('[h] START FAILED:', e && e.message, e);
    console.log('[h] stack:', e && e.stack);
    process.exit(5);
  }
});