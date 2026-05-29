// Line-anchored scroll sync between SourceEditor (CodeMirror) and Preview.
//
// Rust emits `data-line="N"` on every top-level block in the rendered HTML.
// We collect those into a sorted (line, top) anchor list, then linearly
// interpolate to convert between source lines and preview scrollTop. Compared
// to plain percentage sync, this stays
// accurate when source and rendered heights differ wildly (long code blocks,
// math/mermaid, dense tables).

/**
 * Sync against a stable point inside the viewport instead of the exact top.
 * The top edge is often whitespace, the tail of the previous block, or the
 * first line of a dense table; a shallow in-viewport probe better matches the
 * content users visually treat as "current".
 */
export const SCROLL_SYNC_VIEWPORT_RATIO = 0.22;

export interface LineAnchor {
  /** 1-indexed source line for the block. */
  line: number;
  /** Top of the block in scroll coordinates (0 = top of scrollHeight). */
  top: number;
  /** Headings define stable section boundaries; terminal is the document end. */
  kind?: "heading" | "terminal";
}

export interface ScrollInfo {
  top: number;
  height: number;
  clientHeight: number;
  /** Fractional source line at the viewport top, when computable. */
  topLine?: number;
}

export interface ScrollTarget {
  nonce: number;
  /** Preferred: align this fractional source line to the viewport top. */
  line?: number;
  /** Fallback: percentage of total scroll (0..1). */
  ratio?: number;
}

/**
 * Collect anchors from a rendered preview subtree.
 * Sorted by line ascending. Falls back to whatever order it finds them
 * (which is doc order ≡ line order ≡ top order in practice).
 */
export function buildPreviewAnchors(
  container: HTMLElement,
  totalLines?: number,
): LineAnchor[] {
  const els = container.querySelectorAll<HTMLElement>("[data-line]");
  if (els.length === 0) return [];
  const containerRect = container.getBoundingClientRect();
  const baseY = containerRect.top - container.scrollTop;
  const anchors: LineAnchor[] = [];
  const pushAnchor = (line: number, el: HTMLElement, kind?: LineAnchor["kind"]) => {
    if (!Number.isFinite(line) || line <= 0) return;
    const rect = el.getBoundingClientRect();
    const anchor: LineAnchor = { line, top: rect.top - baseY };
    if (kind) anchor.kind = kind;
    anchors.push(anchor);
  };
  for (const el of Array.from(els)) {
    const line = Number(el.getAttribute("data-line"));
    const tag = el.tagName.toUpperCase();
    pushAnchor(line, el, /^H[1-6]$/.test(tag) ? "heading" : undefined);
    if (el.tagName !== "TABLE" || !Number.isFinite(line) || line <= 0) continue;
    const headRow = el.querySelector<HTMLElement>("thead tr");
    if (headRow) pushAnchor(line, headRow);
    const bodyRows = el.querySelectorAll<HTMLElement>("tbody tr");
    bodyRows.forEach((row, index) => {
      // GFM table source lines are: header, separator, then body rows.
      pushAnchor(line + 2 + index, row);
    });
  }
  if (typeof totalLines === "number" && Number.isFinite(totalLines) && totalLines > 0) {
    anchors.push({
      line: totalLines + 1,
      top: container.scrollHeight,
      kind: "terminal",
    });
  }
  // Defensive sort; pulldown-cmark emits in doc order so this is usually a no-op.
  anchors.sort((a, b) => a.line - b.line);
  // Drop duplicates / non-monotonic anchors so binary search stays well-defined.
  const deduped: LineAnchor[] = [];
  for (const a of anchors) {
    const last = deduped[deduped.length - 1];
    if (last && last.line === a.line) continue;
    if (last && a.top < last.top) continue;
    deduped.push(a);
  }
  return deduped;
}

function syncAnchors(anchors: LineAnchor[]): LineAnchor[] {
  const sectionAnchors = anchors.filter(
    (anchor) => anchor.kind === "heading" || anchor.kind === "terminal",
  );
  return sectionAnchors.length >= 2 ? sectionAnchors : anchors;
}

/**
 * Given anchors and a current scrollTop, return the (fractional) source line
 * at the viewport top. Uses linear interpolation between adjacent anchors so
 * scrolling within a long block still maps smoothly.
 */
export function topLineFromScroll(
  anchors: LineAnchor[],
  scrollTop: number,
): number | null {
  anchors = syncAnchors(anchors);
  if (anchors.length === 0) return null;
  if (scrollTop <= anchors[0]!.top) return anchors[0]!.line;
  const last = anchors[anchors.length - 1]!;
  if (scrollTop >= last.top) return last.line;
  let lo = 0;
  let hi = anchors.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (anchors[mid]!.top <= scrollTop) lo = mid;
    else hi = mid;
  }
  const a = anchors[lo]!;
  const b = anchors[hi]!;
  if (b.top === a.top) return a.line;
  const ratio = (scrollTop - a.top) / (b.top - a.top);
  return a.line + ratio * (b.line - a.line);
}

/**
 * Inverse of `topLineFromScroll`: given a desired top line, return the
 * scrollTop that aligns that line to the viewport top.
 */
export function scrollPosForLine(
  anchors: LineAnchor[],
  line: number,
): number | null {
  anchors = syncAnchors(anchors);
  if (anchors.length === 0) return null;
  if (line <= anchors[0]!.line) return anchors[0]!.top;
  const last = anchors[anchors.length - 1]!;
  if (line >= last.line) return last.top;
  let lo = 0;
  let hi = anchors.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (anchors[mid]!.line <= line) lo = mid;
    else hi = mid;
  }
  const a = anchors[lo]!;
  const b = anchors[hi]!;
  if (b.line === a.line) return a.top;
  const ratio = (line - a.line) / (b.line - a.line);
  return a.top + ratio * (b.top - a.top);
}

/** Percentage fallback when no anchors are available. */
export function scrollRatio(info: {
  top: number;
  height: number;
  clientHeight: number;
}): number {
  const max = Math.max(0, info.height - info.clientHeight);
  return max <= 0 ? 0 : Math.max(0, Math.min(1, info.top / max));
}
