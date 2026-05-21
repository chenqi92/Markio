import { useEffect, useState } from "react";
import { Toggle, SelectBtn, type SelectOption } from "../../ui/controls";
import { useSettings, generateChannelId } from "@/stores/settings";
import { useUI } from "@/stores/ui";
import { useWorkspace as useWorkspaceStore } from "@/stores/workspace";
import { useDialog } from "@/stores/dialog";
import { writeText } from "@/lib/clipboard";
import { smartChannelQuery, getSmartChannelUsage } from "@/lib/smartChannel";
import { shortcutText } from "@/lib/shortcuts";
import { SectionHeader, LabelWithTip } from "./_shared";

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

export function SmartChannelSettings() {
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
