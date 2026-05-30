export function uid(): string {
  // 24-bit timestamp + random, sufficient for client ids
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `${t}${r}`;
}

export function basename(path: string): string {
  if (!path) return "";
  const norm = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = norm.lastIndexOf("/");
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

/**
 * 把磁盘路径转成给用户看的形式：
 * - 去掉 Windows 扩展长度前缀 `\\?\` 和 `\\?\UNC\`
 * - 反斜杠统一为正斜杠，便于跨平台显示
 *
 * 仅用于显示；实际写盘 / 调 Tauri 命令仍要用原始路径。
 */
export function displayPath(path: string): string {
  if (!path) return "";
  let p = path;
  if (p.startsWith("\\\\?\\UNC\\")) {
    p = "\\\\" + p.slice("\\\\?\\UNC\\".length);
  } else if (p.startsWith("\\\\?\\")) {
    p = p.slice("\\\\?\\".length);
  }
  // 统一斜杠
  return p.replace(/\\/g, "/");
}

export function dirname(path: string): string {
  if (!path) return "";
  const norm = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = norm.lastIndexOf("/");
  return idx > 0 ? norm.slice(0, idx) : "/";
}

export function pathKey(path: string): string {
  const norm = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-zA-Z]:\//.test(norm) ? norm.toLowerCase() : norm;
}

export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

export function pathContains(parent: string, candidate: string): boolean {
  const p = pathKey(parent);
  const c = pathKey(candidate);
  return c === p || c.startsWith(`${p}/`);
}

export function joinPath(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, "") : p.replace(/^[\\/]+|[\\/]+$/g, "")))
    .join("/");
}

/**
 * 把 markdown 链接里的相对路径解析成绝对磁盘路径。
 * - 去掉 #anchor 和 ?query
 * - decodeURIComponent（空格 %20、中文等被编码的字符）
 * - 折叠 `./` 与 `../`
 *
 * `baseFilePath` 是当前笔记的绝对路径（解析基准取其所在目录）。
 * 返回 null 表示无法解析（空路径 / 纯锚点）。
 */
export function resolveRelativePath(
  baseFilePath: string,
  href: string,
): string | null {
  if (!baseFilePath || !href) return null;
  let rel = href.split("#")[0]!.split("?")[0]!;
  if (!rel) return null;
  try {
    rel = decodeURIComponent(rel);
  } catch {
    // 非法 % 转义序列：按原样处理
  }
  rel = rel.replace(/\\/g, "/");

  const driveRe = /^[a-zA-Z]:\//;
  let prefix = "";
  let segments: string[];
  if (rel.startsWith("/")) {
    prefix = "/";
    segments = rel.split("/");
  } else if (driveRe.test(rel)) {
    prefix = rel.slice(0, 3);
    segments = rel.slice(3).split("/");
  } else {
    const baseDir = dirname(baseFilePath).replace(/\\/g, "/");
    if (baseDir.startsWith("/")) prefix = "/";
    else if (driveRe.test(baseDir)) prefix = baseDir.slice(0, 3);
    const baseSegs = baseDir
      .replace(driveRe, "")
      .replace(/^\//, "")
      .split("/")
      .filter(Boolean);
    segments = [...baseSegs, ...rel.split("/")];
  }

  const stack: string[] = [];
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      stack.pop();
      continue;
    }
    stack.push(seg);
  }
  return prefix + stack.join("/");
}

/**
 * 生成标题锚点 slug，与 Rust 端 markdown::slugify 行为对齐：
 * 字母数字（含 CJK）转小写保留，空白 / - / _ 折叠成单个 -，去掉首尾 -。
 * 注意不处理同名标题的 `-2` 去重后缀（少见，调用方按需兜底）。
 */
export function slugifyHeading(text: string): string {
  let out = "";
  let lastDash = false;
  for (const ch of text) {
    if (/[\p{L}\p{N}]/u.test(ch)) {
      out += ch.toLowerCase();
      lastDash = false;
    } else if (/[\s\-_]/.test(ch) && !lastDash && out.length > 0) {
      out += "-";
      lastDash = true;
    }
  }
  while (out.endsWith("-")) out = out.slice(0, -1);
  return out || "section";
}

export function debounce<T extends (...args: never[]) => void>(fn: T, wait: number): T {
  let t: ReturnType<typeof setTimeout> | null = null;
  return ((...args: Parameters<T>) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  }) as T;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 把路径切成可点击的面包屑段 */
export function crumbSegments(workspacePath: string, filePath: string): string[] {
  if (!filePath) return [];
  const norm = filePath.replace(/\\/g, "/");
  const root = workspacePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const rel = norm.startsWith(root) ? norm.slice(root.length).replace(/^\/+/, "") : norm;
  const parts = rel.split("/").filter(Boolean);
  return [basename(root) || root, ...parts];
}

export function isMarkdownPath(p: string): boolean {
  return /\.(md|markdown|mdown)$/i.test(p);
}

export function classNames(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function initialFor(name: string): string {
  if (!name) return "·";
  const ch = name.trim()[0] || "·";
  return ch.toUpperCase();
}

export function colorForName(name: string): string {
  const palette = ["#0a84ff", "#5b8a6a", "#a05a14", "#bd93f9", "#c43d63", "#34c759", "#ff9500", "#88c0d0"];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return palette[hash % palette.length]!;
}
