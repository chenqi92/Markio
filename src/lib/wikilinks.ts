import type { VaultFile } from "@/lib/api";

export interface WikiLinkParts {
  target: string;
  display: string;
  heading?: string;
}

const WIKI_LINK_RE = /\[\[([^\]\n]{1,200})\]\]/g;

function splitOnce(input: string, token: string): [string, string | undefined] {
  const index = input.indexOf(token);
  if (index < 0) return [input, undefined];
  return [input.slice(0, index), input.slice(index + token.length)];
}

function normalizeName(input: string): string {
  let next = input.trim().replace(/\\/g, "/");
  try {
    next = decodeURIComponent(next);
  } catch {
    /* keep original */
  }
  next = next.replace(/\.md$/i, "");
  next = next.replace(/^\/+|\/+$/g, "");
  return next.toLowerCase();
}

export function parseWikiLinkBody(body: string): WikiLinkParts | null {
  const trimmed = body.trim();
  if (!trimmed) return null;

  const [targetWithHeading, alias] = splitOnce(trimmed, "|");
  const [targetRaw, headingRaw] = splitOnce(targetWithHeading, "#");
  const target = targetRaw.trim();
  if (!target) return null;

  const heading = headingRaw?.trim();
  const display = alias?.trim() || targetWithHeading.trim();
  return {
    target,
    display,
    ...(heading ? { heading } : {}),
  };
}

export interface VaultIndex {
  byStem: Map<string, VaultFile>;
  byName: Map<string, VaultFile>;
  byPath: Map<string, VaultFile>;
  // Sorted-by-length tail lookup for `nested/path` matches; rare in hot path.
  paths: { norm: string; file: VaultFile }[];
}

const vaultIndexCache = new WeakMap<readonly VaultFile[], VaultIndex>();

export function buildVaultIndex(files: readonly VaultFile[] | undefined): VaultIndex {
  const idx: VaultIndex = {
    byStem: new Map(),
    byName: new Map(),
    byPath: new Map(),
    paths: [],
  };
  if (!files?.length) return idx;
  for (const file of files) {
    const stem = normalizeName(file.stem);
    if (stem && !idx.byStem.has(stem)) idx.byStem.set(stem, file);
    const name = normalizeName(file.name);
    if (name && !idx.byName.has(name)) idx.byName.set(name, file);
    const p = normalizeName(file.path);
    if (p) {
      if (!idx.byPath.has(p)) idx.byPath.set(p, file);
      idx.paths.push({ norm: p, file });
    }
  }
  return idx;
}

function getVaultIndex(files: readonly VaultFile[] | undefined): VaultIndex {
  if (!files?.length) return buildVaultIndex(files);
  const cached = vaultIndexCache.get(files);
  if (cached) return cached;
  const next = buildVaultIndex(files);
  vaultIndexCache.set(files, next);
  return next;
}

function resolveFromIndex(index: VaultIndex, target: string): VaultFile | null {
  const needle = normalizeName(target);
  if (!needle) return null;
  const byStem = index.byStem.get(needle);
  if (byStem) return byStem;
  const byName = index.byName.get(needle);
  if (byName) return byName;
  if (needle.includes("/")) {
    const exact = index.byPath.get(needle);
    if (exact) return exact;
    const tail = `/${needle}`;
    for (const { norm, file } of index.paths) {
      if (norm.endsWith(tail)) return file;
    }
  }
  return null;
}

export function resolveWikiFile(files: readonly VaultFile[] | undefined, target: string) {
  if (!files?.length) return null;
  return resolveFromIndex(getVaultIndex(files), target);
}

function isSkippableTextNode(node: Text): boolean {
  const parent = node.parentElement;
  if (!parent) return true;
  return Boolean(
    parent.closest(
      "pre,code,script,style,a,button,textarea,mark.find-hit,.math,.katex",
    ),
  );
}

function applyResolvedState(link: HTMLElement, index: VaultIndex) {
  const target = link.dataset.wikiTarget ?? "";
  const resolved = resolveFromIndex(index, target);
  link.classList.toggle("missing", !resolved);
  if (resolved) {
    link.dataset.path = resolved.path;
    link.title = `打开 ${resolved.name}`;
  } else {
    delete link.dataset.path;
    link.title = `未找到笔记：${target}`;
  }
}

