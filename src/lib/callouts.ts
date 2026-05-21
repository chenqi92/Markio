const CALLOUT_TITLES: Record<string, string> = {
  note: "备注",
  abstract: "摘要",
  summary: "摘要",
  tldr: "摘要",
  info: "信息",
  todo: "待办",
  tip: "提示",
  hint: "提示",
  important: "重要",
  success: "成功",
  check: "完成",
  done: "完成",
  question: "问题",
  help: "帮助",
  faq: "问题",
  warning: "警告",
  caution: "注意",
  attention: "注意",
  danger: "危险",
  error: "错误",
  bug: "问题",
  example: "示例",
  quote: "引用",
};

const CALLOUT_ALIASES: Record<string, string> = {
  hint: "tip",
  important: "important",
  caution: "warning",
  attention: "warning",
  error: "danger",
  check: "success",
  done: "success",
  help: "question",
  faq: "question",
  abstract: "note",
  summary: "note",
  tldr: "note",
};

const markerRe = /^\s*\[!([a-zA-Z][\w-]*)\]([+-])?(?:[ \t]+([^\r\n]+))?(?:\r?\n)?/;

function firstTextNode(root: HTMLElement): Text | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (parent?.closest("pre,code,script,style")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  return walker.nextNode() as Text | null;
}

function removeEmptyLeadingParagraph(blockquote: HTMLElement) {
  const first = blockquote.firstElementChild;
  if (first?.tagName === "P" && !first.textContent?.trim() && first.children.length === 0) {
    first.remove();
  }
}

function enhanceCalloutBlockquote(blockquote: HTMLElement): boolean {
  if (blockquote.dataset.calloutEnhanced) return false;
  const textNode = firstTextNode(blockquote);
  if (!textNode) return false;
  const match = textNode.nodeValue?.match(markerRe);
  if (!match) return false;

  const rawType = match[1]!.toLowerCase();
  const type = CALLOUT_ALIASES[rawType] ?? rawType;
  const title =
    match[3]?.trim() ||
    CALLOUT_TITLES[rawType] ||
    CALLOUT_TITLES[type] ||
    rawType.toUpperCase();
  const fold = match[2] ?? "";

  textNode.nodeValue = (textNode.nodeValue ?? "").slice(match[0].length).replace(/^\s+/, "");
  removeEmptyLeadingParagraph(blockquote);

  const doc = blockquote.ownerDocument ?? document;
  const head = doc.createElement("div");
  head.className = "callout-head";
  const label = doc.createElement("span");
  label.className = "callout-label";
  label.textContent = type.toUpperCase();
  const titleEl = doc.createElement("span");
  titleEl.className = "callout-title";
  titleEl.textContent = title;
  head.append(label, titleEl);

  blockquote.classList.add("callout", `callout-${type}`);
  blockquote.dataset.calloutEnhanced = "1";
  blockquote.dataset.calloutType = type;
  if (fold) blockquote.dataset.calloutFold = fold;
  blockquote.prepend(head);
  return true;
}

/**
 * Eager: walk the whole subtree and enhance every callout. Use for export,
 * tests, or small docs.
 */
export function enhanceCallouts(root: HTMLElement) {
  root
    .querySelectorAll<HTMLElement>("blockquote:not([data-callout-enhanced])")
    .forEach(enhanceCalloutBlockquote);
}

export interface CalloutEnhanceHandle {
  disconnect(): void;
  flushAll(): void;
}

const noop = () => undefined;

/**
 * Lazy: enhance only callouts that are currently in (or near) the viewport;
 * the rest are enhanced on scroll-in via IntersectionObserver.
 *
 * Why two stages: callouts change visual style (border, ::before icon,
 * inserted header). If the first-paint set isn't enhanced synchronously,
 * the user sees a brief flicker as styles snap in. So:
 *   1. `getBoundingClientRect()` filter → sync-enhance visible set (no flicker)
 *   2. IO observes the rest → enhance on scroll-in
 *
 * Falls back to immediate full enhancement when IO is unavailable.
 *
 * @param options.viewportHeight   Inject for tests; defaults to window.innerHeight.
 * @param options.rootMargin       IO rootMargin; defaults to "200px 0px".
 * @param options.visibilityMargin Extra px above/below the viewport that counts
 *                                  as "visible-now" for stage 1. Default 200.
 */
export function enhanceCalloutsLazy(
  root: HTMLElement,
  options: {
    rootMargin?: string;
    viewportHeight?: number;
    visibilityMargin?: number;
  } = {},
): CalloutEnhanceHandle {
  const all = Array.from(
    root.querySelectorAll<HTMLElement>("blockquote:not([data-callout-enhanced])"),
  );
  if (all.length === 0) return { disconnect: noop, flushAll: noop };

  const viewportH =
    options.viewportHeight ??
    (typeof window !== "undefined" && typeof window.innerHeight === "number"
      ? window.innerHeight
      : 0);
  const margin = options.visibilityMargin ?? 200;

  // Stage 1: enhance currently-visible blockquotes synchronously — no flicker.
  const pending: HTMLElement[] = [];
  for (const bq of all) {
    const rect = bq.getBoundingClientRect();
    const visible = rect.bottom >= -margin && rect.top <= viewportH + margin;
    if (visible) {
      enhanceCalloutBlockquote(bq);
    } else {
      pending.push(bq);
    }
  }

  if (pending.length === 0) return { disconnect: noop, flushAll: noop };

  const IO =
    typeof globalThis !== "undefined" && "IntersectionObserver" in globalThis
      ? (globalThis as typeof window).IntersectionObserver
      : null;

  if (!IO) {
    for (const bq of pending) enhanceCalloutBlockquote(bq);
    return { disconnect: noop, flushAll: noop };
  }

  const observer = new IO(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const bq = entry.target as HTMLElement;
        enhanceCalloutBlockquote(bq);
        observer.unobserve(bq);
      }
    },
    { rootMargin: options.rootMargin ?? "200px 0px" },
  );

  for (const bq of pending) observer.observe(bq);

  return {
    disconnect: () => observer.disconnect(),
    flushAll: () => {
      observer.disconnect();
      for (const bq of pending) enhanceCalloutBlockquote(bq);
    },
  };
}
