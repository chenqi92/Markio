import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettings } from "@/stores/settings";
import {
  COMMANDS,
  type CommandDef,
  type CommandId,
  eventToBinding,
  formatBinding,
  normalizeBinding,
  shortcutText,
} from "@/lib/shortcuts";
import { SectionHeader } from "../_shared";

const MARKDOWN_EDITOR_SHORTCUTS: { l: string; k: string[] }[] = [
  { l: "加粗 / 斜体 / 链接", k: [shortcutText("⌘"), "B / I / K"] },
  { l: "高亮 / 删除线", k: [shortcutText("⌘"), shortcutText("⇧"), "H / X"] },
  { l: "标题 1–4", k: [shortcutText("⌘"), shortcutText("⌥"), "1–4"] },
  { l: "双向链接 / 表格 / 代码块 / 公式", k: [shortcutText("⌘"), shortcutText("⌥"), "L / T / C / M"] },
];

export function Shortcuts() {
  const overrides = useSettings((s) => s.shortcutOverrides);
  const setShortcut = useSettings((s) => s.setShortcut);
  const { t } = useTranslation();
  const resetShortcut = useSettings((s) => s.resetShortcut);
  const resetAllShortcuts = useSettings((s) => s.resetAllShortcuts);
  const [recording, setRecording] = useState<CommandId | null>(null);
  const [error, setError] = useState<{ id: CommandId; msg: string } | null>(null);

  const effective = useMemo(() => {
    const out: Partial<Record<CommandId, string>> = {};
    for (const c of COMMANDS) {
      const o = overrides[c.id];
      const binding = o !== undefined ? o : c.defaultBinding;
      out[c.id] = normalizeBinding(binding);
    }
    return out as Record<CommandId, string>;
  }, [overrides]);

  const conflicts = useMemo(() => {
    const map = new Map<string, CommandId[]>();
    for (const c of COMMANDS) {
      const b = effective[c.id];
      if (!b) continue;
      const list = map.get(b);
      if (list) list.push(c.id);
      else map.set(b, [c.id]);
    }
    const set = new Set<CommandId>();
    for (const ids of map.values()) {
      if (ids.length > 1) ids.forEach((id) => set.add(id));
    }
    return set;
  }, [effective]);

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(null);
        setError(null);
        return;
      }
      const binding = eventToBinding(e);
      if (!binding) return;
      const normalized = normalizeBinding(binding);
      const taken = COMMANDS.find(
        (c) => c.id !== recording && effective[c.id] === normalized,
      );
      if (taken) {
        setError({
          id: recording,
          msg: t("settings.shortcuts.conflictWith", { name: taken.label }),
        });
        return;
      }
      setShortcut(recording, normalized);
      setRecording(null);
      setError(null);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, {
        capture: true,
      } as EventListenerOptions);
  }, [recording, effective, setShortcut, t]);

  const groups = useMemo(() => {
    const map = new Map<string, CommandDef[]>();
    for (const c of COMMANDS) {
      const list = map.get(c.group);
      if (list) list.push(c);
      else map.set(c.group, [c]);
    }
    return Array.from(map.entries());
  }, []);

  const dangerColor = "var(--danger, #c1432f)";

  return (
    <>
      <SectionHeader id="shortcuts" />
      <div className="shortcuts-toolbar">
        <button
          className="settings-btn"
          onClick={() => {
            setRecording(null);
            setError(null);
            resetAllShortcuts();
          }}
        >
          {t("settings.shortcuts.resetAll")}
        </button>
      </div>
      {groups.map(([group, items]) => (
        <div className="settings-card" key={group}>
          <div className="settings-card-h">{group}</div>
          {items.map((cmd) => {
            const binding = effective[cmd.id];
            const isRecording = recording === cmd.id;
            const isConflict = conflicts.has(cmd.id);
            const hasOverride = overrides[cmd.id] !== undefined;
            const chips = formatBinding(binding);
            return (
              <div className="settings-row" key={cmd.id}>
                <div className="settings-row-l">
                  <div className="settings-label">{cmd.label}</div>
                  {error?.id === cmd.id ? (
                    <div className="settings-help" style={{ color: dangerColor }}>
                      {error.msg}
                    </div>
                  ) : isConflict ? (
                    <div className="settings-help" style={{ color: dangerColor }}>
                      {t("settings.shortcuts.conflict")}
                    </div>
                  ) : null}
                </div>
                <div className="kbd-group">
                  {isRecording ? (
                    <span className="kbd kbd-recording">
                      {t("settings.shortcuts.pressNewKey")}
                    </span>
                  ) : binding ? (
                    chips.map((k, i) => (
                      <span
                        key={i}
                        className="kbd"
                        style={
                          isConflict
                            ? { color: dangerColor, borderColor: dangerColor }
                            : undefined
                        }
                      >
                        {k}
                      </span>
                    ))
                  ) : (
                    <span className="kbd" style={{ opacity: 0.6 }}>
                      {t("settings.shortcuts.unbound")}
                    </span>
                  )}
                </div>
                <button
                  className="settings-btn"
                  onClick={() => {
                    setError(null);
                    setRecording(isRecording ? null : cmd.id);
                  }}
                >
                  {isRecording
                    ? t("settings.shortcuts.actions.cancel")
                    : t("settings.shortcuts.actions.record")}
                </button>
                <button
                  className="settings-btn"
                  onClick={() => {
                    setError(null);
                    setShortcut(cmd.id, "");
                  }}
                  disabled={!binding}
                  title={t("settings.shortcuts.unbound")}
                >
                  {t("settings.shortcuts.actions.clear")}
                </button>
                <button
                  className="settings-btn"
                  onClick={() => {
                    setError(null);
                    resetShortcut(cmd.id);
                  }}
                  disabled={!hasOverride}
                  title={t("common.reset")}
                >
                  {t("settings.shortcuts.actions.reset")}
                </button>
              </div>
            );
          })}
        </div>
      ))}
      <div className="settings-card">
        <div className="settings-card-h">
          {t("settings.shortcuts.markdownCard")}
        </div>
        {MARKDOWN_EDITOR_SHORTCUTS.map((it) => (
          <div className="settings-row" key={it.l}>
            <div className="settings-row-l">
              <div className="settings-label">{it.l}</div>
            </div>
            <div className="kbd-group">
              {it.k.map((k, i) => (
                <span key={i} className="kbd">
                  {k}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
      <GlobalShortcutCard />
    </>
  );
}

function GlobalShortcutCard() {
  const binding = useSettings((s) => s.globalShortcutShow);
  const setPreference = useSettings((s) => s.setPreference);
  const [recording, setRecording] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(false);
        return;
      }
      const b = eventToBinding(e);
      if (!b) return;
      const normalized = normalizeBinding(b);
      // 必须含修饰键，否则会和正常打字冲突
      if (!/^(Mod|Ctrl|Alt|Shift)\+/.test(normalized)) {
        setErr("全局快捷键必须包含修饰键（⌘ / Ctrl / Alt / Shift）");
        return;
      }
      setErr(null);
      setPreference("globalShortcutShow", normalized);
      setRecording(false);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, {
        capture: true,
      } as EventListenerOptions);
  }, [recording, setPreference]);

  const chips = formatBinding(binding);
  return (
    <div className="settings-card">
      <div className="settings-card-h">全局快捷键</div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">唤起 markio（应用未聚焦时也生效）</div>
          <div className="settings-help">
            按下后把 markio 主窗口拉到前台。系统级注册，可能与其他应用冲突；冲突时下次启动会注册失败。
            {err && <span style={{ color: "var(--danger, #c1432f)", marginLeft: 8 }}>{err}</span>}
          </div>
        </div>
        <div className="kbd-group">
          {recording ? (
            <span className="kbd" style={{ minWidth: 120, textAlign: "center" }}>
              按下新按键…
            </span>
          ) : binding ? (
            chips.map((k, i) => (
              <span key={i} className="kbd">
                {k}
              </span>
            ))
          ) : (
            <span className="kbd" style={{ opacity: 0.6 }}>未绑定</span>
          )}
        </div>
        <button
          className="settings-btn"
          onClick={() => {
            setErr(null);
            setRecording((v) => !v);
          }}
        >
          {recording ? "取消" : "录制"}
        </button>
        <button
          className="settings-btn"
          onClick={() => {
            setErr(null);
            setPreference("globalShortcutShow", "");
          }}
          disabled={!binding}
        >
          清除
        </button>
      </div>
    </div>
  );
}
