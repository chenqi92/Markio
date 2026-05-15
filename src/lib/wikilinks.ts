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

export function resolveWikiFile(files: VaultFile[] | undefined, target: string) {
  if (!files?.length) return null;
  const needle = normalizeName(target);
  if (!needle) return null;

  for (const file of files) {
    if (normalizeName(file.stem) === needle) return file;
  }
  for (const file of files) {
    if (normalizeName(file.name) === needle) return file;
  }
  if (needle.includes("/")) {
    for (const file of files) {
      const path = normalizeName(file.path);
      if (path.endsWith(`/${needle}`) || path === needle) return file;
    }
  }
  return null;
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

function applyResolvedState(link: HTMLElement, files: VaultFile[] | undefined) {
  const target = link.dataset.wikiTarget ?? "";
  const resolved = resolveWikiFile(files, target);
  link.classList.toggle("missing", !resolved);
  if (resolved) {
    link.dataset.path = resolved.path;
    link.title = `打开 ${resolved.name}`;
  } else {
    delete link.dataset.path;
    link.title = `未找到笔记：${target}`;
  }
}

export function enhanceWikiLinks(root: HTMLElement, files: VaultFile[] | undefined) {
  root.querySelectorAll<HTMLElement>("a.wikilink").forEach((link) => {
    applyResolvedState(link, files);
  });

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
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
    const fragment = document.createDocumentFragment();

    while ((match = WIKI_LINK_RE.exec(text))) {
      const body = match[1];
      const parts = parseWikiLinkBody(body);
      if (!parts) continue;
      if (match.index > last) {
        fragment.append(document.createTextNode(text.slice(last, match.index)));
      }

      const link = document.createElement("a");
      link.href = "#";
      link.className = "wikilink";
      link.dataset.wikiTarget = parts.target;
      link.dataset.wikiRaw = body;
      if (parts.heading) link.dataset.wikiHeading = parts.heading;
      link.textContent = parts.display;
      applyResolvedState(link, files);
      fragment.append(link);
      last = match.index + match[0].length;
    }

    if (last === 0) continue;
    if (last < text.length) fragment.append(document.createTextNode(text.slice(last)));
    textNode.parentNode?.replaceChild(fragment, textNode);
  }
}
