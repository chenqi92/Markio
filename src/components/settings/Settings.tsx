import { useState, type CSSProperties } from "react";
import { Icon, type IconName } from "../ui/Icon";
import { Toggle, Slider, SelectBtn } from "../ui/controls";
import { useSettings } from "@/stores/settings";
import { THEMES } from "@/themes";

const SECTIONS = [
  { id: "appear", label: "外观", icon: "palette" },
  { id: "general", label: "通用", icon: "sliders" },
  { id: "editor", label: "编辑器", icon: "edit" },
  { id: "sync", label: "同步", icon: "sync" },
  { id: "shortcuts", label: "快捷键", icon: "cmd" },
  { id: "picgo", label: "图片上传", icon: "image" },
  { id: "wechat", label: "微信公众号", icon: "message" },
  { id: "lobster", label: "腾讯龙虾", icon: "bot" },
  { id: "ai", label: "AI 助手", icon: "sparkle" },
  { id: "export", label: "导入 / 导出", icon: "upload" },
  { id: "about", label: "关于", icon: "info" },
] as const satisfies readonly { id: string; label: string; icon: IconName }[];

type SectionId = (typeof SECTIONS)[number]["id"];

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
            {section === "lobster" && <Lobster />}
            {section === "ai" && <AI />}
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
    </>
  );
}

