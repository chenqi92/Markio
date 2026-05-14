import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SourceEditor } from "./SourceEditor";
import { Preview } from "../preview/Preview";
import { BubbleMenu } from "../popovers/BubbleMenu";
import { SlashMenu } from "../popovers/SlashMenu";
import { Autocomplete, type AcKind } from "../popovers/Autocomplete";
import { useTabs } from "@/stores/tabs";
import { useUI } from "@/stores/ui";
import { useSettings } from "@/stores/settings";
import { useWorkspace } from "@/stores/workspace";
import { api } from "@/lib/api";
import { getEditor, replaceRange } from "@/lib/editor-bridge";
import { detectTable } from "./table-edit";
import { TableToolbar } from "../popovers/TableToolbar";
import { classNames, debounce } from "@/lib/utils";
import { Outline } from "../layout/Outline";
import type { OutlineItem, ViewMode } from "@/types";

interface Props {
  onMeta?: (meta: { outline: OutlineItem[]; words: number; readingMinutes: number }) => void;
  onAskAi: () => void;
}

const MODE_CLASS: Record<ViewMode, string> = {
  source: "source-only",
  split: "split",
  wysiwyg: "wysiwyg",
  preview: "preview-only",
};

const MAX_PASTE_IMAGES = 8;
const MAX_PASTE_IMAGE_BYTES = 25 * 1024 * 1024;

function scrollRatio(info: { top: number; height: number; clientHeight: number }) {
  const max = Math.max(0, info.height - info.clientHeight);
  return max <= 0 ? 0 : Math.max(0, Math.min(1, info.top / max));
}

function buildS3Key(notePath: string, fileName?: string): string {
  const stem = (fileName || "image").replace(/[^a-zA-Z0-9._-]+/g, "-");
  const noteStem =
    notePath
      .split(/[/\\]/)
      .pop()
      ?.replace(/\.[^./]+$/, "")
      .replace(/[^a-zA-Z0-9._-]+/g, "-") || "note";
  const ts = Date.now();
  return `markio/${noteStem}/${ts}-${stem}`;
}

function fileToBase64(file: File): Promise<string> {
  if (file.size > MAX_PASTE_IMAGE_BYTES) {
    return Promise.reject(
      new Error(`图片过大：单张最大 ${Math.floor(MAX_PASTE_IMAGE_BYTES / 1024 / 1024)} MB`),
    );
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("无法读取剪贴板图片"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.includes(",") ? result.split(",").pop() ?? "" : result);
    };
    reader.readAsDataURL(file);
  });
}

