import { useEffect, useMemo, useState } from "react";
import { Icon, type IconName } from "../ui/Icon";
import { useWorkspace } from "@/stores/workspace";
import { useTabs } from "@/stores/tabs";
import { useVaultTokens } from "@/stores/vaultTokens";
import { replaceSelection, deleteBeforeCursor } from "@/lib/editor-bridge";
import type { FileEntry } from "@/types";

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

const TRIGGER_LABEL: Record<AcKind, { badge: string; title: string }> = {
  wiki: { badge: "[[", title: "链接到笔记" },
  mention: { badge: "@", title: "提及人员或仓库" },
  tag: { badge: "#", title: "标签" },
  emoji: { badge: ":", title: "Emoji" },
};

function walkMd(node: FileEntry, out: Item[]) {
  if (!node.isDir) {
    const name = node.name.replace(/\.md$/i, "");
    out.push({
      icon: "note",
      l1: name,
      l2: node.path,
      // 由于 commit 时会先吃掉触发字符 [[ 和 query，
      // 这里 insert 必须把 [[ 与 ]] 一起补回去
      insert: `[[${name}]] `,
    });
    return;
  }
  for (const c of node.children ?? []) walkMd(c, out);
}

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
  const tree = useWorkspace((s) => s.activeTree());
  const ws = useWorkspace((s) => s.activeWorkspace());
  const indexedText = useTabs((s) => s.tabs.map((t) => t.content).join("\n"));
  const ensureTokens = useVaultTokens((s) => s.ensure);
  const vaultTokens = useVaultTokens((s) =>
    ws ? s.cache[ws.path] : undefined,
  );
  const [sel, setSel] = useState(0);

  useEffect(() => {
    if (kind === "tag" || kind === "mention") {
      if (ws) void ensureTokens(ws.path);
    }
  }, [kind, ws?.path, ensureTokens]);

  const base: Item[] = useMemo(() => {
    if (kind === "mention") {
      const fromVault = vaultTokens ? tokensToItems(vaultTokens.mentions, "@") : [];
      const fromTabs = fallbackTokens(indexedText, "@");
      return mergeUnique(fromVault, fromTabs);
    }
    if (kind === "tag") {
      const fromVault = vaultTokens ? tokensToItems(vaultTokens.tags, "#") : [];
      const fromTabs = fallbackTokens(indexedText, "#");
      return mergeUnique(fromVault, fromTabs);
    }
    if (kind === "emoji") return EMOJIS;
    // wiki: 优先全 vault 文件名（来自 indexTokens），fallback 用 tree
    if (vaultTokens && vaultTokens.files.length > 0) {
      return vaultTokens.files.slice(0, 500).map((name) => ({
        icon: "note" as IconName,
        l1: name,
        insert: `[[${name}]] `,
      }));
    }
    if (!tree) return [];
    const out: Item[] = [];
    walkMd(tree, out);
    return out.slice(0, 200);
  }, [kind, tree, indexedText, vaultTokens]);

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
