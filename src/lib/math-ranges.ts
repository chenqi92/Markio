// Find inline `$..$` and block `$$..$$` math regions in markdown source.
//
// Used by the CodeMirror WYSIWYG plugin to know which spans to replace with
// a rendered KaTeX widget. Lezer-markdown has no native math node, so we
// scan the doc text directly.
//
// Rules:
//   - Inline:  `$x$`. Single-line. Inner cannot be empty (`$$` is reserved
//              for the block form). `\$` (escaped dollar) does not start/end.
//              No newline inside.
//   - Block:   `$$\n...\n$$` where the `$$` markers are on their own lines
//              (or at start/end of doc). Captures a multi-line range.
//
// Both forms strictly require source positions and do not allocate per-line.

export interface MathRange {
  /** Doc offset of the opening `$` (block: opening `$$`). */
  from: number;
  /** Doc offset just past the closing `$` / `$$`. */
  to: number;
  /** Inner math expression, trimmed of delimiters and whitespace. */
  source: string;
  /** true for `$$...$$` blocks, false for inline `$...$`. */
  display: boolean;
}

const isEscaped = (text: string, idx: number): boolean => {
  let n = 0;
  let i = idx - 1;
  while (i >= 0 && text[i] === "\\") {
    n++;
    i--;
  }
  return n % 2 === 1;
};

const isLineStart = (text: string, idx: number): boolean =>
  idx === 0 || text[idx - 1] === "\n";

/**
 * Detect all math ranges in `text`. Offsets are absolute (not relative to
 * a slice), so pass the full doc for stable positions.
 */
export function detectMathRanges(text: string): MathRange[] {
  const ranges: MathRange[] = [];
  const len = text.length;
  let i = 0;
  while (i < len) {
    const ch = text[i];

    // Skip past fenced code blocks (``` ... ```) — they should never be
    // interpreted as math even if they contain `$`.
    if (ch === "`" && text[i + 1] === "`" && text[i + 2] === "`" && isLineStart(text, i)) {
      const close = text.indexOf("\n```", i + 3);
      if (close < 0) break;
      // advance past the closing fence's newline (or end-of-line)
      const afterFence = text.indexOf("\n", close + 1);
      i = afterFence < 0 ? len : afterFence + 1;
      continue;
    }

    // Skip past inline code (single backticks). These also shadow `$`.
    if (ch === "`" && !isEscaped(text, i)) {
      const close = text.indexOf("`", i + 1);
      if (close < 0) {
        i += 1;
        continue;
      }
      i = close + 1;
      continue;
    }

    if (ch === "$" && !isEscaped(text, i)) {
      // `$$` adjacent: either a well-formed block (own line, paired close) or
      // a non-math `$$x^2$$` inline-ish sequence. In the latter case we must
      // skip the whole `$$` so the inline branch doesn't pick up the second
      // `$` as an opener.
      if (text[i + 1] === "$") {
        if (isLineStart(text, i) && isWhitespaceUntilEol(text, i + 2)) {
          const start = i;
          const openEol = text.indexOf("\n", i + 2);
          const innerStart = openEol < 0 ? len : openEol + 1;
          const close = findClosingBlock(text, innerStart);
          if (close !== -1) {
            const innerEnd = close.startOfClose;
            const afterClose = close.endOfClose;
            const inner = text.slice(innerStart, innerEnd).trim();
            if (inner.length > 0) {
              ranges.push({
                from: start,
                to: afterClose,
                source: inner,
                display: true,
              });
              i = afterClose;
              continue;
            }
          }
        }
        // Either not at line start, no proper close, or empty body — skip both `$`.
        i += 2;
        continue;
      }

      // Inline `$...$` on a single line; the closer cannot itself be `$$`.
      const lineEnd = text.indexOf("\n", i + 1);
      const searchTo = lineEnd < 0 ? len : lineEnd;
      let j = i + 1;
      let closed = -1;
      while (j < searchTo) {
        if (text[j] === "$" && !isEscaped(text, j) && text[j + 1] !== "$") {
          closed = j;
          break;
        }
        j++;
      }
      if (closed > i + 1) {
        const inner = text.slice(i + 1, closed).trim();
        if (inner.length > 0) {
          ranges.push({
            from: i,
            to: closed + 1,
            source: inner,
            display: false,
          });
          i = closed + 1;
          continue;
        }
      }
    }
    i++;
  }
  return ranges;
}

function isWhitespaceUntilEol(text: string, start: number): boolean {
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "\n") return true;
    if (c !== " " && c !== "\t" && c !== "\r") return false;
  }
  return true;
}

interface CloseInfo {
  startOfClose: number;
  endOfClose: number;
}

function findClosingBlock(text: string, from: number): CloseInfo | -1 {
  let line = from;
  while (line < text.length) {
    // Trim leading whitespace on the line
    let probe = line;
    while (probe < text.length && (text[probe] === " " || text[probe] === "\t")) {
      probe++;
    }
    if (
      text[probe] === "$" &&
      text[probe + 1] === "$" &&
      isWhitespaceUntilEol(text, probe + 2)
    ) {
      const eol = text.indexOf("\n", probe + 2);
      return {
        startOfClose: line,
        endOfClose: eol < 0 ? text.length : eol + 1,
      };
    }
    const nextNl = text.indexOf("\n", line);
    if (nextNl < 0) return -1;
    line = nextNl + 1;
  }
  return -1;
}

/** Inclusive containment test: cursor at the boundary counts as inside. */
export function cursorInsideRange(range: MathRange, head: number): boolean {
  return head >= range.from && head <= range.to;
}
