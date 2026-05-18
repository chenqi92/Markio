// Line-anchored scroll sync between SourceEditor (CodeMirror) and Preview.
//
// Rust emits `data-line="N"` on every top-level block in the rendered HTML.
// We collect those into a sorted (line, top) anchor list, then linearly
// interpolate to convert between "source line at viewport top" and
// "preview scrollTop". Compared to plain percentage sync, this stays
// accurate when source and rendered heights differ wildly (long code blocks,
// math/mermaid, dense tables).

export interface LineAnchor {
  /** 1-indexed source line for the block. */
  line: number;
  /** Top of the block in scroll coordinates (0 = top of scrollHeight). */
  top: number;
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
export function buildPreviewAnchors(container: HTMLElement): LineAnchor[] {
  const els = container.querySelectorAll<HTMLElement>("[data-line]");
  if (els.length === 0) return [];
  const containerRect = container.getBoundingClientRect();
  const baseY = containerRect.top - container.scrollTop;
  const anchors: LineAnchor[] = [];
  for (const el of Array.from(els)) {
    const line = Number(el.getAttribute("data-line"));
    if (!Number.isFinite(line) || line <= 0) continue;
    const rect = el.getBoundingClientRect();
    anchors.push({ line, top: rect.top - baseY });
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

/**
 * Given anchors and a current scrollTop, return the (fractional) source line
 * at the viewport top. Uses linear interpolation between adjacent anchors so
 * scrolling within a long block still maps smoothly.
 */
export function topLineFromScroll(
  anchors: LineAnchor[],
  scrollTop: number,
): number | null {
  if (anchors.length === 0) return null;
  if (scrollTop <= anchors[0].top) return anchors[0].line;
  const last = anchors[anchors.length - 1];
  if (scrollTop >= last.top) return last.line;
  let lo = 0;
  let hi = anchors.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (anchors[mid].top <= scrollTop) lo = mid;
    else hi = mid;
  }
  const a = anchors[lo];
  const b = anchors[hi];
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
  if (anchors.length === 0) return null;
  if (line <= anchors[0].line) return anchors[0].top;
  const last = anchors[anchors.length - 1];
  if (line >= last.line) return last.top;
  let lo = 0;
  let hi = anchors.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (anchors[mid].line <= line) lo = mid;
    else hi = mid;
  }
  const a = anchors[lo];
  const b = anchors[hi];
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
