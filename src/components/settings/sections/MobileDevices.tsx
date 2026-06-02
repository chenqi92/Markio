import { useEffect, useState } from "react";
import { Toggle } from "../../ui/controls";
import { useSettings } from "@/stores/settings";
import { useDialog } from "@/stores/dialog";
import { useUI } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";
import { useSync } from "@/stores/sync";
import { api } from "@/lib/api";
import { pairWithPeer, runP2PSync } from "@/lib/sync/p2pAdapter";
import { cloudStageLabel, cloudStoreStage } from "@/lib/syncScheduler";
import type { SyncStage as EngineSyncStage } from "@/lib/sync/types";
import { SectionHeader } from "../_shared";

interface DiscoveredPeer {
  deviceId: string;
  name: string;
  host: string;
  port: number;
  version: string;
}

export function MobileDevices() {
  const p2p = useSettings((s) => s.mobileP2pEnabled);
  const deviceName = useSettings((s) => s.mobileDeviceName);
  const devices = useSettings((s) => s.mobileDevices);
  const conflictStrategy = useSettings((s) => s.syncConflictStrategy);
  const setPreference = useSettings((s) => s.setPreference);
  const promptDialog = useDialog((s) => s.prompt);
  const confirmDialog = useDialog((s) => s.confirm);
  const setToast = useUI((s) => s.setToast);

  const [peers, setPeers] = useState<DiscoveredPeer[]>([]);
  const [pairCode, setPairCode] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // 启用后轮询 p2p_status：拿发现的对端 + 本机配对窗口状态
  useEffect(() => {
    if (!p2p) {
      setPeers([]);
      return;
    }
    let alive = true;
    const load = () => {
      api
        .p2pStatus()
        .then((s) => {
          if (!alive) return;
          setPeers(s.peers);
          if (!s.pairingOpen) setPairCode((c) => (c ? null : c));
        })
        .catch(() => undefined);
    };
    load();
    const t = setInterval(load, 2500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [p2p]);

  const toggleP2p = async (v: boolean) => {
    setPreference("mobileP2pEnabled", v);
    try {
      await api.p2pSetConfig(v, deviceName || "我的设备");
      // 同步把当前活跃仓库告诉后端（决定 P2P 暴露哪个仓库）
      const ws = useWorkspace.getState().activeWorkspace();
      await api.p2pSetActiveWorkspace(ws?.path ?? null);
    } catch (e) {
      setToast({ stage: "error", message: `P2P 启动失败：${(e as Error).message}` });
      setTimeout(() => setToast(null), 2500);
    }
  };

  const renameDevice = async () => {
    const name = await promptDialog({
      title: "本机设备名",
      message: "局域网内其它设备看到的名字",
      defaultValue: deviceName,
      confirmLabel: "保存",
    });
    if (!name) return;
    setPreference("mobileDeviceName", name);
    if (p2p) await api.p2pSetConfig(true, name).catch(() => undefined);
  };

  const openPairing = async () => {
    try {
      const code = await api.p2pOpenPairing();
      setPairCode(code);
    } catch (e) {
      setToast({ stage: "error", message: (e as Error).message });
      setTimeout(() => setToast(null), 2500);
    }
  };

  const closePairing = async () => {
    await api.p2pClosePairing().catch(() => undefined);
    setPairCode(null);
  };

  // 与发现的对端配对：输入对端显示的 6 位码 → 换 token → 存为已配对设备
  const pairPeer = async (peer: DiscoveredPeer) => {
    const code = await promptDialog({
      title: `与「${peer.name}」配对`,
      message: "在对方设备「本机配对码」里生成 6 位码，填到这里",
      defaultValue: "",
      confirmLabel: "配对",
    });
    if (!code || !/^\d{6}$/.test(code.trim())) return;
    setBusy(peer.deviceId);
    try {
      const r = await pairWithPeer(peer.host, peer.port, code.trim());
      const cur = useSettings.getState().mobileDevices;
      const id = `dev_${Date.now().toString(36)}`;
      const next = cur.filter((d) => d.peerId !== r.peerId);
      next.push({
        id,
        name: r.name || peer.name,
        kind: "other",
        pairedAt: Date.now(),
        peerId: r.peerId,
        host: peer.host,
        port: peer.port,
        token: r.token,
      });
      setPreference("mobileDevices", next);
      setToast({ stage: "done", message: `已与 ${r.name || peer.name} 配对` });
      setTimeout(() => setToast(null), 2000);
    } catch (e) {
      setToast({ stage: "error", message: `配对失败：${(e as Error).message}` });
      setTimeout(() => setToast(null), 2800);
    } finally {
      setBusy(null);
    }
  };

  const syncWith = async (device: (typeof devices)[number]) => {
    if (!device.peerId || !device.host || !device.port || !device.token) {
      setToast({ stage: "error", message: "该设备缺少配对信息，请重新配对" });
      setTimeout(() => setToast(null), 2500);
      return;
    }
    const ws = useWorkspace.getState().activeWorkspace();
    if (!ws) {
      setToast({ stage: "error", message: "请先打开一个仓库" });
      setTimeout(() => setToast(null), 2500);
      return;
    }
    const sync = useSync.getState();
    if (sync.isInflight(ws.path)) {
      setToast({ stage: "error", message: "当前仓库正在同步中" });
      setTimeout(() => setToast(null), 2500);
      return;
    }
    setBusy(device.id);
    // 复用全局 sync 状态栏（与云同步同一处展示阶段/进度）
    sync.setInflight(ws.path, true);
    sync.setStage("preflight", `P2P · ${device.name} 准备同步`);
    try {
      const report = await runP2PSync(
        {
          peerId: device.peerId,
          name: device.name,
          host: device.host,
          port: device.port,
          token: device.token,
        },
        ws.path,
        conflictStrategy,
        {
          onStage: (stage, detail) => {
            const s = stage as EngineSyncStage;
            const label = cloudStageLabel(s);
            sync.setStage(
              cloudStoreStage(s),
              `P2P · ${device.name} · ${label}${detail ? ` · ${detail}` : ""}`,
            );
          },
          onProgress: (done, total, current) => {
            sync.setStage(
              "push",
              `P2P · ${device.name} · ${done}/${total}${current ? ` · ${current}` : ""}`,
            );
          },
        },
      );
      if (report.stage === "error") {
        sync.setStatus("error", report.fatalError ?? "P2P 同步失败");
        setToast({ stage: "error", message: `同步失败：${report.fatalError ?? ""}` });
      } else {
        const n = report.results.filter((r) => r.ok).length;
        sync.setStage("done", `P2P · ${device.name} 同步完成（${n} 项）`);
        sync.setLastSync(Date.now());
        setToast({ stage: "done", message: `与 ${device.name} 同步完成（${n} 项）` });
      }
    } catch (e) {
      sync.setStatus("error", (e as Error).message);
      setToast({ stage: "error", message: `同步失败：${(e as Error).message}` });
    } finally {
      sync.setInflight(ws.path, false);
      setBusy(null);
      setTimeout(() => setToast(null), 2800);
    }
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

  const paired = devices.filter((d) => d.peerId);

  return (
    <>
      <SectionHeader id="mobile" />

      <div className="settings-banner">
        P2P 局域网同步（桌面 ↔ 桌面）：两台 markio 在同一局域网内经 mDNS 自动发现、配对后用
        WebSocket 直传整个仓库，不经云端。macOS 首次启用需在系统弹窗允许「本地网络」访问。
      </div>

      <div className="settings-card">
        <div className="settings-card-h">P2P 直连</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">启用局域网直连</div>
            <div className="settings-help">开启后广播本机并发现同网段的其它 markio</div>
          </div>
          <Toggle on={p2p} onChange={(v) => void toggleP2p(v)} />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">本机设备名</div>
            <div className="settings-help">{deviceName}</div>
          </div>
          <button className="settings-btn" onClick={() => void renameDevice()}>
            改名
          </button>
        </div>
      </div>

      {p2p && (
        <div className="settings-card">
          <div className="settings-card-h">本机配对码</div>
          <div className="settings-row">
            <div className="settings-row-l">
              <div className="settings-label">
                {pairCode ? (
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 20, letterSpacing: 4 }}>
                    {pairCode}
                  </span>
                ) : (
                  "未开启配对窗口"
                )}
              </div>
              <div className="settings-help">
                {pairCode
                  ? "把这串码告诉对方设备，让它在「局域网设备」里对本机发起配对（5 分钟内有效）"
                  : "生成一个 6 位码，供对方设备配对本机"}
              </div>
            </div>
            {pairCode ? (
              <button className="settings-btn" onClick={() => void closePairing()}>
                关闭
              </button>
            ) : (
              <button className="settings-btn primary" onClick={() => void openPairing()}>
                生成配对码
              </button>
            )}
          </div>
        </div>
      )}

      {p2p && (
        <div className="settings-card">
          <div className="settings-card-h">局域网设备 ({peers.length})</div>
          {peers.length === 0 ? (
            <div className="settings-row">
              <div className="settings-row-l">
                <div className="settings-label" style={{ color: "var(--text-3)" }}>
                  暂未发现其它 markio
                </div>
                <div className="settings-help">确保对方也开启了 P2P 且在同一局域网</div>
              </div>
            </div>
          ) : (
            peers.map((peer) => (
              <div className="settings-row" key={peer.deviceId}>
                <div className="settings-row-l">
                  <div className="settings-label">{peer.name || peer.deviceId}</div>
                  <div className="settings-help">
                    {peer.host}:{peer.port} · v{peer.version}
                  </div>
                </div>
                <button
                  className="settings-btn primary"
                  disabled={busy === peer.deviceId}
                  onClick={() => void pairPeer(peer)}
                >
                  {busy === peer.deviceId ? "配对中…" : "配对"}
                </button>
              </div>
            ))
          )}
        </div>
      )}

      <div className="settings-card">
        <div className="settings-card-h">已配对设备 ({paired.length})</div>
        {paired.length === 0 ? (
          <div className="settings-row">
            <div className="settings-row-l">
              <div className="settings-label" style={{ color: "var(--text-3)" }}>
                还没有配对任何设备
              </div>
              <div className="settings-help">在上面「局域网设备」里发起配对</div>
            </div>
          </div>
        ) : (
          paired.map((d) => (
            <div className="settings-row" key={d.id}>
              <div className="settings-row-l">
                <div className="settings-label">{d.name}</div>
                <div className="settings-help">
                  {d.host}:{d.port} · 配对于 {new Date(d.pairedAt).toLocaleDateString()}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <button
                  className="settings-btn primary"
                  disabled={busy === d.id}
                  onClick={() => void syncWith(d)}
                >
                  {busy === d.id ? "同步中…" : "同步"}
                </button>
                <button
                  className="settings-btn settings-btn-danger"
                  onClick={() => void removeDevice(d.id, d.name)}
                >
                  解除
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}
