import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { renderMermaidIn } from "@/lib/mermaid";
import type { OutlineItem } from "@/types";
import { useSettings } from "@/stores/settings";
import { useUI } from "@/stores/ui";

interface Props {
  source: string;
  onMeta?: (meta: { outline: OutlineItem[]; words: number; readingMinutes: number }) => void;
  onScroll?: (info: { top: number; height: number; clientHeight: number }) => void;
}

/**
 * Render markdown by delegating to the Rust backend (pulldown-cmark + syntect),
 * then inject the resulting HTML. The frontend only paints; parsing/highlighting
 * stays in Rust.
 */
export function Preview({ source, onMeta, onScroll }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [html, setHtml] = useState("");
  const fontSize = useSettings((s) => s.fontSize);
  const theme = useSettings((s) => s.theme);
  const findQuery = useUI((s) => s.findQuery);
  const findIndex = useUI((s) => s.findIndex);

  useEffect(() => {
    if (!contentRef.current) return;
    // 主题切换后强制重绘 mermaid
    contentRef.current
      .querySelectorAll<HTMLElement>(".mermaid-block")
      .forEach((el) => {
        delete el.dataset.rendered;
      });
    renderMermaidIn(contentRef.current).catch(() => undefined);
  }, [html, theme]);

  // Find 高亮：扫描文字节点，包 <mark class="find-hit"> + 当前项加 .current
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    // 先撤销旧高亮
    root.querySelectorAll("mark.find-hit").forEach((m) => {
      const parent = m.parentNode;
      if (!parent) return;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
      parent.normalize();
    });
    if (!findQuery) return;
    const needle = findQuery.toLowerCase();
    let count = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue) return NodeFilter.FILTER_REJECT;
        if (
          (n.parentElement?.closest("pre,code,script,style,mark.find-hit") ?? null) !==
          null
        )
          return NodeFilter.FILTER_REJECT;
        return n.nodeValue.toLowerCase().includes(needle)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });
    const targets: Text[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) targets.push(node as Text);
    for (const t of targets) {
      const v = t.nodeValue ?? "";
      const lower = v.toLowerCase();
      let last = 0;
      const parent = t.parentNode;
      if (!parent) continue;
      const fragments: Node[] = [];
      let from = 0;
      while ((from = lower.indexOf(needle, last)) !== -1) {
        if (from > last) fragments.push(document.createTextNode(v.slice(last, from)));
        const mark = document.createElement("mark");
        mark.className = "find-hit";
        mark.dataset.idx = String(count);
        mark.textContent = v.slice(from, from + needle.length);
        fragments.push(mark);
        last = from + needle.length;
        count++;
      }
      if (last < v.length) fragments.push(document.createTextNode(v.slice(last)));
      for (const f of fragments) parent.insertBefore(f, t);
      parent.removeChild(t);
    }
    // 当前 idx 加 .current
    const hits = root.querySelectorAll<HTMLElement>("mark.find-hit");
    if (hits.length === 0) return;
    const safeIdx = Math.max(0, Math.min(hits.length - 1, findIndex));
    hits.forEach((h, i) => h.classList.toggle("current", i === safeIdx));
  }, [html, findQuery, findIndex]);

  // 稳定 debounce：timer 在整个组件生命周期内只有一个；source 变化时
  // reset timer，先前的渲染如果还没发就直接被替换。
  const timerRef = useRef<number | null>(null);
  const seqRef = useRef(0);
  const onMetaRef = useRef(onMeta);
  useEffect(() => {
    onMetaRef.current = onMeta;
  }, [onMeta]);

  useEffect(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const seq = ++seqRef.current;
    timerRef.current = window.setTimeout(async () => {
      timerRef.current = null;
      try {
        const r = await api.renderMarkdown(source);
        if (seq !== seqRef.current) return; // 期间又输入了，丢弃
        setHtml(r.html);
        onMetaRef.current?.({
          outline: r.outline,
          words: r.words,
          readingMinutes: r.readingMinutes,
        });
      } catch (e) {
        if (seq !== seqRef.current) return;
        setHtml(
          `<pre style="color: var(--text-3); padding: 16px;">渲染失败：${(e as Error).message}</pre>`,
        );
      }
    }, 60);
    return () => {
      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [source]);

  // 不再依赖 onMeta 引用变化触发 effect
  void useMemo(() => onMeta, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !onScroll) return;
    const handler = () =>
      onScroll({
        top: el.scrollTop,
        height: el.scrollHeight,
        clientHeight: el.clientHeight,
      });
    el.addEventListener("scroll", handler, { passive: true });
    return () => el.removeEventListener("scroll", handler);
  }, [onScroll]);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const handler = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest("a");
      if (!a) return;
      const href = a.getAttribute("href");
      if (!href) return;
      // 内部锚点
      if (href.startsWith("#")) {
        e.preventDefault();
        const id = href.slice(1);
        const target = document.getElementById(id);
        if (target)
          target.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      // 外链
      if (/^https?:\/\//.test(href)) {
        e.preventDefault();
        window.open(href, "_blank");
      }
    };
    el.addEventListener("click", handler);
    return () => el.removeEventListener("click", handler);
  }, []);

  return (
    <div ref={containerRef} className="preview-pane">
      <div
        ref={contentRef}
        className="preview"
        style={{ fontSize }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
