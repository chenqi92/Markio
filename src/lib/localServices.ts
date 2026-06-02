// 本地服务桥接：把前端设置 / 活跃仓库推给三个 Rust 本地服务（WebClipper / SmartChannel / P2P），
// 并把 SmartChannel 的入站请求桥接回前端的 smartChannelQuery（复用其检索 + AI + 配额逻辑）。
//
// main.tsx 启动时调用一次 installLocalServices()。仅桌面端生效。

import { listen } from "@tauri-apps/api/event";
import { api, isDesktop } from "@/lib/api";
import { useSettings } from "@/stores/settings";
import { useWorkspace } from "@/stores/workspace";
import {
  smartChannelQuery,
  type SmartChannelScope,
  type SmartChannelModelSource,
} from "@/lib/smartChannel";

let installed = false;

export function installLocalServices() {
  if (installed || !isDesktop()) return;
  installed = true;

  // ── 1) 活跃仓库变化 → 推给本地服务（决定 clipper 落到哪个仓库、P2P 暴露哪个仓库） ──
  const pushActiveWorkspace = (path: string | null) => {
    void api.clipperSetActiveWorkspace(path).catch(() => undefined);
    void api.p2pSetActiveWorkspace(path).catch(() => undefined);
    void api.mcpSetActiveWorkspace(path).catch(() => undefined);
  };
  pushActiveWorkspace(useWorkspace.getState().activeWorkspace()?.path ?? null);
  let lastWsId = useWorkspace.getState().activeId;
  useWorkspace.subscribe((s) => {
    if (s.activeId !== lastWsId) {
      lastWsId = s.activeId;
      pushActiveWorkspace(s.activeWorkspace()?.path ?? null);
    }
  });

  // ── 2) 设置变化 → 推 clipper / smartChannel 配置（P2P 由 MobileDevices 开关直接推，避免无谓建身份） ──
  const pushConfig = (s: ReturnType<typeof useSettings.getState>) => {
    void api
      .clipperSetConfig(s.clipperEnabled, s.clipperReadability, s.clipperHtmlToMd)
      .catch(() => undefined);
    void api
      .smartChannelSetConfig(s.smartChannelEnabled, s.smartChannelId)
      .catch(() => undefined);
  };
  const relevant = (s: ReturnType<typeof useSettings.getState>) =>
    [
      s.clipperEnabled,
      s.clipperReadability,
      s.clipperHtmlToMd,
      s.smartChannelEnabled,
      s.smartChannelId,
    ].join("|");
  pushConfig(useSettings.getState());
  let prevRelevant = relevant(useSettings.getState());
  useSettings.subscribe((s) => {
    const cur = relevant(s);
    if (cur !== prevRelevant) {
      prevRelevant = cur;
      pushConfig(s);
    }
  });

  // ── 3) SmartChannel 入站桥：后端 /query 派发事件 → 跑 smartChannelQuery → 回包 ──
  void listen<{
    id: string;
    query: string;
    scope?: string | null;
    modelSource?: string | null;
    maxChunks?: number | null;
  }>("smart-channel-request", async (e) => {
    const { id, query, scope, modelSource, maxChunks } = e.payload;
    try {
      const res = await smartChannelQuery({
        query,
        scope: (scope as SmartChannelScope) ?? undefined,
        modelSource: (modelSource as SmartChannelModelSource) ?? undefined,
        maxChunks: maxChunks ?? undefined,
      });
      await api.smartChannelRespond(id, {
        ok: true,
        answer: res.answer,
        refs: res.refs.map((r) => ({ path: r.path, heading: r.heading })),
        model: res.model,
      });
    } catch (err) {
      await api.smartChannelRespond(id, { ok: false, error: (err as Error).message });
    }
  });
}
