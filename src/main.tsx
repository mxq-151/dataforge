import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initSecurity } from "./utils/security";
import { loader } from "@monaco-editor/react";
import { ensureVscodeApiStarted } from "./services/lsp/bootstrapVscode";
import { registerAllTextmateLanguages } from "./services/textmate";

// ═══════════════════════════════════════════════════════════════
// 生产版关键修复：拦截全局 fetch，把绝对 tauri://localhost/... URL
// 转换为相对路径。
//
// 根因：@codingame/monaco-vscode-theme-defaults 在 registerFileUrl 时用
// `new URL("/assets/xxx.json", import.meta.url).toString()` 注册资源 URL。
// 在 Tauri 2 生产版中 import.meta.url = "tauri://localhost/assets/index-xxx.js"，
// 因此注册的 URL 变成绝对 "tauri://localhost/assets/dark_modern-xxx.json"。
// WebKit 的 fetch API 不支持以绝对自定义协议 URL 发起请求（Load failed），
// 但同样的文件用相对路径 fetch("/assets/xxx.json") 却可以正常加载（grammar
// 文件就是用相对路径 fetch 的，全部 200 OK）。
//
// 这里在所有模块加载之前、ensureVscodeApiStarted 之前安装拦截器，确保
// ThemeService / ExtensionResourceLoaderService / RegisteredUriFile.fetch
// 产生的所有 tauri:// 绝对 URL 都被转换为相对路径。
// ═══════════════════════════════════════════════════════════════
(function installTauriFetchInterceptor() {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  const originalFetch = window.fetch.bind(window);
  window.fetch = function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    try {
      let url: string | undefined;
      if (typeof input === 'string') {
        url = input;
      } else if (input instanceof URL) {
        url = input.toString();
      } else if (input && typeof input === 'object' && 'url' in input) {
        url = (input as Request).url;
      }
      if (url) {
        // tauri://localhost/path → /path
        // https://tauri.localhost/path → /path (Windows)
        const tauriMatch = url.match(/^tauri:\/\/localhost\/(.*)$/) || url.match(/^https?:\/\/tauri\.localhost\/(.*)$/);
        if (tauriMatch) {
          const relativePath = '/' + tauriMatch[1];
          if (typeof input === 'string') {
            return originalFetch(relativePath, init);
          } else if (input instanceof URL) {
            return originalFetch(new URL(relativePath, window.location.origin), init);
          } else {
            // Request object: clone with new URL
            const newReq = new Request(relativePath, init);
            return originalFetch(newReq);
          }
        }
      }
    } catch {
      // If interception fails, fall through to original fetch
    }
    return originalFetch(input as RequestInfo | URL, init);
  } as typeof window.fetch;
  console.log('[fetch-interceptor] 已安装 tauri:// → 相对路径 拦截器');
})();

// 使用「真正的 VS Code 编辑器」(@codingame/monaco-vscode-editor-api) 作为 Monaco 实例，
// 而不是自带一份轻量 monaco。这与 VS Code 完全一致，也是 monaco-languageclient
// （官方 LSP client，即 vscode-languageclient 的 Web 移植）所期望的运行时。
// 初始化（MonacoVscodeApiWrapper.start）是异步的，必须在渲染前完成。
ensureVscodeApiStarted()
  .then((monaco) => {
    console.log('[main] VS Code 编辑器运行时就绪，开始配置 loader 并注册 TextMate 语法');
    loader.config({ monaco });
    // 通过 VS Code 扩展贡献机制注册 TextMate 语法高亮（java/scala/sql 等）。
    // 必须在编辑器运行时就绪后调用；注册是全局且幂等的。
    registerAllTextmateLanguages().catch((err) => {
      console.warn("[main] TextMate 语法注册失败:", err);
    });
  })
  .catch((err) => {
    console.error("[main] 初始化 VS Code 编辑器运行时失败:", err);
  });

initSecurity();

// 标记 WKWebView（Tauri app / WebKit），供 CSS 做平台差异修复
// （如选区高亮外溢到相邻行，见 EditorArea.css 的 .is-webkit 区块）。
const isWebKit = /AppleWebKit\//.test(navigator.userAgent)
  && !/Chrome\//.test(navigator.userAgent)
  && !/CriOS\//.test(navigator.userAgent)
  && !/Edg(e|A|iOS)?\//.test(navigator.userAgent)
  && !/Firefox\//.test(navigator.userAgent);
document.documentElement.classList.toggle('is-webkit', isWebKit);

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // L16 修复：生产环境不打印完整错误到控制台，仅记录错误名
    if (import.meta.env.DEV) {
      console.error("[AppErrorBoundary] Uncaught error:", error, errorInfo);
    }
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: "100vh",
            width: "100vw",
            backgroundColor: "#1e1e1e",
            color: "#ccc",
            fontFamily:
              "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
            padding: "40px",
            boxSizing: "border-box",
          }}
        >
          <div
            style={{
              fontSize: "48px",
              marginBottom: "16px",
            }}
          >
            ⚠️
          </div>
          <h1
            style={{
              fontSize: "20px",
              fontWeight: 600,
              color: "#e0e0e0",
              marginBottom: "12px",
            }}
          >
            应用加载出错
          </h1>
          <p
            style={{
              fontSize: "13px",
              color: "#888",
              marginBottom: "8px",
              textAlign: "center",
              maxWidth: "500px",
              lineHeight: 1.6,
            }}
          >
            应用在启动过程中遇到了错误，请尝试刷新页面。如果问题持续存在，请联系管理员。
          </p>
          <pre
            style={{
              fontSize: "12px",
              color: "#f48771",
              backgroundColor: "#2d2d2d",
              padding: "12px 16px",
              borderRadius: "6px",
              maxWidth: "600px",
              maxHeight: "200px",
              overflow: "auto",
              marginBottom: "20px",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            {import.meta.env.DEV ? (this.state.error?.message || "未知错误") : "应用遇到内部错误，请刷新页面或联系管理员。"}
          </pre>
          <button
            onClick={this.handleReload}
            style={{
              padding: "8px 24px",
              fontSize: "14px",
              backgroundColor: "#0078d4",
              color: "#fff",
              border: "none",
              borderRadius: "4px",
              cursor: "pointer",
              fontWeight: 500,
            }}
          >
            重新加载
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>,
);
