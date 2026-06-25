import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettings, type DriveId, type DriveConfig } from "@/stores/settings";
import { useDialog } from "@/stores/dialog";
import { useWorkspace as useWorkspaceStore } from "@/stores/workspace";
import { api, pickDirectory } from "@/lib/api";
import { displayPath } from "@/lib/utils";
import { openExternal } from "@/lib/opener";
import { type IconName } from "../../ui/Icon";
import { Toggle, SelectBtn } from "../../ui/controls";
import { BrandMark, CardTitle, LabelWithTip, SectionHeader } from "../_shared";
import { WebDavCard } from "./AI";

function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).pop() || "untitled";
}

function contentTypeFromPath(path: string): string {
  const ext = fileNameFromPath(path).split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    md: "text/markdown",
    markdown: "text/markdown",
    txt: "text/plain",
    json: "application/json",
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    csv: "text/csv",
    html: "text/html",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    zip: "application/zip",
  };
  return ext ? map[ext] ?? "application/octet-stream" : "application/octet-stream";
}

/** 拉取「已内置官方 client_id」的网盘集合，用于决定显示一键登录还是要求填 client_id */
function useBuiltinOauth(): Set<string> {
  const [set, setSet] = useState<Set<string>>(new Set());
  useEffect(() => {
    api
      .builtinOauthProviders()
      .then((list) => setSet(new Set(list)))
      .catch(() => setSet(new Set()));
  }, []);
  return set;
}

/** 每个网盘可指定只同步仓库内某个子目录（不相交挂载）；留空=整个仓库 */
function LocalSubpathRow({ driveId }: { driveId: DriveId }) {
  const driveConfigs = useSettings((s) => s.driveConfigs);
  const setPreference = useSettings((s) => s.setPreference);
  const cfg: DriveConfig = driveConfigs[driveId] ?? { folder: "", enabled: false };
  return (
    <div className="settings-row">
      <div className="settings-row-l">
        <div className="settings-label">本地子目录</div>
        <div className="settings-help">
          留空 = 同步整个仓库；填子目录（如 work）则只同步该目录，可让不同网盘各管一个目录、互不相交
        </div>
      </div>
      <input
        type="text"
        value={cfg.localSubpath ?? ""}
        onChange={(e) =>
          setPreference("driveConfigs", {
            ...driveConfigs,
            [driveId]: { ...cfg, localSubpath: e.target.value },
          })
        }
        placeholder="留空 = 整个仓库"
        style={{ flex: 1, minWidth: 280 }}
      />
    </div>
  );
}

const DRIVES = [
  { id: "icloud", name: "iCloud Drive", logo: "/brand/sync/icloud.svg", color: "#0a84ff", status: "未连接" },
  { id: "s3", name: "AWS S3 / 兼容", icon: "database" as IconName, color: "#ff9900", status: "未连接" },
  { id: "drop", name: "Dropbox", logo: "/brand/sync/dropbox.svg", color: "#0061ff", status: "未连接" },
  { id: "drive", name: "Google Drive", logo: "/brand/sync/googledrive.svg", color: "#34c759", status: "未连接" },
  { id: "onedrive", name: "OneDrive", icon: "cloud" as IconName, color: "#0364b8", status: "未连接" },
  { id: "synology", name: "Synology NAS", icon: "archive" as IconName, color: "#0066cc", status: "未连接" },
];

