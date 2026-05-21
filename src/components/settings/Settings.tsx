import { useEffect, useState } from "react";
import { Icon } from "../ui/Icon";
import { useWorkspace as useWorkspaceStore } from "@/stores/workspace";
import { displayPath } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import {
  SECTION_GROUPS,
  sectionLabel,
  type SectionId,
} from "./sections/_shared";
import { Appearance } from "./sections/Appearance";
import { General } from "./sections/General";
import { Editor } from "./sections/Editor";
import { Sync } from "./sections/Sync";
import { Shortcuts } from "./sections/Shortcuts";
import { Picgo } from "./sections/Picgo";
import { WeChat } from "./sections/WeChat";
import { WxAssistant } from "./sections/WxAssistant";
import { SmartChannelSettings } from "./sections/SmartChannel";
import { AI } from "./sections/AI";
import { RagSettings } from "./sections/Rag";
import { ImportExport } from "./sections/ImportExport";
import { WebClipper } from "./sections/WebClipper";
import { RssFeeds } from "./sections/RssFeeds";
import { MobileDevices } from "./sections/MobileDevices";
import { About } from "./sections/About";

export function Settings({ onClose }: { onClose: () => void }) {
  const [section, setSection] = useState<SectionId>("appear");
  const [query, setQuery] = useState("");
  const { t } = useTranslation();
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace());

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
          <div className="settings-mark" aria-hidden />
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
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("settings.searchPlaceholder", { defaultValue: "搜索设置…" })}
              aria-label={t("settings.searchPlaceholder", { defaultValue: "搜索设置…" })}
            />
            <span className="kbd">⌘ ,</span>
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
          {section === "ai" && <AI />}
          {section === "rag" && <RagSettings />}
          {section === "export" && <ImportExport />}
          {section === "about" && <About />}
        </div>
      </div>
    </div>
  );
}
