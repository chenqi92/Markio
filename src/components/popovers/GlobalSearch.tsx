import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../ui/Icon";
import { useUI } from "@/stores/ui";
import { useTabs } from "@/stores/tabs";
import { useWorkspace } from "@/stores/workspace";
import { useDialog } from "@/stores/dialog";
import { useVaultIndex } from "@/stores/vaultIndex";
import { api, type VaultFile } from "@/lib/api";
import { shortcutText } from "@/lib/shortcuts";
import type { GrepHit } from "@/types";

const MAX_GLOBAL_SEARCH_RESULTS = 200;
const SAVED_KEY = "markio.savedSearches.v1";

type FileExtFilter = "all" | "md" | "txt";
type ScopeFilter = "current" | "all";
type TimeFilter = "all" | "7d" | "30d" | "90d" | "1y";

const TIME_OPTIONS: Array<{ id: TimeFilter; label: string; days?: number }> = [
  { id: "all", label: "全部" },
  { id: "7d", label: "7 天", days: 7 },
  { id: "30d", label: "30 天", days: 30 },
  { id: "90d", label: "90 天", days: 90 },
  { id: "1y", label: "1 年", days: 365 },
];

interface SavedSearch {
  id: string;
  name: string;
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  scope: ScopeFilter;
  ext: FileExtFilter;
  /** v2 增字段；老条目里可能为 undefined，过滤层走 fallback 处理 */
  tags?: string[];
  time?: TimeFilter;
  createdAt: number;
}

interface HitWithMeta extends GrepHit {
  wsId: string;
  wsName: string;
}

function loadSaved(): SavedSearch[] {
  try {
    const raw = localStorage.getItem(SAVED_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as SavedSearch[];
  } catch {
    return [];
  }
}

function persistSaved(list: SavedSearch[]) {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(list));
  } catch {
    /* ignore quota */
  }
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 把命中文行按搜索词高亮成 [{text, hit}] 段 */
function highlightSegments(
  preview: string,
  pattern: RegExp | string,
): Array<{ text: string; hit: boolean }> {
  if (!preview) return [{ text: "", hit: false }];
  const re =
    pattern instanceof RegExp
      ? pattern
      : new RegExp(escapeForRegex(pattern), "gi");
  const parts: Array<{ text: string; hit: boolean }> = [];
  let last = 0;
  // 防止 zero-width loop
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(preview))) {
    if (m.index > last) {
      parts.push({ text: preview.slice(last, m.index), hit: false });
    }
    parts.push({ text: m[0] || "", hit: true });
    last = m.index + (m[0]?.length || 1);
    if (!re.global) break;
    if (m[0] === "") re.lastIndex++;
  }
  if (last < preview.length) parts.push({ text: preview.slice(last), hit: false });
  return parts;
}

/**
 * 全文搜索（⌘⇧F）：Aa/W/.* 三个客户端切换 + 范围 / 类型 / 标签 / 时间 4 个面筛选 +
 * 「保存为智能文件夹」。Rust grep 拉宽到当前仓库或全部仓库，前端按 facet 过滤。
 */
