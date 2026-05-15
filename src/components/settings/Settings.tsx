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
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { Icon, type IconName } from "../ui/Icon";
import { Toggle, Slider, SelectBtn, type SelectOption } from "../ui/controls";
import { useSettings, generateChannelId } from "@/stores/settings";
import { useRag } from "@/stores/rag";
import { useUI } from "@/stores/ui";
import { useWorkspace as useWorkspaceStore } from "@/stores/workspace";
import { useCustomThemes } from "@/stores/customThemes";
import { THEMES } from "@/themes";
import { api, pickDirectory, pickFile, type RagStatus } from "@/lib/api";
import { writeText } from "@/lib/clipboard";
import { smartChannelQuery, getSmartChannelUsage } from "@/lib/smartChannel";
import { setLocale, currentLocale, type Locale } from "@/i18n";
import {
  COMMANDS,
  type CommandDef,
  type CommandId,
  eventToBinding,
  formatBinding,
  normalizeBinding,
} from "@/lib/shortcuts";

const SECTIONS = [
  { id: "appear", label: "外观", icon: "palette" },
  { id: "general", label: "通用", icon: "sliders" },
  { id: "editor", label: "编辑器", icon: "edit" },
  { id: "sync", label: "同步", icon: "sync" },
  { id: "shortcuts", label: "快捷键", icon: "cmd" },
  { id: "picgo", label: "图片上传", icon: "image" },
  { id: "wechat", label: "微信公众号", icon: "message" },
  { id: "wxAssistant", label: "微信助手", icon: "bot" },
  { id: "smartChannel", label: "智能通道", icon: "flame" },
  { id: "ai", label: "AI 助手", icon: "sparkle" },
  { id: "rag", label: "本地知识库", icon: "search" },
  { id: "export", label: "导入 / 导出", icon: "upload" },
  { id: "about", label: "关于", icon: "info" },
] as const satisfies readonly { id: string; label: string; icon: IconName }[];

type SectionId = (typeof SECTIONS)[number]["id"];

const STARTUP_OPTIONS = [
  { value: "restoreTabs", label: "上次打开的文档" },
  { value: "lastWorkspace", label: "只恢复上次仓库" },
  { value: "welcome", label: "显示欢迎页" },
] as const satisfies readonly SelectOption<"restoreTabs" | "lastWorkspace" | "welcome">[];

const CLOSE_LAST_TAB_OPTIONS = [
  { value: "keepWindow", label: "保留窗口" },
  { value: "showWelcome", label: "显示欢迎页" },
  { value: "quitApp", label: "退出应用" },
] as const satisfies readonly SelectOption<"keepWindow" | "showWelcome" | "quitApp">[];

const AUTOSAVE_DELAY_OPTIONS = [
  { value: 500, label: "500 ms · 实时" },
  { value: 800, label: "800 ms · 平衡" },
  { value: 1500, label: "1.5 秒 · 安静" },
  { value: 3000, label: "3 秒 · 手动感" },
] as const satisfies readonly SelectOption<500 | 800 | 1500 | 3000>[];

const SYNC_CONFLICT_OPTIONS = [
  { value: "ask", label: "弹出对比窗口让我选择" },
  { value: "newest", label: "保留最新修改" },
  { value: "local", label: "优先保留本机版本" },
  { value: "remote", label: "优先保留远端版本" },
] as const satisfies readonly SelectOption<"ask" | "newest" | "local" | "remote">[];

const SYNC_FREQUENCY_OPTIONS = [
  { value: "manual", label: "手动同步" },
  { value: "30s", label: "每 30 秒" },
  { value: "1m", label: "每 1 分钟" },
  { value: "5m", label: "每 5 分钟" },
] as const satisfies readonly SelectOption<"manual" | "30s" | "1m" | "5m">[];

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

const WECHAT_AUTHOR_OPTIONS = [
  { value: "unset", label: "未设置" },
  { value: "appName", label: "markio" },
  { value: "systemUser", label: "系统用户名" },
] as const satisfies readonly SelectOption<"unset" | "appName" | "systemUser">[];

const WECHAT_COVER_OPTIONS = [
  { value: "firstImage", label: "取正文首图" },
  { value: "none", label: "不附带" },
] as const satisfies readonly SelectOption<"firstImage" | "none">[];

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

const EXPORT_PDF_THEME_OPTIONS = [
  { value: "current", label: "跟随当前主题" },
  { value: "light", label: "浅色打印" },
  { value: "dark", label: "深色预览" },
  { value: "print", label: "黑白打印" },
] as const satisfies readonly SelectOption<"current" | "light" | "dark" | "print">[];

const EXPORT_PDF_MARGIN_OPTIONS = [
  { value: "standard", label: "标准 · 1 英寸" },
  { value: "narrow", label: "窄边距 · 0.5 英寸" },
  { value: "wide", label: "宽边距 · 1.25 英寸" },
] as const satisfies readonly SelectOption<"standard" | "narrow" | "wide">[];

