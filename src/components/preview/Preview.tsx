import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "@/lib/api";
import { enhanceCalloutsLazy, type CalloutEnhanceHandle } from "@/lib/callouts";
import {
  buildPreviewAnchors,
  SCROLL_SYNC_VIEWPORT_RATIO,
  scrollPosForLine,
  topLineFromScroll,
  type LineAnchor,
} from "@/lib/scrollSync";
import {
  registerPane as registerScrollPane,
  syncPreviewToSource,
} from "@/lib/splitScrollSync";
import { perfMeasure, perfMeasureAsync } from "@/lib/perfMarks";
import {
  mergePreviewVisualSnapshot,
  restorePreviewVisualBlocks,
} from "@/lib/previewVisualCache";
import { patchPreviewDom } from "@/lib/previewDomPatch";
import { renderChartsLazy } from "@/lib/charts";
import { enhanceCodeBlocks } from "@/lib/code-blocks";
import { renderDiagramsLazy } from "@/lib/diagrams";
import { enhanceMarkdownImages } from "@/lib/markdown-images";
import { renderMathLazy } from "@/lib/math";
import { renderMermaidLazy } from "@/lib/mermaid";
import {
  blockExternalImages,
  unblockAllRemoteImages,
  LOAD_ALL_REMOTE_IMAGES_EVENT,
} from "@/lib/remoteImageGuard";
import type { VisualBlockHandle } from "@/lib/visualScheduler";
import { enhanceWikiLinksLazy, type WikiEnhanceHandle } from "@/lib/wikilinks";
import type { OutlineItem } from "@/types";
import { useSettings } from "@/stores/settings";
import { useTabs } from "@/stores/tabs";
import { useUI } from "@/stores/ui";
import { useVaultIndex } from "@/stores/vaultIndex";
import { useWorkspace } from "@/stores/workspace";
import { parseFrontmatter } from "@/lib/frontmatter";
import { findTextRanges } from "@/lib/findText";
import { openExternal } from "@/lib/opener";
import {
  hydrateMarkdownTaskCheckboxes,
  toggleMarkdownTaskLine,
} from "@/lib/markdownTasks";
import {
  inspectPreviewClick,
  type PreviewClickInfo,
} from "@/lib/preview-context-menu";
import { KanbanView } from "./KanbanView";
import { ListView } from "./ListView";
import { GraphView } from "./GraphView";

interface Props {
  source: string;
  basePath?: string;
  onMeta?: (meta: { outline: OutlineItem[]; words: number; readingMinutes: number }) => void;
  /** 行号跳转的一次性目标。分屏滚动同步走 splitScrollSync 不经过这里。 */
  scrollTarget?: import("@/lib/scrollSync").ScrollTarget | null;
  /** 仅分屏模式启用源码 ↔ 预览滚动同步。 */
  syncScroll?: boolean;
  /** kanban 等可写视图回写 source */
  onSourceChange?: (next: string) => void;
  /** 鼠标悬停在渲染后的表格上时上报；index 是 doc 顺序 */
  onTableHover?: (info: { index: number; rect: DOMRect } | null) => void;
  /** 右键 / hover-加号 触发：上报 doc 顺序的 table index、行列、屏幕坐标 */
  onTableCellContext?: (
    info: {
      tableIndex: number;
      row: number;
      col: number;
      x: number;
      y: number;
    },
  ) => void;
  /** 快捷"行 / 列加号"触发：在指定位置插入空行 / 空列（无需打开 menu） */
  onTableQuickAdd?: (
    info: {
      tableIndex: number;
      kind: "row" | "col";
      /** 插入的目标位置（0-based）；row 时 = 在哪行之后插入；col 时 = 在哪列之后插入 */
      after: number;
    },
  ) => void;
  /** 预览侧右键（非表格区域）。Preview 已 preventDefault，宿主只负责弹什么。 */
  onPreviewContextMenu?: (info: {
    coords: { x: number; y: number };
    info: PreviewClickInfo;
  }) => void;
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
  scrollTarget,
  syncScroll = false,
  onSourceChange,
  onTableHover,
  onTableCellContext,
  onTableQuickAdd,
  onPreviewContextMenu,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [html, setHtml] = useState("");
  const sourceRef = useRef(source);
  const onSourceChangeRef = useRef(onSourceChange);
  const fontSize = useSettings((s) => s.fontSize);
  const theme = useSettings((s) => s.theme);
  const themeRef = useRef(theme);
  const visualCacheRef = useRef<Map<string, string>>(new Map());
  const loadRemoteImages = useSettings((s) => s.loadRemoteImages);
  const findQuery = useUI((s) => s.findQuery);
  const findIndex = useUI((s) => s.findIndex);
  const findCaseSensitive = useUI((s) => s.findCaseSensitive);
  const findWholeWord = useUI((s) => s.findWholeWord);
  const findRegex = useUI((s) => s.findRegex);
  const activeWorkspace = useWorkspace((s) =>
    s.workspaces.find((w) => w.id === s.activeId),
  );
  const vaultFiles = useVaultIndex((s) =>
    activeWorkspace ? s.index[activeWorkspace.path]?.files : undefined,
  );

