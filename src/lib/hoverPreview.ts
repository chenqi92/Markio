// wikilink 悬浮预览：鼠标停在预览区里已解析的 a.wikilink[data-path]（含嵌入卡片头）
// 上 ~400ms 后，弹出目标笔记前若干行的渲染结果。纯附加——不改链接本身的渲染。
//
// 取数走 api.open + api.renderMarkdown（本地图片已内联），按路径缓存渲染结果。
// 弹卡挂在 document.body 上（避免被预览区 overflow 裁切），position: fixed。

import { api } from "@/lib/api";

export interface HoverPreviewHandle {
  disconnect(): void;
}

const SHOW_DELAY = 380;
const HIDE_DELAY = 180;
const MAX_LINES = 40;

/** 取笔记正文前若干行作悬浮预览：去掉 frontmatter，超出行数补省略号。 */
export function previewSnippet(markdown: string, maxLines = MAX_LINES): string {
  let md = markdown;
  const fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(md);
  if (fm && fm.index === 0) md = md.slice(fm[0].length);
  const lines = md.split("\n");
  if (lines.length <= maxLines) return md.trim();
  return `${lines.slice(0, maxLines).join("\n").trim()}\n\n…`;
}

/**
 * 给 root 下的 wikilink 装上悬浮预览。返回 handle，disconnect 解绑并移除弹卡。
 */
export function attachWikilinkHover(root: HTMLElement): HoverPreviewHandle {
  const doc = root.ownerDocument ?? document;
  let pop: HTMLElement | null = null;
  let showTimer = 0;
  let hideTimer = 0;
  let currentLink: HTMLElement | null = null;
  let reqSeq = 0;
  let disposed = false;
  const cache = new Map<string, string>();

  function ensurePop(): HTMLElement {
    if (pop) return pop;
    const el = doc.createElement("div");
    el.className = "wiki-hover-card";
    el.setAttribute("role", "tooltip");
    // 鼠标移进弹卡时取消隐藏，方便阅读（但弹卡本身不抢焦点）
    el.addEventListener("mouseenter", () => window.clearTimeout(hideTimer));
    el.addEventListener("mouseleave", scheduleHide);
    doc.body.appendChild(el);
    pop = el;
    return el;
  }

  function position(link: HTMLElement) {
    if (!pop) return;
    const r = link.getBoundingClientRect();
    const margin = 6;
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    let top = r.bottom + margin;
    if (top + ph > window.innerHeight - 8 && r.top - margin - ph > 8) {
      top = r.top - margin - ph;
    }
    let left = r.left;
    if (left + pw > window.innerWidth - 8) left = window.innerWidth - 8 - pw;
    if (left < 8) left = 8;
    pop.style.top = `${Math.max(8, top)}px`;
    pop.style.left = `${left}px`;
  }

  function hide() {
    window.clearTimeout(showTimer);
    window.clearTimeout(hideTimer);
    currentLink = null;
    if (pop) pop.style.display = "none";
  }

  function scheduleHide() {
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(hide, HIDE_DELAY) as unknown as number;
  }

  async function fill(link: HTMLElement, path: string) {
    const el = ensurePop();
    const name = path.split(/[\\/]/).pop() ?? path;
    const head = `<div class="wiki-hover-head">${escapeHtml(name)}</div>`;
    if (cache.has(path)) {
      el.innerHTML = head + `<div class="wiki-hover-body">${cache.get(path)}</div>`;
      el.style.display = "block";
      position(link);
      return;
    }
    el.innerHTML = head + `<div class="wiki-hover-body wiki-hover-loading">载入中…</div>`;
    el.style.display = "block";
    position(link);
    const seq = ++reqSeq;
    try {
      const opened = await api.open(path);
      if (disposed || seq !== reqSeq || currentLink !== link) return;
      const rendered = await api.renderMarkdown(previewSnippet(opened.content), path);
      if (disposed || seq !== reqSeq || currentLink !== link) return;
      cache.set(path, rendered.html);
      el.innerHTML = head + `<div class="wiki-hover-body">${rendered.html}</div>`;
      position(link);
    } catch {
      if (disposed || seq !== reqSeq || currentLink !== link) return;
      el.innerHTML = head + `<div class="wiki-hover-body wiki-hover-loading">无法加载预览</div>`;
      position(link);
    }
  }

  const onOver = (e: MouseEvent) => {
    const link = (e.target as HTMLElement | null)?.closest<HTMLElement>(
      "a.wikilink[data-path]",
    );
    if (!link) return;
    if (link === currentLink) {
      window.clearTimeout(hideTimer);
      return;
    }
    const path = link.getAttribute("data-path");
    if (!path) return;
    window.clearTimeout(hideTimer);
    window.clearTimeout(showTimer);
    currentLink = link;
    showTimer = window.setTimeout(() => {
      if (currentLink === link) void fill(link, path);
    }, SHOW_DELAY) as unknown as number;
  };

  const onOut = (e: MouseEvent) => {
    const link = (e.target as HTMLElement | null)?.closest<HTMLElement>(
      "a.wikilink[data-path]",
    );
    if (!link) return;
    // 移到弹卡上不算离开
    const to = e.relatedTarget as HTMLElement | null;
    if (to && pop && pop.contains(to)) return;
    window.clearTimeout(showTimer);
    scheduleHide();
  };

  const onScroll = () => hide();
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") hide();
  };

  root.addEventListener("mouseover", onOver);
  root.addEventListener("mouseout", onOut);
  root.addEventListener("scroll", onScroll, { passive: true, capture: true });
  doc.addEventListener("keydown", onKey);

  return {
    disconnect() {
      disposed = true;
      root.removeEventListener("mouseover", onOver);
      root.removeEventListener("mouseout", onOut);
      root.removeEventListener("scroll", onScroll, { capture: true } as EventListenerOptions);
      doc.removeEventListener("keydown", onKey);
      window.clearTimeout(showTimer);
      window.clearTimeout(hideTimer);
      pop?.remove();
      pop = null;
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
