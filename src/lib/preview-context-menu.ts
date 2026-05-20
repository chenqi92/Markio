// 预览侧右键菜单：根据点击位置（链接 / 图片 / 表格 / 选区 / 普通文本）拼条目。
// 必须由调用方对 contextmenu 事件 preventDefault 才能屏蔽 WebView 原生菜单。
// 表格的右键已经由 onTableCellContext 走源码侧的 TableContextMenu，这里不重复。

import type { CtxItem } from "@/components/popovers/ContextMenu";
import { writeText } from "@/lib/clipboard";
import { openExternal } from "@/lib/opener";

export interface PreviewClickInfo {
  /** 命中的链接 `<a href>`；wiki link 也会被识别（取 data-wiki-target） */
  link: { href: string; text: string; isWiki: boolean } | null;
  /** 命中的图片 `<img src>` */
  image: { src: string; alt: string } | null;
  /** 命中的 `<pre><code>` 代码块 */
  codeBlock: { text: string; lang: string | null } | null;
  /** 当前 selection 范围内是否有文本（window.getSelection 计算） */
  selectionText: string;
}

export function inspectPreviewClick(target: EventTarget | null): PreviewClickInfo {
  let link: PreviewClickInfo["link"] = null;
  let image: PreviewClickInfo["image"] = null;
  let codeBlock: PreviewClickInfo["codeBlock"] = null;

  const el = target instanceof Element ? target : null;
  if (el) {
    const a = el.closest("a") as HTMLAnchorElement | null;
    if (a) {
      const isWiki = a.classList.contains("wikilink");
      const href = isWiki
        ? a.getAttribute("data-path") ??
          a.getAttribute("data-wiki-target") ??
          a.getAttribute("href") ??
          ""
        : a.getAttribute("href") ?? "";
      link = { href, text: a.textContent ?? "", isWiki };
    }
    const img = el.closest("img") as HTMLImageElement | null;
    if (img) {
      image = {
        src: img.getAttribute("src") ?? img.src,
        alt: img.getAttribute("alt") ?? "",
      };
    }
    const pre = el.closest("pre") as HTMLPreElement | null;
    if (pre) {
      const code = pre.querySelector("code");
      const langClass = Array.from(code?.classList ?? []).find((c) =>
        c.startsWith("language-"),
      );
      codeBlock = {
        text: (code?.textContent ?? pre.textContent) ?? "",
        lang: langClass ? langClass.slice("language-".length) : null,
      };
    }
  }

  const selection = typeof window !== "undefined" ? window.getSelection() : null;
  const selectionText = selection?.toString() ?? "";

  return { link, image, codeBlock, selectionText };
}

export interface BuildPreviewItemsDeps {
  info: PreviewClickInfo;
  toast: (msg: string) => void;
  modifierLabel: (mac: string, win: string) => string;
}

export function buildPreviewContextItems(deps: BuildPreviewItemsDeps): CtxItem[] {
  const { info, toast, modifierLabel } = deps;
  const items: CtxItem[] = [];

  // ─── 链接 ───
  if (info.link) {
    const { href, isWiki } = info.link;
    if (isWiki) {
      items.push({
        label: "复制 wiki 链接名",
        icon: "copy",
        onClick: () => void writeText(href).then(() => toast("已复制")),
      });
    } else {
      items.push({
        label: "在外部打开链接",
        icon: "external",
        onClick: () => void openExternal(href),
      });
      items.push({
        label: "复制链接地址",
        icon: "copy",
        onClick: () => void writeText(href).then(() => toast("已复制")),
      });
    }
    items.push({ sep: true });
  }

  // ─── 图片 ───
  if (info.image) {
    const src = info.image.src;
    items.push({
      label: "复制图片地址",
      icon: "copy",
      onClick: () => void writeText(src).then(() => toast("已复制")),
    });
    items.push({
      label: "在外部打开图片",
      icon: "external",
      onClick: () => void openExternal(src),
    });
    items.push({ sep: true });
  }

  // ─── 代码块 ───
  if (info.codeBlock) {
    items.push({
      label: "复制整段代码",
      icon: "copy",
      onClick: () => {
        void writeText(info.codeBlock!.text).then(() => toast("已复制"));
      },
    });
    items.push({ sep: true });
  }

  // ─── 选区文本 ───
  if (info.selectionText) {
    items.push({
      label: "复制",
      icon: "copy",
      kbd: modifierLabel("⌘C", "Ctrl+C"),
      onClick: () => {
        void writeText(info.selectionText).then(() => toast("已复制"));
      },
    });
    items.push({
      label: "复制为 markdown 链接",
      onClick: () => {
        const text = info.selectionText.trim();
        void writeText(`[${text}]()`).then(() => toast("已复制"));
      },
    });
    items.push({ sep: true });
  }

  // ─── 通用 ───
  items.push({
    label: "全选",
    kbd: modifierLabel("⌘A", "Ctrl+A"),
    onClick: () => {
      const sel = window.getSelection();
      const root = document.querySelector(".preview-pane .preview") as HTMLElement | null;
      if (!sel || !root) return;
      sel.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(root);
      sel.addRange(range);
    },
  });

  while (items.length && items[items.length - 1].sep) items.pop();
  return items;
}
