import { useEffect, useMemo, useRef } from "react";
import CodeMirror, {
  type ReactCodeMirrorRef,
  EditorView,
} from "@uiw/react-codemirror";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { EditorView as CMView } from "@codemirror/view";
import { useSettings } from "@/stores/settings";
import { registerEditor } from "@/lib/editor-bridge";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onScroll?: (info: {
    top: number;
    height: number;
    clientHeight: number;
  }) => void;
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
}

export function SourceEditor({
  value,
  onChange,
  onScroll,
  onSelectionChange,
  onSlashTrigger,
  onAutocompleteUpdate,
}: Props) {
  const fontSize = useSettings((s) => s.fontSize);
  const ref = useRef<ReactCodeMirrorRef>(null);

  const extensions = useMemo(
    () => [
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      EditorView.lineWrapping,
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
    [fontSize, onSelectionChange, onAutocompleteUpdate],
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
    <div className="cm-host" style={{ height: "100%" }}>
      <CodeMirror
        ref={ref}
        value={value}
        height="100%"
        theme="none"
        extensions={extensions}
        basicSetup={{
          lineNumbers: true,
          foldGutter: true,
          highlightActiveLine: true,
          highlightActiveLineGutter: true,
          autocompletion: false,
          bracketMatching: true,
          closeBrackets: true,
        }}
        onChange={onChange}
      />
    </div>
  );
}
