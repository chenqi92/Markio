/**
 * 字体覆盖工具：把 settings 里的字体字段写到 :root CSS 变量。
 *
 * 三个 CSS 变量在 themes.css 里有默认值：--font-sans / --font-serif / --font-mono。
 * 当 settings 里某个字体字段为空串时，移除自定义覆盖、回退到主题默认。
 */

export interface FontPrefs {
  uiFontFamily: string;
  bodyFontFamily: string;
  monoFontFamily: string;
}

function setOrUnset(varName: string, value: string) {
  const root = document.documentElement;
  if (value.trim()) {
    root.style.setProperty(varName, value);
  } else {
    root.style.removeProperty(varName);
  }
}

export function applyFonts(prefs: FontPrefs) {
  if (typeof document === "undefined") return;
  setOrUnset("--font-sans", prefs.uiFontFamily);
  setOrUnset("--font-serif", prefs.bodyFontFamily);
  setOrUnset("--font-mono", prefs.monoFontFamily);
}

/** 字体下拉的预设。value 直接作为 CSS font-family 写入；空串表示「系统默认」。 */
export const UI_FONT_PRESETS: { value: string; label: string }[] = [
  { value: "", label: "系统默认" },
  {
    value:
      '"PingFang SC", "Hiragino Sans GB", -apple-system, "Microsoft YaHei", sans-serif',
    label: "苹方",
  },
  {
    value: '"Microsoft YaHei", "PingFang SC", sans-serif',
    label: "微软雅黑",
  },
  {
    value:
      '"Source Han Sans SC", "Noto Sans CJK SC", "Source Han Sans", sans-serif',
    label: "思源黑体",
  },
  { value: 'Inter, "PingFang SC", sans-serif', label: "Inter" },
  {
    value:
      '"SF Pro Text", -apple-system, "Helvetica Neue", "PingFang SC", sans-serif',
    label: "SF Pro",
  },
  {
    value: '"Segoe UI", "Microsoft YaHei", sans-serif',
    label: "Segoe UI",
  },
];

export const BODY_FONT_PRESETS: { value: string; label: string }[] = [
  { value: "", label: "系统默认（衬线）" },
  {
    value:
      '"Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", Georgia, serif',
    label: "思源宋体",
  },
  {
    value: '"Songti SC", SimSun, "Times New Roman", serif',
    label: "宋体",
  },
  {
    value: '"New York", "Iowan Old Style", Georgia, "Songti SC", serif',
    label: "New York",
  },
  { value: 'Georgia, "Songti SC", serif', label: "Georgia" },
  {
    value:
      '"PingFang SC", -apple-system, "Microsoft YaHei", sans-serif',
    label: "无衬线（同界面）",
  },
];

export const MONO_FONT_PRESETS: { value: string; label: string }[] = [
  { value: "", label: "系统默认" },
  { value: '"SF Mono", Menlo, Consolas, monospace', label: "SF Mono" },
  { value: '"JetBrains Mono", "SF Mono", monospace', label: "JetBrains Mono" },
  { value: '"Fira Code", "SF Mono", monospace', label: "Fira Code" },
  {
    value: '"Cascadia Code", "Consolas", monospace',
    label: "Cascadia Code",
  },
  { value: "Menlo, Consolas, monospace", label: "Menlo" },
  { value: "Consolas, Menlo, monospace", label: "Consolas" },
];
