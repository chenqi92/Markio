import { useEffect, useMemo, useRef } from "react";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import {
  BlockNoteSchema,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
  type PartialBlock,
} from "@blocknote/core";
import { en as bnEn, zh as bnZh } from "@blocknote/core/locales";
import "@blocknote/mantine/style.css";
// markio 主题 CSS override
import "./BlockEditor.css";
import { MermaidReactBlock } from "./blocks/MermaidBlock";
import { MathReactBlock } from "./blocks/MathBlock";
import {
  CalloutReactBlock,
  tryParseCalloutFromQuote,
  calloutToQuoteText,
} from "./blocks/CalloutBlock";
import {
  WikilinkInlineContent,
  expandWikilinksInInlineContent,
  collapseWikilinksInInlineContent,
} from "./blocks/WikilinkInline";
import { MarkioSlashMenu, WikilinkSuggestionMenu } from "./BlockEditorMenus";
import type { Locale } from "@/i18n";

interface Props {
  /** 初次解析用的 markdown source。后续不再监听 value 变化，避免
   *  BlockNote lossy round-trip 跟外部 updateContent 形成死循环。 */
  value: string;
  /** 笔记路径变化时（切 tab / 切文件）重新解析。 */
  docKey: string;
  onChange: (next: string) => void;
  /** 当前主题是否暗色 —— 传给 BlockNoteView 让它自己切 data-mantine-color-scheme。 */
  dark?: boolean;
  /** UI locale，跟随 markio 设置。换 locale 会重 create editor。 */
  locale?: Locale;
}

/**
 * 自定义 BlockNote schema：在默认 schema 基础上注入 markio 专有的 block：
 * - mermaid 图表（` ```mermaid ` 围栏 ↔ 可编辑 + 渲染预览）
 * - （后续）math / callout / wikilink
 */
const markioSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    mermaid: MermaidReactBlock(),
    math: MathReactBlock(),
    callout: CalloutReactBlock(),
  },
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    wikilink: WikilinkInlineContent,
  },
});

/**
 * Markdown 预处理：BlockNote 的默认 parser 不识别 `$$...$$` 数学块，
 * 我们先把它替换成 ` ```math ` 围栏伪装成 codeBlock，让 BlockNote 把内容
 * 完整带进来；后处理 transformBlocksAfterParse 再把 codeBlock(math) 转
 * 成自定义 math block。
 */
function preprocessMarkdown(md: string): string {
  // 匹配独占整行的 $$ 块（避免误吞行内 $x$）
  // 注意保持非贪婪并允许多行内容
  return md.replace(
    /(^|\n)\$\$\s*\n?([\s\S]*?)\n?\$\$(?=\n|$)/g,
    (_, lead, body) => `${lead}\`\`\`math\n${body.trim()}\n\`\`\``,
  );
}

/**
 * 序列化后处理：把 ` ```math ` 围栏换回 `$$...$$`（GFM 标准），让磁盘上的
 * markdown 维持原始可读语法。
 */
function postprocessMarkdown(md: string): string {
  return md.replace(
    /```math\n([\s\S]*?)\n```/g,
    (_, body) => `$$\n${body}\n$$`,
  );
}

/**
 * 解析方向：BlockNote 把 ` ```mermaid ` 围栏当作普通 codeBlock 解析，
 * 我们在这里后处理，把 language === "mermaid" 的 codeBlock 换成自定义
 * mermaid block。
 */
function transformBlocksAfterParse(blocks: PartialBlock[]): PartialBlock[] {
  return blocks.map((b) => {
    const bb = b as PartialBlock & {
      type?: string;
      props?: Record<string, unknown>;
      content?: unknown;
      children?: PartialBlock[];
    };
    // 在所有 block 的 inline content 里把 `[[xxx]]` 拆成 wikilink inline 节点
    if (bb.content != null) {
      bb.content = expandWikilinksInInlineContent(bb.content) as typeof bb.content;
    }
    if (bb.type === "codeBlock" && typeof bb.props?.language === "string") {
      const lang = bb.props.language.toLowerCase();
      const text = extractCodeText(bb.content);
      if (lang === "mermaid") {
        return {
          type: "mermaid",
          props: { code: text },
        } as unknown as PartialBlock;
      }
      if (lang === "math") {
        return {
          type: "math",
          props: { latex: text },
        } as unknown as PartialBlock;
      }
    }
    // quote 块（BlockNote 把 `> ...` parse 成 quote 块）+ 首行匹配
    // `[!type] title?` → callout
    if (bb.type === "quote") {
      const text = extractCodeText(bb.content);
      const parsed = tryParseCalloutFromQuote(text);
      if (parsed) {
        return {
          type: "callout",
          props: {
            calloutType: parsed.type,
            title: parsed.title,
            body: parsed.body,
          },
        } as unknown as PartialBlock;
      }
    }
    if (bb.children?.length) {
      bb.children = transformBlocksAfterParse(bb.children);
    }
    return bb;
  });
}

