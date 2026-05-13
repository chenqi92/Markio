/**
 * Inject a CSS rules block keyed by the active theme so syntect's
 * Spaced class names (`.source`, `.keyword`, `.string`, …) get colors.
 *
 * 我们用语义化映射映到 themes.css 的 syntax-* 变量，主题切换会自动跟随。
 */
const STYLE_ID = "markio-syntax-theme";

const CSS = `
.hljs { color: var(--text); }
.hljs .keyword,
.hljs .storage.type,
.hljs .storage.modifier,
.hljs .declaration { color: var(--syntax-k); }
.hljs .string,
.hljs .string.quoted { color: var(--syntax-s); }
.hljs .comment,
.hljs .comment.line,
.hljs .comment.block { color: var(--syntax-c); font-style: italic; }
.hljs .constant,
.hljs .constant.numeric,
.hljs .number { color: var(--syntax-n); }
.hljs .entity.name.function,
.hljs .support.function,
.hljs .meta.function-call { color: var(--syntax-h); }
.hljs .entity.name.tag,
.hljs .entity.name.type { color: var(--syntax-h); }
.hljs .punctuation.definition.string { color: var(--syntax-s); }
.hljs .variable,
.hljs .variable.parameter,
.hljs .source { color: var(--text); }
.hljs .invalid { color: #ff453a; }
.hljs .markup.bold { font-weight: 700; }
.hljs .markup.italic { font-style: italic; }
.hljs .markup.heading { color: var(--syntax-h); font-weight: 700; }
.hljs .markup.underline.link { color: var(--accent); text-decoration: underline; }
`;

export function injectSyntaxTheme() {
  if (typeof document === "undefined") return;
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = CSS;
}
