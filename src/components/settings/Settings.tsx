import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import {
  UpdateDialog,
  ChangelogDialog,
  FeedbackDialog,
} from "../popovers/AboutDialogs";
import { Icon, type IconName } from "../ui/Icon";
import { Toggle, Slider, SelectBtn, type SelectOption } from "../ui/controls";
import { useSettings, generateChannelId, type DriveId, type DriveConfig } from "@/stores/settings";
import { useRag } from "@/stores/rag";
import { useUI } from "@/stores/ui";
import { useWorkspace as useWorkspaceStore } from "@/stores/workspace";
import { useCustomThemes } from "@/stores/customThemes";
import { useDialog } from "@/stores/dialog";
import { THEMES } from "@/themes";
import { api, pickDirectory, pickFile, type RagStatus } from "@/lib/api";
import * as aiCache from "@/lib/aiCache";
import { openExternal } from "@/lib/opener";
import { writeText } from "@/lib/clipboard";
import { smartChannelQuery, getSmartChannelUsage } from "@/lib/smartChannel";
import type { Locale } from "@/i18n";
import { useTranslation } from "react-i18next";
import { RagGraphMini } from "./RagGraphMini";
import {
  COMMANDS,
  type CommandDef,
  type CommandId,
  eventToBinding,
  formatBinding,
  normalizeBinding,
  shortcutText,
} from "@/lib/shortcuts";
import {
  UI_FONT_PRESETS,
  BODY_FONT_PRESETS,
  MONO_FONT_PRESETS,
} from "@/lib/fonts";
import {
  AI_PROVIDERS,
  getProvider,
  getProviderDefaults,
  type AIProviderId,
} from "@/lib/ai-providers";
import { AIModelPicker } from "./AIModelPicker";

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

const SECTIONS = SECTION_GROUPS.flatMap((g) => g.items) as ReadonlyArray<{
  id: string;
  icon: IconName;
}>;

type SectionId = (typeof SECTIONS)[number]["id"];

/** 在没有 useTranslation 上下文的工具里偶尔需要，普通组件用 useTranslation(). */
function sectionLabel(t: (k: string) => string, id: SectionId): string {
  return t(`settings.sections.${id}`);
}

