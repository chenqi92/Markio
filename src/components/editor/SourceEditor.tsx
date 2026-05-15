import { useCallback, useEffect, useMemo, useRef } from "react";
import CodeMirror, {
  type ReactCodeMirrorRef,
  EditorView,
} from "@uiw/react-codemirror";
import { Prec } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { EditorView as CMView, keymap } from "@codemirror/view";
import { useSettings } from "@/stores/settings";
import { registerEditor } from "@/lib/editor-bridge";
import { markdownCommands } from "@/lib/markdown-commands";
import { wysiwygMarkdown } from "./wysiwyg";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onScroll?: (info: {
    top: number;
    height: number;
    clientHeight: number;
  }) => void;
  scrollTarget?: {
    ratio: number;
    nonce: number;
  } | null;
  onPasteImages?: (
    files: File[],
    range: { from: number; to: number },
  ) => void | Promise<void>;
  onSelectionChange?: (info: {
    hasSelection: boolean;
    coords: { x: number; y: number } | null;
  }) => void;
  onSlashTrigger?: (coords: { x: number; y: number }) => void;
  onAutocompleteUpdate?: (
    state:
      | {
          kind: "wiki" | "mention" | "tag" | "emoji";
          query: string;
          triggerLen: number;
          coords: { x: number; y: number };
        }
      | null,
  ) => void;
  /** 是否启用 WYSIWYG 装饰（隐藏 markdown 标记 + 行级样式） */
  wysiwyg?: boolean;
}

