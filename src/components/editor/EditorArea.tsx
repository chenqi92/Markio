import { useCallback, useEffect, useMemo, useState } from "react";
import { SourceEditor } from "./SourceEditor";
import { Preview } from "../preview/Preview";
import { BubbleMenu } from "../popovers/BubbleMenu";
import { SlashMenu } from "../popovers/SlashMenu";
import { Autocomplete, type AcKind } from "../popovers/Autocomplete";
import { useTabs } from "@/stores/tabs";
import { useUI } from "@/stores/ui";
import { useSettings } from "@/stores/settings";
import { classNames, debounce } from "@/lib/utils";
import { Outline } from "../layout/Outline";
import type { OutlineItem, ViewMode } from "@/types";

interface Props {
  onMeta?: (meta: { outline: OutlineItem[]; words: number; readingMinutes: number }) => void;
  onAskAi: () => void;
}

const MODE_CLASS: Record<ViewMode, string> = {
  source: "source-only",
  split: "split",
  wysiwyg: "wysiwyg",
  preview: "preview-only",
};

export function EditorArea({ onMeta, onAskAi }: Props) {
  const tab = useTabs((s) => s.activeTab());
  const updateContent = useTabs((s) => s.updateContent);
  const saveTab = useTabs((s) => s.saveTab);
  const mode = useUI((s) => s.mode);
  const autosave = useSettings((s) => s.autosave);
  const shortcutStyle = useSettings((s) => s.shortcutStyle);
  const [meta, setMeta] = useState<{
    outline: OutlineItem[];
    words: number;
    readingMinutes: number;
  }>({ outline: [], words: 0, readingMinutes: 1 });
  const [bubble, setBubble] = useState<{ x: number; y: number } | null>(null);
  const [slash, setSlash] = useState<{ x: number; y: number } | null>(null);
  const [ac, setAc] = useState<{
    kind: AcKind;
    query: string;
    triggerLen: number;
    x: number;
    y: number;
  } | null>(null);

  const onMetaInternal = useCallback(
    (m: { outline: OutlineItem[]; words: number; readingMinutes: number }) => {
      setMeta(m);
      onMeta?.(m);
    },
    [onMeta],
  );

  const renderMode = useMemo<ViewMode>(() => {
    if (mode === "wysiwyg") return "preview";
    return mode;
  }, [mode]);

  // 自动保存：内容变化 800ms 后写盘
  const tabId = tab?.id;
  const dirty = tab?.dirty;
  const debouncedSave = useMemo(
    () =>
      debounce((id: string) => {
        if (!useSettings.getState().autosave) return;
        saveTab(id).catch(() => undefined);
      }, 800),
    [saveTab],
  );
  useEffect(() => {
    if (!autosave || !tabId || !dirty) return;
    debouncedSave(tabId);
  }, [tabId, dirty, autosave, debouncedSave, tab?.content]);

  if (!tab) {
    return null;
  }

  const showSource = renderMode === "source" || renderMode === "split";
  const showPreview = renderMode === "preview" || renderMode === "split";

  const allowBubble =
    shortcutStyle === "all" || shortcutStyle === "bubble";
  const allowSlash = shortcutStyle === "all" || shortcutStyle === "slash";

  return (
    <div className={classNames("editor-split", MODE_CLASS[mode])}>
      {showSource && (
        <div className="editor-pane">
          <SourceEditor
            value={tab.content}
            onChange={(v) => updateContent(tab.id, v)}
            onSelectionChange={(info) => {
              if (!allowBubble) {
                setBubble(null);
                return;
              }
              if (!info.hasSelection || !info.coords) {
                setBubble(null);
                return;
              }
              setBubble(info.coords);
            }}
            onSlashTrigger={
              allowSlash ? (coords) => setSlash(coords) : undefined
            }
            onAutocompleteUpdate={(s) => {
              if (!s) {
                setAc(null);
                return;
              }
              setAc({
                kind: s.kind,
                query: s.query,
                triggerLen: s.triggerLen,
                x: s.coords.x,
                y: s.coords.y,
              });
            }}
          />
        </div>
      )}
      {showPreview && (
        <Preview source={tab.content} onMeta={onMetaInternal} />
      )}
      <Outline
        items={meta.outline}
        words={meta.words}
        readingMinutes={meta.readingMinutes}
      />
      {bubble && (
        <BubbleMenu
          x={bubble.x}
          y={bubble.y}
          onAskAi={() => {
            setBubble(null);
            onAskAi();
          }}
          onClose={() => setBubble(null)}
        />
      )}
      {slash && (
        <SlashMenu
          x={slash.x}
          y={slash.y}
          onClose={() => setSlash(null)}
        />
      )}
      {ac && (
        <Autocomplete
          kind={ac.kind}
          query={ac.query}
          triggerLen={ac.triggerLen}
          x={ac.x}
          y={ac.y}
          onClose={() => setAc(null)}
        />
      )}
    </div>
  );
}
