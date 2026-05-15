import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { enhanceCallouts } from "@/lib/callouts";
import { renderChartsIn } from "@/lib/charts";
import { enhanceCodeBlocks } from "@/lib/code-blocks";
import { renderDiagramsIn } from "@/lib/diagrams";
import { renderMathIn } from "@/lib/math";
import { renderMermaidIn } from "@/lib/mermaid";
import { enhanceWikiLinks } from "@/lib/wikilinks";
import type { OutlineItem } from "@/types";
import { useSettings } from "@/stores/settings";
import { useTabs } from "@/stores/tabs";
import { useUI } from "@/stores/ui";
import { useVaultIndex } from "@/stores/vaultIndex";
import { useWorkspace } from "@/stores/workspace";
import { parseFrontmatter } from "@/lib/frontmatter";
import { openExternal } from "@/lib/opener";
import { KanbanView } from "./KanbanView";
import { ListView } from "./ListView";
import { GraphView } from "./GraphView";
import { GeoMapView } from "./GeoMapView";
import { GlobeView } from "./GlobeView";

interface Props {
  source: string;
  basePath?: string;
  onMeta?: (meta: { outline: OutlineItem[]; words: number; readingMinutes: number }) => void;
  onScroll?: (info: { top: number; height: number; clientHeight: number }) => void;
  scrollTarget?: { ratio: number; nonce: number } | null;
  /** kanban 等可写视图回写 source */
  onSourceChange?: (next: string) => void;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Render markdown by delegating to the Rust backend (pulldown-cmark + syntect),
 * then inject the resulting HTML. The frontend only paints; parsing/highlighting
 * stays in Rust.
 */
export function Preview({
  source,
  basePath,
  onMeta,
  onScroll,
  scrollTarget,
  onSourceChange,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const suppressScrollRef = useRef(false);
  const [html, setHtml] = useState("");
  const fontSize = useSettings((s) => s.fontSize);
  const theme = useSettings((s) => s.theme);
  const findQuery = useUI((s) => s.findQuery);
  const findIndex = useUI((s) => s.findIndex);
  const activeWorkspace = useWorkspace((s) =>
    s.workspaces.find((w) => w.id === s.activeId),
  );
  const vaultFiles = useVaultIndex((s) =>
    activeWorkspace ? s.index[activeWorkspace.path]?.files : undefined,
  );

  const fm = useMemo(() => parseFrontmatter(source), [source]);
  const viewKind = fm.data.view?.toLowerCase();

  useEffect(() => {
    if (activeWorkspace) {
      void useVaultIndex.getState().ensure(activeWorkspace.path);
    }
  }, [activeWorkspace?.path]);

  const applyScrollTarget = useCallback(() => {
    const el = containerRef.current;
    if (!el || !scrollTarget) return;
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    const nextTop = max * Math.max(0, Math.min(1, scrollTarget.ratio));
    if (Math.abs(el.scrollTop - nextTop) < 1) return;
    suppressScrollRef.current = true;
    el.scrollTop = nextTop;
    requestAnimationFrame(() => {
      suppressScrollRef.current = false;
    });
  }, [scrollTarget?.nonce, scrollTarget?.ratio]);

  useEffect(() => {
    if (!contentRef.current) return;
    // 主题切换后强制重绘 mermaid
    contentRef.current
      .querySelectorAll<HTMLElement>(".mermaid-block")
      .forEach((el) => {
        delete el.dataset.rendered;
      });
    const root = contentRef.current;
    let cancelled = false;
    enhanceCallouts(root);
    renderChartsIn(root);
    enhanceCodeBlocks(root);
    enhanceWikiLinks(root, vaultFiles);
    Promise.all([renderMathIn(root), renderMermaidIn(root), renderDiagramsIn(root)])
      .then(() => {
        if (!cancelled) applyScrollTarget();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [html, theme, applyScrollTarget, vaultFiles]);

  // Find 高亮：扫描文字节点，包 <mark class="find-hit"> + 当前项加 .current
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    // 先撤销旧高亮
    root.querySelectorAll("mark.find-hit").forEach((m) => {
      const parent = m.parentNode;
      if (!parent) return;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
      parent.normalize();
    });
    if (!findQuery) return;
    const needle = findQuery.toLowerCase();
    let count = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue) return NodeFilter.FILTER_REJECT;
        if (
          (n.parentElement?.closest("pre,code,script,style,mark.find-hit") ?? null) !==
          null
        )
          return NodeFilter.FILTER_REJECT;
        return n.nodeValue.toLowerCase().includes(needle)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });
    const targets: Text[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) targets.push(node as Text);
    for (const t of targets) {
      const v = t.nodeValue ?? "";
      const lower = v.toLowerCase();
      let last = 0;
      const parent = t.parentNode;
      if (!parent) continue;
      const fragments: Node[] = [];
      let from = 0;
      while ((from = lower.indexOf(needle, last)) !== -1) {
        if (from > last) fragments.push(document.createTextNode(v.slice(last, from)));
        const mark = document.createElement("mark");
        mark.className = "find-hit";
        mark.dataset.idx = String(count);
        mark.textContent = v.slice(from, from + needle.length);
        fragments.push(mark);
        last = from + needle.length;
        count++;
      }
      if (last < v.length) fragments.push(document.createTextNode(v.slice(last)));
      for (const f of fragments) parent.insertBefore(f, t);
      parent.removeChild(t);
    }
    // 当前 idx 加 .current
    const hits = root.querySelectorAll<HTMLElement>("mark.find-hit");
    if (hits.length === 0) return;
    const safeIdx = Math.max(0, Math.min(hits.length - 1, findIndex));
    hits.forEach((h, i) => h.classList.toggle("current", i === safeIdx));
  }, [html, findQuery, findIndex]);