export function EditorArea({ onMeta, onAskAi }: Props) {
  const tab = useTabs((s) => s.activeTab());
  const updateContent = useTabs((s) => s.updateContent);
  const saveTab = useTabs((s) => s.saveTab);
  const workspaces = useWorkspace((s) => s.workspaces);
  const mode = useUI((s) => s.mode);
  const setToast = useUI((s) => s.setToast);
  const autosave = useSettings((s) => s.autosave);
  const autosaveDelayMs = useSettings((s) => s.autosaveDelayMs);
  const shortcutStyle = useSettings((s) => s.shortcutStyle);
  const workspace = useMemo(
    () => (tab ? workspaces.find((w) => w.id === tab.workspaceId) : undefined),
    [tab, workspaces],
  );
  const syncNonce = useRef(0);
  const [scrollSync, setScrollSync] = useState<{
    target: "source" | "preview";
    ratio: number;
    nonce: number;
  } | null>(null);
  const [meta, setMeta] = useState<{
    outline: OutlineItem[];
    words: number;
    readingMinutes: number;
  }>({ outline: [], words: 0, readingMinutes: 1 });
  const [bubble, setBubble] = useState<{ x: number; y: number } | null>(null);
  const [slash, setSlash] = useState<{ x: number; y: number } | null>(null);
  const [tableTb, setTableTb] = useState<{
    x: number;
    y: number;
    align: "left" | "center" | "right" | null;
  } | null>(null);
  const [ac, setAc] = useState<{
    kind: AcKind;
    query: string;
    triggerLen: number;
    x: number;
    y: number;
  } | null>(null);

  const onMetaInternal = useCallback(
    (m: { outline: OutlineItem[]; words: number; readingMinutes: number }) => {
      setMeta(m);
      onMeta?.(m);
    },
    [onMeta],
  );

  const renderMode = mode;

  useEffect(() => {
    if (renderMode !== "split") setScrollSync(null);
  }, [renderMode]);

  const handleSourceScroll = useCallback(
    (info: { top: number; height: number; clientHeight: number }) => {
      if (renderMode !== "split") return;
      setScrollSync({
        target: "preview",
        ratio: scrollRatio(info),
        nonce: ++syncNonce.current,
      });
    },
    [renderMode],
  );

  const handlePreviewScroll = useCallback(
    (info: { top: number; height: number; clientHeight: number }) => {
      if (renderMode !== "split") return;
      setScrollSync({
        target: "source",
        ratio: scrollRatio(info),
        nonce: ++syncNonce.current,
      });
    },
    [renderMode],
  );

  const handlePasteImages = useCallback(
    async (files: File[], range: { from: number; to: number }) => {
      if (!tab || !workspace) {
        setToast({ stage: "error", message: "请先打开一个仓库文件" });
        setTimeout(() => setToast(null), 2200);
        return;
      }
      const settings = useSettings.getState();
      const acceptedFiles = files.slice(0, MAX_PASTE_IMAGES);
      const skipped = files.length - acceptedFiles.length;
      setToast({ stage: "uploading", message: "正在处理剪贴板图片..." });
      try {
        const markdown: string[] = [];
        const warnings: string[] =
          skipped > 0 ? [`一次最多插入 ${MAX_PASTE_IMAGES} 张图片，已跳过 ${skipped} 张`] : [];
        for (const file of acceptedFiles) {
          const dataBase64 = await fileToBase64(file);
          // 第一步：始终走 Rust image_paste 写到本地 Assets/（带可选压缩）；
          // upload=false 时不调 PicGo，由前端决定是否再走 S3 直传
          const usePicgo = settings.uploadProvider === "picgo" && settings.picgoPasteUpload;
          const useS3 =
            settings.uploadProvider === "s3" &&
            !!settings.s3Endpoint &&
            !!settings.s3Bucket;
          const r = await api.pasteImage({
            workspace: workspace.path,
            note: tab.path,
            fileName: file.name || undefined,
            mime: file.type || "image/png",
            dataBase64,
            upload: usePicgo,
            keepLocal: settings.picgoKeepLocalCopy,
            endpoint: settings.picgoEndpoint,
            compress: settings.picgoCompressBeforeUpload,
            quality: settings.picgoQuality,
          });
          let finalMarkdown = r.markdown;
          if (useS3 && r.localPath) {
            try {
              const key = buildS3Key(tab.path, file.name);
              const url = await api.s3PutObject(
                {
                  endpoint: settings.s3Endpoint,
                  region: settings.s3Region,
                  bucket: settings.s3Bucket,
                  accessKeyId: settings.s3AccessKeyId,
                  secretAccessKey: "", // 走 keychain
                  publicBaseUrl: settings.s3PublicBaseUrl || undefined,
                  pathStyle: settings.s3PathStyle,
                },
                key,
                dataBase64,
                file.type || "image/png",
              );
              const alt = (file.name || "image").replace(/\.[^./]+$/, "");
              finalMarkdown = `![${alt}](${url})`;
            } catch (e) {
              warnings.push(`S3 上传失败：${String(e)}（已保留本地副本）`);
            }
          }
          markdown.push(finalMarkdown);
          if (r.warning) warnings.push(r.warning);
        }
        if (useTabs.getState().activeId !== tab.id) return;
        replaceRange(range.from, range.to, markdown.join("\n"));
        useWorkspace.getState().refreshTree(tab.workspaceId).catch(() => undefined);
        setToast({
          stage: warnings.length > 0 ? "error" : "done",
          message: warnings[0] ?? "图片已插入",
        });
        setTimeout(() => setToast(null), warnings.length > 0 ? 3200 : 1800);
      } catch (e) {
        setToast({
          stage: "error",
          message: `图片处理失败：${(e as Error).message}`,
        });
        setTimeout(() => setToast(null), 3000);
      }
    },
    [setToast, tab, workspace],
  );

  const handleEditorDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      const dt = e.dataTransfer;
      if (!dt || dt.files.length === 0) return;
      const images = Array.from(dt.files).filter((f) =>
        f.type.startsWith("image/"),
      );
      if (images.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const view = getEditor();
      const pos =
        view?.posAtCoords({ x: e.clientX, y: e.clientY }) ??
        view?.state.doc.length ??
        0;
      await handlePasteImages(images, { from: pos, to: pos });
    },
    [handlePasteImages],
  );

  // 自动保存：按设置里的延迟写盘
  const tabId = tab?.id;
  const dirty = tab?.dirty;
  const debouncedSave = useMemo(
    () =>
      debounce((id: string) => {
        if (!useSettings.getState().autosave) return;
        saveTab(id).catch(() => undefined);
      }, autosaveDelayMs),
    [autosaveDelayMs, saveTab],
  );
  useEffect(() => {
    if (!autosave || !tabId || !dirty) return;
    debouncedSave(tabId);
  }, [tabId, dirty, autosave, debouncedSave, tab?.content]);

  if (!tab) {
    return null;
  }

  const showSource =
    renderMode === "source" ||
    renderMode === "split" ||
    renderMode === "wysiwyg";
  const showPreview = renderMode === "preview" || renderMode === "split";

  const allowBubble =
    shortcutStyle === "all" || shortcutStyle === "bubble";
  const allowSlash = shortcutStyle === "all" || shortcutStyle === "slash";

  return (
    <div className={classNames("editor-split", MODE_CLASS[mode])}>
      {showSource && (
        <div
          className="editor-pane"
          onDragOver={(e) => {
            if (Array.from(e.dataTransfer.types).includes("Files")) {
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
            }
          }}
          onDrop={handleEditorDrop}
        >
          <SourceEditor
            value={tab.content}
            wysiwyg={renderMode === "wysiwyg"}
            onChange={(v) => updateContent(tab.id, v)}
            onScroll={handleSourceScroll}
            scrollTarget={
              scrollSync?.target === "source"
                ? { ratio: scrollSync.ratio, nonce: scrollSync.nonce }
                : null
            }
            onPasteImages={handlePasteImages}
            onSelectionChange={(info) => {
              if (!allowBubble) {
                setBubble(null);
              } else if (!info.hasSelection || !info.coords) {
                setBubble(null);
              } else {
                setBubble(info.coords);
              }
              // 表格 toolbar：cursor 落在表格行就显示
              const view = getEditor();
              if (view) {
                const tab = detectTable(view);
                if (tab) {
                  const r = view.coordsAtPos(
                    view.state.selection.main.head,
                  );
                  if (r) {
                    setTableTb({
                      x: r.left,
                      y: Math.max(8, r.top - 36),
                      align: tab.aligns[tab.cursorCol] ?? null,
                    });
                    return;
                  }
                }
              }
              setTableTb(null);
            }}
            onSlashTrigger={
              allowSlash ? (coords) => setSlash(coords) : undefined
            }
            onAutocompleteUpdate={(s) => {
              if (!s) {
                setAc(null);
                return;
              }
              setAc({
                kind: s.kind,
                query: s.query,
                triggerLen: s.triggerLen,
                x: s.coords.x,
                y: s.coords.y,
              });
            }}
          />
        </div>
      )}
      {showPreview && (
        <Preview
          source={tab.content}
          basePath={tab.path}
          onMeta={onMetaInternal}
          onScroll={handlePreviewScroll}
          scrollTarget={
            scrollSync?.target === "preview"
              ? { ratio: scrollSync.ratio, nonce: scrollSync.nonce }
              : null
          }
        />
      )}
      <Outline
        items={meta.outline}
        words={meta.words}
        readingMinutes={meta.readingMinutes}
      />
      {bubble && (
        <BubbleMenu
          x={bubble.x}
          y={bubble.y}
          onAskAi={() => {
            setBubble(null);
            onAskAi();
          }}
          onClose={() => setBubble(null)}
        />
      )}
      {tableTb && (
        <TableToolbar x={tableTb.x} y={tableTb.y} align={tableTb.align} />
      )}
      {slash && (
        <SlashMenu
          x={slash.x}
          y={slash.y}
          onClose={() => setSlash(null)}
        />
      )}
      {ac && (
        <Autocomplete
          kind={ac.kind}
          query={ac.query}
          triggerLen={ac.triggerLen}
          x={ac.x}
          y={ac.y}
          onClose={() => setAc(null)}
        />
      )}
    </div>
  );
}