export function Settings({ onClose }: { onClose: () => void }) {
  const [section, setSection] = useState<SectionId>("appear");
  return (
    <div className="scrim" onClick={onClose}>
      <div className="settings-window" onClick={(e) => e.stopPropagation()}>
        <div className="settings-titlebar">
          <div className="settings-title">设置</div>
          <button className="icon-btn" onClick={onClose} title="关闭">
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="settings-body">
          <aside className="settings-nav">
            {SECTIONS.map((s) => (
              <button
                type="button"
                key={s.id}
                className={
                  "settings-nav-item" + (section === s.id ? " active" : "")
                }
                onClick={() => setSection(s.id)}
              >
                <span className="ico">
                  <Icon name={s.icon} size={14} />
                </span>
                <span>{s.label}</span>
              </button>
            ))}
          </aside>
          <div className="settings-main">
            {section === "appear" && <Appearance />}
            {section === "general" && <General />}
            {section === "editor" && <Editor />}
            {section === "sync" && <Sync />}
            {section === "shortcuts" && <Shortcuts />}
            {section === "picgo" && <Picgo />}
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
    </div>
  );
}

function Appearance() {
  const theme = useSettings((s) => s.theme);
  const setTheme = useSettings((s) => s.setTheme);
  const fontSize = useSettings((s) => s.fontSize);
  const setFontSize = useSettings((s) => s.setFontSize);
  const follow = useSettings((s) => s.followSystemTheme);
  const setFollow = useSettings((s) => s.setFollowSystemTheme);

  return (
    <>
      <h2 className="settings-h">外观</h2>
      <p className="settings-sub">主题、字号与排版默认值。</p>
      <div className="settings-card">
        <div className="settings-card-h">主题</div>
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
        <div className="settings-card-h">主题模式</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">跟随系统</div>
            <div className="settings-help">日间使用浅色主题，夜间自动切换到深色</div>
          </div>
          <Toggle on={follow} onChange={setFollow} />
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card-h">字号</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">正文字号</div>
            <div className="settings-help">{fontSize} px</div>
          </div>
          <Slider value={fontSize} min={13} max={22} onChange={setFontSize} />
        </div>
      </div>

      <CustomThemesCard />
    </>
  );
}

