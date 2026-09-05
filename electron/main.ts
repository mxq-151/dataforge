import { app, BrowserWindow, screen, shell } from 'electron';
import * as path from 'node:path';
import { installMainLogger } from './backend/logger';
import { registerIpcHandlers } from './ipc';
import { autoStartOpencode, stopOpencodeServer } from './backend/opencode';
import { startCompileServer, stopCompileServer } from './backend/compileServer';
import { stopAllLspBridges } from './backend/lspBridge';
import { detectWsl, runtimeId } from './backend/platform';

// preload 编译产物与 main.js 同目录（dist-electron/）
const PRELOAD_PATH = path.join(__dirname, 'preload.js');
// 生产构建产物（vite build -> dist/index.html）
const RENDERER_INDEX = path.join(__dirname, '../dist/index.html');

// 打包版无控制台，主进程日志同时落盘到 userData/logs/main.log，便于排查
installMainLogger();

function createWindow(): void {
  // 初始尺寸为工作区 70%（与渲染层旧逻辑 initWindowSize 一致，改由主进程原生实现）
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width: Math.round(sw * 0.7),
    height: Math.round(sh * 0.7),
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'DataForge',
    // 原生标题栏方案：macOS 用 hiddenInset 保留系统红绿灯（hover 效果/双击缩放等原生行为
    // 全部可用），Windows/Linux 用 titleBarOverlay 渲染系统控制按钮；仅标题与拖拽区域
    // 由应用内 TitleBar 组件提供，不再自绘按钮。
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform !== 'darwin'
      ? { titleBarOverlay: { color: '#1f1f1f', symbolColor: '#cccccc', height: 32 } }
      : {}),
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => win.show());
  // 兜底：若首帧渲染迟迟不完成（渲染层卡住/白屏），ready-to-show 可能永不触发，
  // 窗口会一直保持 show:false 而表现为"应用没启动"。加超时强制显示，便于看到真实界面或错误。
  setTimeout(() => {
    if (win.isDestroyed()) return;
    if (!win.isVisible()) win.show();
  }, 4000);

  // 记录渲染失败原因（如 dev server 未就绪/NET 错误），便于排查窗口白屏、不显示等问题
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error(`[renderer] did-fail-load code=${errorCode} ${errorDescription}`);
  });

  // 拦截 window.open / target=_blank：任何在开发助手等模块触发的"新窗口打开"都改为在原窗口内处理。
  // 外部 http(s) 链接交给系统浏览器，其余一律拒绝新开窗口（保证单窗口应用形态）。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void win.loadURL(devServerUrl);
  } else {
    void win.loadFile(RENDERER_INDEX);
  }
}

app.whenReady().then(() => {
  // 启动即打印精确运行环境（Windows / macOS / WSL / 裸 Linux），便于排查时第一时间确认宿主系统
  console.log(
    `[platform] DataForge running on runtime=${runtimeId()} platform=${process.platform} arch=${process.arch} wsl=${detectWsl()}`
  );
  registerIpcHandlers();
  createWindow();

  // 先启动 compile HTTP server（随机端口+token），再自动启动 opencode，
  // 确保 opencode 工具能拿到 DATAFORGE_COMPILE_PORT/TOKEN。
  startCompileServer();

  // 配置完整（model + auth_token）时自动启动 opencode
  void autoStartOpencode();

  app.on('activate', () => {
    // 应用已配置为关闭即完全退出，这里仅在极端情况下（窗口被系统销毁但进程存活）
    // 补建窗口。普通关闭流程不会走到这里。
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // 点击标题栏关闭按钮后完全退出整个应用（含 macOS），
  // 退出前 before-quit 会优雅终止 opencode / compile / LSP 进程。
  app.quit();
});

// 退出时优雅终止 opencode、compile server 与 LSP 桥（避免留下孤儿进程/占用端口）
app.on('before-quit', () => {
  void stopOpencodeServer();
  stopCompileServer();
  stopAllLspBridges();
});