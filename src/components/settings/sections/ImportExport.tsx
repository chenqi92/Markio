import { useMemo, useState } from "react";
import { Toggle, SelectBtn } from "../../ui/controls";
import { useSettings } from "@/stores/settings";
import { useWorkspace as useWorkspaceStore } from "@/stores/workspace";
import { api, pickDirectory, pickFile } from "@/lib/api";
import { useTranslation } from "react-i18next";
import { SectionHeader, CardTitle } from "./_shared";
import { BrandMark } from "./Sync";

const IMPORT_SOURCES = [
  {
    id: "notion",
    name: "Notion",
    logo: "/brand/import/notion.svg",
    color: "#111111",
    inputHint: "ZIP 归档",
    inputTitle: "选择 Notion 导出的 .zip",
  },
  {
    id: "bear",
    name: "Bear",
    logo: "/brand/import/bear.svg",
    color: "#111827",
    inputHint: "Bearbook / ZIP",
    inputTitle: "选择 .bearbook 或 Bear 导出的 .zip",
  },
  {
    id: "obsidian",
    name: "Obsidian",
    logo: "/brand/import/obsidian.svg",
    color: "#7c3aed",
    inputHint: "仓库目录",
    inputTitle: "选择 Obsidian vault 目录",
  },
  {
    id: "evernote",
    name: "印象笔记",
    logo: "/brand/import/evernote.svg",
    color: "#00a82d",
    inputHint: "ENEX 文件",
    inputTitle: "选择印象笔记导出的 .enex",
  },
  {
    id: "roam",
    name: "Roam",
    logo: "/brand/import/roamresearch.svg",
    color: "#475569",
    inputHint: "Markdown ZIP",
    inputTitle: "选择 Roam 的 Markdown .zip；JSON 会跳过并给出警告",
  },
  {
    id: "logseq",
    name: "Logseq",
    logo: "/brand/import/logseq.svg",
    color: "#2563eb",
    inputHint: "Graph 目录",
    inputTitle: "选择 Logseq graph 目录",
  },
];

type ImportProvider =
  | "notion"
  | "obsidian"
  | "bear"
  | "evernote"
  | "roam"
  | "logseq";

type ImportBusyProvider = ImportProvider | "apple-notes";

const IMPORT_PROVIDER_MAP: Record<string, ImportProvider | null> = {
  notion: "notion",
  obsidian: "obsidian",
  bear: "bear",
  evernote: "evernote",
  roam: "roam",
  logseq: "logseq",
};

function extsFor(p: ImportProvider): string[] {
  switch (p) {
    case "notion":
    case "roam":
      return ["zip"];
    case "bear":
      return ["bearbook", "zip"];
    case "evernote":
      return ["enex"];
    case "obsidian":
    case "logseq":
      return [];
  }
}

function providerNeedsDir(p: ImportProvider): boolean {
  return p === "obsidian" || p === "logseq";
}

function importProviderName(provider: ImportProvider): string {
  return (
    IMPORT_SOURCES.find((source) => IMPORT_PROVIDER_MAP[source.id] === provider)
      ?.name ?? provider
  );
}

function importWarningSuffix(warnings: string[]): string {
  if (warnings.length === 0) return "";
  const preview = warnings.slice(0, 3).join("；");
  const more =
    warnings.length > 3 ? `；另有 ${warnings.length - 3} 条未显示` : "";
  return `（警告：${preview}${more}）`;
}

