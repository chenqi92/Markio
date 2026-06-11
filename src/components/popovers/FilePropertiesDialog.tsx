import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../ui/Icon";
import { useFileMeta, FILE_COLOR_PALETTE } from "@/stores/fileMeta";
import { useVaultIndex } from "@/stores/vaultIndex";
import { pathKey } from "@/lib/utils";
import type { FileEntry } from "@/types";

interface Props {
  node: FileEntry;
  workspacePath: string;
  onClose: () => void;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function formatTs(ms: number): string {
  if (!ms) return "未知";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 文件属性弹窗：路径 / 大小 / mtime / vault index 抽出的 tags + mentions / 用户元数据
 *  (收藏 / 颜色 / 标记)，并提供小型编辑控件。 */
export function FilePropertiesDialog({ node, workspacePath, onClose }: Props) {
  const { t } = useTranslation();
  const meta = useFileMeta((s) => s.byPath[pathKey(node.path)]) ?? {};
  const toggleBookmark = useFileMeta((s) => s.toggleBookmark);
  const setColor = useFileMeta((s) => s.setColor);
  const addMark = useFileMeta((s) => s.addMark);
  const removeMark = useFileMeta((s) => s.removeMark);
  const idx = useVaultIndex((s) => s.index[workspacePath]);
  const [markDraft, setMarkDraft] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const vfile = useMemo(
    () => idx?.files.find((f) => f.path === node.path),
    [idx, node.path],
  );

  return (
    <div className="scrim" onClick={onClose}>
      <div className="about-modal" style={{ width: 460 }} onClick={(e) => e.stopPropagation()}>
        <div className="about-modal-h">
          <div className="about-modal-t">{t("fileProps.title")}</div>
          <button type="button" className="about-modal-x" onClick={onClose} aria-label={t("common.close")}>
            <Icon name="x" size={13} />
          </button>
        </div>

        <div className="about-modal-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <div className="fp-row">
              <span className="fp-k">{t("fileProps.name")}</span>
              <span className="fp-v">{node.name}</span>
            </div>
            <div className="fp-row">
              <span className="fp-k">{t("fileProps.type")}</span>
              <span className="fp-v">{node.isDir ? t("fileProps.kindDir") : t("fileProps.kindFile")}</span>
            </div>
            <div className="fp-row">
              <span className="fp-k">{t("fileProps.path")}</span>
              <span className="fp-v fp-mono" title={node.path}>{node.path}</span>
            </div>
            {vfile && (
              <>
                <div className="fp-row">
                  <span className="fp-k">{t("fileProps.size")}</span>
                  <span className="fp-v">{formatBytes(vfile.size)}</span>
                </div>
                <div className="fp-row">
                  <span className="fp-k">{t("fileProps.mtime")}</span>
                  <span className="fp-v">{formatTs(vfile.mtime * 1000)}</span>
                </div>
                <div className="fp-row">
                  <span className="fp-k">{t("fileProps.tags")}</span>
                  <span className="fp-v">{vfile.tags.length > 0 ? vfile.tags.map((x) => `#${x}`).join(" ") : t("fileProps.noneDash")}</span>
                </div>
                <div className="fp-row">
                  <span className="fp-k">{t("fileProps.mentions")}</span>
                  <span className="fp-v">{vfile.mentions.length > 0 ? vfile.mentions.map((m) => `@${m}`).join(" ") : t("fileProps.noneDash")}</span>
                </div>
              </>
            )}
            {!vfile && !node.isDir && (
              <div className="fp-row">
                <span className="fp-k">·</span>
                <span className="fp-v" style={{ color: "var(--text-3)" }}>{t("fileProps.indexHint")}</span>
              </div>
            )}
          </div>

          <div className="fp-sec-h">{t("fileProps.userMeta")}</div>

          <div className="fp-row">
            <span className="fp-k">{t("fileProps.bookmark")}</span>
            <button
              type="button"
              className="settings-btn"
              onClick={() => toggleBookmark(node.path)}
            >
              {meta.bookmark ? t("fileProps.bookmarkOn") : t("fileProps.bookmarkOff")}
            </button>
          </div>

          <div className="fp-row">
            <span className="fp-k">{t("fileProps.color")}</span>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {FILE_COLOR_PALETTE.map((c) => (
                <button
                  key={c.id || "_"}
                  type="button"
                  onClick={() => setColor(node.path, c.id || undefined)}
                  title={c.label}
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 6,
                    background: c.id || "transparent",
                    border: meta.color === c.id || (!meta.color && !c.id)
                      ? "2px solid var(--text)"
                      : "0.5px solid var(--border-strong)",
                    cursor: "pointer",
                    position: "relative",
                  }}
                >
                  {!c.id && <span style={{ fontSize: 10, color: "var(--text-3)" }}>×</span>}
                </button>
              ))}
            </div>
          </div>

          <div className="fp-row" style={{ alignItems: "flex-start" }}>
            <span className="fp-k">{t("fileProps.marks")}</span>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {(meta.marks ?? []).length === 0 ? (
                  <span style={{ fontSize: 11, color: "var(--text-3)" }}>{t("fileProps.noneDash")}</span>
                ) : (
                  (meta.marks ?? []).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => removeMark(node.path, m)}
                      style={{
                        padding: "2px 8px",
                        fontSize: 11,
                        background: "var(--bg-pane)",
                        border: "0.5px solid var(--border)",
                        borderRadius: 999,
                        cursor: "pointer",
                      }}
                      title="点击移除"
                    >
                      {m} <span style={{ color: "var(--text-3)" }}>×</span>
                    </button>
                  ))
                )}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  type="text"
                  value={markDraft}
                  onChange={(e) => setMarkDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && markDraft.trim()) {
                      addMark(node.path, markDraft.trim());
                      setMarkDraft("");
                    }
                  }}
                  placeholder={t("fileProps.markPlaceholder")}
                  style={{
                    flex: 1,
                    padding: "4px 8px",
                    background: "var(--bg-input)",
                    border: "0.5px solid var(--border-strong)",
                    borderRadius: 6,
                    fontSize: 12,
                    color: "var(--text)",
                  }}
                />
                <button
                  type="button"
                  className="settings-btn"
                  onClick={() => {
                    if (markDraft.trim()) {
                      addMark(node.path, markDraft.trim());
                      setMarkDraft("");
                    }
                  }}
                  disabled={!markDraft.trim()}
                >
                  {t("fileProps.markAdd")}
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="about-modal-foot">
          <button type="button" className="settings-btn primary" onClick={onClose}>{t("common.close")}</button>
        </div>
      </div>
    </div>
  );
}
