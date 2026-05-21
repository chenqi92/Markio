import { useMemo } from "react";
import { Toggle, SelectBtn } from "../../ui/controls";
import { useSettings } from "@/stores/settings";
import { api } from "@/lib/api";
import { useTranslation } from "react-i18next";
import { SectionHeader } from "./_shared";

export function General() {
  const { t } = useTranslation();
  const startupBehavior = useSettings((s) => s.startupBehavior);
  const closeLastTabBehavior = useSettings((s) => s.closeLastTabBehavior);
  const showInTray = useSettings((s) => s.showInTray);
  const loadRemoteImages = useSettings((s) => s.loadRemoteImages);
  const setPreference = useSettings((s) => s.setPreference);
  const startupOptions = useMemo(
    () =>
      (["restoreTabs", "lastWorkspace", "welcome"] as const).map((v) => ({
        value: v,
        label: t(`settings.general.startupOptions.${v}`),
      })),
    [t],
  );
  const closeOptions = useMemo(
    () =>
      (["keepWindow", "showWelcome", "quitApp"] as const).map((v) => ({
        value: v,
        label: t(`settings.general.closeLastTabOptions.${v}`),
      })),
    [t],
  );
  return (
    <>
      <SectionHeader id="general" />
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">{t("settings.general.startup")}</div>
          </div>
          <SelectBtn
            value={startupBehavior}
            options={startupOptions}
            onChange={(v) => setPreference("startupBehavior", v)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">
              {t("settings.general.closeLastTab")}
            </div>
          </div>
          <SelectBtn
            value={closeLastTabBehavior}
            options={closeOptions}
            onChange={(v) => setPreference("closeLastTabBehavior", v)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">{t("settings.general.showInTray")}</div>
            <div className="settings-help">
              {t("settings.general.showInTrayHelp")}
            </div>
          </div>
          <Toggle
            on={showInTray}
            onChange={(v) => {
              setPreference("showInTray", v);
              api.traySetVisible(v).catch(() => {
                /* 非桌面环境忽略 */
              });
            }}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">
              {t("settings.general.loadRemoteImages", {
                defaultValue: "自动加载外链图片",
              })}
            </div>
            <div className="settings-help">
              {t("settings.general.loadRemoteImagesHelp", {
                defaultValue:
                  "默认显示占位符以避免追踪像素 / canary 链接泄漏使用者 IP；关闭时点击图片即可加载单张。",
              })}
            </div>
          </div>
          <Toggle
            on={loadRemoteImages}
            onChange={(v) => setPreference("loadRemoteImages", v)}
          />
        </div>
      </div>
    </>
  );
}
