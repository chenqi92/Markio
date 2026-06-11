import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../ui/Icon";
import { useVaultIndex } from "@/stores/vaultIndex";
import { useWorkspace } from "@/stores/workspace";
import { useTabs } from "@/stores/tabs";
import { useUI } from "@/stores/ui";
import { useDialog } from "@/stores/dialog";
import { renameTag } from "@/lib/tag-ops";
import { ContextMenu } from "../popovers/ContextMenu";
import { writeText } from "@/lib/clipboard";
import { api } from "@/lib/api";

type SortMode = "refs" | "alpha";

interface TagEntry {
  tag: string;
  count: number;
  /** 引用此 tag 的 (wsId, path, fileName) */
  refs: Array<{ wsId: string; wsName: string; path: string; fileName: string }>;
}

/** 跨仓库的 #tag 全景：vault index 在 Rust 端已经为每个 .md 抽好 tags 数组，
 *  这里聚合 + 计数 + 渲染。点击 tag 展开右侧详情；rename / merge 留给后续。 */
export function TagLandscape() {
  const { t } = useTranslation();
  const workspaces = useWorkspace((s) => s.workspaces);
  const setActive = useWorkspace((s) => s.setActive);
  const openPath = useTabs((s) => s.openPath);
  const indexMap = useVaultIndex((s) => s.index);
  const ensure = useVaultIndex((s) => s.ensure);
  const scheduleRebuild = useVaultIndex((s) => s.scheduleRebuild);
  const setToast = useUI((s) => s.setToast);
  const openGlobalSearch = useUI((s) => s.openGlobalSearch);
  const promptDialog = useDialog((s) => s.prompt);
  const confirmDialog = useDialog((s) => s.confirm);

  const [sortMode, setSortMode] = useState<SortMode>("refs");
  const [filter, setFilter] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "renaming" | "merging">(null);
  const [ctx, setCtx] = useState<{ x: number; y: number; tag: string } | null>(
    null,
  );
  const [refCtx, setRefCtx] = useState<
    | { x: number; y: number; path: string; wsId: string }
    | null
  >(null);

  // 切到本 tab 时确保索引已构建
  useEffect(() => {
    for (const ws of workspaces) {
      void ensure(ws.path);
    }
  }, [workspaces, ensure]);

  const entries = useMemo<TagEntry[]>(() => {
    const map = new Map<string, TagEntry>();
    for (const ws of workspaces) {
      const idx = indexMap[ws.path];
      if (!idx) continue;
      for (const f of idx.files) {
        for (const tag of f.tags) {
          const cur = map.get(tag) ?? { tag, count: 0, refs: [] };
          cur.count += 1;
          cur.refs.push({
            wsId: ws.id,
            wsName: ws.name,
            path: f.path,
            fileName: f.name,
          });
          map.set(tag, cur);
        }
      }
    }
    return Array.from(map.values());
  }, [indexMap, workspaces]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const matched = q
      ? entries.filter((e) => e.tag.toLowerCase().includes(q))
      : entries;
    return matched.slice().sort((a, b) => {
      if (sortMode === "alpha") return a.tag.localeCompare(b.tag);
      return b.count - a.count || a.tag.localeCompare(b.tag);
    });
  }, [entries, filter, sortMode]);

  // 字号映射：min 11 / max 22，按 log(count) 拉伸
  const sizeFor = (n: number): number => {
    if (filtered.length === 0) return 12;
    const maxC = filtered[0]?.count ?? 1;
    if (maxC <= 1) return 12;
    const t = Math.log(n) / Math.log(maxC);
    return Math.round(11 + t * 11);
  };

  const active = activeTag ? entries.find((e) => e.tag === activeTag) ?? null : null;

  const flash = (stage: "done" | "error", message: string, ms = stage === "error" ? 2500 : 1500) => {
    setToast({ stage, message }, ms);
  };

  /** 在所有相关仓库重建 vault index（拿到新 tag 后让标签云立即更新）。 */
  const rebuildAffectedIndexes = (paths: string[]) => {
    const wsPaths = new Set<string>();
    for (const w of workspaces) {
      if (paths.some((p) => p.startsWith(w.path))) wsPaths.add(w.path);
    }
    for (const wp of wsPaths) scheduleRebuild(wp);
  };

  /** 重命名当前 tag。新 tag 已存在 = 走合并语义。 */
  const doRename = async () => {
    if (!active) return;
    const next = await promptDialog({
      title: t("tagLandscape.renameTitle"),
      message: t("tagLandscape.renameMessage", { tag: active.tag, count: active.count }),
      defaultValue: active.tag,
      confirmLabel: t("tagLandscape.rename"),
    });
    if (!next || next.trim() === active.tag) return;
    const newTag = next.trim().replace(/^#+/, "");
    if (!/^[\w一-鿿./-]+$/.test(newTag)) {
      flash("error", t("tagLandscape.invalidChars"));
      return;
    }
    setBusy("renaming");
    try {
      const paths = active.refs.map((r) => r.path);
      const result = await renameTag(paths, active.tag, newTag);
      rebuildAffectedIndexes(paths);
      if (result.failed) {
        flash(
          "error",
          t("tagLandscape.failedAt", {
            done: result.changed.length,
            next: result.changed.length + 1,
            message: result.failed.message,
          }),
        );
      } else {
        flash(
          "done",
          t("tagLandscape.doneChanged", {
            changed: result.changed.length,
            skipped: result.skipped.length,
          }),
        );
        setActiveTag(newTag);
      }
    } finally {
      setBusy(null);
    }
  };

  /** 合并到另一个 tag（要求目标 tag 已经在标签云里）。 */
  const doMerge = async () => {
    if (!active) return;
    const target = await promptDialog({
      title: t("tagLandscape.mergeTitle"),
      message: t("tagLandscape.mergeMessage", { tag: active.tag, count: active.count }),
      defaultValue: "",
      confirmLabel: t("tagLandscape.merge"),
    });
    if (!target || target.trim() === active.tag) return;
    const newTag = target.trim().replace(/^#+/, "");
    if (!/^[\w一-鿿./-]+$/.test(newTag)) {
      flash("error", t("tagLandscape.invalidChars"));
      return;
    }
    const ok = await confirmDialog({
      title: t("tagLandscape.mergeConfirmTitle"),
      message: t("tagLandscape.mergeConfirmMessage", {
        from: active.tag,
        to: newTag,
        count: active.refs.length,
      }),
      confirmLabel: t("tagLandscape.merge"),
      danger: true,
    });
    if (!ok) return;
    setBusy("merging");
    try {
      const paths = active.refs.map((r) => r.path);
      const result = await renameTag(paths, active.tag, newTag);
      rebuildAffectedIndexes(paths);
      if (result.failed) {
        flash(
          "error",
          t("tagLandscape.failedAt", {
            done: result.changed.length,
            next: result.changed.length + 1,
            message: result.failed.message,
          }),
        );
      } else {
        flash("done", t("tagLandscape.doneMerged", { changed: result.changed.length }));
        setActiveTag(newTag);
      }
    } finally {
      setBusy(null);
    }
  };

  const doFilterSearch = () => {
    if (!active) return;
    openGlobalSearch(true);
    // GlobalSearch 没有 tag 预填的入参；用户在那里手动加 tag 筛选。
    // 这里把 tag 文本塞进剪贴板做个轻量交接。
    void navigator.clipboard?.writeText(`#${active.tag}`).catch(() => undefined);
    flash("done", t("tagLandscape.searchHinted", { tag: active.tag }));
  };

  const totalCount = entries.length;

  return (
    <div className="tag-cloud-pane">
      <div className="ti-h">
        <div className="ti-title">
          {t("tagLandscape.title")}
          <span className="ti-count">{totalCount}</span>
        </div>
      </div>

      <div className="ti-toolbar">
        <input
          type="text"
          className="ti-search"
          placeholder={t("tagLandscape.filter")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className="ti-groupby" role="group" aria-label="排序">
          {(["refs", "alpha"] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={"ti-gb-btn" + (sortMode === m ? " active" : "")}
              onClick={() => setSortMode(m)}
            >
              {m === "refs" ? t("tagLandscape.sortRefs") : t("tagLandscape.sortAlpha")}
            </button>
          ))}
        </div>
      </div>

      <div className="tag-cloud-list">
        {filtered.length === 0 ? (
          <div className="ti-empty">
            {workspaces.length === 0
              ? t("tagLandscape.emptyNoWorkspace")
              : t("tagLandscape.emptyNoTags")}
          </div>
        ) : (
          <div className="tag-cloud">
            {filtered.map((e) => (
              <button
                key={e.tag}
                type="button"
                className={
                  "tag-chip" + (activeTag === e.tag ? " active" : "")
                }
                style={{ fontSize: sizeFor(e.count) }}
                onClick={() =>
                  setActiveTag((cur) => (cur === e.tag ? null : e.tag))
                }
                onContextMenu={(ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  setActiveTag(e.tag);
                  setCtx({ x: ev.clientX, y: ev.clientY, tag: e.tag });
                }}
                title={`${e.count} 处引用`}
              >
                #{e.tag}
                <span className="tag-chip-cnt">{e.count}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {active && (
        <div className="tag-detail">
          <div className="tag-detail-h">
            <span className="tag-detail-name">#{active.tag}</span>
            <span className="tag-detail-cnt">{active.count} 处</span>
            <button
              type="button"
              className="ti-refresh"
              onClick={() => setActiveTag(null)}
              title={t("tagLandscape.collapse")}
            >
              <Icon name="x" size={11} />
            </button>
          </div>
          <div className="tag-detail-actions">
            <button
              type="button"
              onClick={() => void doRename()}
              disabled={busy !== null}
            >
              {busy === "renaming" ? t("tagLandscape.renaming") : t("tagLandscape.rename")}
            </button>
            <button
              type="button"
              onClick={() => void doMerge()}
              disabled={busy !== null}
            >
              {busy === "merging" ? t("tagLandscape.merging") : t("tagLandscape.merge")}
            </button>
            <button
              type="button"
              onClick={() => doFilterSearch()}
              disabled={busy !== null}
            >
              {t("tagLandscape.filterSearch")}
            </button>
          </div>
          <div className="tag-detail-list">
            {active.refs.slice(0, 30).map((r, i) => (
              <button
                key={`${r.path}:${i}`}
                type="button"
                className="tag-ref"
                onClick={async () => {
                  setActive(r.wsId);
                  try {
                    await openPath(r.path);
                  } catch {
                    /* ignore */
                  }
                }}
                onContextMenu={(ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  setRefCtx({
                    x: ev.clientX,
                    y: ev.clientY,
                    path: r.path,
                    wsId: r.wsId,
                  });
                }}
                title={r.path}
              >
                <span className="tag-ref-f">{r.fileName}</span>
                <span className="tag-ref-ws">{r.wsName}</span>
              </button>
            ))}
            {active.refs.length > 30 && (
              <div className="ti-empty" style={{ padding: "8px 4px", fontSize: 10.5 }}>
                {t("tagLandscape.remainingHidden", { count: active.refs.length - 30 })}
              </div>
            )}
          </div>
        </div>
      )}
      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          onClose={() => setCtx(null)}
          items={[
            {
              label: t("tagLandscape.rename") + "…",
              icon: "edit",
              disabled: busy !== null,
              onClick: () => void doRename(),
            },
            {
              label: t("tagLandscape.merge") + "…",
              icon: "diagram",
              disabled: busy !== null,
              onClick: () => void doMerge(),
            },
            {
              label: t("tagLandscape.filterSearch"),
              icon: "search",
              onClick: () => doFilterSearch(),
            },
            { sep: true },
            {
              label: "复制 #tag",
              icon: "copy",
              onClick: async () => {
                try {
                  await writeText(`#${ctx.tag}`);
                  flash("done", "已复制");
                } catch {
                  /* ignore */
                }
              },
            },
          ]}
        />
      )}
      {refCtx && (
        <ContextMenu
          x={refCtx.x}
          y={refCtx.y}
          onClose={() => setRefCtx(null)}
          items={[
            {
              label: "打开",
              icon: "external",
              onClick: async () => {
                setActive(refCtx.wsId);
                try {
                  await openPath(refCtx.path);
                } catch {
                  /* ignore */
                }
              },
            },
            {
              label: "在 Finder 中显示",
              icon: "folder-open",
              onClick: () => {
                void api.reveal(refCtx.path);
              },
            },
            {
              label: "复制路径",
              icon: "copy",
              onClick: async () => {
                try {
                  await writeText(refCtx.path);
                  flash("done", "已复制路径");
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