  const fm = useMemo(() => parseFrontmatter(source), [source]);
  const viewKind = fm.data.view?.toLowerCase();

  useEffect(() => {
    sourceRef.current = source;
    onSourceChangeRef.current = onSourceChange;
  }, [source, onSourceChange]);

  useEffect(() => {
    themeRef.current = theme;
  }, [theme]);

  const commitPreviewHtml = useCallback((nextHtml: string, restoreVisuals = true) => {
    if (!restoreVisuals) {
      setHtml(nextHtml);
      return;
    }
    const themeId = themeRef.current;
    mergePreviewVisualSnapshot(visualCacheRef.current, contentRef.current, themeId);
    setHtml(restorePreviewVisualBlocks(nextHtml, visualCacheRef.current, themeId));
  }, []);

  useLayoutEffect(() => {
    patchPreviewDom(contentRef.current, html);
  }, [html]);

  useEffect(() => {
    if (activeWorkspace) {
      void useVaultIndex.getState().ensure(activeWorkspace.path);
    }
  }, [activeWorkspace]);

  const findIndexRef = useRef(findIndex);
  const findCurrentRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    findIndexRef.current = findIndex;
  }, [findIndex]);

  const applyFindCurrent = useCallback((nextIndex: number) => {
    const root = contentRef.current;
    if (!root) return;
    const previous = findCurrentRef.current;
    if (previous?.isConnected) previous.classList.remove("current");
    const hits = root.querySelectorAll<HTMLElement>("mark.find-hit");
    if (hits.length === 0) {
      findCurrentRef.current = null;
      return;
    }
    const safeIdx = Math.max(0, Math.min(hits.length - 1, nextIndex));
    const current = hits[safeIdx]!;
    current.classList.add("current");
    findCurrentRef.current = current;
  }, []);

  const anchorsRef = useRef<LineAnchor[]>([]);

  const applyScrollTarget = useCallback(() => {
    const el = containerRef.current;
    if (!el || !scrollTarget) return;
    let nextTop: number | null = null;
    if (typeof scrollTarget.line === "number" && anchorsRef.current.length > 0) {
      nextTop = scrollPosForLine(anchorsRef.current, scrollTarget.line);
    }
    if (nextTop == null && typeof scrollTarget.ratio === "number") {
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      nextTop = max * Math.max(0, Math.min(1, scrollTarget.ratio));
    }
    if (nextTop == null) return;
    if (Math.abs(el.scrollTop - nextTop) < 1) return;
    // lineJump 是一次性写入；分屏总线会把这次 scroll 同步过去
    el.scrollTop = nextTop;
  }, [scrollTarget]);

  // 表格装饰 = 两层：
  //   (A) DOM 层：html 变化时把每个 <table> 包到 .md-table-host，挂 + 行 / + 列 按钮（无监听）
  //   (B) 事件层：root 上一次性事件委托。新增的 table 自动覆盖，不随表格数量增长。
  // 之前是「每个 table 都 addEventListener 4 次」，50 表 * 多次 rerender 累积可观。
  const tableHandlersRef = useRef({ onTableHover, onTableCellContext, onTableQuickAdd });
  useEffect(() => {
    tableHandlersRef.current = { onTableHover, onTableCellContext, onTableQuickAdd };
  });

  // (A) DOM 装饰：仅 html 变化时跑
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    const tables = Array.from(root.querySelectorAll<HTMLTableElement>("table"));
    const cleanups: Array<() => void> = [];

    tables.forEach((table, index) => {
      table.dataset.mdTableIndex = String(index);

      // 包一层 div 作为定位容器：直接把 <button> 挂到 <table> 是非法 HTML，
      // 浏览器会自动把按钮丢到 <table> 外面，绝对定位就乱掉
      let host: HTMLDivElement;
      if (table.parentElement?.classList.contains("md-table-host")) {
        host = table.parentElement as HTMLDivElement;
      } else {
        const parent = table.parentElement;
        if (!parent) {
          return;
        }
        host = document.createElement("div");
        host.className = "md-table-host";
        parent.insertBefore(host, table);
        host.appendChild(table);
      }
      host.dataset.mdTableIndex = String(index);
      cleanups.push(() => {
        if (host.isConnected && host.parentElement) {
          host.parentElement.insertBefore(table, host);
          host.remove();
        }
      });

      // 快捷加号按钮（DOM only，事件走 root 委托）
      if (!host.querySelector(".md-table-add-row")) {
        const addRowBtn = document.createElement("button");
        addRowBtn.type = "button";
        addRowBtn.className = "md-table-add md-table-add-row";
        addRowBtn.title = "在末尾插入一行";
        addRowBtn.textContent = "+ 行";
        host.appendChild(addRowBtn);

        const addColBtn = document.createElement("button");
        addColBtn.type = "button";
        addColBtn.className = "md-table-add md-table-add-col";
        addColBtn.title = "在末尾插入一列";
        addColBtn.textContent = "+ 列";
        host.appendChild(addColBtn);

        cleanups.push(() => {
          addRowBtn.remove();
          addColBtn.remove();
        });
      }
    });

    return () => {
      cleanups.forEach((fn) => fn());
    };
  }, [html]);

  // (B) 事件委托：根上一次性绑定，根据 target.closest 路由到 table / cell / button
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;

    const cellRowCol = (
      cell: HTMLTableCellElement,
    ): { row: number; col: number } | null => {
      const tr = cell.parentElement;
      if (!tr) return null;
      const col = Array.from(tr.children).indexOf(cell);
      if (col < 0) return null;
      const inHead = !!cell.closest("thead");
      if (inHead) return { row: 0, col };
      const tbody = cell.closest("tbody");
      if (!tbody) return null;
      const bodyRowIdx = Array.from(tbody.children).indexOf(tr as HTMLTableRowElement);
      if (bodyRowIdx < 0) return null;
      return { row: 1 + bodyRowIdx, col };
    };

    const tableIndex = (t: HTMLTableElement): number => {
      const raw = t.dataset.mdTableIndex;
      const n = raw ? Number(raw) : NaN;
      return Number.isFinite(n) ? n : -1;
    };

    let hovered: HTMLTableElement | null = null;
    const onMouseOver = (e: MouseEvent) => {
      const h = tableHandlersRef.current.onTableHover;
      if (!h) return;
      const t = (e.target as HTMLElement | null)?.closest("table") as HTMLTableElement | null;
      if (t === hovered) return;
      hovered = t;
      if (t) {
        h({ index: tableIndex(t), rect: t.getBoundingClientRect() });
      } else {
        h(null);
      }
    };
    const onMouseLeaveRoot = (e: MouseEvent) => {
      if (root.contains(e.relatedTarget as Node)) return;
      const h = tableHandlersRef.current.onTableHover;
      if (h && hovered) h(null);
      hovered = null;
    };
    const onContextMenu = (e: MouseEvent) => {
      const h = tableHandlersRef.current.onTableCellContext;
      if (!h) return;
      const cell = (e.target as HTMLElement | null)?.closest(
        "th, td",
      ) as HTMLTableCellElement | null;
      if (!cell) return;
      const table = cell.closest("table") as HTMLTableElement | null;
      if (!table || !root.contains(table)) return;
      const rc = cellRowCol(cell);
      if (!rc) return;
      e.preventDefault();
      h({
        tableIndex: tableIndex(table),
        row: rc.row,
        col: rc.col,
        x: e.clientX,
        y: e.clientY,
      });
    };
    const onClick = (e: MouseEvent) => {
      const h = tableHandlersRef.current.onTableQuickAdd;
      if (!h) return;
      const btn = (e.target as HTMLElement | null)?.closest(
        ".md-table-add",
      ) as HTMLButtonElement | null;
      if (!btn) return;
      const host = btn.closest(".md-table-host") as HTMLElement | null;
      if (!host) return;
      const idxRaw = host.dataset.mdTableIndex;
      const idx = idxRaw ? Number(idxRaw) : -1;
      if (!Number.isFinite(idx)) return;
      const table = host.querySelector("table") as HTMLTableElement | null;
      if (!table) return;
      e.preventDefault();
      e.stopPropagation();
      if (btn.classList.contains("md-table-add-row")) {
        const bodyRowCount = table.querySelector("tbody")?.children.length ?? 0;
        h({ tableIndex: idx, kind: "row", after: bodyRowCount });
      } else if (btn.classList.contains("md-table-add-col")) {
        const headRow = table.querySelector("thead tr") as HTMLTableRowElement | null;
        const lastBody = table.querySelector("tbody")?.lastElementChild as HTMLTableRowElement | null;
        const colCount = headRow?.children.length ?? lastBody?.children.length ?? 0;
        h({ tableIndex: idx, kind: "col", after: colCount - 1 });
      }
    };

    root.addEventListener("mouseover", onMouseOver);
    root.addEventListener("mouseleave", onMouseLeaveRoot);
    root.addEventListener("contextmenu", onContextMenu);
    root.addEventListener("click", onClick);
    return () => {
      root.removeEventListener("mouseover", onMouseOver);
      root.removeEventListener("mouseleave", onMouseLeaveRoot);
      root.removeEventListener("contextmenu", onContextMenu);
      root.removeEventListener("click", onClick);
    };
  }, []);

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
    const handles: number[] = [];
    let wikiHandle: WikiEnhanceHandle | null = null;
    let calloutHandle: CalloutEnhanceHandle | null = null;
    let chartHandle: VisualBlockHandle | null = null;
    let mathHandle: VisualBlockHandle | null = null;
    let mermaidHandle: VisualBlockHandle | null = null;
    let diagramHandle: VisualBlockHandle | null = null;
    let unblockImages: (() => void) | null = null;

    // 默认拦截 http(s) 图片，避免 canary / 追踪像素。用户在 Settings → 通用
    // 里把 loadRemoteImages 打开后整体放行（不调本函数）。必须在其它 enhance
    // 之前跑——否则浏览器已经发出图片请求，再替换 src 也救不回来。
    if (!loadRemoteImages) {
      unblockImages = blockExternalImages(root);
    }

    // 工具栏「一键加载外链图片」：放行当前预览里所有被拦截的外链图，省去逐张点击。
    const onLoadAllRemote = () => {
      unblockAllRemoteImages(root);
    };
    document.addEventListener(LOAD_ALL_REMOTE_IMAGES_EVENT, onLoadAllRemote);

    // 影响布局的（callouts 改 ::before、span 包裹）必须立刻——否则用户首屏看到的样式会跳
    // 视口内同步增强（零闪烁）；视口外用 IO 等滚动时再增强。
    perfMeasure("preview:enhanceCallouts", () => {
      calloutHandle = enhanceCalloutsLazy(root);
    });
    perfMeasure("preview:enhanceImages", () => enhanceMarkdownImages(root));

    // 其余 enhance 在浏览器空闲帧执行，把首屏渲染让给主线程。
    // requestIdleCallback 在 WebView 上偶尔不可用，setTimeout(16) 兜底（一帧后）。
    const idle = (cb: () => void) => {
      const fn = () => {
        if (!cancelled) cb();
      };
      const h =
        typeof window.requestIdleCallback === "function"
          ? window.requestIdleCallback(fn, { timeout: 500 })
          : (window.setTimeout(fn, 16) as unknown as number);
      handles.push(h);
    };
    idle(() => perfMeasure("preview:enhanceCodeBlocks", () => enhanceCodeBlocks(root)));
    idle(() =>
      perfMeasure("preview:enhanceWikiLinks", () => {
        if (cancelled) return;
        wikiHandle = enhanceWikiLinksLazy(root, vaultFiles);
      }),
    );
    // Charts can be numerous in real notes; schedule them like the heavier
    // visual blocks so startup never renders a chart-heavy document in one go.
    perfMeasure("preview:renderCharts", () => {
      if (cancelled) return;
      chartHandle = renderChartsLazy(root);
    });
    // 重 IO（math 编译 / mermaid svg / graphviz）：viewport-first + 串行 idle
    // 调度。Promise.all 并发跑只会让主线程交错执行，反而拉高单帧峰值。
    perfMeasure("preview:renderMath", () => {
      if (cancelled) return;
      mathHandle = renderMathLazy(root);
    });
    perfMeasure("preview:renderMermaid", () => {
      if (cancelled) return;
      mermaidHandle = renderMermaidLazy(root);
    });
    perfMeasure("preview:renderDiagrams", () => {
      if (cancelled) return;
      diagramHandle = renderDiagramsLazy(root);
    });
    // Rebuild the line→top anchor map after layout is in place. Heavy renders
    // (mermaid SVG, katex, images) settle asynchronously, so we re-collect
    // whenever content size changes — via ResizeObserver on the content root.
    // Debounced because async chunked renders fire many resize events in
    // succession; we only need a stable measurement.
    const container = containerRef.current;
    const content = contentRef.current;
    let rebuildPending = 0;
    const rebuildAnchors = () => {
      if (cancelled || !container) return;
      const totalLines = sourceRef.current.split(/\r?\n/).length;
      anchorsRef.current = buildPreviewAnchors(container, totalLines);
      if (syncScroll) syncPreviewToSource();
    };
    const scheduleRebuild = () => {
      if (rebuildPending) window.clearTimeout(rebuildPending);
      rebuildPending = window.setTimeout(() => {
        rebuildPending = 0;
        rebuildAnchors();
      }, 80) as unknown as number;
    };
    idle(() => {
      rebuildAnchors();
      if (!cancelled) applyScrollTarget();
    });
    let resizeObserver: ResizeObserver | null = null;
    if (content && typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(scheduleRebuild);
      resizeObserver.observe(content);
    }

    return () => {
      cancelled = true;
      for (const h of handles) {
        if (typeof window.cancelIdleCallback === "function") {
          window.cancelIdleCallback(h);
        } else {
          window.clearTimeout(h);
        }
      }
      wikiHandle?.disconnect();
      calloutHandle?.disconnect();
      chartHandle?.disconnect();
      mathHandle?.disconnect();
      mermaidHandle?.disconnect();
      diagramHandle?.disconnect();
      resizeObserver?.disconnect();
      unblockImages?.();
      document.removeEventListener(LOAD_ALL_REMOTE_IMAGES_EVENT, onLoadAllRemote);
      if (rebuildPending) window.clearTimeout(rebuildPending);
    };
  }, [html, theme, applyScrollTarget, vaultFiles, syncScroll, loadRemoteImages]);

  // Find 高亮：扫描文字节点，包 <mark class="find-hit">。
  // 当前命中项单独切换，避免“下一处”时重扫整篇预览。
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    // 撤销旧高亮——直接用 replaceWith(textNode) 原地替换；不调 parent.normalize()，
    // 大结果集（500+ 处）逐个 normalize 累计 300ms+ 阻塞，且仅是合并冗余文本节点，
    // 不影响显示也不影响下次 walker 的 SHOW_TEXT 遍历。
    const oldHits = root.querySelectorAll("mark.find-hit");
    for (const m of oldHits) {
      m.replaceWith(document.createTextNode(m.textContent ?? ""));
    }
    findCurrentRef.current = null;
    if (!findQuery) return;
    let count = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue) return NodeFilter.FILTER_REJECT;
        if (
          (n.parentElement?.closest("pre,code,script,style,mark.find-hit") ?? null) !==
          null
        )
          return NodeFilter.FILTER_REJECT;
        return findTextRanges(n.nodeValue, findQuery, {
          caseSensitive: findCaseSensitive,
          wholeWord: findWholeWord,
          regex: findRegex,
          maxMatches: 1,
        }).matches.length > 0
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });
    const targets: Text[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) targets.push(node as Text);
    for (const t of targets) {
      const v = t.nodeValue ?? "";
      const result = findTextRanges(v, findQuery, {
        caseSensitive: findCaseSensitive,
        wholeWord: findWholeWord,
        regex: findRegex,
      });
      if (result.error) continue;
      let last = 0;
      const parent = t.parentNode;
      if (!parent) continue;
      // 一次 insertBefore DocumentFragment 比 N 次 insertBefore 单节点便宜
      const frag = document.createDocumentFragment();
      for (const { from, to } of result.matches) {
        if (from > last) frag.appendChild(document.createTextNode(v.slice(last, from)));
        const mark = document.createElement("mark");
        mark.className = "find-hit";
        mark.dataset.idx = String(count);
        mark.textContent = v.slice(from, to);
        frag.appendChild(mark);
        last = to;
        count++;
      }
      if (last < v.length) frag.appendChild(document.createTextNode(v.slice(last)));
      parent.insertBefore(frag, t);
      parent.removeChild(t);
    }
    applyFindCurrent(findIndexRef.current);
  }, [
    html,
    findQuery,
    findCaseSensitive,
    findWholeWord,
    findRegex,
    applyFindCurrent,
  ]);

  useEffect(() => {
    applyFindCurrent(findIndex);
  }, [findIndex, applyFindCurrent]);

  // 稳定 debounce：timer 在整个组件生命周期内只有一个；source 变化时
  // reset timer，先前的渲染如果还没发就直接被替换。
  const timerRef = useRef<number | null>(null);
  const seqRef = useRef(0);
  const hasRenderedOnceRef = useRef(false);
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
    if (viewKind === "kanban" || viewKind === "list" || viewKind === "graph") {
      // 仍需把字数 / 标题大纲算出来给 Outline 用
      const words = fm.body
        .replace(/[`*_#>\-[\]()]/g, "")
        .trim().length;
      const outline: OutlineItem[] = [];
      const lines = fm.body.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i]!.match(/^(#{1,6})\s+(.+?)\s*$/);
        if (m)
          outline.push({
            level: m[1]!.length,
            text: m[2]!.trim(),
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
    // 首次 mount（html 还没填）就立刻渲染，免得切到分屏后右侧空一帧再出现；
    // 已有 html（用户连续输入）时才走 debounce 节流
    const isFirst = !hasRenderedOnceRef.current;
    const renderDelay = isFirst
      ? 0
      : source.length > 100_000
        ? 700
        : source.length > 30_000
          ? 350
          : source.length > 10_000
            ? 180
            : 80;
    timerRef.current = window.setTimeout(async () => {
      timerRef.current = null;
      try {
        if (source.length > 20_000) {
          const chunks: string[] = [];
          const flushChunks = () => {
            flushTimer = null;
            if (cancelled || seq !== seqRef.current) return;
            commitPreviewHtml(chunks.join(""));
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
              commitPreviewHtml(chunks.join(""));
              hasRenderedOnceRef.current = true;
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
        const r = await perfMeasureAsync("preview:renderMarkdown", () =>
          api.renderMarkdown(source, basePath),
        );
        if (seq !== seqRef.current) return; // 期间又输入了，丢弃
        commitPreviewHtml(r.html);
        hasRenderedOnceRef.current = true;
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
  }, [source, basePath, viewKind, fm.body, commitPreviewHtml]);

  // 预览侧用 splitScrollSync 单例总线接入分屏滚动同步。containerRef 既是 scroll
  // 元素也是 anchors 测量基准。viewKind 切换会换 containerRef 指向的元素（kanban /
  // list / graph 都有各自的早返回），所以同时把 viewKind 进依赖触发重注册。
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !syncScroll) {
      registerScrollPane("preview", null);
      return;
    }
    registerScrollPane("preview", {
      el,
      getTopLine: (eventEl) => {
        const anchors = anchorsRef.current;
        if (anchors.length === 0) return null;
        const scrollEl = eventEl === el ? eventEl : el;
        const probeTop =
          scrollEl.scrollTop + scrollEl.clientHeight * SCROLL_SYNC_VIEWPORT_RATIO;
        return topLineFromScroll(anchors, probeTop);
      },
      setTopLine: (line) => {
        const anchors = anchorsRef.current;
        if (anchors.length === 0) return false;
        const target = scrollPosForLine(anchors, line);
        if (target == null || !Number.isFinite(target)) return false;
        const max = Math.max(0, el.scrollHeight - el.clientHeight);
        const next = Math.max(
          0,
          Math.min(max, target - el.clientHeight * SCROLL_SYNC_VIEWPORT_RATIO),
        );
        if (Math.abs(el.scrollTop - next) < 1) return true;
        el.scrollTop = next;
        return true;
      },
      getRatio: () => {
        const max = Math.max(0, el.scrollHeight - el.clientHeight);
        return max <= 0 ? 0 : el.scrollTop / max;
      },
      setRatio: (ratio) => {
        const max = Math.max(0, el.scrollHeight - el.clientHeight);
        const next = max * Math.max(0, Math.min(1, ratio));
        if (Math.abs(el.scrollTop - next) < 1) return;
        el.scrollTop = next;
      },
    });
    return () => registerScrollPane("preview", null);
  }, [viewKind, syncScroll]);

  useEffect(() => {
    applyScrollTarget();
  }, [applyScrollTarget, html]);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    hydrateMarkdownTaskCheckboxes(el, source);
  }, [html, source]);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const toggleTaskCheckbox = (checkbox: HTMLInputElement) => {
      const line = Number(checkbox.dataset.sourceLine);
      if (!Number.isFinite(line)) return;
      const next = toggleMarkdownTaskLine(sourceRef.current, line);
      if (next == null) return;
      sourceRef.current = next;
      const nextLine = next.split(/\r?\n/)[line - 1] ?? "";
      const checked = /^\s*[-*+]\s+\[[xX]\]/.test(nextLine);
      checkbox.checked = checked;
      checkbox.setAttribute(
        "aria-label",
        checked ? "标记为未完成" : "标记为完成",
      );
      onSourceChangeRef.current?.(next);
    };
    const handler = (e: MouseEvent) => {
      const checkbox = (e.target as HTMLElement).closest<HTMLInputElement>(
        'input[type="checkbox"][data-source-line]',
      );
      if (checkbox) {
        e.preventDefault();
        e.stopPropagation();
        toggleTaskCheckbox(checkbox);
        return;
      }
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
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key !== " " && e.key !== "Enter") return;
      const checkbox = (e.target as HTMLElement | null)?.closest<HTMLInputElement>(
        'input[type="checkbox"][data-source-line]',
      );
      if (!checkbox) return;
      e.preventDefault();
      e.stopPropagation();
      toggleTaskCheckbox(checkbox);
    };
    el.addEventListener("click", handler, true);
    el.addEventListener("keydown", keyHandler, true);
    return () => {
      el.removeEventListener("click", handler, true);
      el.removeEventListener("keydown", keyHandler, true);
    };
  }, []);

  // 屏蔽 WebView 原生右键菜单（返回 / 刷新 / 另存为 / 打印），用宿主的 ContextMenu 接管
  const onPreviewContextMenuRef = useRef(onPreviewContextMenu);
  useEffect(() => {
    onPreviewContextMenuRef.current = onPreviewContextMenu;
  });
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: MouseEvent) => {
      // 任何情况下都屏蔽 WebView 原生菜单。
      e.preventDefault();
      e.stopPropagation();
      // 表格 cell 的右键已经在内层 (.preview) 上由 onTableCellContext 接管，
      // 那条路径会自己派发到源码侧的 TableContextMenu；这里只兜底不再额外弹。
      if (e.target instanceof Element && e.target.closest("table")) return;
      const info = inspectPreviewClick(e.target);
      onPreviewContextMenuRef.current?.({
        coords: { x: e.clientX, y: e.clientY },
        info,
      });
    };
    el.addEventListener("contextmenu", handler);
    return () => el.removeEventListener("contextmenu", handler);
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

  return (
    <div ref={containerRef} className="preview-pane">
      <div
        ref={contentRef}
        className="preview"
        style={{ fontSize }}
      />
    </div>
  );
}