export function Sync() {
  const { t } = useTranslation();
  const conflict = useSettings((s) => s.syncConflictStrategy);
  const frequency = useSettings((s) => s.syncFrequency);
  const autoSync = useSettings((s) => s.autoSyncEnabled);
  const webdavBaseUrl = useSettings((s) => s.webdavBaseUrl);
  const s3Bucket = useSettings((s) => s.s3Bucket);
  const s3AccessKeyId = useSettings((s) => s.s3AccessKeyId);
  const driveConfigs = useSettings((s) => s.driveConfigs);
  const setPreference = useSettings((s) => s.setPreference);
  const conflictOptions = useMemo(
    () =>
      (["ask", "newest", "local", "remote"] as const).map((v) => ({
        value: v,
        label: t(`settings.sync.conflictOptions.${v}`),
      })),
    [t],
  );
  const frequencyOptions = useMemo(
    () =>
      (["manual", "30s", "1m", "5m"] as const).map((v) => ({
        value: v,
        label: t(`settings.sync.frequencyOptions.${v}`),
      })),
    [t],
  );
  const autoSyncActive = autoSync && frequency !== "manual";
  const setAutoSyncEnabled = (enabled: boolean) => {
    if (enabled && frequency === "manual") {
      setPreference("syncFrequency", "30s");
    }
    setPreference("autoSyncEnabled", enabled);
  };
  const setSyncFrequency = (value: typeof frequency) => {
    setPreference("syncFrequency", value);
    if (value === "manual" && autoSync) {
      setPreference("autoSyncEnabled", false);
    }
  };

  const webdavSyncEnabled = !!(driveConfigs.webdav?.enabled && webdavBaseUrl);
  const totalDriveCount = (
    ["icloud", "s3", "drop", "drive", "onedrive", "synology"] as DriveId[]
  ).filter((id) => {
    const cfg = driveConfigs[id];
    if (!cfg?.enabled) return false;
    if (id === "s3") return !!(s3Bucket && s3AccessKeyId);
    return !!cfg.folder;
  }).length;

  const targets: Array<{
    id: string;
    label: string;
    sub: string;
    dot: "ok" | "warn" | "off";
    anchor?: string;
  }> = [
    { id: "local", label: "本地", sub: "当前仓库永远落地到磁盘", dot: "ok" },
    {
      id: "git",
      label: "Git",
      sub: autoSyncActive
        ? `自动 ${frequencyOptions.find((o) => o.value === frequency)?.label ?? frequency}`
        : "手动模式 · 在下方 Git 卡里推 / 拉",
      dot: autoSyncActive ? "ok" : "off",
      anchor: "mk-sync-card-github",
    },
    {
      id: "webdav",
      label: "WebDAV",
      sub: webdavSyncEnabled
        ? `已启用 · ${driveConfigs.webdav?.folder || webdavBaseUrl}`
        : webdavBaseUrl
          ? "已配置 · 未启用同步"
          : "未配置",
      dot: webdavSyncEnabled ? "ok" : webdavBaseUrl ? "warn" : "off",
      anchor: "mk-sync-card-webdav",
    },
    {
      id: "drives",
      label: "网盘 / 对象存储",
      sub:
        totalDriveCount > 0
          ? `${totalDriveCount} 个已配置 · iCloud / S3 / Dropbox / GDrive / OneDrive / Synology`
          : "未启用 · iCloud / S3 / Dropbox / GDrive / OneDrive / Synology",
      dot: totalDriveCount > 0 ? "ok" : "off",
      anchor: "mk-sync-card-drives",
    },
  ];

  const scrollTo = (anchor: string) => {
    const el = document.getElementById(anchor);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    el.classList.add("mk-flash");
    window.setTimeout(() => el.classList.remove("mk-flash"), 1600);
  };

  return (
    <>
      <SectionHeader id="sync" />

      {/* 顶部概览：5 个存储目标 + 状态点；点击滚到对应卡片 */}
      <div className="settings-card">
        <div className="settings-card-h">Git 同步与云存储</div>
        <div className="sync-overview">
          {targets.map((t) => (
            <button
              key={t.id}
              type="button"
              className="sync-target"
              onClick={() => t.anchor && scrollTo(t.anchor)}
              disabled={!t.anchor}
              title={t.anchor ? "跳到下方对应配置" : undefined}
            >
              <span className={`upload-dot upload-dot-${t.dot}`} />
              <div className="sync-target-tt">
                <div className="t">{t.label}</div>
                <div className="s">{t.sub}</div>
              </div>
              {t.anchor && (
                <span className="sync-target-chev" aria-hidden>›</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* 策略 — 提到第二位，让用户先看到"我会自动同步还是手动"再细配各目标 */}
      <div className="settings-card">
        <CardTitle tip={t("settings.sync.policyTip")}>
          {t("settings.sync.policyCard")}
        </CardTitle>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">{t("settings.sync.enableAutoSync")}</div>
          </div>
          <Toggle
            on={autoSync}
            onChange={setAutoSyncEnabled}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">{t("settings.sync.onConflict")}</div>
          </div>
          <SelectBtn
            value={conflict}
            options={conflictOptions}
            onChange={(v) => setPreference("syncConflictStrategy", v)}
            minMenuWidth={220}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">{t("settings.sync.frequency")}</div>
          </div>
          <SelectBtn
            value={frequency}
            options={frequencyOptions}
            onChange={setSyncFrequency}
          />
        </div>
      </div>

      <div id="mk-sync-card-github">
        <GitSyncCard />
      </div>

      <div id="mk-sync-card-webdav">
        <WebDavCard />
      </div>

      <div id="mk-sync-card-drives">
        <DrivesCard />
      </div>
    </>
  );
}

function flashHighlight(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  el.classList.add("mk-flash");
  window.setTimeout(() => el.classList.remove("mk-flash"), 1600);
}

const DRIVE_HAS_NATIVE_CARD: Partial<Record<DriveId, string>> = {
  github: "mk-sync-card-github",
  webdav: "mk-sync-card-webdav",
};

function DrivesCard() {
  const { t } = useTranslation();
  const driveConfigs = useSettings((s) => s.driveConfigs);
  const webdavBaseUrl = useSettings((s) => s.webdavBaseUrl);
  const s3Bucket = useSettings((s) => s.s3Bucket);
  const s3AccessKeyId = useSettings((s) => s.s3AccessKeyId);
  const [expanded, setExpanded] = useState<DriveId | null>(null);

  const driveStatusText = (id: DriveId): string => {
    if (id === "github") {
      // GitSyncCard 自己管远端，这里只显示"详见上方卡片"
      return t("settings.sync.drive.openExisting", { name: "GitHub" });
    }
    if (id === "webdav") {
      return webdavBaseUrl
        ? t("settings.sync.driveStatus.connected", { folder: webdavBaseUrl })
        : t("settings.sync.driveStatus.disconnected");
    }
    if (id === "s3") {
      const cfg = driveConfigs.s3;
      if (!s3Bucket || !s3AccessKeyId) return t("settings.sync.driveStatus.disconnected");
      if (!cfg?.enabled) return t("settings.sync.driveStatus.paused");
      return t("settings.sync.driveStatus.connected", {
        folder: `${s3Bucket}/${cfg.folder || "markio"} · ${s3AccessKeyId.slice(0, 6)}…`,
      });
    }
    const cfg = driveConfigs[id];
    if (!cfg || !cfg.folder) {
      return t("settings.sync.driveStatus.disconnected");
    }
    if (!cfg.enabled) {
      return t("settings.sync.driveStatus.paused");
    }
    return t("settings.sync.driveStatus.connected", { folder: cfg.folder });
  };

  const onConfigureClick = (id: DriveId) => {
    const nativeId = DRIVE_HAS_NATIVE_CARD[id];
    if (nativeId) {
      flashHighlight(nativeId);
      return;
    }
    setExpanded((cur) => (cur === id ? null : id));
  };

  return (
    <div className="settings-card">
      <div className="settings-card-h">{t("settings.sync.drivesCard")}</div>
      {DRIVES.map((d) => {
        const id = d.id as DriveId;
        const isExpanded = expanded === id;
        return (
          <div key={d.id}>
            <div className="settings-row">
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
                <div className="settings-help">{driveStatusText(id)}</div>
              </div>
              <button
                className="settings-btn"
                type="button"
                onClick={() => onConfigureClick(id)}
              >
                {DRIVE_HAS_NATIVE_CARD[id]
                  ? t("settings.sync.drive.configure")
                  : isExpanded
                    ? t("settings.sync.drive.collapse")
                    : t("settings.sync.drive.configure")}
              </button>
            </div>
            {isExpanded && id === "s3" && <S3DriveDrawer />}
            {isExpanded && id === "drop" && <DropboxDriveDrawer />}
            {isExpanded && id === "drive" && <GDriveDriveDrawer />}
            {isExpanded && id === "onedrive" && <OneDriveDriveDrawer />}
            {isExpanded && id === "synology" && <SynologyDriveDrawer />}
            {isExpanded && id === "icloud" && (
              <FolderDriveDrawer driveId={id} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function FolderDriveDrawer({
  driveId,
}: {
  driveId: DriveId;
}) {
  const { t } = useTranslation();
  const driveConfigs = useSettings((s) => s.driveConfigs);
  const setPreference = useSettings((s) => s.setPreference);
  const cfg: DriveConfig = driveConfigs[driveId] ?? { folder: "", enabled: false };
  const [autoDetected, setAutoDetected] = useState<string | null>(null);

  useEffect(() => {
    if (driveId !== "icloud") return;
    api
      .icloudDefaultPath()
      .then((p) => setAutoDetected(p || null))
      .catch(() => setAutoDetected(null));
  }, [driveId]);

  const updateCfg = (patch: Partial<DriveConfig>) => {
    const next: Partial<Record<DriveId, DriveConfig>> = {
      ...driveConfigs,
      [driveId]: { ...cfg, ...patch },
    };
    setPreference("driveConfigs", next);
  };

  const pickFolder = async () => {
    const picked = await pickDirectory();
    if (picked) updateCfg({ folder: picked });
  };

  const useAutoDetected = () => {
    if (autoDetected) updateCfg({ folder: autoDetected });
  };

  const openInFileManager = () => {
    if (cfg.folder) void openExternal(cfg.folder);
  };

  const disconnect = () => {
    const next = { ...driveConfigs };
    delete next[driveId];
    setPreference("driveConfigs", next);
  };

  return (
    <div
      className="settings-drawer"
      style={{
        margin: "8px 0 12px",
        padding: 12,
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--surface-2)",
      }}
    >
      <div className="settings-help" style={{ marginBottom: 8 }}>
        把 markio 仓库放进 iCloud Drive 文件夹，Apple 客户端会自动镜像到云端和其它设备。
      </div>
      {autoDetected && (
        <div
          className="settings-help"
          style={{
            padding: 8,
            border: "1px dashed var(--border)",
            borderRadius: 6,
            marginBottom: 8,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span style={{ flex: 1, wordBreak: "break-all" }}>
            侦测到本机 iCloud Drive：{autoDetected}
          </span>
          <button
            className="settings-btn"
            type="button"
            onClick={useAutoDetected}
            disabled={cfg.folder === autoDetected}
          >
            采用
          </button>
        </div>
      )}
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">{t("settings.sync.drive.pickFolder")}</div>
          <div className="settings-help" style={{ wordBreak: "break-all" }}>
            {cfg.folder || t("settings.sync.drive.noFolder")}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button className="settings-btn" type="button" onClick={pickFolder}>
            {t("settings.sync.drive.pickFolder")}
          </button>
          {cfg.folder && (
            <button className="settings-btn" type="button" onClick={openInFileManager}>
              打开
            </button>
          )}
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">{t("settings.sync.drive.enable")}</div>
        </div>
        <Toggle
          on={cfg.enabled && !!cfg.folder}
          onChange={(v) => updateCfg({ enabled: v })}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-help" style={{ color: "var(--text-3)" }}>
            iCloud 的真实同步由 Apple 客户端进程负责；markio 只是把这个目录认作仓库根。
          </div>
        </div>
        {cfg.folder && (
          <button className="settings-btn" type="button" onClick={disconnect}>
            {t("settings.sync.drive.disconnect")}
          </button>
        )}
      </div>
    </div>
  );
}

function S3DriveDrawer() {
  const { t } = useTranslation();
  const s3Endpoint = useSettings((s) => s.s3Endpoint);
  const s3Region = useSettings((s) => s.s3Region);
  const s3Bucket = useSettings((s) => s.s3Bucket);
  const s3AccessKeyId = useSettings((s) => s.s3AccessKeyId);
  const s3PublicBaseUrl = useSettings((s) => s.s3PublicBaseUrl);
  const s3PathStyle = useSettings((s) => s.s3PathStyle);
  const driveConfigs = useSettings((s) => s.driveConfigs);
  const setPreference = useSettings((s) => s.setPreference);
  const syncCfg: DriveConfig = driveConfigs.s3 ?? { folder: "markio", enabled: false };

  const [secret, setSecret] = useState("");
  const [hasStoredSecret, setHasStoredSecret] = useState(false);
  const [busy, setBusy] = useState<"save" | "test" | "list" | "delete" | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [listPrefix, setListPrefix] = useState("");
  const [remoteObjects, setRemoteObjects] = useState<Array<{
    key: string;
    size: number;
    etag: string;
    lastModified: string;
  }> | null>(null);
  const [listTruncated, setListTruncated] = useState(false);
  const confirmDialog = useDialog((s) => s.confirm);

  const cfgPayload = () => ({
    endpoint: s3Endpoint,
    region: s3Region,
    bucket: s3Bucket,
    accessKeyId: s3AccessKeyId,
    secretAccessKey: "",
    publicBaseUrl: s3PublicBaseUrl || undefined,
    pathStyle: s3PathStyle,
  });

  const updateSyncCfg = (patch: Partial<DriveConfig>) => {
    setPreference("driveConfigs", {
      ...driveConfigs,
      s3: { ...syncCfg, folder: syncCfg.folder || "markio", ...patch },
    });
  };

  const setSyncEnabled = (enabled: boolean) => {
    if (enabled && (!s3Endpoint || !s3Bucket || !s3AccessKeyId)) {
      setMsg({ kind: "err", text: "启用同步前请先填写 endpoint / bucket / accessKeyId" });
      return;
    }
    updateSyncCfg({ enabled });
  };

  useEffect(() => {
    if (!s3Endpoint) {
      setHasStoredSecret(false);
      return;
    }
    api.s3HasSecret(s3Endpoint).then(setHasStoredSecret).catch(() => setHasStoredSecret(false));
  }, [s3Endpoint]);

  const save = async () => {
    if (!s3Endpoint) {
      setMsg({ kind: "err", text: "endpoint 必填" });
      return;
    }
    setBusy("save");
    setMsg(null);
    try {
      if (secret) {
        await api.s3SetSecret(s3Endpoint, secret);
        setSecret("");
        setHasStoredSecret(true);
      }
      setMsg({ kind: "ok", text: t("settings.sync.drive.save") });
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    if (!s3Endpoint || !s3Bucket || !s3AccessKeyId) {
      setMsg({ kind: "err", text: "endpoint / bucket / accessKeyId 必填" });
      return;
    }
    setBusy("test");
    setMsg(null);
    try {
      const probeKey = `.markio/probe-${Date.now()}.txt`;
      const body = btoa("markio s3 connection probe");
      await api.s3PutObject(cfgPayload(), probeKey, body, "text/plain");
      try {
        await api.s3DeleteObject(cfgPayload(), probeKey);
        setMsg({ kind: "ok", text: t("settings.sync.drive.testOk") });
      } catch (cleanupError) {
        setMsg({
          kind: "ok",
          text: `${t("settings.sync.drive.testOk")}；探针文件清理失败：${String(cleanupError)}`,
        });
      }
    } catch (e) {
      setMsg({
        kind: "err",
        text: t("settings.sync.drive.testFailed", { msg: String(e) }),
      });
    } finally {
      setBusy(null);
    }
  };

  const listRemote = async () => {
    if (!s3Endpoint || !s3Bucket || !s3AccessKeyId) {
      setMsg({ kind: "err", text: "endpoint / bucket / accessKeyId 必填" });
      return;
    }
    setBusy("list");
    setMsg(null);
    try {
      const r = await api.s3ListObjects(cfgPayload(), listPrefix, undefined, 200);
      setRemoteObjects(r.objects);
      setListTruncated(r.isTruncated);
      if (r.objects.length === 0) {
        setMsg({ kind: "ok", text: "远端没有匹配的对象" });
      }
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
      setRemoteObjects(null);
    } finally {
      setBusy(null);
    }
  };

  const deleteRemote = async (key: string) => {
    const ok = await confirmDialog({
      title: "删除远端对象？",
      message: `${key} 将从远端存储中删除，此操作不可撤销。`,
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    setBusy("delete");
    setMsg(null);
    try {
      await api.s3DeleteObject(cfgPayload(), key);
      setRemoteObjects((cur) => cur?.filter((o) => o.key !== key) ?? null);
      setMsg({ kind: "ok", text: `已删除 ${key}` });
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const formatSize = (n: number): string => {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  };

  return (
    <div
      className="settings-drawer"
      style={{
        margin: "8px 0 12px",
        padding: 12,
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--surface-2)",
        display: "grid",
        gap: 8,
      }}
    >
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">Endpoint</div>
        </div>
        <input
          type="text"
          value={s3Endpoint}
          onChange={(e) => setPreference("s3Endpoint", e.target.value)}
          placeholder="https://s3.amazonaws.com"
          style={{ flex: 1, minWidth: 280 }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">Region</div>
        </div>
        <input
          type="text"
          value={s3Region}
          onChange={(e) => setPreference("s3Region", e.target.value)}
          placeholder="us-east-1"
          style={{ width: 200 }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">Bucket</div>
        </div>
        <input
          type="text"
          value={s3Bucket}
          onChange={(e) => setPreference("s3Bucket", e.target.value)}
          placeholder="markio-sync"
          style={{ flex: 1, minWidth: 280 }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">Access Key ID</div>
        </div>
        <input
          type="text"
          value={s3AccessKeyId}
          onChange={(e) => setPreference("s3AccessKeyId", e.target.value)}
          placeholder="AKIA…"
          style={{ flex: 1, minWidth: 280 }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">Secret Access Key</div>
          <div className="settings-help">
            {hasStoredSecret ? "已存入系统钥匙串" : "尚未保存"}
          </div>
        </div>
        <input
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder={hasStoredSecret ? "•••••• (留空保持现有)" : "secret"}
          style={{ flex: 1, minWidth: 280 }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">Public Base URL</div>
          <div className="settings-help">CDN/自定义域名，可留空</div>
        </div>
        <input
          type="text"
          value={s3PublicBaseUrl}
          onChange={(e) => setPreference("s3PublicBaseUrl", e.target.value)}
          placeholder="https://cdn.example.com"
          style={{ flex: 1, minWidth: 280 }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">Path-style URL</div>
          <div className="settings-help">兼容 MinIO / 自建 S3</div>
        </div>
        <Toggle
          on={s3PathStyle}
          onChange={(v) => setPreference("s3PathStyle", v)}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">同步前缀</div>
          <div className="settings-help">自动同步会读写这个 prefix 下的仓库文件</div>
        </div>
        <input
          type="text"
          value={syncCfg.folder || "markio"}
          onChange={(e) => updateSyncCfg({ folder: e.target.value })}
          placeholder="markio"
          style={{ flex: 1, minWidth: 280 }}
        />
      </div>
      <LocalSubpathRow driveId="s3" />
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">启用 S3 同步</div>
          <div className="settings-help">状态栏“立刻同步”和自动同步会使用此目标</div>
        </div>
        <Toggle
          on={syncCfg.enabled && !!s3Endpoint && !!s3Bucket && !!s3AccessKeyId}
          onChange={setSyncEnabled}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">前缀（用于浏览）</div>
          <div className="settings-help">可选；只列出 key 以此开头的对象</div>
        </div>
        <input
          type="text"
          value={listPrefix}
          onChange={(e) => setListPrefix(e.target.value)}
          placeholder="例如 markio/"
          style={{ flex: 1, minWidth: 280 }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l" />
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button
            className="settings-btn"
            type="button"
            disabled={busy !== null}
            onClick={save}
          >
            {t("settings.sync.drive.save")}
          </button>
          <button
            className="settings-btn"
            type="button"
            disabled={busy !== null}
            onClick={listRemote}
          >
            {busy === "list" ? "…" : "浏览远端"}
          </button>
          <button
            className="settings-btn primary"
            type="button"
            disabled={busy !== null}
            onClick={test}
          >
            {busy === "test" ? "…" : t("settings.sync.drive.testUpload")}
          </button>
        </div>
      </div>
      {remoteObjects && remoteObjects.length > 0 && (
        <div
          className="settings-help"
          style={{
            padding: 8,
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg-pane)",
            maxHeight: 240,
            overflow: "auto",
          }}
        >
          <div style={{ marginBottom: 6 }}>
            {remoteObjects.length} 个对象
            {listTruncated ? "（仅显示前 200）" : ""}
          </div>
          <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none" }}>
            {remoteObjects.map((o) => (
              <li
                key={o.key}
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  padding: "2px 0",
                  borderBottom: "1px dashed var(--border)",
                }}
              >
                <span style={{ flex: 1, wordBreak: "break-all" }}>{o.key}</span>
                <span style={{ color: "var(--text-3)", fontSize: 12 }}>
                  {formatSize(o.size)}
                </span>
                <button
                  className="settings-btn"
                  type="button"
                  disabled={busy !== null}
                  onClick={() => deleteRemote(o.key)}
                  title={`删除 ${o.key}`}
                  style={{ padding: "2px 8px" }}
                >
                  删除
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {msg && (
        <div
          className="settings-message"
          style={{ color: msg.kind === "err" ? "#dc2626" : "var(--accent)" }}
        >
          {msg.text}
        </div>
      )}
    </div>
  );
}

function DropboxDriveDrawer() {
  const clientId = useSettings((s) => s.dropboxClientId);
  const hasBuiltin = useBuiltinOauth().has("dropbox");
  const driveConfigs = useSettings((s) => s.driveConfigs);
  const setPreference = useSettings((s) => s.setPreference);
  const syncCfg: DriveConfig = driveConfigs.drop ?? { folder: "/markio", enabled: false };
  const [status, setStatus] = useState<{
    connected: boolean;
    display: string;
    accountId: string;
    expiresInSecs: number;
  } | null>(null);
  const [busy, setBusy] = useState<
    "auth" | "list" | "delete" | "upload" | "signout" | null
  >(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [listPath, setListPath] = useState("");
  const [entries, setEntries] = useState<
    Array<{ tag: string; name: string; pathLower: string; pathDisplay: string; size: number; serverModified: string }>
    | null
  >(null);
  const [uploadPath, setUploadPath] = useState("");
  const confirmDialog = useDialog((s) => s.confirm);

  const updateSyncCfg = (patch: Partial<DriveConfig>) => {
    setPreference("driveConfigs", {
      ...driveConfigs,
      drop: { ...syncCfg, folder: syncCfg.folder || "/markio", ...patch },
    });
  };

  const setSyncEnabled = (enabled: boolean) => {
    if (enabled && !status?.connected) {
      setMsg({ kind: "err", text: "启用同步前请先完成 Dropbox 授权" });
      return;
    }
    updateSyncCfg({ enabled });
  };

  useEffect(() => {
    api.dropboxStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  const authorize = async () => {
    if (!clientId.trim() && !hasBuiltin) {
      setMsg({ kind: "err", text: "请先填写 Dropbox App key (Client ID)" });
      return;
    }
    setBusy("auth");
    setMsg(null);
    try {
      const s = await api.dropboxAuthorize(clientId.trim());
      setStatus(s);
      setMsg({ kind: "ok", text: `授权成功：${s.display}` });
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const signout = async () => {
    const ok = await confirmDialog({
      title: "注销 Dropbox 授权？",
      message: "token 将从系统钥匙串中清除。",
      confirmLabel: "注销",
      danger: true,
    });
    if (!ok) return;
    setBusy("signout");
    try {
      await api.dropboxSignout();
      setStatus({ connected: false, display: "", accountId: "", expiresInSecs: 0 });
      setEntries(null);
      setMsg({ kind: "ok", text: "已注销" });
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const list = async () => {
    setBusy("list");
    setMsg(null);
    try {
      const r = await api.dropboxList(listPath || "");
      setEntries(r.entries);
      if (r.entries.length === 0) setMsg({ kind: "ok", text: "目录为空" });
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
      setEntries(null);
    } finally {
      setBusy(null);
    }
  };

  const del = async (path: string) => {
    const ok = await confirmDialog({
      title: "从 Dropbox 删除？",
      message: `${path} 将被删除，此操作不可撤销。`,
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    setBusy("delete");
    try {
      await api.dropboxDelete(path);
      setEntries((cur) => cur?.filter((e) => e.pathLower !== path.toLowerCase()) ?? null);
      setMsg({ kind: "ok", text: `已删除 ${path}` });
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const upload = async () => {
    if (!uploadPath.trim() || !uploadPath.startsWith("/")) {
      setMsg({ kind: "err", text: "上传路径需以 / 开头，例如 /markio/test.md" });
      return;
    }
    const picked = await api.pickFileBase64();
    if (!picked) return;
    setBusy("upload");
    setMsg(null);
    try {
      await api.dropboxUpload(uploadPath.trim(), picked.bodyBase64);
      setMsg({ kind: "ok", text: `已上传 ${picked.path} → ${uploadPath}` });
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const connected = status?.connected;

  return (
    <div
      className="settings-drawer"
      style={{
        margin: "8px 0 12px",
        padding: 12,
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--surface-2)",
        display: "grid",
        gap: 8,
      }}
    >
      <div className="settings-help">
        {hasBuiltin ? (
          "已内置官方 App key，直接点「授权」用你自己的 Dropbox 账号登录即可；如需用自己注册的 App，可在下方填入 App key。"
        ) : (
          <>
            在{" "}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                void openExternal("https://www.dropbox.com/developers/apps");
              }}
            >
              Dropbox 开发者后台
            </a>{" "}
            注册一个 App（Scoped access, App folder 或 Full Dropbox），勾选
            files.content.write / files.content.read 权限，把 App key 填到下方。
          </>
        )}
      </div>
      {!hasBuiltin && (
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">App key (Client ID)</div>
          </div>
          <input
            type="text"
            value={clientId}
            onChange={(e) => setPreference("dropboxClientId", e.target.value)}
            placeholder="abc123xyz456"
            style={{ flex: 1, minWidth: 280 }}
          />
        </div>
      )}
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">连接状态</div>
          <div className="settings-help">
            {connected
              ? `已连接 · ${status?.display} · 还有 ${Math.max(0, status?.expiresInSecs ?? 0)} 秒过期`
              : "未连接"}
          </div>
        </div>
        {connected ? (
          <button
            className="settings-btn"
            type="button"
            disabled={busy !== null}
            onClick={signout}
          >
            注销
          </button>
        ) : (
          <button
            className="settings-btn primary"
            type="button"
            disabled={busy !== null || (!clientId.trim() && !hasBuiltin)}
            onClick={authorize}
          >
            {busy === "auth" ? "授权中…浏览器已打开" : "授权"}
          </button>
        )}
      </div>
      {connected && (
        <>
          <div className="settings-row">
            <div className="settings-row-l">
              <div className="settings-label">同步根目录</div>
              <div className="settings-help">自动同步会读写这个 Dropbox 目录</div>
            </div>
            <input
              type="text"
              value={syncCfg.folder || "/markio"}
              onChange={(e) => updateSyncCfg({ folder: e.target.value })}
              placeholder="/markio"
              style={{ flex: 1, minWidth: 280 }}
            />
          </div>
          <LocalSubpathRow driveId="drop" />
          <div className="settings-row">
            <div className="settings-row-l">
              <div className="settings-label">启用 Dropbox 同步</div>
              <div className="settings-help">状态栏“立刻同步”和自动同步会使用此目标</div>
            </div>
            <Toggle
              on={syncCfg.enabled && !!connected}
              onChange={setSyncEnabled}
            />
          </div>
          <div className="settings-row">
            <div className="settings-row-l">
              <div className="settings-label">浏览路径</div>
              <div className="settings-help">空字符串=根目录</div>
            </div>
            <input
              type="text"
              value={listPath}
              onChange={(e) => setListPath(e.target.value)}
              placeholder="/markio"
              style={{ flex: 1, minWidth: 280 }}
            />
            <button
              className="settings-btn"
              type="button"
              disabled={busy !== null}
              onClick={list}
            >
              {busy === "list" ? "…" : "列目录"}
            </button>
          </div>
          {entries && entries.length > 0 && (
            <div
              className="settings-help"
              style={{
                padding: 8,
                border: "1px solid var(--border)",
                borderRadius: 6,
                background: "var(--bg-pane)",
                maxHeight: 240,
                overflow: "auto",
              }}
            >
              <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none" }}>
                {entries.map((e) => (
                  <li
                    key={e.pathLower || e.name}
                    style={{
                      display: "flex",
                      gap: 8,
                      alignItems: "center",
                      padding: "2px 0",
                      borderBottom: "1px dashed var(--border)",
                    }}
                  >
                    <span style={{ color: "var(--text-3)", fontSize: 11 }}>
                      [{e.tag}]
                    </span>
                    <span style={{ flex: 1, wordBreak: "break-all" }}>
                      {e.pathDisplay || e.name}
                    </span>
                    {e.tag === "file" && (
                      <span style={{ color: "var(--text-3)", fontSize: 12 }}>
                        {formatBytes(e.size)}
                      </span>
                    )}
                    <button
                      className="settings-btn"
                      type="button"
                      disabled={busy !== null}
                      onClick={() => del(e.pathDisplay || e.pathLower || `/${e.name}`)}
                      style={{ padding: "2px 8px" }}
                    >
                      删除
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="settings-row">
            <div className="settings-row-l">
              <div className="settings-label">上传文本文件</div>
              <div className="settings-help">
                选一个本地文件，按下方路径上传到 Dropbox
              </div>
            </div>
            <input
              type="text"
              value={uploadPath}
              onChange={(e) => setUploadPath(e.target.value)}
              placeholder="/markio/test.md"
              style={{ flex: 1, minWidth: 240 }}
            />
            <button
              className="settings-btn"
              type="button"
              disabled={busy !== null}
              onClick={upload}
            >
              {busy === "upload" ? "…" : "选文件上传"}
            </button>
          </div>
        </>
      )}
      {msg && (
        <div
          className="settings-message"
          style={{ color: msg.kind === "err" ? "#dc2626" : "var(--accent)" }}
        >
          {msg.text}
        </div>
      )}
    </div>
  );
}

function GDriveDriveDrawer() {
  const clientId = useSettings((s) => s.gdriveClientId);
  const hasBuiltin = useBuiltinOauth().has("gdrive");
  const driveConfigs = useSettings((s) => s.driveConfigs);
  const setPreference = useSettings((s) => s.setPreference);
  const syncCfg: DriveConfig = driveConfigs.drive ?? { folder: "root", enabled: false };
  const [status, setStatus] = useState<{
    connected: boolean;
    display: string;
    expiresInSecs: number;
  } | null>(null);
  const [busy, setBusy] = useState<
    "auth" | "list" | "delete" | "upload" | "signout" | null
  >(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [listQ, setListQ] = useState("");
  const [files, setFiles] = useState<
    Array<{
      id: string;
      name: string;
      mimeType: string;
      size: number;
      modifiedTime: string;
    }>
    | null
  >(null);
  const confirmDialog = useDialog((s) => s.confirm);

  const updateSyncCfg = (patch: Partial<DriveConfig>) => {
    setPreference("driveConfigs", {
      ...driveConfigs,
      drive: { ...syncCfg, folder: syncCfg.folder || "root", ...patch },
    });
  };

  const setSyncEnabled = (enabled: boolean) => {
    if (enabled && !status?.connected) {
      setMsg({ kind: "err", text: "启用同步前请先完成 Google Drive 授权" });
      return;
    }
    updateSyncCfg({ enabled });
  };

  useEffect(() => {
    api.gdriveStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  const authorize = async () => {
    if (!clientId.trim() && !hasBuiltin) {
      setMsg({ kind: "err", text: "请先填写 Google OAuth Client ID" });
      return;
    }
    setBusy("auth");
    setMsg(null);
    try {
      const s = await api.gdriveAuthorize(clientId.trim());
      setStatus(s);
      setMsg({ kind: "ok", text: `授权成功：${s.display}` });
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const signout = async () => {
    const ok = await confirmDialog({
      title: "注销 Google Drive 授权？",
      message: "token 将从系统钥匙串中清除。",
      confirmLabel: "注销",
      danger: true,
    });
    if (!ok) return;
    setBusy("signout");
    try {
      await api.gdriveSignout();
      setStatus({ connected: false, display: "", expiresInSecs: 0 });
      setFiles(null);
      setMsg({ kind: "ok", text: "已注销" });
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const list = async () => {
    setBusy("list");
    setMsg(null);
    try {
      const r = await api.gdriveList(listQ.trim());
      setFiles(r.files);
      if (r.files.length === 0) setMsg({ kind: "ok", text: "无匹配文件" });
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
      setFiles(null);
    } finally {
      setBusy(null);
    }
  };

  const del = async (file: { id: string; name: string }) => {
    const ok = await confirmDialog({
      title: "从 Google Drive 删除？",
      message: `${file.name} 将被删除，此操作不可撤销。`,
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    setBusy("delete");
    try {
      await api.gdriveDelete(file.id);
      setFiles((cur) => cur?.filter((f) => f.id !== file.id) ?? null);
      setMsg({ kind: "ok", text: `已删除 ${file.name}` });
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const upload = async () => {
    const picked = await api.pickFileBase64();
    if (!picked) return;
    setBusy("upload");
    setMsg(null);
    try {
      const name = picked.name || fileNameFromPath(picked.path);
      const id = await api.gdriveUpload(
        name,
        null,
        null,
        picked.bodyBase64,
        contentTypeFromPath(picked.path),
      );
      setMsg({ kind: "ok", text: `已上传 ${name} (id=${id})` });
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const connected = status?.connected;

  return (
    <div
      className="settings-drawer"
      style={{
        margin: "8px 0 12px",
        padding: 12,
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--surface-2)",
        display: "grid",
        gap: 8,
      }}
    >
      <div className="settings-help">
        {hasBuiltin ? (
          "已内置官方 OAuth client，直接点「授权」用你自己的 Google 账号登录即可（markio 仅申请 drive.file，只能访问自己创建/打开的文件）；如需用自己的 client，可在下方填入。"
        ) : (
          <>
            在{" "}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                void openExternal("https://console.cloud.google.com/apis/credentials");
              }}
            >
              Google Cloud Console
            </a>{" "}
            创建一个 OAuth Client ID（Application type: Desktop app），并开启
            Google Drive API。把 Client ID 填到下方；首次授权会要求你同意
            drive.file scope（markio 只能访问自己创建/打开的文件）。
          </>
        )}
      </div>
      {!hasBuiltin && (
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">OAuth Client ID</div>
          </div>
          <input
            type="text"
            value={clientId}
            onChange={(e) => setPreference("gdriveClientId", e.target.value)}
            placeholder="123-abc.apps.googleusercontent.com"
            style={{ flex: 1, minWidth: 320 }}
          />
        </div>
      )}
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">连接状态</div>
          <div className="settings-help">
            {connected
              ? `已连接 · ${status?.display} · 还有 ${Math.max(0, status?.expiresInSecs ?? 0)} 秒过期`
              : "未连接"}
          </div>
        </div>
        {connected ? (
          <button
            className="settings-btn"
            type="button"
            disabled={busy !== null}
            onClick={signout}
          >
            注销
          </button>
        ) : (
          <button
            className="settings-btn primary"
            type="button"
            disabled={busy !== null || (!clientId.trim() && !hasBuiltin)}
            onClick={authorize}
          >
            {busy === "auth" ? "授权中…浏览器已打开" : "授权"}
          </button>
        )}
      </div>
      {connected && (
        <>
          <div className="settings-row">
            <div className="settings-row-l">
              <div className="settings-label">同步根文件夹 ID</div>
              <div className="settings-help">
                root 表示 Drive 根目录；也可以填一个 markio 文件夹的 ID
              </div>
            </div>
            <input
              type="text"
              value={syncCfg.folder || "root"}
              onChange={(e) => updateSyncCfg({ folder: e.target.value })}
              placeholder="root"
              style={{ flex: 1, minWidth: 280 }}
            />
          </div>
          <LocalSubpathRow driveId="drive" />
          <div className="settings-row">
            <div className="settings-row-l">
              <div className="settings-label">启用 Google Drive 同步</div>
              <div className="settings-help">状态栏“立刻同步”和自动同步会使用此目标</div>
            </div>
            <Toggle
              on={syncCfg.enabled && !!connected}
              onChange={setSyncEnabled}
            />
          </div>
          <div className="settings-row">
            <div className="settings-row-l">
              <div className="settings-label">查询表达式 q</div>
              <div className="settings-help">
                Drive v3 q 语法，空=按 modifiedTime 列出所有可访问文件。例如
                {` "name contains 'md'"`}
              </div>
            </div>
            <input
              type="text"
              value={listQ}
              onChange={(e) => setListQ(e.target.value)}
              placeholder="mimeType='text/markdown'"
              style={{ flex: 1, minWidth: 280 }}
            />
            <button
              className="settings-btn"
              type="button"
              disabled={busy !== null}
              onClick={list}
            >
              {busy === "list" ? "…" : "列文件"}
            </button>
          </div>
          {files && files.length > 0 && (
            <div
              className="settings-help"
              style={{
                padding: 8,
                border: "1px solid var(--border)",
                borderRadius: 6,
                background: "var(--bg-pane)",
                maxHeight: 240,
                overflow: "auto",
              }}
            >
              <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none" }}>
                {files.map((f) => (
                  <li
                    key={f.id}
                    style={{
                      display: "flex",
                      gap: 8,
                      alignItems: "center",
                      padding: "2px 0",
                      borderBottom: "1px dashed var(--border)",
                    }}
                  >
                    <span style={{ flex: 1, wordBreak: "break-all" }}>{f.name}</span>
                    <span style={{ color: "var(--text-3)", fontSize: 11 }}>
                      {f.mimeType}
                    </span>
                    <span style={{ color: "var(--text-3)", fontSize: 12 }}>
                      {formatBytes(f.size)}
                    </span>
                    <button
                      className="settings-btn"
                      type="button"
                      disabled={busy !== null}
                      onClick={() => del(f)}
                      style={{ padding: "2px 8px" }}
                    >
                      删除
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="settings-row">
            <div className="settings-row-l">
              <div className="settings-label">上传文本文件</div>
              <div className="settings-help">选一个本地文件，新建到 Drive 根目录</div>
            </div>
            <button
              className="settings-btn"
              type="button"
              disabled={busy !== null}
              onClick={upload}
            >
              {busy === "upload" ? "…" : "选文件上传"}
            </button>
          </div>
        </>
      )}
      {msg && (
        <div
          className="settings-message"
          style={{ color: msg.kind === "err" ? "#dc2626" : "var(--accent)" }}
        >
          {msg.text}
        </div>
      )}
    </div>
  );
}

function OneDriveDriveDrawer() {
  const driveConfigs = useSettings((s) => s.driveConfigs);
  const setPreference = useSettings((s) => s.setPreference);
  const hasBuiltin = useBuiltinOauth().has("onedrive");
  const syncCfg: DriveConfig = driveConfigs.onedrive ?? { folder: "markio", enabled: false };
  const [status, setStatus] = useState<{
    connected: boolean;
    display: string;
    expiresInSecs: number;
  } | null>(null);
  const [busy, setBusy] = useState<
    "auth" | "list" | "delete" | "upload" | "signout" | null
  >(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [listPath, setListPath] = useState("");
  const [entries, setEntries] = useState<
    Array<{ tag: string; name: string; path: string; size: number; lastModified: string }>
    | null
  >(null);
  const [uploadPath, setUploadPath] = useState("");
  const confirmDialog = useDialog((s) => s.confirm);

  const updateSyncCfg = (patch: Partial<DriveConfig>) => {
    setPreference("driveConfigs", {
      ...driveConfigs,
      onedrive: { ...syncCfg, folder: syncCfg.folder || "markio", ...patch },
    });
  };

  const setSyncEnabled = (enabled: boolean) => {
    if (enabled && !status?.connected) {
      setMsg({ kind: "err", text: "启用同步前请先完成 OneDrive 授权" });
      return;
    }
    updateSyncCfg({ enabled });
  };

  useEffect(() => {
    api.onedriveStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  const authorize = async () => {
    if (!hasBuiltin) {
      setMsg({ kind: "err", text: "本版本未内置 OneDrive client_id，请改用 WebDAV 或其它已配置网盘" });
      return;
    }
    setBusy("auth");
    setMsg(null);
    try {
      const s = await api.onedriveAuthorize("");
      setStatus(s);
      setMsg({ kind: "ok", text: `授权成功：${s.display}` });
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const signout = async () => {
    const ok = await confirmDialog({
      title: "注销 OneDrive 授权？",
      message: "token 将从系统钥匙串中清除。",
      confirmLabel: "注销",
      danger: true,
    });
    if (!ok) return;
    setBusy("signout");
    try {
      await api.onedriveSignout();
      setStatus({ connected: false, display: "", expiresInSecs: 0 });
      setEntries(null);
      setMsg({ kind: "ok", text: "已注销" });
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const list = async () => {
    setBusy("list");
    setMsg(null);
    try {
      const r = await api.onedriveList(listPath.trim());
      setEntries(r.entries);
      if (r.entries.length === 0) setMsg({ kind: "ok", text: "目录为空" });
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
      setEntries(null);
    } finally {
      setBusy(null);
    }
  };

  const del = async (path: string) => {
    const ok = await confirmDialog({
      title: "从 OneDrive 删除？",
      message: `${path} 将被删除，此操作不可撤销。`,
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    setBusy("delete");
    try {
      await api.onedriveDelete(path);
      setEntries((cur) => cur?.filter((e) => e.path !== path) ?? null);
      setMsg({ kind: "ok", text: `已删除 ${path}` });
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const upload = async () => {
    if (!uploadPath.trim()) {
      setMsg({ kind: "err", text: "上传路径不能为空，例如 markio/test.md" });
      return;
    }
    const picked = await api.pickFileBase64();
    if (!picked) return;
    setBusy("upload");
    setMsg(null);
    try {
      await api.onedriveUpload(uploadPath.trim(), picked.bodyBase64);
      setMsg({ kind: "ok", text: `已上传 ${picked.path} → ${uploadPath}` });
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const connected = status?.connected;

  return (
    <div
      className="settings-drawer"
      style={{
        margin: "8px 0 12px",
        padding: 12,
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--surface-2)",
        display: "grid",
        gap: 8,
      }}
    >
      <div className="settings-help">
        {hasBuiltin
          ? "已内置官方 OneDrive client，直接点「授权」用你自己的微软账号登录即可（支持个人 / 工作学校账号，markio 仅申请 Files.ReadWrite）。"
          : "本版本未内置 OneDrive client_id。OneDrive 需要在编译期注入官方 client_id 才能一键登录；当前请改用 WebDAV / S3 等已配置的网盘。"}
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">连接状态</div>
          <div className="settings-help">
            {connected
              ? `已连接 · ${status?.display} · 还有 ${Math.max(0, status?.expiresInSecs ?? 0)} 秒过期`
              : "未连接"}
          </div>
        </div>
        {connected ? (
          <button
            className="settings-btn"
            type="button"
            disabled={busy !== null}
            onClick={signout}
          >
            注销
          </button>
        ) : (
          <button
            className="settings-btn primary"
            type="button"
            disabled={busy !== null || !hasBuiltin}
            onClick={authorize}
          >
            {busy === "auth" ? "授权中…浏览器已打开" : "授权"}
          </button>
        )}
      </div>
      {connected && (
        <>
          <div className="settings-row">
            <div className="settings-row-l">
              <div className="settings-label">同步根目录</div>
              <div className="settings-help">drive 根下的相对路径，自动同步会读写这个目录</div>
            </div>
            <input
              type="text"
              value={syncCfg.folder || "markio"}
              onChange={(e) => updateSyncCfg({ folder: e.target.value })}
              placeholder="markio"
              style={{ flex: 1, minWidth: 280 }}
            />
          </div>
          <LocalSubpathRow driveId="onedrive" />
          <div className="settings-row">
            <div className="settings-row-l">
              <div className="settings-label">启用 OneDrive 同步</div>
              <div className="settings-help">状态栏“立刻同步”和自动同步会使用此目标</div>
            </div>
            <Toggle on={syncCfg.enabled && !!connected} onChange={setSyncEnabled} />
          </div>
          <div className="settings-row">
            <div className="settings-row-l">
              <div className="settings-label">浏览路径</div>
              <div className="settings-help">空=drive 根目录</div>
            </div>
            <input
              type="text"
              value={listPath}
              onChange={(e) => setListPath(e.target.value)}
              placeholder="markio"
              style={{ flex: 1, minWidth: 280 }}
            />
            <button
              className="settings-btn"
              type="button"
              disabled={busy !== null}
              onClick={list}
            >
              {busy === "list" ? "…" : "列目录"}
            </button>
          </div>
          {entries && entries.length > 0 && (
            <div
              className="settings-help"
              style={{
                padding: 8,
                border: "1px solid var(--border)",
                borderRadius: 6,
                background: "var(--bg-pane)",
                maxHeight: 240,
                overflow: "auto",
              }}
            >
              <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none" }}>
                {entries.map((e) => (
                  <li
                    key={e.path || e.name}
                    style={{
                      display: "flex",
                      gap: 8,
                      alignItems: "center",
                      padding: "2px 0",
                      borderBottom: "1px dashed var(--border)",
                    }}
                  >
                    <span style={{ color: "var(--text-3)", fontSize: 11 }}>[{e.tag}]</span>
                    <span style={{ flex: 1, wordBreak: "break-all" }}>{e.path || e.name}</span>
                    {e.tag === "file" && (
                      <span style={{ color: "var(--text-3)", fontSize: 12 }}>
                        {formatBytes(e.size)}
                      </span>
                    )}
                    <button
                      className="settings-btn"
                      type="button"
                      disabled={busy !== null}
                      onClick={() => del(e.path)}
                      style={{ padding: "2px 8px" }}
                    >
                      删除
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="settings-row">
            <div className="settings-row-l">
              <div className="settings-label">上传文本文件</div>
              <div className="settings-help">选一个本地文件，按下方路径上传到 OneDrive</div>
            </div>
            <input
              type="text"
              value={uploadPath}
              onChange={(e) => setUploadPath(e.target.value)}
              placeholder="markio/test.md"
              style={{ flex: 1, minWidth: 240 }}
            />
            <button
              className="settings-btn"
              type="button"
              disabled={busy !== null}
              onClick={upload}
            >
              {busy === "upload" ? "…" : "选文件上传"}
            </button>
          </div>
        </>
      )}
      {msg && (
        <div
          className="settings-message"
          style={{ color: msg.kind === "err" ? "#dc2626" : "var(--accent)" }}
        >
          {msg.text}
        </div>
      )}
    </div>
  );
}

function SynologyDriveDrawer() {
  const baseUrl = useSettings((s) => s.synologyBaseUrl);
  const username = useSettings((s) => s.synologyUsername);
  const insecureTls = useSettings((s) => s.synologyInsecureTls);
  const driveConfigs = useSettings((s) => s.driveConfigs);
  const setPreference = useSettings((s) => s.setPreference);
  const syncCfg: DriveConfig = driveConfigs.synology ?? { folder: "/markio", enabled: false };
  const [password, setPassword] = useState("");
  const [hasStoredPassword, setHasStoredPassword] = useState(false);
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [connected, setConnected] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const updateSyncCfg = (patch: Partial<DriveConfig>) => {
    setPreference("driveConfigs", {
      ...driveConfigs,
      synology: { ...syncCfg, folder: syncCfg.folder || "/markio", ...patch },
    });
  };

  const setSyncEnabled = (enabled: boolean) => {
    if (enabled && (!baseUrl.trim() || !username.trim() || !hasStoredPassword)) {
      setMsg({ kind: "err", text: "启用同步前请先填写地址 / 账号并保存密码" });
      return;
    }
    updateSyncCfg({ enabled });
  };

  useEffect(() => {
    if (!baseUrl.trim()) {
      setHasStoredPassword(false);
      return;
    }
    api
      .synologyHasPassword(baseUrl.trim())
      .then(setHasStoredPassword)
      .catch(() => setHasStoredPassword(false));
  }, [baseUrl]);

  const savePassword = async () => {
    if (!baseUrl.trim()) {
      setMsg({ kind: "err", text: "请先填写 NAS 地址" });
      return;
    }
    if (!password) {
      setMsg({ kind: "err", text: "密码为空" });
      return;
    }
    setBusy("save");
    setMsg(null);
    try {
      await api.synologySetPassword(baseUrl.trim(), password);
      setPassword("");
      setHasStoredPassword(true);
      setMsg({ kind: "ok", text: "密码已存入系统钥匙串" });
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    if (!baseUrl.trim() || !username.trim()) {
      setMsg({ kind: "err", text: "请填写 NAS 地址和账号" });
      return;
    }
    setBusy("test");
    setMsg(null);
    try {
      const r = await api.synologyLogin(
        baseUrl.trim(),
        insecureTls,
        username.trim(),
        otp.trim() || undefined,
      );
      setConnected(!!r.sid);
      setMsg({ kind: "ok", text: "登录成功，FileStation 可用" });
    } catch (e) {
      setConnected(false);
      setMsg({ kind: "err", text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="settings-drawer"
      style={{
        margin: "8px 0 12px",
        padding: 12,
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--surface-2)",
        display: "grid",
        gap: 8,
      }}
    >
      <div className="settings-help">
        填入群晖 NAS 的访问地址和账号即可（无需在开发者平台申请任何 key）。地址形如
        <code> https://nas.example.com:5001 </code>或局域网
        <code> http://192.168.1.50:5000 </code>。同步走 FileStation API；密码仅存系统钥匙串。
        若 NAS 是自签证书 https，请打开下方「忽略 TLS 证书」。
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">NAS 地址</div>
        </div>
        <input
          type="text"
          value={baseUrl}
          onChange={(e) => setPreference("synologyBaseUrl", e.target.value)}
          placeholder="https://nas.example.com:5001"
          style={{ flex: 1, minWidth: 280 }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">账号</div>
        </div>
        <input
          type="text"
          value={username}
          onChange={(e) => setPreference("synologyUsername", e.target.value)}
          placeholder="admin"
          style={{ flex: 1, minWidth: 280 }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">密码</div>
          <div className="settings-help">{hasStoredPassword ? "已存入系统钥匙串" : "尚未保存"}</div>
        </div>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={hasStoredPassword ? "•••••• (留空保持现有)" : "密码"}
          style={{ flex: 1, minWidth: 220 }}
        />
        <button className="settings-btn" type="button" disabled={busy !== null} onClick={savePassword}>
          {busy === "save" ? "…" : "保存密码"}
        </button>
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">二步验证 OTP</div>
          <div className="settings-help">仅开启 2FA 的账号需要；自动同步建议用免 2FA 账号</div>
        </div>
        <input
          type="text"
          value={otp}
          onChange={(e) => setOtp(e.target.value)}
          placeholder="6 位数字（可留空）"
          style={{ width: 160 }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">忽略 TLS 证书</div>
          <div className="settings-help">NAS 自签证书 https 时打开</div>
        </div>
        <Toggle on={insecureTls} onChange={(v) => setPreference("synologyInsecureTls", v)} />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">同步根目录</div>
          <div className="settings-help">NAS 绝对路径，例如 /markio 或 /home/markio</div>
        </div>
        <input
          type="text"
          value={syncCfg.folder || "/markio"}
          onChange={(e) => updateSyncCfg({ folder: e.target.value })}
          placeholder="/markio"
          style={{ flex: 1, minWidth: 280 }}
        />
      </div>
      <LocalSubpathRow driveId="synology" />
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">启用 Synology 同步</div>
          <div className="settings-help">状态栏“立刻同步”和自动同步会使用此目标</div>
        </div>
        <Toggle
          on={syncCfg.enabled && !!baseUrl.trim() && !!username.trim() && hasStoredPassword}
          onChange={setSyncEnabled}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">连接状态</div>
          <div className="settings-help">{connected ? "已验证登录" : "未验证"}</div>
        </div>
        <button
          className="settings-btn primary"
          type="button"
          disabled={busy !== null}
          onClick={test}
        >
          {busy === "test" ? "登录中…" : "测试连接"}
        </button>
      </div>
      {msg && (
        <div
          className="settings-message"
          style={{ color: msg.kind === "err" ? "#dc2626" : "var(--accent)" }}
        >
          {msg.text}
        </div>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
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
        const files = text.split("CONFLICT:")[1]!.split("\n").filter(Boolean);
        setConflict(files);
        setMessage({ kind: "err", text: `${label} 冲突，需要解决 ${files.length} 个文件` });
      } else {
        setMessage({ kind: "err", text });
      }
    } finally {
      setBusy(null);
    }
  };

  const refreshBranches = useCallback(async () => {
    if (!workspacePath) return;
    try {
      const b = await api.gitListBranches(workspacePath);
      setBranches(b);
    } catch {
      setBranches(null);
    }
  }, [workspacePath]);

  useEffect(() => {
    void refreshBranches();
  }, [refreshBranches]);

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

  // 统一状态行：dot 反映 head/working tree 状态；off=未检测，ok=clean+无 ahead/behind，warn=有变动或与远端不同步
  const gitStatusDot: "ok" | "warn" | "off" = !status
    ? "off"
    : status.files.length > 0 || status.ahead > 0 || status.behind > 0
      ? "warn"
      : "ok";
  const gitSummary = !status
    ? "尚未检测 · 点右侧「刷新」获取本地仓库状态"
    : `${status.branch ?? "(detached)"} · ↑${status.ahead} ↓${status.behind} · ${status.files.length} 个改动`;

  return (
    <div className="settings-card">
      <CardTitle tip="支持 clone、init、status、fetch、commit、pull、push、分支切换和冲突处理；PAT 仅保存在系统钥匙串。">
        Git 同步
      </CardTitle>

      <div className="sync-card-status">
        <span className={`upload-dot upload-dot-${gitStatusDot}`} aria-hidden />
        <div className="summary">
          {!status ? (
            gitSummary
          ) : (
            <>
              <span className="strong">{status.branch ?? "(detached)"}</span>
              <span className="dim"> · </span>
              <span>↑{status.ahead} ↓{status.behind}</span>
              <span className="dim"> · </span>
              <span>{status.files.length} 个改动</span>
            </>
          )}
        </div>
        <button
          className="settings-btn"
          type="button"
          onClick={refreshStatus}
          disabled={!workspacePath || busy === "status"}
        >
          {busy === "status" ? "检测中…" : "刷新"}
        </button>
      </div>

      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">当前工作仓库</div>
          <div className="settings-help">{workspacePath ? displayPath(workspacePath) : "未选择"}</div>
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
        {branches && branches.local.length > 0 ? (
          <SelectBtn
            value={branches.current ?? ""}
            options={branches.local.map((b) => ({ value: b, label: b }))}
            onChange={(v) => {
              if (busy !== null) return;
              wrap("checkout", () => api.gitCheckout(workspacePath, v));
            }}
            minMenuWidth={220}
          />
        ) : null}
        <button
          className="settings-btn"
          disabled={!workspacePath}
          onClick={refreshBranches}
        >
          刷新分支
        </button>
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <LabelWithTip tip="开启后本地分支落后远端时，pull 会以 rebase 方式整理你的本地提交。">
            pull 策略
          </LabelWithTip>
          <div className="settings-help">
            {pullRebase ? "rebase（线性历史）" : "merge（默认 · 生成合并提交）"}
          </div>
        </div>
        <Toggle on={pullRebase} onChange={setPullRebase} />
      </div>

      {conflict && conflict.length > 0 && (
        <div className="sync-conflict">
          <div className="sync-conflict-h">
            合并冲突 · 需要解决 {conflict.length} 个文件
          </div>
          <ul className="sync-conflict-list">
            {conflict.slice(0, 20).map((f) => (
              <li key={f}>{f}</li>
            ))}
            {conflict.length > 20 && (
              <li style={{ color: "var(--text-3)" }}>
                … 还有 {conflict.length - 20} 个
              </li>
            )}
          </ul>
          <div className="sync-conflict-actions">
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