function extractCodeText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => {
      if (typeof p === "string") return p;
      if (p && typeof p === "object" && "text" in p) {
        return String((p as { text: string }).text);
      }
      return "";
    })
    .join("");
}

/**
 * 序列化方向：blocksToMarkdownLossy 不认识 mermaid block，会跳过。
 * 我们在传给序列化前把 mermaid block 倒回成 codeBlock，让 BlockNote
 * 正常输出 ` ```mermaid ` 围栏。
 */
function transformBlocksBeforeSerialize(blocks: PartialBlock[]): PartialBlock[] {
  return blocks.map((b) => {
    // 自定义 block 类型在标准 PartialBlock 联合里没有，用 any 绕开 TS 收窄
    const bb = b as unknown as {
      type?: string;
      props?: Record<string, unknown>;
      content?: unknown;
      children?: PartialBlock[];
    };
    // wikilink inline → 还原成 `[[target]]` 文本，让 BlockNote 正常 serialize
    if (bb.content != null) {
      bb.content = collapseWikilinksInInlineContent(bb.content);
    }
    if (bb.type === "mermaid") {
      const code = (bb.props?.code as string) ?? "";
      return {
        type: "codeBlock",
        props: { language: "mermaid" },
        content: [{ type: "text", text: code, styles: {} }],
      } as unknown as PartialBlock;
    }
    if (bb.type === "math") {
      const latex = (bb.props?.latex as string) ?? "";
      return {
        type: "codeBlock",
        props: { language: "math" },
        content: [{ type: "text", text: latex, styles: {} }],
      } as unknown as PartialBlock;
    }
    if (bb.type === "callout") {
      const text = calloutToQuoteText({
        type: (bb.props?.calloutType as string) ?? "note",
        title: (bb.props?.title as string) ?? "",
        body: (bb.props?.body as string) ?? "",
      });
      return {
        type: "quote",
        content: [{ type: "text", text, styles: {} }],
      } as unknown as PartialBlock;
    }
    if (bb.children?.length) {
      bb.children = transformBlocksBeforeSerialize(bb.children);
    }
    return b;
  });
}

export function BlockEditor({
  value,
  docKey,
  onChange,
  dark,
  locale = "en",
}: Props) {
  const dictionary = useMemo(() => (locale === "zh-CN" ? bnZh : bnEn), [locale]);
  const editor = useCreateBlockNote(
    { schema: markioSchema, dictionary },
    [dictionary],
  );
  const hydratedKeyRef = useRef<string | null>(null);
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
    const md = preprocessMarkdown(initialValueRef.current);
    void (async () => {
      const parsed = await editor.tryParseMarkdownToBlocks(md);
      if (myId !== counterRef.current) return;
      const blocks = transformBlocksAfterParse(parsed as PartialBlock[]);
      isHydratingRef.current = true;
      try {
        editor.replaceBlocks(editor.document, blocks);
        lastEmittedRef.current = md;
        hydratedKeyRef.current = docKey;
      } finally {
        queueMicrotask(() => {
          isHydratingRef.current = false;
        });
      }
    })();
    return () => {
      counterRef.current++;
    };
  }, [docKey, editor]);

  const themeMode = useMemo(() => (dark ? "dark" : "light"), [dark]);

  return (
    <BlockNoteView
      editor={editor}
      theme={themeMode}
      // 关闭默认 slash menu，自己挂一个能注入 markio 扩展块的版本
      slashMenu={false}
      onChange={() => {
        if (isHydratingRef.current) return;
        void (async () => {
          try {
            const blocks = transformBlocksBeforeSerialize(
              editor.document as PartialBlock[],
            );
            const raw = await editor.blocksToMarkdownLossy(blocks);
            const md = postprocessMarkdown(raw);
            if (md === lastEmittedRef.current) return;
            lastEmittedRef.current = md;
            onChangeRef.current(md);
          } catch {
            // serialize 失败极少见，吞掉避免打断编辑
          }
        })();
      }}
    >
      <MarkioSlashMenu editor={editor} locale={locale} />
      <WikilinkSuggestionMenu editor={editor} />
    </BlockNoteView>
  );
}