function CustomThemesCard() {
  const list = useCustomThemes((s) => s.list);
  const activeId = useCustomThemes((s) => s.activeId);
  const refresh = useCustomThemes((s) => s.refresh);
  const importFrom = useCustomThemes((s) => s.importFrom);
  const remove = useCustomThemes((s) => s.remove);
  const apply = useCustomThemes((s) => s.apply);
  const setPreference = useSettings((s) => s.setPreference);
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
    if (!window.confirm(`删除主题 ${id}.css？`)) return;
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
      <CardTitle tip="导入 .css 后会作为附加样式注入根节点，可覆盖内置主题变量；单文件不超过 256 KB。">
        自定义 CSS 主题
      </CardTitle>
      <div className="settings-action-row">
        <button
          className="settings-btn primary"
          disabled={busy !== null}
          onClick={onImport}
        >
          导入 .css
        </button>
        <button
          className="settings-btn"
          disabled={busy !== null}
          onClick={() => void refresh()}
        >
          刷新列表
        </button>
        {activeId && (
          <button
            className="settings-btn"
            disabled={busy !== null}
            onClick={() => void onApply(null)}
          >
            关闭自定义主题
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
        <div className="settings-help">还没有导入任何主题。</div>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
          {list.map((t) => (
            <li
              key={t.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 0",
                borderTop: "1px solid var(--border)",
              }}
            >
              <span style={{ flex: 1 }}>
                <span style={{ fontWeight: activeId === t.id ? 600 : 400 }}>
                  {t.name}
                </span>
                <span
                  className="settings-help"
                  style={{ marginLeft: 8, fontSize: 11 }}
                >
                  {(t.size / 1024).toFixed(1)} KB
                </span>
              </span>
              <button
                className="settings-btn"
                disabled={busy !== null || activeId === t.id}
                onClick={() => void onApply(t.id)}
              >
                {activeId === t.id ? "已应用" : "应用"}
              </button>
              <button
                className="settings-btn"
                disabled={busy !== null}
                onClick={() => void onRemove(t.id)}
                style={{ color: "#ff453a" }}
              >
                删除
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LanguageCard() {
  const [loc, setLoc] = useState<Locale>(currentLocale());
  return (
    <div className="settings-card">
      <div className="settings-row">
        <div className="settings-row-l">
          <LabelWithTip tip="切换后立即生效；少量历史文案会逐步补齐。">
            界面语言 · UI language
          </LabelWithTip>
        </div>
        <SelectBtn
          value={loc}
          options={[
            { value: "zh-CN", label: "简体中文" },
            { value: "en", label: "English" },
          ] as const}
          onChange={(v) => {
            setLoc(v as Locale);
            setLocale(v as Locale);
          }}
        />
      </div>
    </div>
  );
}

function General() {
  const startupBehavior = useSettings((s) => s.startupBehavior);
  const closeLastTabBehavior = useSettings((s) => s.closeLastTabBehavior);
  const setPreference = useSettings((s) => s.setPreference);
  return (
    <>
      <h2 className="settings-h">通用</h2>
      <p className="settings-sub">基础行为与启动选项。</p>
      <LanguageCard />
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">启动时打开</div>
          </div>
          <SelectBtn
            value={startupBehavior}
            options={STARTUP_OPTIONS}
            onChange={(v) => setPreference("startupBehavior", v)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">关闭最后一个标签时</div>
          </div>
          <SelectBtn
            value={closeLastTabBehavior}
            options={CLOSE_LAST_TAB_OPTIONS}
            onChange={(v) => setPreference("closeLastTabBehavior", v)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">显示在菜单栏</div>
          </div>
          <Toggle on={true} />
        </div>
      </div>
    </>
  );
}

function Editor() {
  const mode = useSettings((s) => s.defaultMode);
  const setMode = useSettings((s) => s.setDefaultMode);
  const autosave = useSettings((s) => s.autosave);
  const setAutosave = useSettings((s) => s.setAutosave);
  const autosaveDelayMs = useSettings((s) => s.autosaveDelayMs);
  const shortcutStyle = useSettings((s) => s.shortcutStyle);
  const setShortcutStyle = useSettings((s) => s.setShortcutStyle);
  const setPreference = useSettings((s) => s.setPreference);
  return (
    <>
      <h2 className="settings-h">编辑器</h2>
      <p className="settings-sub">输入习惯与默认视图模式。</p>
      <div className="settings-card">
        <div className="settings-card-h">自动保存</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">输入 800ms 后自动写盘</div>
            <div className="settings-help">关掉则只能 ⌘S 手动保存</div>
          </div>
          <Toggle on={autosave} onChange={setAutosave} />
        </div>
      </div>
      <div className="settings-card">
        <div className="settings-card-h">编辑快捷菜单</div>
        {(
          [
            { id: "all", label: "全部启用（推荐）" },
            { id: "bubble", label: "只用浮动气泡" },
            { id: "slash", label: "只用 / 命令" },
            { id: "toolbar", label: "只用顶部工具栏" },
          ] as const
        ).map((m) => (
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
      <div className="settings-card">
        <div className="settings-card-h">默认模式</div>
        {(
          [
            { id: "source", label: "纯源码" },
            { id: "split", label: "分屏 (推荐)" },
            { id: "wysiwyg", label: "所见即所得" },
            { id: "preview", label: "纯预览" },
          ] as const
        ).map((m) => (
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
        <div className="settings-card-h">输入</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">智能引号</div>
            <div className="settings-help">把 &quot; &quot; 自动替换为 “ ”</div>
          </div>
          <Toggle on={true} />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">自动列表续行</div>
          </div>
          <Toggle on={true} />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">中英文之间自动空格</div>
          </div>
          <Toggle on={false} />
        </div>
      </div>
      <div className="settings-card">
        <div className="settings-card-h">保存</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">自动保存间隔</div>
          </div>
          <SelectBtn
            value={autosaveDelayMs}
            options={AUTOSAVE_DELAY_OPTIONS}
            onChange={(v) => setPreference("autosaveDelayMs", v)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">每次保存写入历史快照</div>
          </div>
          <Toggle on={true} />
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
  const conflict = useSettings((s) => s.syncConflictStrategy);
  const frequency = useSettings((s) => s.syncFrequency);
  const autoSync = useSettings((s) => s.autoSyncEnabled);
  const setPreference = useSettings((s) => s.setPreference);
  return (
    <>
      <h2 className="settings-h">同步</h2>
      <p className="settings-sub">每个驱动单独鉴权与配置。</p>

      <GitSyncCard />

      <WebDavCard />

      <div className="settings-card">
        <div className="settings-card-h">驱动</div>
        {DRIVES.map((d) => (
          <div className="settings-row" key={d.id}>
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
              <div className="settings-help">{d.status}</div>
            </div>
            <button className="settings-btn">配置</button>
          </div>
        ))}
      </div>

      <div className="settings-card">
        <CardTitle tip="自动同步会按频率对当前活动 Git 仓库执行 add、commit、pull 和 push。">
          同步策略
        </CardTitle>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">启用自动同步</div>
          </div>
          <Toggle
            on={autoSync}
            onChange={(v) => setPreference("autoSyncEnabled", v)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">冲突时</div>
          </div>
          <SelectBtn
            value={conflict}
            options={SYNC_CONFLICT_OPTIONS}
            onChange={(v) => setPreference("syncConflictStrategy", v)}
            minMenuWidth={220}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">同步频率</div>
          </div>
          <SelectBtn
            value={frequency}
            options={SYNC_FREQUENCY_OPTIONS}
            onChange={(v) => setPreference("syncFrequency", v)}
          />
        </div>
      </div>
    </>
  );
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

  const refreshBranches = async () => {
    if (!workspacePath) return;
    try {
      const b = await api.gitListBranches(workspacePath);
      setBranches(b);
    } catch {
      setBranches(null);
    }
  };

  useEffect(() => {
    void refreshBranches();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacePath]);

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

  return (
    <div className="settings-card">
      <CardTitle tip="支持 clone、init、status、fetch、commit、pull、push、分支切换和冲突处理；PAT 仅保存在系统钥匙串。">
        Git 同步
      </CardTitle>

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
  { l: "加粗 / 斜体 / 链接", k: ["⌘", "B / I / K"] },
  { l: "高亮 / 删除线", k: ["⌘", "⇧", "H / X"] },
  { l: "标题 1–4", k: ["⌘", "⌥", "1–4"] },
  { l: "双向链接 / 表格 / 代码块 / 公式", k: ["⌘", "⌥", "L / T / C / M"] },
];

function Shortcuts() {
  const overrides = useSettings((s) => s.shortcutOverrides);
  const setShortcut = useSettings((s) => s.setShortcut);
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
        setError({ id: recording, msg: `与「${taken.label}」冲突，请先解除` });
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
  }, [recording, effective, setShortcut]);

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
      <h2 className="settings-h">快捷键</h2>
      <p className="settings-sub">
        点击「录制」后按下要绑定的键组合；按 Esc 取消录制。冲突项以红色提示。
      </p>
      <div className="settings-row" style={{ justifyContent: "flex-end" }}>
        <button
          className="settings-btn"
          onClick={() => {
            setRecording(null);
            setError(null);
            resetAllShortcuts();
          }}
        >
          全部恢复默认
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
                      与其它命令冲突
                    </div>
                  ) : null}
                </div>
                <div className="kbd-group">
                  {isRecording ? (
                    <span
                      className="kbd"
                      style={{ minWidth: 120, textAlign: "center" }}
                    >
                      按下新的键…
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
                      未绑定
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
                  {isRecording ? "取消" : "录制"}
                </button>
                <button
                  className="settings-btn"
                  onClick={() => {
                    setError(null);
                    setShortcut(cmd.id, "");
                  }}
                  disabled={!binding}
                  title="设为未绑定"
                >
                  清除
                </button>
                <button
                  className="settings-btn"
                  onClick={() => {
                    setError(null);
                    resetShortcut(cmd.id);
                  }}
                  disabled={!hasOverride}
                  title="恢复默认"
                >
                  默认
                </button>
              </div>
            );
          })}
        </div>
      ))}
      <div className="settings-card">
        <div className="settings-card-h">Markdown 编辑器内（暂不可改）</div>
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
    </>
  );
}

type PicgoPingState =
  | { stage: "idle" }
  | { stage: "probing" }
  | { stage: "ok"; latencyMs: number }
  | { stage: "fail"; message: string };

function Picgo() {
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
        return "未检测";
      case "probing":
        return "检测中…";
      case "ok":
        return `已连接 · ${ping.latencyMs} ms`;
      case "fail":
        return `未连接 · ${ping.message}`;
    }
  })();
  return (
    <>
      <h2 className="settings-h">图片上传</h2>
      <p className="settings-sub">把粘贴的图片自动上传到图床，并在笔记中插入外链。</p>

      <div className="settings-card">
        <CardTitle tip="S3 为直传，PicGo 为本地代理，关闭时只保存在文档旁 Assets 目录。">
          上传管线
        </CardTitle>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">优先 provider</div>
          </div>
          <SelectBtn
            value={uploadProvider}
            options={[
              { value: "picgo", label: "PicGo（本地代理）" },
              { value: "s3", label: "S3 兼容（直传）" },
              { value: "none", label: "关闭" },
            ] as const}
            onChange={(v) => setPreference("uploadProvider", v)}
          />
        </div>
      </div>

      <S3Card />

      <div className="settings-card">
        <div className="settings-card-h">PicGo 本地服务</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">状态</div>
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
            {ping.stage === "probing" ? "检测中…" : "重新检测"}
          </button>
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">API 端点</div>
          </div>
          <SelectBtn
            value={endpoint}
            options={PICGO_ENDPOINT_OPTIONS}
            onChange={(v) => setPreference("picgoEndpoint", v)}
            minMenuWidth={230}
          />
        </div>
      </div>
      <div className="settings-card">
        <div className="settings-card-h">通用</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <LabelWithTip tip="关闭后会保存到当前文档旁的 Assets/ 目录。">
              粘贴图片自动上传
            </LabelWithTip>
          </div>
          <Toggle
            on={pasteUpload}
            onChange={(v) => setPreference("picgoPasteUpload", v)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">拖入图片自动上传</div>
          </div>
          <Toggle
            on={dragUpload}
            onChange={(v) => setPreference("picgoDragUpload", v)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <LabelWithTip tip="副本保存在当前文档旁的 Assets/ 子目录。">
              本地保留副本
            </LabelWithTip>
          </div>
          <Toggle
            on={keepLocalCopy}
            onChange={(v) => setPreference("picgoKeepLocalCopy", v)}
          />
        </div>
      </div>
      <div className="settings-card">
        <div className="settings-card-h">压缩</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">上传前压缩</div>
          </div>
          <Toggle
            on={compressBeforeUpload}
            onChange={(v) => setPreference("picgoCompressBeforeUpload", v)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">质量</div>
            <div className="settings-help">{quality}%</div>
          </div>
          <Slider
            value={quality}
            min={40}
            max={100}
            onChange={(v) => setPreference("picgoQuality", v)}
          />
        </div>
      </div>
    </>
  );
}

function WeChat() {
  const style = useSettings((s) => s.wechatStyle);
  const author = useSettings((s) => s.wechatAuthor);
  const accountName = useSettings((s) => s.wechatAccountName);
  const appId = useSettings((s) => s.wechatAppId);
  const autoSummary = useSettings((s) => s.wechatAutoSummary);
  const defaultCover = useSettings((s) => s.wechatDefaultCover);
  const setPreference = useSettings((s) => s.setPreference);
  const setToast = useUI((s) => s.setToast);

  const [draftName, setDraftName] = useState(accountName);
  const [draftAppId, setDraftAppId] = useState(appId);
  const [secretDraft, setSecretDraft] = useState("");
  const [secretStored, setSecretStored] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    setDraftName(accountName);
    setDraftAppId(appId);
  }, [accountName, appId]);

  useEffect(() => {
    let cancelled = false;
    if (!appId) {
      setSecretStored(false);
      return;
    }
    api
      .secretHas(`wechat:${appId}`)
      .then((v) => !cancelled && setSecretStored(v))
      .catch(() => !cancelled && setSecretStored(false));
    return () => {
      cancelled = true;
    };
  }, [appId]);

  const bound = Boolean(accountName && appId && secretStored);

  const bind = async () => {
    if (!draftAppId.trim()) {
      setMsg("请填写 AppID");
      return;
    }
    if (!draftName.trim()) {
      setMsg("请填写公众号名称");
      return;
    }
    if (!secretDraft.trim() && !secretStored) {
      setMsg("请填写 AppSecret");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      if (secretDraft) {
        await api.secretSet(`wechat:${draftAppId}`, secretDraft);
      }
      setPreference("wechatAccountName", draftName.trim());
      setPreference("wechatAppId", draftAppId.trim());
      setSecretStored(true);
      setSecretDraft("");
      setMsg("✓ 已绑定，凭据写入系统钥匙串");
      setToast({ stage: "done", message: "公众号已绑定" });
      setTimeout(() => setToast(null), 2400);
    } catch (e) {
      setMsg(`✗ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const unbind = async () => {
    if (!window.confirm(`解绑「${accountName || appId}」？凭据会从钥匙串删除。`)) return;
    setBusy(true);
    try {
      if (appId) await api.secretDelete(`wechat:${appId}`);
      setPreference("wechatAccountName", "");
      setPreference("wechatAppId", "");
      setSecretStored(false);
      setSecretDraft("");
      setDraftName("");
      setDraftAppId("");
      setMsg("已解绑");
    } catch (e) {
      setMsg(`✗ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h2 className="settings-h">微信公众号</h2>
      <p className="settings-sub">
        绑定公众号、配置发布样式与默认作者署名。凭据保存在系统钥匙串。
      </p>

      <div className="settings-card">
        <div className="settings-card-h">绑定的公众号</div>
        {bound ? (
          <>
            <div className="settings-row">
              <div className="settings-row-l">
                <div className="settings-label">{accountName}</div>
                <div className="settings-help">AppID · {appId}</div>
              </div>
              <span
                style={{
                  padding: "2px 8px",
                  fontSize: 11,
                  fontWeight: 600,
                  background: "var(--accent-glow)",
                  color: "var(--accent)",
                  borderRadius: 4,
                }}
              >
                已绑定
              </span>
            </div>
            <div className="settings-row">
              <div className="settings-row-l">
                <div className="settings-help">
                  解绑后将无法一键推送草稿；样式与摘要设置会保留。
                </div>
              </div>
              <button
                className="settings-btn"
                disabled={busy}
                onClick={unbind}
                style={{ color: "#ff453a" }}
              >
                解绑公众号
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="settings-row">
              <div className="settings-row-l">
                <LabelWithTip tip="在公众平台 → 开发 → 基本配置 中查到 AppID。">
                  AppID
                </LabelWithTip>
              </div>
              <input
                type="text"
                value={draftAppId}
                onChange={(e) => setDraftAppId(e.target.value)}
                placeholder="wx...."
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
                <LabelWithTip tip="只在本机展示，方便区分多账号。">
                  公众号名称
                </LabelWithTip>
              </div>
              <input
                type="text"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder="例如：markio 实验室"
                style={{
                  padding: "5px 10px",
                  background: "var(--bg-input)",
                  border: "0.5px solid var(--border-strong)",
                  borderRadius: 6,
                  width: 220,
                  fontSize: 12,
                  color: "var(--text)",
                }}
              />
            </div>
            <div className="settings-row">
              <div className="settings-row-l">
                <LabelWithTip tip="AppSecret 直接写入系统钥匙串；前端只检测是否存在。">
                  AppSecret
                </LabelWithTip>
                <div className="settings-help">
                  {secretStored ? "已存储 · 输入新值替换" : "未保存"}
                </div>
              </div>
              <input
                type="password"
                value={secretDraft}
                onChange={(e) => setSecretDraft(e.target.value)}
                placeholder={secretStored ? "已保存 · 留空保持不变" : "公众号 AppSecret"}
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
            <div className="settings-row" style={{ background: "var(--bg-pane-2)" }}>
              <div className="settings-row-l">
                <div className="settings-help">{msg ?? "填写后保存即可绑定。"}</div>
              </div>
              <button
                className="settings-btn primary"
                disabled={busy}
                onClick={bind}
              >
                {busy ? "保存中…" : "保存并绑定"}
              </button>
            </div>
          </>
        )}
      </div>

      <div className="settings-card">
        <div className="settings-card-h">发布默认</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">默认导出样式</div>
            <div className="settings-help">在导出抽屉中可临时切换。</div>
          </div>
          <SelectBtn
            value={style}
            options={WECHAT_STYLE_OPTIONS}
            onChange={(v) => setPreference("wechatStyle", v)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">默认作者署名</div>
          </div>
          <SelectBtn
            value={author}
            options={WECHAT_AUTHOR_OPTIONS}
            onChange={(v) => setPreference("wechatAuthor", v)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <LabelWithTip tip="发布时自动调用 AI 助手生成摘要；未配置 AI 时退化为正文前 120 字。">
              自动生成摘要
            </LabelWithTip>
          </div>
          <Toggle
            on={autoSummary}
            onChange={(v) => setPreference("wechatAutoSummary", v)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <LabelWithTip tip="发布时优先取文章里的第一张本地图片，作为公众号封面。">
              默认封面
            </LabelWithTip>
          </div>
          <SelectBtn
            value={defaultCover}
            options={WECHAT_COVER_OPTIONS}
            onChange={(v) => setPreference("wechatDefaultCover", v)}
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
  const publishHook = useSettings((s) => s.wxAssistantPublishHook);
  const setPreference = useSettings((s) => s.setPreference);
  const setToast = useUI((s) => s.setToast);
  const [draftHook, setDraftHook] = useState(webhook);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);

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
      <h2 className="settings-h">微信助手</h2>
      <p className="settings-sub">
        通过企业微信机器人 / Server 酱 / 自建 webhook，把 markio 的操作通知推到你的微信。
      </p>

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
            <LabelWithTip tip="公众号草稿创建成功后，向微信助手发送一条带链接的通知。">
              发布公众号草稿后通知
            </LabelWithTip>
          </div>
          <Toggle
            on={publishHook && enabled}
            onChange={(v) => enabled && setPreference("wxAssistantPublishHook", v)}
          />
        </div>
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

  const rotate = () => {
    if (!window.confirm("重置通道 ID 会让现有外部 app 失效，确定继续？")) return;
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
      <h2 className="settings-h">智能通道</h2>
      <p className="settings-sub">
        把 markio 文档库做成一个可被外部应用调用的 AI 查询通道：在其他工具里提问，
        会自动检索当前仓库 + 走 AI 模型给出答案。
      </p>

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
                fontSize: 12.5,
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
                fontSize: 12.5,
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
                    fontSize: 11.5,
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
              命令面板（<code>⌘K</code>）搜索"<b>通过智能通道查询</b>"，把当前问题发给同一引擎。
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

const AI_PROVIDERS = [
  { id: "anthropic", n: "Anthropic", sub: "Claude 系列 · 推荐" },
  { id: "openai", n: "OpenAI", sub: "GPT-4 / 4o / o-series" },
  { id: "google", n: "Google", sub: "Gemini 2.5" },
  { id: "deepseek", n: "DeepSeek", sub: "V3 / R1 · 国内" },
  { id: "ollama", n: "本地 · Ollama", sub: "Qwen / Llama / Mistral" },
  { id: "custom", n: "自定义", sub: "OpenAI 兼容 endpoint" },
];

function AI() {
  const provider = useSettings((s) => s.aiProvider);
  const keyConfigured = useSettings((s) => s.aiKeyConfigured);
  const endpoint = useSettings((s) => s.aiEndpoint);
  const model = useSettings((s) => s.aiModel);
  const temperature = useSettings((s) => s.aiTemperature);
  const maxTokens = useSettings((s) => s.aiMaxTokens);
  const setAi = useSettings((s) => s.setAi);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [savingKey, setSavingKey] = useState(false);

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
    if (!window.confirm(`清除 ${provider} 的 API Key？`)) return;
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
      <h2 className="settings-h">AI 助手</h2>
      <p className="settings-sub">配置模型、API 与提示词。</p>

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
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 8,
            padding: "12px 16px",
          }}
        >
          {AI_PROVIDERS.map((p) => (
            <button
              type="button"
              key={p.id}
              onClick={() => setAi({ aiProvider: p.id as typeof provider })}
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
                style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}
              >
                {p.n}
              </div>
              <div
                style={{ fontSize: 10.5, color: "var(--text-3)", marginTop: 1 }}
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
      </div>

      <div className="settings-card">
        <div className="settings-card-h">
          {AI_PROVIDERS.find((p) => p.id === provider)?.n} 配置
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
              {provider === "ollama"
                ? "本地 Ollama 可留空"
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
              keyConfigured
                ? "已保存 · 输入新值替换"
                : provider === "anthropic"
                ? "sk-ant-…"
                : provider === "openai"
                ? "sk-…"
                : "API Key"
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
            onChange={(e) => setAi({ aiEndpoint: e.target.value })}
            placeholder={
              provider === "anthropic"
                ? "https://api.anthropic.com"
                : provider === "openai"
                ? "https://api.openai.com/v1"
                : provider === "ollama"
                ? "http://127.0.0.1:11434/v1"
                : "https://..."
            }
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
          <input
            type="text"
            value={model}
            onChange={(e) => setAi({ aiModel: e.target.value })}
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
    </>
  );
}

// 1x1 透明 PNG，用于 S3 连接测试
const S3_PROBE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function S3Card() {
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
      <CardTitle tip="支持 AWS S3、阿里 OSS、七牛、Cloudflare R2 和 MinIO；Secret Access Key 只保存到系统钥匙串。">
        S3 兼容存储
      </CardTitle>
      <div className="settings-row">
        <div className="settings-row-l">
          <LabelWithTip tip="例如 https://s3.us-east-1.amazonaws.com 或 https://oss-cn-hangzhou.aliyuncs.com">
            Endpoint
          </LabelWithTip>
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
          <LabelWithTip tip="只保存到系统钥匙串，不写入持久化设置。">
            Secret Access Key
          </LabelWithTip>
          <div className="settings-help">
            {stored ? "已存储" : "未存储"}
          </div>
        </div>
        <input
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          style={{ flex: 1, minWidth: 220 }}
        />
        <button className="settings-btn" onClick={save} disabled={!endpoint}>
          保存
        </button>
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <LabelWithTip tip="使用 CDN 时填写；留空会按 endpoint 和 bucket 推导。">
            公开 URL 前缀（可选）
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
          <LabelWithTip tip="老版 S3 或 MinIO 通常需要开启；新版 AWS 通常使用 virtual-hosted。">
            Path-style URL
          </LabelWithTip>
        </div>
        <Toggle
          on={pathStyle}
          onChange={(v) => setPreference("s3PathStyle", v)}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <LabelWithTip tip="上传一张 1px 占位图到 markio/_probe/ 验证凭据与桶可写。">
            连接测试
          </LabelWithTip>
        </div>
        <button
          className="settings-btn"
          onClick={testConnection}
          disabled={testing || !endpoint || !bucket || !accessKeyId}
        >
          {testing ? "测试中…" : "测试连接"}
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

  return (
    <div className="settings-card">
      <CardTitle tip="支持坚果云、TeraCloud、Nextcloud 和自建 WebDAV；密码只保存到系统钥匙串。">
        WebDAV
      </CardTitle>
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
      <div className="settings-action-row">
        <button
          className="settings-btn"
          disabled={!baseUrl || busy !== null}
          onClick={() => wrap("连接测试", () => api.webdavTest(baseUrl, auth()))}
        >
          测试连接
        </button>
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
  const apiKey = useSettings((s) => s.rerankApiKey);
  const setPreference = useSettings((s) => s.setPreference);
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
        </div>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setPreference("rerankApiKey", e.target.value)}
          placeholder="cohere_xxx"
          style={{ flex: 1, minWidth: 280 }}
        />
      </div>
    </div>
  );
}

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
  const setPreference = useSettings((s) => s.setPreference);

  const [openaiKeyDraft, setOpenaiKeyDraft] = useState("");
  const [openaiKeyConfigured, setOpenaiKeyConfigured] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

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
    if (!window.confirm("清除 OpenAI Embedding 的 API Key？")) return;
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
    if (
      !window.confirm("确认清空索引库？已索引的向量会全部丢失，下次需要重建。")
    )
      return;
    try {
      await useRag.getState().clear(ws.id, ws.path);
      setMsg("索引已清空");
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
      <h2 className="settings-h">本地知识库</h2>
      <p className="settings-sub">
        为当前仓库建立本地向量索引。
      </p>

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
                style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}
              >
                {p.n}
              </div>
              <div
                style={{ fontSize: 10.5, color: "var(--text-3)", marginTop: 1 }}
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
                  正在索引{" "}
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
  { id: "notion", name: "Notion", logo: "/brand/import/notion.svg", color: "#111111" },
  { id: "bear", name: "Bear", logo: "/brand/import/bear.svg", color: "#111827" },
  { id: "obsidian", name: "Obsidian", logo: "/brand/import/obsidian.svg", color: "#7c3aed" },
  { id: "evernote", name: "印象笔记", logo: "/brand/import/evernote.svg", color: "#00a82d" },
  { id: "roam", name: "Roam", logo: "/brand/import/roamresearch.svg", color: "#475569" },
  { id: "logseq", name: "Logseq", logo: "/brand/import/logseq.svg", color: "#2563eb" },
];

type ImportProvider = "notion" | "obsidian" | "bear" | "evernote";

const IMPORT_PROVIDER_MAP: Record<string, ImportProvider | null> = {
  notion: "notion",
  obsidian: "obsidian",
  bear: "bear",
  evernote: "evernote",
  roam: null,
  logseq: null,
};

function extsFor(p: ImportProvider): string[] {
  switch (p) {
    case "notion":
      return ["zip"];
    case "bear":
      return ["bearbook", "zip"];
    case "evernote":
      return ["enex"];
    case "obsidian":
      return [];
  }
}

function providerNeedsDir(p: ImportProvider): boolean {
  return p === "obsidian";
}

function ImportExport() {
  const pdfTheme = useSettings((s) => s.exportPdfTheme);
  const pdfMargin = useSettings((s) => s.exportPdfMargin);
  const setPreference = useSettings((s) => s.setPreference);
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace());
  const refreshTree = useWorkspaceStore((s) => s.refreshTree);
  const [importBusy, setImportBusy] = useState<ImportProvider | null>(null);
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
    setImportMsg({ kind: "info", text: `${provider} 导入中…` });
    try {
      const report = await api.importRun(provider, src, activeWorkspace.path);
      setImportMsg({
        kind: "ok",
        text: `${provider} 导入完成：${report.files} 个文件 → ${report.dest}${
          report.warnings.length > 0 ? `（${report.warnings.length} 条警告）` : ""
        }`,
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
      <h2 className="settings-h">导入 / 导出</h2>
      <p className="settings-sub">把内容带进 markio，或导出到别处。</p>
      <div className="settings-card">
        <div className="settings-card-h">导出默认</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">PDF 主题</div>
          </div>
          <SelectBtn
            value={pdfTheme}
            options={EXPORT_PDF_THEME_OPTIONS}
            onChange={(v) => setPreference("exportPdfTheme", v)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">PDF 页边距</div>
          </div>
          <SelectBtn
            value={pdfMargin}
            options={EXPORT_PDF_MARGIN_OPTIONS}
            onChange={(v) => setPreference("exportPdfMargin", v)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">HTML 内嵌图片</div>
          </div>
          <Toggle on={true} />
        </div>
      </div>
      <div className="settings-card">
        <CardTitle tip="导入到当前仓库的 imports/provider-timestamp/；Notion、Bear、印象选归档文件，Obsidian 选 vault 目录。">
          从其它工具导入
        </CardTitle>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
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
                  fontSize: 12.5,
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
                        : `从 ${n.name} 导入`
                }
              >
                <BrandMark logo={n.logo} color={n.color} size={28} />
                <div>
                  {n.name}
                  {importBusy === provider && (
                    <div style={{ fontSize: 10, color: "var(--text-3)" }}>导入中…</div>
                  )}
                </div>
              </button>
            );
          })}
        </div>
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

type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "uptodate" }
  | { kind: "available"; version: string; notes?: string }
  | { kind: "downloading"; version: string; progress: number; total: number }
  | { kind: "ready"; version: string }
  | { kind: "error"; message: string };

function About() {
  const [version, setVersion] = useState<string>("");
  const [update, setUpdate] = useState<UpdateState>({ kind: "idle" });
  const theme = useSettings((s) => s.theme);
  const isDarkTheme = THEMES.find((t) => t.id === theme)?.isDark ?? false;

  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion("?"));
  }, []);

  const checkForUpdates = async () => {
    setUpdate({ kind: "checking" });
    try {
      const u = await check();
      if (!u) {
        setUpdate({ kind: "uptodate" });
        return;
      }
      setUpdate({ kind: "available", version: u.version, notes: u.body });
      let downloaded = 0;
      let contentLength = 0;
      await u.downloadAndInstall((event) => {
        if (event.event === "Started") {
          contentLength = event.data.contentLength ?? 0;
          setUpdate({
            kind: "downloading",
            version: u.version,
            progress: 0,
            total: contentLength,
          });
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          setUpdate({
            kind: "downloading",
            version: u.version,
            progress: downloaded,
            total: contentLength,
          });
        } else if (event.event === "Finished") {
          setUpdate({ kind: "ready", version: u.version });
        }
      });
    } catch (e) {
      setUpdate({ kind: "error", message: String(e) });
    }
  };

  const restartNow = async () => {
    try {
      await relaunch();
    } catch (e) {
      setUpdate({ kind: "error", message: String(e) });
    }
  };

  const renderStatus = () => {
    switch (update.kind) {
      case "checking":
        return <span style={{ color: "var(--text-3)" }}>正在检查…</span>;
      case "uptodate":
        return <span style={{ color: "var(--text-3)" }}>已是最新版本</span>;
      case "available":
        return (
          <span style={{ color: "var(--accent)" }}>
            发现新版本 {update.version}，正在下载…
          </span>
        );
      case "downloading": {
        const pct =
          update.total > 0
            ? Math.round((update.progress / update.total) * 100)
            : 0;
        return (
          <span style={{ color: "var(--accent)" }}>
            下载中 {update.version} · {pct}%
          </span>
        );
      }
      case "ready":
        return (
          <span style={{ color: "var(--accent)" }}>
            {update.version} 已就绪，重启生效
          </span>
        );
      case "error":
        return <span style={{ color: "#dc2626" }}>{update.message}</span>;
      default:
        return null;
    }
  };

  const checking = update.kind === "checking" || update.kind === "downloading";

  return (
    <>
      <h2 className="settings-h">关于</h2>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: "20px 0",
        }}
      >
        <img
          className="settings-app-icon"
          src={isDarkTheme ? "/brand/icon-dark-256.png" : "/brand/icon-light-256.png"}
          alt="markio"
          draggable={false}
        />
        <div>
          <div style={{ fontSize: 20, fontWeight: 700 }}>markio</div>
          <div style={{ color: "var(--text-3)", marginTop: 2 }}>
            {version || "0.1.0"} · 一款本地优先的 Markdown 阅读器
          </div>
          <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {update.kind === "ready" ? (
              <button className="settings-btn primary" onClick={restartNow}>
                重启应用
              </button>
            ) : (
              <button
                className="settings-btn primary"
                disabled={checking}
                onClick={checkForUpdates}
              >
                {checking ? "处理中…" : "检查更新"}
              </button>
            )}
            <button className="settings-btn">发布日志</button>
            <button
              className="settings-btn"
              type="button"
              onClick={() => {
                void api.crashOpenDir().catch(() => undefined);
              }}
              title="在文件管理器中显示 markio.log 所在目录"
            >
              错误日志
            </button>
            <button className="settings-btn">反馈</button>
            {renderStatus()}
          </div>
        </div>
      </div>
    </>
  );
}
