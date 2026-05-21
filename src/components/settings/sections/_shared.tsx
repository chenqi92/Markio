import type { CSSProperties, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { type IconName } from "../../ui/Icon";

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
      { id: "rag", icon: "search" },
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
    ],
  },
  {
    group: "other",
    items: [{ id: "about", icon: "info" }],
  },
];

export const SECTIONS = SECTION_GROUPS.flatMap((g) => g.items) as ReadonlyArray<{
  id: string;
  icon: IconName;
}>;

export type SectionId = (typeof SECTIONS)[number]["id"];

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

export const inputStyle: CSSProperties = {
  background: "var(--bg-pane-2)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "5px 8px",
  fontSize: 12,
  color: "var(--text)",
  outline: "none",
  minWidth: 180,
};

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
