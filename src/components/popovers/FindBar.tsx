import { useEffect, useMemo, useState } from "react";
import { Icon } from "../ui/Icon";
import { useUI } from "@/stores/ui";
import { useTabs } from "@/stores/tabs";
import { api, isDesktop } from "@/lib/api";

const LARGE_FIND_THRESHOLD = 30_000;

export function FindBar() {
  const open = useUI((s) => s.findOpen);
  const q = useUI((s) => s.findQuery);
  const idx = useUI((s) => s.findIndex);
  const setQ = useUI((s) => s.setFindQuery);
  const setIdx = useUI((s) => s.setFindIndex);
  const close = () => {
    useUI.getState().openFind(false);
    setQ("");
  };
  const content = useTabs((s) => {
    if (!open && !q) return "";
    return s.activeTab()?.content ?? "";
  });
  const useRustTotal = !!q && content.length >= LARGE_FIND_THRESHOLD && isDesktop();

  // 总数：小文档走 JS indexOf；大文档在桌面端走 Rust，避免主线程整篇 lower + 扫描。
  const jsTotal = useMemo(() => {
    if (useRustTotal) return 0;
    if (!q) return 0;
    const lower = content.toLowerCase();
    const needle = q.toLowerCase();
    let count = 0;
    let i = 0;
    while ((i = lower.indexOf(needle, i)) !== -1) {
      count++;
      i += needle.length;
    }
    return count;
  }, [q, content, useRustTotal]);

  const [rustTotal, setRustTotal] = useState<number | null>(null);
  useEffect(() => {
    if (!useRustTotal) {
      setRustTotal(null);
      return;
    }
    let cancelled = false;
    setRustTotal(null);
    const t = window.setTimeout(() => {
      api
        .textFindCount(content, q, { caseInsensitive: true })
        .then((count) => {
          if (!cancelled) setRustTotal(count);
        })
        .catch(() => {
          if (!cancelled) setRustTotal(null);
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [q, content, useRustTotal]);

  const total = useRustTotal ? rustTotal ?? 0 : jsTotal;

  // 每次 q / idx 变更后滚动到当前命中元素
  useEffect(() => {
    if (!q || total === 0) return;
    const t = setTimeout(() => {
      const hits = document.querySelectorAll<HTMLElement>(".find-hit");
      const cur = hits[idx];
      if (cur)
        cur.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 60);
    return () => clearTimeout(t);
  }, [q, idx, total]);

  if (!open) return null;

  const step = (dir: 1 | -1) => {
    if (total === 0) return;
    setIdx((idx + dir + total) % total);
  };

  return (
    <div className="findbar" role="search">
      <input
        autoFocus
        placeholder="在当前文档中查找…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          }
          if (e.key === "Escape") close();
        }}
      />
      <span className="count">
        {q ? `${total ? idx + 1 : 0} / ${total}` : ""}
      </span>
      <button title="上一个" onClick={() => step(-1)}>‹</button>
      <button title="下一个" onClick={() => step(1)}>›</button>
      <button onClick={close} title="关闭">
        <Icon name="x" size={12} />
      </button>
    </div>
  );
}