function enhanceSubtree(subtree: HTMLElement, index: VaultIndex) {
  subtree.querySelectorAll<HTMLElement>("a.wikilink").forEach((link) => {
    applyResolvedState(link, index);
  });

  const doc = subtree.ownerDocument ?? document;
  const walker = doc.createTreeWalker(subtree, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = node.nodeValue ?? "";
      if (!text.includes("[[")) return NodeFilter.FILTER_REJECT;
      if (isSkippableTextNode(node as Text)) return NodeFilter.FILTER_REJECT;
      WIKI_LINK_RE.lastIndex = 0;
      return WIKI_LINK_RE.test(text)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  const targets: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) targets.push(node as Text);

  for (const textNode of targets) {
    const text = textNode.nodeValue ?? "";
    WIKI_LINK_RE.lastIndex = 0;
    let last = 0;
    let match: RegExpExecArray | null;
    const fragment = doc.createDocumentFragment();

    while ((match = WIKI_LINK_RE.exec(text))) {
      const body = match[1]!;
      const parts = parseWikiLinkBody(body);
      if (!parts) continue;
      if (match.index > last) {
        fragment.append(doc.createTextNode(text.slice(last, match.index)));
      }

      const link = doc.createElement("a");
      link.href = "#";
      link.className = "wikilink";
      link.dataset.wikiTarget = parts.target;
      link.dataset.wikiRaw = body;
      if (parts.heading) link.dataset.wikiHeading = parts.heading;
      link.textContent = parts.display;
      applyResolvedState(link, index);
      fragment.append(link);
      last = match.index + match[0].length;
    }

    if (last === 0) continue;
    if (last < text.length) fragment.append(doc.createTextNode(text.slice(last)));
    textNode.parentNode?.replaceChild(fragment, textNode);
  }
}

/**
 * Eager enhancement: walks the whole `root` subtree synchronously.
 * Use this when you need every link enhanced immediately (small docs,
 * tests, headless rendering for export).
 */
export function enhanceWikiLinks(root: HTMLElement, files: VaultFile[] | undefined) {
  const index = buildVaultIndex(files);
  enhanceSubtree(root, index);
}

export interface WikiEnhanceHandle {
  /** Disconnects the observer; pending blocks stay un-enhanced. */
  disconnect(): void;
  /** Enhances all remaining blocks immediately (used for tests / export). */
  flushAll(): void;
}

/**
 * Lazy enhancement: enhances only blocks (direct children of `root`) that
 * intersect the viewport, and enhances the rest as the user scrolls them
 * into view. Cuts first-paint cost on large docs from ~seconds to ~ms.
 *
 * Falls back to immediate full enhancement when `IntersectionObserver`
 * is unavailable (some legacy WebViews).
 *
 * Returns a handle; call `disconnect()` on cleanup / re-render.
 */
export function enhanceWikiLinksLazy(
  root: HTMLElement,
  files: VaultFile[] | undefined,
  options: { rootMargin?: string } = {},
): WikiEnhanceHandle {
  const index = buildVaultIndex(files);

  // Already-rendered <a.wikilink> elements (e.g. inserted server-side) are
  // cheap to re-evaluate; do them up-front so click handlers see a path.
  root.querySelectorAll<HTMLElement>("a.wikilink").forEach((link) => {
    applyResolvedState(link, index);
  });

  // Pick block-level containers that actually contain wikilink syntax.
  // Markdown renders to a flat tree at root (p / ul / blockquote / pre / hN).
  const pending: HTMLElement[] = [];
  for (const child of Array.from(root.children)) {
    if (
      child instanceof HTMLElement &&
      child.textContent?.includes("[[") &&
      !child.dataset.wikiEnhanced
    ) {
      pending.push(child);
    }
  }

  if (pending.length === 0) {
    return { disconnect: () => undefined, flushAll: () => undefined };
  }

  const IO =
    typeof globalThis !== "undefined" && "IntersectionObserver" in globalThis
      ? (globalThis as typeof window).IntersectionObserver
      : null;

  if (!IO) {
    for (const block of pending) {
      enhanceSubtree(block, index);
      block.dataset.wikiEnhanced = "1";
    }
    return { disconnect: () => undefined, flushAll: () => undefined };
  }

  const observer = new IO(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const block = entry.target as HTMLElement;
        if (block.dataset.wikiEnhanced) {
          observer.unobserve(block);
          continue;
        }
        enhanceSubtree(block, index);
        block.dataset.wikiEnhanced = "1";
        observer.unobserve(block);
      }
    },
    { rootMargin: options.rootMargin ?? "200px 0px" },
  );

  for (const block of pending) observer.observe(block);

  return {
    disconnect: () => observer.disconnect(),
    flushAll: () => {
      observer.disconnect();
      for (const block of pending) {
        if (block.dataset.wikiEnhanced) continue;
        enhanceSubtree(block, index);
        block.dataset.wikiEnhanced = "1";
      }
    },
  };
}
