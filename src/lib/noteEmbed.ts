// 笔记嵌入（transclusion）：把预览里 `![[note]]` / `![[note#heading]]` 产出的占位
// span.wiki-embed 异步填充为目标笔记（或某个 heading 区段）的渲染内容。
//
// wikilinks.ts 的 enhanceSubtree 只负责造占位（纯 DOM，不取数）；真正取数/渲染在这里，
// 由 Preview 在增强管线里调用。带深度 + 环路保护，避免 A 嵌 B、B 嵌 A 无限递归。

import { api, type VaultFile } from "@/lib/api";
import { enhanceWikiLinks } from "@/lib/wikilinks";

const MAX_EMBED_DEPTH = 3;

export interface EmbedFillHandle {
  disconnect(): void;
}

interface CancelSignal {
  cancelled: boolean;
}

/**
 * 从 markdown 里截取某个 heading 到下一个「同级或更高级」heading 之间的内容
 * （含该 heading 行本身）。围栏内的 `#` 不当标题。找不到返回 null。
 */
export function extractHeadingSection(
  markdown: string,
  heading: string,
): string | null {
  const want = heading.trim().toLowerCase();
  if (!want) return null;
  const lines = markdown.split("\n");
  let inFence = false;
  let startIdx = -1;
  let startLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]!;
    if (/^\s*(```|~~~)/.test(ln)) inFence = !inFence;
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.*)$/.exec(ln);
    if (!m) continue;
    const level = m[1]!.length;
    const text = m[2]!.replace(/\s*#*\s*$/, "").trim().toLowerCase();
    if (startIdx === -1) {
      if (text === want) {
        startIdx = i;
        startLevel = level;
      }
    } else if (level <= startLevel) {
      return lines.slice(startIdx, i).join("\n");
    }
  }
  if (startIdx === -1) return null;
  return lines.slice(startIdx).join("\n");
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function setNote(el: HTMLElement, cls: string, msg: string) {
  el.classList.add(cls);
  el.textContent = msg;
}

async function fillOne(
  el: HTMLElement,
  vaultFiles: VaultFile[] | undefined,
  depth: number,
  ancestors: Set<string>,
  signal: CancelSignal,
) {
  const path = el.dataset.path;
  const target = el.dataset.embedTarget ?? "";
  const heading = el.dataset.embedHeading;
  if (!path) {
    setNote(el, "missing", `未找到笔记：${target}`);
    return;
  }
  const pkey = path.toLowerCase().replace(/\\/g, "/");
  if (depth >= MAX_EMBED_DEPTH || ancestors.has(pkey)) {
    setNote(el, "missing", `嵌入层级过深或循环：${target}`);
    return;
  }
  try {
    const opened = await api.open(path);
    if (signal.cancelled) return;
    let content = opened.content;
    if (heading) {
      const section = extractHeadingSection(content, heading);
      if (section == null) {
        setNote(el, "missing", `未找到标题：${heading}`);
        return;
      }
      content = section;
    }
    const rendered = await api.renderMarkdown(content, path);
    if (signal.cancelled) return;
    const html = rendered.html;

    const name = path.split(/[\\/]/).pop() ?? target;
    el.classList.remove("missing");
    el.classList.add("filled");
    el.textContent = "";
    el.innerHTML =
      `<a class="wikilink wiki-embed-head" href="#" data-path="${escapeAttr(path)}" ` +
      `data-wiki-target="${escapeAttr(target)}">` +
      `${escapeHtml(name)}${heading ? ` › ${escapeHtml(heading)}` : ""}</a>` +
      `<div class="wiki-embed-body"></div>`;
    const body = el.querySelector<HTMLElement>(".wiki-embed-body");
    if (body) {
      body.innerHTML = html;
      // 嵌入内容里的 [[link]] 也要可点；嵌套 ![[..]] 继续递归（带环路 + 深度保护）
      enhanceWikiLinks(body, vaultFiles);
      enhanceNoteEmbeds(body, vaultFiles, {
        depth: depth + 1,
        ancestors: new Set([...ancestors, pkey]),
        signal,
      });
    }
  } catch (e) {
    if (signal.cancelled) return;
    setNote(el, "missing", `嵌入失败：${(e as Error).message}`);
  }
}

/**
 * 填充 root 下所有未填充的 span.wiki-embed。返回 handle，disconnect 后未完成的
 * 异步填充会停止写入 DOM（含递归出来的嵌套填充）。
 */
export function enhanceNoteEmbeds(
  root: HTMLElement,
  vaultFiles: VaultFile[] | undefined,
  opts: { depth?: number; ancestors?: Set<string>; signal?: CancelSignal } = {},
): EmbedFillHandle {
  const signal = opts.signal ?? { cancelled: false };
  const depth = opts.depth ?? 0;
  const ancestors = opts.ancestors ?? new Set<string>();
  const pending = Array.from(
    root.querySelectorAll<HTMLElement>("span.wiki-embed"),
  ).filter((el) => !el.dataset.embedFilled);
  for (const el of pending) {
    el.dataset.embedFilled = "1";
    void fillOne(el, vaultFiles, depth, ancestors, signal);
  }
  return {
    disconnect: () => {
      signal.cancelled = true;
    },
  };
}
