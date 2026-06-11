import { useEffect, useState } from "react";
import { Icon, type IconName } from "../ui/Icon";
import { api } from "@/lib/api";
import { useWorkspace } from "@/stores/workspace";
import { useUI } from "@/stores/ui";
import { formatBytes } from "@/lib/utils";
import { writeText } from "@/lib/clipboard";
import { ContextMenu } from "../popovers/ContextMenu";
import type { Attachment } from "@/types";

const KIND_ICON: Record<Attachment["kind"], IconName> = {
  pdf: "file",
  image: "image",
  svg: "image",
  video: "file",
  audio: "file",
  word: "file",
  sheet: "table",
  slides: "image",
  archive: "archive",
};

function kindLabel(k: Attachment["kind"]): string {
  switch (k) {
    case "pdf":
      return "PDF";
    case "image":
      return "图";
    case "svg":
      return "SVG";
    case "video":
      return "视频";
    case "audio":
      return "音频";
    case "word":
      return "Word";
    case "sheet":
      return "表";
    case "slides":
      return "幻灯";
    case "archive":
      return "压缩";
  }
}

/**
 * 侧边栏「附件」分区：把 workspace 里非 markdown 的资源（图、PDF、视频…）平铺，
 * 默认折叠，展开后按修改时间倒序，最多 50 条。点击 → 在系统文件管理器里显示。
 */
export function AttachmentSection() {
  const ws = useWorkspace((s) => s.activeWorkspace());
  const setToast = useUI((s) => s.setToast);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(false);
  const [ctx, setCtx] = useState<{ x: number; y: number; a: Attachment } | null>(
    null,
  );

  const flash = (msg: string) => {
    setToast({ stage: "done", message: msg });
  };

  useEffect(() => {
    if (!open || !ws) return;
    let cancelled = false;
    setLoading(true);
    api
      .listAttachments(ws.path, 50)
      .then((r) => {
        if (!cancelled) setItems(r);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, ws]);

  if (!ws) return null;

  const onReveal = async (a: Attachment) => {
    try {
      await api.reveal(a.path);
    } catch (e) {
      setToast({
        stage: "error",
        message: `打开失败：${(e as Error).message}`,
      });
    }
  };

  return (
    <div className="attachment-section">
      <div
        className="tree-section"
        style={{ cursor: "pointer", marginTop: 6 }}
        onClick={() => setOpen((v) => !v)}
      >
        <span
          style={{
            display: "inline-block",
            width: 12,
            fontSize: 9,
            color: "var(--text-3)",
            transform: open ? "rotate(90deg)" : "none",
            transition: "transform 160ms",
          }}
        >
          ▸
        </span>
        <span style={{ flex: 1 }}>附件</span>
        {open && items.length > 0 && (
          <span className="count">{items.length}</span>
        )}
      </div>
      {open && (
        <>
          {loading ? (
            <div
              style={{
                padding: "8px 14px",
                fontSize: 11,
                color: "var(--text-3)",
              }}
            >
              扫描中…
            </div>
          ) : items.length === 0 ? (
            <div
              style={{
                padding: "8px 14px",
                fontSize: 11,
                color: "var(--text-3)",
              }}
            >
              空
            </div>
          ) : (
            items.map((a) => (
              <div
                key={a.path}
                className="tree-row"
                title={`${a.path}\n${formatBytes(a.size)}`}
                style={{ paddingLeft: 16 }}
                onClick={() => onReveal(a)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setCtx({ x: e.clientX, y: e.clientY, a });
                }}
              >
                <span className="chev" style={{ visibility: "hidden" }}>
                  <Icon name="chevron" size={11} />
                </span>
                <span className="ico">
                  <Icon name={KIND_ICON[a.kind]} size={13} />
                </span>
                <span className="lbl">{a.name}</span>
                <span
                  style={{
                    fontSize: 9,
                    color: "var(--text-4)",
                    padding: "0 4px",
                    border: "0.5px solid var(--border)",
                    borderRadius: 3,
                    flexShrink: 0,
                  }}
                >
                  {kindLabel(a.kind)}
                </span>
              </div>
            ))
          )}
        </>
      )}
      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          onClose={() => setCtx(null)}
          items={[
            {
              label: "在 Finder 中显示",
              icon: "folder-open",
              onClick: () => {
                void onReveal(ctx.a);
              },
            },
            {
              label: "复制路径",
              icon: "copy",
              onClick: async () => {
                try {
                  await writeText(ctx.a.path);
                  flash("已复制路径");
                } catch {
                  /* ignore */
                }
              },
            },
          ]}
        />
      )}
    </div>
  );
}
