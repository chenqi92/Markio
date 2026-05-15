/**
 * 全局快捷键命令注册表 + 解析 / 匹配 / 显示工具。
 *
 * 命令 id 稳定（外部存储 override 用），label 走 i18n 文案，defaultBinding 用统一字符串：
 *   "Mod+K"、"Mod+Shift+F"、"Mod+Alt+1"、"Alt+Space"、"Escape"
 * 修饰键固定顺序：Mod → Ctrl → Alt → Shift → key。Mod 在 mac 是 Cmd，其他平台是 Ctrl。
 *
 * 空串 "" 表示用户显式取消绑定。
 */

export type CommandId =
  | "app.commandPalette"
  | "app.commandPaletteP"
  | "app.globalSearch"
  | "app.findInFile"
  | "app.save"
  | "app.newNote"
  | "app.openFile"
  | "app.openFolder"
  | "app.toggleAi"
  | "app.openExport"
  | "app.openSettings"
  | "app.toggleHistory"
  | "app.closeTab"
  | "app.toggleFocus"
  | "app.toggleSidebar"
  | "app.toggleOutline"
  | "app.viewSource"
  | "app.viewSplit"
  | "app.viewWysiwyg"
  | "app.viewPreview"
  | "app.quickCapture"
  | "app.escape";

export interface CommandDef {
  id: CommandId;
  label: string;
  group: string;
  defaultBinding: string;
}

export const COMMANDS: CommandDef[] = [
  // 导航
  { id: "app.commandPalette", label: "命令面板 / 快速打开", group: "导航", defaultBinding: "Mod+K" },
  { id: "app.commandPaletteP", label: "命令面板（备用）", group: "导航", defaultBinding: "Mod+P" },
  { id: "app.globalSearch", label: "全文搜索", group: "导航", defaultBinding: "Mod+Shift+F" },
  { id: "app.findInFile", label: "在文档内查找", group: "导航", defaultBinding: "Mod+F" },
  { id: "app.toggleFocus", label: "切换专注模式", group: "导航", defaultBinding: "Mod+." },
  { id: "app.quickCapture", label: "快速捕捉", group: "导航", defaultBinding: "Alt+Space" },
  { id: "app.escape", label: "关闭浮层 (Escape)", group: "导航", defaultBinding: "Escape" },

  // 视图
  { id: "app.viewSource", label: "源码视图", group: "视图", defaultBinding: "Mod+1" },
  { id: "app.viewSplit", label: "分屏视图", group: "视图", defaultBinding: "Mod+2" },
  { id: "app.viewWysiwyg", label: "所见即所得", group: "视图", defaultBinding: "Mod+3" },
  { id: "app.viewPreview", label: "阅读视图", group: "视图", defaultBinding: "Mod+4" },
  { id: "app.toggleSidebar", label: "侧栏开关", group: "视图", defaultBinding: "Mod+Shift+L" },
  { id: "app.toggleOutline", label: "大纲开关", group: "视图", defaultBinding: "Mod+Shift+R" },

  // 文档
  { id: "app.save", label: "保存", group: "文档", defaultBinding: "Mod+S" },
  { id: "app.newNote", label: "新建笔记", group: "文档", defaultBinding: "Mod+N" },
  { id: "app.closeTab", label: "关闭标签", group: "文档", defaultBinding: "Mod+W" },
  { id: "app.openFile", label: "打开单个文件…", group: "文档", defaultBinding: "Mod+O" },
  { id: "app.openFolder", label: "打开文件夹…", group: "文档", defaultBinding: "Mod+Shift+O" },
  { id: "app.openExport", label: "导出当前文档", group: "文档", defaultBinding: "Mod+E" },
  { id: "app.toggleHistory", label: "历史版本面板", group: "文档", defaultBinding: "Mod+Y" },

  // AI / 设置
  { id: "app.toggleAi", label: "AI 助手面板", group: "AI / 设置", defaultBinding: "Mod+J" },
  { id: "app.openSettings", label: "打开设置", group: "AI / 设置", defaultBinding: "Mod+," },
];

export const COMMANDS_BY_ID: Record<CommandId, CommandDef> = COMMANDS.reduce(
  (acc, c) => {
    acc[c.id] = c;
    return acc;
  },
  {} as Record<CommandId, CommandDef>,
);

export interface ParsedBinding {
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string; // 规范化后的 key（小写字母/数字/标点/特殊键名）
}

const SPECIAL_KEYS: Record<string, string> = {
  " ": "Space",
  spacebar: "Space",
  esc: "Escape",
  escape: "Escape",
  return: "Enter",
  enter: "Enter",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
};

function normalizeKey(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const lower = trimmed.toLowerCase();
  if (SPECIAL_KEYS[lower]) return SPECIAL_KEYS[lower];
  // 单字符（字母统一小写）
  if (trimmed.length === 1) return lower;
  // 形如 F1-F12 保留大写
  if (/^f([1-9]|1[0-2])$/i.test(trimmed)) return trimmed.toUpperCase();
  return trimmed;
}

