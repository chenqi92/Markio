import { useState } from "react";
import { SelectBtn, type SelectOption, Toggle } from "../../ui/controls";
import { useSettings } from "@/stores/settings";
import { useDialog } from "@/stores/dialog";
import { openExternal } from "@/lib/opener";
import { fetchRssFeed } from "@/lib/rssScheduler";
import { SectionHeader } from "../_shared";

const RSS_INTERVAL_OPTIONS = [
  { value: "manual", label: "手动" },
  { value: "15m", label: "15 分钟" },
  { value: "1h", label: "1 小时" },
  { value: "4h", label: "4 小时" },
  { value: "1d", label: "1 天" },
] as const satisfies readonly SelectOption<
  "manual" | "15m" | "1h" | "4h" | "1d"
>[];

export function RssFeeds() {
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

  /** 拉取单个 feed：与后台调度器共用 fetchRssFeed，仅在此处额外维护按钮 busy 态。 */
  const refreshFeed = async (id: string) => {
    setBusyIds((s) => new Set(s).add(id));
    try {
      await fetchRssFeed(id);
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
      <SectionHeader id="rss" />

      <div className="settings-card">
        <div className="settings-card-h">
          <span>订阅 ({feeds.length})</span>
          {feeds.length > 0 && (
            <div className="settings-card-h-actions">
              <button
                className="settings-btn"
                onClick={() => void refreshAll()}
                disabled={refreshingAll}
              >
                {refreshingAll ? "刷新中…" : "全部刷新"}
              </button>
              <button
                className="settings-btn primary"
                onClick={() => void addFeed()}
              >
                添加订阅
              </button>
            </div>
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
                        <span className="settings-pill-new">
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
                      className="settings-btn settings-btn-danger"
                      onClick={() => void removeFeed(f.id, f.title)}
                    >
                      删除
                    </button>
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>

      <div className="settings-card">
        <div className="settings-card-h">拉取与摘要</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">拉取频率</div>
            <div className="settings-help">按此频率后台自动拉取（手动 = 只在你点刷新时拉）</div>
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
            <div className="settings-help">条目阅读器接入后，每条新条目调用当前 AI 提供方生成 1 句话摘要（暂存设置）</div>
          </div>
          <Toggle on={aiSummary} onChange={(v) => setPreference("rssAiSummary", v)} />
        </div>
      </div>
    </>
  );
}
