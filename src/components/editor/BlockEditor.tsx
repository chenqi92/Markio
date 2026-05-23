import { useEffect, useRef } from "react";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/mantine/style.css";
// markio 主题 CSS override —— 在 BlockNote 默认 CSS 变量上叠加 markio 色板。
// 故意放在 mantine/style.css 之后导入，让选择器优先级竞争中胜出。
import "./BlockEditor.css";

interface Props {
  /** 初次解析用的 markdown source。后续不再监听 value 变化，避免
   *  BlockNote lossy round-trip 跟外部 updateContent 形成死循环。 */
  value: string;
  /** 笔记路径变化时（切 tab / 切文件）重新解析。同一文件内部的内部
   *  编辑由 BlockNote 自身状态承载，不重 parse。 */
  docKey: string;
  onChange: (next: string) => void;
  /** 当前主题是否暗色 —— 传给 BlockNoteView 让它自己切 data-mantine-color-scheme。 */
  dark?: boolean;
}

/**
 * BlockNote 风格的 rich editor。
 *
 * 设计要点（防死循环）：
 *
 * - **不**把 value 当 useEffect 依赖。BlockNote 的 markdown 序列化是 lossy 的
 *   （`-` 会变 `*`，列表缩进、表格对齐被规范化），所以 `parseMarkdownToBlocks(v) →
 *   replaceBlocks → blocksToMarkdownLossy ≠ v`。如果再用 value 当 dep，外层 setState
 *   后又会触发 re-parse，循环到天荒地老。
 *
 * - 初始 `replaceBlocks` 期间用 `isHydratingRef` 吞掉 onChange，避免初始化的 lossy
 *   规范化被当成"用户改动"灌回上层。
 *
 * - 切换文件靠 docKey；外部强制回灌（AI 写入等）需要新增专用 API，目前不支持。
 */
export function BlockEditor({ value, docKey, onChange, dark }: Props) {
  const editor = useCreateBlockNote();
  const hydratedKeyRef = useRef<string | null>(null);
  // monotonic id：每次发起 hydrate 都自增，await 回来时校验自己仍是最新一次。
  // 防止 session restore 频繁切 tab 引发的多个并发 hydrate 互相覆盖。
  const hydrationIdRef = useRef<number>(0);
  const isHydratingRef = useRef<boolean>(false);
  const lastEmittedRef = useRef<string>("");
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const initialValueRef = useRef(value);
  initialValueRef.current = value;

  useEffect(() => {
    if (hydratedKeyRef.current === docKey) return;
    const counterRef = hydrationIdRef;
    const myId = ++counterRef.current;
    const md = initialValueRef.current;
    void (async () => {
      const blocks = await editor.tryParseMarkdownToBlocks(md);
      // 不是当前的 hydrate 了（更新一波 docKey 已经超车）就丢弃
      if (myId !== counterRef.current) return;
      isHydratingRef.current = true;
      try {
        editor.replaceBlocks(editor.document, blocks);
        lastEmittedRef.current = md;
        hydratedKeyRef.current = docKey;
      } finally {
        // 等 replaceBlocks 引发的所有 onChange 回弹结束才放开
        queueMicrotask(() => {
          isHydratingRef.current = false;
        });
      }
    })();
    return () => {
      // 标记被新一轮 hydrate 超车
      counterRef.current++;
    };
  }, [docKey, editor]);

  return (
    <BlockNoteView
      editor={editor}
      theme={dark ? "dark" : "light"}
      onChange={() => {
        if (isHydratingRef.current) return;
        void (async () => {
          try {
            const md = await editor.blocksToMarkdownLossy(editor.document);
            if (md === lastEmittedRef.current) return;
            lastEmittedRef.current = md;
            onChangeRef.current(md);
          } catch {
            // serialize 失败极少见，吞掉避免打断编辑
          }
        })();
      }}
    />
  );
}
