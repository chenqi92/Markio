import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../ui/Icon";
import { useUI } from "@/stores/ui";
import type { Backlink, OutlineItem } from "@/types";
import { useTabs } from "@/stores/tabs";
import { useWorkspace } from "@/stores/workspace";
import { api } from "@/lib/api";

interface HeadingSpan {
  from: number;
  to: number;
  level: number;
}

/** 扫描 markdown 文本里的 heading（忽略 ``` 围栏内的 `#`），返回每条 heading
 *  的 [from, to) 字符范围；to 是下一个 ≤ 同级 heading 的 from，或 EOF。 */
function computeHeadingSpans(content: string): HeadingSpan[] {
  const lines = content.split("\n");
  const headings: { line: number; level: number; offset: number }[] = [];
  let offset = 0;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (/^\s*```/.test(ln)) inFence = !inFence;
    if (!inFence) {
      const m = /^(#{1,6})[ \t]+\S/.exec(ln);
      if (m) {
        headings.push({ line: i, level: m[1].length, offset });
      }
    }
    offset += ln.length + 1; // +1 for "\n"
  }
  const totalLen = content.length;
  return headings.map((h, i) => {
    let to = totalLen;
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j].level <= h.level) {
        to = headings[j].offset;
        break;
      }
    }
    return { from: h.offset, to, level: h.level };
  });
}

/** 把 from..to 这段挪到 insertBefore 之前（0-based char offset）。
 *  insertBefore 必须不在 [from, to) 内。返回新内容；若条件不成立返回原内容。 */
function moveSection(
  content: string,
  from: number,
  to: number,
  insertBefore: number,
): string {
  if (insertBefore >= from && insertBefore < to) return content;
  const section = content.slice(from, to);
  const without =
    content.slice(0, from) + content.slice(to);
  const adj =
    insertBefore > to ? insertBefore - (to - from) : insertBefore;
  return without.slice(0, adj) + section + without.slice(adj);
}

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
  const [mentions, setMentions] = useState<Backlink[]>([]);
  const [loadingLinks, setLoadingLinks] = useState(false);
  const linksSeqRef = useRef(0);

  useEffect(() => {
    const seq = ++linksSeqRef.current;
    if (tab !== "links" || !file || !ws) {
      setLinks([]);
      setMentions([]);
      setLoadingLinks(false);
      return;
    }
    setLoadingLinks(true);
    Promise.all([
      api.backlinks(ws.path, file.path).catch(() => [] as Backlink[]),
      api.mentions(ws.path, file.path).catch(() => [] as Backlink[]),
    ])
      .then(([bl, mn]) => {
        if (seq !== linksSeqRef.current) return;
        setLinks(bl);
        // 已显式链接的文件路径，从未链接提及里剔除
        const linkedPaths = new Set(bl.map((b) => b.path));
        setMentions(mn.filter((m) => !linkedPaths.has(m.path)));
      })
      .finally(() => {
        if (seq === linksSeqRef.current) setLoadingLinks(false);
      });
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
          <OutlinePanel items={items} />
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

            {!loadingLinks && mentions.length > 0 && (
              <>
                <div className="outline-h" style={{ marginTop: 8 }}>
                  未链接的提及 · {mentions.length} 处
                </div>
                <div style={{ padding: "0 8px 14px" }}>
                  {mentions.map((b, i) => (
                    <button
                      type="button"
                      key={`m-${i}`}
                      className="backlink"
                      onClick={() => openPath(b.path)}
                      title="点击打开 · 这些文件正文裸出现了当前笔记的标题"
                    >
                      <span className="ico" style={{ opacity: 0.5 }}>
                        <Icon name="note" size={13} />
                      </span>
                      <div className="body">
                        <div className="ttl">{b.name}</div>
                        <div className="snip">第 {b.line} 行 · {b.preview}</div>
                      </div>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </aside>
    </>
  );
}

function OutlinePanel({ items }: { items: OutlineItem[] }) {
  const file = useTabs((s) => s.activeTab());
  const updateContent = useTabs((s) => s.updateContent);
  const content = file?.content ?? "";
  const spans = useMemo(() => computeHeadingSpans(content), [content]);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

  const reorder = (sourceIdx: number, targetIdx: number) => {
    if (!file) return;
    if (sourceIdx === targetIdx) return;
    const src = spans[sourceIdx];
    const tgt = spans[targetIdx];
    if (!src || !tgt) return;
    const next = moveSection(content, src.from, src.to, tgt.from);
    if (next !== content) {
      updateContent(file.id, next);
    }
  };

  if (items.length === 0) {
    return (
      <div className="scroll" style={{ flex: 1 }}>
        <div className="outline-h">章节</div>
        <div className="outline-empty">当前文档没有标题</div>
      </div>
    );
  }

  return (
    <div className="scroll" style={{ flex: 1 }}>
      <div className="outline-h">章节 · 拖拽可重排</div>
      <div className="outline-list">
        {items.map((it, ix) => (
          <a
            key={ix}
            href={`#${it.anchor}`}
            draggable={!!spans[ix]}
            className={
              "outline-item lvl-" +
              Math.min(it.level, 4) +
              (overIdx === ix && dragIdx !== ix ? " drop-over" : "") +
              (dragIdx === ix ? " dragging" : "")
            }
            onClick={(e) => {
              e.preventDefault();
              const target = document.getElementById(it.anchor);
              if (target)
                target.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
            onDragStart={(e) => {
              setDragIdx(ix);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              if (dragIdx === null) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (overIdx !== ix) setOverIdx(ix);
            }}
            onDragLeave={() => {
              if (overIdx === ix) setOverIdx(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragIdx !== null) reorder(dragIdx, ix);
              setDragIdx(null);
              setOverIdx(null);
            }}
            onDragEnd={() => {
              setDragIdx(null);
              setOverIdx(null);
            }}
          >
            <span className="num">{ix + 1}</span>
            <span className="text">{it.text}</span>
          </a>
        ))}
      </div>
    </div>
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