export function SourceEditor({
  value,
  onChange,
  onScroll,
  scrollTarget,
  onPasteImages,
  onSelectionChange,
  onSlashTrigger,
  onAutocompleteUpdate,
  wysiwyg = false,
}: Props) {
  const fontSize = useSettings((s) => s.fontSize);
  const ref = useRef<ReactCodeMirrorRef>(null);
  const suppressScrollRef = useRef(false);

  const applyScrollTarget = useCallback(() => {
    const view = ref.current?.view;
    if (!view || !scrollTarget) return;
    const el = view.scrollDOM;
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    const nextTop = max * Math.max(0, Math.min(1, scrollTarget.ratio));
    if (Math.abs(el.scrollTop - nextTop) < 1) return;
    suppressScrollRef.current = true;
    el.scrollTop = nextTop;
    requestAnimationFrame(() => {
      suppressScrollRef.current = false;
    });
  }, [scrollTarget?.nonce, scrollTarget?.ratio]);

  const extensions = useMemo(
    () => [
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      EditorView.lineWrapping,
      ...(wysiwyg ? [wysiwygMarkdown] : []),
      markdownKeymap,
      mathInputHandler,
      EditorView.updateListener.of((u) => {
        if (u.selectionSet && onSelectionChange) {
          const sel = u.state.selection.main;
          const has = !sel.empty;
          let coords: { x: number; y: number } | null = null;
          if (has) {
            const r = u.view.coordsAtPos(sel.from);
            if (r) coords = { x: r.left, y: r.top };
          }
          onSelectionChange({ hasSelection: has, coords });
        }
        if ((u.docChanged || u.selectionSet) && onAutocompleteUpdate) {
          const sel = u.state.selection.main;
          if (!sel.empty) {
            onAutocompleteUpdate(null);
            return;
          }
          const line = u.state.doc.lineAt(sel.head);
          const before = line.text.slice(0, sel.head - line.from);
          // 探测最近一次触发
          const triggers: Array<{
            kind: "wiki" | "mention" | "tag" | "emoji";
            re: RegExp;
            triggerLen: number;
          }> = [
            { kind: "wiki", re: /\[\[([\w一-鿿\-\.\/ ]{0,40})$/, triggerLen: 2 },
            { kind: "mention", re: /(^|\s)@([\w一-鿿\-]{0,30})$/, triggerLen: 1 },
            { kind: "tag", re: /(^|\s)#([\w一-鿿\-]{0,30})$/, triggerLen: 1 },
            { kind: "emoji", re: /(^|\s):([\w\-]{0,30})$/, triggerLen: 1 },
          ];
          for (const t of triggers) {
            const m = before.match(t.re);
            if (m) {
              const query = (m[2] ?? m[1] ?? "") as string;
              const r = u.view.coordsAtPos(sel.head);
              if (!r) {
                onAutocompleteUpdate(null);
                return;
              }
              onAutocompleteUpdate({
                kind: t.kind,
                query,
                triggerLen: t.triggerLen,
                coords: { x: r.left, y: r.bottom },
              });
              return;
            }
          }
          onAutocompleteUpdate(null);
        }
      }),
      CMView.theme(
        {
          "&": { height: "100%", backgroundColor: "transparent" },
          ".cm-scroller": {
            fontFamily: "var(--font-mono)",
            fontSize: `${fontSize - 2}px`,
            lineHeight: "1.7",
          },
        },
        { dark: false },
      ),
    ],
    [fontSize, onSelectionChange, onAutocompleteUpdate, wysiwyg],
  );

  useEffect(() => {
    const view = ref.current?.view;
    if (!view) return;
    registerEditor(view);
    return () => registerEditor(null);
  }, [ref.current?.view]);

  useEffect(() => {
    const view = ref.current?.view;
    if (!view) return;
    const el = view.scrollDOM;
    if (onScroll) {
      const handler = () => {
        if (suppressScrollRef.current) return;
        onScroll({
          top: el.scrollTop,
          height: el.scrollHeight,
          clientHeight: el.clientHeight,
        });
      };
      el.addEventListener("scroll", handler, { passive: true });
      return () => el.removeEventListener("scroll", handler);
    }
  }, [onScroll]);

  useEffect(() => {
    applyScrollTarget();
  }, [applyScrollTarget, value]);

  useEffect(() => {
    if (!onPasteImages) return;
    const view = ref.current?.view;
    if (!view) return;
    const handler = (e: ClipboardEvent) => {
      const data = e.clipboardData;
      if (!data) return;
      const fromItems = Array.from(data.items ?? [])
        .filter((item) => item.type.startsWith("image/"))
        .map((item) => item.getAsFile())
        .filter((file): file is File => !!file);
      const fromFiles = Array.from(data.files ?? []).filter((file) =>
        file.type.startsWith("image/"),
      );
      const files = fromItems.length > 0 ? fromItems : fromFiles;
      if (files.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const sel = view.state.selection.main;
      void onPasteImages(files, { from: sel.from, to: sel.to });
    };
    view.contentDOM.addEventListener("paste", handler);
    return () => view.contentDOM.removeEventListener("paste", handler);
  }, [onPasteImages]);

  // 监听 `/` 触发斜杠菜单
  useEffect(() => {
    if (!onSlashTrigger) return;
    const view = ref.current?.view;
    if (!view) return;
    const el = view.scrollDOM;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // 等输入应用一帧后再读取光标坐标
        requestAnimationFrame(() => {
          const cur = view.state.selection.main;
          const line = view.state.doc.lineAt(cur.head);
          // 仅当 `/` 在行首或行内仅紧贴前导空白后触发
          const prefix = line.text.slice(0, cur.head - line.from);
          if (!/^\s*\/$/.test(prefix)) return;
          const r = view.coordsAtPos(cur.head);
          if (!r) return;
          onSlashTrigger({ x: r.left, y: r.bottom });
        });
      }
    };
    el.addEventListener("keydown", handler);
    return () => el.removeEventListener("keydown", handler);
  }, [onSlashTrigger]);

  return (
    <div
      className="cm-host"
      style={{ height: "100%" }}
      data-mode={wysiwyg ? "wysiwyg" : "source"}
    >
      <CodeMirror
        ref={ref}
        value={value}
        height="100%"
        theme="none"
        extensions={extensions}
        basicSetup={{
          lineNumbers: !wysiwyg,
          foldGutter: !wysiwyg,
          highlightActiveLine: true,
          highlightActiveLineGutter: !wysiwyg,
          autocompletion: false,
          bracketMatching: true,
          closeBrackets: true,
        }}
        onChange={onChange}
      />
    </div>
  );
}

/**
 * 输入 `$` 时自动补一个 `$`，光标停在中间；适配公式输入。
 * 已经在 `$...$` 内部、或行起始 `$$` → 不接管，让默认行为生效。
 */
const mathInputHandler = EditorView.inputHandler.of(
  (view, from, to, text) => {
    if (text !== "$") return false;
    const doc = view.state.doc;
    const prevCh = from > 0 ? doc.sliceString(from - 1, from) : "";
    const nextCh = to < doc.length ? doc.sliceString(to, to + 1) : "";
    // 紧跟在 `$` 之后 → 让用户继续打第二个 `$` 完成 display math
    if (prevCh === "$") return false;
    // 下一个字符已经是 `$` → 视为跳过闭合分隔符
    if (nextCh === "$") {
      view.dispatch({
        selection: { anchor: to + 1 },
        userEvent: "input.type",
      });
      return true;
    }
    // 默认：插入 `$$` 并把光标放中间
    view.dispatch({
      changes: { from, to, insert: "$$" },
      selection: { anchor: from + 1 },
      userEvent: "input.type",
    });
    return true;
  },
);

function runMarkdownCommand(command: () => void) {
  return () => {
    command();
    return true;
  };
}

const markdownKeymap = Prec.highest(
  keymap.of([
    { key: "Mod-b", run: runMarkdownCommand(markdownCommands.bold) },
    { key: "Mod-i", run: runMarkdownCommand(markdownCommands.italic) },
    { key: "Mod-k", run: runMarkdownCommand(markdownCommands.link) },
    { key: "Mod-Shift-h", run: runMarkdownCommand(markdownCommands.mark) },
    { key: "Mod-Shift-x", run: runMarkdownCommand(markdownCommands.strike) },
    { key: "Mod-Alt-1", run: runMarkdownCommand(markdownCommands.h1) },
    { key: "Mod-Alt-2", run: runMarkdownCommand(markdownCommands.h2) },
    { key: "Mod-Alt-3", run: runMarkdownCommand(markdownCommands.h3) },
    { key: "Mod-Alt-4", run: runMarkdownCommand(markdownCommands.h4) },
    { key: "Mod-Alt-l", run: runMarkdownCommand(markdownCommands.wikiLink) },
    { key: "Mod-Alt-t", run: runMarkdownCommand(markdownCommands.table) },
    { key: "Mod-Alt-c", run: runMarkdownCommand(markdownCommands.codeBlock) },
    { key: "Mod-Alt-m", run: runMarkdownCommand(markdownCommands.mathBlock) },
  ]),
);
