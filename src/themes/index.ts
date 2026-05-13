import type { ThemeDef } from "@/types";

export const THEMES: ThemeDef[] = [
  { id: "light", name: "浅色 · 默认", swatch: ["#e8e6e1", "#0a84ff", "#fff5e6"], isDark: false },
  { id: "dark", name: "深色 · 默认", swatch: ["#0a0a0c", "#5e9eff", "#1a1530"], isDark: true },
  { id: "solarized", name: "Solarized", swatch: ["#fdf6e3", "#b58900", "#586e75"], isDark: false },
  { id: "nord", name: "Nord", swatch: ["#2e3440", "#88c0d0", "#4c566a"], isDark: true },
  { id: "sepia", name: "Sepia 羊皮纸", swatch: ["#f4eadb", "#a05a14", "#5c4828"], isDark: false },
  { id: "hc", name: "高对比 黑金", swatch: ["#000000", "#ffc83d", "#1a1200"], isDark: true },
  { id: "dracula", name: "Dracula", swatch: ["#282a36", "#bd93f9", "#ff79c6"], isDark: true },
  { id: "rose", name: "Rose 桃粉", swatch: ["#fcf4f0", "#c43d63", "#f29274"], isDark: false },
];

export function applyTheme(id: string) {
  document.documentElement.dataset.theme = id;
}

export function isDarkTheme(id: string): boolean {
  return THEMES.find((t) => t.id === id)?.isDark ?? false;
}
