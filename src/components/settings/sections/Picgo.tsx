import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Slider, Toggle, SelectBtn } from "../../ui/controls";
import { useSettings } from "@/stores/settings";
import { api } from "@/lib/api";
import {
  LabelWithTip,
  PICGO_ENDPOINT_OPTIONS,
  SectionHeader,
} from "../_shared";
import { S3Card } from "./AI";

export type PicgoPingState =
  | { stage: "idle" }
  | { stage: "probing" }
  | { stage: "ok"; latencyMs: number }
  | { stage: "fail"; message: string };

export function Picgo() {
  const { t } = useTranslation();
  const endpoint = useSettings((s) => s.picgoEndpoint);
  const pasteUpload = useSettings((s) => s.picgoPasteUpload);
  const dragUpload = useSettings((s) => s.picgoDragUpload);
  const keepLocalCopy = useSettings((s) => s.picgoKeepLocalCopy);
  const compressBeforeUpload = useSettings((s) => s.picgoCompressBeforeUpload);
  const quality = useSettings((s) => s.picgoQuality);
  const uploadProvider = useSettings((s) => s.uploadProvider);
  const setPreference = useSettings((s) => s.setPreference);

  const [ping, setPing] = useState<PicgoPingState>({ stage: "idle" });
  const probe = useCallback(async (ep: string) => {
    setPing({ stage: "probing" });
    try {
      const r = await api.picgoPing(ep);
      if (r.ok) {
        setPing({ stage: "ok", latencyMs: r.latencyMs });
      } else {
        setPing({ stage: "fail", message: r.message ?? "服务无响应" });
      }
    } catch (e) {
      setPing({ stage: "fail", message: (e as Error).message });
    }
  }, []);
  useEffect(() => {
    if (!endpoint) return;
    let cancelled = false;
    void (async () => {
      setPing({ stage: "probing" });
      try {
        const r = await api.picgoPing(endpoint);
        if (cancelled) return;
        if (r.ok) {
          setPing({ stage: "ok", latencyMs: r.latencyMs });
        } else {
          setPing({ stage: "fail", message: r.message ?? "服务无响应" });
        }
      } catch (e) {
        if (cancelled) return;
        setPing({ stage: "fail", message: (e as Error).message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [endpoint]);

  const statusText = (() => {
    switch (ping.stage) {
      case "idle":
        return t("settings.picgo.statusIdle");
      case "probing":
        return t("settings.picgo.statusProbing");
      case "ok":
        return t("settings.picgo.statusOk", { ms: ping.latencyMs });
      case "fail":
        return t("settings.picgo.statusFail", { reason: ping.message });
    }
  })();
  // 三个 provider 的"状态点 + 简介"，用于 tab 头和按钮副标
  const providerSummary: Record<typeof uploadProvider, { dot: "ok" | "warn" | "off"; text: string }> = {
    picgo: {
      dot: ping.stage === "ok" ? "ok" : ping.stage === "fail" ? "warn" : "off",
      text:
        ping.stage === "ok"
          ? `已连接 · ${ping.latencyMs} ms`
          : ping.stage === "fail"
          ? "未连接"
          : ping.stage === "probing"
          ? "检测中"
          : "未测试",
    },
    s3: { dot: "off", text: "S3 兼容图床（自己的 bucket）" },
    none: { dot: "off", text: "粘贴 / 拖入图片留在本地不上传" },
  };

  return (
    <>
      <SectionHeader id="picgo" />

      {/* 3-tab 切换 — 一眼看到所有选项，不需要展开 dropdown 才知道还有 S3 */}
      <div className="settings-card">
        <div className="upload-tabs" role="tablist">
          {(["picgo", "s3", "none"] as const).map((id) => {
            const s = providerSummary[id];
            const active = uploadProvider === id;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={active}
                className={"upload-tab" + (active ? " active" : "")}
                onClick={() => setPreference("uploadProvider", id)}
              >
                <span className={`upload-dot upload-dot-${s.dot}`} />
                <div className="upload-tab-tt">
                  <div className="t">
                    {id === "picgo"
                      ? t("settings.picgo.providerOptions.picgo")
                      : id === "s3"
                      ? t("settings.picgo.providerOptions.s3")
                      : t("settings.picgo.providerOptions.none")}
                  </div>
                  <div className="s">{s.text}</div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* 选中 provider 的具体配置 */}
      {uploadProvider === "picgo" && (
        <div className="settings-card">
          <div className="settings-card-h">{t("settings.picgo.picgoCard")}</div>
          <div className="settings-row">
            <div className="settings-row-l">
              <div className="settings-label">{t("settings.picgo.status")}</div>
              <div
                className={
                  "settings-help" +
                  (ping.stage === "ok"
                    ? " settings-help-ok"
                    : ping.stage === "fail"
                      ? " settings-help-err"
                      : "")
                }
              >
                {statusText}
              </div>
            </div>
            <button
              className="settings-btn"
              onClick={() => probe(endpoint)}
              disabled={!endpoint || ping.stage === "probing"}
            >
              {ping.stage === "probing"
                ? t("settings.picgo.rescanning")
                : t("settings.picgo.rescan")}
            </button>
          </div>
          <div className="settings-row">
            <div className="settings-row-l">
              <div className="settings-label">{t("settings.picgo.endpoint")}</div>
            </div>
            <SelectBtn
              value={endpoint}
              options={PICGO_ENDPOINT_OPTIONS}
              onChange={(v) => setPreference("picgoEndpoint", v)}
              minMenuWidth={230}
            />
          </div>
        </div>
      )}

      {uploadProvider === "s3" && <S3Card />}

      {uploadProvider === "none" && (
        <div className="settings-banner">
          选择"不上传"后，粘贴 / 拖入的图片不会自动上传，只在本地按附件保存；笔记里走相对路径。
        </div>
      )}

      {/* 通用行为 — 不上传时大部分无意义，整块淡化 */}
      <div
        className={
          "settings-card" + (uploadProvider === "none" ? " settings-card-dim" : "")
        }
        aria-disabled={uploadProvider === "none"}
      >
        <div className="settings-card-h">{t("settings.picgo.generalCard")}</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <LabelWithTip tip={t("settings.picgo.pasteAutoUploadTip")}>
              {t("settings.picgo.pasteAutoUpload")}
            </LabelWithTip>
          </div>
          <Toggle
            on={pasteUpload}
            onChange={(v) => setPreference("picgoPasteUpload", v)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">{t("settings.picgo.dragAutoUpload")}</div>
          </div>
          <Toggle
            on={dragUpload}
            onChange={(v) => setPreference("picgoDragUpload", v)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <LabelWithTip tip={t("settings.picgo.keepLocalCopyTip")}>
              {t("settings.picgo.keepLocalCopy")}
            </LabelWithTip>
          </div>
          <Toggle
            on={keepLocalCopy}
            onChange={(v) => setPreference("picgoKeepLocalCopy", v)}
          />
        </div>
      </div>

      {/* 压缩 — 同样上传时才有意义 */}
      <div
        className={
          "settings-card" + (uploadProvider === "none" ? " settings-card-dim" : "")
        }
        aria-disabled={uploadProvider === "none"}
      >
        <div className="settings-card-h">{t("settings.picgo.compressCard")}</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">{t("settings.picgo.compressToggle")}</div>
          </div>
          <Toggle
            on={compressBeforeUpload}
            onChange={(v) => setPreference("picgoCompressBeforeUpload", v)}
          />
        </div>
        {compressBeforeUpload && (
          <div className="settings-row">
            <div className="settings-row-l">
              <div className="settings-label">{t("settings.picgo.quality")}</div>
              <div className="settings-help">{quality}%</div>
            </div>
            <Slider
              value={quality}
              min={40}
              max={100}
              onChange={(v) => setPreference("picgoQuality", v)}
            />
          </div>
        )}
      </div>
    </>
  );
}
