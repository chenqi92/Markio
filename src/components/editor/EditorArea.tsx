import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
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
import {
  applyTableAction,
  detectTable,
  findAllTablesInText,
  tableCellSourcePos,
  type TableSelectionRect,
} from "./table-edit";
import { EditorSelection } from "@codemirror/state";
import { TableToolbar } from "../popovers/TableToolbar";
import { TableContextMenu } from "../popovers/TableContextMenu";
import { MathPreview } from "../popovers/MathPreview";
import type { MathContext } from "@/lib/math-context";
import { classNames, debounce } from "@/lib/utils";
import { Outline } from "../layout/Outline";
import type { OutlineItem, ViewMode } from "@/types";
import {
  scrollRatio as computeRatio,
  type ScrollInfo,
} from "@/lib/scrollSync";

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
const SPLIT_WIDTH_KEY = "markio.split.sourcePercent";

const scrollRatio = computeRatio;

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
  const scrollSyncFrame = useRef<number | null>(null);
  const scrollSyncLock = useRef<"source" | "preview" | null>(null);
  const scrollSyncLockTimer = useRef<number | null>(null);
  const splitRootRef = useRef<HTMLDivElement>(null);
  const editorPaneRef = useRef<HTMLDivElement>(null);
  const [splitSourcePercent, setSplitSourcePercent] = useState(() => {
    if (typeof window === "undefined") return 50;
    try {
      const saved = Number(window.localStorage.getItem(SPLIT_WIDTH_KEY));
      return Number.isFinite(saved) ? Math.max(25, Math.min(75, saved)) : 50;
    } catch {
      // 桌面 WebView 在隐身/磁盘满/Storage 被禁用时 getItem 也会抛
      return 50;
    }
  });
  const [scrollSync, setScrollSync] = useState<{
    target: "source" | "preview";
    line?: number;
    ratio?: number;
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
    row: number;
    col: number;
    rows: number;
    cols: number;
  } | null>(null);
  const [tableMenu, setTableMenu] = useState<{
    x: number;
    y: number;
    row: number;
    col: number;
    rows: number;
    cols: number;
    rect: TableSelectionRect | null;
  } | null>(null);
  const [ac, setAc] = useState<{
    kind: AcKind;
    query: string;
    triggerLen: number;
    x: number;
    y: number;
  } | null>(null);
  const [mathCtx, setMathCtx] = useState<MathContext | null>(null);

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

  // 持久化写入按 250ms 节流：拖分栏时 pointermove 可能每像素触发，
  // 立即写 localStorage 会冗余几十次并阻塞渲染线程。
  const splitPersistTimer = useRef<number | null>(null);
  const setSplitPercent = useCallback((next: number) => {
    const clamped = Math.max(25, Math.min(75, next));
    setSplitSourcePercent(clamped);
    if (splitPersistTimer.current !== null) {
      window.clearTimeout(splitPersistTimer.current);
    }
    splitPersistTimer.current = window.setTimeout(() => {
      splitPersistTimer.current = null;
      try {
        window.localStorage.setItem(SPLIT_WIDTH_KEY, String(Math.round(clamped * 10) / 10));
      } catch {
        // QuotaExceededError / SecurityError 时记忆失败不影响本次会话
      }
    }, 250);
  }, []);
  useEffect(() => {
    return () => {
      if (splitPersistTimer.current !== null) {
        window.clearTimeout(splitPersistTimer.current);
      }
    };
  }, []);

  const scheduleScrollSync = useCallback(
    (
      origin: "source" | "preview",
      target: "source" | "preview",
      info: ScrollInfo,
    ) => {
      if (renderMode !== "split") return;
      if (scrollSyncLock.current === origin) return;
      const ratio = scrollRatio(info);
      const line = info.topLine;
      if (scrollSyncFrame.current != null) {
        window.cancelAnimationFrame(scrollSyncFrame.current);
      }
      scrollSyncFrame.current = window.requestAnimationFrame(() => {
        scrollSyncFrame.current = null;
        scrollSyncLock.current = target;
        if (scrollSyncLockTimer.current != null) {
          window.clearTimeout(scrollSyncLockTimer.current);
        }
        scrollSyncLockTimer.current = window.setTimeout(() => {
          scrollSyncLock.current = null;
          scrollSyncLockTimer.current = null;
        }, 140);
        setScrollSync({
          target,
          line,
          ratio,
          nonce: ++syncNonce.current,
        });
      });
    },
    [renderMode],
  );

  useEffect(
    () => () => {
      if (scrollSyncFrame.current != null) window.cancelAnimationFrame(scrollSyncFrame.current);
      if (scrollSyncLockTimer.current != null) window.clearTimeout(scrollSyncLockTimer.current);
    },
    [],
  );

  const handleSourceScroll = useCallback(
    (info: ScrollInfo) => {
      scheduleScrollSync("source", "preview", info);
    },
    [scheduleScrollSync],
  );

  const handlePreviewScroll = useCallback(
    (info: ScrollInfo) => {
      scheduleScrollSync("preview", "source", info);
    },
    [scheduleScrollSync],
  );

  const handleSplitPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (renderMode !== "split") return;
      const root = splitRootRef.current;
      if (!root) return;
      e.preventDefault();
      const rect = root.getBoundingClientRect();
      const prevCursor = document.body.style.cursor;
      const prevUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const update = (clientX: number) => {
        if (rect.width <= 0) return;
        setSplitPercent(((clientX - rect.left) / rect.width) * 100);
      };
      update(e.clientX);

      const onMove = (event: PointerEvent) => update(event.clientX);
      const onUp = () => {
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevUserSelect;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [renderMode, setSplitPercent],
  );

  const handleSplitKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (renderMode !== "split") return;
      const step = e.shiftKey ? 8 : 2;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setSplitPercent(splitSourcePercent - step);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setSplitPercent(splitSourcePercent + step);
      } else if (e.key === "Home") {
        e.preventDefault();
        setSplitPercent(25);
      } else if (e.key === "End") {
        e.preventDefault();
        setSplitPercent(75);
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setSplitPercent(50);
      }
    },
    [renderMode, setSplitPercent, splitSourcePercent],
  );

  const splitStyle = useMemo(
    () =>
      renderMode === "split"
        ? ({ "--split-source": `${splitSourcePercent}%` } as CSSProperties)
        : undefined,
    [renderMode, splitSourcePercent],
  );

  const handlePasteImages = useCallback(
    async (
      files: File[],
      range: { from: number; to: number },
      trigger: "paste" | "drop" = "paste",
    ) => {
      if (!tab || !workspace) {
        setToast({ stage: "error", message: "请先打开一个仓库文件" });
        setTimeout(() => setToast(null), 2200);
        return;
      }
      const settings = useSettings.getState();
      const acceptedFiles = files.slice(0, MAX_PASTE_IMAGES);
      const skipped = files.length - acceptedFiles.length;
      const triggerLabel = trigger === "drop" ? "拖入" : "剪贴板";
      setToast({ stage: "uploading", message: `正在处理${triggerLabel}图片...` });
      const initialTabId = tab.id;
      try {
        const markdown: string[] = [];
        const warnings: string[] =
          skipped > 0 ? [`一次最多插入 ${MAX_PASTE_IMAGES} 张图片，已跳过 ${skipped} 张`] : [];
        for (const file of acceptedFiles) {
          // 用户切走当前 tab：不再为旧 tab 继续走 Rust pasteImage / S3 上传，
          // 避免浪费 Assets/ 空间和云带宽（IPC 已发出的那一张兜底还是会跑完）
          if (useTabs.getState().activeId !== initialTabId) {
            return;
          }
          const dataBase64 = await fileToBase64(file);
          // 第一步：始终走 Rust image_paste 写到本地 Assets/（带可选压缩）；
          // upload=false 时不调 PicGo，由前端决定是否再走 S3 直传
          const triggerEnabled =
            trigger === "drop" ? settings.picgoDragUpload : settings.picgoPasteUpload;
          const usePicgo = settings.uploadProvider === "picgo" && triggerEnabled;
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
      // Fallback：网页 / 应用内拖来的 File（OS 文件管理器在 Tauri 里
      // 不会触发 HTML5 drop，会被原生 onDragDropEvent 截获）
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
      await handlePasteImages(images, { from: pos, to: pos }, "drop");
    },
    [handlePasteImages],
  );

  // Tauri 原生拖入事件：从系统文件管理器拖入文件时，OS 不会触发 webview
  // 的 HTML5 drop（只能拿到 File blob 没 path），改走 Tauri 给的绝对路径。
  // - .md / .markdown / .txt → openPath
  // - 图片 → image_paste_from_disk + 在光标处插入 markdown
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let mounted = true;
    const tryRouteToTab = async (paths: string[]): Promise<string[]> => {
      const remaining: string[] = [];
      for (const p of paths) {
        const ext = p.toLowerCase().match(/\.([^.\\/]+)$/)?.[1];
        if (ext === "md" || ext === "markdown" || ext === "txt") {
          try {
            await useTabs.getState().openPath(p);
          } catch (e) {
            setToast({
              stage: "error",
              message: `打开 ${p.split(/[\\/]/).pop()} 失败：${(e as Error).message}`,
            });
            setTimeout(() => setToast(null), 2400);
          }
        } else {
          remaining.push(p);
        }
      }
      return remaining;
    };
    const handleDropPaths = async (
      paths: string[],
      pos: { x: number; y: number } | null,
    ) => {
      const pane = editorPaneRef.current;
      if (pane && pos) {
        const rect = pane.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const cssX = pos.x / dpr;
        const cssY = pos.y / dpr;
        if (
          cssX < rect.left ||
          cssX > rect.right ||
          cssY < rect.top ||
          cssY > rect.bottom
        ) {
          return; // 没落在编辑器面板上，不抢
        }
      }
      const imgPaths = await tryRouteToTab(paths);
      if (imgPaths.length === 0) return;
      const t = useTabs.getState().activeTab();
      const ws = t
        ? useWorkspace.getState().workspaces.find((w) => w.id === t.workspaceId)
        : undefined;
      if (!t || !ws) {
        setToast({ stage: "error", message: "请先打开一个仓库文件" });
        setTimeout(() => setToast(null), 2200);
        return;
      }
      const settings = useSettings.getState();
      const usePicgo =
        settings.uploadProvider === "picgo" && settings.picgoDragUpload;
      const view = getEditor();
      const insertPos =
        view?.state.selection.main.from ?? view?.state.doc.length ?? 0;
      const accepted = imgPaths
        .filter((p) => /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(p))
        .slice(0, MAX_PASTE_IMAGES);
      if (accepted.length === 0) return;
      setToast({ stage: "uploading", message: "正在处理拖入图片..." });
      const out: string[] = [];
      const warnings: string[] = [];
      try {
        for (const p of accepted) {
          const r = await api.pasteImageFromDisk({
            workspace: ws.path,
            note: t.path,
            srcPath: p,
            upload: usePicgo,
            keepLocal: settings.picgoKeepLocalCopy,
            endpoint: settings.picgoEndpoint,
            compress: settings.picgoCompressBeforeUpload,
            quality: settings.picgoQuality,
          });
          out.push(r.markdown);
          if (r.warning) warnings.push(r.warning);
        }
        if (useTabs.getState().activeId !== t.id) return;
        replaceRange(insertPos, insertPos, out.join("\n"));
        useWorkspace.getState().refreshTree(t.workspaceId).catch(() => undefined);
        setToast({
          stage: warnings.length > 0 ? "error" : "done",
          message: warnings[0] ?? `已插入 ${out.length} 张图片`,
        });
        setTimeout(() => setToast(null), warnings.length > 0 ? 3200 : 1800);
      } catch (e) {
        setToast({
          stage: "error",
          message: `图片处理失败：${(e as Error).message}`,
        });
        setTimeout(() => setToast(null), 3000);
      }
    };
    void (async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        const webview = getCurrentWebview();
        unlisten = await webview.onDragDropEvent((evt) => {
          if (!mounted) return;
          if (evt.payload.type !== "drop") return;
          const paths = evt.payload.paths;
          if (!paths || paths.length === 0) return;
          void handleDropPaths(paths, evt.payload.position ?? null);
        });
      } catch {
        // 非 Tauri 环境忽略
      }
    })();
    return () => {
      mounted = false;
      if (unlisten) unlisten();
    };
  }, [setToast]);

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

  const allowBubble =
    shortcutStyle === "all" || shortcutStyle === "bubble";
  const allowSlash = shortcutStyle === "all" || shortcutStyle === "slash";

  const handleContentChange = useCallback(
    (next: string) => {
      if (tabId) updateContent(tabId, next);
    },
    [tabId, updateContent],
  );

  const handleTableContextMenu = useCallback(
    (info: {
      coords: { x: number; y: number };
      row: number;
      col: number;
      rows: number;
      cols: number;
      rect: TableSelectionRect | null;
    }) => {
      setBubble(null);
      setSlash(null);
      setTableMenu({
        x: info.coords.x,
        y: info.coords.y,
        row: info.row,
        col: info.col,
        rows: info.rows,
        cols: info.cols,
        rect: info.rect,
      });
    },
    [],
  );

  const handleSelectionChange = useCallback(
    (info: {
      hasSelection: boolean;
      coords: { x: number; y: number } | null;
    }) => {
      if (!allowBubble) {
        setBubble(null);
      } else if (!info.hasSelection || !info.coords) {
        setBubble(null);
      } else {
        setBubble(info.coords);
      }
      // 表格 toolbar 不再由源码 cursor 触发；改由 Preview 中的 table hover 触发，
      // 见 handleTableHover —— 这样 toolbar 只会浮在渲染后的 table 上方，不污染 md 编辑区
    },
    [allowBubble],
  );

  // toolbar 自身 hover 时延迟消失：Preview 上 mouseleave + toolbar 上 mouseleave 都
  // 会调度一个 200ms 后清空的 timer；mouseenter 任一边都取消它
  const tbDismissTimerRef = useRef<number | null>(null);
  const cancelTbDismiss = useCallback(() => {
    if (tbDismissTimerRef.current != null) {
      window.clearTimeout(tbDismissTimerRef.current);
      tbDismissTimerRef.current = null;
    }
  }, []);
  const scheduleTbDismiss = useCallback(() => {
    cancelTbDismiss();
    tbDismissTimerRef.current = window.setTimeout(() => {
      tbDismissTimerRef.current = null;
      setTableTb(null);
    }, 220);
  }, [cancelTbDismiss]);
  useEffect(() => () => cancelTbDismiss(), [cancelTbDismiss]);

  const handleTableHover = useCallback(
    (info: { index: number; rect: DOMRect } | null) => {
      if (!info) {
        scheduleTbDismiss();
        return;
      }
      cancelTbDismiss();
      const view = getEditor();
      const src = view?.state.doc.toString() ?? tab?.content ?? "";
      const tables = findAllTablesInText(src);
      const target = tables[info.index];
      if (!target || !view) {
        setTableTb(null);
        return;
      }
      // 把 cursor 移到该表格首个数据行的首个单元格（跳过 header + 分隔行）
      // 这样 detectTable 能拿到 align/row/col，工具栏的所有 action 也作用在正确位置
      const dataLine = view.state.doc.line(
        Math.min(target.dataRowLine, view.state.doc.lines),
      );
      const firstCellPos = Math.min(dataLine.from + 2, dataLine.to);
      view.dispatch({
        selection: EditorSelection.cursor(firstCellPos),
        // 不滚动到位 —— Preview 已经在那张表上了，源码侧滚动会打断分栏同步
        scrollIntoView: false,
      });
      const tinfo = detectTable(view);
      if (!tinfo) {
        setTableTb(null);
        return;
      }
      setTableTb({
        x: info.rect.left + info.rect.width / 2,
        y: Math.max(8, info.rect.top - 38),
        align: tinfo.aligns[tinfo.cursorCol] ?? null,
        row: Math.max(0, tinfo.cursorRow),
        col: tinfo.cursorCol,
        rows: tinfo.cells.length,
        cols: tinfo.aligns.length,
      });
    },
    [cancelTbDismiss, scheduleTbDismiss, tab?.content],
  );

  // Preview 中右键 cell：把源码 cursor 移到对应 cell，再弹出已有的 TableContextMenu
  const handleTableCellContext = useCallback(
    (info: { tableIndex: number; row: number; col: number; x: number; y: number }) => {
      const view = getEditor();
      if (!view) return;
      const tables = findAllTablesInText(view.state.doc.toString());
      const target = tables[info.tableIndex];
      if (!target) return;
      const pos = tableCellSourcePos(view, target.topLine, info.row, info.col);
      if (pos == null) return;
      view.dispatch({
        selection: EditorSelection.cursor(pos),
        scrollIntoView: false,
      });
      // 拿一下当前 table info 用于 menu 标题
      const tinfo = detectTable(view);
      setBubble(null);
      setSlash(null);
      setTableTb(null);
      setTableMenu({
        x: info.x,
        y: info.y,
        row: tinfo ? Math.max(0, tinfo.cursorRow) : info.row,
        col: tinfo?.cursorCol ?? info.col,
        rows: tinfo?.cells.length ?? 1,
        cols: tinfo?.aligns.length ?? 1,
        rect: null,
      });
    },
    [],
  );

  // Preview 的 "+ 行 / + 列" 快捷按钮：定位到表格末尾对应位置后调用现有 applyTableAction
  const handleTableQuickAdd = useCallback(
    (info: { tableIndex: number; kind: "row" | "col"; after: number }) => {
      const view = getEditor();
      if (!view) return;
      const tables = findAllTablesInText(view.state.doc.toString());
      const target = tables[info.tableIndex];
      if (!target) return;
      // 行：定位到最后一行；列：定位到最后一列
      const row = info.kind === "row" ? info.after : 1;
      const col = info.kind === "col" ? info.after : 0;
      const pos = tableCellSourcePos(view, target.topLine, row, col);
      if (pos == null) return;
      view.dispatch({ selection: EditorSelection.cursor(pos), scrollIntoView: false });
      applyTableAction(
        view,
        info.kind === "row" ? { type: "insertRowBelow" } : { type: "insertColRight" },
      );
    },
    [],
  );

  const handleSlashTrigger = useCallback((coords: { x: number; y: number }) => {
    setSlash(coords);
  }, []);

  const handleAutocompleteUpdate = useCallback(
    (
      s:
        | {
            kind: AcKind;
            query: string;
            triggerLen: number;
            coords: { x: number; y: number };
          }
        | null,
    ) => {
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
    },
    [],
  );

  if (!tab) {
    return null;
  }

  const showSource =
    renderMode === "source" ||
    renderMode === "split" ||
    renderMode === "wysiwyg";
  const showPreview = renderMode === "preview" || renderMode === "split";

  return (
    <div
      ref={splitRootRef}
      className={classNames("editor-split", MODE_CLASS[mode])}
      style={splitStyle}
    >
      {showSource && (
        <div
          className="editor-pane"
          ref={editorPaneRef}
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
            onChange={handleContentChange}
            onScroll={handleSourceScroll}
            scrollTarget={
              scrollSync?.target === "source"
                ? {
                    nonce: scrollSync.nonce,
                    line: scrollSync.line,
                    ratio: scrollSync.ratio,
                  }
                : null
            }
            onPasteImages={handlePasteImages}
            onTableContextMenu={handleTableContextMenu}
            onSelectionChange={handleSelectionChange}
            onSlashTrigger={
              allowSlash ? handleSlashTrigger : undefined
            }
            onAutocompleteUpdate={handleAutocompleteUpdate}
            onMathContext={setMathCtx}
          />
        </div>
      )}
      {showSource && showPreview && (
        <div
          className="split-resizer"
          role="separator"
          aria-label="调整源码和预览分栏宽度"
          aria-orientation="vertical"
          aria-valuemin={25}
          aria-valuemax={75}
          aria-valuenow={Math.round(splitSourcePercent)}
          tabIndex={0}
          title="拖动调整分栏宽度，双击恢复 50/50"
          onPointerDown={handleSplitPointerDown}
          onDoubleClick={() => setSplitPercent(50)}
          onKeyDown={handleSplitKeyDown}
        />
      )}
      {showPreview && (
        <Preview
          source={tab.content}
          basePath={tab.path}
          onMeta={onMetaInternal}
          onScroll={handlePreviewScroll}
          scrollTarget={
            scrollSync?.target === "preview"
              ? {
                  nonce: scrollSync.nonce,
                  line: scrollSync.line,
                  ratio: scrollSync.ratio,
                }
              : null
          }
          onSourceChange={handleContentChange}
          onTableHover={handleTableHover}
          onTableCellContext={handleTableCellContext}
          onTableQuickAdd={handleTableQuickAdd}
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
        <TableToolbar
          x={tableTb.x}
          y={tableTb.y}
          align={tableTb.align}
          row={tableTb.row}
          col={tableTb.col}
          rows={tableTb.rows}
          cols={tableTb.cols}
          onMouseEnter={cancelTbDismiss}
          onMouseLeave={scheduleTbDismiss}
        />
      )}
      {tableMenu && (
        <TableContextMenu
          x={tableMenu.x}
          y={tableMenu.y}
          row={tableMenu.row}
          col={tableMenu.col}
          rows={tableMenu.rows}
          cols={tableMenu.cols}
          rect={tableMenu.rect}
          onClose={() => setTableMenu(null)}
        />
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
      {mathCtx && !bubble && !slash && !ac && (
        <MathPreview
          formula={mathCtx.formula}
          display={mathCtx.display}
          x={mathCtx.coords.x}
          y={mathCtx.coords.y}
        />
      )}
    </div>
  );
}