export function parseBinding(binding: string): ParsedBinding | null {
  if (!binding) return null;
  const parts = binding.split("+").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  let mod = false;
  let ctrl = false;
  let alt = false;
  let shift = false;
  let key = "";
  for (const p of parts) {
    const lower = p.toLowerCase();
    if (lower === "mod" || lower === "cmd" || lower === "meta") mod = true;
    else if (lower === "ctrl" || lower === "control") ctrl = true;
    else if (lower === "alt" || lower === "option" || lower === "opt") alt = true;
    else if (lower === "shift") shift = true;
    else key = normalizeKey(p);
  }
  if (!key) return null;
  return { mod, ctrl, alt, shift, key };
}

export function normalizeBinding(binding: string): string {
  const p = parseBinding(binding);
  if (!p) return "";
  const out: string[] = [];
  if (p.mod) out.push("Mod");
  if (p.ctrl) out.push("Ctrl");
  if (p.alt) out.push("Alt");
  if (p.shift) out.push("Shift");
  out.push(p.key);
  return out.join("+");
}

/** 把 KeyboardEvent 转成规范化的 binding 字符串（用于录制 / 匹配）。 */
export function eventToBinding(e: KeyboardEvent): string | null {
  const mod = e.metaKey || e.ctrlKey;
  // 修饰键自己被按下时不算
  const k = e.key;
  if (k === "Meta" || k === "Control" || k === "Shift" || k === "Alt") return null;
  let key = normalizeKey(k);
  if (!key) return null;
  // Mod+数字键（"1" 等）保留为数字；字母统一小写已在 normalizeKey 处理
  const out: string[] = [];
  if (mod) out.push("Mod");
  if (e.altKey) out.push("Alt");
  if (e.shiftKey) out.push("Shift");
  out.push(key);
  return out.join("+");
}

export function matchesBinding(e: KeyboardEvent, binding: string): boolean {
  const p = parseBinding(binding);
  if (!p) return false;
  const mod = e.metaKey || e.ctrlKey;
  if (p.mod !== mod) return false;
  if (p.alt !== e.altKey) return false;
  if (p.shift !== e.shiftKey) return false;
  // ctrl 单独指定的场景这里允许：parseBinding 里如果显式写 "Ctrl+X"（不带 Mod），
  // 我们仍然把它当作 mod=false ctrl=true，但 KeyboardEvent 上 metaKey/ctrlKey 已经汇总进 mod，
  // 实际不会触发。设计上只用 "Mod" 表示跨平台修饰键，不暴露 "Ctrl"。
  const evKey = normalizeKey(e.key);
  if (evKey !== p.key) {
    // 数字键 "1" 在某些键盘 e.key 可能是 "!"（shift 1）；用 e.code 兜底
    if (e.code && /^Digit\d$/.test(e.code)) {
      const digit = e.code.slice(5);
      if (digit !== p.key) return false;
    } else {
      return false;
    }
  }
  return true;
}

const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export const isMacPlatform = IS_MAC;

/** 把任意含有 mac 风格修饰符号 (⌘ / ⌥ / ⇧ / ⌃) 的字符串改写成
 *  当前平台的展示形式：mac 原样、其它平台改成 Ctrl/Alt/Shift 加 + 号。
 *  例：
 *    "加粗 ⌘B"         → win: "加粗 Ctrl+B"
 *    "⌘⇧L"             → win: "Ctrl+Shift+L"
 *    "⌘"  (单字符)     → win: "Ctrl"
 *    "⌘↩ 发送"         → win: "Ctrl+Enter 发送"
 */
export function shortcutText(s: string): string {
  if (IS_MAC) return s;
  // 把连续修饰符号 + 紧跟的一个键合并：⌘⇧L → Ctrl+Shift+L、⌘ → Ctrl、⌘↩ → Ctrl+Enter
  return s.replace(
    /([⌘⌥⇧⌃]+)([A-Za-z0-9.,/↩↑↓←→]?)/g,
    (_, mods: string, key: string) => {
      const out: string[] = [];
      for (const ch of mods) {
        if (ch === "⌘" || ch === "⌃") out.push("Ctrl");
        else if (ch === "⌥") out.push("Alt");
        else if (ch === "⇧") out.push("Shift");
      }
      const pretty = key === "↩" ? "Enter" : key;
      if (pretty) out.push(pretty);
      return out.join("+");
    },
  );
}

/** 把 binding 字符串渲染成给用户看的按键 chip 数组。 */
export function formatBinding(binding: string): string[] {
  const p = parseBinding(binding);
  if (!p) return [];
  const out: string[] = [];
  if (p.mod) out.push(IS_MAC ? "⌘" : "Ctrl");
  if (p.alt) out.push(IS_MAC ? "⌥" : "Alt");
  if (p.shift) out.push(IS_MAC ? "⇧" : "Shift");
  let key = p.key;
  if (/^[a-z]$/.test(key)) key = key.toUpperCase();
  else if (key === "Space") key = "Space";
  else if (key === ",") key = ",";
  else if (key === ".") key = ".";
  out.push(key);
  return out;
}
