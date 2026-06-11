import { useEffect, useState } from "react";
import { useUI } from "@/stores/ui";
import { api } from "@/lib/api";
import { writeText } from "@/lib/clipboard";
import { SectionHeader } from "../_shared";

export function McpServerSettings() {
  const setToast = useUI((s) => s.setToast);
  const [status, setStatus] = useState<{
    port: number | null;
    token: string | null;
    activeWorkspace: string | null;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [showToken, setShowToken] = useState(false);

  useEffect(() => {
    let alive = true;
    void api
      .mcpStatus()
      .then((s) => alive && setStatus(s))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  const mcpClientSnippet =
    status?.port && status?.token
      ? JSON.stringify(
          {
            mcpServers: {
              markio: {
                command: "node",
                args: [
                  // 用户机器上 markio.app 路径不固定，给个引导占位；
                  // 装好 mcp-server 之后改成实际绝对路径
                  "/absolute/path/to/markio/mcp-server/index.js",
                ],
                env: {
                  MARKIO_MCP_PORT: String(status.port),
                  MARKIO_MCP_TOKEN: status.token,
                },
              },
            },
          },
          null,
          2,
        )
      : "";

  const copySnippet = async () => {
    if (!mcpClientSnippet) return;
    await writeText(mcpClientSnippet);
    setToast({ stage: "done", message: "MCP 客户端配置已复制" });
  };

  const copyEndpoint = async () => {
    if (!status?.port) return;
    await writeText(`http://127.0.0.1:${status.port}`);
    setToast({ stage: "done", message: "端点已复制" });
  };

  const copyToken = async () => {
    if (!status?.token) return;
    await writeText(status.token);
    setToast({ stage: "done", message: "Token 已复制" });
  };

  const MCP_TOOLS = [
    { name: "search_notes", sig: "(query, limit?)", desc: "全文搜索" },
    { name: "get_note", sig: "(path)", desc: "读取笔记内容" },
    { name: "list_notes", sig: "(limit?)", desc: "列出全部笔记" },
    { name: "open_note", sig: "(path)", desc: "在 markio UI 中打开" },
    { name: "get_vault_info", sig: "()", desc: "当前 / 全部 vault" },
  ];

  return (
    <>
      <SectionHeader id="mcp" />

      <div className="settings-card">
        <div className="settings-card-h">状态</div>
        {loading ? (
          <div className="settings-row">
            <div className="settings-row-l">
              <div className="settings-label" style={{ color: "var(--text-3)" }}>
                读取中…
              </div>
            </div>
          </div>
        ) : status?.port ? (
          <>
            <div className="settings-row">
              <div className="settings-row-l">
                <div className="settings-label">端点</div>
                <div className="settings-help" style={{ fontFamily: "var(--font-mono)" }}>
                  http://127.0.0.1:{status.port}
                </div>
              </div>
              <button className="settings-btn" onClick={copyEndpoint}>
                复制
              </button>
            </div>
            <div className="settings-row">
              <div className="settings-row-l">
                <div className="settings-label">Token</div>
                <div className="settings-help" style={{ fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>
                  {showToken
                    ? status.token
                    : status.token
                      ? `${status.token.slice(0, 8)}…${status.token.slice(-4)}`
                      : "(无)"}
                </div>
              </div>
              <button
                className="settings-btn"
                onClick={() => setShowToken((v) => !v)}
              >
                {showToken ? "隐藏" : "显示"}
              </button>
              <button
                className="settings-btn"
                onClick={copyToken}
                disabled={!status.token}
              >
                复制
              </button>
            </div>
            <div className="settings-row">
              <div className="settings-row-l">
                <div className="settings-label">活跃 vault</div>
                <div className="settings-help" style={{ fontFamily: "var(--font-mono)" }}>
                  {status.activeWorkspace ?? "(无；将兜底使用唯一已注册仓库)"}
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="settings-banner warn">
            MCP server 尚未启动；启动失败时请看主进程日志。
          </div>
        )}
      </div>

      <div className="settings-card">
        <div className="settings-card-h">MCP 客户端配置</div>
        <div className="settings-help" style={{ padding: "0 0 10px" }}>
          先在 markio 仓库的 <code>mcp-server/</code> 目录里跑 <code>npm install</code>，
          再把下面 JSON 粘进支持 MCP 的客户端配置文件，并把{" "}
          <code>/absolute/path/to/markio</code> 改成你机器上的实际路径。
        </div>
        <pre className="about-notes" style={{ maxHeight: 280 }}>
          {mcpClientSnippet || "(等待 MCP server 就绪…)"}
        </pre>
        <div className="settings-row settings-row-action">
          <div className="settings-row-l">
            <div className="settings-label">复制 JSON 配置</div>
            <div className="settings-help">
              粘到目标 MCP 客户端的配置文件中
            </div>
          </div>
          <button
            type="button"
            className="settings-btn primary"
            onClick={copySnippet}
            disabled={!mcpClientSnippet}
          >
            复制配置
          </button>
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card-h">暴露的工具</div>
        <ul className="mcp-tools-list">
          {MCP_TOOLS.map((tool) => (
            <li key={tool.name}>
              <code>
                <span className="mcp-tool-name">{tool.name}</span>
                <span className="mcp-tool-sig">{tool.sig}</span>
              </code>
              <span className="mcp-tool-desc">{tool.desc}</span>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
