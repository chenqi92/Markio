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
import { ChartReactBlock, DEFAULT_CHART_CODE } from "./blocks/ChartBlock";
import {
  DiagramReactBlock,
  DEFAULT_DOT_CODE,
  DEFAULT_PLANTUML_CODE,
} from "./blocks/DiagramBlock";
import {
  MarkioCodeBlockSpec,
  normalizeCodeBlockLanguage,
} from "./codeBlockSpec";
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
import {
  TagInlineContent,
  expandTagsInInlineContent,
  collapseTagsInInlineContent,
} from "./blocks/TagInline";
import {
  MathInlineContent,
  expandInlineMathInInlineContent,
  collapseInlineMathInInlineContent,
} from "./blocks/MathInline";
import { MarkioSlashMenu, WikilinkSuggestionMenu } from "./BlockEditorMenus";
import { devLog } from "@/lib/devLogger";
import { registerMarkdownCommandHandler } from "@/lib/editor-bridge";
import { useDialog } from "@/stores/dialog";
import type { Locale } from "@/i18n";

import type { OutlineItem } from "@/types";

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
  /** 跟 source / split 模式一致的大纲 + 字数回调。anchor 是 BlockNote 的
   *  block.id，对应 DOM 上的 `[data-id="..."]`。 */
  onMeta?: (meta: {
    outline: OutlineItem[];
    words: number;
    readingMinutes: number;
  }) => void;
}

/**
 * 自定义 BlockNote schema：在默认 schema 基础上注入 markio 专有的 block：
 * - mermaid 图表（` ```mermaid ` 围栏 ↔ 可编辑 + 渲染预览）
 * - （后续）math / callout / wikilink
 */
const markioSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    codeBlock: MarkioCodeBlockSpec,
    mermaid: MermaidReactBlock(),
    math: MathReactBlock(),
    chart: ChartReactBlock(),
    diagram: DiagramReactBlock(),
    callout: CalloutReactBlock(),
  },
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    wikilink: WikilinkInlineContent,
    tag: TagInlineContent,
    mathInline: MathInlineContent,
  },
});

/** 从 inline content 数组抽出可读文本（剥掉 wikilink/tag 等的 wrap，
 *  剩纯文字）。给大纲生成 heading 文本用。 */
function inlineContentToPlainText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => {
      if (typeof p === "string") return p;
      if (!p || typeof p !== "object") return "";
      const n = p as { type?: string; text?: string; props?: Record<string, unknown> };
      if (n.type === "text" && typeof n.text === "string") return n.text;
      if (n.type === "wikilink") return String(n.props?.target ?? "");
      if (n.type === "tag") return `#${String(n.props?.name ?? "")}`;
      return "";
    })
    .join("");
}

/** 扫 BlockNote document 的所有 heading 块，生成跟 source/split 模式同型的
 *  OutlineItem[]。anchor 用 block.id —— BlockNote 在每个 block 容器 DOM 上
 *  写 data-id={id}，Outline 点击时 querySelector 即可定位。 */
function extractOutline(blocks: PartialBlock[]): OutlineItem[] {
  const out: OutlineItem[] = [];
  const walk = (arr: PartialBlock[]) => {
    for (const b of arr) {
      const bb = b as PartialBlock & {
        id?: string;
        type?: string;
        props?: Record<string, unknown>;
        content?: unknown;
        children?: PartialBlock[];
      };
      if (bb.type === "heading" && bb.id) {
        const rawLevel = Number(bb.props?.level);
        const level = Number.isFinite(rawLevel) ? Math.max(1, Math.min(6, rawLevel)) : 1;
        const text = inlineContentToPlainText(bb.content).trim();
        out.push({ level, text, anchor: bb.id });
      }
      if (bb.children?.length) walk(bb.children);
    }
  };
  walk(blocks);
  return out;
}

