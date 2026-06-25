import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { Icon } from "../ui/Icon";
import { useUI } from "@/stores/ui";
import { useTabs } from "@/stores/tabs";
import { useWorkspace } from "@/stores/workspace";
import { useDialog } from "@/stores/dialog";
import { useVaultIndex } from "@/stores/vaultIndex";
import { useSettings } from "@/stores/settings";
import { useRag } from "@/stores/rag";
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

/** 按顶层 `|` 拆分正则（不切 () 内或 [] 内的 |）。 */
function splitTopLevelAlternation(re: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inClass = false;
  let cur = "";
  for (let i = 0; i < re.length; i++) {
    const c = re[i]!;
    if (c === "\\") {
      cur += c + (re[i + 1] ?? "");
      i++;
      continue;
    }
    if (inClass) {
      cur += c;
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      cur += c;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "|" && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

const RE_META = /[\\^$.*+?()[\]{}|]/g;

/** 计算发给后端 fs_grep（字面子串匹配）的候选 anchor 列表。
 *  - 纯文本：直接用原串（含 C++ 这类含 + 的字面），不剥特殊字符；
 *  - 正则：按顶层 | 拆分，每个分支取字面核心并分别 grep 取并集，使候选集是真超集；
 *    任一分支无可用字面核心（如 .* / \d+）则退回旧的整串剥字符行为（尽力而为）。 */
function buildSearchAnchors(query: string, isRegex: boolean): string[] {
  if (!isRegex) return [query];
  const alts = splitTopLevelAlternation(query);
  const anchors: string[] = [];
  for (const alt of alts) {
    const lit = alt.replace(RE_META, "").slice(0, 80);
    if (lit.length >= 2) {
      anchors.push(lit);
    } else {
      const fallback = query.replace(RE_META, "").slice(0, 80) || query;
      return [fallback];
    }
  }
  return anchors.length ? Array.from(new Set(anchors)) : [query];
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

/** 单条搜索结果行。memo 化：鼠标移过列表时只有「旧选中 / 新选中」两行的 selected
 *  变了，其余行 props 不变 → 跳过重渲染，不再对全部 ~200 行重跑一遍正则高亮。 */
const ResultRow = memo(function ResultRow({
  hit,
  index,
  selected,
  showWs,
  filterRegex,
  onOpen,
  onHover,
  refs,
}: {
  hit: HitWithMeta;
  index: number;
  selected: boolean;
  showWs: boolean;
  filterRegex: RegExp | null;
  onOpen: (hit: HitWithMeta) => void;
  onHover: (index: number) => void;
  refs: MutableRefObject<(HTMLButtonElement | null)[]>;
}) {
  return (
    <button
      type="button"
      ref={(el) => {
        refs.current[index] = el;
      }}
      className={"cmdk-item" + (selected ? " sel" : "")}
      onClick={() => onOpen(hit)}
      onMouseEnter={() => onHover(index)}
    >
      <div className="ico">
        <Icon name="note" size={14} />
      </div>
      <div className="lbl">
        <div className="l1">
          {hit.name}
          {hit.line > 0 && (
            <span
              style={{
                marginLeft: 8,
                fontSize: 11,
                color: "var(--text-3)",
                fontFamily: "var(--font-mono)",
              }}
            >
              : {hit.line}
            </span>
          )}
          {showWs && (
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
              {hit.wsName}
            </span>
          )}
        </div>
        <div className="l2">
          {filterRegex
            ? highlightSegments(hit.preview || hit.path, filterRegex).map((seg, k) =>
                seg.hit ? (
                  <mark key={k} className="gs-hl">
                    {seg.text}
                  </mark>
                ) : (
                  <span key={k}>{seg.text}</span>
                ),
              )
            : hit.preview || hit.path}
        </div>
      </div>
    </button>
  );
});

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
  const confirmDialog = useDialog((s) => s.confirm);
  const setToast = useUI((s) => s.setToast);

  // 从查找栏「整个仓库」切换过来时带着当前关键词；否则空。
  const [q, setQ] = useState(() => useUI.getState().findQuery || "");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  // 语义检索：路由到 RAG 混合检索（向量 + FTS RRF + rerank + 图扩展）。
  const ragEnabled = useSettings((s) => s.ragEnabled);
  const [semantic, setSemantic] = useState(false);
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
  // 跨文件替换
  const [showReplace, setShowReplace] = useState(false);
  const [replaceText, setReplaceText] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const seqRef = useRef(0);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // RAG 关掉时不应停留在语义模式。
  useEffect(() => {
    if (!ragEnabled) setSemantic(false);
  }, [ragEnabled]);

  // 字面模式：Aa/W/.* 都用客户端正则过滤实现，发给 Rust 的串保持简单（fs_grep 没暴露
  // 这些开关）。先用宽松的 plain 子串拉回候选，再前端过滤。
  // 语义模式：直接路由到 RAG 混合检索，结果按 chunk 给出（line 取 0，仅打开文件）。
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
        if (semantic) {
          const ragHits: HitWithMeta[] = [];
          let anyOk = false;
          let lastErr: string | null = null;
          for (const w of targetWss) {
            try {
              const rs = await useRag.getState().search(w.path, trimmed);
              anyOk = true;
              for (const h of rs) {
                const name = h.path.split(/[\\/]/).pop() || h.path;
                const snippet = h.body.replace(/\s+/g, " ").trim().slice(0, 200);
                ragHits.push({
                  path: h.path,
                  name,
                  line: 0,
                  preview: h.heading ? `${h.heading} — ${snippet}` : snippet,
                  wsId: w.id,
                  wsName: w.name,
                });
              }
            } catch (e) {
              lastErr = (e as Error).message;
            }
          }
          if (seq !== seqRef.current) return;
          if (!anyOk && lastErr) {
            setErr(`语义检索失败：${lastErr}（请确认已在设置里建好 RAG 索引）`);
            setHits([]);
          } else {
            setHits(ragHits);
          }
          return;
        }
        const all: HitWithMeta[] = [];
        const seen = new Set<string>();
        const anchors = buildSearchAnchors(trimmed, regex);
        for (const w of targetWss) {
          for (const anchor of anchors) {
            const a = anchor.length >= 2 ? anchor : trimmed;
            const r = await api.grep(w.path, a, MAX_GLOBAL_SEARCH_RESULTS);
            for (const h of r) {
              // 多 anchor（正则分支）取并集，按 path+line 去重
              const key = `${w.id}\0${h.path}\0${h.line}`;
              if (seen.has(key)) continue;
              seen.add(key);
              all.push({ ...h, wsId: w.id, wsName: w.name });
            }
          }
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
  }, [q, ws, scope, workspaces, regex, semantic, reloadNonce]);

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

  // 应用 facets + 客户端正则（语义模式跳过字面正则过滤——否则把语义命中又按字面筛掉了）
  const filtered = useMemo<HitWithMeta[]>(() => {
    if (!semantic && !filterRegex) return [];
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
      // 文本正则：仅字面模式生效
      if (!semantic && filterRegex) {
        filterRegex.lastIndex = 0;
        if (!filterRegex.test(h.preview)) return false;
      }
      return true;
    });
  }, [hits, filterRegex, ext, tagSel, mtimeFloor, pathToVaultFile, semantic]);

  const toggleTag = (tag: string) => {
    setTagSel((cur) => {
      const next = new Set(cur);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  };

  useEffect(() => setSel(0), [filtered.length]);

  const openHit = useCallback(async (h: HitWithMeta) => {
    if (h.wsId !== ws?.id) setActive(h.wsId);
    await openFile(h.wsId, h.path);
    if (h.line > 0) jumpToLine(h.path, h.line);
    setFindQuery(q.trim());
    openFind(true);
    onClose();
  }, [jumpToLine, onClose, openFile, openFind, q, setActive, setFindQuery, ws?.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // IME 组字中的 Enter/方向键/Escape 留给候选词操作，别打开结果或关闭面板
      if (e.isComposing || e.keyCode === 229) return;
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
  }, [filtered, sel, onClose, openHit]);

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

  /** 跨文件全部替换：对命中文件逐个 open → 全局正则替换 → 保存（先存历史快照）。
   *  字面模式下替换串里的 `$` 转义为字面；正则模式保留 $1 等回引用。 */
  const replaceAll = async () => {
    if (semantic || !filterRegex) return;
    const files = Array.from(grouped.keys());
    if (files.length === 0) return;
    const ok = await confirmDialog({
      title: "全部替换？",
      message: `将在 ${files.length} 个文件中把匹配项替换为「${replaceText}」。每个文件会先存历史快照，可在历史面板撤销。`,
      confirmLabel: "替换",
      danger: true,
    });
    if (!ok) return;
    setReplacing(true);
    // 字面模式：$ → $$（避免被当成 $&/$1 等替换占位符）
    const repl = regex ? replaceText : replaceText.replace(/\$/g, "$$$$");
    const flags = filterRegex.flags.includes("g")
      ? filterRegex.flags
      : filterRegex.flags + "g";
    let changedFiles = 0;
    let totalHits = 0;
    let failed = 0;
    try {
      for (const path of files) {
        try {
          const opened = await api.open(path);
          const re = new RegExp(filterRegex.source, flags);
          const matches = opened.content.match(re);
          if (!matches || matches.length === 0) continue;
          const next = opened.content.replace(re, repl);
          if (next === opened.content) continue;
          await api.save(path, next, opened.sig.mtime, opened.sig.hash);
          changedFiles++;
          totalHits += matches.length;
        } catch {
          failed++;
        }
      }
      setToast({
        stage: failed > 0 ? "error" : "done",
        message:
          `已替换 ${totalHits} 处 · ${changedFiles} 个文件` +
          (failed > 0 ? `，${failed} 个失败` : ""),
      });
      // 重新检索，让已替换的命中从列表里消失
      setReloadNonce((n) => n + 1);
    } finally {
      setReplacing(false);
    }
  };

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
              disabled={semantic}
            >
              .*
            </button>
            {ragEnabled && (
              <button
                type="button"
                className={"gs-tog-btn" + (semantic ? " on" : "")}
                onClick={() => setSemantic((v) => !v)}
                title="语义检索（RAG：向量 + 关键词 RRF 融合 + 图扩展）"
              >
                语义
              </button>
            )}
            {!semantic && (
              <button
                type="button"
                className={"gs-tog-btn" + (showReplace ? " on" : "")}
                onClick={() => setShowReplace((v) => !v)}
                title="跨文件替换"
              >
                替换
              </button>
            )}
          </div>
          <span className="esc">{shortcutText("⌘⇧F")}</span>
        </div>

        {showReplace && !semantic && (
          <div
            className="cmdk-search"
            style={{ borderTop: "0.5px solid var(--border)" }}
          >
            <Icon name="edit" size={16} />
            <input
              placeholder={regex ? "替换为…（支持 $1 回引用）" : "替换为…"}
              value={replaceText}
              onChange={(e) => setReplaceText(e.target.value)}
            />
            <button
              type="button"
              className="gs-save"
              onClick={() => void replaceAll()}
              disabled={replacing || filtered.length === 0 || !filterRegex}
              title="把命中文件里的所有匹配替换掉（每个文件先存历史快照，可在历史面板撤销）"
            >
              {replacing ? "替换中…" : `全部替换 (${grouped.size})`}
            </button>
          </div>
        )}

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
              <div className="cmdk-empty">{semantic ? "语义检索中…" : "扫描中…"}</div>
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
                  <ResultRow
                    key={i}
                    hit={h}
                    index={i}
                    selected={i === sel}
                    showWs={scope === "all"}
                    filterRegex={filterRegex}
                    onOpen={openHit}
                    onHover={setSel}
                    refs={itemRefs}
                  />
                ))}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
