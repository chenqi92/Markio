// 整库静态站点导出：把仓库里每个 .md 渲染成自洽 HTML（本地图片已被后端内联成
// data URL），[[wikilink]] / 相对 .md 链接改写成站点内相对 .html，再生成一个 index。
//
// 复用 export.ts 的 wrapStandaloneHtml（主题 token 内联）和 wikilinks 的 enhanceWikiLinks
// （headless 解析 [[..]] → data-path）。产物是一组可直接丢到 Cloudflare Pages / 自托管
// 的静态文件（本地优先，无中央服务）。

import { api, type VaultFile } from "@/lib/api";
import { enhanceWikiLinks } from "@/lib/wikilinks";
import { wrapStandaloneHtml } from "@/lib/export";

const MD_EXT_RE = /\.(md|markdown|mdown|mkd)$/i;

/** 绝对路径 → 站点内相对 .html 路径（仓库相对，'/' 分隔，扩展名换 .html）。 */
export function siteRelPath(absPath: string, workspace: string): string {
  const a = absPath.replace(/\\/g, "/");
  const ws = workspace.replace(/\\/g, "/").replace(/\/+$/, "");
  let rel =
    a.toLowerCase().startsWith(ws.toLowerCase() + "/") ? a.slice(ws.length + 1) : a;
  rel = rel.replace(/^\/+/, "");
  return rel.replace(MD_EXT_RE, ".html");
}

/** 从 fromRel 所在目录到 toRel 的 posix 相对链接（同目录不加 ./）。 */
export function relativeHref(fromRel: string, toRel: string): string {
  const fromDir = fromRel.split("/").slice(0, -1);
  const to = toRel.split("/");
  let i = 0;
  while (i < fromDir.length && i < to.length - 1 && fromDir[i] === to[i]) i++;
  const ups = fromDir.slice(i).map(() => "..");
  const downs = to.slice(i);
  const parts = [...ups, ...downs];
  return parts.length ? parts.join("/") : to[to.length - 1]!;
}

/**
 * 在已 enhance 过 wikilink 的 container 上做站点化改写：
 *  - a.wikilink[data-path] → 站点内相对 .html 链接；missing 退化成纯文本
 *  - span.wiki-embed       → 链接到目标页（v1 不内联嵌入）
 *  - 相对 .md 链接          → .html（保留锚点）
 */
export function rewriteForSite(
  container: HTMLElement,
  currentRel: string,
  workspace: string,
): void {
  const doc = container.ownerDocument;
  container.querySelectorAll<HTMLElement>("a.wikilink").forEach((a) => {
    const path = a.getAttribute("data-path");
    if (path) {
      const link = doc.createElement("a");
      link.setAttribute("href", relativeHref(currentRel, siteRelPath(path, workspace)));
      link.textContent = a.textContent ?? "";
      a.replaceWith(link);
    } else {
      a.replaceWith(doc.createTextNode(a.textContent ?? ""));
    }
  });
  container.querySelectorAll<HTMLElement>("span.wiki-embed").forEach((s) => {
    const path = s.getAttribute("data-path");
    const target = s.getAttribute("data-embed-target") ?? "";
    if (path) {
      const link = doc.createElement("a");
      link.setAttribute("href", relativeHref(currentRel, siteRelPath(path, workspace)));
      link.textContent = `↪ ${target}`;
      s.replaceWith(link);
    } else {
      s.replaceWith(doc.createTextNode(`![[${target}]]`));
    }
  });
  container.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((a) => {
    const href = a.getAttribute("href");
    if (!href || /^[a-z]+:/i.test(href) || href.startsWith("#") || href.startsWith("//")) {
      return;
    }
    const m = /^([^#?]*)\.(md|markdown|mdown|mkd)(#.*)?$/i.exec(href);
    if (m) a.setAttribute("href", `${m[1]}.html${m[3] ?? ""}`);
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 生成站点首页：按相对路径排序，列出全部页面。 */
export function buildIndexHtml(
  entries: { rel: string; title: string }[],
  workspaceName: string,
): string {
  const sorted = [...entries].sort((a, b) => a.rel.localeCompare(b.rel));
  const list = sorted
    .map(
      (e) =>
        `<li><a href="${escapeHtml(e.rel)}">${escapeHtml(e.title)}</a> ` +
        `<span style="color:var(--text-4);font-size:0.85em">${escapeHtml(e.rel)}</span></li>`,
    )
    .join("\n");
  const body = `<h1>${escapeHtml(workspaceName)}</h1>
<p style="color:var(--text-3)">${sorted.length} 个页面</p>
<ul style="list-style:none;padding-left:0">
${list}
</ul>`;
  return wrapStandaloneHtml(workspaceName, body);
}

export interface SiteExportResult {
  written: number;
  failed: number;
  total: number;
}

/**
 * 把整个仓库导出为静态站点写到 outDir。逐文件渲染 + 写盘（await 之间让出主线程）。
 * onProgress(done, total, currentName)。
 */
export async function exportVaultSite(
  workspace: string,
  workspaceName: string,
  files: VaultFile[],
  outDir: string,
  onProgress?: (done: number, total: number, current: string) => void,
): Promise<SiteExportResult> {
  const mdFiles = files.filter((f) => MD_EXT_RE.test(f.path));
  const indexEntries: { rel: string; title: string }[] = [];
  let written = 0;
  let failed = 0;
  for (let i = 0; i < mdFiles.length; i++) {
    const f = mdFiles[i]!;
    onProgress?.(i, mdFiles.length, f.name);
    try {
      const opened = await api.open(f.path);
      const rendered = await api.renderMarkdown(opened.content, f.path);
      const container = document.createElement("div");
      container.innerHTML = rendered.html;
      enhanceWikiLinks(container, files);
      const currentRel = siteRelPath(f.path, workspace);
      rewriteForSite(container, currentRel, workspace);
      const title = f.stem || f.name;
      const page = wrapStandaloneHtml(title, container.innerHTML);
      await api.exportSiteWrite(outDir, currentRel, page);
      indexEntries.push({ rel: currentRel, title });
      written++;
    } catch {
      failed++;
    }
  }
  try {
    await api.exportSiteWrite(outDir, "index.html", buildIndexHtml(indexEntries, workspaceName));
  } catch {
    /* index 失败不致命 */
  }
  onProgress?.(mdFiles.length, mdFiles.length, "");
  return { written, failed, total: mdFiles.length };
}
