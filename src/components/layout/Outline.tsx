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
    const ln = lines[i]!;
    if (/^\s*```/.test(ln)) inFence = !inFence;
    if (!inFence) {
      const m = /^(#{1,6})[ \t]+\S/.exec(ln);
      if (m) {
        headings.push({ line: i, level: m[1]!.length, offset });
      }
    }
    offset += ln.length + 1; // +1 for "\n"
  }
  const totalLen = content.length;
  return headings.map((h, i) => {
    let to = totalLen;
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j]!.level <= h.level) {
        to = headings[j]!.offset;
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
  // insertBefore === to（把 A 拖到紧邻的下一段 B 之前）= A 本就在该插入点前，应为
  // no-op。旧实现用 `< to` 漏掉了相等情形，导致 adj 落在错位置，把 B 的内容黏到
  // A 的标题上损坏文档。改为 `<= to` 收口。
  if (insertBefore >= from && insertBefore <= to) return content;
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
  const fileId = useTabs((s) => s.activeId);
  const fileWorkspaceId = useTabs((s) => {
    const id = s.activeId;
    const t = id ? s.tabs.find((x) => x.id === id) : undefined;
    return t?.workspaceId;
  });
  const filePath = useTabs((s) => {
    const id = s.activeId;
    const t = id ? s.tabs.find((x) => x.id === id) : undefined;
    return t?.path;
  });
  const fileDirty = useTabs((s) => {
    const id = s.activeId;
    const t = id ? s.tabs.find((x) => x.id === id) : undefined;
    return t?.dirty ?? false;
  });
  const ws = useWorkspace((s) =>
    fileWorkspaceId ? s.workspaces.find((w) => w.id === fileWorkspaceId) : undefined,
  );
  const [links, setLinks] = useState<Backlink[]>([]);
  const [mentions, setMentions] = useState<Backlink[]>([]);
  const [loadingLinks, setLoadingLinks] = useState(false);
  const linksSeqRef = useRef(0);

  useEffect(() => {
    const seq = ++linksSeqRef.current;
    if (tab !== "links" || !filePath || !ws) {
      setLinks([]);
      setMentions([]);
      setLoadingLinks(false);
      return;
    }
    setLoadingLinks(true);
    Promise.all([
      api.backlinks(ws.path, filePath).catch(() => [] as Backlink[]),
      api.mentions(ws.path, filePath).catch(() => [] as Backlink[]),
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
  }, [tab, filePath, ws]);

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
              <Metric v={fileId ? (fileDirty ? "未保存" : "已保存") : "—"} l="状态" />
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
              {filePath ?? "—"}
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

/** 把 text 按 query (case-insensitive) 切片，命中段用 <mark> 包裹。 */
function highlightText(text: string, queryNorm: string): React.ReactNode {
  if (!queryNorm) return text;
  const lower = text.toLowerCase();
  const out: React.ReactNode[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const idx = lower.indexOf(queryNorm, cursor);
    if (idx === -1) {
      out.push(text.slice(cursor));
      break;
    }
    if (idx > cursor) out.push(text.slice(cursor, idx));
    const end = idx + queryNorm.length;
    out.push(
      <mark key={`m-${idx}`} className="outline-hit">
        {text.slice(idx, end)}
      </mark>,
    );
    cursor = end;
  }
  return out;
}

function OutlinePanel({ items }: { items: OutlineItem[] }) {
  const fileId = useTabs((s) => s.activeId);
  const updateContent = useTabs((s) => s.updateContent);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  // 折叠状态按 item index 存储。新文档默认全展开。
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());
  const searchRef = useRef<HTMLInputElement>(null);

  // 大纲 items 变更时重置折叠态——避免旧索引指向新文档的不同节点
  useEffect(() => {
    setCollapsed(new Set());
  }, [items]);

  // 每个 item 的直接父节点 index（无父则 null）；用栈按 level 推断
  const parentOf = useMemo(() => {
    const parents: Array<number | null> = new Array(items.length).fill(null);
    const stack: number[] = [];
    for (let i = 0; i < items.length; i++) {
      const lv = items[i]!.level;
      while (stack.length > 0 && items[stack[stack.length - 1]!]!.level >= lv) {
        stack.pop();
      }
      parents[i] = stack.length > 0 ? stack[stack.length - 1]! : null;
      stack.push(i);
    }
    return parents;
  }, [items]);

  const hasChildren = useMemo(() => {
    const flags = new Array<boolean>(items.length).fill(false);
    for (const p of parentOf) {
      if (p !== null) flags[p] = true;
    }
    return flags;
  }, [items.length, parentOf]);

  const queryNorm = query.trim().toLowerCase();

  // 命中集合（仅搜索时计算）
  const matchedSet = useMemo(() => {
    if (!queryNorm) return null;
    const set = new Set<number>();
    for (let i = 0; i < items.length; i++) {
      if (items[i]!.text.toLowerCase().includes(queryNorm)) set.add(i);
    }
    return set;
  }, [items, queryNorm]);

  // 可见集合：
  //   搜索：命中项 ∪ 所有祖先链（保留层级上下文）
  //   非搜索：剔除被 collapsed 祖先遮住的
  const visibleSet = useMemo(() => {
    const set = new Set<number>();
    if (matchedSet) {
      for (const idx of matchedSet) {
        set.add(idx);
        let p = parentOf[idx] ?? null;
        while (p !== null) {
          set.add(p);
          p = parentOf[p] ?? null;
        }
      }
      return set;
    }
    for (let i = 0; i < items.length; i++) {
      let hidden = false;
      let p = parentOf[i] ?? null;
      while (p !== null) {
        if (collapsed.has(p)) {
          hidden = true;
          break;
        }
        p = parentOf[p] ?? null;
      }
      if (!hidden) set.add(i);
    }
    return set;
  }, [items.length, parentOf, matchedSet, collapsed]);

  const isExpanded = (idx: number) => {
    // 搜索期强制展开（让用户看到祖先链）
    if (matchedSet) return true;
    return !collapsed.has(idx);
  };

  const toggleCollapse = (idx: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const collapseAll = () => {
    const all = new Set<number>();
    for (let i = 0; i < items.length; i++) {
      if (hasChildren[i]) all.add(i);
    }
    setCollapsed(all);
  };

  const expandAll = () => setCollapsed(new Set());

  const allExpanded = collapsed.size === 0;

  const reorder = (sourceIdx: number, targetIdx: number) => {
    if (!fileId) return;
    if (sourceIdx === targetIdx) return;
    const current = useTabs.getState().tabs.find((t) => t.id === fileId);
    const content = current?.content ?? "";
    const spans = computeHeadingSpans(content);
    // items 来自 Rust 解析器，spans 来自前端正则扫描，两者对 setext / 缩进 / 引用内
    // 标题、YAML 里的 # 等的判定可能不一致。数量对不上时索引无法可靠对齐，
    // 直接拒绝重排，避免移动到错误的 [from,to) 段落静默损坏文档。
    if (spans.length !== items.length) {
      useUI
        .getState()
        .setToast({ stage: "error", message: "该文档标题结构无法安全重排" });
      return;
    }
    const src = spans[sourceIdx];
    const tgt = spans[targetIdx];
    if (!src || !tgt) return;
    const next = moveSection(content, src.from, src.to, tgt.from);
    if (next !== content) {
      updateContent(fileId, next);
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

  // 搜索状态下禁用 drag：可见集合是稀疏的，拖到祖先 vs 拖到命中项之间的语义不直观
  const dragEnabled = !matchedSet;

  return (
    <div className="scroll" style={{ flex: 1 }}>
      <div className="outline-toolbar">
        <div className="outline-search">
          <span className="outline-search-ico">
            <Icon name="search" size={11} />
          </span>
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.preventDefault();
                e.stopPropagation();
                setQuery("");
              }
            }}
            placeholder="过滤章节…"
            spellCheck={false}
          />
          {query && (
            <button
              type="button"
              className="outline-search-clear"
              onClick={() => {
                setQuery("");
                searchRef.current?.focus();
              }}
              title="清空"
            >
              <Icon name="x" size={10} />
            </button>
          )}
        </div>
        <button
          type="button"
          className="outline-toolbar-btn"
          onClick={() => (allExpanded ? collapseAll() : expandAll())}
          title={allExpanded ? "全部折叠" : "全部展开"}
          disabled={!!matchedSet}
        >
          <Icon name={allExpanded ? "chevron" : "chevdown"} size={12} />
        </button>
      </div>
      <div className="outline-h">
        {matchedSet
          ? `命中 ${matchedSet.size} 处`
          : dragEnabled
            ? "章节 · 拖拽可重排"
            : "章节"}
      </div>
      <div className="outline-list">
        {items.map((it, ix) => {
          if (!visibleSet.has(ix)) return null;
          const hasChild = hasChildren[ix];
          const expanded = isExpanded(ix);
          const isMatch = matchedSet?.has(ix) ?? false;
          return (
            <a
              key={ix}
              href={`#${it.anchor}`}
              draggable={dragEnabled}
              className={
                "outline-item lvl-" +
                Math.min(it.level, 4) +
                (overIdx === ix && dragIdx !== ix ? " drop-over" : "") +
                (dragIdx === ix ? " dragging" : "") +
                (isMatch ? " matched" : "") +
                (matchedSet && !isMatch ? " ancestor" : "")
              }
              onClick={(e) => {
                e.preventDefault();
                // 优先按 id 找（preview / split 模式的渲染节点），
                // 找不到再按 data-id 找（所见即所得 BlockNote 模式 —
                // 它给每个 block 容器 DOM 写 data-id={block.id}）
                const target =
                  document.getElementById(it.anchor) ??
                  document.querySelector<HTMLElement>(
                    `[data-id="${CSS.escape(it.anchor)}"]`,
                  );
                if (target)
                  target.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
              onDragStart={(e) => {
                if (!dragEnabled) {
                  e.preventDefault();
                  return;
                }
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
              {hasChild ? (
                <button
                  type="button"
                  className="outline-twist"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    toggleCollapse(ix);
                  }}
                  disabled={!!matchedSet}
                  aria-label={expanded ? "折叠" : "展开"}
                >
                  <Icon name={expanded ? "chevdown" : "chevron"} size={10} />
                </button>
              ) : (
                <span className="outline-twist-spacer" />
              )}
              <span className="num">{ix + 1}</span>
              <span className="text">
                {queryNorm ? highlightText(it.text, queryNorm) : it.text}
              </span>
            </a>
          );
        })}
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
