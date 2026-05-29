import { useEffect, useMemo, useState } from "react";
import { Icon } from "../ui/Icon";
import { useUI } from "@/stores/ui";
import { useTabs } from "@/stores/tabs";
import { api, isDesktop } from "@/lib/api";
import { countFindMatches, type FindTextOptions } from "@/lib/findText";
import { classNames } from "@/lib/utils";

const LARGE_FIND_THRESHOLD = 30_000;

export function FindBar() {
  const open = useUI((s) => s.findOpen);
  const q = useUI((s) => s.findQuery);
  const idx = useUI((s) => s.findIndex);
  const caseSensitive = useUI((s) => s.findCaseSensitive);
  const wholeWord = useUI((s) => s.findWholeWord);
  const regex = useUI((s) => s.findRegex);
  const setQ = useUI((s) => s.setFindQuery);
  const setIdx = useUI((s) => s.setFindIndex);
  const setFindOptions = useUI((s) => s.setFindOptions);
  const openGlobalSearch = useUI((s) => s.openGlobalSearch);
  const close = () => {
    useUI.getState().openFind(false);
    setQ("");
  };
  // 切到「整个仓库」：保留当前关键词，交给全局搜索面板（它默认搜整个当前仓库）
  const goRepo = () => {
    openGlobalSearch(true);
    useUI.getState().openFind(false);
  };
  const content = useTabs((s) => {
    if (!open && !q) return "";
    return s.activeTab()?.content ?? "";
  });
  const options = useMemo<FindTextOptions>(
    () => ({ caseSensitive, wholeWord, regex }),
    [caseSensitive, wholeWord, regex],
  );
  const useRustTotal = !!q && content.length >= LARGE_FIND_THRESHOLD && isDesktop();

  // 总数：小文档走 JS；大文档在桌面端走 Rust，避免主线程整篇扫描。
  const jsTotal = useMemo(() => {
    if (useRustTotal || !q) return { count: 0, error: null as string | null };
    return countFindMatches(content, q, options);
  }, [q, content, options, useRustTotal]);

  const [rustTotal, setRustTotal] = useState<number | null>(null);
  const [rustError, setRustError] = useState<string | null>(null);
  useEffect(() => {
    if (!useRustTotal) {
      setRustTotal(null);
      setRustError(null);
      return;
    }
    let cancelled = false;
    setRustTotal(null);
    setRustError(null);
    const t = window.setTimeout(() => {
      api
        .textFindCount(content, q, {
          caseInsensitive: !caseSensitive,
          wholeWord,
          regex,
        })
        .then((count) => {
          if (!cancelled) setRustTotal(count);
        })
        .catch((e) => {
          if (!cancelled) {
            setRustError(e instanceof Error ? e.message : String(e));
            setRustTotal(null);
          }
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [q, content, caseSensitive, wholeWord, regex, useRustTotal]);

  const total = useRustTotal ? rustTotal ?? 0 : jsTotal.count;
  const findError = useRustTotal ? rustError : jsTotal.error;

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
    if (total === 0 || findError) return;
    setIdx((idx + dir + total) % total);
  };
  const toggleOption = (patch: Partial<{
    findCaseSensitive: boolean;
    findWholeWord: boolean;
    findRegex: boolean;
  }>) => setFindOptions(patch);

  return (
    <div className="findbar" role="search">
      <Icon name="search" size={14} />
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
      <span className="find-scope" role="tablist" aria-label="搜索范围">
        <button
          type="button"
          className="find-scope-btn active"
          aria-pressed={true}
          title="只在当前文档中查找"
        >
          当前文档
        </button>
        <button
          type="button"
          className="find-scope-btn"
          aria-pressed={false}
          title="在整个仓库中搜索（打开全局搜索）"
          onClick={goRepo}
        >
          整个仓库
        </button>
      </span>
      <span className={classNames("count", findError && "error")} title={findError ?? undefined}>
        {q ? (findError ? "正则错误" : `${total ? idx + 1 : 0} / ${total}`) : ""}
      </span>
      <span className="find-options" aria-label="查找选项">
        <button
          className={classNames("find-toggle", caseSensitive && "active")}
          aria-pressed={caseSensitive}
          title="区分大小写"
          onClick={() => toggleOption({ findCaseSensitive: !caseSensitive })}
        >
          Aa
        </button>
        <button
          className={classNames("find-toggle", wholeWord && "active")}
          aria-pressed={wholeWord}
          title="整词匹配"
          onClick={() => toggleOption({ findWholeWord: !wholeWord })}
        >
          W
        </button>
        <button
          className={classNames("find-toggle", regex && "active")}
          aria-pressed={regex}
          title="正则表达式"
          onClick={() => toggleOption({ findRegex: !regex })}
        >
          .*
        </button>
      </span>
      <button title="上一个" onClick={() => step(-1)}>‹</button>
      <button title="下一个" onClick={() => step(1)}>›</button>
      <button onClick={close} title="关闭">
        <Icon name="x" size={12} />
      </button>
    </div>
  );
}