/** 粗略字数：英文按空白分，中文每字算一。够给 status bar 用。 */
function countWords(blocks: PartialBlock[]): number {
  let total = 0;
  const walk = (arr: PartialBlock[]) => {
    for (const b of arr) {
      const bb = b as PartialBlock & { content?: unknown; children?: PartialBlock[] };
      const text = inlineContentToPlainText(bb.content);
      // 中文/日文字 + 英文单词
      const cjk = (text.match(/[一-鿿぀-ヿ가-힯]/g) ?? []).length;
      const ascii = (text.match(/[A-Za-z0-9]+/g) ?? []).length;
      total += cjk + ascii;
      if (bb.children?.length) walk(bb.children);
    }
  };
  walk(blocks);
  return total;
}

/**
 * 把开头的 YAML frontmatter（` --- ... --- `）切走。Frontmatter 在 markio
 * 的 "属性" 侧栏里编辑（PropertyExplorer），BlockNote 模式下不显示，
 * 避免被当成普通段落/分割线/H2 错渲染。
 *
 * 返回 [前置 frontmatter（含两道 ---），剩余 body]。如果没有 frontmatter，
 * 第一项是空串。
 */
function splitFrontmatter(md: string): [string, string] {
  if (!md.startsWith("---\n") && !md.startsWith("---\r\n")) return ["", md];
  const body = md.replace(/^---\r?\n/, "");
  const end = body.search(/\n---\s*(?:\n|$)/);
  if (end < 0) return ["", md];
  const headLen = md.length - body.length + end + "\n---".length;
  // 后面再跟一个换行就一起吃掉，避免 body 开头多空行
  const after = md[headLen] === "\n" ? headLen + 1 : headLen;
  return [md.slice(0, after), md.slice(after)];
}

/**
 * Markdown 预处理：BlockNote 的默认 parser 不识别 `$$...$$` 数学块，
 * 我们先把它替换成 ` ```math ` 围栏伪装成 codeBlock，让 BlockNote 把内容
 * 完整带进来；后处理 transformBlocksAfterParse 再把 codeBlock(math) 转
 * 成自定义 math block。
 */
const BLOCK_EDITOR_RICH_VISUALS_ENABLED = true;

