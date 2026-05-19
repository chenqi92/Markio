export interface FindTextOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  maxMatches?: number;
}

export interface FindTextMatch {
  from: number;
  to: number;
}

export interface FindTextResult {
  matches: FindTextMatch[];
  error: string | null;
  capped: boolean;
}

const DEFAULT_MAX_MATCHES = 50_000;

function escapeRegExp(pattern: string): string {
  return pattern.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function codePointBefore(text: string, index: number): string {
  if (index <= 0) return "";
  const prev = text.charCodeAt(index - 1);
  if (prev >= 0xdc00 && prev <= 0xdfff && index > 1) {
    const high = text.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) return text.slice(index - 2, index);
  }
  return text.slice(index - 1, index);
}

function codePointAt(text: string, index: number): string {
  if (index >= text.length) return "";
  const first = text.charCodeAt(index);
  if (first >= 0xd800 && first <= 0xdbff && index + 1 < text.length) {
    const low = text.charCodeAt(index + 1);
    if (low >= 0xdc00 && low <= 0xdfff) return text.slice(index, index + 2);
  }
  return text.slice(index, index + 1);
}

function isWordChar(ch: string): boolean {
  return ch !== "" && /^[\p{L}\p{N}_]$/u.test(ch);
}

function hasWordBoundary(text: string, from: number, to: number): boolean {
  return !isWordChar(codePointBefore(text, from)) && !isWordChar(codePointAt(text, to));
}

export function findTextRanges(
  text: string,
  query: string,
  options: FindTextOptions,
): FindTextResult {
  if (!query) return { matches: [], error: null, capped: false };

  let re: RegExp;
  try {
    re = new RegExp(options.regex ? query : escapeRegExp(query), options.caseSensitive ? "gu" : "giu");
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { matches: [], error: message, capped: false };
  }

  const maxMatches = options.maxMatches ?? DEFAULT_MAX_MATCHES;
  const matches: FindTextMatch[] = [];
  let capped = false;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const from = match.index;
    const to = from + match[0].length;
    if (to === from) {
      re.lastIndex = from + 1;
      continue;
    }
    if (!options.wholeWord || hasWordBoundary(text, from, to)) {
      matches.push({ from, to });
      if (matches.length >= maxMatches) {
        capped = true;
        break;
      }
    }
  }
  return { matches, error: null, capped };
}

export function countFindMatches(
  text: string,
  query: string,
  options: FindTextOptions,
): { count: number; error: string | null; capped: boolean } {
  const result = findTextRanges(text, query, options);
  return {
    count: result.matches.length,
    error: result.error,
    capped: result.capped,
  };
}
