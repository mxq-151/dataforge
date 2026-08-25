import { app, BrowserWindow } from 'electron';
import * as path from 'node:path';
import { registerIpcHandlers } from './ipc';
import { autoStartOpencode, stopOpencodeServer } from './backend/opencode';
import { startCompileServer, stopCompileServer } from './backend/compileServer';
import { stopAllLspBridges } from './backend/lspBridge';

// preload 编译产物与 main.js 同目录（dist-electron/）
const PRELOAD_PATH = path.join(__dirname, 'preload.js');
// 生产构建产物（vite build -> dist/index.html）
const RENDERER_INDEX = path.join(__dirname, '../dist/index.html');

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1344,
    height: 756,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'DataForge',
    // 与 Tauri 版一致：无边框窗口 + 应用内自定义 TitleBar
    // （拖拽由 index.html 中的 -webkit-app-region 垫片 CSS 提供）
    frame: false,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => win.show());

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void win.loadURL(devServerUrl);
  } else {
    void win.loadFile(RENDERER_INDEX);
  }
}

app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();

  // 先启动 compile HTTP server（随机端口+token），再自动启动 opencode，
  // 确保 opencode 工具能拿到 DATAFORGE_COMPILE_PORT/TOKEN。
  startCompileServer();

  // 与 Rust 版 auto_start_opencode 一致：配置完整（model + auth_token）时自动启动
  void autoStartOpencode();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 退出时优雅终止 opencode、compile server 与 LSP 桥（避免留下孤儿进程/占用端口）
app.on('before-quit', () => {
  void stopOpencodeServer();
  stopCompileServer();
  stopAllLspBridges();
});