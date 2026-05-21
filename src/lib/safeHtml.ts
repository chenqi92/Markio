// 统一 HTML 注入边界：
//   - trustedHtml：来自 Rust md_render 的输出（已被 ammonia 过滤），可直接使用
//   - sanitizeHtml：本地生成、来自用户或第三方库（KaTeX / mermaid / 用户片段）的 HTML，
//     都必须先过 DOMPurify。
//
// 约束：除测试代码外，禁止裸用 dangerouslySetInnerHTML / element.innerHTML，
// 全部走这两个函数之一。这样既保留 md_render 的零拷贝快路径，又把第三方
// HTML 集中到一个 sanitize 点。

import DOMPurify from "dompurify";

const FULL_PROFILE = {
  USE_PROFILES: { html: true, mathMl: true, svg: true, svgFilters: true },
} as const;

/** 来自后端 md_render（Rust ammonia）的输出，已可信，原样返回。 */
export function trustedHtml(html: string): string {
  return html;
}

/** 本地生成 / 来自第三方库的 HTML，必须 sanitize 后才能注入 DOM。 */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, FULL_PROFILE);
}