function firstFenceToken(input: string): string {
  return input.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

function parseFenceAttr(input: string, key: string): string | null {
  const m = input.match(new RegExp(`${key}=("[^"]*"|'[^']*'|\\S+)`));
  if (!m) return null;
  const raw = m[1] ?? "";
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}

function isChartLang(lang: string): boolean {
  return lang === "chart" || lang === "markio-chart" || lang === "charts";
}

function isGraphvizLang(lang: string): boolean {
  return lang === "dot" || lang === "graphviz";
}

function isPlantUmlLang(lang: string): boolean {
  return lang === "plantuml" || lang === "puml";
}

function preprocessMarkdown(md: string): string {
  if (!BLOCK_EDITOR_RICH_VISUALS_ENABLED) return md;
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
    // 在所有 block 的 inline content 里把 `[[xxx]]` / `#tag` / `$x$`
    // 拆成对应的 inline content 节点。顺序：先 wikilink（避免 `[[#tag]]`
    // 被 tag 抢），再 tag，最后 inline math。
    if (bb.content != null) {
      const a = expandWikilinksInInlineContent(bb.content);
      const b = expandTagsInInlineContent(a);
      bb.content = BLOCK_EDITOR_RICH_VISUALS_ENABLED
        ? (expandInlineMathInInlineContent(b) as typeof bb.content)
        : (b as typeof bb.content);
    }
    if (bb.type === "codeBlock" && typeof bb.props?.language === "string") {
      const rawLang = bb.props.language;
      const lang = firstFenceToken(rawLang);
      const text = extractCodeText(bb.content);
      if (BLOCK_EDITOR_RICH_VISUALS_ENABLED && lang === "mermaid") {
        return {
          type: "mermaid",
          props: { code: text },
        } as unknown as PartialBlock;
      }
      if (BLOCK_EDITOR_RICH_VISUALS_ENABLED && lang === "math") {
        return {
          type: "math",
          props: { latex: text },
        } as unknown as PartialBlock;
      }
      if (BLOCK_EDITOR_RICH_VISUALS_ENABLED && isChartLang(lang)) {
        return {
          type: "chart",
          props: { code: text },
        } as unknown as PartialBlock;
      }
      if (BLOCK_EDITOR_RICH_VISUALS_ENABLED && isGraphvizLang(lang)) {
        return {
          type: "diagram",
          props: { kind: "graphviz", code: text, server: "" },
        } as unknown as PartialBlock;
      }
      if (BLOCK_EDITOR_RICH_VISUALS_ENABLED && isPlantUmlLang(lang)) {
        return {
          type: "diagram",
          props: {
            kind: "plantuml",
            code: text,
            server: parseFenceAttr(rawLang, "server") ?? "",
          },
        } as unknown as PartialBlock;
      }
      (bb as { props?: Record<string, unknown> }).props = {
        ...(bb.props ?? {}),
        language: normalizeCodeBlockLanguage(rawLang),
      };
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
    // 自定义 inline content → 还原成纯文本，让 BlockNote 正常 serialize
    if (bb.content != null) {
      const a = collapseInlineMathInInlineContent(bb.content);
      const b = collapseTagsInInlineContent(a);
      bb.content = collapseWikilinksInInlineContent(b);
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
    if (bb.type === "chart") {
      const code = (bb.props?.code as string) ?? "";
      return {
        type: "codeBlock",
        props: { language: "chart" },
        content: [{ type: "text", text: code, styles: {} }],
      } as unknown as PartialBlock;
    }
    if (bb.type === "diagram") {
      const kind = bb.props?.kind === "plantuml" ? "plantuml" : "graphviz";
      const code = (bb.props?.code as string) ?? "";
      const server = String(bb.props?.server ?? "").trim();
      const language =
        kind === "plantuml" && server
          ? `plantuml server="${server.replace(/"/g, "")}"`
          : kind === "plantuml"
            ? "plantuml"
            : "dot";
      return {
        type: "codeBlock",
        props: { language },
        content: [{ type: "text", text: code, styles: {} }],
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

type CommandBlock = {
  id?: string;
  type?: string;
  content?: unknown;
  props?: Record<string, unknown>;
};

type CommandEditor = {
  focus: () => void;
  getSelectedText: () => string;
  getTextCursorPosition: () => { block: CommandBlock; nextBlock?: CommandBlock };
  updateBlock: (block: unknown, update: PartialBlock) => unknown;
  insertBlocks: (
    blocks: PartialBlock[],
    referenceBlock: unknown,
    placement?: "before" | "after",
  ) => CommandBlock[];
  setTextCursorPosition: (
    targetBlock: unknown,
    placement?: "start" | "end",
  ) => void;
  insertInlineContent: (
    content: unknown,
    options?: { updateSelection?: boolean },
  ) => void;
  toggleStyles: (styles: Record<string, boolean | string>) => void;
  createLink: (url: string, text?: string) => void;
};

function currentBlock(editor: CommandEditor): CommandBlock | null {
  try {
    return editor.getTextCursorPosition().block;
  } catch {
    return null;
  }
}

function updateCurrentBlock(
  editor: CommandEditor,
  update: PartialBlock,
): boolean {
  const block = currentBlock(editor);
  if (!block) return false;
  editor.updateBlock(block, update);
  editor.focus();
  return true;
}

function insertAfterCursor(editor: CommandEditor, block: PartialBlock): boolean {
  const ref = currentBlock(editor);
  if (!ref) return false;
  const inserted = editor.insertBlocks([block], ref, "after")[0];
  try {
    editor.setTextCursorPosition(inserted, "start");
  } catch {
    /* custom no-content blocks do not always accept text cursor placement */
  }
  editor.focus();
  return true;
}

function tableRows(rows: number, cols: number) {
  const safeRows = Math.max(1, Math.min(20, Math.floor(rows)));
  const safeCols = Math.max(1, Math.min(12, Math.floor(cols)));
  return Array.from({ length: safeRows + 1 }, () => ({
    cells: Array(safeCols).fill(""),
  }));
}

function splitDelimitedLine(line: string): string[] {
  if (line.includes("\t")) return line.split("\t").map((cell) => cell.trim());
  if (line.includes("|")) {
    return line
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((cell) => cell.trim());
  }
  return line.split(/[,，]/).map((cell) => cell.trim());
}

function tableRowsFromText(input: string) {
  const lines = input
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const rows = lines
    .map(splitDelimitedLine)
    .filter((row) => row.length > 0 && row.some(Boolean));
  if (rows.length === 0) return null;
  const cols = Math.max(...rows.map((row) => row.length));
  if (cols < 2) return null;
  return rows.map((row) => {
    const cells = row.slice();
    while (cells.length < cols) cells.push("");
    return { cells };
  });
}

function insertTextParagraph(editor: CommandEditor, text: string): boolean {
  return insertAfterCursor(editor, {
    type: "paragraph",
    content: [{ type: "text", text, styles: {} }],
  } as unknown as PartialBlock);
}

function runBlockEditorCommand(
  editor: CommandEditor,
  name: string,
  args: readonly unknown[],
): boolean {
  const style = (styles: Record<string, boolean | string>) => {
    editor.toggleStyles(styles);
    editor.focus();
    return true;
  };

  switch (name) {
    case "bold":
      return style({ bold: true });
    case "italic":
      return style({ italic: true });
    case "underline":
      return style({ underline: true });
    case "strike":
      return style({ strike: true });
    case "inlineCode":
      return style({ code: true });
    case "mark":
      return style({ backgroundColor: "yellow" });
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
      return updateCurrentBlock(editor, {
        type: "heading",
        props: { level: Number(name.slice(1)) },
      } as unknown as PartialBlock);
    case "bulletList":
      return updateCurrentBlock(editor, {
        type: "bulletListItem",
      } as unknown as PartialBlock);
    case "orderedList":
      return updateCurrentBlock(editor, {
        type: "numberedListItem",
      } as unknown as PartialBlock);
    case "taskList":
      return updateCurrentBlock(editor, {
        type: "checkListItem",
        props: { checked: false },
      } as unknown as PartialBlock);
    case "quote":
      return updateCurrentBlock(editor, {
        type: "quote",
      } as unknown as PartialBlock);
    case "wikiLink": {
      const target = editor.getSelectedText().trim() || "笔记名";
      editor.insertInlineContent(
        [{ type: "wikilink", props: { target } }],
        { updateSelection: true },
      );
      editor.focus();
      return true;
    }
    case "link": {
      void (async () => {
        const selected = editor.getSelectedText().trim();
        const url = await useDialog.getState().prompt({
          title: "链接 URL",
          defaultValue: /^https?:\/\//i.test(selected) ? selected : "https://",
          confirmLabel: "插入",
        });
        if (!url) return;
        editor.createLink(url, selected || "链接文本");
        editor.focus();
      })();
      return true;
    }
    case "image": {
      void (async () => {
        const url = await useDialog.getState().prompt({
          title: "图片 URL",
          defaultValue: "https://",
          confirmLabel: "插入",
        });
        if (!url) return;
        insertAfterCursor(editor, {
          type: "image",
          props: { url, caption: "", name: "" },
        } as unknown as PartialBlock);
      })();
      return true;
    }
    case "insertTable": {
      const rows = Number(args[0] ?? 3);
      const cols = Number(args[1] ?? 3);
      return insertAfterCursor(editor, {
        type: "table",
        content: {
          type: "tableContent",
          rows: tableRows(rows, cols),
        },
      } as unknown as PartialBlock);
    }
    case "selectionToTable": {
      const rows = tableRowsFromText(editor.getSelectedText());
      return insertAfterCursor(editor, {
        type: "table",
        content: {
          type: "tableContent",
          rows: rows ?? tableRows(3, 3),
        },
      } as unknown as PartialBlock);
    }
    case "codeBlock":
      return insertAfterCursor(editor, {
        type: "codeBlock",
        props: { language: "typescript" },
        content: [{ type: "text", text: "代码", styles: {} }],
      } as unknown as PartialBlock);
    case "mathBlock":
      return insertAfterCursor(editor, {
        type: "math",
        props: { latex: "公式" },
      } as unknown as PartialBlock);
    case "mermaid":
      return insertAfterCursor(editor, {
        type: "mermaid",
        props: { code: "graph LR\n  A --> B" },
      } as unknown as PartialBlock);
    case "chart":
      return insertAfterCursor(editor, {
        type: "chart",
        props: { code: DEFAULT_CHART_CODE },
      } as unknown as PartialBlock);
    case "graphviz":
      return insertAfterCursor(editor, {
        type: "diagram",
        props: { kind: "graphviz", code: DEFAULT_DOT_CODE, server: "" },
      } as unknown as PartialBlock);
    case "plantuml":
      return insertAfterCursor(editor, {
        type: "diagram",
        props: { kind: "plantuml", code: DEFAULT_PLANTUML_CODE, server: "" },
      } as unknown as PartialBlock);
    case "callout":
      return insertAfterCursor(editor, {
        type: "callout",
        props: { calloutType: "tip", title: "", body: "提示内容" },
      } as unknown as PartialBlock);
    case "footnote":
      return insertTextParagraph(editor, "[^1]: 脚注内容");
    case "horizontalRule":
      return insertAfterCursor(editor, {
        type: "divider",
      } as unknown as PartialBlock);
    default:
      return false;
  }
}

export function BlockEditor({
  value,
  docKey,
  onChange,
  dark,
  locale = "en",
  onMeta,
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
  // 当前文档的 frontmatter 前缀（含 `---\n...\n---\n`），serialize 时拼回
  const frontmatterRef = useRef<string>("");
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onMetaRef = useRef(onMeta);
  onMetaRef.current = onMeta;
  const initialValueRef = useRef(value);
  initialValueRef.current = value;
  // emit 节流：blocksToMarkdownLossy 遍历整个文档 + transform 后处理，
  // 每个按键都跑会让大文档输入明显卡顿。debounce 到用户停下来一小段再 emit。
  const emitTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const commandEditor = editor as unknown as CommandEditor;
    registerMarkdownCommandHandler((name, args) =>
      runBlockEditorCommand(commandEditor, name, args),
    );
    return () => registerMarkdownCommandHandler(null);
  }, [editor]);

  useEffect(() => {
    if (hydratedKeyRef.current === docKey) return;
    const counterRef = hydrationIdRef;
    const myId = ++counterRef.current;
    const raw = initialValueRef.current;
    devLog("debug", "blockEditor.hydrate.start", {
      docKey,
      chars: raw.length,
    });
    // 先切掉 frontmatter，存到 ref，BlockNote 只看 body
    const [frontmatter, body] = splitFrontmatter(raw);
    frontmatterRef.current = frontmatter;
    const md = preprocessMarkdown(body);
    void (async () => {
      const parseT0 = performance.now();
      const parsed = await editor.tryParseMarkdownToBlocks(md);
      if (myId !== counterRef.current) return;
      devLog("debug", "blockEditor.parse.done", {
        docKey,
        ms: Math.round(performance.now() - parseT0),
        blocks: parsed.length,
      });
      const transformT0 = performance.now();
      const blocks = transformBlocksAfterParse(parsed as PartialBlock[]);
      devLog("debug", "blockEditor.transform.done", {
        docKey,
        ms: Math.round(performance.now() - transformT0),
        blocks: blocks.length,
      });
      isHydratingRef.current = true;
      try {
        const replaceT0 = performance.now();
        editor.replaceBlocks(editor.document, blocks);
        devLog("debug", "blockEditor.replace.done", {
          docKey,
          ms: Math.round(performance.now() - replaceT0),
          blocks: blocks.length,
        });
        lastEmittedRef.current = raw;
        hydratedKeyRef.current = docKey;
        // hydrate 完立刻吐一次大纲，避免 BlockNote 模式下右栏大纲空一段
        if (onMetaRef.current) {
          const snapshot = editor.document as PartialBlock[];
          const outline = extractOutline(snapshot);
          const words = countWords(snapshot);
          onMetaRef.current({
            outline,
            words,
            readingMinutes: Math.max(1, Math.round(words / 500)),
          });
        }
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

  // 卸载时：若还有 pending 的 emit timer，强制立刻 flush 一次，避免最后
  // 几次按键丢失（用户切 tab / 关闭编辑器时）
  useEffect(() => {
    return () => {
      if (emitTimerRef.current != null) {
        window.clearTimeout(emitTimerRef.current);
        emitTimerRef.current = null;
        try {
          const snapshot = JSON.parse(
            JSON.stringify(editor.document),
          ) as PartialBlock[];
          const blocks = transformBlocksBeforeSerialize(snapshot);
          const bodyMd = editor.blocksToMarkdownLossy(blocks);
          const body = postprocessMarkdown(bodyMd);
          const md = frontmatterRef.current + body;
          if (md !== lastEmittedRef.current) {
            lastEmittedRef.current = md;
            onChangeRef.current(md);
          }
        } catch {
          /* ignore */
        }
      }
    };
  }, [editor]);

  const themeMode = useMemo(() => (dark ? "dark" : "light"), [dark]);

  return (
    <div style={{ width: "100%", height: "100%" }}>
    <BlockNoteView
      editor={editor}
      theme={themeMode}
      // 关闭默认 slash menu，自己挂一个能注入 markio 扩展块的版本
      slashMenu={false}
      onChange={() => {
        if (isHydratingRef.current) return;
        // 节流：用户连续输入时每 220ms 才 serialize 一次，避免
        // blocksToMarkdownLossy + transform 在每个按键上跑导致卡顿
        if (emitTimerRef.current != null) {
          window.clearTimeout(emitTimerRef.current);
        }
        emitTimerRef.current = window.setTimeout(() => {
          emitTimerRef.current = null;
          try {
            // deep clone 避免 transform 时 mutate editor.document 内部对象
            const snapshot = JSON.parse(
              JSON.stringify(editor.document),
            ) as PartialBlock[];
            // 大纲 / 字数：从未 transform 的 snapshot 提取（保留 wikilink/tag
            // 等结构，方便抽 plain text 时识别 props）
            if (onMetaRef.current) {
              const outline = extractOutline(snapshot);
              const words = countWords(snapshot);
              onMetaRef.current({
                outline,
                words,
                readingMinutes: Math.max(1, Math.round(words / 500)),
              });
            }
            const blocks = transformBlocksBeforeSerialize(snapshot);
            const bodyMd = editor.blocksToMarkdownLossy(blocks);
            const body = postprocessMarkdown(bodyMd);
            // 拼回 frontmatter 前缀，让磁盘上的 .md 保持原始 YAML 头
            const md = frontmatterRef.current + body;
            if (md === lastEmittedRef.current) return;
            lastEmittedRef.current = md;
            onChangeRef.current(md);
          } catch {
            // serialize 失败极少见，吞掉避免打断编辑
          }
        }, 220);
      }}
    >
      <MarkioSlashMenu editor={editor} locale={locale} />
      <WikilinkSuggestionMenu editor={editor} />
    </BlockNoteView>
    </div>
  );
}
