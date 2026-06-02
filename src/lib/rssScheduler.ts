// RSS 订阅的前端定时拉取调度器。
//
// 设计与 digestScheduler 一致：用 setInterval 每 60s 轮询一次，对每个 feed 按
// rssFetchInterval 判断"距上次拉取是否已超过间隔"，是则后台拉取。仅在 app 运行期间生效。
// interval = "manual" 时不自动拉，只有用户点刷新才拉。
//
// 拉取核心 fetchRssFeed 同时给设置面板的"刷新"按钮复用，保证两处更新 store 的逻辑一致。

import { useSettings } from "@/stores/settings";
import { api } from "@/lib/api";

const TICK_MS = 60_000;
let timer: number | null = null;

/** 各间隔对应的毫秒数；"manual" 不在表里 → 不自动拉。 */
const INTERVAL_MS: Partial<Record<string, number>> = {
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

// 正在拉取的 feed id，避免同一 feed 并发拉取（tick 与手动刷新重叠时）。
const inflight = new Set<string>();

/**
 * 拉取单个 feed 并把结果写回 settings.rssFeeds：对比 seenGuids 算新增条目数累加到 unread。
 * 失败时记录 lastError。设置面板按钮与调度器共用此函数。
 */
export async function fetchRssFeed(id: string): Promise<void> {
  if (inflight.has(id)) return;
  inflight.add(id);
  try {
    const f = useSettings.getState().rssFeeds.find((x) => x.id === id);
    if (!f) return;
    try {
      const r = await api.rssFetch(f.url);
      const seen = new Set(f.seenGuids ?? []);
      const fresh = r.items.filter((it) => !seen.has(it.guid)).length;
      const nextGuids = r.items
        .map((it) => it.guid)
        .filter(Boolean)
        .slice(0, 50);
      // 从 store 重新取最新列表，避免闭包里的 f 已陈旧
      const cur = useSettings.getState().rssFeeds;
      useSettings.getState().setPreference(
        "rssFeeds",
        cur.map((x) =>
          x.id === id
            ? {
                ...x,
                lastFetchedAt: Date.now(),
                seenGuids: nextGuids,
                unread: (x.unread ?? 0) + fresh,
                lastError: undefined,
              }
            : x,
        ),
      );
    } catch (e) {
      const cur = useSettings.getState().rssFeeds;
      useSettings.getState().setPreference(
        "rssFeeds",
        cur.map((x) =>
          x.id === id
            ? { ...x, lastError: (e as Error).message, lastFetchedAt: Date.now() }
            : x,
        ),
      );
    }
  } finally {
    inflight.delete(id);
  }
}

function tick() {
  const s = useSettings.getState();
  const intervalMs = INTERVAL_MS[s.rssFetchInterval];
  if (!intervalMs) return; // manual：不自动拉
  const now = Date.now();
  for (const f of s.rssFeeds) {
    const last = f.lastFetchedAt ?? 0;
    if (now - last >= intervalMs) {
      void fetchRssFeed(f.id);
    }
  }
}

export function installRssScheduler() {
  if (timer != null) return;
  tick();
  timer = window.setInterval(tick, TICK_MS);
}

export function uninstallRssScheduler() {
  if (timer != null) {
    window.clearInterval(timer);
    timer = null;
  }
}
