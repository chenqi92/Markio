import { useEffect, useRef, useState } from "react";

/**
 * 开发期诊断浮窗（只在 dev 构建里挂载，prod 构建因 `import.meta.env.DEV`
 * 短路 + tree-shaking 完全剔除）。
 *
 * - 默认隐藏，不打扰正常使用
 * - 快捷键 ⌘⇧D / Ctrl+Shift+D 切换显示
 * - 显示后会拦截 `console.warn` 里所有 `[markio:diag*]` 开头的消息
 * - 一键 copy 全部日志 / clear / 折叠
 *
 * 用法：当排查 bug 时在调用处加 `console.warn("[markio:diag] ...")`，
 * 然后用快捷键打开面板看现场。
 */
interface DiagEntry {
  ts: number;
  msg: string;
}

export function DiagPanel() {
  const [visible, setVisible] = useState(false);
  const [logs, setLogs] = useState<DiagEntry[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const startedAtRef = useRef<number>(Date.now());
  const listRef = useRef<HTMLDivElement>(null);

  // 拦截 console.warn 收集 [markio:diag*] 消息（无论 visible 都收，
  // 让用户打开面板时能看到此前累积的内容）
  useEffect(() => {
    const orig = console.warn;
    const handler = (...args: unknown[]) => {
      orig.apply(console, args);
      const first = typeof args[0] === "string" ? args[0] : "";
      if (!first.startsWith("[markio:diag")) return;
      const text = args
        .map((a) => {
          if (typeof a === "string") return a;
          if (a instanceof Error) {
            const lines = (a.stack ?? a.message).split("\n").slice(0, 6).join("\n");
            return `\n  ${lines}`;
          }
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        })
        .join(" ");
      setLogs((l) => {
        const next = [...l, { ts: Date.now(), msg: text }];
        return next.length > 200 ? next.slice(-200) : next;
      });
    };
    console.warn = handler as typeof console.warn;
    return () => {
      console.warn = orig;
    };
  }, []);

  // ⌘⇧D / Ctrl+Shift+D 切换显示
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey && (e.key === "D" || e.key === "d")) {
        e.preventDefault();
        setVisible((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (visible && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [logs.length, visible]);

  if (!visible) return null;

  const startedAt = startedAtRef.current;

  return (
    <div
      style={{
        position: "fixed",
        right: 8,
        bottom: 8,
        width: collapsed ? 200 : 520,
        maxHeight: collapsed ? 32 : 360,
        background: "rgba(0,0,0,0.92)",
        color: "#9fffa0",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 11,
        padding: 6,
        borderRadius: 6,
        zIndex: 99999,
        display: "flex",
        flexDirection: "column",
        gap: 4,
        boxShadow: "0 4px 18px rgba(0,0,0,0.4)",
        pointerEvents: "auto",
      }}
    >
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <span style={{ flex: 1, color: "#fff" }}>
          markio diag · {logs.length}
        </span>
        <button
          type="button"
          onClick={() => {
            const dump = logs
              .map(
                (l) =>
                  `+${(l.ts - startedAt).toString().padStart(6)}ms  ${l.msg}`,
              )
              .join("\n");
            void navigator.clipboard.writeText(dump);
          }}
          style={btnStyle}
        >
          copy
        </button>
        <button type="button" onClick={() => setLogs([])} style={btnStyle}>
          clear
        </button>
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          style={btnStyle}
        >
          {collapsed ? "▴" : "▾"}
        </button>
        <button
          type="button"
          onClick={() => setVisible(false)}
          style={btnStyle}
          title="关闭（再按 ⌘⇧D 重开）"
        >
          ✕
        </button>
      </div>
      {!collapsed && (
        <div
          ref={listRef}
          style={{
            overflowY: "auto",
            flex: 1,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            background: "rgba(255,255,255,0.03)",
            padding: 4,
            borderRadius: 4,
          }}
        >
          {logs.length === 0 ? (
            <div style={{ color: "#888", padding: 6 }}>
              暂无 [markio:diag*] 日志。在代码里加 console.warn("[markio:diag] ...") 即可被这里收集。
            </div>
          ) : (
            logs.map((l, i) => (
              <div
                key={i}
                style={{
                  borderTop: i ? "1px solid rgba(255,255,255,0.08)" : "none",
                  padding: "3px 0",
                }}
              >
                <span style={{ color: "#888" }}>
                  +{(l.ts - startedAt).toString().padStart(5)}ms{" "}
                </span>
                {l.msg}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  background: "#2a2a2a",
  color: "#fff",
  border: "1px solid #555",
  padding: "1px 8px",
  cursor: "pointer",
  fontSize: 10,
  borderRadius: 3,
  fontFamily: "inherit",
};
