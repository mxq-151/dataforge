import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initSecurity } from "./utils/security";
import { loader } from "@monaco-editor/react";
import { ensureVscodeApiStarted } from "./services/lsp/bootstrapVscode";
import { registerAllTextmateLanguages } from "./services/textmate";
import { startPeriodicReporting } from "./api/report";

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

// 定时上报：启动立即上报一次，随后每小时上报一次（fire-and-forget，失败静默，不阻塞渲染）
startPeriodicReporting();

// 标记 WebKit（WKWebView / Safari）环境，供 CSS 做平台差异修复
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
