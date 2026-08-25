/// <reference types="node" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile as fsReadFile } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// dev-only：为编辑器测试页提供本地文件读取通道（与 Tauri 版相同）
function devLocalFileReadPlugin() {
  return {
    name: 'dev-local-file-read-testpage',
    configureServer(server: { middlewares: { use: (path: string, h: (req: any, res: any) => void) => void } }) {
      server.middlewares.use('/__testfile__/', (req, res) => {
        try {
          const query = new URL(req.url || '', 'http://localhost').searchParams;
          const filePath = query.get('path');
          if (!filePath) {
            res.statusCode = 400;
            res.end('missing path');
            return;
          }
          fsReadFile(filePath, (err, data) => {
            if (err) {
              res.statusCode = 404;
              res.end(String(err));
              return;
            }
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.end(data);
          });
        } catch (e) {
          res.statusCode = 500;
          res.end(String(e));
        }
      });
    },
  };
}

const isProduction = process.env.NODE_ENV === 'production' || process.argv.includes('build');

export default defineConfig({
  // base: './' 是关键——生产构建由 Electron 通过 file:// 加载，必须用相对路径
  base: './',
  plugins: [react(), devLocalFileReadPlugin()],

  // === Tauri 兼容垫片：把所有 @tauri-apps/* 导入映射到本地 compat/ 实现 ===
  // vscode 别名：与原工程一致，指向 @codingame/monaco-vscode-extension-api
  resolve: {
    alias: {
      vscode: '@codingame/monaco-vscode-extension-api',
      '@tauri-apps/api/core': resolve(__dirname, 'compat/tauri-core.ts'),
      '@tauri-apps/api/event': resolve(__dirname, 'compat/tauri-event.ts'),
      '@tauri-apps/api/path': resolve(__dirname, 'compat/tauri-path.ts'),
      '@tauri-apps/api/app': resolve(__dirname, 'compat/tauri-app.ts'),
      '@tauri-apps/plugin-store': resolve(__dirname, 'compat/tauri-plugin-store.ts'),
      '@tauri-apps/plugin-fs': resolve(__dirname, 'compat/tauri-plugin-fs.ts'),
      '@tauri-apps/plugin-shell': resolve(__dirname, 'compat/tauri-plugin-shell.ts'),
      '@tauri-apps/plugin-http': resolve(__dirname, 'compat/tauri-plugin-http.ts'),
    },
    dedupe: ['react', 'react-dom', '@codingame/monaco-vscode-api'],
  },

  // === 关键：排除所有 @codingame/monaco-vscode-* 包出 Vite 预打包 ===
  // 这些包大量使用 `new URL('./resources/x', import.meta.url)` 定位主题/worker/wasm。
  // 预打包会让 import.meta.url 指向 .vite/deps/，相对资源 404 → 主题加载失败 → 无高亮。
  // 必须【全部】排除，保持唯一 DI 容器（与原工程配置一致）。
  optimizeDeps: {
    exclude: [
      '@codingame/monaco-vscode-api',
      '@codingame/monaco-vscode-editor-api',
      '@codingame/monaco-vscode-extension-api',
      '@codingame/monaco-vscode-base-service-override',
      '@codingame/monaco-vscode-host-service-override',
      '@codingame/monaco-vscode-extensions-service-override',
      '@codingame/monaco-vscode-files-service-override',
      '@codingame/monaco-vscode-quickaccess-service-override',
      '@codingame/monaco-vscode-configuration-service-override',
      '@codingame/monaco-vscode-environment-service-override',
      '@codingame/monaco-vscode-layout-service-override',
      '@codingame/monaco-vscode-log-service-override',
      '@codingame/monaco-vscode-model-service-override',
      '@codingame/monaco-vscode-editor-service-override',
      '@codingame/monaco-vscode-languages-service-override',
      '@codingame/monaco-vscode-textmate-service-override',
      '@codingame/monaco-vscode-monarch-service-override',
      '@codingame/monaco-vscode-theme-service-override',
      '@codingame/monaco-vscode-theme-defaults-default-extension',
      '@codingame/monaco-vscode-bulk-edit-service-override',
      '@codingame/monaco-vscode-keybindings-service-override',
      '@codingame/monaco-vscode-localization-service-override',
      '@codingame/monaco-vscode-view-common-service-override',
      '@codingame/monaco-vscode-view-banner-service-override',
      '@codingame/monaco-vscode-view-status-bar-service-override',
      '@codingame/monaco-vscode-view-title-bar-service-override',
      '@codingame/monaco-vscode-views-service-override',
      '@codingame/monaco-vscode-workbench-service-override',
    ],
  },

  // monaco-languageclient 的 worker 需使用 es 格式
  worker: {
    format: 'es',
  },

  clearScreen: false,

  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ['**/dist-electron/**', '**/node_modules/**'],
    },
  },

  build: isProduction
    ? {
        minify: 'terser',
        terserOptions: {
          compress: {
            drop_console: false,
            drop_debugger: true,
            passes: 3,
          },
          mangle: {
            toplevel: false,
          },
          format: {
            comments: false,
          },
        },
        sourcemap: false,
      }
    : {},
});