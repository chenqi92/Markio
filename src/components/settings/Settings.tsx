import { useEffect, useState } from "react";
import { Icon, type IconName } from "../ui/Icon";
import { About } from "./sections/About";
import { WebClipper } from "./sections/WebClipper";
import { MobileDevices } from "./sections/MobileDevices";
import { RssFeeds } from "./sections/RssFeeds";
import { McpServerSettings } from "./sections/Mcp";
import { General } from "./sections/General";
import { Editor } from "./sections/Editor";
import { WeChat } from "./sections/WeChat";
import { WxAssistant } from "./sections/WxAssistant";
import { SmartChannelSettings } from "./sections/SmartChannel";
import { Shortcuts } from "./sections/Shortcuts";
import { Appearance } from "./sections/Appearance";
import { AI } from "./sections/AI";
import { Picgo } from "./sections/Picgo";
import { RagSettings } from "./sections/Rag";
import { ImportExport } from "./sections/ImportExport";
import { Sync } from "./sections/Sync";
import { useSettings } from "@/stores/settings";
import { useWorkspace as useWorkspaceStore } from "@/stores/workspace";
import { isDarkTheme } from "@/themes";
import { displayPath } from "@/lib/utils";
import { useTranslation } from "react-i18next";


/** 设置导航分组：参考 mdview-design 把分区按用途分到 通用 / 工作流 / 集成 / 其他。
 *  顺序决定 UI 渲染顺序；nav 在每段第一项前插入分组标题。 */
const SECTION_GROUPS: ReadonlyArray<{
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

type SectionId = (typeof SECTION_GROUPS)[number]["items"][number]["id"];

/** 在没有 useTranslation 上下文的工具里偶尔需要，普通组件用 useTranslation(). */
function sectionLabel(t: (k: string) => string, id: SectionId): string {
  return t(`settings.sections.${id}`);
}

export function Settings({ onClose }: { onClose: () => void }) {
  const [section, setSection] = useState<SectionId>("appear");
  const [query, setQuery] = useState("");
  const { t } = useTranslation();
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace());
  const theme = useSettings((s) => s.theme);
  const brandIcon = isDarkTheme(theme)
    ? "/brand/icon-dark-256.png"
    : "/brand/icon-light-256.png";

  // Esc 关闭 —— App 层也注册了 app.escape，但当焦点在 settings 输入框里时
  // App 层 keydown 会被 input 吞掉，所以本组件兜底再监听一次。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 顶部搜索：按 section 名称做大小写不敏感的匹配；命中 0 项时不隐藏 nav
  // （保持空间稳定），只把不匹配项 dim 掉。
  const q = query.trim().toLowerCase();
  const matches = (id: string): boolean => {
    if (!q) return true;
    const label = sectionLabel(t, id as SectionId).toLowerCase();
    const header = t(`settings.headers.${id}.h`).toLowerCase();
    return label.includes(q) || header.includes(q) || id.toLowerCase().includes(q);
  };

  const footerName = activeWorkspace?.name ?? t("settings.workspace.localUser", { defaultValue: "本地用户" });
  const footerSub = activeWorkspace?.path
    ? displayPath(activeWorkspace.path)
    : t("settings.workspace.noWorkspace", { defaultValue: "尚未打开仓库" });
  const footerInitial = (footerName || "M").trim().charAt(0).toUpperCase();

  return (
    <div className="settings-workspace" role="dialog" aria-label={t("settings.title")}>
      <div className="settings-topbar">
        <div className="settings-topbar-l">
          <div className="settings-mark" aria-hidden>
            <img src={brandIcon} alt="" draggable={false} />
          </div>
          <div className="settings-topbar-tt">
            <div className="settings-topbar-t">{t("settings.title")}</div>
            <div className="settings-topbar-s">
              {t("settings.subtitle", { defaultValue: "所有偏好在此 · 修改会即时生效" })}
            </div>
          </div>
        </div>
        <div className="settings-topbar-r">
          <div className="settings-search-top">
            <Icon name="search" size={12} />
            <input
              className="settings-search-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("settings.searchPlaceholder", { defaultValue: "搜索设置…" })}
              aria-label={t("settings.searchPlaceholder", { defaultValue: "搜索设置…" })}
            />
            {query ? (
              <button
                type="button"
                className="settings-search-clear"
                onClick={() => setQuery("")}
                aria-label="清空搜索"
                title="清空搜索"
              >
                <Icon name="x" size={12} />
              </button>
            ) : (
              <span className="kbd">⌘,</span>
            )}
          </div>
          <button
            type="button"
            className="settings-close"
            onClick={onClose}
            title={t("common.close")}
            aria-label={t("common.close")}
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      </div>

      <div className="settings-body2">
        <aside className="settings-nav2">
          {SECTION_GROUPS.map((grp) => (
            <div key={grp.group}>
              <div className="settings-nav2-group">
                {t(`settings.groups.${grp.group}`, {
                  defaultValue:
                    grp.group === "general"
                      ? "通用"
                      : grp.group === "workflow"
                        ? "工作流"
                        : grp.group === "integration"
                          ? "集成"
                          : "其他",
                })}
              </div>
              {grp.items.map((s) => {
                const dim = !matches(s.id);
                return (
                  <button
                    type="button"
                    key={s.id}
                    className={
                      "settings-nav2-item" +
                      (section === s.id ? " active" : "") +
                      (dim ? " dim" : "")
                    }
                    onClick={() => setSection(s.id as SectionId)}
                    tabIndex={dim ? -1 : 0}
                  >
                    <span className="ico">
                      <Icon name={s.icon} size={12} />
                    </span>
                    <span className="lbl">{sectionLabel(t, s.id as SectionId)}</span>
                  </button>
                );
              })}
            </div>
          ))}
          <div className="settings-nav2-foot">
            <div className="settings-nav2-foot-l">
              <div className="settings-nav2-foot-av">{footerInitial}</div>
              <div style={{ minWidth: 0 }}>
                <div className="t">{footerName}</div>
                <div className="s" title={footerSub}>{footerSub}</div>
              </div>
            </div>
          </div>
        </aside>
        <div className="settings-main2 scroll">
          {section === "appear" && <Appearance />}
          {section === "general" && <General />}
          {section === "editor" && <Editor />}
          {section === "sync" && <Sync />}
          {section === "shortcuts" && <Shortcuts />}
          {section === "picgo" && <Picgo />}
          {section === "clipper" && <WebClipper />}
          {section === "rss" && <RssFeeds />}
          {section === "mobile" && <MobileDevices />}
          {section === "wechat" && <WeChat />}
          {section === "wxAssistant" && <WxAssistant />}
          {section === "smartChannel" && <SmartChannelSettings />}
          {section === "mcp" && <McpServerSettings />}
          {section === "ai" && (
            <>
              <AI />
              <RagSettings />
            </>
          )}
          {section === "export" && <ImportExport />}
          {section === "about" && <About />}
        </div>
      </div>
    </div>
  );
}





// Web Clipper / RSS / 移动端 / 关于 / MCP server 的具体组件已迁移到 ./sections/