function SectionHeader({ id }: { id: SectionId }) {
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

const PICGO_ENDPOINT_OPTIONS = [
  { value: "http://127.0.0.1:36677", label: "http://127.0.0.1:36677" },
  { value: "http://localhost:36677", label: "http://localhost:36677" },
  { value: "http://127.0.0.1:36678", label: "http://127.0.0.1:36678" },
] as const satisfies readonly SelectOption<string>[];

const WECHAT_STYLE_OPTIONS = [
  { value: "warmMagazine", label: "暖橘 · 杂志" },
  { value: "cleanTech", label: "清爽 · 科技" },
  { value: "inkClassic", label: "墨色 · 经典" },
  { value: "minimal", label: "极简 · 文章" },
] as const satisfies readonly SelectOption<"warmMagazine" | "cleanTech" | "inkClassic" | "minimal">[];

const SMART_CHANNEL_MODEL_OPTIONS = [
  { value: "aiDefault", label: "跟随 AI 助手设置" },
  { value: "currentClaude", label: "Claude（当前账户）" },
  { value: "currentOpenAI", label: "OpenAI（当前账户）" },
  { value: "localOllama", label: "本地 Ollama" },
] as const satisfies readonly SelectOption<
  "aiDefault" | "currentClaude" | "currentOpenAI" | "localOllama"
>[];

const SMART_CHANNEL_SCOPE_OPTIONS = [
  { value: "currentFile", label: "仅当前文档" },
  { value: "currentWorkspace", label: "当前仓库" },
  { value: "allWorkspaces", label: "所有仓库" },
] as const satisfies readonly SelectOption<
  "currentFile" | "currentWorkspace" | "allWorkspaces"
>[];

const SMART_CHANNEL_LIMIT_OPTIONS = [
  { value: 50, label: "50 次 / 天" },
  { value: 100, label: "100 次 / 天" },
  { value: 200, label: "200 次 / 天" },
  { value: 500, label: "500 次 / 天" },
  { value: 1000, label: "1000 次 / 天" },
] as const satisfies readonly SelectOption<50 | 100 | 200 | 500 | 1000>[];

const SMART_CHANNEL_CHUNKS_OPTIONS = [
  { value: 3, label: "3 段 · 精准" },
  { value: 5, label: "5 段 · 平衡" },
  { value: 8, label: "8 段 · 宽松" },
  { value: 12, label: "12 段 · 全面" },
] as const satisfies readonly SelectOption<3 | 5 | 8 | 12>[];

const SMART_CHANNEL_STYLE_OPTIONS = [
  { value: "concise", label: "简短 · 直接结论" },
  { value: "balanced", label: "平衡 · 结论+要点" },
  { value: "detailed", label: "详细 · 长答+摘录" },
] as const satisfies readonly SelectOption<"concise" | "balanced" | "detailed">[];

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
  const footerSub = activeWorkspace?.path ?? t("settings.workspace.noWorkspace", { defaultValue: "尚未打开仓库" });
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

function Appearance() {
  const { t } = useTranslation();
  const theme = useSettings((s) => s.theme);
  const setTheme = useSettings((s) => s.setTheme);
  const follow = useSettings((s) => s.followSystemTheme);
  const setFollow = useSettings((s) => s.setFollowSystemTheme);

  return (
    <>
      <SectionHeader id="appear" />
      <LanguageCard />
      <div className="settings-card">
        <div className="settings-card-h">{t("settings.appear.themeCard")}</div>
        <div className="theme-grid">
          {THEMES.map((t) => (
            <button
              type="button"
              key={t.id}
              className={"theme-tile" + (theme === t.id ? " active" : "")}
              onClick={() => setTheme(t.id)}
            >
              <div className="theme-preview" style={{ background: t.swatch[0] }}>
                <div className="tp-text" style={{ color: t.swatch[1] }}>Aa</div>
                <div className="tp-dot" style={{ background: t.swatch[1] }} />
                <div className="tp-dot" style={{ background: t.swatch[2] }} />
              </div>
              <div className="theme-name">{t.name}</div>
              {theme === t.id && <div className="theme-check">✓</div>}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card-h">{t("settings.appear.modeCard")}</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">{t("settings.appear.followSystem")}</div>
            <div className="settings-help">{t("settings.appear.followSystemHelp")}</div>
          </div>
          <Toggle on={follow} onChange={setFollow} />
        </div>
      </div>

      <FontCard />

      <CustomThemesCard />
    </>
  );
}

function FontCard() {
  const { t } = useTranslation();
  const fontSize = useSettings((s) => s.fontSize);
  const setFontSize = useSettings((s) => s.setFontSize);
  const uiFont = useSettings((s) => s.uiFontFamily);
  const bodyFont = useSettings((s) => s.bodyFontFamily);
  const monoFont = useSettings((s) => s.monoFontFamily);
  const setFontFamily = useSettings((s) => s.setFontFamily);
  const promptDialog = useDialog((s) => s.prompt);

  const renderFontRow = (
    kind: "ui" | "body" | "mono",
    label: string,
    help: string,
    presets: { value: string; label: string }[],
    current: string,
  ) => {
    const matched = presets.find((p) => p.value === current);
    const isCustom = !matched && current !== "";
    return (
      <div className="settings-row" key={kind}>
        <div className="settings-row-l">
          <div className="settings-label">{label}</div>
          <div className="settings-help">{help}</div>
        </div>
        <SelectBtn
          value={isCustom ? "__custom__" : current}
          options={[
            ...presets.map((p) => ({ value: p.value, label: p.label })),
            { value: "__custom__", label: t("common.custom") },
          ]}
          onChange={async (v) => {
            if (v === "__custom__") {
              const input = await promptDialog({
                title: t("settings.appear.customFontPrompt"),
                defaultValue: current || "",
                confirmLabel: t("common.save"),
              });
              if (input !== null) setFontFamily(kind, input.trim());
            } else {
              setFontFamily(kind, v);
            }
          }}
          minMenuWidth={200}
        />
      </div>
    );
  };

  return (
    <div className="settings-card">
      <div className="settings-card-h">{t("settings.appear.fontCard")}</div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">{t("settings.appear.fontSize")}</div>
          <div className="settings-help">{fontSize} px</div>
        </div>
        <Slider value={fontSize} min={13} max={22} onChange={setFontSize} />
      </div>
      {renderFontRow(
        "ui",
        t("settings.appear.uiFont"),
        t("settings.appear.uiFontHelp"),
        UI_FONT_PRESETS,
        uiFont,
      )}
      {renderFontRow(
        "body",
        t("settings.appear.bodyFont"),
        t("settings.appear.bodyFontHelp"),
        BODY_FONT_PRESETS,
        bodyFont,
      )}
      {renderFontRow(
        "mono",
        t("settings.appear.monoFont"),
        t("settings.appear.monoFontHelp"),
        MONO_FONT_PRESETS,
        monoFont,
      )}
    </div>
  );
}

function CustomThemesCard() {
  const { t } = useTranslation();
  const list = useCustomThemes((s) => s.list);
  const activeId = useCustomThemes((s) => s.activeId);
  const refresh = useCustomThemes((s) => s.refresh);
  const importFrom = useCustomThemes((s) => s.importFrom);
  const remove = useCustomThemes((s) => s.remove);
  const apply = useCustomThemes((s) => s.apply);
  const setPreference = useSettings((s) => s.setPreference);
  const confirmDialog = useDialog((s) => s.confirm);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const onImport = async () => {
    setErr(null);
    try {
      const picked = await pickFile([
        { name: "CSS", extensions: ["css"] },
      ]);
      if (!picked) return;
      setBusy("import");
      const meta = await importFrom(picked);
      await apply(meta.id);
      setPreference("customThemeId", meta.id);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  };

  const onApply = async (id: string | null) => {
    setErr(null);
    setBusy(id ?? "off");
    try {
      await apply(id);
      setPreference("customThemeId", id);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  };

  const onRemove = async (id: string) => {
    const ok = await confirmDialog({
      title: t("settings.appear.confirmRemoveTheme", { id }),
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (!ok) return;
    setErr(null);
    setBusy(id);
    try {
      await remove(id);
      if (activeId === id) setPreference("customThemeId", null);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="settings-card">
      <CardTitle tip={t("settings.appear.customThemeTip")}>
        {t("settings.appear.customThemeCard")}
      </CardTitle>
      <div className="settings-action-row">
        <button
          className="settings-btn primary"
          disabled={busy !== null}
          onClick={onImport}
        >
          {t("settings.appear.importCss")}
        </button>
        <button
          className="settings-btn"
          disabled={busy !== null}
          onClick={() => void refresh()}
        >
          {t("common.refresh")}
        </button>
        {activeId && (
          <button
            className="settings-btn"
            disabled={busy !== null}
            onClick={() => void onApply(null)}
          >
            {t("settings.appear.disableCustomTheme")}
          </button>
        )}
      </div>
      {err && (
        <div
          className="settings-help"
          style={{ color: "#ff453a", marginBottom: 8 }}
        >
          {err}
        </div>
      )}
      {list.length === 0 ? (
        <div className="settings-help">{t("settings.appear.noCustomThemes")}</div>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
          {list.map((it) => (
            <li
              key={it.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 0",
                borderTop: "1px solid var(--border)",
              }}
            >
              <span style={{ flex: 1 }}>
                <span style={{ fontWeight: activeId === it.id ? 600 : 400 }}>
                  {it.name}
                </span>
                <span
                  className="settings-help"
                  style={{ marginLeft: 8, fontSize: 11 }}
                >
                  {(it.size / 1024).toFixed(1)} KB
                </span>
              </span>
              <button
                className="settings-btn"
                disabled={busy !== null || activeId === it.id}
                onClick={() => void onApply(it.id)}
              >
                {activeId === it.id ? t("common.applied") : t("common.apply")}
              </button>
              <button
                className="settings-btn"
                disabled={busy !== null}
                onClick={() => void onRemove(it.id)}
                style={{ color: "#ff453a" }}
              >
                {t("common.delete")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LanguageCard() {
  const { t } = useTranslation();
  const loc = useSettings((s) => s.locale);
  const setLocaleAction = useSettings((s) => s.setLocale);
  return (
    <div className="settings-card">
      <div className="settings-row">
        <div className="settings-row-l">
          <LabelWithTip tip={t("settings.appear.languageTip")}>
            {t("settings.appear.languageLabel")}
          </LabelWithTip>
        </div>
        <SelectBtn
          value={loc}
          options={[
            { value: "zh-CN", label: "简体中文" },
            { value: "en", label: "English" },
          ] as const}
          onChange={(v) => setLocaleAction(v as Locale)}
        />
      </div>
    </div>
  );
}

function General() {
  const { t } = useTranslation();
  const startupBehavior = useSettings((s) => s.startupBehavior);
  const closeLastTabBehavior = useSettings((s) => s.closeLastTabBehavior);
  const showInTray = useSettings((s) => s.showInTray);
  const setPreference = useSettings((s) => s.setPreference);
  const startupOptions = useMemo(
    () =>
      (["restoreTabs", "lastWorkspace", "welcome"] as const).map((v) => ({
        value: v,
        label: t(`settings.general.startupOptions.${v}`),
      })),
    [t],
  );
  const closeOptions = useMemo(
    () =>
      (["keepWindow", "showWelcome", "quitApp"] as const).map((v) => ({
        value: v,
        label: t(`settings.general.closeLastTabOptions.${v}`),
      })),
    [t],
  );
  return (
    <>
      <SectionHeader id="general" />
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">{t("settings.general.startup")}</div>
          </div>
          <SelectBtn
            value={startupBehavior}
            options={startupOptions}
            onChange={(v) => setPreference("startupBehavior", v)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">
              {t("settings.general.closeLastTab")}
            </div>
          </div>
          <SelectBtn
            value={closeLastTabBehavior}
            options={closeOptions}
            onChange={(v) => setPreference("closeLastTabBehavior", v)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">{t("settings.general.showInTray")}</div>
            <div className="settings-help">
              {t("settings.general.showInTrayHelp")}
            </div>
          </div>
          <Toggle
            on={showInTray}
            onChange={(v) => {
              setPreference("showInTray", v);
              api.traySetVisible(v).catch(() => {
                /* 非桌面环境忽略 */
              });
            }}
          />
        </div>
      </div>
    </>
  );
}

function Editor() {
  const { t } = useTranslation();
  const mode = useSettings((s) => s.defaultMode);
  const setMode = useSettings((s) => s.setDefaultMode);
  const autosave = useSettings((s) => s.autosave);
  const setAutosave = useSettings((s) => s.setAutosave);
  const autosaveDelayMs = useSettings((s) => s.autosaveDelayMs);
  const shortcutStyle = useSettings((s) => s.shortcutStyle);
  const setShortcutStyle = useSettings((s) => s.setShortcutStyle);
  const setPreference = useSettings((s) => s.setPreference);
  const smartQuotes = useSettings((s) => s.smartQuotes);
  const autoListContinuation = useSettings((s) => s.autoListContinuation);
  const autoSpaceCJK = useSettings((s) => s.autoSpaceCJK);
  const snapshotOnSave = useSettings((s) => s.snapshotOnSave);
  const shortcutStyleItems = useMemo(
    () =>
      (["all", "bubble", "slash", "toolbar"] as const).map((id) => ({
        id,
        label: t(`settings.editor.shortcutStyle.${id}`),
      })),
    [t],
  );
  const bubbleTrigger = useSettings((s) => s.bubbleTrigger);
  const bubbleAllowed = shortcutStyle === "all" || shortcutStyle === "bubble";
  const bubbleTriggerItems = useMemo(
    () =>
      (["selection", "rightClick"] as const).map((id) => ({
        id,
        label: t(`settings.editor.bubbleTrigger.${id}`),
      })),
    [t],
  );
  const modeItems = useMemo(
    () =>
      (["source", "split", "wysiwyg", "preview"] as const).map((id) => ({
        id,
        label: t(`settings.editor.mode.${id}`),
      })),
    [t],
  );
  const autosaveDelayOptions = useMemo(
    () =>
      ([500, 800, 1500, 3000] as const).map((v) => ({
        value: v,
        label: t(`settings.editor.autosaveDelayOptions.${v}`),
      })),
    [t],
  );
  return (
    <>
      <SectionHeader id="editor" />
      <div className="settings-card">
        <div className="settings-card-h">{t("settings.editor.autosaveCard")}</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">
              {t("settings.editor.autosaveToggle")}
            </div>
            <div className="settings-help">
              {t("settings.editor.autosaveToggleHelp")}
            </div>
          </div>
          <Toggle on={autosave} onChange={setAutosave} />
        </div>
      </div>
      <div className="settings-card">
        <div className="settings-card-h">
          {t("settings.editor.shortcutStyleCard")}
        </div>
        {shortcutStyleItems.map((m) => (
          <button
            type="button"
            key={m.id}
            className={
              "settings-row settings-choice-row" +
              (shortcutStyle === m.id ? " active" : "")
            }
            onClick={() => setShortcutStyle(m.id)}
          >
            <div className="settings-row-l">
              <div className="settings-label">{m.label}</div>
            </div>
            <div className="settings-choice-dot" />
          </button>
        ))}
      </div>
      <div className="settings-card" aria-disabled={!bubbleAllowed}>
        <div className="settings-card-h">
          {t("settings.editor.bubbleTriggerCard")}
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-help">
              {t("settings.editor.bubbleTriggerHelp")}
            </div>
          </div>
        </div>
        {bubbleTriggerItems.map((m) => (
          <button
            type="button"
            key={m.id}
            disabled={!bubbleAllowed}
            className={
              "settings-row settings-choice-row" +
              (bubbleTrigger === m.id ? " active" : "")
            }
            onClick={() => setPreference("bubbleTrigger", m.id)}
          >
            <div className="settings-row-l">
              <div className="settings-label">{m.label}</div>
            </div>
            <div className="settings-choice-dot" />
          </button>
        ))}
      </div>
      <div className="settings-card">
        <div className="settings-card-h">{t("settings.editor.modeCard")}</div>
        {modeItems.map((m) => (
          <button
            type="button"
            key={m.id}
            className={
              "settings-row settings-choice-row" +
              (mode === m.id ? " active" : "")
            }
            onClick={() => setMode(m.id)}
          >
            <div className="settings-row-l">
              <div className="settings-label">{m.label}</div>
            </div>
            <div className="settings-choice-dot" />
          </button>
        ))}
      </div>
      <div className="settings-card">
        <div className="settings-card-h">{t("settings.editor.inputCard")}</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">{t("settings.editor.smartQuotes")}</div>
            <div className="settings-help">
              {t("settings.editor.smartQuotesHelp")}
            </div>
          </div>
          <Toggle
            on={smartQuotes}
            onChange={(v) => setPreference("smartQuotes", v)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">{t("settings.editor.autoList")}</div>
            <div className="settings-help">
              {t("settings.editor.autoListHelp")}
            </div>
          </div>
          <Toggle
            on={autoListContinuation}
            onChange={(v) => setPreference("autoListContinuation", v)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">
              {t("settings.editor.autoSpaceCJK")}
            </div>
            <div className="settings-help">
              {t("settings.editor.autoSpaceCJKHelp")}
            </div>
          </div>
          <Toggle
            on={autoSpaceCJK}
            onChange={(v) => setPreference("autoSpaceCJK", v)}
          />
        </div>
      </div>
      <div className="settings-card">
        <div className="settings-card-h">{t("settings.editor.saveCard")}</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">
              {t("settings.editor.autosaveDelay")}
            </div>
          </div>
          <SelectBtn
            value={autosaveDelayMs}
            options={autosaveDelayOptions}
            onChange={(v) => setPreference("autosaveDelayMs", v)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">
              {t("settings.editor.snapshotOnSave")}
            </div>
            <div className="settings-help">
              {t("settings.editor.snapshotOnSaveHelp")}
            </div>
          </div>
          <Toggle
            on={snapshotOnSave}
            onChange={(v) => setPreference("snapshotOnSave", v)}
          />
        </div>
      </div>
    </>
  );
}

const DRIVES = [
  { id: "icloud", name: "iCloud Drive", logo: "/brand/sync/icloud.svg", color: "#0a84ff", status: "未连接" },
  { id: "github", name: "GitHub", logo: "/brand/sync/github.svg", color: "#1f1f23", status: "未连接" },
  { id: "webdav", name: "WebDAV", icon: "cloud" as IconName, color: "#a05a14", status: "未连接" },
  { id: "s3", name: "AWS S3 / 兼容", icon: "database" as IconName, color: "#ff9900", status: "未连接" },
  { id: "drop", name: "Dropbox", logo: "/brand/sync/dropbox.svg", color: "#0061ff", status: "未连接" },
  { id: "drive", name: "Google Drive", logo: "/brand/sync/googledrive.svg", color: "#34c759", status: "未连接" },
];

function BrandMark({
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

function HelpTip({ text }: { text: string }) {
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

function CardTitle({ children, tip }: { children: ReactNode; tip?: string }) {
  return (
    <div className="settings-card-h">
      <span className="settings-card-title">{children}</span>
      {tip && <HelpTip text={tip} />}
    </div>
  );
}

function LabelWithTip({ children, tip }: { children: ReactNode; tip: string }) {
  return (
    <div className="settings-label settings-label-with-tip">
      <span>{children}</span>
      <HelpTip text={tip} />
    </div>
  );
}

function Sync() {
  const { t } = useTranslation();
  const conflict = useSettings((s) => s.syncConflictStrategy);
  const frequency = useSettings((s) => s.syncFrequency);
  const autoSync = useSettings((s) => s.autoSyncEnabled);
  const webdavBaseUrl = useSettings((s) => s.webdavBaseUrl);
  const s3Bucket = useSettings((s) => s.s3Bucket);
  const s3AccessKeyId = useSettings((s) => s.s3AccessKeyId);
  const driveConfigs = useSettings((s) => s.driveConfigs);
  const setPreference = useSettings((s) => s.setPreference);
  const conflictOptions = useMemo(
    () =>
      (["ask", "newest", "local", "remote"] as const).map((v) => ({
        value: v,
        label: t(`settings.sync.conflictOptions.${v}`),
      })),
    [t],
  );
  const frequencyOptions = useMemo(
    () =>
      (["manual", "30s", "1m", "5m"] as const).map((v) => ({
        value: v,
        label: t(`settings.sync.frequencyOptions.${v}`),
      })),
    [t],
  );

  // 5 个存储目标的概览行；状态 dot 只反映"是否已配置"，
  // 真实联通性还要看下方各卡片自己的 probe。
  const enabledDrives = Object.entries(driveConfigs).filter(([id, c]) => {
    if (id === "github" || id === "webdav") return false; // 这俩有专用卡，不计入网盘
    return c?.folder && c?.enabled;
  }).length;
  const targets: Array<{
    id: string;
    label: string;
    sub: string;
    dot: "ok" | "warn" | "off";
    anchor?: string;
  }> = [
    { id: "local", label: "本地", sub: "当前仓库永远落地到磁盘", dot: "ok" },
    {
      id: "git",
      label: "Git",
      sub: autoSync
        ? `自动 ${frequencyOptions.find((o) => o.value === frequency)?.label ?? frequency}`
        : "手动模式 · 在下方 Git 卡里推 / 拉",
      dot: autoSync ? "ok" : "off",
      anchor: "mk-sync-card-github",
    },
    {
      id: "webdav",
      label: "WebDAV",
      sub: webdavBaseUrl ? webdavBaseUrl : "未配置",
      dot: webdavBaseUrl ? "ok" : "off",
      anchor: "mk-sync-card-webdav",
    },
    {
      id: "s3",
      label: "S3 / 兼容",
      sub: s3Bucket && s3AccessKeyId ? `${s3Bucket}` : "未配置（图床用，不是双向同步）",
      dot: s3Bucket && s3AccessKeyId ? "ok" : "off",
      anchor: "mk-sync-card-drives",
    },
    {
      id: "drives",
      label: "网盘组",
      sub: enabledDrives > 0 ? `${enabledDrives} 个已启用` : "未启用 · iCloud / Dropbox / 等",
      dot: enabledDrives > 0 ? "ok" : "off",
      anchor: "mk-sync-card-drives",
    },
  ];

  const scrollTo = (anchor: string) => {
    const el = document.getElementById(anchor);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    el.classList.add("mk-flash");
    window.setTimeout(() => el.classList.remove("mk-flash"), 1600);
  };

  return (
    <>
      <SectionHeader id="sync" />

      {/* 顶部概览：5 个存储目标 + 状态点；点击滚到对应卡片 */}
      <div className="settings-card">
        <div className="settings-card-h">存储与同步目标</div>
        <div className="sync-overview">
          {targets.map((t) => (
            <button
              key={t.id}
              type="button"
              className="sync-target"
              onClick={() => t.anchor && scrollTo(t.anchor)}
              disabled={!t.anchor}
              title={t.anchor ? "跳到下方对应配置" : undefined}
            >
              <span className={`upload-dot upload-dot-${t.dot}`} />
              <div className="sync-target-tt">
                <div className="t">{t.label}</div>
                <div className="s">{t.sub}</div>
              </div>
              {t.anchor && (
                <span className="sync-target-chev" aria-hidden>›</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* 策略 — 提到第二位，让用户先看到"我会自动同步还是手动"再细配各目标 */}
      <div className="settings-card">
        <CardTitle tip={t("settings.sync.policyTip")}>
          {t("settings.sync.policyCard")}
        </CardTitle>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">{t("settings.sync.enableAutoSync")}</div>
          </div>
          <Toggle
            on={autoSync}
            onChange={(v) => setPreference("autoSyncEnabled", v)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">{t("settings.sync.onConflict")}</div>
          </div>
          <SelectBtn
            value={conflict}
            options={conflictOptions}
            onChange={(v) => setPreference("syncConflictStrategy", v)}
            minMenuWidth={220}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">{t("settings.sync.frequency")}</div>
          </div>
          <SelectBtn
            value={frequency}
            options={frequencyOptions}
            onChange={(v) => setPreference("syncFrequency", v)}
          />
        </div>
      </div>

      <div id="mk-sync-card-github">
        <GitSyncCard />
      </div>

      <div id="mk-sync-card-webdav">
        <WebDavCard />
      </div>

      <div id="mk-sync-card-drives">
        <DrivesCard />
      </div>
    </>
  );
}

function flashHighlight(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  el.classList.add("mk-flash");
  window.setTimeout(() => el.classList.remove("mk-flash"), 1600);
}

const DRIVE_HAS_NATIVE_CARD: Partial<Record<DriveId, string>> = {
  github: "mk-sync-card-github",
  webdav: "mk-sync-card-webdav",
};

function DrivesCard() {
  const { t } = useTranslation();
  const driveConfigs = useSettings((s) => s.driveConfigs);
  const webdavBaseUrl = useSettings((s) => s.webdavBaseUrl);
  const s3Bucket = useSettings((s) => s.s3Bucket);
  const s3AccessKeyId = useSettings((s) => s.s3AccessKeyId);
  const [expanded, setExpanded] = useState<DriveId | null>(null);

  const driveStatusText = (id: DriveId): string => {
    if (id === "github") {
      // GitSyncCard 自己管远端，这里只显示"详见上方卡片"
      return t("settings.sync.drive.openExisting", { name: "GitHub" });
    }
    if (id === "webdav") {
      return webdavBaseUrl
        ? t("settings.sync.driveStatus.connected", { folder: webdavBaseUrl })
        : t("settings.sync.driveStatus.disconnected");
    }
    if (id === "s3") {
      return s3Bucket && s3AccessKeyId
        ? t("settings.sync.driveStatus.connected", {
            folder: `${s3Bucket} · ${s3AccessKeyId.slice(0, 6)}…`,
          })
        : t("settings.sync.driveStatus.disconnected");
    }
    const cfg = driveConfigs[id];
    if (!cfg || !cfg.folder) {
      return t("settings.sync.driveStatus.disconnected");
    }
    if (!cfg.enabled) {
      return t("settings.sync.driveStatus.paused");
    }
    return t("settings.sync.driveStatus.connected", { folder: cfg.folder });
  };

  const onConfigureClick = (id: DriveId) => {
    const nativeId = DRIVE_HAS_NATIVE_CARD[id];
    if (nativeId) {
      flashHighlight(nativeId);
      return;
    }
    setExpanded((cur) => (cur === id ? null : id));
  };

  return (
    <div className="settings-card">
      <div className="settings-card-h">{t("settings.sync.drivesCard")}</div>
      {DRIVES.map((d) => {
        const id = d.id as DriveId;
        const isExpanded = expanded === id;
        return (
          <div key={d.id}>
            <div className="settings-row">
              <div className="settings-row-l">
                <div
                  className="settings-label"
                  style={{ display: "flex", alignItems: "center", gap: 8 }}
                >
                  <BrandMark
                    logo={"logo" in d ? d.logo : undefined}
                    icon={"icon" in d ? d.icon : undefined}
                    color={d.color}
                    size={22}
                  />
                  {d.name}
                </div>
                <div className="settings-help">{driveStatusText(id)}</div>
              </div>
              <button
                className="settings-btn"
                type="button"
                onClick={() => onConfigureClick(id)}
              >
                {DRIVE_HAS_NATIVE_CARD[id]
                  ? t("settings.sync.drive.configure")
                  : isExpanded
                    ? t("settings.sync.drive.collapse")
                    : t("settings.sync.drive.configure")}
              </button>
            </div>
            {isExpanded && id === "s3" && <S3DriveDrawer />}
            {isExpanded && id === "drop" && <DropboxDriveDrawer />}
            {isExpanded && id === "drive" && <GDriveDriveDrawer />}
            {isExpanded && id === "icloud" && (
              <FolderDriveDrawer driveId={id} driveName={d.name} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function FolderDriveDrawer({
  driveId,
  driveName,
}: {
  driveId: DriveId;
  driveName: string;
}) {
  const { t } = useTranslation();
  const driveConfigs = useSettings((s) => s.driveConfigs);
  const setPreference = useSettings((s) => s.setPreference);
  const cfg: DriveConfig = driveConfigs[driveId] ?? { folder: "", enabled: false };
  const [autoDetected, setAutoDetected] = useState<string | null>(null);

  useEffect(() => {
    if (driveId !== "icloud") return;
    api
      .icloudDefaultPath()
      .then((p) => setAutoDetected(p || null))
      .catch(() => setAutoDetected(null));
  }, [driveId]);

  const updateCfg = (patch: Partial<DriveConfig>) => {
    const next: Partial<Record<DriveId, DriveConfig>> = {
      ...driveConfigs,
      [driveId]: { ...cfg, ...patch },
    };
    setPreference("driveConfigs", next);
  };

  const pickFolder = async () => {
    const picked = await pickDirectory();
    if (picked) updateCfg({ folder: picked });
  };

  const useAutoDetected = () => {
    if (autoDetected) updateCfg({ folder: autoDetected });
  };

  const openInFileManager = () => {
    if (cfg.folder) void openExternal(cfg.folder);
  };

  const disconnect = () => {
    const next = { ...driveConfigs };
    delete next[driveId];
    setPreference("driveConfigs", next);
  };

  const isIcloud = driveId === "icloud";

  return (
    <div
      className="settings-drawer"
      style={{
        margin: "8px 0 12px",
        padding: 12,
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--surface-2)",
      }}
    >
      <div className="settings-help" style={{ marginBottom: 8 }}>
        {isIcloud
          ? "把 markio 仓库放进 iCloud Drive 文件夹，Apple 客户端会自动镜像到云端和其它设备。"
          : t("settings.sync.drive.folderHint", { name: driveName })}
      </div>
      {isIcloud && autoDetected && (
        <div
          className="settings-help"
          style={{
            padding: 8,
            border: "1px dashed var(--border)",
            borderRadius: 6,
            marginBottom: 8,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span style={{ flex: 1, wordBreak: "break-all" }}>
            侦测到本机 iCloud Drive：{autoDetected}
          </span>
          <button
            className="settings-btn"
            type="button"
            onClick={useAutoDetected}
            disabled={cfg.folder === autoDetected}
          >
            采用
          </button>
        </div>
      )}
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">{t("settings.sync.drive.pickFolder")}</div>
          <div className="settings-help" style={{ wordBreak: "break-all" }}>
            {cfg.folder || t("settings.sync.drive.noFolder")}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button className="settings-btn" type="button" onClick={pickFolder}>
            {t("settings.sync.drive.pickFolder")}
          </button>
          {cfg.folder && (
            <button className="settings-btn" type="button" onClick={openInFileManager}>
              打开
            </button>
          )}
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">{t("settings.sync.drive.enable")}</div>
        </div>
        <Toggle
          on={cfg.enabled && !!cfg.folder}
          onChange={(v) => updateCfg({ enabled: v })}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-help" style={{ color: "var(--text-3)" }}>
            {isIcloud
              ? "iCloud 的真实同步由 Apple 客户端进程负责；markio 只是把这个目录认作仓库根。"
              : t("settings.sync.drive.comingSoon")}
          </div>
        </div>
        {cfg.folder && (
          <button className="settings-btn" type="button" onClick={disconnect}>
            {t("settings.sync.drive.disconnect")}
          </button>
        )}
      </div>
    </div>
  );
}

function S3DriveDrawer() {
  const { t } = useTranslation();
  const s3Endpoint = useSettings((s) => s.s3Endpoint);
  const s3Region = useSettings((s) => s.s3Region);
  const s3Bucket = useSettings((s) => s.s3Bucket);
  const s3AccessKeyId = useSettings((s) => s.s3AccessKeyId);
  const s3PublicBaseUrl = useSettings((s) => s.s3PublicBaseUrl);
  const s3PathStyle = useSettings((s) => s.s3PathStyle);
  const setPreference = useSettings((s) => s.setPreference);

  const [secret, setSecret] = useState("");
  const [hasStoredSecret, setHasStoredSecret] = useState(false);
  const [busy, setBusy] = useState<"save" | "test" | "list" | "delete" | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [listPrefix, setListPrefix] = useState("");
  const [remoteObjects, setRemoteObjects] = useState<Array<{
    key: string;
    size: number;
    etag: string;
    lastModified: string;
  }> | null>(null);
  const [listTruncated, setListTruncated] = useState(false);
  const confirmDialog = useDialog((s) => s.confirm);

  const cfgPayload = () => ({
    endpoint: s3Endpoint,
    region: s3Region,
    bucket: s3Bucket,
    accessKeyId: s3AccessKeyId,
    secretAccessKey: "",
    publicBaseUrl: s3PublicBaseUrl || undefined,
    pathStyle: s3PathStyle,
  });

  useEffect(() => {
    if (!s3Endpoint) {
      setHasStoredSecret(false);
      return;
    }
    api.s3HasSecret(s3Endpoint).then(setHasStoredSecret).catch(() => setHasStoredSecret(false));
  }, [s3Endpoint]);

  const save = async () => {
    if (!s3Endpoint) {
      setMsg({ kind: "err", text: "endpoint 必填" });
      return;
    }
    setBusy("save");
    setMsg(null);
    try {
      if (secret) {
        await api.s3SetSecret(s3Endpoint, secret);
        setSecret("");
        setHasStoredSecret(true);
      }
      setMsg({ kind: "ok", text: t("settings.sync.drive.save") });
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    if (!s3Endpoint || !s3Bucket || !s3AccessKeyId) {
      setMsg({ kind: "err", text: "endpoint / bucket / accessKeyId 必填" });
      return;
    }
    setBusy("test");
    setMsg(null);
    try {
      const probeKey = `.markio/probe-${Date.now()}.txt`;
      const body = btoa("markio s3 connection probe");
      await api.s3PutObject(cfgPayload(), probeKey, body, "text/plain");
      setMsg({ kind: "ok", text: t("settings.sync.drive.testOk") });
    } catch (e) {
      setMsg({
        kind: "err",
        text: t("settings.sync.drive.testFailed", { msg: String(e) }),
      });
    } finally {
      setBusy(null);
    }
  };

  const listRemote = async () => {
    if (!s3Endpoint || !s3Bucket || !s3AccessKeyId) {
      setMsg({ kind: "err", text: "endpoint / bucket / accessKeyId 必填" });
      return;
    }
    setBusy("list");
    setMsg(null);
    try {
      const r = await api.s3ListObjects(cfgPayload(), listPrefix, undefined, 200);
      setRemoteObjects(r.objects);
      setListTruncated(r.isTruncated);
      if (r.objects.length === 0) {
        setMsg({ kind: "ok", text: "远端没有匹配的对象" });
      }
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
      setRemoteObjects(null);
    } finally {
      setBusy(null);
    }
  };

  const deleteRemote = async (key: string) => {
    const ok = await confirmDialog({
      title: "删除远端对象？",
      message: `${key} 将从远端存储中删除，此操作不可撤销。`,
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    setBusy("delete");
    setMsg(null);
    try {
      await api.s3DeleteObject(cfgPayload(), key);
      setRemoteObjects((cur) => cur?.filter((o) => o.key !== key) ?? null);
      setMsg({ kind: "ok", text: `已删除 ${key}` });
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const formatSize = (n: number): string => {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  };

  return (
    <div
      className="settings-drawer"
      style={{
        margin: "8px 0 12px",
        padding: 12,
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--surface-2)",
        display: "grid",
        gap: 8,
      }}
    >
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">Endpoint</div>
        </div>
        <input
          type="text"
          value={s3Endpoint}
          onChange={(e) => setPreference("s3Endpoint", e.target.value)}
          placeholder="https://s3.amazonaws.com"
          style={{ flex: 1, minWidth: 280 }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">Region</div>
        </div>
        <input
          type="text"
          value={s3Region}
          onChange={(e) => setPreference("s3Region", e.target.value)}
          placeholder="us-east-1"
          style={{ width: 200 }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">Bucket</div>
        </div>
        <input
          type="text"
          value={s3Bucket}
          onChange={(e) => setPreference("s3Bucket", e.target.value)}
          placeholder="markio-sync"
          style={{ flex: 1, minWidth: 280 }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">Access Key ID</div>
        </div>
        <input
          type="text"
          value={s3AccessKeyId}
          onChange={(e) => setPreference("s3AccessKeyId", e.target.value)}
          placeholder="AKIA…"
          style={{ flex: 1, minWidth: 280 }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">Secret Access Key</div>
          <div className="settings-help">
            {hasStoredSecret ? "已存入系统钥匙串" : "尚未保存"}
          </div>
        </div>
        <input
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder={hasStoredSecret ? "•••••• (留空保持现有)" : "secret"}
          style={{ flex: 1, minWidth: 280 }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">Public Base URL</div>
          <div className="settings-help">CDN/自定义域名，可留空</div>
        </div>
        <input
          type="text"
          value={s3PublicBaseUrl}
          onChange={(e) => setPreference("s3PublicBaseUrl", e.target.value)}
          placeholder="https://cdn.example.com"
          style={{ flex: 1, minWidth: 280 }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">Path-style URL</div>
          <div className="settings-help">兼容 MinIO / 自建 S3</div>
        </div>
        <Toggle
          on={s3PathStyle}
          onChange={(v) => setPreference("s3PathStyle", v)}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">前缀（用于浏览）</div>
          <div className="settings-help">可选；只列出 key 以此开头的对象</div>
        </div>
        <input
          type="text"
          value={listPrefix}
          onChange={(e) => setListPrefix(e.target.value)}
          placeholder="例如 markio/"
          style={{ flex: 1, minWidth: 280 }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l" />
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button
            className="settings-btn"
            type="button"
            disabled={busy !== null}
            onClick={save}
          >
            {t("settings.sync.drive.save")}
          </button>
          <button
            className="settings-btn"
            type="button"
            disabled={busy !== null}
            onClick={listRemote}
          >
            {busy === "list" ? "…" : "浏览远端"}
          </button>
          <button
            className="settings-btn primary"
            type="button"
            disabled={busy !== null}
            onClick={test}
          >
            {busy === "test" ? "…" : t("settings.sync.drive.testUpload")}
          </button>
        </div>
      </div>
      {remoteObjects && remoteObjects.length > 0 && (
        <div
          className="settings-help"
          style={{
            padding: 8,
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg-pane)",
            maxHeight: 240,
            overflow: "auto",
          }}
        >
          <div style={{ marginBottom: 6 }}>
            {remoteObjects.length} 个对象
            {listTruncated ? "（仅显示前 200）" : ""}
          </div>
          <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none" }}>
            {remoteObjects.map((o) => (
              <li
                key={o.key}
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  padding: "2px 0",
                  borderBottom: "1px dashed var(--border)",
                }}
              >
                <span style={{ flex: 1, wordBreak: "break-all" }}>{o.key}</span>
                <span style={{ color: "var(--text-3)", fontSize: 12 }}>
                  {formatSize(o.size)}
                </span>
                <button
                  className="settings-btn"
                  type="button"
                  disabled={busy !== null}
                  onClick={() => deleteRemote(o.key)}
                  title={`删除 ${o.key}`}
                  style={{ padding: "2px 8px" }}
                >
                  删除
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {msg && (
        <div
          className="settings-message"
          style={{ color: msg.kind === "err" ? "#dc2626" : "var(--accent)" }}
        >
          {msg.text}
        </div>
      )}
    </div>
  );
}

function DropboxDriveDrawer() {
  const clientId = useSettings((s) => s.dropboxClientId);
  const setPreference = useSettings((s) => s.setPreference);
  const [status, setStatus] = useState<{
    connected: boolean;
    display: string;
    accountId: string;
    expiresInSecs: number;
  } | null>(null);
  const [busy, setBusy] = useState<
    "auth" | "list" | "delete" | "upload" | "signout" | null
  >(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [listPath, setListPath] = useState("");
  const [entries, setEntries] = useState<
    Array<{ tag: string; name: string; pathLower: string; size: number; serverModified: string }>
    | null
  >(null);
  const [uploadPath, setUploadPath] = useState("");
  const confirmDialog = useDialog((s) => s.confirm);

  useEffect(() => {
    api.dropboxStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  const authorize = async () => {
    if (!clientId.trim()) {
      setMsg({ kind: "err", text: "请先填写 Dropbox App key (Client ID)" });
      return;
    }
    setBusy("auth");
    setMsg(null);
    try {
      const s = await api.dropboxAuthorize(clientId.trim());
      setStatus(s);
      setMsg({ kind: "ok", text: `授权成功：${s.display}` });
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const signout = async () => {
    const ok = await confirmDialog({
      title: "注销 Dropbox 授权？",
      message: "token 将从系统钥匙串中清除。",
      confirmLabel: "注销",
      danger: true,
    });
    if (!ok) return;
    setBusy("signout");
    try {
      await api.dropboxSignout();
      setStatus({ connected: false, display: "", accountId: "", expiresInSecs: 0 });
      setEntries(null);
      setMsg({ kind: "ok", text: "已注销" });
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const list = async () => {
    setBusy("list");
    setMsg(null);
    try {
      const r = await api.dropboxList(listPath || "");
      setEntries(r.entries);
      if (r.entries.length === 0) setMsg({ kind: "ok", text: "目录为空" });
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
      setEntries(null);
    } finally {
      setBusy(null);
    }
  };

  const del = async (path: string) => {
    const ok = await confirmDialog({
      title: "从 Dropbox 删除？",
      message: `${path} 将被删除，此操作不可撤销。`,
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    setBusy("delete");
    try {
      await api.dropboxDelete(path);
      setEntries((cur) => cur?.filter((e) => e.pathLower !== path.toLowerCase()) ?? null);
      setMsg({ kind: "ok", text: `已删除 ${path}` });
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const upload = async () => {
    if (!uploadPath.trim() || !uploadPath.startsWith("/")) {
      setMsg({ kind: "err", text: "上传路径需以 / 开头，例如 /markio/test.md" });
      return;
    }
    const localFile = await pickFile([{ name: "Any", extensions: ["*"] }]);
    if (!localFile) return;
    setBusy("upload");
    setMsg(null);
    try {
      const txt = await api.readText(localFile);
      const bodyBase64 = btoa(unescape(encodeURIComponent(txt)));
      await api.dropboxUpload(uploadPath.trim(), bodyBase64);
      setMsg({ kind: "ok", text: `已上传 ${localFile} → ${uploadPath}` });
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const connected = status?.connected;

  return (
    <div
      className="settings-drawer"
      style={{
        margin: "8px 0 12px",
        padding: 12,
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--surface-2)",
        display: "grid",
        gap: 8,
      }}
    >
      <div className="settings-help">
        在{" "}
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            void openExternal("https://www.dropbox.com/developers/apps");
          }}
        >
          Dropbox 开发者后台
        </a>{" "}
        注册一个 App（Scoped access, App folder 或 Full Dropbox），勾选
        files.content.write / files.content.read 权限，把 App key 填到下方。
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">App key (Client ID)</div>
        </div>
        <input
          type="text"
          value={clientId}
          onChange={(e) => setPreference("dropboxClientId", e.target.value)}
          placeholder="abc123xyz456"
          style={{ flex: 1, minWidth: 280 }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">连接状态</div>
          <div className="settings-help">
            {connected
              ? `已连接 · ${status?.display} · 还有 ${Math.max(0, status?.expiresInSecs ?? 0)} 秒过期`
              : "未连接"}
          </div>
        </div>
        {connected ? (
          <button
            className="settings-btn"
            type="button"
            disabled={busy !== null}
            onClick={signout}
          >
            注销
          </button>
        ) : (
          <button
            className="settings-btn primary"
            type="button"
            disabled={busy !== null || !clientId.trim()}
            onClick={authorize}
          >
            {busy === "auth" ? "授权中…浏览器已打开" : "授权"}
          </button>
        )}
      </div>
      {connected && (
        <>
          <div className="settings-row">
            <div className="settings-row-l">
              <div className="settings-label">浏览路径</div>
              <div className="settings-help">空字符串=根目录</div>
            </div>
            <input
              type="text"
              value={listPath}
              onChange={(e) => setListPath(e.target.value)}
              placeholder="/markio"
              style={{ flex: 1, minWidth: 280 }}
            />
            <button
              className="settings-btn"
              type="button"
              disabled={busy !== null}
              onClick={list}
            >
              {busy === "list" ? "…" : "列目录"}
            </button>
          </div>
          {entries && entries.length > 0 && (
            <div
              className="settings-help"
              style={{
                padding: 8,
                border: "1px solid var(--border)",
                borderRadius: 6,
                background: "var(--bg-pane)",
                maxHeight: 240,
                overflow: "auto",
              }}
            >
              <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none" }}>
                {entries.map((e) => (
                  <li
                    key={e.pathLower || e.name}
                    style={{
                      display: "flex",
                      gap: 8,
                      alignItems: "center",
                      padding: "2px 0",
                      borderBottom: "1px dashed var(--border)",
                    }}
                  >
                    <span style={{ color: "var(--text-3)", fontSize: 11 }}>
                      [{e.tag}]
                    </span>
                    <span style={{ flex: 1, wordBreak: "break-all" }}>
                      {e.name}
                    </span>
                    {e.tag === "file" && (
                      <span style={{ color: "var(--text-3)", fontSize: 12 }}>
                        {formatBytes(e.size)}
                      </span>
                    )}
                    <button
                      className="settings-btn"
                      type="button"
                      disabled={busy !== null}
                      onClick={() => del(e.pathLower || `/${e.name}`)}
                      style={{ padding: "2px 8px" }}
                    >
                      删除
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="settings-row">
            <div className="settings-row-l">
              <div className="settings-label">上传文本文件</div>
              <div className="settings-help">
                选一个本地文件，按下方路径上传到 Dropbox
              </div>
            </div>
            <input
              type="text"
              value={uploadPath}
              onChange={(e) => setUploadPath(e.target.value)}
              placeholder="/markio/test.md"
              style={{ flex: 1, minWidth: 240 }}
            />
            <button
              className="settings-btn"
              type="button"
              disabled={busy !== null}
              onClick={upload}
            >
              {busy === "upload" ? "…" : "选文件上传"}
            </button>
          </div>
        </>
      )}
      {msg && (
        <div
          className="settings-message"
          style={{ color: msg.kind === "err" ? "#dc2626" : "var(--accent)" }}
        >
          {msg.text}
        </div>
      )}
    </div>
  );
}

function GDriveDriveDrawer() {
  const clientId = useSettings((s) => s.gdriveClientId);
  const setPreference = useSettings((s) => s.setPreference);
  const [status, setStatus] = useState<{
    connected: boolean;
    display: string;
    expiresInSecs: number;
  } | null>(null);
  const [busy, setBusy] = useState<
    "auth" | "list" | "delete" | "upload" | "signout" | null
  >(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [listQ, setListQ] = useState("");
  const [files, setFiles] = useState<
    Array<{
      id: string;
      name: string;
      mimeType: string;
      size: number;
      modifiedTime: string;
    }>
    | null
  >(null);
  const confirmDialog = useDialog((s) => s.confirm);

  useEffect(() => {
    api.gdriveStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  const authorize = async () => {
    if (!clientId.trim()) {
      setMsg({ kind: "err", text: "请先填写 Google OAuth Client ID" });
      return;
    }
    setBusy("auth");
    setMsg(null);
    try {
      const s = await api.gdriveAuthorize(clientId.trim());
      setStatus(s);
      setMsg({ kind: "ok", text: `授权成功：${s.display}` });
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const signout = async () => {
    const ok = await confirmDialog({
      title: "注销 Google Drive 授权？",
      message: "token 将从系统钥匙串中清除。",
      confirmLabel: "注销",
      danger: true,
    });
    if (!ok) return;
    setBusy("signout");
    try {
      await api.gdriveSignout();
      setStatus({ connected: false, display: "", expiresInSecs: 0 });
      setFiles(null);
      setMsg({ kind: "ok", text: "已注销" });
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const list = async () => {
    setBusy("list");
    setMsg(null);
    try {
      const r = await api.gdriveList(listQ.trim());
      setFiles(r.files);
      if (r.files.length === 0) setMsg({ kind: "ok", text: "无匹配文件" });
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
      setFiles(null);
    } finally {
      setBusy(null);
    }
  };

  const del = async (file: { id: string; name: string }) => {
    const ok = await confirmDialog({
      title: "从 Google Drive 删除？",
      message: `${file.name} 将被删除，此操作不可撤销。`,
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    setBusy("delete");
    try {
      await api.gdriveDelete(file.id);
      setFiles((cur) => cur?.filter((f) => f.id !== file.id) ?? null);
      setMsg({ kind: "ok", text: `已删除 ${file.name}` });
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const upload = async () => {
    const localFile = await pickFile([{ name: "Any", extensions: ["*"] }]);
    if (!localFile) return;
    setBusy("upload");
    setMsg(null);
    try {
      const txt = await api.readText(localFile);
      const bodyBase64 = btoa(unescape(encodeURIComponent(txt)));
      const name = localFile.split(/[\\/]/).pop() || "untitled";
      const id = await api.gdriveUpload(name, null, null, bodyBase64, "text/markdown");
      setMsg({ kind: "ok", text: `已上传 ${name} (id=${id})` });
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const connected = status?.connected;

  return (
    <div
      className="settings-drawer"
      style={{
        margin: "8px 0 12px",
        padding: 12,
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--surface-2)",
        display: "grid",
        gap: 8,
      }}
    >
      <div className="settings-help">
        在{" "}
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            void openExternal("https://console.cloud.google.com/apis/credentials");
          }}
        >
          Google Cloud Console
        </a>{" "}
        创建一个 OAuth Client ID（Application type: Desktop app），并开启
        Google Drive API。把 Client ID 填到下方；首次授权会要求你同意
        drive.file scope（markio 只能访问自己创建/打开的文件）。
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">OAuth Client ID</div>
        </div>
        <input
          type="text"
          value={clientId}
          onChange={(e) => setPreference("gdriveClientId", e.target.value)}
          placeholder="123-abc.apps.googleusercontent.com"
          style={{ flex: 1, minWidth: 320 }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">连接状态</div>
          <div className="settings-help">
            {connected
              ? `已连接 · ${status?.display} · 还有 ${Math.max(0, status?.expiresInSecs ?? 0)} 秒过期`
              : "未连接"}
          </div>
        </div>
        {connected ? (
          <button
            className="settings-btn"
            type="button"
            disabled={busy !== null}
            onClick={signout}
          >
            注销
          </button>
        ) : (
          <button
            className="settings-btn primary"
            type="button"
            disabled={busy !== null || !clientId.trim()}
            onClick={authorize}
          >
            {busy === "auth" ? "授权中…浏览器已打开" : "授权"}
          </button>
        )}
      </div>
      {connected && (
        <>
          <div className="settings-row">
            <div className="settings-row-l">
              <div className="settings-label">查询表达式 q</div>
              <div className="settings-help">
                Drive v3 q 语法，空=按 modifiedTime 列出所有可访问文件。例如
                {` "name contains 'md'"`}
              </div>
            </div>
            <input
              type="text"
              value={listQ}
              onChange={(e) => setListQ(e.target.value)}
              placeholder="mimeType='text/markdown'"
              style={{ flex: 1, minWidth: 280 }}
            />
            <button
              className="settings-btn"
              type="button"
              disabled={busy !== null}
              onClick={list}
            >
              {busy === "list" ? "…" : "列文件"}
            </button>
          </div>
          {files && files.length > 0 && (
            <div
              className="settings-help"
              style={{
                padding: 8,
                border: "1px solid var(--border)",
                borderRadius: 6,
                background: "var(--bg-pane)",
                maxHeight: 240,
                overflow: "auto",
              }}
            >
              <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none" }}>
                {files.map((f) => (
                  <li
                    key={f.id}
                    style={{
                      display: "flex",
                      gap: 8,
                      alignItems: "center",
                      padding: "2px 0",
                      borderBottom: "1px dashed var(--border)",
                    }}
                  >
                    <span style={{ flex: 1, wordBreak: "break-all" }}>{f.name}</span>
                    <span style={{ color: "var(--text-3)", fontSize: 11 }}>
                      {f.mimeType}
                    </span>
                    <span style={{ color: "var(--text-3)", fontSize: 12 }}>
                      {formatBytes(f.size)}
                    </span>
                    <button
                      className="settings-btn"
                      type="button"
                      disabled={busy !== null}
                      onClick={() => del(f)}
                      style={{ padding: "2px 8px" }}
                    >
                      删除
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="settings-row">
            <div className="settings-row-l">
              <div className="settings-label">上传文本文件</div>
              <div className="settings-help">选一个本地文件，新建到 Drive 根目录</div>
            </div>
            <button
              className="settings-btn"
              type="button"
              disabled={busy !== null}
              onClick={upload}
            >
              {busy === "upload" ? "…" : "选文件上传"}
            </button>
          </div>
        </>
      )}
      {msg && (
        <div
          className="settings-message"
          style={{ color: msg.kind === "err" ? "#dc2626" : "var(--accent)" }}
        >
          {msg.text}
        </div>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

type GitStatusInfo = {
  head?: string;
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  files: Array<{ path: string; kind: string }>;
};

function GitSyncCard() {
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace());
  const workspacePath = activeWorkspace?.path ?? "";

  const [remoteUrl, setRemoteUrl] = useState("");
  const [pat, setPat] = useState("");
  const [storedPat, setStoredPat] = useState(false);
  const [status, setStatus] = useState<GitStatusInfo | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [commitMsg, setCommitMsg] = useState("");
  const [authorName, setAuthorName] = useState("markio");
  const [authorEmail, setAuthorEmail] = useState("markio@local");
  const [branches, setBranches] = useState<{
    current?: string;
    local: string[];
    remote: string[];
  } | null>(null);
  const [pullRebase, setPullRebase] = useState(false);
  const [conflict, setConflict] = useState<string[] | null>(null);

  useEffect(() => {
    if (!remoteUrl) {
      setStoredPat(false);
      return;
    }
    api.gitHasPat(remoteUrl).then(setStoredPat).catch(() => setStoredPat(false));
  }, [remoteUrl]);

  const refreshStatus = async () => {
    if (!workspacePath) return;
    setBusy("status");
    try {
      const s = await api.gitStatus(workspacePath);
      setStatus(s);
      setMessage(null);
      if (s.upstream && !remoteUrl) {
        // 不主动写 URL，只在用户清空时给个提示
      }
    } catch (e) {
      setStatus(null);
      setMessage({ kind: "err", text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const wrap = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setMessage(null);
    try {
      await fn();
      setMessage({ kind: "ok", text: `${label} 完成` });
      setConflict(null);
      await refreshStatus();
    } catch (e) {
      const text = String(e);
      if (text.includes("CONFLICT:")) {
        const files = text.split("CONFLICT:")[1].split("\n").filter(Boolean);
        setConflict(files);
        setMessage({ kind: "err", text: `${label} 冲突，需要解决 ${files.length} 个文件` });
      } else {
        setMessage({ kind: "err", text });
      }
    } finally {
      setBusy(null);
    }
  };

  const refreshBranches = useCallback(async () => {
    if (!workspacePath) return;
    try {
      const b = await api.gitListBranches(workspacePath);
      setBranches(b);
    } catch {
      setBranches(null);
    }
  }, [workspacePath]);

  useEffect(() => {
    void refreshBranches();
  }, [refreshBranches]);

  const savePat = async () => {
    if (!remoteUrl) {
      setMessage({ kind: "err", text: "请先填写仓库 URL" });
      return;
    }
    await wrap("PAT 保存", async () => {
      await api.gitSetPat(remoteUrl, pat);
      setPat("");
      setStoredPat(!!pat);
    });
  };

  const requireWs = (run: () => Promise<unknown>) => async () => {
    if (!workspacePath) {
      setMessage({ kind: "err", text: "请先选择一个工作仓库" });
      return;
    }
    await run();
  };

  // 统一状态行：dot 反映 head/working tree 状态；off=未检测，ok=clean+无 ahead/behind，warn=有变动或与远端不同步
  const gitStatusDot: "ok" | "warn" | "off" = !status
    ? "off"
    : status.files.length > 0 || status.ahead > 0 || status.behind > 0
      ? "warn"
      : "ok";
  const gitSummary = !status
    ? "尚未检测 · 点右侧「刷新」获取本地仓库状态"
    : `${status.branch ?? "(detached)"} · ↑${status.ahead} ↓${status.behind} · ${status.files.length} 个改动`;

  return (
    <div className="settings-card">
      <CardTitle tip="支持 clone、init、status、fetch、commit、pull、push、分支切换和冲突处理；PAT 仅保存在系统钥匙串。">
        Git 同步
      </CardTitle>

      <div className="sync-card-status">
        <span className={`upload-dot upload-dot-${gitStatusDot}`} aria-hidden />
        <div className="summary">
          {!status ? (
            gitSummary
          ) : (
            <>
              <span className="strong">{status.branch ?? "(detached)"}</span>
              <span className="dim"> · </span>
              <span>↑{status.ahead} ↓{status.behind}</span>
              <span className="dim"> · </span>
              <span>{status.files.length} 个改动</span>
            </>
          )}
        </div>
        <button
          className="settings-btn"
          type="button"
          onClick={refreshStatus}
          disabled={!workspacePath || busy === "status"}
        >
          {busy === "status" ? "检测中…" : "刷新"}
        </button>
      </div>

      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">当前工作仓库</div>
          <div className="settings-help">{workspacePath || "未选择"}</div>
        </div>
      </div>

      <div className="settings-row">
        <div className="settings-row-l">
          <LabelWithTip tip="形如 https://github.com/owner/repo.git">
            远端 URL（HTTPS）
          </LabelWithTip>
        </div>
        <input
          type="text"
          value={remoteUrl}
          onChange={(e) => setRemoteUrl(e.target.value)}
          placeholder="https://github.com/..."
          style={{ flex: 1, minWidth: 280 }}
        />
      </div>

      <div className="settings-row">
        <div className="settings-row-l">
          <LabelWithTip tip="仅保存到系统钥匙串，不写入本地设置。">
            Personal Access Token
          </LabelWithTip>
          <div className="settings-help">
            {storedPat ? "已存储" : "未存储"}
          </div>
        </div>
        <input
          type="password"
          value={pat}
          onChange={(e) => setPat(e.target.value)}
          placeholder="ghp_xxx..."
          style={{ flex: 1, minWidth: 280 }}
        />
        <button
          className="settings-btn"
          disabled={!remoteUrl || busy === "PAT 保存"}
          onClick={savePat}
        >
          保存 PAT
        </button>
      </div>

      <div className="settings-action-row">
        <button
          className="settings-btn"
          disabled={!workspacePath || busy !== null}
          onClick={requireWs(() => wrap("init", () => api.gitInit(workspacePath)))}
        >
          init
        </button>
        <button
          className="settings-btn"
          disabled={!workspacePath || !remoteUrl || busy !== null}
          onClick={requireWs(() =>
            wrap("clone", () => api.gitClone(remoteUrl, workspacePath, pat || undefined)),
          )}
        >
          clone
        </button>
        <button
          className="settings-btn"
          disabled={!workspacePath || busy !== null}
          onClick={requireWs(refreshStatus)}
        >
          status
        </button>
        <button
          className="settings-btn"
          disabled={!workspacePath || busy !== null}
          onClick={requireWs(() =>
            wrap("fetch", () => api.gitFetch(workspacePath, { pat: pat || undefined })),
          )}
        >
          fetch
        </button>
        <button
          className="settings-btn"
          disabled={!workspacePath || busy !== null}
          onClick={requireWs(() =>
            wrap("pull", () =>
              api.gitPull(workspacePath, {
                pat: pat || undefined,
                rebase: pullRebase,
              }),
            ),
          )}
        >
          pull{pullRebase ? " --rebase" : ""}
        </button>
        <button
          className="settings-btn primary"
          disabled={!workspacePath || busy !== null || !commitMsg.trim()}
          title={commitMsg.trim() ? "" : "请填写 commit message"}
          onClick={requireWs(() =>
            wrap("commit", () =>
              api.gitCommit(
                workspacePath,
                commitMsg.trim(),
                authorName || "markio",
                authorEmail || "markio@local",
              ),
            ),
          )}
        >
          commit -A
        </button>
        <button
          className="settings-btn"
          disabled={!workspacePath || busy !== null}
          onClick={requireWs(() =>
            wrap("push", () =>
              api.gitPush(workspacePath, {
                pat: pat || undefined,
                setUpstream: !status?.upstream,
              }),
            ),
          )}
        >
          push{!status?.upstream ? " -u" : ""}
        </button>
      </div>

      <div className="settings-row" style={{ marginTop: 6 }}>
        <div className="settings-row-l">
          <div className="settings-label">Commit message</div>
        </div>
        <input
          type="text"
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          placeholder="本次提交说明..."
          style={{ flex: 1, minWidth: 280 }}
        />
      </div>

      <div className="settings-row">
        <div className="settings-row-l">
          <LabelWithTip tip="提交时写入 GIT_AUTHOR_NAME 和 GIT_AUTHOR_EMAIL。">
            作者
          </LabelWithTip>
        </div>
        <input
          type="text"
          value={authorName}
          onChange={(e) => setAuthorName(e.target.value)}
          placeholder="Name"
          style={{ width: 160 }}
        />
        <input
          type="email"
          value={authorEmail}
          onChange={(e) => setAuthorEmail(e.target.value)}
          placeholder="email"
          style={{ flex: 1, minWidth: 220 }}
        />
      </div>

      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">分支</div>
          <div className="settings-help">
            当前：{branches?.current ?? "-"} · 本地 {branches?.local.length ?? 0}{" "}
            · 远端 {branches?.remote.length ?? 0}
          </div>
        </div>
        {branches && branches.local.length > 0 && (
          <select
            value={branches.current ?? ""}
            onChange={(e) =>
              wrap("checkout", () => api.gitCheckout(workspacePath, e.target.value))
            }
            disabled={busy !== null}
            style={{ minWidth: 180 }}
          >
            {branches.local.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        )}
        <button className="settings-btn" disabled={!workspacePath} onClick={refreshBranches}>
          刷新分支
        </button>
        <label
          style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12 }}
        >
          <input
            type="checkbox"
            checked={pullRebase}
            onChange={(e) => setPullRebase(e.target.checked)}
          />
          pull 用 rebase
        </label>
      </div>

      {conflict && conflict.length > 0 && (
        <div
          className="settings-help"
          style={{
            padding: 8,
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--surface-2)",
          }}
        >
          <div style={{ marginBottom: 6 }}>
            合并冲突 · {conflict.length} 个文件：
          </div>
          <ul style={{ margin: "0 0 8px", paddingLeft: 18 }}>
            {conflict.slice(0, 20).map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button
              className="settings-btn"
              onClick={() =>
                wrap("解决冲突 · 保留本地", () =>
                  api.gitResolveConflict(workspacePath, "ours", conflict),
                )
              }
            >
              保留本地
            </button>
            <button
              className="settings-btn"
              onClick={() =>
                wrap("解决冲突 · 采用远端", () =>
                  api.gitResolveConflict(workspacePath, "theirs", conflict),
                )
              }
            >
              采用远端
            </button>
            <button
              className="settings-btn"
              onClick={() =>
                wrap("放弃合并", () =>
                  api.gitResolveConflict(workspacePath, "abort", []),
                )
              }
            >
              放弃合并
            </button>
          </div>
        </div>
      )}

      {status && (
        <div className="settings-help" style={{ paddingTop: 6 }}>
          <div>
            分支：{status.branch ?? "(detached)"} · HEAD {status.head ?? "-"} ·
            上游 {status.upstream ?? "未设置"}
          </div>
          <div>
            未推送 {status.ahead} · 未拉取 {status.behind} · 变更{" "}
            {status.files.length}
          </div>
          {status.files.length > 0 && (
            <ul
              style={{
                margin: "6px 0 0",
                paddingLeft: 18,
                maxHeight: 120,
                overflow: "auto",
              }}
            >
              {status.files.slice(0, 20).map((f, i) => (
                <li key={i}>
                  <span style={{ color: "var(--text-3)" }}>[{f.kind}]</span>{" "}
                  {f.path}
                </li>
              ))}
              {status.files.length > 20 && (
                <li>… 还有 {status.files.length - 20} 个文件</li>
              )}
            </ul>
          )}
        </div>
      )}

      {message && (
        <div
          className="settings-message"
          style={{
            color: message.kind === "err" ? "#dc2626" : "var(--accent)",
          }}
        >
          {message.text}
        </div>
      )}
    </div>
  );
}

const MARKDOWN_EDITOR_SHORTCUTS: { l: string; k: string[] }[] = [
  { l: "加粗 / 斜体 / 链接", k: [shortcutText("⌘"), "B / I / K"] },
  { l: "高亮 / 删除线", k: [shortcutText("⌘"), shortcutText("⇧"), "H / X"] },
  { l: "标题 1–4", k: [shortcutText("⌘"), shortcutText("⌥"), "1–4"] },
  { l: "双向链接 / 表格 / 代码块 / 公式", k: [shortcutText("⌘"), shortcutText("⌥"), "L / T / C / M"] },
];

function Shortcuts() {
  const overrides = useSettings((s) => s.shortcutOverrides);
  const setShortcut = useSettings((s) => s.setShortcut);
  const { t } = useTranslation();
  const resetShortcut = useSettings((s) => s.resetShortcut);
  const resetAllShortcuts = useSettings((s) => s.resetAllShortcuts);
  const [recording, setRecording] = useState<CommandId | null>(null);
  const [error, setError] = useState<{ id: CommandId; msg: string } | null>(null);

  const effective = useMemo(() => {
    const out: Partial<Record<CommandId, string>> = {};
    for (const c of COMMANDS) {
      const o = overrides[c.id];
      const binding = o !== undefined ? o : c.defaultBinding;
      out[c.id] = normalizeBinding(binding);
    }
    return out as Record<CommandId, string>;
  }, [overrides]);

  const conflicts = useMemo(() => {
    const map = new Map<string, CommandId[]>();
    for (const c of COMMANDS) {
      const b = effective[c.id];
      if (!b) continue;
      const list = map.get(b);
      if (list) list.push(c.id);
      else map.set(b, [c.id]);
    }
    const set = new Set<CommandId>();
    for (const ids of map.values()) {
      if (ids.length > 1) ids.forEach((id) => set.add(id));
    }
    return set;
  }, [effective]);

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(null);
        setError(null);
        return;
      }
      const binding = eventToBinding(e);
      if (!binding) return;
      const normalized = normalizeBinding(binding);
      const taken = COMMANDS.find(
        (c) => c.id !== recording && effective[c.id] === normalized,
      );
      if (taken) {
        setError({
          id: recording,
          msg: t("settings.shortcuts.conflictWith", { name: taken.label }),
        });
        return;
      }
      setShortcut(recording, normalized);
      setRecording(null);
      setError(null);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, {
        capture: true,
      } as EventListenerOptions);
  }, [recording, effective, setShortcut, t]);

  const groups = useMemo(() => {
    const map = new Map<string, CommandDef[]>();
    for (const c of COMMANDS) {
      const list = map.get(c.group);
      if (list) list.push(c);
      else map.set(c.group, [c]);
    }
    return Array.from(map.entries());
  }, []);

  const dangerColor = "var(--danger, #c1432f)";

  return (
    <>
      <SectionHeader id="shortcuts" />
      <div className="settings-row" style={{ justifyContent: "flex-end" }}>
        <button
          className="settings-btn"
          onClick={() => {
            setRecording(null);
            setError(null);
            resetAllShortcuts();
          }}
        >
          {t("settings.shortcuts.resetAll")}
        </button>
      </div>
      {groups.map(([group, items]) => (
        <div className="settings-card" key={group}>
          <div className="settings-card-h">{group}</div>
          {items.map((cmd) => {
            const binding = effective[cmd.id];
            const isRecording = recording === cmd.id;
            const isConflict = conflicts.has(cmd.id);
            const hasOverride = overrides[cmd.id] !== undefined;
            const chips = formatBinding(binding);
            return (
              <div className="settings-row" key={cmd.id}>
                <div className="settings-row-l">
                  <div className="settings-label">{cmd.label}</div>
                  {error?.id === cmd.id ? (
                    <div className="settings-help" style={{ color: dangerColor }}>
                      {error.msg}
                    </div>
                  ) : isConflict ? (
                    <div className="settings-help" style={{ color: dangerColor }}>
                      {t("settings.shortcuts.conflict")}
                    </div>
                  ) : null}
                </div>
                <div className="kbd-group">
                  {isRecording ? (
                    <span
                      className="kbd"
                      style={{ minWidth: 120, textAlign: "center" }}
                    >
                      {t("settings.shortcuts.pressNewKey")}
                    </span>
                  ) : binding ? (
                    chips.map((k, i) => (
                      <span
                        key={i}
                        className="kbd"
                        style={
                          isConflict
                            ? { color: dangerColor, borderColor: dangerColor }
                            : undefined
                        }
                      >
                        {k}
                      </span>
                    ))
                  ) : (
                    <span className="kbd" style={{ opacity: 0.6 }}>
                      {t("settings.shortcuts.unbound")}
                    </span>
                  )}
                </div>
                <button
                  className="settings-btn"
                  onClick={() => {
                    setError(null);
                    setRecording(isRecording ? null : cmd.id);
                  }}
                >
                  {isRecording
                    ? t("settings.shortcuts.actions.cancel")
                    : t("settings.shortcuts.actions.record")}
                </button>
                <button
                  className="settings-btn"
                  onClick={() => {
                    setError(null);
                    setShortcut(cmd.id, "");
                  }}
                  disabled={!binding}
                  title={t("settings.shortcuts.unbound")}
                >
                  {t("settings.shortcuts.actions.clear")}
                </button>
                <button
                  className="settings-btn"
                  onClick={() => {
                    setError(null);
                    resetShortcut(cmd.id);
                  }}
                  disabled={!hasOverride}
                  title={t("common.reset")}
                >
                  {t("settings.shortcuts.actions.reset")}
                </button>
              </div>
            );
          })}
        </div>
      ))}
      <div className="settings-card">
        <div className="settings-card-h">
          {t("settings.shortcuts.markdownCard")}
        </div>
        {MARKDOWN_EDITOR_SHORTCUTS.map((it) => (
          <div className="settings-row" key={it.l}>
            <div className="settings-row-l">
              <div className="settings-label">{it.l}</div>
            </div>
            <div className="kbd-group">
              {it.k.map((k, i) => (
                <span key={i} className="kbd">
                  {k}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
      <GlobalShortcutCard />
    </>
  );
}

function GlobalShortcutCard() {
  const binding = useSettings((s) => s.globalShortcutShow);
  const setPreference = useSettings((s) => s.setPreference);
  const [recording, setRecording] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(false);
        return;
      }
      const b = eventToBinding(e);
      if (!b) return;
      const normalized = normalizeBinding(b);
      // 必须含修饰键，否则会和正常打字冲突
      if (!/^(Mod|Ctrl|Alt|Shift)\+/.test(normalized)) {
        setErr("全局快捷键必须包含修饰键（⌘ / Ctrl / Alt / Shift）");
        return;
      }
      setErr(null);
      setPreference("globalShortcutShow", normalized);
      setRecording(false);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, {
        capture: true,
      } as EventListenerOptions);
  }, [recording, setPreference]);

  const chips = formatBinding(binding);
  return (
    <div className="settings-card">
      <div className="settings-card-h">全局快捷键</div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">唤起 markio（应用未聚焦时也生效）</div>
          <div className="settings-help">
            按下后把 markio 主窗口拉到前台。系统级注册，可能与其他应用冲突；冲突时下次启动会注册失败。
            {err && <span style={{ color: "var(--danger, #c1432f)", marginLeft: 8 }}>{err}</span>}
          </div>
        </div>
        <div className="kbd-group">
          {recording ? (
            <span className="kbd" style={{ minWidth: 120, textAlign: "center" }}>
              按下新按键…
            </span>
          ) : binding ? (
            chips.map((k, i) => (
              <span key={i} className="kbd">
                {k}
              </span>
            ))
          ) : (
            <span className="kbd" style={{ opacity: 0.6 }}>未绑定</span>
          )}
        </div>
        <button
          className="settings-btn"
          onClick={() => {
            setErr(null);
            setRecording((v) => !v);
          }}
        >
          {recording ? "取消" : "录制"}
        </button>
        <button
          className="settings-btn"
          onClick={() => {
            setErr(null);
            setPreference("globalShortcutShow", "");
          }}
          disabled={!binding}
        >
          清除
        </button>
      </div>
    </div>
  );
}

type PicgoPingState =
  | { stage: "idle" }
  | { stage: "probing" }
  | { stage: "ok"; latencyMs: number }
  | { stage: "fail"; message: string };

function Picgo() {
  const { t } = useTranslation();
  const endpoint = useSettings((s) => s.picgoEndpoint);
  const pasteUpload = useSettings((s) => s.picgoPasteUpload);
  const dragUpload = useSettings((s) => s.picgoDragUpload);
  const keepLocalCopy = useSettings((s) => s.picgoKeepLocalCopy);
  const compressBeforeUpload = useSettings((s) => s.picgoCompressBeforeUpload);
  const quality = useSettings((s) => s.picgoQuality);
  const uploadProvider = useSettings((s) => s.uploadProvider);
  const setPreference = useSettings((s) => s.setPreference);

  const [ping, setPing] = useState<PicgoPingState>({ stage: "idle" });
  const probe = useCallback(async (ep: string) => {
    setPing({ stage: "probing" });
    try {
      const r = await api.picgoPing(ep);
      if (r.ok) {
        setPing({ stage: "ok", latencyMs: r.latencyMs });
      } else {
        setPing({ stage: "fail", message: r.message ?? "服务无响应" });
      }
    } catch (e) {
      setPing({ stage: "fail", message: (e as Error).message });
    }
  }, []);
  useEffect(() => {
    if (!endpoint) return;
    let cancelled = false;
    void (async () => {
      setPing({ stage: "probing" });
      try {
        const r = await api.picgoPing(endpoint);
        if (cancelled) return;
        if (r.ok) {
          setPing({ stage: "ok", latencyMs: r.latencyMs });
        } else {
          setPing({ stage: "fail", message: r.message ?? "服务无响应" });
        }
      } catch (e) {
        if (cancelled) return;
        setPing({ stage: "fail", message: (e as Error).message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [endpoint]);

  const statusText = (() => {
    switch (ping.stage) {
      case "idle":
        return t("settings.picgo.statusIdle");
      case "probing":
        return t("settings.picgo.statusProbing");
      case "ok":
        return t("settings.picgo.statusOk", { ms: ping.latencyMs });
      case "fail":
        return t("settings.picgo.statusFail", { reason: ping.message });
    }
  })();
  // 三个 provider 的"状态点 + 简介"，用于 tab 头和按钮副标
  const providerSummary: Record<typeof uploadProvider, { dot: "ok" | "warn" | "off"; text: string }> = {
    picgo: {
      dot: ping.stage === "ok" ? "ok" : ping.stage === "fail" ? "warn" : "off",
      text:
        ping.stage === "ok"
          ? `已连接 · ${ping.latencyMs} ms`
          : ping.stage === "fail"
          ? "未连接"
          : ping.stage === "probing"
          ? "检测中"
          : "未测试",
    },
    s3: { dot: "off", text: "S3 兼容图床（自己的 bucket）" },
    none: { dot: "off", text: "粘贴 / 拖入图片留在本地不上传" },
  };

  const cur = providerSummary[uploadProvider];

  return (
    <>
      <SectionHeader id="picgo" />

      {/* 3-tab 切换 — 一眼看到所有选项，不需要展开 dropdown 才知道还有 S3 */}
      <div className="settings-card">
        <div className="upload-tabs" role="tablist">
          {(["picgo", "s3", "none"] as const).map((id) => {
            const s = providerSummary[id];
            const active = uploadProvider === id;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={active}
                className={"upload-tab" + (active ? " active" : "")}
                onClick={() => setPreference("uploadProvider", id)}
              >
                <span className={`upload-dot upload-dot-${s.dot}`} />
                <div className="upload-tab-tt">
                  <div className="t">
                    {id === "picgo"
                      ? t("settings.picgo.providerOptions.picgo")
                      : id === "s3"
                      ? t("settings.picgo.providerOptions.s3")
                      : t("settings.picgo.providerOptions.none")}
                  </div>
                  <div className="s">{s.text}</div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* 选中 provider 的具体配置 */}
      {uploadProvider === "picgo" && (
        <div className="settings-card">
          <div className="settings-card-h">{t("settings.picgo.picgoCard")}</div>
          <div className="settings-row">
            <div className="settings-row-l">
              <div className="settings-label">{t("settings.picgo.status")}</div>
              <div
                className="settings-help"
                style={{
                  color:
                    ping.stage === "ok"
                      ? "var(--success, #2c9c5a)"
                      : ping.stage === "fail"
                      ? "var(--danger, #c1432f)"
                      : undefined,
                }}
              >
                {statusText}
              </div>
            </div>
            <button
              className="settings-btn"
              onClick={() => probe(endpoint)}
              disabled={!endpoint || ping.stage === "probing"}
            >
              {ping.stage === "probing"
                ? t("settings.picgo.rescanning")
                : t("settings.picgo.rescan")}
            </button>
          </div>
          <div className="settings-row">
            <div className="settings-row-l">
              <div className="settings-label">{t("settings.picgo.endpoint")}</div>
            </div>
            <SelectBtn
              value={endpoint}
              options={PICGO_ENDPOINT_OPTIONS}
              onChange={(v) => setPreference("picgoEndpoint", v)}
              minMenuWidth={230}
            />
          </div>
        </div>
      )}

      {uploadProvider === "s3" && <S3Card />}

      {uploadProvider === "none" && (
        <div className="settings-card">
          <div
            className="settings-help"
            style={{ padding: "12px 4px" }}
          >
            选择 "不上传" 后，粘贴 / 拖入的图片不会自动上传，只在本地按附件保存；笔记里走相对路径。
          </div>
        </div>
      )}

      {/* 通用行为 — 不上传时大部分无意义，整块淡化 */}
      <div
        className="settings-card"
        style={uploadProvider === "none" ? { opacity: 0.55 } : undefined}
      >
        <div className="settings-card-h">{t("settings.picgo.generalCard")}</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <LabelWithTip tip={t("settings.picgo.pasteAutoUploadTip")}>
              {t("settings.picgo.pasteAutoUpload")}
            </LabelWithTip>
          </div>
          <Toggle
            on={pasteUpload}
            onChange={(v) => setPreference("picgoPasteUpload", v)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">{t("settings.picgo.dragAutoUpload")}</div>
          </div>
          <Toggle
            on={dragUpload}
            onChange={(v) => setPreference("picgoDragUpload", v)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <LabelWithTip tip={t("settings.picgo.keepLocalCopyTip")}>
              {t("settings.picgo.keepLocalCopy")}
            </LabelWithTip>
          </div>
          <Toggle
            on={keepLocalCopy}
            onChange={(v) => setPreference("picgoKeepLocalCopy", v)}
          />
        </div>
      </div>

      {/* 压缩 — 同样上传时才有意义 */}
      <div
        className="settings-card"
        style={uploadProvider === "none" ? { opacity: 0.55 } : undefined}
      >
        <div className="settings-card-h">{t("settings.picgo.compressCard")}</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">{t("settings.picgo.compressToggle")}</div>
          </div>
          <Toggle
            on={compressBeforeUpload}
            onChange={(v) => setPreference("picgoCompressBeforeUpload", v)}
          />
        </div>
        {compressBeforeUpload && (
          <div className="settings-row">
            <div className="settings-row-l">
              <div className="settings-label">{t("settings.picgo.quality")}</div>
              <div className="settings-help">{quality}%</div>
            </div>
            <Slider
              value={quality}
              min={40}
              max={100}
              onChange={(v) => setPreference("picgoQuality", v)}
            />
          </div>
        )}
      </div>
      {/* 引用一下，避免 ping/cur 变量未使用警告（cur 暂留给后续侧栏状态展示） */}
      <div style={{ display: "none" }} aria-hidden>{cur.dot}</div>
    </>
  );
}

function WeChat() {
  const style = useSettings((s) => s.wechatStyle);
  const setPreference = useSettings((s) => s.setPreference);

  return (
    <>
      <SectionHeader id="wechat" />

      <div className="settings-card">
        <div className="settings-card-h">复制默认</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">默认导出样式</div>
            <div className="settings-help">公众号排版面板会默认选中这套样式。</div>
          </div>
          <SelectBtn
            value={style}
            options={WECHAT_STYLE_OPTIONS}
            onChange={(v) => setPreference("wechatStyle", v)}
          />
        </div>
      </div>
    </>
  );
}

function WxAssistant() {
  const enabled = useSettings((s) => s.wxAssistantEnabled);
  const webhook = useSettings((s) => s.wxAssistantWebhook);
  const dailyDigest = useSettings((s) => s.wxAssistantDailyDigest);
  const digestTime = useSettings((s) => s.wxAssistantDigestTime);
  const lastDigestSent = useSettings((s) => s.wxAssistantLastDigestSentDate);
  const setPreference = useSettings((s) => s.setPreference);
  const setToast = useUI((s) => s.setToast);
  const [draftHook, setDraftHook] = useState(webhook);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [digestBusy, setDigestBusy] = useState(false);
  const [digestMsg, setDigestMsg] = useState<string | null>(null);

  useEffect(() => setDraftHook(webhook), [webhook]);

  const saveHook = () => {
    setPreference("wxAssistantWebhook", draftHook.trim());
    setTestMsg("✓ 已保存");
  };

  const test = async () => {
    if (!draftHook.trim()) {
      setTestMsg("请先填入 webhook URL");
      return;
    }
    setTesting(true);
    setTestMsg(null);
    try {
      const body = JSON.stringify({
        msgtype: "text",
        text: { content: "[markio] 微信助手连通测试 · 收到这条消息即表示配置成功。" },
        title: "markio 微信助手测试",
        desp: "收到这条消息即表示配置成功。",
      });
      const r = await api.webhookPost(draftHook.trim(), body);
      if (!r.ok) {
        throw new Error(
          `HTTP ${r.status}${r.bodyExcerpt ? ` · ${r.bodyExcerpt.slice(0, 120)}` : ""}`,
        );
      }
      setTestMsg("✓ 已发送，请在微信里查收");
      setToast({ stage: "done", message: "测试消息已发送" });
      setTimeout(() => setToast(null), 2400);
    } catch (e) {
      setTestMsg(`✗ ${(e as Error).message}`);
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <SectionHeader id="wxAssistant" />

      <div className="settings-card">
        <div className="settings-card-h">总开关</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <LabelWithTip tip="关闭后所有通知都不会发出，已配置的 webhook 不会丢失。">
              启用微信助手
            </LabelWithTip>
          </div>
          <Toggle
            on={enabled}
            onChange={(v) => setPreference("wxAssistantEnabled", v)}
          />
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card-h">Webhook 地址</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <LabelWithTip tip="支持企业微信群机器人、Server 酱（sctapi.ftqq.com）、自建桥。POST JSON 即可。">
              推送 URL
            </LabelWithTip>
            <div className="settings-help">
              {webhook ? "已保存" : "未配置 · 推送将失败"}
            </div>
          </div>
          <input
            type="text"
            value={draftHook}
            onChange={(e) => setDraftHook(e.target.value)}
            onBlur={saveHook}
            placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..."
            style={{
              padding: "5px 10px",
              background: "var(--bg-input)",
              border: "0.5px solid var(--border-strong)",
              borderRadius: 6,
              width: 320,
              fontSize: 12,
              color: "var(--text)",
              fontFamily: "var(--font-mono)",
            }}
          />
        </div>
        <div className="settings-row" style={{ background: "var(--bg-pane-2)" }}>
          <div className="settings-row-l">
            <div className="settings-label" style={{ color: "var(--accent)" }}>
              发送测试
            </div>
            <div className="settings-help">
              {testMsg ?? "向上面的 webhook 推一条 [markio] 测试消息。"}
            </div>
          </div>
          <button
            className="settings-btn primary"
            disabled={testing || !enabled}
            onClick={test}
            title={!enabled ? "请先打开总开关" : undefined}
          >
            {testing ? "发送中…" : "发送测试"}
          </button>
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card-h">通知触发</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <LabelWithTip tip="每天定时把当日新增 / 修改过的笔记标题与摘要推送一次。">
              每日笔记摘要推送
            </LabelWithTip>
          </div>
          <Toggle
            on={dailyDigest && enabled}
            onChange={(v) => enabled && setPreference("wxAssistantDailyDigest", v)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">摘要推送时间</div>
            <div className="settings-help">24 小时制 · 仅在每日摘要打开时生效</div>
          </div>
          <input
            type="time"
            value={digestTime}
            onChange={(e) => setPreference("wxAssistantDigestTime", e.target.value)}
            disabled={!enabled || !dailyDigest}
            style={{
              padding: "5px 10px",
              background: "var(--bg-input)",
              border: "0.5px solid var(--border-strong)",
              borderRadius: 6,
              fontSize: 12,
              color: "var(--text)",
              fontFamily: "var(--font-mono)",
              opacity: !enabled || !dailyDigest ? 0.5 : 1,
            }}
          />
        </div>
        <div className="settings-row" style={{ background: "var(--bg-pane-2)" }}>
          <div className="settings-row-l">
            <div className="settings-label" style={{ color: "var(--accent)" }}>
              立即发送一次摘要
            </div>
            <div className="settings-help">
              {digestMsg ??
                (lastDigestSent
                  ? `上次推送：${lastDigestSent}`
                  : "拼好今日 recents + 字数后立刻推一次（不更新「今日已发」标记）")}
            </div>
          </div>
          <button
            className="settings-btn primary"
            disabled={digestBusy || !enabled || !webhook}
            onClick={async () => {
              setDigestBusy(true);
              setDigestMsg(null);
              try {
                const { sendDigestNow } = await import("@/lib/digestScheduler");
                const r = await sendDigestNow({ markSent: false });
                setDigestMsg(r.ok ? `✓ ${r.message}` : `✗ ${r.message}`);
                setToast({
                  stage: r.ok ? "done" : "error",
                  message: r.ok ? "摘要已推送" : `推送失败：${r.message}`,
                });
                setTimeout(() => setToast(null), 2400);
              } finally {
                setDigestBusy(false);
              }
            }}
            title={
              !enabled
                ? "请先打开总开关"
                : !webhook
                  ? "请先填 webhook URL"
                  : undefined
            }
          >
            {digestBusy ? "推送中…" : "立即发送"}
          </button>
        </div>
      </div>
    </>
  );
}

function SmartChannelSettings() {
  const enabled = useSettings((s) => s.smartChannelEnabled);
  const channelId = useSettings((s) => s.smartChannelId);
  const modelSource = useSettings((s) => s.smartChannelModelSource);
  const scope = useSettings((s) => s.smartChannelScope);
  const dailyLimit = useSettings((s) => s.smartChannelDailyLimit);
  const maxChunks = useSettings((s) => s.smartChannelMaxChunks);
  const includeAttachments = useSettings((s) => s.smartChannelIncludeAttachments);
  const responseStyle = useSettings((s) => s.smartChannelResponseStyle);
  const setPreference = useSettings((s) => s.setPreference);
  const setToast = useUI((s) => s.setToast);
  const ws = useWorkspaceStore((s) => s.activeWorkspace());
  const confirmDialog = useDialog((s) => s.confirm);

  const [usage, setUsage] = useState<{ used: number; limit: number }>({
    used: 0,
    limit: dailyLimit,
  });
  const [testQuery, setTestQuery] = useState("");
  const [testing, setTesting] = useState(false);
  const [testAnswer, setTestAnswer] = useState<string | null>(null);
  const [testRefs, setTestRefs] = useState<
    Array<{ path: string; heading: string }>
  >([]);
  const [testErr, setTestErr] = useState<string | null>(null);

  useEffect(() => {
    setUsage(getSmartChannelUsage());
  }, [enabled, dailyLimit]);

  const copyId = async () => {
    try {
      await writeText(channelId);
      setToast({ stage: "done", message: "通道 ID 已复制" });
      setTimeout(() => setToast(null), 1800);
    } catch {
      setToast({ stage: "error", message: "复制失败" });
      setTimeout(() => setToast(null), 1800);
    }
  };

  const rotate = async () => {
    const ok = await confirmDialog({
      title: "重置通道 ID？",
      message: "重置通道 ID 会让现有外部 app 失效。",
      confirmLabel: "重置",
      danger: true,
    });
    if (!ok) return;
    setPreference("smartChannelId", generateChannelId());
  };

  const runTest = async () => {
    if (!testQuery.trim()) {
      setTestErr("请输入问题");
      return;
    }
    setTesting(true);
    setTestErr(null);
    setTestAnswer(null);
    setTestRefs([]);
    try {
      const res = await smartChannelQuery({ query: testQuery.trim() });
      setTestAnswer(res.answer);
      setTestRefs(res.refs.map((r) => ({ path: r.path, heading: r.heading })));
      setUsage(getSmartChannelUsage());
    } catch (e) {
      setTestErr((e as Error).message);
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <SectionHeader id="smartChannel" />

      <div className="settings-card">
        <div className="settings-card-h">总开关</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <LabelWithTip tip="关闭后通道 ID 仍然保留，但所有调用都会被拒绝。">
              启用智能通道
            </LabelWithTip>
            <div className="settings-help">
              {ws ? `当前仓库 · ${ws.name}` : "尚未打开任何仓库 · 通道将无法检索"}
            </div>
          </div>
          <Toggle
            on={enabled}
            onChange={(v) => setPreference("smartChannelEnabled", v)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <LabelWithTip tip="发给外部应用作为唯一标识；重置后旧 ID 立即失效。">
              通道 ID
            </LabelWithTip>
            <div
              className="settings-help"
              style={{ fontFamily: "var(--font-mono)", userSelect: "all" }}
            >
              {channelId}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button className="settings-btn" onClick={copyId}>
              复制
            </button>
            <button className="settings-btn" onClick={rotate}>
              重置
            </button>
          </div>
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card-h">检索与回答</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <LabelWithTip tip="决定从哪里捞片段：当前文档够窄、所有仓库最广。">
              检索范围
            </LabelWithTip>
          </div>
          <SelectBtn
            value={scope}
            options={SMART_CHANNEL_SCOPE_OPTIONS}
            onChange={(v) => setPreference("smartChannelScope", v)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <LabelWithTip tip="挑选模型。aiDefault 表示使用 AI 助手当前配置。">
              模型来源
            </LabelWithTip>
          </div>
          <SelectBtn
            value={modelSource}
            options={SMART_CHANNEL_MODEL_OPTIONS}
            onChange={(v) => setPreference("smartChannelModelSource", v)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">每次回答带回的片段数</div>
          </div>
          <SelectBtn
            value={maxChunks}
            options={SMART_CHANNEL_CHUNKS_OPTIONS}
            onChange={(v) => setPreference("smartChannelMaxChunks", v)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">回答风格</div>
          </div>
          <SelectBtn
            value={responseStyle}
            options={SMART_CHANNEL_STYLE_OPTIONS}
            onChange={(v) => setPreference("smartChannelResponseStyle", v)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <LabelWithTip tip="试验中：把表格 / 图片附件的元数据一起带回。">
              附带附件元信息
            </LabelWithTip>
          </div>
          <Toggle
            on={includeAttachments}
            onChange={(v) => setPreference("smartChannelIncludeAttachments", v)}
          />
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card-h">配额</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">每日上限</div>
            <div className="settings-help">
              今日已调用 {usage.used} / {usage.limit} 次
            </div>
          </div>
          <SelectBtn
            value={dailyLimit}
            options={SMART_CHANNEL_LIMIT_OPTIONS}
            onChange={(v) => setPreference("smartChannelDailyLimit", v)}
          />
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card-h">提问测试</div>
        <div className="settings-row" style={{ alignItems: "flex-start" }}>
          <div className="settings-row-l" style={{ flex: 1 }}>
            <LabelWithTip tip="模拟外部 app 通过通道发起的查询；结果与外部一致。">
              测试问题
            </LabelWithTip>
            <textarea
              value={testQuery}
              onChange={(e) => setTestQuery(e.target.value)}
              placeholder={`例如：本周我写过哪些和"反脆弱"相关的笔记？`}
              rows={2}
              style={{
                marginTop: 8,
                width: "100%",
                padding: "7px 10px",
                background: "var(--bg-input)",
                border: "0.5px solid var(--border-strong)",
                borderRadius: 6,
                fontSize: 12,
                color: "var(--text)",
                resize: "vertical",
                fontFamily: "inherit",
              }}
            />
          </div>
          <button
            className="settings-btn primary"
            onClick={runTest}
            disabled={testing || !enabled}
            title={!enabled ? "请先开启总开关" : undefined}
            style={{ marginLeft: 12, alignSelf: "flex-end" }}
          >
            {testing ? "查询中…" : "发送"}
          </button>
        </div>
        {testErr && (
          <div
            className="settings-help"
            style={{ color: "#ff453a", padding: "0 16px 8px" }}
          >
            {testErr}
          </div>
        )}
        {testAnswer && (
          <div style={{ padding: "0 16px 12px", borderTop: "1px solid var(--border)" }}>
            <div
              className="settings-help"
              style={{ marginTop: 8, color: "var(--text-2)" }}
            >
              回答
            </div>
            <div
              style={{
                marginTop: 6,
                padding: 10,
                background: "var(--bg-pane-2)",
                borderRadius: 6,
                fontSize: 12,
                whiteSpace: "pre-wrap",
                lineHeight: 1.6,
                color: "var(--text)",
              }}
            >
              {testAnswer}
            </div>
            {testRefs.length > 0 && (
              <>
                <div className="settings-help" style={{ marginTop: 10 }}>
                  引用片段
                </div>
                <ul
                  style={{
                    margin: "4px 0 0",
                    padding: 0,
                    listStyle: "none",
                    fontSize: 12,
                  }}
                >
                  {testRefs.map((r, i) => (
                    <li
                      key={i}
                      style={{
                        padding: "3px 0",
                        color: "var(--text-3)",
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      · {r.path.split("/").slice(-1)[0]}
                      {r.heading ? ` — ${r.heading}` : ""}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>

      <div className="settings-card">
        <div className="settings-card-h">如何在其他工具里用</div>
        <div style={{ padding: "10px 16px 14px", fontSize: 12, lineHeight: 1.7, color: "var(--text-2)" }}>
          <p style={{ margin: 0 }}>
            智能通道在浏览器环境暴露为 <code>window.__markioSmartChannel</code>；
            在 Tauri 桌面端会附带本机进程内调用。外部应用可通过以下方式触发：
          </p>
          <ol style={{ margin: "8px 0 0 18px", padding: 0 }}>
            <li>
              命令面板（<code>{shortcutText("⌘K")}</code>）搜索"<b>通过智能通道查询</b>"，把当前问题发给同一引擎。
            </li>
            <li>
              Raycast / Alfred / 自建脚本通过 markio 的 webhook 触发器（路线图），
              POST <code>{`{"channelId":"${channelId.slice(0, 14)}…","query":"…"}`}</code>。
            </li>
            <li>
              微信助手 webhook（见左侧"微信助手"）收到查询消息时自动转发到此通道，回答再推回微信。
            </li>
          </ol>
        </div>
      </div>
    </>
  );
}

function AI() {
  const provider = useSettings((s) => s.aiProvider);
  const keyConfigured = useSettings((s) => s.aiKeyConfigured);
  const endpoint = useSettings((s) => s.aiEndpoint);
  const model = useSettings((s) => s.aiModel);
  const temperature = useSettings((s) => s.aiTemperature);
  const maxTokens = useSettings((s) => s.aiMaxTokens);
  const providerConfigs = useSettings((s) => s.aiProviderConfigs);
  const setAi = useSettings((s) => s.setAi);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const confirmDialog = useDialog((s) => s.confirm);

  const def = getProvider(provider);

  // endpoint / model 改动时落到当前 provider 的槽位，下次切回来还在。
  const persistProviderField = (patch: { endpoint?: string; model?: string }) => {
    const cur = providerConfigs[provider] ?? {};
    setAi({
      aiProviderConfigs: {
        ...providerConfigs,
        [provider]: { ...cur, ...patch },
      },
    });
  };

  const switchProvider = (id: AIProviderId) => {
    if (id === provider) return;
    const saved = providerConfigs[id] ?? {};
    const defaults = getProviderDefaults(id);
    setAi({
      aiProvider: id,
      aiEndpoint: saved.endpoint ?? defaults.endpoint,
      aiModel: saved.model ?? defaults.model,
    });
    setTestResult(null);
  };

  // 切换 provider 时刷新"是否已配"
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const has = await api.secretHas(`ai:${provider}`);
        if (!cancelled) setAi({ aiKeyConfigured: has });
      } catch {
        if (!cancelled) setAi({ aiKeyConfigured: false });
      }
    })();
    setKeyDraft("");
    return () => {
      cancelled = true;
    };
  }, [provider, setAi]);

  const saveKey = async () => {
    if (!keyDraft) return;
    setSavingKey(true);
    try {
      await api.secretSet(`ai:${provider}`, keyDraft);
      setAi({ aiKeyConfigured: true });
      setKeyDraft("");
      setTestResult("✓ 已存入系统钥匙串");
    } catch (e) {
      setTestResult(`✗ ${(e as Error).message}`);
    } finally {
      setSavingKey(false);
    }
  };

  const clearKey = async () => {
    const ok = await confirmDialog({
      title: "清除 API Key？",
      message: `清除 ${provider} 的 API Key？`,
      confirmLabel: "清除",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.secretDelete(`ai:${provider}`);
      setAi({ aiKeyConfigured: false });
      setKeyDraft("");
      setTestResult("已清除");
    } catch (e) {
      setTestResult(`✗ ${(e as Error).message}`);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api.aiChat({
        provider,
        endpoint: endpoint || undefined,
        model,
        maxTokens: 32,
        temperature: 0,
        messages: [{ role: "user", content: "ping" }],
      });
      setTestResult(`✓ ${r.text.slice(0, 80) || "已连接"}`);
    } catch (e) {
      setTestResult(`✗ ${(e as Error).message}`);
    } finally {
      setTesting(false);
    }
  };

  const useCurrentFile = useSettings((s) => s.aiUseCurrentFile);
  const useWorkspace = useSettings((s) => s.aiUseWorkspace);

  return (
    <>
      <SectionHeader id="ai" />

      <div className="settings-card">
        <CardTitle tip="这些开关会决定发送给 AI 的上下文范围。">
          回答时的上下文
        </CardTitle>
        <div className="settings-row">
          <div className="settings-row-l">
            <LabelWithTip tip="系统 prompt 会包含当前打开 Markdown 的前 6000 字。">
              把当前笔记发给 AI
            </LabelWithTip>
          </div>
          <Toggle
            on={useCurrentFile}
            onChange={(v) => setAi({ aiUseCurrentFile: v })}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <LabelWithTip tip="提问时先在仓库中查找关键词，并把命中片段发给当前 AI 提供方。">
              用仓库做关键词检索
            </LabelWithTip>
          </div>
          <Toggle
            on={useWorkspace}
            onChange={(v) => setAi({ aiUseWorkspace: v })}
          />
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card-h">API 提供方</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">当前提供方</div>
            <div className="settings-help">
              切换后会自动恢复该提供方上次的 endpoint / 模型（API Key 始终独立保存）
            </div>
          </div>
          <SelectBtn
            value={provider}
            options={AI_PROVIDERS.map((p) => {
              const saved = providerConfigs[p.id]?.model || providerConfigs[p.id]?.endpoint;
              return {
                value: p.id,
                label: `${p.name} · ${p.sub}${saved && provider !== p.id ? " · 已记住" : ""}`,
              };
            })}
            onChange={(v) => switchProvider(v)}
            minMenuWidth={320}
          />
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card-h">
          {def?.name ?? provider} 配置
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label settings-label-with-tip">
              <span>
                API Key
                {keyConfigured && (
                  <span
                    style={{
                      marginLeft: 8,
                      padding: "1px 6px",
                      fontSize: 10,
                      fontWeight: 600,
                      background: "var(--accent-glow)",
                      color: "var(--accent)",
                      borderRadius: 4,
                    }}
                  >
                    已配置
                  </span>
                )}
              </span>
              <HelpTip text="非 Ollama 提供方的 Key 存入系统钥匙串；前端不会持久化明文。" />
            </div>
            <div className="settings-help">
              {def?.keyOptional
                ? "本地服务可留空"
                : keyConfigured
                ? "已存储"
                : "未配置"}
            </div>
          </div>
          <input
            type="password"
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            onBlur={() => {
              if (keyDraft) saveKey();
            }}
            placeholder={
              keyConfigured ? "已保存 · 输入新值替换" : def?.keyPlaceholder ?? "API Key"
            }
            style={{
              padding: "5px 10px",
              background: "var(--bg-input)",
              border: "0.5px solid var(--border-strong)",
              borderRadius: 6,
              width: 220,
              fontSize: 12,
              color: "var(--text)",
              fontFamily: "var(--font-mono)",
            }}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <LabelWithTip tip="留空会使用当前提供方的默认地址。">
              Endpoint
            </LabelWithTip>
          </div>
          <input
            type="text"
            value={endpoint}
            onChange={(e) => {
              const v = e.target.value;
              setAi({ aiEndpoint: v });
              persistProviderField({ endpoint: v });
            }}
            placeholder={def?.defaultEndpoint || "https://..."}
            style={{
              padding: "5px 10px",
              background: "var(--bg-input)",
              border: "0.5px solid var(--border-strong)",
              borderRadius: 6,
              width: 260,
              fontSize: 12,
              color: "var(--text)",
              fontFamily: "var(--font-mono)",
            }}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">默认模型</div>
          </div>
          {def ? (
            <AIModelPicker
              provider={def}
              endpoint={endpoint}
              value={model}
              onChange={(v) => {
                setAi({ aiModel: v });
                persistProviderField({ model: v });
              }}
            />
          ) : (
            <input
              type="text"
              value={model}
              onChange={(e) => {
                const v = e.target.value;
                setAi({ aiModel: v });
                persistProviderField({ model: v });
              }}
              placeholder="model id"
              style={{
                padding: "5px 10px",
                background: "var(--bg-input)",
                border: "0.5px solid var(--border-strong)",
                borderRadius: 6,
                width: 220,
                fontSize: 12,
                color: "var(--text)",
                fontFamily: "var(--font-mono)",
              }}
            />
          )}
        </div>
        <div
          className="settings-row"
          style={{ background: "var(--bg-pane-2)" }}
        >
          <div className="settings-row-l">
            <div className="settings-label" style={{ color: "var(--accent)" }}>
              测试连接
            </div>
            <div className="settings-help">
              {testResult ?? "发送一次 ping 请求验证 Key 与 Endpoint"}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {keyConfigured && (
              <button
                className="settings-btn"
                onClick={clearKey}
                disabled={savingKey || testing}
              >
                清除 Key
              </button>
            )}
            <button
              className="settings-btn primary"
              onClick={test}
              disabled={testing || savingKey}
            >
              {testing ? "测试中…" : "测试"}
            </button>
          </div>
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card-h">高级参数</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">温度 (Temperature)</div>
            <div className="settings-help">
              {temperature.toFixed(2)} · 越高越发散
            </div>
          </div>
          <Slider
            value={Math.round(temperature * 100)}
            min={0}
            max={150}
            onChange={(v) => setAi({ aiTemperature: v / 100 })}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">最大输出 tokens</div>
          </div>
          <input
            type="number"
            min={256}
            max={32000}
            value={maxTokens}
            onChange={(e) =>
              setAi({ aiMaxTokens: Math.max(256, Math.min(32000, Number(e.target.value) || 4096)) })
            }
            style={{
              padding: "5px 10px",
              background: "var(--bg-input)",
              border: "0.5px solid var(--border-strong)",
              borderRadius: 6,
              width: 120,
              fontSize: 12,
              color: "var(--text)",
              fontFamily: "var(--font-mono)",
            }}
          />
        </div>
      </div>
      <AICacheCard />
    </>
  );
}

function AICacheCard() {
  const enabled = useSettings((s) => s.aiCacheEnabled);
  const setPreference = useSettings((s) => s.setPreference);
  const [cleared, setCleared] = useState(false);
  return (
    <div className="settings-card">
      <div className="settings-card-h">响应缓存</div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">启用缓存（仅本次会话）</div>
          <div className="settings-help">
            完全相同的 prompt + 模型 + RAG 上下文不重发请求，秒回上次结果。改一字即重发。
            重启清空。默认关，避免破坏"重新生成"语义。
          </div>
        </div>
        <Toggle on={enabled} onChange={(v) => setPreference("aiCacheEnabled", v)} />
      </div>
      <div className="settings-row" style={{ justifyContent: "flex-end", gap: 8 }}>
        <span className="settings-help">
          {cleared ? "已清空" : `当前缓存：${aiCache.size()} 条`}
        </span>
        <button
          className="settings-btn"
          onClick={() => {
            aiCache.clear();
            setCleared(true);
            window.setTimeout(() => setCleared(false), 1500);
          }}
        >
          清空缓存
        </button>
      </div>
    </div>
  );
}

// 1x1 透明 PNG，用于 S3 连接测试
const S3_PROBE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function S3Card() {
  const { t } = useTranslation();
  const endpoint = useSettings((s) => s.s3Endpoint);
  const region = useSettings((s) => s.s3Region);
  const bucket = useSettings((s) => s.s3Bucket);
  const accessKeyId = useSettings((s) => s.s3AccessKeyId);
  const publicBaseUrl = useSettings((s) => s.s3PublicBaseUrl);
  const pathStyle = useSettings((s) => s.s3PathStyle);
  const setPreference = useSettings((s) => s.setPreference);
  const [secret, setSecret] = useState("");
  const [stored, setStored] = useState(false);
  const [testing, setTesting] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const testConnection = async () => {
    if (!endpoint || !bucket || !accessKeyId) {
      setMsg({ kind: "err", text: "请先填写 endpoint / bucket / access key" });
      return;
    }
    setTesting(true);
    setMsg(null);
    try {
      const key = `markio/_probe/${Date.now()}.png`;
      const url = await api.s3PutObject(
        {
          endpoint,
          region,
          bucket,
          accessKeyId,
          secretAccessKey: "", // 走 keychain
          publicBaseUrl: publicBaseUrl || undefined,
          pathStyle,
        },
        key,
        S3_PROBE_PNG_BASE64,
        "image/png",
      );
      setMsg({ kind: "ok", text: `✓ 连接成功：${url}` });
    } catch (e) {
      setMsg({ kind: "err", text: `✗ ${String(e)}` });
    } finally {
      setTesting(false);
    }
  };

  useEffect(() => {
    if (!endpoint) {
      setStored(false);
      return;
    }
    api.s3HasSecret(endpoint).then(setStored).catch(() => setStored(false));
  }, [endpoint]);

  const save = async () => {
    if (!endpoint) {
      setMsg({ kind: "err", text: "请先填写 endpoint" });
      return;
    }
    try {
      await api.s3SetSecret(endpoint, secret);
      setMsg({ kind: "ok", text: "Secret 已保存到钥匙串" });
      setSecret("");
      setStored(!!secret);
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
    }
  };

  return (
    <div className="settings-card">
      <CardTitle tip={t("settings.picgo.s3Tip")}>
        {t("settings.picgo.s3Card")}
      </CardTitle>
      <div className="settings-row">
        <div className="settings-row-l">
          <LabelWithTip tip={t("settings.picgo.s3EndpointTip")}>Endpoint</LabelWithTip>
        </div>
        <input
          type="text"
          value={endpoint}
          onChange={(e) => setPreference("s3Endpoint", e.target.value)}
          placeholder="https://..."
          style={{ flex: 1, minWidth: 280 }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">Region</div>
        </div>
        <input
          type="text"
          value={region}
          onChange={(e) => setPreference("s3Region", e.target.value)}
          placeholder="us-east-1"
          style={{ flex: 1, minWidth: 180 }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">Bucket</div>
        </div>
        <input
          type="text"
          value={bucket}
          onChange={(e) => setPreference("s3Bucket", e.target.value)}
          placeholder="markio-images"
          style={{ flex: 1, minWidth: 180 }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">Access Key ID</div>
        </div>
        <input
          type="text"
          value={accessKeyId}
          onChange={(e) => setPreference("s3AccessKeyId", e.target.value)}
          style={{ flex: 1, minWidth: 220 }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <LabelWithTip tip={t("settings.picgo.s3SecretTip")}>
            {t("settings.picgo.s3Secret")}
          </LabelWithTip>
          <div className="settings-help">
            {stored
              ? t("settings.picgo.s3SecretStored")
              : t("settings.picgo.s3SecretMissing")}
          </div>
        </div>
        <input
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          style={{ flex: 1, minWidth: 220 }}
        />
        <button className="settings-btn" onClick={save} disabled={!endpoint}>
          {t("common.save")}
        </button>
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <LabelWithTip tip={t("settings.picgo.s3PublicBaseTip")}>
            {t("settings.picgo.s3PublicBase")}
          </LabelWithTip>
        </div>
        <input
          type="text"
          value={publicBaseUrl}
          onChange={(e) => setPreference("s3PublicBaseUrl", e.target.value)}
          placeholder="https://cdn.example.com/markio"
          style={{ flex: 1, minWidth: 280 }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <LabelWithTip tip={t("settings.picgo.s3PathStyleTip")}>
            {t("settings.picgo.s3PathStyle")}
          </LabelWithTip>
        </div>
        <Toggle
          on={pathStyle}
          onChange={(v) => setPreference("s3PathStyle", v)}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <LabelWithTip tip={t("settings.picgo.s3ProbeTip")}>
            {t("settings.picgo.s3Probe")}
          </LabelWithTip>
        </div>
        <button
          className="settings-btn"
          onClick={testConnection}
          disabled={testing || !endpoint || !bucket || !accessKeyId}
        >
          {testing ? t("settings.picgo.s3Testing") : t("settings.picgo.s3TestBtn")}
        </button>
      </div>
      {msg && (
        <div
          className="settings-message"
          style={{
            color: msg.kind === "err" ? "#dc2626" : "var(--accent)",
          }}
        >
          {msg.text}
        </div>
      )}
    </div>
  );
}

function WebDavCard() {
  const baseUrl = useSettings((s) => s.webdavBaseUrl);
  const username = useSettings((s) => s.webdavUsername);
  const remoteDir = useSettings((s) => s.webdavRemoteDir);
  const setPreference = useSettings((s) => s.setPreference);
  const [password, setPassword] = useState("");
  const [stored, setStored] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [connStatus, setConnStatus] = useState<"unknown" | "ok" | "fail">("unknown");
  // baseUrl 改变后旧的测试结果失效
  useEffect(() => {
    setConnStatus("unknown");
  }, [baseUrl]);

  useEffect(() => {
    if (!baseUrl) {
      setStored(false);
      return;
    }
    api.webdavHasPassword(baseUrl).then(setStored).catch(() => setStored(false));
  }, [baseUrl]);

  const auth = () => ({ username, password });

  const wrap = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setMsg(null);
    try {
      await fn();
      setMsg({ kind: "ok", text: `${label} 完成` });
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const savePassword = async () => {
    if (!baseUrl) {
      setMsg({ kind: "err", text: "请先填写 WebDAV URL" });
      return;
    }
    await wrap("密码保存", async () => {
      await api.webdavSetPassword(baseUrl, password);
      setPassword("");
      setStored(!!password);
    });
  };

  // 统一状态行：off=没填 URL，unknown=没测过，ok=测过且通，fail=测过但失败
  const wdDot: "ok" | "warn" | "off" =
    !baseUrl ? "off" : connStatus === "ok" ? "ok" : connStatus === "fail" ? "warn" : "off";
  const wdSummary = !baseUrl
    ? "未配置 · 在下方填服务地址"
    : connStatus === "ok"
      ? `已连通 · ${baseUrl}`
      : connStatus === "fail"
        ? `连接失败 · ${baseUrl}`
        : `${baseUrl} · 尚未测试`;

  const testConnection = async () => {
    if (!baseUrl) return;
    setBusy("conn");
    setMsg(null);
    try {
      await api.webdavTest(baseUrl, auth());
      setConnStatus("ok");
      setMsg({ kind: "ok", text: "连接成功" });
    } catch (e) {
      setConnStatus("fail");
      setMsg({ kind: "err", text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="settings-card">
      <CardTitle tip="支持坚果云、TeraCloud、Nextcloud 和自建 WebDAV；密码只保存到系统钥匙串。">
        WebDAV
      </CardTitle>

      <div className="sync-card-status">
        <span className={`upload-dot upload-dot-${wdDot}`} aria-hidden />
        <div className="summary">{wdSummary}</div>
        <button
          className="settings-btn"
          type="button"
          onClick={testConnection}
          disabled={!baseUrl || busy !== null}
        >
          {busy === "conn" ? "测试中…" : "测试连接"}
        </button>
      </div>

      <div className="settings-row">
        <div className="settings-row-l">
          <LabelWithTip tip="例如 https://dav.jianguoyun.com/dav/">
            服务地址
          </LabelWithTip>
        </div>
        <input
          type="text"
          value={baseUrl}
          onChange={(e) => setPreference("webdavBaseUrl", e.target.value)}
          placeholder="https://..."
          style={{ flex: 1, minWidth: 280 }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">用户名</div>
        </div>
        <input
          type="text"
          value={username}
          onChange={(e) => setPreference("webdavUsername", e.target.value)}
          style={{ flex: 1, minWidth: 220 }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <LabelWithTip tip="只保存到系统钥匙串，不写入前端持久化设置。">
            应用专用密码
          </LabelWithTip>
          <div className="settings-help">
            {stored ? "已存储" : "未存储"}
          </div>
        </div>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="password / app password"
          style={{ flex: 1, minWidth: 220 }}
        />
        <button
          className="settings-btn"
          disabled={!baseUrl || busy === "密码保存"}
          onClick={savePassword}
        >
          保存
        </button>
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <LabelWithTip tip="同步到这个相对路径下；初始化目录会自动创建路径。">
            远端根目录
          </LabelWithTip>
        </div>
        <input
          type="text"
          value={remoteDir}
          onChange={(e) => setPreference("webdavRemoteDir", e.target.value)}
          placeholder="markio"
          style={{ flex: 1, minWidth: 220 }}
        />
      </div>
      {/* 测试连接已经移到上方 .sync-card-status，这里只留初始化 / 列出 */}
      <div className="settings-action-row">
        <button
          className="settings-btn"
          disabled={!baseUrl || busy !== null}
          onClick={() =>
            wrap("远端目录初始化", () =>
              api.webdavMkcol(baseUrl, auth(), remoteDir || "/"),
            )
          }
        >
          初始化目录
        </button>
        <button
          className="settings-btn"
          disabled={!baseUrl || busy !== null}
          onClick={async () => {
            setBusy("list");
            setMsg(null);
            try {
              const items = await api.webdavList(
                baseUrl,
                auth(),
                remoteDir || "/",
              );
              setMsg({
                kind: "ok",
                text: `远端共 ${items.length} 项（${items.filter((i) => i.isDir).length} 目录 / ${items.filter((i) => !i.isDir).length} 文件）`,
              });
            } catch (e) {
              setMsg({ kind: "err", text: String(e) });
            } finally {
              setBusy(null);
            }
          }}
        >
          列举远端
        </button>
      </div>
      {msg && (
        <div
          className="settings-message"
          style={{
            color: msg.kind === "err" ? "#dc2626" : "var(--accent)",
          }}
        >
          {msg.text}
        </div>
      )}
    </div>
  );
}

function RepoGraphCard() {
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace());
  const [graph, setGraph] = useState<{
    nodes: Array<{ id: number; path: string; inDegree: number; outDegree: number }>;
    edges: Array<{ from: number; to: number }>;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    if (!activeWorkspace) return;
    setBusy(true);
    setError(null);
    try {
      const g = await api.ragRepoGraph(activeWorkspace.path);
      setGraph(g);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const hubs = useMemoSort(graph?.nodes ?? [], (a, b) => b.inDegree - a.inDegree)
    .slice(0, 10);
  const orphans = (graph?.nodes ?? []).filter(
    (n) => n.inDegree === 0 && n.outDegree === 0,
  );

  return (
    <div className="settings-card">
      <CardTitle tip="基于 [[wiki]] 和 Markdown 链接统计中心笔记与孤立笔记。">
        链接图谱
      </CardTitle>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">
            {graph
              ? `共 ${graph.nodes.length} 笔记 · ${graph.edges.length} 条链接`
              : "未加载"}
          </div>
        </div>
        <button
          className="settings-btn"
          disabled={busy || !activeWorkspace}
          onClick={refresh}
        >
          {busy ? "加载中…" : "重新计算"}
        </button>
      </div>
      {error && (
        <div style={{ color: "#dc2626", fontSize: 12, padding: "4px 16px" }}>
          {error}
        </div>
      )}
      {graph && graph.nodes.length > 0 && (
        <RagGraphMini nodes={graph.nodes} edges={graph.edges} />
      )}
      {graph && hubs.length > 0 && (
        <div style={{ padding: "0 16px 8px" }}>
          <div
            style={{ fontSize: 12, color: "var(--text-3)", margin: "8px 0 4px" }}
          >
            高被引（top {hubs.length}）
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
            {hubs.map((h) => (
              <li key={h.id}>
                <span style={{ color: "var(--accent)" }}>{h.inDegree}↓</span>{" "}
                {h.path}
              </li>
            ))}
          </ul>
        </div>
      )}
      {graph && orphans.length > 0 && (
        <div style={{ padding: "0 16px 12px" }}>
          <div
            style={{ fontSize: 12, color: "var(--text-3)", margin: "8px 0 4px" }}
          >
            孤立笔记（无 in/out 链接）· {orphans.length} 条
          </div>
          <ul
            style={{
              margin: 0,
              paddingLeft: 18,
              fontSize: 12,
              maxHeight: 120,
              overflow: "auto",
            }}
          >
            {orphans.slice(0, 30).map((n) => (
              <li key={n.id}>{n.path}</li>
            ))}
            {orphans.length > 30 && <li>… 还有 {orphans.length - 30} 条</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

function useMemoSort<T>(items: readonly T[], cmp: (a: T, b: T) => number): T[] {
  return useMemo(() => [...items].sort(cmp), [items, cmp]);
}

function RerankCard() {
  const enabled = useSettings((s) => s.rerankEnabled);
  const model = useSettings((s) => s.rerankModel);
  const baseUrl = useSettings((s) => s.rerankBaseUrl);
  const setPreference = useSettings((s) => s.setPreference);
  const [keyDraft, setKeyDraft] = useState("");
  const [keyConfigured, setKeyConfigured] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const confirmDialog = useDialog((s) => s.confirm);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const has = await api.secretHas("rerank:cohere");
        if (!cancelled) setKeyConfigured(has);
      } catch {
        if (!cancelled) setKeyConfigured(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const saveKey = async () => {
    const value = keyDraft.trim();
    if (!value) return;
    setSavingKey(true);
    try {
      await api.secretSet("rerank:cohere", value);
      setKeyConfigured(true);
      setKeyDraft("");
      setMsg("✓ Reranker API Key 已存入系统钥匙串");
    } catch (e) {
      setMsg(`✗ ${(e as Error).message}`);
    } finally {
      setSavingKey(false);
    }
  };

  const clearKey = async () => {
    const ok = await confirmDialog({
      title: "清除 Reranker API Key？",
      confirmLabel: "清除",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.secretDelete("rerank:cohere");
      setKeyConfigured(false);
      setKeyDraft("");
      setMsg("已清除");
    } catch (e) {
      setMsg(`✗ ${(e as Error).message}`);
    }
  };

  return (
    <div className="settings-card">
      <CardTitle tip="在 RRF 融合之后再精排；支持 Cohere API 和兼容 /v1/rerank 的本地服务。">
        Reranker（cohere 兼容协议）
      </CardTitle>
      <div className="settings-row">
        <div className="settings-row-l">
          <LabelWithTip tip="启用后会在检索候选里再次精排。">
            启用 Reranker
          </LabelWithTip>
          <div className="settings-help">{enabled ? "已启用" : "未启用"}</div>
        </div>
        <Toggle
          on={enabled}
          onChange={(v) => setPreference("rerankEnabled", v)}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <LabelWithTip tip="Cohere 默认 rerank-multilingual-v3.0。">
            模型
          </LabelWithTip>
        </div>
        <input
          type="text"
          value={model}
          onChange={(e) => setPreference("rerankModel", e.target.value)}
          style={{ flex: 1, minWidth: 220 }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <LabelWithTip tip="留空使用 https://api.cohere.com；自部署填写 http://host:port。">
            服务地址
          </LabelWithTip>
        </div>
        <input
          type="text"
          value={baseUrl}
          onChange={(e) => setPreference("rerankBaseUrl", e.target.value)}
          placeholder="https://api.cohere.com"
          style={{ flex: 1, minWidth: 280 }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <LabelWithTip tip="本地服务通常可留空。">
            API Key
          </LabelWithTip>
          <div className="settings-help">
            {keyConfigured ? "已存入系统钥匙串" : "未配置"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            type="password"
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            placeholder="cohere_xxx"
            style={inputStyle}
          />
          <button
            type="button"
            className="btn-primary"
            disabled={!keyDraft.trim() || savingKey}
            onClick={saveKey}
          >
            保存
          </button>
          {keyConfigured && (
            <button type="button" className="btn-ghost" onClick={clearKey}>
              清除
            </button>
          )}
        </div>
      </div>
      {msg && (
        <div
          className="settings-row"
          style={{
            color: msg.startsWith("✗") ? "var(--danger)" : "var(--text-3)",
          }}
        >
          {msg}
        </div>
      )}
    </div>
  );
}

/** 已知支持 OpenAI 兼容 /v1/embeddings 协议的提供方预设：选一个就自动填好
 *  base_url + 推荐模型 + 维度 + 应该到哪个 keychain 账户去取 key。 */
const EMBEDDING_PRESETS: ReadonlyArray<{
  /** 对应 AI 助手页 aiProvider 的 id；用于"复用 AI 助手 Key" */
  aiProviderId: string;
  label: string;
  baseUrl: string;
  model: string;
  dim: number;
}> = [
  {
    aiProviderId: "openai",
    label: "OpenAI · text-embedding-3-small (1536)",
    baseUrl: "https://api.openai.com",
    model: "text-embedding-3-small",
    dim: 1536,
  },
  {
    aiProviderId: "siliconflow",
    label: "SiliconFlow · BAAI/bge-m3 (1024)",
    baseUrl: "https://api.siliconflow.cn",
    model: "BAAI/bge-m3",
    dim: 1024,
  },
  {
    aiProviderId: "zhipu",
    label: "智谱 GLM · embedding-2 (1024)",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "embedding-2",
    dim: 1024,
  },
  {
    aiProviderId: "dashscope",
    label: "通义千问 · text-embedding-v3 (1024)",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "text-embedding-v3",
    dim: 1024,
  },
  {
    aiProviderId: "mistral",
    label: "Mistral · mistral-embed (1024)",
    baseUrl: "https://api.mistral.ai/v1",
    model: "mistral-embed",
    dim: 1024,
  },
  {
    aiProviderId: "together",
    label: "Together · BAAI/bge-base-en-v1.5 (768)",
    baseUrl: "https://api.together.xyz/v1",
    model: "BAAI/bge-base-en-v1.5",
    dim: 768,
  },
];

function RagSettings() {
  const provider = useSettings((s) => s.ragProvider);
  const enabled = useSettings((s) => s.ragEnabled);
  const autoOnSave = useSettings((s) => s.ragAutoReindexOnSave);
  const topK = useSettings((s) => s.ragTopK);
  const expandLinks = useSettings((s) => s.ragExpandLinks);
  const ollamaBaseUrl = useSettings((s) => s.ragOllamaBaseUrl);
  const ollamaModel = useSettings((s) => s.ragOllamaModel);
  const ollamaDim = useSettings((s) => s.ragOllamaDim);
  const openaiBaseUrl = useSettings((s) => s.ragOpenaiBaseUrl);
  const openaiModel = useSettings((s) => s.ragOpenaiModel);
  const openaiDim = useSettings((s) => s.ragOpenaiDim);
  const aiProvider = useSettings((s) => s.aiProvider);
  const setPreference = useSettings((s) => s.setPreference);

  const [openaiKeyDraft, setOpenaiKeyDraft] = useState("");
  const [openaiKeyConfigured, setOpenaiKeyConfigured] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const confirmDialog = useDialog((s) => s.confirm);

  /** 一键把某个预设的 base_url / model / dim 应用到 OpenAI 兼容设置，并把
   *  对应 AI 助手的 keychain key (ai:{provider}) 在 Rust 端复制到 embed:openai。
   *  Key 明文不经过前端。 */
  const applyPreset = async (preset: typeof EMBEDDING_PRESETS[number]) => {
    setPreference("ragProvider", "openai");
    setPreference("ragOpenaiBaseUrl", preset.baseUrl);
    setPreference("ragOpenaiModel", preset.model);
    setPreference("ragOpenaiDim", preset.dim);
    try {
      const copied = await api.secretCopy(`ai:${preset.aiProviderId}`, "embed:openai");
      if (copied) {
        setOpenaiKeyConfigured(true);
        setMsg(`✓ 已应用 ${preset.label}（已复用 ${preset.aiProviderId} 的 Key）`);
        return;
      }
    } catch {
      /* keychain 操作失败时静默 fall through */
    }
    setMsg(`✓ 已应用 ${preset.label} · 请在下方填入 API Key`);
  };

  // 当前活动 workspace
  const wsLoaded = useWorkspaceForRag();
  const ws = wsLoaded.ws;
  const status = wsLoaded.status;
  const refresh = wsLoaded.refresh;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const has = await api.secretHas("embed:openai");
        if (!cancelled) setOpenaiKeyConfigured(has);
      } catch {
        if (!cancelled) setOpenaiKeyConfigured(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [provider]);

  const saveOpenaiKey = async () => {
    if (!openaiKeyDraft) return;
    setSavingKey(true);
    try {
      await api.secretSet("embed:openai", openaiKeyDraft);
      setOpenaiKeyConfigured(true);
      setOpenaiKeyDraft("");
      setMsg("✓ OpenAI API Key 已存入系统钥匙串");
    } catch (e) {
      setMsg(`✗ ${(e as Error).message}`);
    } finally {
      setSavingKey(false);
    }
  };

  const clearOpenaiKey = async () => {
    const ok = await confirmDialog({
      title: "清除 OpenAI Embedding API Key？",
      confirmLabel: "清除",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.secretDelete("embed:openai");
      setOpenaiKeyConfigured(false);
      setMsg("已清除");
    } catch (e) {
      setMsg(`✗ ${(e as Error).message}`);
    }
  };

  const triggerReindex = async () => {
    if (!ws) {
      setMsg("请先打开一个仓库");
      return;
    }
    try {
      await useRag.getState().reindex(ws.path);
      setMsg("已触发重建，可继续使用 markio，索引在后台进行");
      refresh();
    } catch (e) {
      setMsg(`✗ ${(e as Error).message}`);
    }
  };

  const triggerClear = async () => {
    if (!ws) return;
    const ok = await confirmDialog({
      title: "清空索引库？",
      message: "已索引的向量会全部丢失，下次需要重建。",
      confirmLabel: "清空",
      danger: true,
    });
    if (!ok) return;
    try {
      await useRag.getState().clear(ws.id, ws.path);
      setMsg("索引已清空");
      refresh();
    } catch (e) {
      setMsg(`✗ ${(e as Error).message}`);
    }
  };

  const triggerCancel = async () => {
    if (!ws) return;
    try {
      const ok = await useRag.getState().cancel(ws.path);
      setMsg(ok ? "正在取消重建，当前文件处理完成后会停止" : "当前没有运行中的重建任务");
      refresh();
    } catch (e) {
      setMsg(`✗ ${(e as Error).message}`);
    }
  };

  const progress = status?.progress;
  const progressPct = progress?.total
    ? Math.round((progress.processed / Math.max(1, progress.total)) * 100)
    : 0;
  const dbSizeKb = status ? Math.max(1, Math.round(status.dbSize / 1024)) : 0;

  return (
    <>
      <SectionHeader id="rag" />

      <div className="settings-card">
        <CardTitle tip="索引存放在当前仓库的 .markio/rag.db；查询在本地完成。">
          总开关
        </CardTitle>
        <div className="settings-row">
          <div className="settings-row-l">
            <LabelWithTip tip="关闭后 AI 检索会退回关键词 grep。">
              启用本地知识库
            </LabelWithTip>
          </div>
          <Toggle on={enabled} onChange={(v) => setPreference("ragEnabled", v)} />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <LabelWithTip tip="首次需要手动构建索引；之后保存当前笔记时只更新这个文件的 chunk。">
              索引后自动增量
            </LabelWithTip>
          </div>
          <Toggle
            on={autoOnSave}
            onChange={(v) => setPreference("ragAutoReindexOnSave", v)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <LabelWithTip tip="命中笔记后沿 [[wiki]] 和 Markdown 链接带回相关 chunk。">
              引用图谱扩展
            </LabelWithTip>
          </div>
          <Toggle
            on={expandLinks}
            onChange={(v) => setPreference("ragExpandLinks", v)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">检索返回条数</div>
            <div className="settings-help">{topK} 条</div>
          </div>
          <Slider
            value={topK}
            min={3}
            max={20}
            onChange={(v) => setPreference("ragTopK", v)}
          />
        </div>
      </div>

      <RerankCard />

      <RepoGraphCard />

      <div className="settings-card">
        <div className="settings-card-h">Embedding 提供方</div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 8,
            padding: "10px 16px",
          }}
        >
          {[
            {
              id: "ollama" as const,
              n: "本地 Ollama",
              sub: "免费、离线、推荐",
            },
            {
              id: "openai" as const,
              n: "OpenAI 兼容",
              sub: "需 API Key，联网调用",
            },
          ].map((p) => (
            <button
              type="button"
              key={p.id}
              onClick={() => setPreference("ragProvider", p.id)}
              style={{
                position: "relative",
                padding: "9px 12px",
                background:
                  provider === p.id ? "var(--accent-glow)" : "var(--bg-pane-2)",
                border:
                  "1px solid " +
                  (provider === p.id ? "var(--accent)" : "var(--border)"),
                borderRadius: 9,
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              <div
                style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}
              >
                {p.n}
              </div>
              <div
                style={{ fontSize: 11, color: "var(--text-3)", marginTop: 1 }}
              >
                {p.sub}
              </div>
              {provider === p.id && (
                <span
                  style={{
                    position: "absolute",
                    top: 6,
                    right: 8,
                    color: "var(--accent)",
                    fontWeight: 700,
                  }}
                >
                  ✓
                </span>
              )}
            </button>
          ))}
        </div>

        {provider === "ollama" ? (
          <>
            <div className="settings-row">
              <div className="settings-row-l">
                <LabelWithTip tip="需要先运行 ollama serve。">
                  Ollama 端点
                </LabelWithTip>
              </div>
              <TextInput
                value={ollamaBaseUrl}
                placeholder="http://127.0.0.1:11434"
                onChange={(v) => setPreference("ragOllamaBaseUrl", v)}
              />
            </div>
            <div className="settings-row">
              <div className="settings-row-l">
                <LabelWithTip tip="推荐 nomic-embed-text（768 维），需先通过 Ollama 拉取。">
                  Embedding 模型
                </LabelWithTip>
              </div>
              <TextInput
                value={ollamaModel}
                placeholder="nomic-embed-text"
                onChange={(v) => setPreference("ragOllamaModel", v)}
              />
            </div>
            <div className="settings-row">
              <div className="settings-row-l">
                <LabelWithTip tip="需要与模型实际维度一致；修改后会触发整库重建。">
                  向量维度
                </LabelWithTip>
              </div>
              <NumberInput
                value={ollamaDim}
                onChange={(v) => setPreference("ragOllamaDim", v)}
              />
            </div>
          </>
        ) : (
          <>
            <div className="settings-row">
              <div className="settings-row-l">
                <LabelWithTip tip="选一个已知支持 embedding 的提供方，自动填好 Base URL / 模型 / 维度，并尝试复用 AI 助手已存的 Key。Anthropic / Google Gemini / 本地 Ollama 不在这个列表（前者无 embedding API、Gemini 协议不同、Ollama 用本地选项）。">
                  快速预设
                </LabelWithTip>
                <div className="settings-help">
                  当前 AI 助手是「{aiProvider}」
                  {EMBEDDING_PRESETS.find((p) => p.aiProviderId === aiProvider)
                    ? "，可直接一键应用"
                    : "，不在预设列表（需手填）"}
                </div>
              </div>
              <SelectBtn
                value=""
                options={[
                  { value: "", label: "选一个预设…" },
                  ...EMBEDDING_PRESETS.map((p) => ({
                    value: p.aiProviderId,
                    label: p.label,
                  })),
                ]}
                onChange={(v) => {
                  const preset = EMBEDDING_PRESETS.find((p) => p.aiProviderId === v);
                  if (preset) void applyPreset(preset);
                }}
                minMenuWidth={320}
              />
            </div>
            <div className="settings-row">
              <div className="settings-row-l">
                <LabelWithTip tip="填写兼容 OpenAI Embedding 协议的服务地址。">
                  Base URL
                </LabelWithTip>
              </div>
              <TextInput
                value={openaiBaseUrl}
                placeholder="https://api.openai.com"
                onChange={(v) => setPreference("ragOpenaiBaseUrl", v)}
              />
            </div>
            <div className="settings-row">
              <div className="settings-row-l">
                <LabelWithTip tip="默认 text-embedding-3-small（1536 维）。">
                  Embedding 模型
                </LabelWithTip>
              </div>
              <TextInput
                value={openaiModel}
                placeholder="text-embedding-3-small"
                onChange={(v) => setPreference("ragOpenaiModel", v)}
              />
            </div>
            <div className="settings-row">
              <div className="settings-row-l">
                <LabelWithTip tip="修改维度后会触发整库重建。">
                  向量维度
                </LabelWithTip>
              </div>
              <NumberInput
                value={openaiDim}
                onChange={(v) => setPreference("ragOpenaiDim", v)}
              />
            </div>
            <div className="settings-row">
              <div className="settings-row-l">
                <LabelWithTip tip="OpenAI Embedding 的 Key 存入系统钥匙串。">
                  API Key
                </LabelWithTip>
                <div className="settings-help">
                  {openaiKeyConfigured ? "已存储" : "未配置"}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  type="password"
                  value={openaiKeyDraft}
                  placeholder="sk-..."
                  onChange={(e) => setOpenaiKeyDraft(e.target.value)}
                  style={inputStyle}
                />
                <button
                  type="button"
                  className="btn-primary"
                  disabled={!openaiKeyDraft || savingKey}
                  onClick={saveOpenaiKey}
                >
                  保存
                </button>
                {openaiKeyConfigured && (
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={clearOpenaiKey}
                  >
                    清除
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      <div className="settings-card">
        <div className="settings-card-h">索引状态</div>
        {!ws ? (
          <div className="settings-row" style={{ color: "var(--text-3)" }}>
            未打开任何仓库
          </div>
        ) : (
          <>
            <div className="settings-row">
              <div className="settings-row-l">
                <div className="settings-label">已索引文档</div>
                <div className="settings-help">
                  {status?.totalDocs ?? 0} 份 · {status?.totalChunks ?? 0} 个 chunk
                </div>
              </div>
              <div style={{ fontSize: 11, color: "var(--text-3)" }}>
                {status?.indexedAt
                  ? new Date(status.indexedAt * 1000).toLocaleString()
                  : "未索引"}
              </div>
            </div>
            <div className="settings-row">
              <div className="settings-row-l">
                <div className="settings-label">数据库大小</div>
                <div className="settings-help">
                  {status?.embeddingProvider ?? "—"} ·{" "}
                  {status?.embeddingModel ?? "—"}（{status?.embeddingDim ?? "?"}{" "}
                  维）
                </div>
              </div>
              <div style={{ fontSize: 11, color: "var(--text-3)" }}>
                {dbSizeKb} KB
              </div>
            </div>
            {progress?.running && (
              <div className="settings-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
                <div style={{ fontSize: 11, color: "var(--text-3)" }}>
                  {progress.cancelRequested ? "正在取消索引" : "正在索引"}{" "}
                  {progress.currentFile
                    ? progress.currentFile.split("/").slice(-1)[0]
                    : ""}{" "}
                  · {progress.processed}/{progress.total}（{progressPct}%）
                </div>
                <div
                  style={{
                    height: 4,
                    background: "var(--bg-pane-2)",
                    borderRadius: 999,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${progressPct}%`,
                      height: "100%",
                      background: "var(--accent)",
                      transition: "width .25s",
                    }}
                  />
                </div>
                {progress.lastError && (
                  <div style={{ fontSize: 11, color: "var(--text-3)" }}>
                    {progress.lastError}
                  </div>
                )}
              </div>
            )}
            <div
              style={{
                display: "flex",
                gap: 8,
                padding: "10px 16px",
              }}
            >
              <button
                type="button"
                className="btn-primary"
                onClick={triggerReindex}
                disabled={progress?.running}
              >
                {status?.totalDocs ? "重新索引整个仓库" : "首次构建索引"}
              </button>
              {progress?.running && (
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={triggerCancel}
                  disabled={progress.cancelRequested}
                >
                  {progress.cancelRequested ? "取消中…" : "取消重建"}
                </button>
              )}
              <button type="button" className="btn-ghost" onClick={triggerClear}>
                清空索引
              </button>
            </div>
          </>
        )}
        {msg && (
          <div
            style={{
              padding: "8px 16px 12px",
              fontSize: 11,
              color: msg.startsWith("✗")
                ? "var(--danger)"
                : "var(--text-3)",
            }}
          >
            {msg}
          </div>
        )}
      </div>
    </>
  );
}

function TextInput({
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

function NumberInput({
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

function sameWorkspacePath(a: string, b: string): boolean {
  const norm = (v: string) => v.replace(/\\/g, "/").replace(/\/+$/, "");
  const aa = norm(a);
  const bb = norm(b);
  return /^[a-zA-Z]:\//.test(aa) ? aa.toLowerCase() === bb.toLowerCase() : aa === bb;
}

function useWorkspaceForRag() {
  const activeId = useWorkspaceStore((s) => s.activeId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const ws = useMemo(() => {
    const active = workspaces.find((w) => w.id === activeId);
    return active ? { id: active.id, path: active.path } : null;
  }, [activeId, workspaces]);
  const [status, setStatus] = useState<RagStatus | null>(null);
  const refresh = useCallback(async () => {
    if (!ws) {
      setStatus(null);
      return;
    }
    try {
      const r = await api.ragStatus(ws.path);
      setStatus(r);
    } catch (e) {
      console.warn("[rag.status] failed", e);
    }
  }, [ws]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    if (!ws) {
      setStatus(null);
      return;
    }
    void refresh();
    void (async () => {
      try {
        unlisten = await listen<RagStatus>("rag-status", (e) => {
          if (cancelled || !sameWorkspacePath(e.payload.workspace, ws.path)) return;
          setStatus(e.payload);
        });
      } catch (e) {
        console.warn("[rag.status.listen] failed", e);
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [refresh, ws]);

  return { ws, status, refresh };
}

const IMPORT_SOURCES = [
  {
    id: "notion",
    name: "Notion",
    logo: "/brand/import/notion.svg",
    color: "#111111",
    inputHint: "ZIP 归档",
    inputTitle: "选择 Notion 导出的 .zip",
  },
  {
    id: "bear",
    name: "Bear",
    logo: "/brand/import/bear.svg",
    color: "#111827",
    inputHint: "Bearbook / ZIP",
    inputTitle: "选择 .bearbook 或 Bear 导出的 .zip",
  },
  {
    id: "obsidian",
    name: "Obsidian",
    logo: "/brand/import/obsidian.svg",
    color: "#7c3aed",
    inputHint: "仓库目录",
    inputTitle: "选择 Obsidian vault 目录",
  },
  {
    id: "evernote",
    name: "印象笔记",
    logo: "/brand/import/evernote.svg",
    color: "#00a82d",
    inputHint: "ENEX 文件",
    inputTitle: "选择印象笔记导出的 .enex",
  },
  {
    id: "roam",
    name: "Roam",
    logo: "/brand/import/roamresearch.svg",
    color: "#475569",
    inputHint: "Markdown ZIP",
    inputTitle: "选择 Roam 的 Markdown .zip；JSON 会跳过并给出警告",
  },
  {
    id: "logseq",
    name: "Logseq",
    logo: "/brand/import/logseq.svg",
    color: "#2563eb",
    inputHint: "Graph 目录",
    inputTitle: "选择 Logseq graph 目录",
  },
];

type ImportProvider =
  | "notion"
  | "obsidian"
  | "bear"
  | "evernote"
  | "roam"
  | "logseq";

type ImportBusyProvider = ImportProvider | "apple-notes";

const IMPORT_PROVIDER_MAP: Record<string, ImportProvider | null> = {
  notion: "notion",
  obsidian: "obsidian",
  bear: "bear",
  evernote: "evernote",
  roam: "roam",
  logseq: "logseq",
};

function extsFor(p: ImportProvider): string[] {
  switch (p) {
    case "notion":
    case "roam":
      return ["zip"];
    case "bear":
      return ["bearbook", "zip"];
    case "evernote":
      return ["enex"];
    case "obsidian":
    case "logseq":
      return [];
  }
}

function providerNeedsDir(p: ImportProvider): boolean {
  return p === "obsidian" || p === "logseq";
}

function importProviderName(provider: ImportProvider): string {
  return (
    IMPORT_SOURCES.find((source) => IMPORT_PROVIDER_MAP[source.id] === provider)
      ?.name ?? provider
  );
}

function importWarningSuffix(warnings: string[]): string {
  if (warnings.length === 0) return "";
  const preview = warnings.slice(0, 3).join("；");
  const more =
    warnings.length > 3 ? `；另有 ${warnings.length - 3} 条未显示` : "";
  return `（警告：${preview}${more}）`;
}

function ImportExport() {
  const { t } = useTranslation();
  const pdfTheme = useSettings((s) => s.exportPdfTheme);
  const pdfMargin = useSettings((s) => s.exportPdfMargin);
  const inlineImages = useSettings((s) => s.htmlExportInlineImages);
  const setPreference = useSettings((s) => s.setPreference);
  const pdfThemeOptions = useMemo(
    () =>
      (["current", "light", "dark", "print"] as const).map((v) => ({
        value: v,
        label: t(`settings.export.pdfThemeOptions.${v}`),
      })),
    [t],
  );
  const pdfMarginOptions = useMemo(
    () =>
      (["standard", "narrow", "wide"] as const).map((v) => ({
        value: v,
        label: t(`settings.export.pdfMarginOptions.${v}`),
      })),
    [t],
  );
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace());
  const refreshTree = useWorkspaceStore((s) => s.refreshTree);
  const [importBusy, setImportBusy] = useState<ImportBusyProvider | null>(null);
  const [importMsg, setImportMsg] = useState<{
    kind: "ok" | "err" | "info";
    text: string;
  } | null>(null);

  const runImport = async (provider: ImportProvider, useDir: boolean) => {
    if (!activeWorkspace) {
      setImportMsg({ kind: "err", text: "请先打开一个仓库" });
      return;
    }
    const src = useDir
      ? await pickDirectory()
      : await pickFile([
          { name: provider === "evernote" ? "ENEX" : "Archive", extensions: useDir ? [] : extsFor(provider) },
        ]);
    if (!src) return;
    setImportBusy(provider);
    const name = importProviderName(provider);
    setImportMsg({ kind: "info", text: `${name} 导入中…` });
    try {
      const report = await api.importRun(provider, src, activeWorkspace.path);
      setImportMsg({
        kind: "ok",
        text: `${name} 导入完成：${report.files} 个文件 → ${
          report.dest
        }${importWarningSuffix(report.warnings)}`,
      });
      await refreshTree(activeWorkspace.id).catch(() => undefined);
    } catch (e) {
      setImportMsg({ kind: "err", text: `导入失败：${String(e)}` });
    } finally {
      setImportBusy(null);
    }
  };

  const runAppleNotesImport = async () => {
    if (!activeWorkspace) {
      setImportMsg({ kind: "err", text: "请先打开一个仓库" });
      return;
    }
    setImportBusy("apple-notes");
    setImportMsg({
      kind: "info",
      text: "正在通过 osascript 读取 Notes.app…（首次会弹系统授权对话框）",
    });
    try {
      const report = await api.importAppleNotes(activeWorkspace.path);
      setImportMsg({
        kind: "ok",
        text: `Apple Notes 导入完成：${report.files} 篇 → ${
          report.dest
        }${importWarningSuffix(report.warnings)}`,
      });
      await refreshTree(activeWorkspace.id).catch(() => undefined);
    } catch (e) {
      setImportMsg({ kind: "err", text: `导入失败：${String(e)}` });
    } finally {
      setImportBusy(null);
    }
  };

  return (
    <>
      <SectionHeader id="export" />
      <div className="settings-card">
        <div className="settings-card-h">{t("settings.export.card")}</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">{t("settings.export.pdfTheme")}</div>
          </div>
          <SelectBtn
            value={pdfTheme}
            options={pdfThemeOptions}
            onChange={(v) => setPreference("exportPdfTheme", v)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">{t("settings.export.pdfMargin")}</div>
          </div>
          <SelectBtn
            value={pdfMargin}
            options={pdfMarginOptions}
            onChange={(v) => setPreference("exportPdfMargin", v)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">{t("settings.export.htmlInline")}</div>
            <div className="settings-help">把远端图片下载并以 base64 嵌入 HTML，离线可看（单张 ≤10MB）</div>
          </div>
          <Toggle
            on={inlineImages}
            onChange={(v) => setPreference("htmlExportInlineImages", v)}
          />
        </div>
      </div>
      <div className="settings-card">
        <CardTitle tip="导入到当前仓库的 imports/provider-timestamp/；Notion/Roam/Bear 选 ZIP，印象笔记选 ENEX，Obsidian/Logseq 选目录。">
          从其它工具导入
        </CardTitle>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
            gap: 8,
            padding: "12px 16px",
          }}
        >
          {IMPORT_SOURCES.map((n) => {
            const provider = IMPORT_PROVIDER_MAP[n.id] ?? null;
            const disabled =
              provider === null || importBusy !== null || !activeWorkspace;
            return (
              <button
                type="button"
                key={n.id}
                disabled={disabled}
                onClick={() => {
                  if (!provider) return;
                  void runImport(provider, providerNeedsDir(provider));
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "9px 12px",
                  background: "var(--bg-pane-2)",
                  border: "0.5px solid var(--border)",
                  borderRadius: 8,
                  fontSize: 12,
                  color: disabled ? "var(--text-3)" : "var(--text)",
                  cursor: disabled ? "not-allowed" : "pointer",
                  opacity: disabled ? 0.55 : 1,
                  textAlign: "left",
                }}
                title={
                  provider === null
                    ? "未支持"
                    : !activeWorkspace
                      ? "请先打开仓库"
                      : importBusy === provider
                        ? "导入中…"
                        : n.inputTitle
                }
              >
                <BrandMark logo={n.logo} color={n.color} size={28} />
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontWeight: 600,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {n.name}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--text-3)", marginTop: 2 }}>
                    {importBusy === provider
                      ? "导入中…"
                      : !activeWorkspace
                        ? "先打开仓库"
                        : n.inputHint}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
        {typeof navigator !== "undefined" && navigator.platform.startsWith("Mac") && (
          <div style={{ padding: "0 16px 12px" }}>
            <button
              type="button"
              disabled={importBusy !== null || !activeWorkspace}
              onClick={() => void runAppleNotesImport()}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "9px 12px",
                background: "var(--bg-pane-2)",
                border: "0.5px solid var(--border)",
                borderRadius: 8,
                fontSize: 12,
                color:
                  importBusy !== null || !activeWorkspace
                    ? "var(--text-3)"
                    : "var(--text)",
                cursor:
                  importBusy !== null || !activeWorkspace ? "not-allowed" : "pointer",
                opacity: importBusy !== null || !activeWorkspace ? 0.55 : 1,
                width: "100%",
                textAlign: "left",
              }}
              title={
                !activeWorkspace
                  ? "请先打开仓库"
                  : "通过 osascript 调系统 Notes.app；首次需授权"
              }
            >
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 6,
                  background: "#fed7aa",
                  color: "#9a3412",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: 700,
                  fontSize: 14,
                }}
              >
                N
              </div>
              <div>
                Apple Notes（macOS）
                <div style={{ fontSize: 10, color: "var(--text-3)", marginTop: 2 }}>
                  {importBusy === "apple-notes"
                    ? "导入中…"
                    : "首次会弹系统授权对话框"}
                </div>
              </div>
            </button>
          </div>
        )}
        {importMsg && (
          <div
            style={{
              padding: "0 16px 12px",
              fontSize: 12,
              color:
                importMsg.kind === "err"
                  ? "#dc2626"
                  : importMsg.kind === "ok"
                    ? "var(--accent)"
                    : "var(--text-3)",
            }}
          >
            {importMsg.text}
          </div>
        )}
      </div>
    </>
  );
}

// ─── Web Clipper / RSS / 移动端 ──────────────────────────────────
// 三块新增分区：壳 + 真实开关。需要后端管道（扩展推送 / RSS 拉取 / mDNS+P2P 握手）
// 的能力暂未接，通过 inline banner 明确告知用户当前状态。

const CLIPPER_BROWSERS: ReadonlyArray<{
  id: string;
  label: string;
  sub: string;
  url: string;
}> = [
  {
    id: "chrome",
    label: "Chrome",
    sub: "Chrome Web Store",
    url: "https://chrome.google.com/webstore",
  },
  {
    id: "edge",
    label: "Edge",
    sub: "Edge Add-ons",
    url: "https://microsoftedge.microsoft.com/addons",
  },
  {
    id: "firefox",
    label: "Firefox",
    sub: "Mozilla Add-ons",
    url: "https://addons.mozilla.org",
  },
  {
    id: "safari",
    label: "Safari",
    sub: "App Store · Safari Extensions",
    url: "https://apps.apple.com",
  },
];

function WebClipper() {
  const htmlToMd = useSettings((s) => s.clipperHtmlToMd);
  const readability = useSettings((s) => s.clipperReadability);
  const aiSummary = useSettings((s) => s.clipperAiSummary);
  const pdfSnapshot = useSettings((s) => s.clipperPdfSnapshot);
  const setPreference = useSettings((s) => s.setPreference);

  return (
    <>
      <h2 className="settings-h">Web Clipper</h2>
      <p className="settings-sub">
        浏览器扩展把网页抓回 markio 时按下面的偏好处理。扩展端单独分发，桌面端这里只配置接收行为。
      </p>

      <div
        className="settings-help"
        style={{
          padding: "10px 12px",
          background: "var(--bg-pane)",
          border: "0.5px solid var(--border)",
          borderRadius: 8,
          marginBottom: 16,
        }}
      >
        扩展端 → 桌面端的推送通道未接，下方开关已存好；扩展上架后即生效。
      </div>

      <div className="settings-card">
        <div className="settings-card-h">扩展安装</div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, 1fr)",
            gap: 8,
            padding: "8px 0",
          }}
        >
          {CLIPPER_BROWSERS.map((b) => (
            <button
              key={b.id}
              type="button"
              className="about-foot-card"
              onClick={() => void openExternal(b.url)}
            >
              <div className="t">{b.label}</div>
              <div className="s">{b.sub}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card-h">收藏行为</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">HTML → Markdown</div>
            <div className="settings-help">用 turndown 类规则把网页转为 .md，再落到收件箱目录</div>
          </div>
          <Toggle on={htmlToMd} onChange={(v) => setPreference("clipperHtmlToMd", v)} />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">Readability 抽取正文</div>
            <div className="settings-help">先用 readability 算法剥掉导航 / 广告 / 评论再保存</div>
          </div>
          <Toggle on={readability} onChange={(v) => setPreference("clipperReadability", v)} />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">AI 摘要</div>
            <div className="settings-help">保存时调用当前 AI 提供方生成一句话摘要，写进 frontmatter</div>
          </div>
          <Toggle on={aiSummary} onChange={(v) => setPreference("clipperAiSummary", v)} />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">附带 PDF 快照</div>
            <div className="settings-help">在 attachments/ 下额外保留原页 PDF，链接挂在文件 frontmatter</div>
          </div>
          <Toggle on={pdfSnapshot} onChange={(v) => setPreference("clipperPdfSnapshot", v)} />
        </div>
      </div>
    </>
  );
}

const RSS_INTERVAL_OPTIONS = [
  { value: "manual", label: "手动" },
  { value: "15m", label: "15 分钟" },
  { value: "1h", label: "1 小时" },
  { value: "4h", label: "4 小时" },
  { value: "1d", label: "1 天" },
] as const satisfies readonly SelectOption<
  "manual" | "15m" | "1h" | "4h" | "1d"
>[];

function RssFeeds() {
  const feeds = useSettings((s) => s.rssFeeds);
  const interval = useSettings((s) => s.rssFetchInterval);
  const aiSummary = useSettings((s) => s.rssAiSummary);
  const setPreference = useSettings((s) => s.setPreference);
  const promptDialog = useDialog((s) => s.prompt);
  const confirmDialog = useDialog((s) => s.confirm);
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  const [refreshingAll, setRefreshingAll] = useState(false);

  const addFeed = async () => {
    const url = await promptDialog({
      title: "添加 RSS 源",
      message: "输入 RSS / Atom 源的完整 URL（http(s)://...）",
      defaultValue: "https://",
      confirmLabel: "添加",
    });
    if (!url || !/^https?:\/\//i.test(url)) return;
    const title = await promptDialog({
      title: "源标题",
      message: "为这个源起一个显示名（便于辨认）",
      defaultValue: new URL(url).hostname,
      confirmLabel: "保存",
    });
    if (!title) return;
    const id = `feed_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    setPreference("rssFeeds", [
      ...feeds,
      { id, url, title, addedAt: Date.now() },
    ]);
  };

  const removeFeed = async (id: string, title: string) => {
    const ok = await confirmDialog({
      title: "删除订阅",
      message: `不再订阅 ${title}？已下载的条目不会被清理。`,
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    setPreference(
      "rssFeeds",
      feeds.filter((f) => f.id !== id),
    );
  };

  /** 拉取单个 feed：调 Rust GET，对比 seenGuids 算新出现条目数。 */
  const refreshFeed = async (id: string) => {
    const f = feeds.find((x) => x.id === id);
    if (!f) return;
    setBusyIds((s) => new Set(s).add(id));
    try {
      const r = await api.rssFetch(f.url);
      const seen = new Set(f.seenGuids ?? []);
      const fresh = r.items.filter((it) => !seen.has(it.guid)).length;
      const nextGuids = r.items
        .map((it) => it.guid)
        .filter(Boolean)
        .slice(0, 50);
      // 不要在闭包里用 feeds（已变陈旧），从 store 重新取
      const cur = useSettings.getState().rssFeeds;
      const updated = cur.map((x) =>
        x.id === id
          ? {
              ...x,
              lastFetchedAt: Date.now(),
              seenGuids: nextGuids,
              unread: (x.unread ?? 0) + fresh,
              lastError: undefined,
            }
          : x,
      );
      setPreference("rssFeeds", updated);
    } catch (e) {
      const cur = useSettings.getState().rssFeeds;
      setPreference(
        "rssFeeds",
        cur.map((x) =>
          x.id === id ? { ...x, lastError: (e as Error).message, lastFetchedAt: Date.now() } : x,
        ),
      );
    } finally {
      setBusyIds((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  };

  const refreshAll = async () => {
    setRefreshingAll(true);
    try {
      for (const f of feeds) {
        await refreshFeed(f.id);
      }
    } finally {
      setRefreshingAll(false);
    }
  };

  const markFeedRead = (id: string) => {
    const cur = useSettings.getState().rssFeeds;
    setPreference(
      "rssFeeds",
      cur.map((x) => (x.id === id ? { ...x, unread: 0 } : x)),
    );
  };

  return (
    <>
      <h2 className="settings-h">RSS 订阅</h2>
      <p className="settings-sub">
        在 markio 内汇总信息流。点「刷新」或「全部刷新」拉取最新条目；条目元数据在本地，正文留给浏览器。
      </p>

      <div className="settings-card">
        <div className="settings-card-h" style={{ display: "flex", alignItems: "center" }}>
          <span>订阅 ({feeds.length})</span>
          {feeds.length > 0 && (
            <button
              className="settings-btn"
              style={{ marginLeft: "auto", padding: "3px 9px", fontSize: 11 }}
              onClick={() => void refreshAll()}
              disabled={refreshingAll}
            >
              {refreshingAll ? "刷新中…" : "全部刷新"}
            </button>
          )}
        </div>
        {feeds.length === 0 ? (
          <div className="settings-row">
            <div className="settings-row-l">
              <div className="settings-label" style={{ color: "var(--text-3)" }}>
                还没有订阅源
              </div>
              <div className="settings-help">点右上「添加」开始</div>
            </div>
            <button className="settings-btn primary" onClick={() => void addFeed()}>
              添加订阅
            </button>
          </div>
        ) : (
          <>
            {feeds.map((f) => {
              const busy = busyIds.has(f.id);
              return (
                <div className="settings-row" key={f.id}>
                  <div className="settings-row-l">
                    <div className="settings-label">
                      {f.title}
                      {(f.unread ?? 0) > 0 && (
                        <span
                          style={{
                            marginLeft: 8,
                            fontSize: 10,
                            padding: "1px 6px",
                            background: "var(--accent-glow)",
                            color: "var(--accent)",
                            borderRadius: 999,
                            fontWeight: 600,
                          }}
                        >
                          {f.unread} 新
                        </span>
                      )}
                    </div>
                    <div
                      className="settings-help"
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        maxWidth: 380,
                      }}
                      title={f.url}
                    >
                      {f.lastError ? (
                        <span style={{ color: "#dc2626" }}>✗ {f.lastError}</span>
                      ) : f.lastFetchedAt ? (
                        <>
                          {new Date(f.lastFetchedAt).toLocaleString()} · {f.url}
                        </>
                      ) : (
                        f.url
                      )}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <button
                      className="settings-btn"
                      onClick={() => void refreshFeed(f.id)}
                      disabled={busy}
                      title="立即拉取"
                    >
                      {busy ? "…" : "刷新"}
                    </button>
                    <button
                      className="settings-btn"
                      onClick={() => {
                        markFeedRead(f.id);
                        void openExternal(f.url);
                      }}
                      title="在浏览器打开源 URL"
                    >
                      打开
                    </button>
                    <button
                      className="settings-btn"
                      onClick={() => void removeFeed(f.id, f.title)}
                    >
                      删除
                    </button>
                  </div>
                </div>
              );
            })}
            <div className="settings-row" style={{ justifyContent: "flex-end" }}>
              <button className="settings-btn primary" onClick={() => void addFeed()}>
                添加订阅
              </button>
            </div>
          </>
        )}
      </div>

      <div className="settings-card">
        <div className="settings-card-h">拉取与摘要</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">拉取频率</div>
            <div className="settings-help">fetcher 接好后按此频率后台拉取（手动 = 只在你点刷新时拉）</div>
          </div>
          <SelectBtn
            value={interval}
            options={RSS_INTERVAL_OPTIONS}
            onChange={(v) => setPreference("rssFetchInterval", v)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">AI 摘要</div>
            <div className="settings-help">每条新条目调用当前 AI 提供方生成 1 句话摘要</div>
          </div>
          <Toggle on={aiSummary} onChange={(v) => setPreference("rssAiSummary", v)} />
        </div>
      </div>
    </>
  );
}

const MOBILE_DEVICE_KINDS: Array<{
  value: "iphone" | "ipad" | "android" | "mac" | "windows" | "other";
  label: string;
}> = [
  { value: "iphone", label: "iPhone" },
  { value: "ipad", label: "iPad" },
  { value: "android", label: "Android" },
  { value: "mac", label: "Mac" },
  { value: "windows", label: "Windows" },
  { value: "other", label: "其它" },
];

function MobileDevices() {
  const p2p = useSettings((s) => s.mobileP2pEnabled);
  const devices = useSettings((s) => s.mobileDevices);
  const setPreference = useSettings((s) => s.setPreference);
  const promptDialog = useDialog((s) => s.prompt);
  const confirmDialog = useDialog((s) => s.confirm);

  const addDevice = async () => {
    const name = await promptDialog({
      title: "登记新设备",
      message: "起一个易识别的名字（如「我的 iPhone」「公司 Mac」）",
      defaultValue: "新设备",
      confirmLabel: "登记",
    });
    if (!name) return;
    const id = `dev_${Date.now().toString(36)}`;
    setPreference("mobileDevices", [
      ...devices,
      { id, name, kind: "iphone", pairedAt: Date.now() },
    ]);
  };

  const removeDevice = async (id: string, name: string) => {
    const ok = await confirmDialog({
      title: "解除配对",
      message: `${name} 将不再出现在已配对列表里。`,
      confirmLabel: "解除",
      danger: true,
    });
    if (!ok) return;
    setPreference(
      "mobileDevices",
      devices.filter((d) => d.id !== id),
    );
  };

  const setKind = (id: string, kind: typeof MOBILE_DEVICE_KINDS[number]["value"]) => {
    setPreference(
      "mobileDevices",
      devices.map((d) => (d.id === id ? { ...d, kind } : d)),
    );
  };

  return (
    <>
      <h2 className="settings-h">移动端 / 设备</h2>
      <p className="settings-sub">
        在 iPhone / iPad / 其它桌面之间共享当前仓库。配对清单本地存；P2P 握手后端开发中。
      </p>

      <div
        className="settings-help"
        style={{
          padding: "10px 12px",
          background: "var(--bg-pane)",
          border: "0.5px solid var(--border)",
          borderRadius: 8,
          marginBottom: 16,
        }}
      >
        macOS 启用前需在 Info.plist 加 NSLocalNetworkUsageDescription；
        mDNS + WS 握手后端开发中。当前可登记设备清单，握手通道上线后即可激活。
      </div>

      <div className="settings-card">
        <div className="settings-card-h">P2P 直连</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">局域网内直连</div>
            <div className="settings-help">
              通过 mDNS 自动发现局域网内的 markio 实例，传输不经云端
            </div>
          </div>
          <Toggle on={p2p} onChange={(v) => setPreference("mobileP2pEnabled", v)} />
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card-h">已配对设备 ({devices.length})</div>
        {devices.length === 0 ? (
          <div className="settings-row">
            <div className="settings-row-l">
              <div className="settings-label" style={{ color: "var(--text-3)" }}>
                还没有配对任何设备
              </div>
              <div className="settings-help">点右侧「登记」开始</div>
            </div>
            <button className="settings-btn primary" onClick={() => void addDevice()}>
              登记设备
            </button>
          </div>
        ) : (
          <>
            {devices.map((d) => (
              <div className="settings-row" key={d.id}>
                <div className="settings-row-l">
                  <div className="settings-label">{d.name}</div>
                  <div className="settings-help">
                    配对于 {new Date(d.pairedAt).toLocaleDateString()}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <SelectBtn
                    value={d.kind}
                    options={MOBILE_DEVICE_KINDS.map((k) => ({
                      value: k.value,
                      label: k.label,
                    }))}
                    onChange={(v) => setKind(d.id, v)}
                  />
                  <button className="settings-btn" onClick={() => void removeDevice(d.id, d.name)}>
                    解除
                  </button>
                </div>
              </div>
            ))}
            <div className="settings-row" style={{ justifyContent: "flex-end" }}>
              <button className="settings-btn primary" onClick={() => void addDevice()}>
                登记设备
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function About() {
  const { t } = useTranslation();
  const [version, setVersion] = useState<string>("");
  const autoCheck = useSettings((s) => s.autoCheckUpdates);
  const setPreference = useSettings((s) => s.setPreference);
  const [openDialog, setOpenDialog] = useState<null | "update" | "changelog" | "feedback">(null);

  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion("?"));
  }, []);

  // 4 张底部链接卡：用户协议 / 隐私 / 开源许可 / 数据导出 —— 全部走 openExternal /
  // 现有 api，没有引入新的依赖。许可与导出指向仓库内的源文件，给用户一个可追的入口。
  const footerCards: Array<{
    t: string;
    s: string;
    onClick: () => void;
  }> = [
    {
      t: "用户协议",
      s: "使用条款 · 开源 MIT",
      onClick: () => void openExternal("https://github.com/chenqi92/Markio/blob/main/LICENSE"),
    },
    {
      t: "隐私",
      s: "本地优先 · 不上报数据",
      onClick: () => void openExternal("https://github.com/chenqi92/Markio#privacy"),
    },
    {
      t: "开源许可",
      s: "查看依赖与三方协议",
      onClick: () => void openExternal("https://github.com/chenqi92/Markio/blob/main/package.json"),
    },
    {
      t: "数据导出",
      s: "打开崩溃日志目录",
      onClick: () => void api.crashOpenDir().catch(() => undefined),
    },
  ];

  return (
    <>
      <SectionHeader id="about" />
      <div className="about-hero">
        <div className="about-mark" aria-hidden />
        <div>
          <div className="about-hero-name">markio</div>
          <div className="about-hero-ver">
            v{version || "0.1.0"}
          </div>
          <div className="about-hero-tag">{t("settings.about.tagline")}</div>
          <div className="about-hero-actions">
            <button
              className="settings-btn primary"
              onClick={() => setOpenDialog("update")}
            >
              {t("settings.about.checkUpdate")}
            </button>
            <button className="settings-btn" onClick={() => setOpenDialog("changelog")}>
              {t("settings.about.releaseNotes")}
            </button>
            <button
              className="settings-btn"
              onClick={() => void api.crashOpenDir().catch(() => undefined)}
              title={t("settings.about.crashLogTitle")}
            >
              {t("settings.about.crashLog")}
            </button>
            <button className="settings-btn" onClick={() => setOpenDialog("feedback")}>
              {t("settings.about.feedback")}
            </button>
          </div>
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card-h">{t("settings.about.updatesCard")}</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">{t("settings.about.autoCheckLabel")}</div>
            <div className="settings-help">{t("settings.about.autoCheckHelp")}</div>
          </div>
          <Toggle
            on={autoCheck}
            onChange={(v) => setPreference("autoCheckUpdates", v)}
          />
        </div>
      </div>
      <CrashWebhookCard />

      <div className="about-foot-grid">
        {footerCards.map((c) => (
          <button type="button" key={c.t} className="about-foot-card" onClick={c.onClick}>
            <div className="t">{c.t}</div>
            <div className="s">{c.s}</div>
          </button>
        ))}
      </div>

      <div className="about-thanks">
        感谢 React / CodeMirror 6 / Tauri / pulldown-cmark / lezer 等开源项目，以及所有提交 issue / PR 的伙伴。
      </div>

      {openDialog === "update" && (
        <UpdateDialog onClose={() => setOpenDialog(null)} />
      )}
      {openDialog === "changelog" && (
        <ChangelogDialog
          currentVersion={version}
          onClose={() => setOpenDialog(null)}
        />
      )}
      {openDialog === "feedback" && (
        <FeedbackDialog
          appVersion={version}
          onClose={() => setOpenDialog(null)}
        />
      )}
    </>
  );
}

function CrashWebhookCard() {
  const { t } = useTranslation();
  const url = useSettings((s) => s.crashWebhookUrl);
  const setPreference = useSettings((s) => s.setPreference);
  const [draft, setDraft] = useState(url);
  const [flushState, setFlushState] = useState<
    | { kind: "idle" }
    | { kind: "sending" }
    | { kind: "ok"; sent: boolean }
    | { kind: "fail"; message: string }
  >({ kind: "idle" });
  useEffect(() => setDraft(url), [url]);

  const sendNow = async () => {
    setFlushState({ kind: "sending" });
    try {
      const sent = await api.crashFlushToWebhook(draft);
      setFlushState({ kind: "ok", sent });
    } catch (e) {
      setFlushState({ kind: "fail", message: String(e) });
    }
  };

  return (
    <div className="settings-card">
      <div className="settings-card-h">{t("settings.about.crashWebhookCard")}</div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">{t("settings.about.crashWebhookLabel")}</div>
          <div className="settings-help">{t("settings.about.crashWebhookHelp")}</div>
        </div>
        <input
          type="url"
          placeholder="https://example.com/markio-crash"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            const trimmed = draft.trim();
            if (trimmed !== url) setPreference("crashWebhookUrl", trimmed);
          }}
          style={{ flex: 1, minWidth: 260 }}
        />
      </div>
      <div className="settings-row" style={{ justifyContent: "flex-end", gap: 8 }}>
        <span className="settings-help">
          {flushState.kind === "sending"
            ? t("settings.about.crashWebhookSending")
            : flushState.kind === "ok"
              ? flushState.sent
                ? t("settings.about.crashWebhookOk")
                : t("settings.about.crashWebhookEmpty")
              : flushState.kind === "fail"
                ? flushState.message
                : ""}
        </span>
        <button
          className="settings-btn"
          onClick={sendNow}
          disabled={!draft.trim() || flushState.kind === "sending"}
        >
          {t("settings.about.crashWebhookTest")}
        </button>
      </div>
    </div>
  );
}
