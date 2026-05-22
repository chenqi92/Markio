import { useState } from "react";
import { crumbSegments, displayPath } from "@/lib/utils";
import { useWorkspace } from "@/stores/workspace";
import { useTabs } from "@/stores/tabs";
import { useUI } from "@/stores/ui";
import { api } from "@/lib/api";
import { writeText } from "@/lib/clipboard";
import { ContextMenu } from "../popovers/ContextMenu";

export function Crumb() {
  const ws = useWorkspace((s) => s.activeWorkspace());
  const tabPath = useTabs((s) => {
    const id = s.activeId;
    return id ? s.tabs.find((t) => t.id === id)?.path : undefined;
  });
  const setToast = useUI((s) => s.setToast);
  const [ctx, setCtx] = useState<
    { x: number; y: number; absPath: string; isLeaf: boolean } | null
  >(null);

  if (!ws || !tabPath) return null;
  const segs = crumbSegments(ws.path, tabPath);
  if (segs.length === 0) return null;

  const flash = (msg: string) => {
    setToast({ stage: "done", message: msg });
    setTimeout(() => setToast(null), 1500);
  };

  // 在仓库根之下还原每段对应的绝对路径：第 0 段 = ws.path，后续累加。
  // 路径分隔符按平台用 ws.path 已有的；这里统一回退到 "/" 兼容跨平台。
  const sep = ws.path.includes("\\") ? "\\" : "/";
  const absFor = (i: number): string => {
    if (i === 0) return ws.path;
    return ws.path + sep + segs.slice(1, i + 1).join(sep);
  };

  return (
    <>
      <div className="crumb" title={displayPath(tabPath)}>
        {segs.map((s, i) => {
          const isLeaf = i === segs.length - 1;
          return (
            <span
              key={i}
              style={{ display: "inline-flex", alignItems: "center" }}
            >
              <span
                className={"seg" + (isLeaf ? " current" : "")}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setCtx({
                    x: e.clientX,
                    y: e.clientY,
                    absPath: absFor(i),
                    isLeaf,
                  });
                }}
              >
                {s}
              </span>
              {i < segs.length - 1 && <span className="sep">›</span>}
            </span>
          );
        })}
      </div>
      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          onClose={() => setCtx(null)}
          items={[
            {
              label: ctx.isLeaf ? "在 Finder 中显示" : "在 Finder 中打开此目录",
              icon: "folder-open",
              onClick: () => {
                void api.reveal(ctx.absPath);
              },
            },
            {
              label: ctx.isLeaf ? "复制文件路径" : "复制目录路径",
              icon: "copy",
              onClick: async () => {
                try {
                  await writeText(ctx.absPath);
                  flash("已复制路径");
                } catch {
                  /* ignore */
                }
              },
            },
          ]}
        />
      )}
    </>
  );
}
