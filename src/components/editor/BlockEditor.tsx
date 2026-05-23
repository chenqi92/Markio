import { useEffect, useRef } from "react";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/mantine/style.css";

interface Props {
  value: string;
  /** 笔记路径变化时强制 reset 文档；同一文件内的外部内容变化由 sourceRef 处理 */
  docKey: string;
  onChange: (next: string) => void;
  /** dark / light，跟着 markio 的主题模式走 */
  dark?: boolean;
}

/**
 * BlockNote 风格的 rich editor，挂在 ViewMode "block" 下。
 *
 * 跟 markio 源码模式的关系：
 * - 进入 block 模式时，从 markdown source 解析成 blocks 一次性 load
 * - 编辑过程中节流序列化回 markdown，回灌 tab.content
 * - 切回 source / split / wysiwyg / preview 时，markdown 是真相
 *
 * 第一阶段：只用 BlockNote 默认 schema（含 paragraph / heading / list /
 * checklist / code / quote / table / image），不带自定义块。Mermaid /
 * Math / Callout / Wikilink 留给阶段 2。
 */
export function BlockEditor({ value, docKey, onChange, dark }: Props) {
  const editor = useCreateBlockNote();
  // 防止"自己 emit 的 onChange → 上层回灌 value → 又 reset 文档"的死循环。
  const lastEmittedRef = useRef<string>("");
  // 上一次 hydrate 用的 docKey，切文件时强制重新解析
  const hydratedKeyRef = useRef<string | null>(null);

  // path 变化时，从 markdown 重新解析整个文档
  useEffect(() => {
    let cancelled = false;
    if (hydratedKeyRef.current === docKey) return;
    void (async () => {
      const blocks = await editor.tryParseMarkdownToBlocks(value);
      if (cancelled) return;
      editor.replaceBlocks(editor.document, blocks);
      hydratedKeyRef.current = docKey;
      lastEmittedRef.current = value;
    })();
    return () => {
      cancelled = true;
    };
  }, [docKey, editor, value]);

  // 同一文件、外部回灌了新内容（比如 AI 写入、source 模式改了再切回来）
  useEffect(() => {
    if (hydratedKeyRef.current !== docKey) return;
    if (value === lastEmittedRef.current) return;
    let cancelled = false;
    void (async () => {
      const blocks = await editor.tryParseMarkdownToBlocks(value);
      if (cancelled) return;
      editor.replaceBlocks(editor.document, blocks);
      lastEmittedRef.current = value;
    })();
    return () => {
      cancelled = true;
    };
  }, [value, docKey, editor]);

  return (
    <BlockNoteView
      editor={editor}
      theme={dark ? "dark" : "light"}
      onChange={() => {
        void (async () => {
          try {
            const md = await editor.blocksToMarkdownLossy(editor.document);
            if (md === lastEmittedRef.current) return;
            lastEmittedRef.current = md;
            onChange(md);
          } catch {
            // serialize 失败极少见，吞掉避免打断编辑
          }
        })();
      }}
    />
  );
}
