import { useEffect, useState } from "react";
import { Toggle } from "../../ui/controls";
import { useSettings } from "@/stores/settings";
import { useUI } from "@/stores/ui";
import { api } from "@/lib/api";
import { LabelWithTip, SectionHeader } from "../_shared";

export function WxAssistant() {
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
        <div className="settings-row settings-row-action">
          <div className="settings-row-l">
            <div className="settings-label">发送测试</div>
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
            className="settings-time-input"
            value={digestTime}
            onChange={(e) => setPreference("wxAssistantDigestTime", e.target.value)}
            disabled={!enabled || !dailyDigest}
          />
        </div>
        <div className="settings-row settings-row-action">
          <div className="settings-row-l">
            <div className="settings-label">立即发送一次摘要</div>
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
