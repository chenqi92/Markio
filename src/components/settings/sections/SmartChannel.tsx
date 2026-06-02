import { useEffect, useState } from "react";
import { SelectBtn, Toggle } from "../../ui/controls";
import { useSettings, generateChannelId } from "@/stores/settings";
import { useUI } from "@/stores/ui";
import { useWorkspace as useWorkspaceStore } from "@/stores/workspace";
import { useDialog } from "@/stores/dialog";
import { writeText } from "@/lib/clipboard";
import { smartChannelQuery, getSmartChannelUsage } from "@/lib/smartChannel";
import { shortcutText } from "@/lib/shortcuts";
import {
  LabelWithTip,
  SectionHeader,
  SMART_CHANNEL_CHUNKS_OPTIONS,
  SMART_CHANNEL_LIMIT_OPTIONS,
  SMART_CHANNEL_SCOPE_OPTIONS,
  SMART_CHANNEL_STYLE_OPTIONS,
  getSmartChannelModelOptions,
} from "../_shared";

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
  const modelOptions = getSmartChannelModelOptions();

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
            options={modelOptions}
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
        <div className="smart-test-row">
          <LabelWithTip tip="模拟外部 app 通过通道发起的查询；结果与外部一致。">
            测试问题
          </LabelWithTip>
          <textarea
            className="smart-test-input"
            value={testQuery}
            onChange={(e) => setTestQuery(e.target.value)}
            placeholder={`例如：本周我写过哪些和"反脆弱"相关的笔记？`}
            rows={2}
          />
          <div className="smart-test-actions">
            <button
              className="settings-btn primary"
              onClick={runTest}
              disabled={testing || !enabled}
              title={!enabled ? "请先开启总开关" : undefined}
            >
              {testing ? "查询中…" : "发送"}
            </button>
          </div>
        </div>
        {testErr && (
          <div className="smart-test-err">✗ {testErr}</div>
        )}
        {testAnswer && (
          <div className="smart-test-answer">
            <div className="smart-test-answer-h">回答</div>
            <div className="smart-test-answer-body">{testAnswer}</div>
            {testRefs.length > 0 && (
              <>
                <div className="smart-test-answer-h" style={{ marginTop: 10 }}>
                  引用片段
                </div>
                <ul className="smart-test-refs">
                  {testRefs.map((r, i) => (
                    <li key={i}>
                      <span className="smart-ref-file">
                        {r.path.split("/").slice(-1)[0]}
                      </span>
                      {r.heading && (
                        <span className="smart-ref-heading"> — {r.heading}</span>
                      )}
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
        <div className="smart-howto">
          <p>
            智能通道开启后才会在浏览器环境挂载 <code>window.__markioSmartChannel</code>；
            关闭即解绑，避免内部 API 被无意暴露。在 Tauri 桌面端会附带本机进程内调用。
            外部应用可通过以下方式触发：
          </p>
          <ol>
            <li>
              命令面板（<code>{shortcutText("⌘K")}</code>）搜索"<b>通过智能通道查询</b>"，把当前问题发给同一引擎。
            </li>
            <li>
              Raycast / Alfred / 自建脚本通过 markio 的 webhook 触发器（路线图），
              POST <code>{`{"channelId":"${channelId.slice(0, 14)}…","query":"…"}`}</code>。
            </li>
            <li>
              微信助手 webhook（见左侧"微信助手"）收到查询消息时自动转发到此通道、回答再推回微信（路线图，需入站接收端）。
            </li>
          </ol>
        </div>
      </div>
    </>
  );
}
