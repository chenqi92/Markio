import { useEffect, useMemo, useState } from "react";
import { Icon, type IconName } from "../ui/Icon";
import { useWorkspace } from "@/stores/workspace";
import { useTabs } from "@/stores/tabs";
import { useVaultIndex } from "@/stores/vaultIndex";
import { replaceSelection, deleteBeforeCursor } from "@/lib/editor-bridge";

export type AcKind = "wiki" | "mention" | "tag" | "emoji";

interface Item {
  ico?: string;
  icon?: IconName;
  l1: string;
  l2?: string;
  insert: string;
}

const EMOJIS: Item[] = [
  { ico: "😀", l1: ":smile:", l2: "笑", insert: "😀 " },
  { ico: "😅", l1: ":sweat:", l2: "汗", insert: "😅 " },
  { ico: "🌱", l1: ":seedling:", l2: "发芽", insert: "🌱 " },
  { ico: "💡", l1: ":bulb:", l2: "灵感", insert: "💡 " },
  { ico: "🔥", l1: ":fire:", l2: "热度", insert: "🔥 " },
  { ico: "⭐", l1: ":star:", l2: "星", insert: "⭐ " },
  { ico: "✅", l1: ":check:", l2: "完成", insert: "✅ " },
  { ico: "❓", l1: ":question:", l2: "疑问", insert: "❓ " },
];

const FALLBACK_TOKEN_SCAN_LIMIT = 100_000;

const TRIGGER_LABEL: Record<AcKind, { badge: string; title: string }> = {
  wiki: { badge: "[[", title: "链接到笔记" },
  mention: { badge: "@", title: "提及人员或仓库" },
  tag: { badge: "#", title: "标签" },
  emoji: { badge: ":", title: "Emoji" },
};

function tokensToItems(tokens: string[], prefix: "@" | "#"): Item[] {
  const seen = new Set<string>();
  const out: Item[] = [];
  for (const raw of tokens) {
    const t = raw.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const label = `${prefix}${t}`;
    out.push({
      icon: prefix === "#" ? "hash" : "user",
      l1: label,
      insert: `${label} `,
    });
  }
  return out;
}

function mergeUnique(primary: Item[], extra: Item[]): Item[] {
  const seen = new Set(primary.map((it) => it.l1.toLowerCase()));
  const out = primary.slice();
  for (const it of extra) {
    if (seen.has(it.l1.toLowerCase())) continue;
    seen.add(it.l1.toLowerCase());
    out.push(it);
  }
  return out.sort((a, b) => a.l1.localeCompare(b.l1));
}

function fallbackTokens(source: string, prefix: "@" | "#"): Item[] {
  const seen = new Set<string>();
  const out: Item[] = [];
  const re =
    prefix === "#"
      ? /(^|[\s([{"'])#([\p{L}\p{N}_-]{1,64})/gu
      : /(^|[\s([{"'])@([\p{L}\p{N}_-]{1,64})/gu;
  for (const match of source.matchAll(re)) {
    const token = match[2];
    if (!token || seen.has(token.toLowerCase())) continue;
    seen.add(token.toLowerCase());
    const label = `${prefix}${token}`;
    out.push({
      icon: prefix === "#" ? "hash" : "user",
      l1: label,
      insert: `${label} `,
    });
    if (out.length >= 100) break;
  }
  return out;
}

export function Autocomplete({
  kind,
  x,
  y,
  query,
  triggerLen,
  onClose,
}: {
  kind: AcKind;
  x: number;
  y: number;
  query: string;
  triggerLen: number;
  onClose: () => void;
}) {
  const ws = useWorkspace((s) => s.activeWorkspace());
  const activeText = useTabs((s) => s.activeTab()?.content ?? "");
  const ensureIndex = useVaultIndex((s) => s.ensure);
  const vaultIndex = useVaultIndex((s) =>
    ws ? s.index[ws.path] : undefined,
  );
  const [sel, setSel] = useState(0);

  useEffect(() => {
    if (ws) void ensureIndex(ws.path);
  }, [ws, ensureIndex]);

  const base: Item[] = useMemo(() => {
    if (kind === "mention") {
      const fromVault = vaultIndex ? tokensToItems(vaultIndex.mentions, "@") : [];
      const fromActive =
        activeText.length <= FALLBACK_TOKEN_SCAN_LIMIT ? fallbackTokens(activeText, "@") : [];
      return mergeUnique(fromVault, fromActive);
    }
    if (kind === "tag") {
      const fromVault = vaultIndex ? tokensToItems(vaultIndex.tags, "#") : [];
      const fromActive =
        activeText.length <= FALLBACK_TOKEN_SCAN_LIMIT ? fallbackTokens(activeText, "#") : [];
      return mergeUnique(fromVault, fromActive);
    }
    if (kind === "emoji") return EMOJIS;
    // wiki: 全 vault 文件名（来自 vault index 的 stem）
    if (vaultIndex && vaultIndex.files.length > 0) {
      const seen = new Set<string>();
      const out: Item[] = [];
      for (const f of vaultIndex.files) {
        const name = f.stem || f.name.replace(/\.md$/i, "");
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          icon: "note" as IconName,
          l1: name,
          l2: f.path,
          insert: `[[${name}]] `,
        });
        if (out.length >= 500) break;
      }
      return out;
    }
    return [];
  }, [kind, activeText, vaultIndex]);

  const items = useMemo(() => {
    if (!query) return base.slice(0, 20);
    const q = query.toLowerCase();
    return base
      .filter((it) => it.l1.toLowerCase().includes(q) || (it.l2 ?? "").toLowerCase().includes(q))
      .slice(0, 20);
  }, [base, query]);

  useEffect(() => setSel(0), [query]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // IME 组字中的方向键/Enter/Escape 留给候选词，不抢补全菜单的导航
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setSel((s) => Math.min(items.length - 1, s + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSel((s) => Math.max(0, s - 1));
      } else if (e.key === "Enter") {
        if (items[sel]) {
          e.preventDefault();
          commit(items[sel]);
        }
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  });

  const commit = (it: Item) => {
    // 把触发字符（[[ / @ / # / :）以及到当前光标之间的 query 全部清掉，再插入
    const toDelete = triggerLen + query.length;
    deleteBeforeCursor(toDelete);
    replaceSelection(it.insert);
    onClose();
  };

  const info = TRIGGER_LABEL[kind];
  const left = Math.min(x, window.innerWidth - 340);
  const top = Math.min(y + 4, window.innerHeight - 320);

  return (
    <div className="autocomplete" style={{ left, top }}>
      <div className="ac-hd">
        <span className="ac-badge">{info.badge}</span>
        <span style={{ fontWeight: 600 }}>{info.title}</span>
        {query && <span style={{ color: "var(--text-3)" }}>· {query}</span>}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: "var(--text-3)" }}>↩ 选择 · esc 取消</span>
      </div>
      <div className="ac-list">
        {items.length === 0 ? (
          <div
            style={{
              padding: 18,
              fontSize: 11.5,
              color: "var(--text-3)",
              textAlign: "center",
            }}
          >
            没有匹配项
          </div>
        ) : (
          items.map((it, ix) => (
            <button
              type="button"
              key={it.l1 + ix}
              className={"ac-item" + (ix === sel ? " sel" : "")}
              onClick={() => commit(it)}
              onMouseEnter={() => setSel(ix)}
            >
              <span className="ac-ico">
                {it.icon ? <Icon name={it.icon} size={13} /> : it.ico}
              </span>
              <div className="ac-meta">
                <div className="ac-l1">{it.l1}</div>
                {it.l2 && <div className="ac-l2">{it.l2}</div>}
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
