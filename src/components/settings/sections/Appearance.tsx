import { useState } from "react";
import { useTranslation } from "react-i18next";
import { SelectBtn, Slider, Toggle } from "../../ui/controls";
import { useSettings } from "@/stores/settings";
import { useCustomThemes } from "@/stores/customThemes";
import { useDialog } from "@/stores/dialog";
import { THEMES } from "@/themes";
import { pickFile } from "@/lib/api";
import {
  UI_FONT_PRESETS,
  BODY_FONT_PRESETS,
  MONO_FONT_PRESETS,
} from "@/lib/fonts";
import type { Locale } from "@/i18n";
import { CardTitle, LabelWithTip, SectionHeader } from "../_shared";

export function Appearance() {
  const { t } = useTranslation();
  const theme = useSettings((s) => s.theme);
  const setTheme = useSettings((s) => s.setTheme);
  const follow = useSettings((s) => s.followSystemTheme);
  const setFollow = useSettings((s) => s.setFollowSystemTheme);

  return (
    <>
      <SectionHeader id="appear" />
      <LanguageCard />
      <div className="settings-card">
        <div className="settings-card-h">{t("settings.appear.themeCard")}</div>
        <div className="theme-grid">
          {THEMES.map((t) => (
            <button
              type="button"
              key={t.id}
              className={"theme-tile" + (theme === t.id ? " active" : "")}
              onClick={() => setTheme(t.id)}
            >
              <div className="theme-preview" style={{ background: t.swatch[0] }}>
                <div className="tp-text" style={{ color: t.swatch[1] }}>Aa</div>
                <div className="tp-dot" style={{ background: t.swatch[1] }} />
                <div className="tp-dot" style={{ background: t.swatch[2] }} />
              </div>
              <div className="theme-name">{t.name}</div>
              {theme === t.id && <div className="theme-check">✓</div>}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card-h">{t("settings.appear.modeCard")}</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">{t("settings.appear.followSystem")}</div>
            <div className="settings-help">{t("settings.appear.followSystemHelp")}</div>
          </div>
          <Toggle on={follow} onChange={setFollow} />
        </div>
      </div>

      <FontCard />

      <CustomThemesCard />
    </>
  );
}

function FontCard() {
  const { t } = useTranslation();
  const fontSize = useSettings((s) => s.fontSize);
  const setFontSize = useSettings((s) => s.setFontSize);
  const uiFont = useSettings((s) => s.uiFontFamily);
  const bodyFont = useSettings((s) => s.bodyFontFamily);
  const monoFont = useSettings((s) => s.monoFontFamily);
  const setFontFamily = useSettings((s) => s.setFontFamily);
  const promptDialog = useDialog((s) => s.prompt);

  const renderFontRow = (
    kind: "ui" | "body" | "mono",
    label: string,
    help: string,
    presets: { value: string; label: string }[],
    current: string,
  ) => {
    const matched = presets.find((p) => p.value === current);
    const isCustom = !matched && current !== "";
    return (
      <div className="settings-row" key={kind}>
        <div className="settings-row-l">
          <div className="settings-label">{label}</div>
          <div className="settings-help">{help}</div>
        </div>
        <SelectBtn
          value={isCustom ? "__custom__" : current}
          options={[
            ...presets.map((p) => ({ value: p.value, label: p.label })),
            { value: "__custom__", label: t("common.custom") },
          ]}
          onChange={async (v) => {
            if (v === "__custom__") {
              const input = await promptDialog({
                title: t("settings.appear.customFontPrompt"),
                defaultValue: current || "",
                confirmLabel: t("common.save"),
              });
              if (input !== null) setFontFamily(kind, input.trim());
            } else {
              setFontFamily(kind, v);
            }
          }}
          minMenuWidth={200}
        />
      </div>
    );
  };

  return (
    <div className="settings-card">
      <div className="settings-card-h">{t("settings.appear.fontCard")}</div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">{t("settings.appear.fontSize")}</div>
          <div className="settings-help">{fontSize} px</div>
        </div>
        <Slider value={fontSize} min={13} max={22} onChange={setFontSize} />
      </div>
      {renderFontRow(
        "ui",
        t("settings.appear.uiFont"),
        t("settings.appear.uiFontHelp"),
        UI_FONT_PRESETS,
        uiFont,
      )}
      {renderFontRow(
        "body",
        t("settings.appear.bodyFont"),
        t("settings.appear.bodyFontHelp"),
        BODY_FONT_PRESETS,
        bodyFont,
      )}
      {renderFontRow(
        "mono",
        t("settings.appear.monoFont"),
        t("settings.appear.monoFontHelp"),
        MONO_FONT_PRESETS,
        monoFont,
      )}
    </div>
  );
}

function CustomThemesCard() {
  const { t } = useTranslation();
  const list = useCustomThemes((s) => s.list);
  const activeId = useCustomThemes((s) => s.activeId);
  const refresh = useCustomThemes((s) => s.refresh);
  const importFrom = useCustomThemes((s) => s.importFrom);
  const remove = useCustomThemes((s) => s.remove);
  const apply = useCustomThemes((s) => s.apply);
  const setPreference = useSettings((s) => s.setPreference);
  const confirmDialog = useDialog((s) => s.confirm);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const onImport = async () => {
    setErr(null);
    try {
      const picked = await pickFile([
        { name: "CSS", extensions: ["css"] },
      ]);
      if (!picked) return;
      setBusy("import");
      const meta = await importFrom(picked);
      await apply(meta.id);
      setPreference("customThemeId", meta.id);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  };

  const onApply = async (id: string | null) => {
    setErr(null);
    setBusy(id ?? "off");
    try {
      await apply(id);
      setPreference("customThemeId", id);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  };

  const onRemove = async (id: string) => {
    const ok = await confirmDialog({
      title: t("settings.appear.confirmRemoveTheme", { id }),
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (!ok) return;
    setErr(null);
    setBusy(id);
    try {
      await remove(id);
      if (activeId === id) setPreference("customThemeId", null);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="settings-card">
      <CardTitle tip={t("settings.appear.customThemeTip")}>
        {t("settings.appear.customThemeCard")}
      </CardTitle>
      <div className="settings-action-row">
        <button
          className="settings-btn primary"
          disabled={busy !== null}
          onClick={onImport}
        >
          {t("settings.appear.importCss")}
        </button>
        <button
          className="settings-btn"
          disabled={busy !== null}
          onClick={() => void refresh()}
        >
          {t("common.refresh")}
        </button>
        {activeId && (
          <button
            className="settings-btn"
            disabled={busy !== null}
            onClick={() => void onApply(null)}
          >
            {t("settings.appear.disableCustomTheme")}
          </button>
        )}
      </div>
      {err && <div className="settings-banner warn">{err}</div>}
      {list.length === 0 ? (
        <div className="settings-help" style={{ padding: "8px 0 4px" }}>
          {t("settings.appear.noCustomThemes")}
        </div>
      ) : (
        <ul className="custom-theme-list">
          {list.map((it) => (
            <li key={it.id} className={activeId === it.id ? "active" : ""}>
              <div className="cth-l">
                <div className="cth-name">{it.name}</div>
                <div className="cth-size">{(it.size / 1024).toFixed(1)} KB</div>
              </div>
              <button
                className="settings-btn"
                disabled={busy !== null || activeId === it.id}
                onClick={() => void onApply(it.id)}
              >
                {activeId === it.id ? t("common.applied") : t("common.apply")}
              </button>
              <button
                className="settings-btn settings-btn-danger"
                disabled={busy !== null}
                onClick={() => void onRemove(it.id)}
              >
                {t("common.delete")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LanguageCard() {
  const { t } = useTranslation();
  const loc = useSettings((s) => s.locale);
  const setLocaleAction = useSettings((s) => s.setLocale);
  return (
    <div className="settings-card">
      <div className="settings-row">
        <div className="settings-row-l">
          <LabelWithTip tip={t("settings.appear.languageTip")}>
            {t("settings.appear.languageLabel")}
          </LabelWithTip>
        </div>
        <SelectBtn
          value={loc}
          options={[
            { value: "zh-CN", label: "简体中文" },
            { value: "en", label: "English" },
          ] as const}
          onChange={(v) => setLocaleAction(v as Locale)}
        />
      </div>
    </div>
  );
}
