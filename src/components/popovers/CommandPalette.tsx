import { useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "../ui/Icon";
import { useUI } from "@/stores/ui";
import { useTabs } from "@/stores/tabs";
import { useWorkspace } from "@/stores/workspace";
import { useSettings } from "@/stores/settings";
import { useRecents } from "@/stores/recents";
import { useVaultIndex } from "@/stores/vaultIndex";
import { useDialog } from "@/stores/dialog";
import { pickDirectory, type VaultFile } from "@/lib/api";
import { smartChannelQuery } from "@/lib/smartChannel";
import { openDailyNote, openDailyRelative } from "@/lib/daily";
import { exportVaultSite } from "@/lib/siteExport";
import { effectiveBinding, formatBinding } from "@/lib/shortcuts";
import { displayPath } from "@/lib/utils";
import { isLocalAgentEnabled } from "@/lib/ai-region-policy";
import type { ViewMode } from "@/types";
import { THEMES } from "@/themes";

interface Cmd {
  id: string;
  group: string;
  l1: string;
  l2: string;
  kbd?: string[];
  ico: IconName;
  run: () => void;
}

/** 在已建好的 vault index 里做客户端过滤，避免每次输入触发一次 Rust grep。 */
function findFiles(files: VaultFile[] | undefined, q: string, limit: number): VaultFile[] {
  if (!files || !q) return [];
  const needle = q.toLowerCase();
  const out: VaultFile[] = [];
  for (const f of files) {
    if (out.length >= limit) break;
    if (f.name.toLowerCase().includes(needle) || f.stem.toLowerCase().includes(needle)) {
      out.push(f);
    }
  }
  return out;
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const ws = useWorkspace((s) => s.activeWorkspace());
  const ensureVaultIndex = useVaultIndex((s) => s.ensure);
  const vaultFiles = useVaultIndex((s) => (ws ? s.index[ws.path]?.files : undefined));
  const recents = useRecents((s) => s.items);

  useEffect(() => {
    if (ws) void ensureVaultIndex(ws.path);
  }, [ws, ensureVaultIndex]);
  const setMode = useUI((s) => s.setMode);
  const toggleFocus = useUI((s) => s.toggleFocus);
  const openSettings = useUI((s) => s.openSettings);
  const openFind = useUI((s) => s.openFind);
  const openPulse = useUI((s) => s.openPulse);
  const openAgent = useUI((s) => s.openAgent);
  const setTheme = useSettings((s) => s.setTheme);
  const overrides = useSettings((s) => s.shortcutOverrides);
  const addWorkspace = useWorkspace((s) => s.addWorkspace);
  const openFile = useTabs((s) => s.openFile);
  const saveActive = useTabs((s) => s.saveActive);
  const promptDialog = useDialog((s) => s.prompt);

  const baseCommands: Cmd[] = useMemo(
    () => [
      {
        id: "view-source",
        group: "视图",
        l1: "切换到源码模式",
        l2: "纯 markdown 源码",
        kbd: formatBinding(effectiveBinding("app.viewSource", overrides)),
        ico: "code",
        run: () => setMode("source" as ViewMode),
      },
      {
        id: "view-split",
        group: "视图",
        l1: "切换到分屏模式",
        l2: "左源码 · 右预览",
        kbd: formatBinding(effectiveBinding("app.viewSplit", overrides)),
        ico: "split",
        run: () => setMode("split" as ViewMode),
      },
      {
        id: "view-wysiwyg",
        group: "视图",
        l1: "切换到所见即所得",
        l2: "BlockNote rich editor（Notion 风格）",
        kbd: formatBinding(effectiveBinding("app.viewWysiwyg", overrides)),
        ico: "sparkle",
        run: () => setMode("wysiwyg" as ViewMode),
      },
      {
        id: "focus",
        group: "视图",
        l1: "切换专注模式",
        l2: "隐藏工具栏与面包屑",
        kbd: formatBinding(effectiveBinding("app.toggleFocus", overrides)),
        ico: "focus",
        run: () => toggleFocus(),
      },
      {
        id: "find",
        group: "文档",
        l1: "在当前文档中查找…",
        l2: "高亮匹配项",
        kbd: formatBinding(effectiveBinding("app.findInFile", overrides)),
        ico: "search",
        run: () => openFind(true),
      },
      {
        id: "save",
        group: "文档",
        l1: "保存当前文档",
        l2: "写入磁盘",
        kbd: formatBinding(effectiveBinding("app.save", overrides)),
        ico: "save",
        run: () => saveActive(),
      },
      {
        id: "open-daily",
        group: "文档",
        l1: "打开今日日记",
        l2: "Daily/YYYY-MM-DD.md（无则按模板新建）",
        kbd: formatBinding(effectiveBinding("app.openDaily", overrides)),
        ico: "sun",
        run: () => void openDailyNote(),
      },
      {
        id: "daily-prev",
        group: "文档",
        l1: "前一天日记",
        l2: "相对当前日记（或今天）往前一天",
        ico: "calendar",
        run: () => void openDailyRelative(-1),
      },
      {
        id: "daily-next",
        group: "文档",
        l1: "后一天日记",
        l2: "相对当前日记（或今天）往后一天",
        ico: "calendar",
        run: () => void openDailyRelative(1),
      },
      {
        id: "open-folder",
        group: "仓库",
        l1: "打开文件夹…",
        l2: "选择一个目录作为新的仓库",
        ico: "folder-open",
        run: async () => {
          const dir = await pickDirectory();
          if (dir) await addWorkspace(dir);
        },
      },
      {
        id: "export-site",
        group: "仓库",
        l1: "导出为静态站点…",
        l2: "整库渲染成相互链接的 HTML（可发布到 Cloudflare Pages / 自托管）",
        ico: "upload",
        run: async () => {
          const { setToast } = useUI.getState();
          const cur = useWorkspace.getState().activeWorkspace();
          if (!cur) {
            setToast({ stage: "error", message: "请先打开一个仓库" }, 2000);
            return;
          }
          const dir = await pickDirectory();
          if (!dir) return;
          await useVaultIndex.getState().ensure(cur.path);
          const all = useVaultIndex.getState().index[cur.path]?.files ?? [];
          if (all.length === 0) {
            setToast({ stage: "error", message: "仓库里没有可导出的文件" }, 2500);
            return;
          }
          setToast({ stage: "uploading", message: "导出静态站点…" });
          try {
            const res = await exportVaultSite(
              cur.path,
              cur.name,
              all,
              dir,
              (done, total) =>
                useUI
                  .getState()
                  .setToast({ stage: "uploading", message: `导出 ${done}/${total}…` }),
            );
            useUI.getState().setToast(
              {
                stage: res.failed ? "error" : "done",
                message:
                  `已导出 ${res.written}/${res.total} 页` +
                  (res.failed ? `，${res.failed} 失败` : "") +
                  ` → ${dir}`,
              },
              3500,
            );
          } catch (e) {
            useUI
              .getState()
              .setToast({ stage: "error", message: `导出失败：${(e as Error).message}` }, 3000);
          }
        },
      },
      {
        id: "settings",
        group: "应用",
        l1: "打开设置",
        l2: "主题、字号、快捷键…",
        kbd: formatBinding(effectiveBinding("app.openSettings", overrides)),
        ico: "settings",
        run: () => openSettings(true),
      },
      {
        id: "pulse",
        group: "视图",
        l1: "打开时间线",
        l2: "按时间浏览仓库所有历史快照",
        ico: "clock",
        run: () => openPulse(true),
      },
      ...(isLocalAgentEnabled()
        ? [
            {
              id: "agent",
              group: "AI",
              l1: "本地 Agent…",
              l2: "spawn 本地 CLI 操作 vault",
              ico: "bot",
              run: () => openAgent(true),
            } satisfies Cmd,
          ]
        : []),
      {
        id: "smart-channel-query",
        group: "AI",
        l1: "通过智能通道查询当前仓库",
        l2: "把当前问题发给智能通道，AI 会基于仓库内容回答",
        ico: "flame",
        run: async () => {
          const query = await promptDialog({
            title: "智能通道查询",
            message: "输入问题，AI 会基于当前仓库检索后回答。",
            placeholder: "想问什么？",
            confirmLabel: "查询",
          });
          if (!query || !query.trim()) return;
          const { setToast } = useUI.getState();
          setToast({ stage: "uploading", message: "智能通道查询中…" });
          try {
            const res = await smartChannelQuery({ query: query.trim() });
            setToast({
              stage: "done",
              message: `智能通道：${res.answer.replace(/\s+/g, " ").slice(0, 80)}${res.answer.length > 80 ? "…" : ""}`,
            });
            // 短摘要 toast 不够看，把全文也打到控制台，方便排查
            console.info("[smart-channel] 回答：", res.answer, res.refs);
          } catch (e) {
            setToast({ stage: "error", message: `智能通道：${(e as Error).message}` });
          }
        },
      },
      ...THEMES.map(
        (t): Cmd => ({
          id: `theme-${t.id}`,
          group: "主题",
          l1: `切换到 ${t.name}`,
          l2: t.isDark ? "深色调色板" : "浅色调色板",
          ico: "palette",
          run: () => setTheme(t.id),
        }),
      ),
    ],
    [
      setMode,
      toggleFocus,
      openFind,
      saveActive,
      addWorkspace,
      openSettings,
      openPulse,
      openAgent,
      promptDialog,
      setTheme,
      overrides,
    ],
  );

  // 客户端文件名过滤 —— 不再触发 Rust grep，瞬时返回
  const fileMatches = useMemo(() => {
    if (q.length < 1) return [];
    return findFiles(vaultFiles, q, 25);
  }, [q, vaultFiles]);

  const visible: Cmd[] = useMemo(() => {
    const lower = q.toLowerCase();
    const filtered = q
      ? baseCommands.filter(
          (c) =>
            c.l1.toLowerCase().includes(lower) ||
            c.l2.toLowerCase().includes(lower),
        )
      : baseCommands;
    const fileCmds: Cmd[] = fileMatches.map((h) => ({
      id: `file:${h.path}`,
      group: "文件",
      l1: h.name,
      l2: displayPath(h.path),
      ico: "note",
      run: () => {
        if (ws) openFile(ws.id, h.path);
      },
    }));
    // 无 query 时把最近打开排前
    const recentCmds: Cmd[] = q
      ? []
      : recents
          .filter((r) => !ws || r.workspaceId === ws.id)
          .slice(0, 8)
          .map((r) => ({
            id: `recent:${r.path}`,
            group: "最近打开",
            l1: r.name,
            l2: displayPath(r.path),
            ico: "clock",
            run: () => {
              if (ws) openFile(ws.id, r.path);
            },
          }));
    const list = q ? [...fileCmds, ...filtered] : [...recentCmds, ...filtered];
    // 按分组「首次出现顺序」稳定重排，使扁平索引与分组渲染顺序一致。
    // 否则 group 声明非连续时（如 视图 组夹在 应用 组后面），方向键的 sel
    // 会在视觉上向上/向下乱跳。
    const order: string[] = [];
    const byGroup = new Map<string, Cmd[]>();
    for (const it of list) {
      if (!byGroup.has(it.group)) {
        byGroup.set(it.group, []);
        order.push(it.group);
      }
      byGroup.get(it.group)!.push(it);
    }
    return order.flatMap((g) => byGroup.get(g)!);
  }, [q, baseCommands, fileMatches, recents, ws, openFile]);

  useEffect(() => {
    setSel(0);
  }, [q]);

  // 键盘移动高亮时把当前项滚进可见区（与 GlobalSearch 一致）
  useEffect(() => {
    itemRefs.current[sel]?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      // IME 组字中（中文/日文/韩文）的 Enter/方向键/Escape 是在操作候选词，
      // 不能让它执行命令或关闭面板。
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSel((s) => Math.min(visible.length - 1, s + 1));
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSel((s) => Math.max(0, s - 1));
      }
      if (e.key === "Enter") {
        e.preventDefault();
        visible[sel]?.run();
        onClose();
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [visible, sel, onClose]);

  // 预先把全局 index 绑到每条，避免在渲染时对每个 item 调用 visible.indexOf(it)（O(N²)）
  const visibleWithIdx = useMemo(
    () => visible.map((it, idx) => ({ item: it, idx })),
    [visible],
  );
  const grouped: Record<string, Array<{ item: Cmd; idx: number }>> = {};
  visibleWithIdx.forEach((entry) => {
    (grouped[entry.item.group] = grouped[entry.item.group] || []).push(entry);
  });

  return (
    <div className="scrim" onClick={onClose}>
      <div className="cmdk" onClick={(e) => e.stopPropagation()}>
        <div className="cmdk-search">
          <Icon name="search" size={16} />
          <input
            autoFocus
            placeholder="搜索命令、文件、主题…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <span className="esc">esc</span>
        </div>
        <div className="cmdk-body">
          {visible.length === 0 ? (
            <div className="cmdk-empty">没有匹配项</div>
          ) : (
            Object.entries(grouped).map(([g, items]) => (
              <div key={g}>
                <div className="cmdk-group-h">{g}</div>
                {items.map(({ item: it, idx }) => (
                  <button
                    type="button"
                    key={it.id}
                    ref={(el) => {
                      itemRefs.current[idx] = el;
                    }}
                    className={"cmdk-item" + (idx === sel ? " sel" : "")}
                    onClick={() => {
                      it.run();
                      onClose();
                    }}
                    onMouseEnter={() => setSel(idx)}
                  >
                    <div className="ico">
                      <Icon name={it.ico} size={14} />
                    </div>
                    <div className="lbl">
                      <div className="l1">{it.l1}</div>
                      <div className="l2">{it.l2}</div>
                    </div>
                    {it.kbd && (
                      <div className="kbd">
                        {it.kbd.map((k, i) => (
                          <span key={i}>{k}</span>
                        ))}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