export function ImportExport() {
  const { t } = useTranslation();
  const pdfTheme = useSettings((s) => s.exportPdfTheme);
  const pdfMargin = useSettings((s) => s.exportPdfMargin);
  const inlineImages = useSettings((s) => s.htmlExportInlineImages);
  const setPreference = useSettings((s) => s.setPreference);
  const pdfThemeOptions = useMemo(
    () =>
      (["current", "light", "dark", "print"] as const).map((v) => ({
        value: v,
        label: t(`settings.export.pdfThemeOptions.${v}`),
      })),
    [t],
  );
  const pdfMarginOptions = useMemo(
    () =>
      (["standard", "narrow", "wide"] as const).map((v) => ({
        value: v,
        label: t(`settings.export.pdfMarginOptions.${v}`),
      })),
    [t],
  );
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace());
  const refreshTree = useWorkspaceStore((s) => s.refreshTree);
  const [importBusy, setImportBusy] = useState<ImportBusyProvider | null>(null);
  const [importMsg, setImportMsg] = useState<{
    kind: "ok" | "err" | "info";
    text: string;
  } | null>(null);

  const runImport = async (provider: ImportProvider, useDir: boolean) => {
    if (!activeWorkspace) {
      setImportMsg({ kind: "err", text: "请先打开一个仓库" });
      return;
    }
    const src = useDir
      ? await pickDirectory()
      : await pickFile([
          { name: provider === "evernote" ? "ENEX" : "Archive", extensions: useDir ? [] : extsFor(provider) },
        ]);
    if (!src) return;
    setImportBusy(provider);
    const name = importProviderName(provider);
    setImportMsg({ kind: "info", text: `${name} 导入中…` });
    try {
      const report = await api.importRun(provider, src, activeWorkspace.path);
      setImportMsg({
        kind: "ok",
        text: `${name} 导入完成：${report.files} 个文件 → ${
          report.dest
        }${importWarningSuffix(report.warnings)}`,
      });
      await refreshTree(activeWorkspace.id).catch(() => undefined);
    } catch (e) {
      setImportMsg({ kind: "err", text: `导入失败：${String(e)}` });
    } finally {
      setImportBusy(null);
    }
  };

  const runAppleNotesImport = async () => {
    if (!activeWorkspace) {
      setImportMsg({ kind: "err", text: "请先打开一个仓库" });
      return;
    }
    setImportBusy("apple-notes");
    setImportMsg({
      kind: "info",
      text: "正在通过 osascript 读取 Notes.app…（首次会弹系统授权对话框）",
    });
    try {
      const report = await api.importAppleNotes(activeWorkspace.path);
      setImportMsg({
        kind: "ok",
        text: `Apple Notes 导入完成：${report.files} 篇 → ${
          report.dest
        }${importWarningSuffix(report.warnings)}`,
      });
      await refreshTree(activeWorkspace.id).catch(() => undefined);
    } catch (e) {
      setImportMsg({ kind: "err", text: `导入失败：${String(e)}` });
    } finally {
      setImportBusy(null);
    }
  };

  return (
    <>
      <SectionHeader id="export" />
      <div className="settings-card">
        <div className="settings-card-h">{t("settings.export.card")}</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">{t("settings.export.pdfTheme")}</div>
          </div>
          <SelectBtn
            value={pdfTheme}
            options={pdfThemeOptions}
            onChange={(v) => setPreference("exportPdfTheme", v)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">{t("settings.export.pdfMargin")}</div>
          </div>
          <SelectBtn
            value={pdfMargin}
            options={pdfMarginOptions}
            onChange={(v) => setPreference("exportPdfMargin", v)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">{t("settings.export.htmlInline")}</div>
            <div className="settings-help">把远端图片下载并以 base64 嵌入 HTML，离线可看（单张 ≤10MB）</div>
          </div>
          <Toggle
            on={inlineImages}
            onChange={(v) => setPreference("htmlExportInlineImages", v)}
          />
        </div>
      </div>
      <div className="settings-card">
        <CardTitle tip="导入到当前仓库的 imports/provider-timestamp/；Notion/Roam/Bear 选 ZIP，印象笔记选 ENEX，Obsidian/Logseq 选目录。">
          从其它工具导入
        </CardTitle>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
            gap: 8,
            padding: "12px 16px",
          }}
        >
          {IMPORT_SOURCES.map((n) => {
            const provider = IMPORT_PROVIDER_MAP[n.id] ?? null;
            const disabled =
              provider === null || importBusy !== null || !activeWorkspace;
            return (
              <button
                type="button"
                key={n.id}
                disabled={disabled}
                onClick={() => {
                  if (!provider) return;
                  void runImport(provider, providerNeedsDir(provider));
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "9px 12px",
                  background: "var(--bg-pane-2)",
                  border: "0.5px solid var(--border)",
                  borderRadius: 8,
                  fontSize: 12,
                  color: disabled ? "var(--text-3)" : "var(--text)",
                  cursor: disabled ? "not-allowed" : "pointer",
                  opacity: disabled ? 0.55 : 1,
                  textAlign: "left",
                }}
                title={
                  provider === null
                    ? "未支持"
                    : !activeWorkspace
                      ? "请先打开仓库"
                      : importBusy === provider
                        ? "导入中…"
                        : n.inputTitle
                }
              >
                <BrandMark logo={n.logo} color={n.color} size={28} />
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontWeight: 600,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {n.name}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--text-3)", marginTop: 2 }}>
                    {importBusy === provider
                      ? "导入中…"
                      : !activeWorkspace
                        ? "先打开仓库"
                        : n.inputHint}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
        {typeof navigator !== "undefined" && navigator.platform.startsWith("Mac") && (
          <div style={{ padding: "0 16px 12px" }}>
            <button
              type="button"
              disabled={importBusy !== null || !activeWorkspace}
              onClick={() => void runAppleNotesImport()}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "9px 12px",
                background: "var(--bg-pane-2)",
                border: "0.5px solid var(--border)",
                borderRadius: 8,
                fontSize: 12,
                color:
                  importBusy !== null || !activeWorkspace
                    ? "var(--text-3)"
                    : "var(--text)",
                cursor:
                  importBusy !== null || !activeWorkspace ? "not-allowed" : "pointer",
                opacity: importBusy !== null || !activeWorkspace ? 0.55 : 1,
                width: "100%",
                textAlign: "left",
              }}
              title={
                !activeWorkspace
                  ? "请先打开仓库"
                  : "通过 osascript 调系统 Notes.app；首次需授权"
              }
            >
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 6,
                  background: "#fed7aa",
                  color: "#9a3412",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: 700,
                  fontSize: 14,
                }}
              >
                N
              </div>
              <div>
                Apple Notes（macOS）
                <div style={{ fontSize: 10, color: "var(--text-3)", marginTop: 2 }}>
                  {importBusy === "apple-notes"
                    ? "导入中…"
                    : "首次会弹系统授权对话框"}
                </div>
              </div>
            </button>
          </div>
        )}
        {importMsg && (
          <div
            style={{
              padding: "0 16px 12px",
              fontSize: 12,
              color:
                importMsg.kind === "err"
                  ? "#dc2626"
                  : importMsg.kind === "ok"
                    ? "var(--accent)"
                    : "var(--text-3)",
            }}
          >
            {importMsg.text}
          </div>
        )}
      </div>
    </>
  );
}
