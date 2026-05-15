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

export function joinPath(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, "") : p.replace(/^[\\/]+|[\\/]+$/g, "")))
    .join("/");
}

export function debounce<T extends (...args: any[]) => void>(fn: T, wait: number): T {
  let t: ReturnType<typeof setTimeout> | null = null;
  return ((...args: any[]) => {
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
  return palette[hash % palette.length];
}