function General() {
  const showLive = useSettings((s) => s.showLiveCursors);
  const setShowLive = useSettings((s) => s.setShowLiveCursors);
  return (
    <>
      <h2 className="settings-h">通用</h2>
      <p className="settings-sub">基础行为与启动选项。</p>
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">显示多端实时光标（演示）</div>
            <div className="settings-help">协作时显示对方光标的彩色徽章，目前为演示效果</div>
          </div>
          <Toggle on={showLive} onChange={setShowLive} />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">启动时打开</div>
          </div>
          <SelectBtn value="上次打开的文档" />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">关闭最后一个标签时</div>
          </div>
          <SelectBtn value="保留窗口" />
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
  const shortcutStyle = useSettings((s) => s.shortcutStyle);
  const setShortcutStyle = useSettings((s) => s.setShortcutStyle);
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
            className="settings-row"
            style={{
              width: "100%",
              textAlign: "left",
              cursor: "pointer",
              background:
                shortcutStyle === m.id ? "var(--bg-hover)" : "transparent",
            }}
            onClick={() => setShortcutStyle(m.id)}
          >
            <div className="settings-row-l">
              <div className="settings-label">{m.label}</div>
            </div>
            <div
              style={{
                width: 16,
                height: 16,
                borderRadius: "50%",
                border: "1.5px solid var(--border-strong)",
                background:
                  shortcutStyle === m.id ? "var(--accent)" : "transparent",
              }}
            />
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
            className="settings-row"
            style={{
              width: "100%",
              textAlign: "left",
              cursor: "pointer",
              background: mode === m.id ? "var(--bg-hover)" : "transparent",
            }}
            onClick={() => setMode(m.id)}
          >
            <div className="settings-row-l">
              <div className="settings-label">{m.label}</div>
            </div>
            <div
              style={{
                width: 16,
                height: 16,
                borderRadius: "50%",
                border: "1.5px solid var(--border-strong)",
                background: mode === m.id ? "var(--accent)" : "transparent",
              }}
            />
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
          <SelectBtn value="500 ms · 实时" />
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

function Sync() {
  return (
    <>
      <h2 className="settings-h">同步</h2>
      <p className="settings-sub">每个驱动单独鉴权与配置，互不影响。下面是 V1 预留位。</p>

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
        <div className="settings-card-h">同步策略</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">冲突时</div>
          </div>
          <SelectBtn value="弹出对比窗口让我选择" />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">同步频率</div>
          </div>
          <SelectBtn value="每 30 秒" />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">仅在 Wi-Fi 下同步附件</div>
          </div>
          <Toggle on={true} />
        </div>
      </div>
    </>
  );
}

const SHORTCUTS = [
  { g: "导航", items: [
    { l: "命令面板 / 快速打开", k: ["⌘", "K"] },
    { l: "全文搜索", k: ["⌘", "⇧", "F"] },
    { l: "在文档内查找", k: ["⌘", "F"] },
    { l: "切换专注模式", k: ["⌘", "."] },
  ]},
  { g: "视图", items: [
    { l: "源码 / 分屏 / 所见即所得 / 阅读", k: ["⌘", "1–4"] },
    { l: "侧栏开关", k: ["⌘", "⇧", "L"] },
    { l: "大纲开关", k: ["⌘", "⇧", "R"] },
  ]},
  { g: "文档", items: [
    { l: "保存", k: ["⌘", "S"] },
    { l: "关闭标签", k: ["⌘", "W"] },
    { l: "打开单个文件…", k: ["⌘", "O"] },
    { l: "打开文件夹…", k: ["⌘", "⇧", "O"] },
  ]},
];

function Shortcuts() {
  return (
    <>
      <h2 className="settings-h">快捷键</h2>
      <p className="settings-sub">默认绑定（自定义会在后续版本支持）。</p>
      {SHORTCUTS.map((g) => (
        <div className="settings-card" key={g.g}>
          <div className="settings-card-h">{g.g}</div>
          {g.items.map((it) => (
            <div className="settings-row" key={it.l}>
              <div className="settings-row-l">
                <div className="settings-label">{it.l}</div>
              </div>
              <div className="kbd-group">
                {it.k.map((k, i) => (
                  <span key={i} className="kbd">{k}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

function Picgo() {
  return (
    <>
      <h2 className="settings-h">图片上传</h2>
      <p className="settings-sub">把粘贴的图片自动上传到图床，并在笔记中插入外链。</p>
      <div className="settings-card">
        <div className="settings-card-h">PicGo 本地服务</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">状态</div>
            <div className="settings-help">未连接 · 启动 PicGo 后会自动探测</div>
          </div>
          <button className="settings-btn">重新检测</button>
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">API 端点</div>
          </div>
          <SelectBtn value="http://127.0.0.1:36677" />
        </div>
      </div>
      <div className="settings-card">
        <div className="settings-card-h">通用</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">粘贴图片自动上传</div>
          </div>
          <Toggle on={true} />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">拖入图片自动上传</div>
          </div>
          <Toggle on={true} />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">本地保留副本</div>
            <div className="settings-help">仓库内 Assets/ 子目录</div>
          </div>
          <Toggle on={true} />
        </div>
      </div>
      <div className="settings-card">
        <div className="settings-card-h">压缩</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">上传前压缩</div>
          </div>
          <Toggle on={true} />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">质量</div>
            <div className="settings-help">85%</div>
          </div>
          <Slider value={85} />
        </div>
      </div>
    </>
  );
}

function WeChat() {
  return (
    <>
      <h2 className="settings-h">微信公众号</h2>
      <p className="settings-sub">设置文章样式、绑定公众号、扫码登录管理推送。</p>
      <div className="settings-card">
        <div className="settings-card-h">绑定的公众号</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">尚未绑定任何公众号</div>
            <div className="settings-help">扫码绑定后可以一键导出为公众号草稿</div>
          </div>
          <button className="settings-btn primary">扫码绑定</button>
        </div>
      </div>
      <div className="settings-card">
        <div className="settings-card-h">推送行为</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">默认导出样式</div>
          </div>
          <SelectBtn value="暖橘 · 杂志" />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">默认作者署名</div>
          </div>
          <SelectBtn value="未设置" />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">AI 自动生成摘要</div>
            <div className="settings-help">由 AI 助手提取前 120 字</div>
          </div>
          <Toggle on={true} />
        </div>
      </div>
    </>
  );
}

function Lobster() {
  return (
    <>
      <h2 className="settings-h">腾讯龙虾</h2>
      <p className="settings-sub">把消息通道接入 markio，由 AI 自动回复，回复内容直接来自你的笔记。</p>
      <div className="settings-card">
        <div className="settings-card-h">连接状态</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">未连接</div>
            <div className="settings-help">扫码登录腾讯龙虾后可建立长连接</div>
          </div>
          <button className="settings-btn primary">扫码登录</button>
        </div>
      </div>
      <div className="settings-card">
        <div className="settings-card-h">AI 自动回复</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">回答使用的模型</div>
          </div>
          <SelectBtn value="跟随 AI 助手默认" />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">回复中附带笔记引用</div>
          </div>
          <Toggle on={true} />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">每日消息上限</div>
          </div>
          <SelectBtn value="200 条 / 天" />
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
  const apiKey = useSettings((s) => s.aiApiKey);
  const endpoint = useSettings((s) => s.aiEndpoint);
  const model = useSettings((s) => s.aiModel);
  const temperature = useSettings((s) => s.aiTemperature);
  const maxTokens = useSettings((s) => s.aiMaxTokens);
  const setAi = useSettings((s) => s.setAi);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await (await import("@/lib/api")).api.aiChat({
        provider,
        apiKey: apiKey || undefined,
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

  return (
    <>
      <h2 className="settings-h">AI 助手</h2>
      <p className="settings-sub">配置模型、API 与提示词。</p>

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
            <div className="settings-label">API Key</div>
            <div className="settings-help">
              {provider === "ollama"
                ? "本地 Ollama 不需要 Key"
                : "明文保存在本机 localStorage，离线优先"}
            </div>
          </div>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setAi({ aiApiKey: e.target.value })}
            placeholder={
              provider === "anthropic"
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
            <div className="settings-label">Endpoint</div>
            <div className="settings-help">留空使用提供方默认</div>
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
              {testResult ?? "发送一次 ping 请求"}
            </div>
          </div>
          <button
            className="settings-btn primary"
            onClick={test}
            disabled={testing}
          >
            {testing ? "测试中…" : "测试"}
          </button>
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

const IMPORT_SOURCES = [
  { id: "notion", name: "Notion", logo: "/brand/import/notion.svg", color: "#111111" },
  { id: "bear", name: "Bear", logo: "/brand/import/bear.svg", color: "#111827" },
  { id: "obsidian", name: "Obsidian", logo: "/brand/import/obsidian.svg", color: "#7c3aed" },
  { id: "evernote", name: "印象笔记", logo: "/brand/import/evernote.svg", color: "#00a82d" },
  { id: "roam", name: "Roam", logo: "/brand/import/roamresearch.svg", color: "#475569" },
  { id: "logseq", name: "Logseq", logo: "/brand/import/logseq.svg", color: "#2563eb" },
];

function ImportExport() {
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
          <SelectBtn value="跟随当前主题" />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">PDF 页边距</div>
          </div>
          <SelectBtn value="标准 · 1 英寸" />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">HTML 内嵌图片</div>
          </div>
          <Toggle on={true} />
        </div>
      </div>
      <div className="settings-card">
        <div className="settings-card-h">从其它工具导入</div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 8,
            padding: "12px 16px",
          }}
        >
          {IMPORT_SOURCES.map((n) => (
            <button
              type="button"
              key={n.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "9px 12px",
                background: "var(--bg-pane-2)",
                border: "0.5px solid var(--border)",
                borderRadius: 8,
                fontSize: 12.5,
                color: "var(--text)",
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              <BrandMark logo={n.logo} color={n.color} size={28} />
              <div>{n.name}</div>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

function About() {
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
        <div
          style={{
            width: 72,
            height: 72,
            borderRadius: 18,
            background: "linear-gradient(135deg, var(--accent), var(--accent-2))",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 32,
            color: "white",
            fontWeight: 700,
            boxShadow: "0 8px 24px var(--accent-glow)",
          }}
        >
          m
        </div>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700 }}>markio</div>
          <div style={{ color: "var(--text-3)", marginTop: 2 }}>
            0.1.0 · 一款本地优先的 Markdown 阅读器
          </div>
          <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
            <button className="settings-btn primary">检查更新</button>
            <button className="settings-btn">发布日志</button>
            <button className="settings-btn">反馈</button>
          </div>
        </div>
      </div>
    </>
  );
}
