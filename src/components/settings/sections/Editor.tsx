import { useMemo } from "react";
import { Toggle, SelectBtn } from "../../ui/controls";
import { useSettings } from "@/stores/settings";
import { useTranslation } from "react-i18next";
import { SectionHeader } from "./_shared";

export function Editor() {
  const { t } = useTranslation();
  const mode = useSettings((s) => s.defaultMode);
  const setMode = useSettings((s) => s.setDefaultMode);
  const autosave = useSettings((s) => s.autosave);
  const setAutosave = useSettings((s) => s.setAutosave);
  const autosaveDelayMs = useSettings((s) => s.autosaveDelayMs);
  const shortcutStyle = useSettings((s) => s.shortcutStyle);
  const setShortcutStyle = useSettings((s) => s.setShortcutStyle);
  const setPreference = useSettings((s) => s.setPreference);
  const smartQuotes = useSettings((s) => s.smartQuotes);
  const autoListContinuation = useSettings((s) => s.autoListContinuation);
  const autoSpaceCJK = useSettings((s) => s.autoSpaceCJK);
  const snapshotOnSave = useSettings((s) => s.snapshotOnSave);
  const shortcutStyleItems = useMemo(
    () =>
      (["all", "bubble", "slash", "toolbar"] as const).map((id) => ({
        id,
        label: t(`settings.editor.shortcutStyle.${id}`),
      })),
    [t],
  );
  const bubbleTrigger = useSettings((s) => s.bubbleTrigger);
  const bubbleAllowed = shortcutStyle === "all" || shortcutStyle === "bubble";
  const bubbleTriggerItems = useMemo(
    () =>
      (["selection", "rightClick"] as const).map((id) => ({
        id,
        label: t(`settings.editor.bubbleTrigger.${id}`),
      })),
    [t],
  );
  const modeItems = useMemo(
    () =>
      (["source", "split", "wysiwyg", "preview"] as const).map((id) => ({
        id,
        label: t(`settings.editor.mode.${id}`),
      })),
    [t],
  );
  const autosaveDelayOptions = useMemo(
    () =>
      ([500, 800, 1500, 3000] as const).map((v) => ({
        value: v,
        label: t(`settings.editor.autosaveDelayOptions.${v}`),
      })),
    [t],
  );
  return (
    <>
      <SectionHeader id="editor" />
      <div className="settings-card">
        <div className="settings-card-h">{t("settings.editor.autosaveCard")}</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">
              {t("settings.editor.autosaveToggle")}
            </div>
            <div className="settings-help">
              {t("settings.editor.autosaveToggleHelp")}
            </div>
          </div>
          <Toggle on={autosave} onChange={setAutosave} />
        </div>
      </div>
      <div className="settings-card">
        <div className="settings-card-h">
          {t("settings.editor.shortcutStyleCard")}
        </div>
        {shortcutStyleItems.map((m) => (
          <button
            type="button"
            key={m.id}
            className={
              "settings-row settings-choice-row" +
              (shortcutStyle === m.id ? " active" : "")
            }
            onClick={() => setShortcutStyle(m.id)}
          >
            <div className="settings-row-l">
              <div className="settings-label">{m.label}</div>
            </div>
            <div className="settings-choice-dot" />
          </button>
        ))}
      </div>
      <div className="settings-card" aria-disabled={!bubbleAllowed}>
        <div className="settings-card-h">
          {t("settings.editor.bubbleTriggerCard")}
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-help">
              {t("settings.editor.bubbleTriggerHelp")}
            </div>
          </div>
        </div>
        {bubbleTriggerItems.map((m) => (
          <button
            type="button"
            key={m.id}
            disabled={!bubbleAllowed}
            className={
              "settings-row settings-choice-row" +
              (bubbleTrigger === m.id ? " active" : "")
            }
            onClick={() => setPreference("bubbleTrigger", m.id)}
          >
            <div className="settings-row-l">
              <div className="settings-label">{m.label}</div>
            </div>
            <div className="settings-choice-dot" />
          </button>
        ))}
      </div>
      <div className="settings-card">
        <div className="settings-card-h">{t("settings.editor.modeCard")}</div>
        {modeItems.map((m) => (
          <button
            type="button"
            key={m.id}
            className={
              "settings-row settings-choice-row" +
              (mode === m.id ? " active" : "")
            }
            onClick={() => setMode(m.id)}
          >
            <div className="settings-row-l">
              <div className="settings-label">{m.label}</div>
            </div>
            <div className="settings-choice-dot" />
          </button>
        ))}
      </div>
      <div className="settings-card">
        <div className="settings-card-h">{t("settings.editor.inputCard")}</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">{t("settings.editor.smartQuotes")}</div>
            <div className="settings-help">
              {t("settings.editor.smartQuotesHelp")}
            </div>
          </div>
          <Toggle
            on={smartQuotes}
            onChange={(v) => setPreference("smartQuotes", v)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">{t("settings.editor.autoList")}</div>
            <div className="settings-help">
              {t("settings.editor.autoListHelp")}
            </div>
          </div>
          <Toggle
            on={autoListContinuation}
            onChange={(v) => setPreference("autoListContinuation", v)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">
              {t("settings.editor.autoSpaceCJK")}
            </div>
            <div className="settings-help">
              {t("settings.editor.autoSpaceCJKHelp")}
            </div>
          </div>
          <Toggle
            on={autoSpaceCJK}
            onChange={(v) => setPreference("autoSpaceCJK", v)}
          />
        </div>
      </div>
      <div className="settings-card">
        <div className="settings-card-h">{t("settings.editor.saveCard")}</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">
              {t("settings.editor.autosaveDelay")}
            </div>
          </div>
          <SelectBtn
            value={autosaveDelayMs}
            options={autosaveDelayOptions}
            onChange={(v) => setPreference("autosaveDelayMs", v)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">
              {t("settings.editor.snapshotOnSave")}
            </div>
            <div className="settings-help">
              {t("settings.editor.snapshotOnSaveHelp")}
            </div>
          </div>
          <Toggle
            on={snapshotOnSave}
            onChange={(v) => setPreference("snapshotOnSave", v)}
          />
        </div>
      </div>
    </>
  );
}
