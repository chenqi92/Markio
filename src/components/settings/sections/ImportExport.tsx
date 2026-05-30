import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettings } from "@/stores/settings";
import { useDialog } from "@/stores/dialog";
import { useWorkspace as useWorkspaceStore } from "@/stores/workspace";
import { api, pickDirectory, pickFile } from "@/lib/api";
import { writeText } from "@/lib/clipboard";
import { Toggle, SelectBtn } from "../../ui/controls";
import { BrandMark, CardTitle, SectionHeader } from "../_shared";

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

interface ImportReportState {
  provider: string;
  dest: string;
  files: number;
  skipped?: number;
  warnings: string[];
  reportPath?: string | null;
}

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

function importReportText(report: ImportReportState): string {
  const lines = [
    `来源：${report.provider}`,
    `目标：${report.dest}`,
    `新增文件：${report.files}`,
  ];
  if (report.skipped && report.skipped > 0) {
    lines.push(`跳过（已存在）：${report.skipped}`);
  }
  lines.push(`警告数：${report.warnings.length}`);
  if (report.reportPath) lines.push(`报告：${report.reportPath}`);
  if (report.warnings.length > 0) {
    lines.push("", "警告：", ...report.warnings.map((w) => `- ${w}`));
  }
  return lines.join("\n");
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
  const [importReport, setImportReport] = useState<ImportReportState | null>(null);

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
    setImportReport(null);
    try {
      const report = await api.importRun(provider, src, activeWorkspace.path);
      setImportReport(report);
      const skip = report.skipped ?? 0;
      const skipPart = skip > 0 ? `（跳过 ${skip} 条已存在）` : "";
      setImportMsg({
        kind: "ok",
        text: `${name} 导入完成：新增 ${report.files} 个文件${skipPart} → ${report.dest}`,
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
    setImportReport(null);
    setImportMsg({
      kind: "info",
      text: "正在通过 osascript 读取 Notes.app…（首次会弹系统授权对话框）",
    });
    try {
      const report = await api.importAppleNotes(activeWorkspace.path);
      setImportReport(report);
      const skip = report.skipped ?? 0;
      const skipPart = skip > 0 ? `（跳过 ${skip} 篇已存在）` : "";
      setImportMsg({
        kind: "ok",
        text: `Apple Notes 导入完成：新增 ${report.files} 篇${skipPart} → ${report.dest}`,
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
        <CardTitle tip="增量导入到 imports/<provider>/；指纹记在 .markio/imports.json，同条目下次不会再写入。Notion/Roam/Bear 选 ZIP，印象笔记选 ENEX，Obsidian/Logseq 选目录。">
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
        {!__MARKIO_MAS__ &&
          typeof navigator !== "undefined" &&
          navigator.platform.startsWith("Mac") && (
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
        {importReport && (
          <div className="import-report">
            <div className="import-report-h">
              <div>
                <div className="import-report-title">导入报告</div>
                <div className="import-report-sub">
                  新增 {importReport.files} 个文件
                  {importReport.skipped && importReport.skipped > 0
                    ? ` · 跳过 ${importReport.skipped} 条（已存在）`
                    : ""}
                  {" · "}
                  {importReport.warnings.length} 条警告
                </div>
              </div>
              <div className="import-report-actions">
                <button
                  type="button"
                  className="settings-btn"
                  onClick={() => void api.reveal(importReport.dest)}
                >
                  打开目录
                </button>
                {importReport.reportPath && (
                  <button
                    type="button"
                    className="settings-btn"
                    onClick={() => void api.reveal(importReport.reportPath!)}
                  >
                    打开报告
                  </button>
                )}
                <button
                  type="button"
                  className="settings-btn"
                  onClick={() => void writeText(importReportText(importReport))}
                >
                  复制
                </button>
              </div>
            </div>
            <div className="import-report-path">{importReport.dest}</div>
            {importReport.warnings.length > 0 ? (
              <ul className="import-report-warnings">
                {importReport.warnings.map((warning, index) => (
                  <li key={`${index}-${warning}`}>{warning}</li>
                ))}
              </ul>
            ) : (
              <div className="import-report-empty">未产生警告。</div>
            )}
          </div>
        )}
      </div>

      <LegacyImportsCard
        workspacePath={activeWorkspace?.path ?? null}
        onTrashed={() =>
          activeWorkspace
            ? refreshTree(activeWorkspace.id).catch(() => undefined)
            : undefined
        }
      />
    </>
  );
}

function LegacyImportsCard({
  workspacePath,
  onTrashed,
}: {
  workspacePath: string | null;
  onTrashed: () => void;
}) {
  const [list, setList] = useState<
    | null
    | {
        path: string;
        provider: string;
        stamp: string;
        sizeBytes: number;
        fileCount: number;
      }[]
  >(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const confirmDialog = useDialog((s) => s.confirm);

  const refresh = async () => {
    if (!workspacePath) {
      setList([]);
      return;
    }
    try {
      const r = await api.importListLegacyDirs(workspacePath);
      setList(r);
    } catch (e) {
      setMsg(`✗ ${(e as Error).message}`);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacePath]);

  if (!workspacePath) return null;
  const items = list ?? [];
  const totalBytes = items.reduce((s, it) => s + it.sizeBytes, 0);
  const totalFiles = items.reduce((s, it) => s + it.fileCount, 0);
  const fmtSize = (n: number) =>
    n >= 1024 * 1024
      ? `${(n / 1024 / 1024).toFixed(1)} MB`
      : n >= 1024
        ? `${Math.round(n / 1024)} KB`
        : `${n} B`;

  const purgeAll = async () => {
    if (items.length === 0) return;
    const ok = await confirmDialog({
      title: `清理 ${items.length} 个旧导入目录？`,
      message: `共 ${totalFiles} 个文件 · ${fmtSize(totalBytes)}\n会移动到 .markio/trash，可在回收站恢复。`,
      confirmLabel: "移到回收站",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setMsg(null);
    let done = 0;
    let failed = 0;
    for (const it of items) {
      try {
        await api.importTrashLegacyDir(workspacePath, it.path);
        done += 1;
      } catch {
        failed += 1;
      }
    }
    setBusy(false);
    setMsg(
      failed === 0
        ? `✓ 已移走 ${done} 个目录`
        : `已移走 ${done} 个，${failed} 个失败`,
    );
    await refresh();
    onTrashed();
  };

  const purgeOne = async (path: string) => {
    setBusy(true);
    try {
      await api.importTrashLegacyDir(workspacePath, path);
      setMsg("✓ 已移到回收站");
      await refresh();
      onTrashed();
    } catch (e) {
      setMsg(`✗ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-card">
      <CardTitle tip="增量导入切换前留下的 imports/<provider>-<stamp>/ 目录。清理走 .markio/trash，可恢复。">
        旧的全量导入目录
      </CardTitle>
      {items.length === 0 ? (
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">
              {list === null ? "扫描中…" : "没有发现旧目录"}
            </div>
            <div className="settings-help">
              当前 workspace 下 imports/ 里没有形如 <code>provider-YYYYMMDD-HHMMSS</code>{" "}
              的目录。
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="settings-row settings-row-action">
            <div className="settings-row-l">
              <div className="settings-label">
                共 {items.length} 个目录 · {totalFiles} 文件 · {fmtSize(totalBytes)}
              </div>
              <div className="settings-help">
                {msg ?? "全部移到 .markio/trash；可在回收站逐个恢复。"}
              </div>
            </div>
            <button
              type="button"
              className="settings-btn primary"
              disabled={busy}
              onClick={purgeAll}
            >
              {busy ? "处理中…" : "全部清理"}
            </button>
          </div>
          <ul className="legacy-import-list">
            {items.map((it) => (
              <li key={it.path}>
                <div className="lic-l">
                  <div className="lic-name">
                    {it.provider}
                    <span className="lic-stamp">{it.stamp}</span>
                  </div>
                  <div className="lic-meta">
                    {it.fileCount} 文件 · {fmtSize(it.sizeBytes)}
                  </div>
                  <div className="lic-path">{it.path}</div>
                </div>
                <div className="lic-actions">
                  <button
                    type="button"
                    className="settings-btn"
                    onClick={() => void api.reveal(it.path)}
                  >
                    打开
                  </button>
                  <button
                    type="button"
                    className="settings-btn"
                    disabled={busy}
                    onClick={() => void purgeOne(it.path)}
                  >
                    移到回收站
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
