/**
 * Settings 页面跨 section 共享的小组件、常量、工具函数。
 *
 * 原本都在 Settings.tsx 单文件里；拆 section 后必须抽出，否则每个 section
 * 文件都要重复定义。约定：本文件不含状态，只输出 React 组件 / 常量 / 纯函数。
 */
import type { CSSProperties, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Icon, type IconName } from "../ui/Icon";
import type { SelectOption } from "../ui/controls";
import { isMainlandAIRegion } from "@/lib/ai-region-policy";

export function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).pop() || "untitled";
}

export function contentTypeFromPath(path: string): string {
  const ext = fileNameFromPath(path).split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    md: "text/markdown",
    markdown: "text/markdown",
    txt: "text/plain",
    json: "application/json",
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    csv: "text/csv",
    html: "text/html",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    zip: "application/zip",
  };
  return (ext && map[ext]) || "application/octet-stream";
}

/** 设置导航分组：参考 mdview-design 把分区按用途分到 通用 / 工作流 / 集成 / 其他。
 *  顺序决定 UI 渲染顺序；nav 在每段第一项前插入分组标题。 */
export const SECTION_GROUPS: ReadonlyArray<{
  group: "general" | "workflow" | "integration" | "other";
  items: ReadonlyArray<{ id: string; icon: IconName }>;
}> = [
  {
    group: "general",
    items: [
      { id: "appear", icon: "palette" },
      { id: "general", icon: "sliders" },
      { id: "editor", icon: "edit" },
      { id: "shortcuts", icon: "cmd" },
    ],
  },
  {
    group: "workflow",
    items: [
      { id: "ai", icon: "sparkle" },
      { id: "export", icon: "upload" },
    ],
  },
  {
    group: "integration",
    items: [
      { id: "sync", icon: "sync" },
      { id: "picgo", icon: "image" },
      { id: "clipper", icon: "external" },
      { id: "rss", icon: "rss" },
      { id: "mobile", icon: "smartphone" },
      { id: "wechat", icon: "message" },
      { id: "wxAssistant", icon: "bot" },
      { id: "smartChannel", icon: "flame" },
      { id: "mcp", icon: "bot" },
    ],
  },
  {
    group: "other",
    items: [{ id: "about", icon: "info" }],
  },
];

export type SectionId = (typeof SECTION_GROUPS)[number]["items"][number]["id"];

/** 在没有 useTranslation 上下文的工具里偶尔需要，普通组件用 useTranslation(). */
export function sectionLabel(t: (k: string) => string, id: SectionId): string {
  return t(`settings.sections.${id}`);
}

export function SectionHeader({ id }: { id: SectionId }) {
  const { t } = useTranslation();
  const h = t(`settings.headers.${id}.h`);
  const sub = t(`settings.headers.${id}.sub`);
  return (
    <>
      <h2 className="settings-h">{h}</h2>
      {sub ? <p className="settings-sub">{sub}</p> : null}
    </>
  );
}

export const PICGO_ENDPOINT_OPTIONS = [
  { value: "http://127.0.0.1:36677", label: "http://127.0.0.1:36677" },
  { value: "http://localhost:36677", label: "http://localhost:36677" },
  { value: "http://127.0.0.1:36678", label: "http://127.0.0.1:36678" },
] as const satisfies readonly SelectOption<string>[];

export const WECHAT_STYLE_OPTIONS = [
  { value: "warmMagazine", label: "暖橘 · 杂志" },
  { value: "cleanTech", label: "清爽 · 科技" },
  { value: "inkClassic", label: "墨色 · 经典" },
  { value: "minimal", label: "极简 · 文章" },
] as const satisfies readonly SelectOption<"warmMagazine" | "cleanTech" | "inkClassic" | "minimal">[];

const ALL_SMART_CHANNEL_MODEL_OPTIONS = [
  { value: "aiDefault", label: "跟随 AI 助手设置" },
  { value: "deepCurrent", label: "深度模式（当前账户）" },
  { value: "fastCurrent", label: "快速模式（当前账户）" },
  { value: "localOllama", label: "本地 Ollama" },
] as const satisfies readonly SelectOption<
  "aiDefault" | "deepCurrent" | "fastCurrent" | "localOllama"
>[];

export const SMART_CHANNEL_MODEL_OPTIONS = ALL_SMART_CHANNEL_MODEL_OPTIONS.filter(
  (option) =>
    !isMainlandAIRegion() ||
    option.value === "aiDefault" ||
    option.value === "localOllama",
);

