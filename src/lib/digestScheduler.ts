// 微信助手 · 每日笔记摘要的前端调度器。
//
// 设计：用 setInterval 每 60s 检查"现在是不是已经过了 wxAssistantDigestTime
// 但今天还没发"。仅在 app 运行期间起作用（关掉 app 当然不会推）。
// 跨重启去重靠 useSettings.wxAssistantLastDigestSentDate（YYYY-MM-DD）。
//
// 摘要内容只用本地状态（recents + streak），不读笔记正文，避免向 webhook
// 泄露原文。

import { useSettings } from "@/stores/settings";
import { useRecents } from "@/stores/recents";
import { useStreak } from "@/stores/streak";
import { useWorkspace } from "@/stores/workspace";
import { api } from "@/lib/api";

const TICK_MS = 60_000;
let timer: number | null = null;

function ymd(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseHHmm(s: string): { h: number; m: number } | null {
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1]!, 10);
  const min = parseInt(m[2]!, 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return { h, m: min };
}

/** 拼一段适合微信的纯文本摘要（不带正文，仅文件名 + 时间） */
export function buildDigestText(): string {
  const today = ymd();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const cutoff = todayStart.getTime();
  const recents = useRecents.getState().items.filter((it) => it.at >= cutoff);
  const streak = useStreak.getState();
  const ws = useWorkspace.getState().activeWorkspace();
  const lines: string[] = [];
  lines.push(`📅 markio 每日摘要 · ${today}`);
  if (ws) lines.push(`仓库：${ws.name}`);
  lines.push(`今日字数：${streak.todayWords} / ${streak.dailyTarget} · 连击 ${streak.streak} 天`);
  lines.push("");
  if (recents.length === 0) {
    lines.push("（今日还没有打开过笔记，去写点什么吧～）");
  } else {
    lines.push(`今日打开 ${recents.length} 篇笔记：`);
    for (const r of recents.slice(0, 8)) {
      const t = new Date(r.at);
      const hh = String(t.getHours()).padStart(2, "0");
      const mm = String(t.getMinutes()).padStart(2, "0");
      lines.push(`• ${hh}:${mm}  ${r.name}`);
    }
    if (recents.length > 8) lines.push(`…等共 ${recents.length} 篇`);
  }
  return lines.join("\n");
}

export interface DigestSendResult {
  ok: boolean;
  message: string;
}

/** 立即发送一次摘要（设置面板的"立即发送"按钮 + 调度器都用） */
export async function sendDigestNow(opts?: {
  /** 默认 true：发送成功后写入 lastSentDate */
  markSent?: boolean;
}): Promise<DigestSendResult> {
  const settings = useSettings.getState();
  if (!settings.wxAssistantEnabled) {
    return { ok: false, message: "微信助手未启用" };
  }
  const url = settings.wxAssistantWebhook.trim();
  if (!url) {
    return { ok: false, message: "未配置 webhook URL" };
  }
  const text = buildDigestText();
  // 同时按企业微信群机器人格式 + Server 酱风格组装 body
  const body = JSON.stringify({
    msgtype: "text",
    text: { content: text },
    title: `markio 每日摘要 · ${ymd()}`,
    desp: text,
  });
  try {
    const r = await api.webhookPost(url, body);
    if (!r.ok) {
      return {
        ok: false,
        message: `HTTP ${r.status}${r.bodyExcerpt ? ` · ${r.bodyExcerpt.slice(0, 120)}` : ""}`,
      };
    }
    if (opts?.markSent !== false) {
      settings.setPreference("wxAssistantLastDigestSentDate", ymd());
    }
    return { ok: true, message: "已推送" };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

function tick() {
  const settings = useSettings.getState();
  if (!settings.wxAssistantEnabled || !settings.wxAssistantDailyDigest) return;
  const t = parseHHmm(settings.wxAssistantDigestTime);
  if (!t) return;
  const today = ymd();
  if (settings.wxAssistantLastDigestSentDate === today) return; // 今日已发
  const now = new Date();
  // 已经过了目标时刻才发；提前 1 分钟内不发，避免轮询窗口边界两次
  if (now.getHours() < t.h) return;
  if (now.getHours() === t.h && now.getMinutes() < t.m) return;
  // 异步触发，不阻塞 tick
  void sendDigestNow().catch(() => undefined);
}

export function installDigestScheduler() {
  if (timer != null) return;
  // 启动后立即检查一次（覆盖"用户晚于目标时刻才打开 app"）
  tick();
  timer = window.setInterval(tick, TICK_MS);
}

export function uninstallDigestScheduler() {
  if (timer != null) {
    window.clearInterval(timer);
    timer = null;
  }
}