  // 稳定 debounce：timer 在整个组件生命周期内只有一个；source 变化时
  // reset timer，先前的渲染如果还没发就直接被替换。
  const timerRef = useRef<number | null>(null);
  const seqRef = useRef(0);
  const onMetaRef = useRef(onMeta);
  useEffect(() => {
    onMetaRef.current = onMeta;
  }, [onMeta]);

  useEffect(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const seq = ++seqRef.current;
    let cleanupStream: (() => void) | null = null;
    let flushTimer: number | null = null;
    let cancelled = false;
    const clearFlushTimer = () => {
      if (flushTimer != null) {
        window.clearTimeout(flushTimer);
        flushTimer = null;
      }
    };
    // 自定义视图模板（kanban / list / graph）走前端渲染，跳过 Rust HTML 流水线
    if (
      viewKind === "kanban" ||
      viewKind === "list" ||
      viewKind === "graph" ||
      viewKind === "geomap" ||
      viewKind === "globe"
    ) {
      // 仍需把字数 / 标题大纲算出来给 Outline 用
      const words = fm.body
        .replace(/[`*_#>\-\[\]()]/g, "")
        .trim().length;
      const outline: OutlineItem[] = [];
      const lines = fm.body.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^(#{1,6})\s+(.+?)\s*$/);
        if (m)
          outline.push({
            level: m[1].length,
            text: m[2].trim(),
            anchor: `h-${i}`,
          });
      }
      onMetaRef.current?.({
        outline,
        words,
        readingMinutes: Math.max(1, Math.round(words / 500)),
      });
      return;
    }
    const renderDelay =
      source.length > 100_000 ? 350 : source.length > 30_000 ? 180 : 60;
    timerRef.current = window.setTimeout(async () => {
      timerRef.current = null;
      try {
        if (source.length > 30_000) {
          const chunks: string[] = [];
          const flushChunks = () => {
            flushTimer = null;
            if (cancelled || seq !== seqRef.current) return;
            setHtml(chunks.join(""));
          };
          const scheduleFlush = () => {
            if (flushTimer != null) return;
            flushTimer = window.setTimeout(flushChunks, 120);
          };
          const cleanup = await api.renderMarkdownStream(source, basePath, {
            onChunk: (index, chunkHtml) => {
              if (cancelled || seq !== seqRef.current) return;
              chunks[index] = chunkHtml;
              scheduleFlush();
            },
            onDone: (info) => {
              if (cancelled || seq !== seqRef.current) return;
              clearFlushTimer();
              setHtml(chunks.join(""));
              onMetaRef.current?.({
                outline: info.outline,
                words: info.words,
                readingMinutes: info.readingMinutes,
              });
            },
            onError: (message) => {
              if (cancelled || seq !== seqRef.current) return;
              clearFlushTimer();
              setHtml(
                `<pre style="color: var(--text-3); padding: 16px;">渲染失败：${escapeHtml(message)}</pre>`,
              );
            },
          });
          if (cancelled || seq !== seqRef.current) {
            cleanup();
          } else {
            cleanupStream = cleanup;
          }
          return;
        }
        const r = await api.renderMarkdown(source, basePath);
        if (seq !== seqRef.current) return; // 期间又输入了，丢弃
        setHtml(r.html);
        onMetaRef.current?.({
          outline: r.outline,
          words: r.words,
          readingMinutes: r.readingMinutes,
        });
      } catch (e) {
        if (seq !== seqRef.current) return;
        setHtml(
          `<pre style="color: var(--text-3); padding: 16px;">渲染失败：${escapeHtml((e as Error).message)}</pre>`,
        );
      }
    }, renderDelay);
    return () => {
      cancelled = true;
      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      clearFlushTimer();
      cleanupStream?.();
    };
  }, [source, basePath, viewKind, fm.body]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !onScroll) return;
    const handler = () => {
      if (suppressScrollRef.current) return;
      onScroll({
        top: el.scrollTop,
        height: el.scrollHeight,
        clientHeight: el.clientHeight,
      });
    };
    el.addEventListener("scroll", handler, { passive: true });
    return () => el.removeEventListener("scroll", handler);
  }, [onScroll]);

  useEffect(() => {
    applyScrollTarget();
  }, [applyScrollTarget, html]);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const handler = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest("a");
      if (!a) return;
      if (a.classList.contains("wikilink")) {
        e.preventDefault();
        const path = a.getAttribute("data-path");
        if (path) {
          void useTabs.getState().openPath(path);
          return;
        }
        const name = a.getAttribute("data-wiki-target") ?? a.textContent ?? "";
        useUI.getState().setToast({
          stage: "error",
          message: `未找到笔记：${name}`,
        });
        window.setTimeout(() => useUI.getState().setToast(null), 1800);
        return;
      }
      const href = a.getAttribute("href");
      if (!href) return;
      // 内部锚点
      if (href.startsWith("#")) {
        e.preventDefault();
        const id = href.slice(1);
        const target = document.getElementById(id);
        if (target)
          target.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      // 外链
      if (/^https?:\/\//.test(href)) {
        e.preventDefault();
        void openExternal(href);
      }
    };
    el.addEventListener("click", handler);
    return () => el.removeEventListener("click", handler);
  }, []);

  if (viewKind === "kanban") {
    return (
      <div ref={containerRef} className="preview-pane">
        <KanbanView
          body={fm.body}
          source={source}
          filePath={basePath}
          meta={{
            title: fm.data.title ?? basePath?.split(/[\\/]/).pop()?.replace(/\.md$/, ""),
            week: fm.data.week,
            updated: fm.data.updated,
          }}
          onSourceChange={onSourceChange}
        />
      </div>
    );
  }
  if (viewKind === "list") {
    return (
      <div ref={containerRef} className="preview-pane">
        <ListView body={fm.body} title={fm.data.title ?? basePath?.split(/[\\/]/).pop()} />
      </div>
    );
  }
  if (viewKind === "graph") {
    return (
      <div ref={containerRef} className="preview-pane">
        <GraphView title={fm.data.title ?? "知识地图"} />
      </div>
    );
  }
  if (viewKind === "geomap") {
    return (
      <div ref={containerRef} className="preview-pane">
        <GeoMapView body={fm.body} title={fm.data.title ?? "地图"} />
      </div>
    );
  }
  if (viewKind === "globe") {
    return (
      <div ref={containerRef} className="preview-pane">
        <GlobeView body={fm.body} title={fm.data.title ?? "三维地球"} />
      </div>
    );
  }

  return (
    <div ref={containerRef} className="preview-pane">
      <div
        ref={contentRef}
        className="preview"
        style={{ fontSize }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
