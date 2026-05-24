// 默认拦截 markdown 渲染结果里的 http(s) 外链图片：
//   - canary / 像素追踪：纯靠图片请求泄漏 IP / 时间，开启文档就被打掉
//   - 慢站点：远程图未失败但拖慢首屏
//
// 拦截策略：把 <img src=...> 的 src 改为内联占位 SVG，原值挪到 data-original-src，
// 加 .blocked-remote-img class + tabIndex 让整张图作为按钮：点击 / 回车 → 恢复 src。
// 一旦用户点过，该图保持加载；切换文档会重新走一遍。
//
// 与设置 loadRemoteImages 联动：用户在 Settings → 通用 里开启后整体不拦截。

const PLACEHOLDER_SVG =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">
      <rect width="320" height="180" rx="8" fill="#f3f4f6" stroke="#d1d5db" stroke-width="1"/>
      <g transform="translate(160 78)" fill="none" stroke="#9ca3af" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <rect x="-22" y="-16" width="44" height="32" rx="3"/>
        <circle cx="-10" cy="-6" r="3"/>
        <path d="M-22 10 L-6 -2 L6 6 L22 -10"/>
      </g>
      <text x="160" y="124" font-size="12" fill="#6b7280" text-anchor="middle" font-family="-apple-system,system-ui,sans-serif">点击加载外链图片</text>
    </svg>`,
  );

const BLOCK_CLASS = "blocked-remote-img";
const ORIGINAL_ATTR = "data-original-src";

function isExternalHttp(src: string): boolean {
  return /^https?:\/\//i.test(src);
}

function blockOne(img: HTMLImageElement) {
  if (img.classList.contains(BLOCK_CLASS)) return;
  const src = img.getAttribute("src");
  if (!src || !isExternalHttp(src)) return;
  img.setAttribute(ORIGINAL_ATTR, src);
  img.setAttribute("src", PLACEHOLDER_SVG);
  img.classList.add(BLOCK_CLASS);
  img.setAttribute("tabindex", "0");
  img.setAttribute("role", "button");
  img.setAttribute("title", "点击加载外链图片");
}

function unblockOne(img: HTMLImageElement) {
  const original = img.getAttribute(ORIGINAL_ATTR);
  if (!original) return;
  img.setAttribute("src", original);
  img.removeAttribute(ORIGINAL_ATTR);
  img.classList.remove(BLOCK_CLASS);
  img.removeAttribute("tabindex");
  img.removeAttribute("role");
  img.removeAttribute("title");
}

/**
 * 把 root 内所有外链 <img> 切到占位符并注册点击恢复的委托。
 * 返回清理函数，调用后会撤销委托（但不会把已恢复的图重新拦截）。
 *
 * 若 root.querySelector 已被处理过（同一节点重复进入），会自动跳过。
 */
export function blockExternalImages(root: HTMLElement): () => void {
  root.querySelectorAll<HTMLImageElement>("img").forEach(blockOne);

  const onActivate = (target: HTMLImageElement) => {
    if (!target.classList.contains(BLOCK_CLASS)) return;
    unblockOne(target);
  };

  const onClick = (e: MouseEvent) => {
    const t = e.target as HTMLElement | null;
    if (!t) return;
    const img = t.closest<HTMLImageElement>(`img.${BLOCK_CLASS}`);
    if (!img) return;
    e.preventDefault();
    e.stopPropagation();
    onActivate(img);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const t = e.target as HTMLElement | null;
    if (!t) return;
    const img = t.closest<HTMLImageElement>(`img.${BLOCK_CLASS}`);
    if (!img) return;
    e.preventDefault();
    onActivate(img);
  };

  root.addEventListener("click", onClick, true);
  root.addEventListener("keydown", onKey);

  return () => {
    root.removeEventListener("click", onClick, true);
    root.removeEventListener("keydown", onKey);
  };
}

/** 暴露给测试的内部常量。 */
export const _internal = {
  PLACEHOLDER_SVG,
  BLOCK_CLASS,
  ORIGINAL_ATTR,
};
