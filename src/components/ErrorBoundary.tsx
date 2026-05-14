import { Component, type ErrorInfo, type ReactNode } from "react";
import { api, isDesktop } from "@/lib/api";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  message: string;
  stack: string;
}

/**
 * 顶层 ErrorBoundary。
 * 捕获到错误时：
 *   1) 渲染兜底页面，避免白屏
 *   2) 把 message + stack 写到 markio.log（桌面端走 Rust）
 *   3) 不上报到任何远端服务（隐私优先）
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: "", stack: "" };

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      message: error.message || String(error),
      stack: error.stack || "",
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const payload = [
      `[${new Date().toISOString()}] frontend panic`,
      `message: ${error.message}`,
      `stack: ${error.stack ?? "(none)"}`,
      `component: ${info.componentStack ?? "(none)"}`,
      `userAgent: ${typeof navigator !== "undefined" ? navigator.userAgent : "?"}`,
      "",
    ].join("\n");
    if (isDesktop()) {
      api.crashAppend(payload).catch((e) => {
        console.error("[crash] 写日志失败", e);
      });
    } else {
      console.error("[crash]", payload);
    }
  }

  reload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div
        style={{
          padding: 32,
          maxWidth: 720,
          margin: "60px auto",
          fontFamily:
            "var(--font-sans, -apple-system, 'PingFang SC', sans-serif)",
          color: "var(--text, #1d1d1f)",
        }}
      >
        <h1 style={{ fontSize: 22, marginBottom: 8 }}>markio 遇到了错误</h1>
        <div style={{ color: "var(--text-3, #6e6e73)", marginBottom: 16 }}>
          界面已被冻结。已把错误细节写入本地日志，未上传到任何远端。
        </div>
        <pre
          style={{
            background: "var(--bg-1, #f5f5f7)",
            padding: 12,
            borderRadius: 8,
            overflow: "auto",
            fontSize: 12,
            maxHeight: 240,
          }}
        >
          {this.state.message}
          {"\n\n"}
          {this.state.stack}
        </pre>
        <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
          <button
            className="settings-btn primary"
            type="button"
            onClick={this.reload}
          >
            重新加载
          </button>
          <button
            className="settings-btn"
            type="button"
            onClick={() => {
              if (isDesktop()) {
                api.crashOpenDir().catch(() => {
                  /* ignore */
                });
              }
            }}
          >
            打开日志目录
          </button>
        </div>
      </div>
    );
  }
}