export function GlobalSearch({ onClose }: { onClose: () => void }) {
  const ws = useWorkspace((s) => s.activeWorkspace());
  const workspaces = useWorkspace((s) => s.workspaces);
  const setActive = useWorkspace((s) => s.setActive);
  const openFile = useTabs((s) => s.openFile);
  const setFindQuery = useUI((s) => s.setFindQuery);
  const openFind = useUI((s) => s.openFind);
  const jumpToLine = useUI((s) => s.jumpToLine);
  const promptDialog = useDialog((s) => s.prompt);

  const [q, setQ] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [scope, setScope] = useState<ScopeFilter>("current");
  const [ext, setExt] = useState<FileExtFilter>("all");
  const [tagSel, setTagSel] = useState<Set<string>>(() => new Set());
  const [timeSel, setTimeSel] = useState<TimeFilter>("all");
  const indexMap = useVaultIndex((s) => s.index);
  const ensureIndex = useVaultIndex((s) => s.ensure);
  const [hits, setHits] = useState<HitWithMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const [saved, setSaved] = useState<SavedSearch[]>(() => loadSaved());
  const seqRef = useRef(0);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // 实际发给 Rust 的查询：Aa/W/.* 都用客户端正则过滤实现，发给 Rust 的串保持简单
  // (因为 fs_grep 没暴露这些开关)。先用宽松的 plain 子串拉回候选，再前端过滤。
  useEffect(() => {
    const trimmed = q.trim();
    if (!ws || trimmed.length < 2) {
      setHits([]);
      setErr(null);
      return;
    }
    setLoading(true);
    setErr(null);
    const seq = ++seqRef.current;
    const t = setTimeout(async () => {
      try {
        const targetWss = scope === "all" ? workspaces : [ws];
        const all: HitWithMeta[] = [];
        for (const w of targetWss) {
          // 拿一个最宽的 anchor 串：去掉特殊字符的 plain 部分，至少 2 字符
          const anchor = trimmed.replace(/[\\^$.*+?()[\]{}|]/g, "").slice(0, 80) || trimmed;
          const r = await api.grep(w.path, anchor, MAX_GLOBAL_SEARCH_RESULTS);
          for (const h of r) all.push({ ...h, wsId: w.id, wsName: w.name });
        }
        if (seq !== seqRef.current) return;
        setHits(all);
      } catch (e) {
        if (seq !== seqRef.current) return;
        setErr((e as Error).message);
        setHits([]);
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    }, 220);
    return () => clearTimeout(t);
  }, [q, ws?.path, scope, workspaces]);

  // 三个 toggle 共同决定的客户端筛选正则
  const filterRegex = useMemo<RegExp | null>(() => {
    const trimmed = q.trim();
    if (trimmed.length < 1) return null;
    try {
      const flags = caseSensitive ? "g" : "gi";
      let src = regex ? trimmed : escapeForRegex(trimmed);
      if (wholeWord) src = `\\b${src}\\b`;
      return new RegExp(src, flags);
    } catch {
      return null;
    }
  }, [q, caseSensitive, wholeWord, regex]);

  // 进入面板时确保活动仓库的 vault index 在内存里——标签 / 时间 facet 都靠它
  useEffect(() => {
    for (const w of scope === "all" ? workspaces : ws ? [ws] : []) {
      void ensureIndex(w.path);
    }
  }, [scope, workspaces, ws, ensureIndex]);

  /** 命中文件路径 → VaultFile 的快查表，按当前 scope 范围聚合。 */
  const pathToVaultFile = useMemo<Map<string, VaultFile>>(() => {
    const map = new Map<string, VaultFile>();
    const targets = scope === "all" ? workspaces : ws ? [ws] : [];
    for (const w of targets) {
      const idx = indexMap[w.path];
      if (!idx) continue;
      for (const f of idx.files) map.set(f.path, f);
    }
    return map;
  }, [indexMap, workspaces, ws, scope]);

  /** 仅展示"命中文件里出现过"的标签，按引用数排序——避免动辄上千 tag 灌满面板。 */
  const availableTags = useMemo<Array<{ tag: string; count: number }>>(() => {
    const counter = new Map<string, number>();
    for (const h of hits) {
      const vf = pathToVaultFile.get(h.path);
      if (!vf) continue;
      for (const tag of vf.tags) {
        counter.set(tag, (counter.get(tag) ?? 0) + 1);
      }
    }
    return Array.from(counter.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
      .slice(0, 40);
  }, [hits, pathToVaultFile]);

  /** mtime 截止戳；timeSel = all 时为 0。 */
  const mtimeFloor = useMemo<number>(() => {
    const opt = TIME_OPTIONS.find((o) => o.id === timeSel);
    if (!opt?.days) return 0;
    return Date.now() - opt.days * 86_400_000;
  }, [timeSel]);

  // 应用 facets + 客户端正则
  const filtered = useMemo<HitWithMeta[]>(() => {
    if (!filterRegex) return [];
    const tags = tagSel;
    return hits.filter((h) => {
      // 扩展名
      if (ext !== "all") {
        const e = h.name.toLowerCase();
        if (ext === "md" && !/\.(md|markdown|mdown|mkd)$/i.test(e)) return false;
        if (ext === "txt" && !/\.txt$/i.test(e)) return false;
      }
      // 标签：命中文件必须包含所有选中的 tag (AND)
      if (tags.size > 0) {
        const vf = pathToVaultFile.get(h.path);
        if (!vf) return false;
        for (const t of tags) {
          if (!vf.tags.includes(t)) return false;
        }
      }
      // 时间：mtime 在窗口内
      if (mtimeFloor > 0) {
        const vf = pathToVaultFile.get(h.path);
        // 没在 index 里 = 文件刚加 / index 还没刷，宽松通过
        if (vf && vf.mtime > 0 && vf.mtime * 1000 < mtimeFloor) return false;
      }
      // 文本正则
      filterRegex.lastIndex = 0;
      return filterRegex.test(h.preview);
    });
  }, [hits, filterRegex, ext, tagSel, mtimeFloor, pathToVaultFile]);

  const toggleTag = (tag: string) => {
    setTagSel((cur) => {
      const next = new Set(cur);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  };

  useEffect(() => setSel(0), [filtered.length]);

  const openHit = async (h: HitWithMeta) => {
    if (h.wsId !== ws?.id) setActive(h.wsId);
    await openFile(h.wsId, h.path);
    if (h.line > 0) jumpToLine(h.path, h.line);
    setFindQuery(q.trim());
    openFind(true);
    onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSel((s) => Math.min(filtered.length - 1, s + 1));
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSel((s) => Math.max(0, s - 1));
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (filtered[sel]) void openHit(filtered[sel]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filtered, sel, onClose]);

  useEffect(() => {
    itemRefs.current[sel]?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const grouped = useMemo(() => {
    const map = new Map<string, HitWithMeta[]>();
    for (const h of filtered) {
      const arr = map.get(h.path) ?? [];
      arr.push(h);
      map.set(h.path, arr);
    }
    return map;
  }, [filtered]);

  const saveCurrent = async () => {
    const trimmed = q.trim();
    if (!trimmed) return;
    const name = await promptDialog({
      title: "保存为智能文件夹",
      message: "给这个搜索起一个名字，下次直接调用。",
      defaultValue: trimmed.slice(0, 32),
      confirmLabel: "保存",
    });
    if (!name) return;
    const next: SavedSearch = {
      id: `s_${Date.now().toString(36)}`,
      name,
      query: trimmed,
      caseSensitive,
      wholeWord,
      regex,
      scope,
      ext,
      tags: Array.from(tagSel),
      time: timeSel,
      createdAt: Date.now(),
    };
    const list = [...saved, next];
    setSaved(list);
    persistSaved(list);
  };

  const loadSavedSearch = (s: SavedSearch) => {
    setQ(s.query);
    setCaseSensitive(s.caseSensitive);
    setWholeWord(s.wholeWord);
    setRegex(s.regex);
    setScope(s.scope);
    setExt(s.ext);
    setTagSel(new Set(s.tags ?? []));
    setTimeSel(s.time ?? "all");
  };

  const removeSaved = (id: string) => {
    const list = saved.filter((s) => s.id !== id);
    setSaved(list);
    persistSaved(list);
  };

  return (
    <div className="scrim" onClick={onClose}>
      <div
        className="cmdk gs-wide"
        style={{ width: 960 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cmdk-search">
          <Icon name="search" size={16} />
          <input
            autoFocus
            placeholder={
              ws ? `搜索 ${scope === "all" ? "所有仓库" : ws.name}…` : "请先打开一个仓库"
            }
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="gs-tog">
            <button
              type="button"
              className={"gs-tog-btn" + (caseSensitive ? " on" : "")}
              onClick={() => setCaseSensitive((v) => !v)}
              title="区分大小写"
            >
              Aa
            </button>
            <button
              type="button"
              className={"gs-tog-btn" + (wholeWord ? " on" : "")}
              onClick={() => setWholeWord((v) => !v)}
              title="全词匹配"
            >
              W
            </button>
            <button
              type="button"
              className={"gs-tog-btn" + (regex ? " on" : "")}
              onClick={() => setRegex((v) => !v)}
              title="正则"
            >
              .*
            </button>
          </div>
          <span className="esc">{shortcutText("⌘⇧F")}</span>
        </div>

        <div className="gs-body">
          {/* 左侧 facets */}
          <aside className="gs-facets">
            <div className="gs-facet">
              <div className="gs-facet-h">范围</div>
              <button
                type="button"
                className={"gs-facet-opt" + (scope === "current" ? " on" : "")}
                onClick={() => setScope("current")}
              >
                当前仓库
              </button>
              <button
                type="button"
                className={"gs-facet-opt" + (scope === "all" ? " on" : "")}
                onClick={() => setScope("all")}
              >
                所有仓库 ({workspaces.length})
              </button>
            </div>

            <div className="gs-facet">
              <div className="gs-facet-h">类型</div>
              {(["all", "md", "txt"] as const).map((e) => (
                <button
                  key={e}
                  type="button"
                  className={"gs-facet-opt" + (ext === e ? " on" : "")}
                  onClick={() => setExt(e)}
                >
                  {e === "all" ? "全部" : `.${e}`}
                </button>
              ))}
            </div>

            <div className="gs-facet">
              <div className="gs-facet-h">
                标签
                {tagSel.size > 0 && (
                  <button
                    type="button"
                    className="gs-facet-clear"
                    onClick={() => setTagSel(new Set())}
                    title="清除选中"
                  >
                    清除 ({tagSel.size})
                  </button>
                )}
              </div>
              {availableTags.length === 0 ? (
                <div className="gs-facet-note">
                  命中文件还没扫到 #tag（或 vault 索引还在构建）
                </div>
              ) : (
                <div className="gs-tag-cloud">
                  {availableTags.map((t) => (
                    <button
                      key={t.tag}
                      type="button"
                      className={
                        "gs-tag-chip" + (tagSel.has(t.tag) ? " on" : "")
                      }
                      onClick={() => toggleTag(t.tag)}
                    >
                      #{t.tag}
                      <span className="cnt">{t.count}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="gs-facet">
              <div className="gs-facet-h">时间</div>
              {TIME_OPTIONS.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  className={"gs-facet-opt" + (timeSel === o.id ? " on" : "")}
                  onClick={() => setTimeSel(o.id)}
                >
                  {o.label}
                </button>
              ))}
            </div>

            <div className="gs-facet">
              <div className="gs-facet-h">已保存</div>
              {saved.length === 0 ? (
                <div className="gs-facet-note">点下方「保存」把当前搜索存为智能文件夹</div>
              ) : (
                saved.map((s) => (
                  <div key={s.id} className="gs-saved">
                    <button
                      type="button"
                      className="gs-saved-load"
                      onClick={() => loadSavedSearch(s)}
                      title={`${s.query} · ${s.scope === "all" ? "所有" : "当前"} · ${s.ext}`}
                    >
                      {s.name}
                    </button>
                    <button
                      type="button"
                      className="gs-saved-del"
                      onClick={() => removeSaved(s.id)}
                      title="删除"
                    >
                      <Icon name="x" size={10} />
                    </button>
                  </div>
                ))
              )}
            </div>
          </aside>

          {/* 主结果列表 */}
          <div className="gs-results">
            {!ws ? (
              <div className="cmdk-empty">还没打开任何仓库</div>
            ) : q.trim().length < 2 ? (
              <div className="cmdk-empty">输入 ≥ 2 个字符开始搜索…</div>
            ) : loading ? (
              <div className="cmdk-empty">扫描中…</div>
            ) : err ? (
              <div className="cmdk-empty" style={{ color: "#ff453a" }}>
                {err}
              </div>
            ) : filtered.length === 0 ? (
              <div className="cmdk-empty">没有匹配项</div>
            ) : (
              <>
                <div className="cmdk-group-h">
                  {hits.length >= MAX_GLOBAL_SEARCH_RESULTS && filtered.length === hits.length
                    ? `显示前 ${MAX_GLOBAL_SEARCH_RESULTS} 处命中`
                    : `${filtered.length} 处命中`}{" "}
                  · {grouped.size} 个文件
                  <button
                    type="button"
                    className="gs-save"
                    onClick={() => void saveCurrent()}
                    disabled={!q.trim()}
                    title="把当前搜索 + 筛选保存到「已保存」列表"
                  >
                    保存
                  </button>
                </div>
                {filtered.map((h, i) => (
                  <button
                    type="button"
                    ref={(el) => {
                      itemRefs.current[i] = el;
                    }}
                    key={i}
                    className={"cmdk-item" + (i === sel ? " sel" : "")}
                    onClick={() => void openHit(h)}
                    onMouseEnter={() => setSel(i)}
                  >
                    <div className="ico">
                      <Icon name="note" size={14} />
                    </div>
                    <div className="lbl">
                      <div className="l1">
                        {h.name}
                        {h.line > 0 && (
                          <span
                            style={{
                              marginLeft: 8,
                              fontSize: 11,
                              color: "var(--text-3)",
                              fontFamily: "var(--font-mono)",
                            }}
                          >
                            : {h.line}
                          </span>
                        )}
                        {scope === "all" && (
                          <span
                            style={{
                              marginLeft: 8,
                              fontSize: 10,
                              color: "var(--text-4)",
                              padding: "1px 5px",
                              border: "0.5px solid var(--border)",
                              borderRadius: 4,
                            }}
                          >
                            {h.wsName}
                          </span>
                        )}
                      </div>
                      <div className="l2">
                        {filterRegex
                          ? highlightSegments(h.preview || h.path, filterRegex).map(
                              (seg, k) =>
                                seg.hit ? (
                                  <mark key={k} className="gs-hl">
                                    {seg.text}
                                  </mark>
                                ) : (
                                  <span key={k}>{seg.text}</span>
                                ),
                            )
                          : h.preview || h.path}
                      </div>
                    </div>
                  </button>
                ))}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
