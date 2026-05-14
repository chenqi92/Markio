import { useEffect, useMemo, useState } from "react";
import { Icon } from "../ui/Icon";
import { useUI } from "@/stores/ui";
import { useTabs } from "@/stores/tabs";
import { api, isDesktop } from "@/lib/api";

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
  const content = useTabs((s) => s.activeTab()?.content ?? "");

  // 总数：小文档走 JS indexOf；> 30KB 在桌面端走 Rust，避免主线程被卡
  const jsTotal = useMemo(() => {
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
  }, [q, content]);

  const [rustTotal, setRustTotal] = useState<number | null>(null);
  useEffect(() => {
    if (!q || content.length < 30_000 || !isDesktop()) {
      setRustTotal(null);
      return;
    }
    let cancelled = false;
    api
      .textFindRanges(content, q, { caseInsensitive: true })
      .then((ranges) => {
        if (!cancelled) setRustTotal(ranges.length);
      })
      .catch(() => {
        if (!cancelled) setRustTotal(null);
      });
    return () => {
      cancelled = true;
    };
  }, [q, content]);

  const total = rustTotal ?? jsTotal;

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
