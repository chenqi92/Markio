import { useEffect, useState } from "react";
import { Icon } from "../ui/Icon";
import { useUI } from "@/stores/ui";
import type { Backlink, OutlineItem } from "@/types";
import { useTabs } from "@/stores/tabs";
import { useWorkspace } from "@/stores/workspace";
import { api } from "@/lib/api";

export function Outline({
  items,
  words,
  readingMinutes,
}: {
  items: OutlineItem[];
  words: number;
  readingMinutes: number;
}) {
  const closed = !useUI((s) => s.outlineOpen);
  const toggle = useUI((s) => s.toggleOutline);
  const [tab, setTab] = useState<"outline" | "info" | "links">("outline");
  const file = useTabs((s) => s.activeTab());
  const ws = useWorkspace((s) =>
    file ? s.workspaces.find((w) => w.id === file.workspaceId) : undefined,
  );
  const [links, setLinks] = useState<Backlink[]>([]);
  const [loadingLinks, setLoadingLinks] = useState(false);

  useEffect(() => {
    if (tab !== "links" || !file || !ws) {
      return;
    }
    setLoadingLinks(true);
    api
      .backlinks(ws.path, file.path)
      .then(setLinks)
      .catch(() => setLinks([]))
      .finally(() => setLoadingLinks(false));
  }, [tab, file?.path, ws?.path]);

  const openPath = useTabs((s) => s.openPath);

  return (
    <>
      {closed && (
        <button className="outline-reopen" onClick={toggle} type="button">
          大纲 ◂
        </button>
      )}
      <aside className={"outline" + (closed ? " closed" : "")}>
        <div className="outline-tabs">
          <button
            type="button"
            className={"outline-tab" + (tab === "outline" ? " active" : "")}
            onClick={() => setTab("outline")}
          >
            大纲
          </button>
          <button
            type="button"
            className={"outline-tab" + (tab === "info" ? " active" : "")}
            onClick={() => setTab("info")}
          >
            信息
          </button>
          <button
            type="button"
            className={"outline-tab" + (tab === "links" ? " active" : "")}
            onClick={() => setTab("links")}
          >
            链接
          </button>
          <button className="outline-close" onClick={toggle} title="收起">
            <Icon name="x" size={12} />
          </button>
        </div>

        {tab === "outline" && (
          <div className="scroll" style={{ flex: 1 }}>
            <div className="outline-h">章节</div>
            {items.length === 0 ? (
              <div className="outline-empty">当前文档没有标题</div>
            ) : (
              <div className="outline-list">
                {items.map((it, ix) => (
                  <a
                    key={ix}
                    href={`#${it.anchor}`}
                    className={"outline-item lvl-" + Math.min(it.level, 4)}
                    onClick={(e) => {
                      e.preventDefault();
                      const target = document.getElementById(it.anchor);
                      if (target)
                        target.scrollIntoView({ behavior: "smooth", block: "start" });
                    }}
                  >
                    <span className="num">{ix + 1}</span>
                    <span className="text">{it.text}</span>
                  </a>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === "info" && (
          <div className="scroll" style={{ flex: 1, padding: "16px 14px" }}>
            <div className="outline-h" style={{ padding: 0 }}>
              统计
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 10 }}>
              <Metric v={String(words)} l="字数" />
              <Metric v={`${readingMinutes} 分钟`} l="阅读" />
              <Metric v={String(items.length)} l="章节" />
              <Metric v={file ? (file.dirty ? "未保存" : "已保存") : "—"} l="状态" />
            </div>
            <div className="outline-h" style={{ marginTop: 20, padding: 0 }}>
              路径
            </div>
            <div
              style={{
                fontSize: 11,
                color: "var(--text-3)",
                wordBreak: "break-all",
                marginTop: 6,
                lineHeight: 1.6,
                fontFamily: "var(--font-mono)",
                userSelect: "text",
                WebkitUserSelect: "text",
              }}
            >
              {file?.path ?? "—"}
            </div>
          </div>
        )}

        {tab === "links" && (
          <div className="scroll" style={{ flex: 1 }}>
            <div className="outline-h">
              指向此页 · {loadingLinks ? "扫描中" : `${links.length} 处`}
            </div>
            {loadingLinks ? (
              <div className="outline-empty">扫描整个仓库的 [[ 引用…</div>
            ) : links.length === 0 ? (
              <div className="outline-empty">
                还没有任何其它笔记用 <code>[[…]]</code> 引用它。
              </div>
            ) : (
              <div style={{ padding: "0 8px 14px" }}>
                {links.map((b, i) => (
                  <button
                    type="button"
                    key={i}
                    className="backlink"
                    onClick={() => openPath(b.path)}
                  >
                    <span className="ico">
                      <Icon name="note" size={13} />
                    </span>
                    <div className="body">
                      <div className="ttl">{b.name}</div>
                      <div className="snip">第 {b.line} 行 · {b.preview}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </aside>
    </>
  );
}

function Metric({ v, l }: { v: string; l: string }) {
  return (
    <div
      style={{
        background: "var(--bg-pane-2)",
        border: "0.5px solid var(--border)",
        borderRadius: 10,
        padding: "8px 10px",
      }}
    >
      <div
        style={{
          fontSize: 14,
          fontWeight: 700,
          color: "var(--text)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {v}
      </div>
      <div style={{ fontSize: 10, color: "var(--text-3)", marginTop: 4 }}>{l}</div>
    </div>
  );
}
