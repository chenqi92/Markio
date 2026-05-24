/**
 * highlight.js 按需 lazy 加载子系统。
 *
 * 旧实现把 hljs/lib/core + 13 个语言全部 top-level static import 进 wysiwyg.ts，
 * 然后 wysiwyg.ts 被 SourceEditor 静态依赖，整套都沉到主 chunk。即使笔记里
 * 没有任何代码块也要解析 hljs + 全套语法。
 *
 * 这里把核心 + 每个 grammar 拆成独立 dynamic import，第一次出现该语言时才拉，
 * 拉过的语言在 langPromises Map 里复用结果。CodeFenceWidget 在等 grammar
 * 期间用 escapeCodeHtml 兜底渲染明文。
 */

type HljsCore = typeof import("highlight.js/lib/core").default;

let hljsCorePromise: Promise<HljsCore> | null = null;
function loadHljsCore(): Promise<HljsCore> {
  if (!hljsCorePromise) {
    hljsCorePromise = import("highlight.js/lib/core").then((m) => m.default);
  }
  return hljsCorePromise;
}

// 一组工厂函数：value 必须是 () => import("...") 形式，让 Vite 各自切 chunk。
const LANG_LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
  bash: () => import("highlight.js/lib/languages/bash"),
  sh: () => import("highlight.js/lib/languages/bash"),
  shell: () => import("highlight.js/lib/languages/bash"),
  zsh: () => import("highlight.js/lib/languages/bash"),
  css: () => import("highlight.js/lib/languages/css"),
  go: () => import("highlight.js/lib/languages/go"),
  golang: () => import("highlight.js/lib/languages/go"),
  java: () => import("highlight.js/lib/languages/java"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  js: () => import("highlight.js/lib/languages/javascript"),
  json: () => import("highlight.js/lib/languages/json"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  md: () => import("highlight.js/lib/languages/markdown"),
  python: () => import("highlight.js/lib/languages/python"),
  py: () => import("highlight.js/lib/languages/python"),
  rust: () => import("highlight.js/lib/languages/rust"),
  rs: () => import("highlight.js/lib/languages/rust"),
  sql: () => import("highlight.js/lib/languages/sql"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  ts: () => import("highlight.js/lib/languages/typescript"),
  xml: () => import("highlight.js/lib/languages/xml"),
  html: () => import("highlight.js/lib/languages/xml"),
  svg: () => import("highlight.js/lib/languages/xml"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
  yml: () => import("highlight.js/lib/languages/yaml"),
};

const langPromises = new Map<string, Promise<string | null>>();

function ensureHighlightLanguage(lang: string): Promise<string | null> {
  const normalized = lang.trim().toLowerCase();
  if (!normalized) return Promise.resolve(null);
  const loader = LANG_LOADERS[normalized];
  if (!loader) return Promise.resolve(null);
  const cached = langPromises.get(normalized);
  if (cached) return cached;
  const p = (async () => {
    const hljs = await loadHljsCore();
    if (!hljs.getLanguage(normalized)) {
      const mod = await loader();
      // grammar 模块 default export 是 (hljs) => LanguageDefinition
      hljs.registerLanguage(normalized, mod.default as Parameters<typeof hljs.registerLanguage>[1]);
    }
    return normalized;
  })().catch(() => null);
  langPromises.set(normalized, p);
  return p;
}

export function escapeCodeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export async function highlightCode(source: string, lang: string): Promise<string> {
  const normalized = await ensureHighlightLanguage(lang);
  if (!normalized) return escapeCodeHtml(source);
  try {
    const hljs = await loadHljsCore();
    return hljs.highlight(source, { language: normalized, ignoreIllegals: true }).value;
  } catch {
    return escapeCodeHtml(source);
  }
}
