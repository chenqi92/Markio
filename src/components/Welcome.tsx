import { useEffect, useState } from "react";
import { useSettings } from "@/stores/settings";
import { isDarkTheme } from "@/themes";
import { pickDirectory, pickFile } from "@/lib/api";
import { useWorkspace } from "@/stores/workspace";
import { useTabs } from "@/stores/tabs";

export function Welcome() {
  const theme = useSettings((s) => s.theme);
  const dark = isDarkTheme(theme);
  const addWorkspace = useWorkspace((s) => s.addWorkspace);
  const workspaces = useWorkspace((s) => s.workspaces);
  const setActive = useWorkspace((s) => s.setActive);
  const openPath = useTabs((s) => s.openPath);
  const [logoErr, setLogoErr] = useState(false);

  useEffect(() => setLogoErr(false), [dark]);

  return (
    <div className="welcome">
      {logoErr ? (
        <div className="logo">m</div>
      ) : (
        <img
          src={dark ? "/brand/icon-dark-512.png" : "/brand/icon-light-512.png"}
          alt="markio"
          onError={() => setLogoErr(true)}
          style={{ width: 120, height: 120 }}
        />
      )}
      <h1>markio</h1>
      <p>
        一款本地优先的 Markdown 阅读器。选一个文件夹开始，所有 .md 文件会以仓库形式呈现，
        支持仓库切换、源码 / 分屏 / 阅读三种模式、命令面板与 8 套主题。
      </p>
      <div className="actions">
        <button
          type="button"
          className="btn-primary"
          onClick={async () => {
            const dir = await pickDirectory();
            if (dir) await addWorkspace(dir);
          }}
        >
          打开文件夹…
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={async () => {
            const f = await pickFile([
              { name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd"] },
            ]);
            if (f) await openPath(f);
          }}
        >
          打开单个文件…
        </button>
      </div>
      {workspaces.length > 0 && (
        <div
          style={{
            marginTop: 30,
            display: "flex",
            flexDirection: "column",
            gap: 6,
            width: "min(420px, 100%)",
          }}
        >
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: "var(--text-3)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              marginBottom: 4,
              textAlign: "left",
            }}
          >
            最近打开
          </div>
          {workspaces.slice(0, 5).map((w) => (
            <button
              type="button"
              key={w.id}
              onClick={() => setActive(w.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 12px",
                background: "var(--bg-pane)",
                border: "0.5px solid var(--border)",
                borderRadius: 10,
                width: "100%",
                textAlign: "left",
                cursor: "pointer",
              }}
            >
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 7,
                  background: `linear-gradient(135deg, ${w.color}, var(--accent-2))`,
                  color: "white",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: 700,
                  fontSize: 12,
                  flexShrink: 0,
                }}
              >
                {w.initial}
              </div>
              <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: "var(--text)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {w.name}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--text-3)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {w.path}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
