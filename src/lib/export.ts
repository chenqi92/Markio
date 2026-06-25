import { api } from "./api";
import { writeText } from "./clipboard";
import { useSettings } from "@/stores/settings";

/** 拼一个独立 HTML 字符串：标题 + 主题 token + 渲染后的 markdown */
async function buildStandaloneHtml(title: string, source: string): Promise<string> {
  const r = await api.renderMarkdown(source);
  return wrapStandaloneHtml(title, r.html);
}

/** 把一段已渲染好的 body HTML 包成自洽的独立页面（主题 token 内联）。
 *  供单文档导出与整库静态站点导出共用。 */
export function wrapStandaloneHtml(title: string, bodyHtml: string): string {
  // 用渲染主题对应的关键 token 内联到导出文件里，保证打开后样式自洽
  const tokens = readThemeTokens();
  const css = `
:root { color-scheme: light dark; }
${Object.entries(tokens)
  .map(([k, v]) => `  ${k}: ${v};`)
  .join("\n")}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 0;
  background: var(--bg-deep, #fff);
  color: var(--text, #1d1d1f);
  font-family: var(--font-serif, "New York", "Iowan Old Style", Georgia, "Songti SC", serif);
  font-size: 16px; line-height: 1.75;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 820px; margin: 0 auto; padding: 60px 32px 80px; }
h1, h2, h3, h4 {
  font-family: var(--font-sans, -apple-system, "PingFang SC", sans-serif);
  letter-spacing: -0.01em;
}
h1 { font-size: 32px; margin: 0 0 8px; }
h2 { font-size: 22px; margin: 32px 0 10px; position: relative; }
h2::before {
  content: ""; position: absolute; left: -14px; top: 6px; width: 4px; height: 18px;
  background: var(--accent, #0a84ff); border-radius: 2px;
}
h3 { font-size: 17px; margin: 24px 0 8px; color: var(--text-2, #444); }
p { margin: 0 0 14px; }
a { color: var(--accent, #0a84ff); }
strong { font-weight: 700; }
em { font-style: italic; }
mark { background: var(--hl-mark, rgba(255,224,102,0.55)); padding: 0 3px; border-radius: 2px; }
code:not(pre code) {
  font-family: var(--font-mono, "SF Mono", Menlo, monospace);
  font-size: 0.86em; padding: 2px 6px;
  background: var(--code-bg, rgba(0,0,0,0.04));
  border: 0.5px solid var(--border, rgba(0,0,0,0.1));
  border-radius: 5px;
  color: var(--syntax-k, #aa0d91);
}
pre {
  background: var(--code-bg, rgba(0,0,0,0.04));
  border: 0.5px solid var(--border, rgba(0,0,0,0.1));
  border-radius: 12px;
  padding: 14px 18px;
  overflow-x: auto;
  margin: 18px 0;
  font-family: var(--font-mono, "SF Mono", Menlo, monospace);
  font-size: 13px; line-height: 1.55;
}
blockquote {
  margin: 16px 0; padding: 10px 16px;
  border-left: 3px solid var(--accent, #0a84ff);
  background: var(--bg-pane-2, rgba(0,0,0,0.03));
  border-radius: 0 8px 8px 0;
  font-style: italic; color: var(--text-2, #444);
}
table { border-collapse: collapse; width: 100%; margin: 16px 0; font-size: 14px;
  font-family: var(--font-sans, sans-serif); }
th, td { padding: 8px 12px; border-bottom: 0.5px solid var(--border, rgba(0,0,0,0.1)); text-align: left; }
th { font-weight: 600; background: var(--bg-pane-2, rgba(0,0,0,0.03)); }
hr { border: 0; height: 1px; background: var(--border, rgba(0,0,0,0.1)); margin: 28px 0; }
ul, ol { padding-left: 22px; margin: 0 0 14px; }
li { margin: 4px 0; }
img { max-width: 100%; }

@media print {
  body { background: white; color: #111; }
  .wrap { max-width: 100%; padding: 0; }
  pre { page-break-inside: avoid; }
}
`;
  const escapedTitle = title
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<title>${escapedTitle}</title>
<meta name="generator" content="markio" />
<style>${css}</style>
</head>
<body>
<main class="wrap">
${bodyHtml}
</main>
</body>
</html>`;
}

/** 把项目里 themes.css 当前激活主题的 token 抽出来。 */
function readThemeTokens(): Record<string, string> {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const keys = [
    "--bg-deep",
    "--bg-window",
    "--bg-pane",
    "--bg-pane-2",
    "--bg-elev",
    "--bg-input",
    "--bg-hover",
    "--border",
    "--border-strong",
    "--text",
    "--text-2",
    "--text-3",
    "--text-4",
    "--accent",
    "--accent-2",
    "--accent-glow",
    "--syntax-k",
    "--syntax-s",
    "--syntax-c",
    "--syntax-h",
    "--syntax-n",
    "--code-bg",
    "--hl-mark",
    "--font-sans",
    "--font-serif",
    "--font-mono",
  ];
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = style.getPropertyValue(k).trim();
    if (v) out[k] = v;
  }
  return out;
}

export async function exportHtml(title: string, source: string): Promise<void> {
  let html = await buildStandaloneHtml(title, source);
  if (useSettings.getState().htmlExportInlineImages) {
    html = await inlineRemoteImages(html);
  }
  const dest = await pickSaveTarget(title, "html", "HTML");
  if (!dest) return;
  await api.exportWriteFile(dest, html);
}

/** 把 HTML 里所有 http(s) 的 <img src> 替换为 data: URL；失败的保留原 src。 */
async function inlineRemoteImages(html: string): Promise<string> {
  const matches = Array.from(
    html.matchAll(/<img\b[^>]*\bsrc=["'](https?:\/\/[^"']+)["'][^>]*>/gi),
  );
  if (matches.length === 0) return html;
  const cache = new Map<string, string>();
  for (const m of matches) {
    const url = m[1]!;
    if (cache.has(url)) continue;
    try {
      cache.set(url, await api.fetchImageAsDataUrl(url));
    } catch {
      // 抓不动就保留原 url
    }
  }
  return html.replace(
    /(<img\b[^>]*\bsrc=["'])(https?:\/\/[^"']+)(["'])/gi,
    (whole, p1, url, p3) => {
      const data = cache.get(url);
      return data ? `${p1}${data}${p3}` : whole;
    },
  );
}

export async function exportPdf(title: string, source: string): Promise<void> {
  const html = await buildStandaloneHtml(title, source);
  // 用新窗口走原生 print → 用户在打印对话框里选"保存为 PDF"。
  // 这样既不引入额外依赖，又能完全沿用上面那套样式。
  const win = window.open("", "_blank", "noopener,noreferrer,width=920,height=900");
  if (!win) throw new Error("无法打开打印窗口（可能被浏览器拦截）");
  win.document.write(html);
  win.document.close();
  // 等渲染稳定后唤起 print
  setTimeout(() => {
    try {
      win.focus();
      win.print();
    } catch {
      /* ignore */
    }
  }, 300);
}

export async function copyMarkdown(source: string): Promise<void> {
  await writeText(source);
}

async function pickSaveTarget(
  defaultName: string,
  ext: string,
  label: string,
): Promise<string | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const target = await save({
    defaultPath: sanitizeFileName(defaultName) + `.${ext}`,
    filters: [{ name: label, extensions: [ext] }],
  });
  return typeof target === "string" ? target : null;
}

export async function exportEpub(title: string, source: string): Promise<void> {
  const dest = await pickSaveTarget(title, "epub", "EPUB");
  if (!dest) return;
  await api.exportPandoc(source, "epub", dest);
}

export async function exportDocx(title: string, source: string): Promise<void> {
  const dest = await pickSaveTarget(title, "docx", "Word Document");
  if (!dest) return;
  await api.exportPandoc(source, "docx", dest);
}

export async function copyHtml(title: string, source: string): Promise<void> {
  const html = await buildStandaloneHtml(title, source);
  await writeText(html);
}

function sanitizeFileName(name: string): string {
  return name
    .replace(/\.md$/i, "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .trim() || "untitled";
}

