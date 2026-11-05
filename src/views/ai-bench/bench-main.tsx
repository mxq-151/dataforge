/**
 * AI 流式渲染性能基准页 — 独立入口
 *
 * 刻意不经过 App.tsx：基准只需要「AI 时间线 + Monaco」两条链路，
 * 独立入口可以绕开主应用庞大的模块图（调度 DAG / 登录 / 权限等），
 * 让基准在任何环境下都能一键跑起来，也避免与业务模块互相干扰。
 */

import ReactDOM from 'react-dom/client';
import { loader } from '@monaco-editor/react';
import { ensureVscodeApiStarted } from '../../services/lsp/bootstrapVscode';
import { registerAllTextmateLanguages } from '../../services/textmate';
import { AuthProvider } from '../../contexts/AuthContext';
import { DataSourceProvider } from '../../contexts/DataSourceContext';
import { ToastProvider } from '../../components/Toast';
import AIBenchPage from './AIBenchPage';
import './AIBenchPage.css';

const root = document.getElementById('root');
if (!root) throw new Error('缺少 #root 挂载点');

function fatal(message: string): void {
  root!.innerHTML = `<pre style="color:#f48771;padding:16px;white-space:pre-wrap">${message}</pre>`;
}

try {
  // 与 main.tsx 一致：先启动 VS Code 编辑器运行时，再把它交给 @monaco-editor/react
  ensureVscodeApiStarted()
    .then((monaco) => {
      loader.config({ monaco });
      void registerAllTextmateLanguages().catch(() => {
        /* TextMate 注册失败不影响基准 */
      });
      // 刻意不使用 StrictMode：其开发期双渲染会让基准数字翻倍，
      // 而生产构建本来就没有这层开销。
      ReactDOM.createRoot(root!).render(
        <AuthProvider>
          <ToastProvider>
            <DataSourceProvider>
              <AIBenchPage />
            </DataSourceProvider>
          </ToastProvider>
        </AuthProvider>,
      );
    })
    .catch((err: unknown) => {
      fatal('VS Code 编辑器运行时启动失败: ' + String(err));
    });
} catch (err) {
  fatal('基准页初始化失败: ' + String(err));
}