export const SMART_CHANNEL_SCOPE_OPTIONS = [
  { value: "currentFile", label: "仅当前文档" },
  { value: "currentWorkspace", label: "当前仓库" },
  { value: "allWorkspaces", label: "所有仓库" },
] as const satisfies readonly SelectOption<
  "currentFile" | "currentWorkspace" | "allWorkspaces"
>[];

export const SMART_CHANNEL_LIMIT_OPTIONS = [
  { value: 50, label: "50 次 / 天" },
  { value: 100, label: "100 次 / 天" },
  { value: 200, label: "200 次 / 天" },
  { value: 500, label: "500 次 / 天" },
  { value: 1000, label: "1000 次 / 天" },
] as const satisfies readonly SelectOption<50 | 100 | 200 | 500 | 1000>[];

export const SMART_CHANNEL_CHUNKS_OPTIONS = [
  { value: 3, label: "3 段 · 精准" },
  { value: 5, label: "5 段 · 平衡" },
  { value: 8, label: "8 段 · 宽松" },
  { value: 12, label: "12 段 · 全面" },
] as const satisfies readonly SelectOption<3 | 5 | 8 | 12>[];

export const SMART_CHANNEL_STYLE_OPTIONS = [
  { value: "concise", label: "简短 · 直接结论" },
  { value: "balanced", label: "平衡 · 结论+要点" },
  { value: "detailed", label: "详细 · 长答+摘录" },
] as const satisfies readonly SelectOption<"concise" | "balanced" | "detailed">[];

/** 网盘组列表：github 和 webdav 已经在上方各自的 GitSyncCard / WebDavCard 里
 *  独立成卡，这里不再列以免用户在网盘组里点 github 跳到上方 git 卡，造成
 *  "为什么 github 在网盘组里" 的困惑 (用户截图反馈)。 */
export const DRIVES = [
  { id: "icloud", name: "iCloud Drive", logo: "/brand/sync/icloud.svg", color: "#0a84ff", status: "未连接" },
  { id: "s3", name: "AWS S3 / 兼容", icon: "database" as IconName, color: "#ff9900", status: "未连接" },
  { id: "drop", name: "Dropbox", logo: "/brand/sync/dropbox.svg", color: "#0061ff", status: "未连接" },
  { id: "drive", name: "Google Drive", logo: "/brand/sync/googledrive.svg", color: "#34c759", status: "未连接" },
];

export function BrandMark({
  logo,
  icon,
  abbr,
  color,
  size = 24,
}: {
  logo?: string;
  icon?: IconName;
  abbr?: string;
  color: string;
  size?: number;
}) {
  return (
    <span
      className="brand-mark"
      style={
        {
          "--brand-color": color,
          width: size,
          height: size,
        } as CSSProperties
      }
    >
      {logo ? (
        <img src={logo} alt="" draggable={false} />
      ) : icon ? (
        <Icon name={icon} size={Math.max(13, size - 9)} />
      ) : (
        abbr
      )}
    </span>
  );
}

export function HelpTip({ text }: { text: string }) {
  return (
    <span
      className="settings-info"
      data-tip={text}
      tabIndex={0}
      aria-label={text}
    >
      ?
    </span>
  );
}

export function CardTitle({ children, tip }: { children: ReactNode; tip?: string }) {
  return (
    <div className="settings-card-h">
      <span className="settings-card-title">{children}</span>
      {tip && <HelpTip text={tip} />}
    </div>
  );
}

export function LabelWithTip({ children, tip }: { children: ReactNode; tip: string }) {
  return (
    <div className="settings-label settings-label-with-tip">
      <span>{children}</span>
      <HelpTip text={tip} />
    </div>
  );
}

const inputStyle: CSSProperties = {
  background: "var(--bg-pane-2)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "5px 8px",
  fontSize: 12,
  color: "var(--text)",
  outline: "none",
  minWidth: 180,
};

export function TextInput({
  value,
  placeholder,
  onChange,
}: {
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  return (
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      style={inputStyle}
    />
  );
}

export function NumberInput({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <input
      type="number"
      value={value}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (Number.isFinite(n) && n > 0) onChange(Math.round(n));
      }}
      style={{ ...inputStyle, width: 100 }}
    />
  );
}
