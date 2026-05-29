import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import {
  UpdateDialog,
  ChangelogDialog,
  FeedbackDialog,
  LicenseDialog,
  PrivacyDialog,
  OssDialog,
} from "../../popovers/AboutDialogs";
import { Toggle } from "../../ui/controls";
import { useSettings } from "@/stores/settings";
import { useUI } from "@/stores/ui";
import { isDarkTheme } from "@/themes";
import { api } from "@/lib/api";
import { SectionHeader } from "../_shared";

export function About() {
  const { t } = useTranslation();
  const [version, setVersion] = useState<string>("");
  const autoCheck = useSettings((s) => s.autoCheckUpdates);
  const setPreference = useSettings((s) => s.setPreference);
  const theme = useSettings((s) => s.theme);
  const brandIcon = isDarkTheme(theme)
    ? "/brand/icon-dark-512.png"
    : "/brand/icon-light-512.png";
  const [openDialog, setOpenDialog] = useState<
    null | "update" | "changelog" | "feedback" | "license" | "privacy" | "oss"
  >(null);

  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion("?"));
  }, []);

  const setToast = useUI((s) => s.setToast);
  const flashToast = (stage: "done" | "error", message: string) => {
    setToast({ stage, message });
    window.setTimeout(() => setToast(null), 2400);
  };

  // 4 张底部链接卡：用户协议 / 隐私 / 开源许可 / 数据导出。
  // 前三张走内置 modal（离线可看 + 不依赖外链有效性）；数据导出仍调用本机打开崩溃目录。
  const footerCards: Array<{
    t: string;
    s: string;
    onClick: () => void;
  }> = [
    {
      t: "用户协议",
      s: "使用条款 · 开源 MIT",
      onClick: () => setOpenDialog("license"),
    },
    {
      t: "隐私",
      s: "本地优先 · 不上报数据",
      onClick: () => setOpenDialog("privacy"),
    },
    {
      t: "开源许可",
      s: "查看主要依赖与三方协议",
      onClick: () => setOpenDialog("oss"),
    },
    {
      t: "数据导出",
      s: "打开崩溃日志目录",
      onClick: async () => {
        try {
          await api.crashOpenDir();
          flashToast("done", "已在文件管理器中打开日志目录");
        } catch (e) {
          flashToast("error", `打开失败：${(e as Error).message}`);
        }
      },
    },
  ];

  return (
    <>
      <SectionHeader id="about" />
      <div className="about-hero">
        <div className="about-mark" aria-hidden>
          <img src={brandIcon} alt="" draggable={false} />
        </div>
        <div>
          <div className="about-hero-name">markio</div>
          <div className="about-hero-ver">
            v{version || "0.1.0"}
          </div>
          <div className="about-hero-tag">{t("settings.about.tagline")}</div>
          <div className="about-hero-actions">
            <button
              className="settings-btn primary"
              onClick={() => setOpenDialog("update")}
            >
              {t("settings.about.checkUpdate")}
            </button>
            <button className="settings-btn" onClick={() => setOpenDialog("changelog")}>
              {t("settings.about.releaseNotes")}
            </button>
            <button
              className="settings-btn"
              onClick={() => void api.crashOpenDir().catch(() => undefined)}
              title={t("settings.about.crashLogTitle")}
            >
              {t("settings.about.crashLog")}
            </button>
            <button className="settings-btn" onClick={() => setOpenDialog("feedback")}>
              {t("settings.about.feedback")}
            </button>
          </div>
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card-h">{t("settings.about.updatesCard")}</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">{t("settings.about.autoCheckLabel")}</div>
            <div className="settings-help">{t("settings.about.autoCheckHelp")}</div>
          </div>
          <Toggle
            on={autoCheck}
            onChange={(v) => setPreference("autoCheckUpdates", v)}
          />
        </div>
      </div>
      <CrashWebhookCard />

      <div className="about-foot-grid">
        {footerCards.map((c) => (
          <button type="button" key={c.t} className="about-foot-card" onClick={c.onClick}>
            <div className="t">{c.t}</div>
            <div className="s">{c.s}</div>
          </button>
        ))}
      </div>

      <div className="about-thanks">
        感谢 React / CodeMirror 6 / Tauri / pulldown-cmark / lezer 等开源项目，以及所有提交 issue / PR 的伙伴。
      </div>

      {openDialog === "update" && (
        <UpdateDialog onClose={() => setOpenDialog(null)} />
      )}
      {openDialog === "changelog" && (
        <ChangelogDialog
          currentVersion={version}
          onClose={() => setOpenDialog(null)}
        />
      )}
      {openDialog === "feedback" && (
        <FeedbackDialog
          appVersion={version}
          onClose={() => setOpenDialog(null)}
        />
      )}
      {openDialog === "license" && (
        <LicenseDialog onClose={() => setOpenDialog(null)} />
      )}
      {openDialog === "privacy" && (
        <PrivacyDialog onClose={() => setOpenDialog(null)} />
      )}
      {openDialog === "oss" && (
        <OssDialog onClose={() => setOpenDialog(null)} />
      )}
    </>
  );
}

function CrashWebhookCard() {
  const { t } = useTranslation();
  const url = useSettings((s) => s.crashWebhookUrl);
  const setPreference = useSettings((s) => s.setPreference);
  const [draft, setDraft] = useState(url);
  const [flushState, setFlushState] = useState<
    | { kind: "idle" }
    | { kind: "sending" }
    | { kind: "ok"; sent: boolean }
    | { kind: "fail"; message: string }
  >({ kind: "idle" });
  useEffect(() => setDraft(url), [url]);

  const sendNow = async () => {
    setFlushState({ kind: "sending" });
    try {
      const sent = await api.crashFlushToWebhook(draft);
      setFlushState({ kind: "ok", sent });
    } catch (e) {
      setFlushState({ kind: "fail", message: String(e) });
    }
  };

  return (
    <div className="settings-card">
      <div className="settings-card-h">{t("settings.about.crashWebhookCard")}</div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">{t("settings.about.crashWebhookLabel")}</div>
          <div className="settings-help">{t("settings.about.crashWebhookHelp")}</div>
        </div>
        <input
          type="url"
          placeholder="https://example.com/markio-crash"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            const trimmed = draft.trim();
            if (trimmed !== url) setPreference("crashWebhookUrl", trimmed);
          }}
          style={{ flex: 1, minWidth: 260 }}
        />
      </div>
      <div className="settings-row" style={{ justifyContent: "flex-end", gap: 8 }}>
        <span className="settings-help">
          {flushState.kind === "sending"
            ? t("settings.about.crashWebhookSending")
            : flushState.kind === "ok"
              ? flushState.sent
                ? t("settings.about.crashWebhookOk")
                : t("settings.about.crashWebhookEmpty")
              : flushState.kind === "fail"
                ? flushState.message
                : ""}
        </span>
        <button
          className="settings-btn"
          onClick={sendNow}
          disabled={!draft.trim() || flushState.kind === "sending"}
        >
          {t("settings.about.crashWebhookTest")}
        </button>
      </div>
    </div>
  );
}
