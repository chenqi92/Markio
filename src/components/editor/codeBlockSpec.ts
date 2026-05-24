import {
  createCodeBlockSpec,
  type CodeBlockOptions,
} from "@blocknote/core";

export const CODE_BLOCK_LANGUAGES = {
  text: {
    name: "Plain Text",
    aliases: ["text", "txt", "plain", "plaintext", "none"],
  },
  javascript: {
    name: "JavaScript",
    aliases: ["javascript", "js"],
  },
  typescript: {
    name: "TypeScript",
    aliases: ["typescript", "ts"],
  },
  jsx: {
    name: "JSX",
    aliases: ["jsx", "javascriptreact"],
  },
  tsx: {
    name: "TSX",
    aliases: ["tsx", "typescriptreact"],
  },
  json: {
    name: "JSON",
    aliases: ["json"],
  },
  jsonc: {
    name: "JSONC",
    aliases: ["jsonc"],
  },
  html: {
    name: "HTML",
    aliases: ["html"],
  },
  css: {
    name: "CSS",
    aliases: ["css"],
  },
  scss: {
    name: "SCSS",
    aliases: ["scss"],
  },
  markdown: {
    name: "Markdown",
    aliases: ["markdown", "md"],
  },
  yaml: {
    name: "YAML",
    aliases: ["yaml", "yml"],
  },
  shellscript: {
    name: "Shell",
    aliases: ["shellscript", "bash", "sh", "shell", "zsh"],
  },
  python: {
    name: "Python",
    aliases: ["python", "py"],
  },
  java: {
    name: "Java",
    aliases: ["java"],
  },
  go: {
    name: "Go",
    aliases: ["go", "golang"],
  },
  rust: {
    name: "Rust",
    aliases: ["rust", "rs"],
  },
  sql: {
    name: "SQL",
    aliases: ["sql"],
  },
  xml: {
    name: "XML",
    aliases: ["xml", "svg"],
  },
  c: {
    name: "C",
    aliases: ["c"],
  },
  cpp: {
    name: "C++",
    aliases: ["cpp", "c++"],
  },
  csharp: {
    name: "C#",
    aliases: ["csharp", "c#", "cs"],
  },
  php: {
    name: "PHP",
    aliases: ["php"],
  },
  graphql: {
    name: "GraphQL",
    aliases: ["graphql", "gql"],
  },
  less: {
    name: "Less",
    aliases: ["less"],
  },
  sass: {
    name: "Sass",
    aliases: ["sass"],
  },
  svelte: {
    name: "Svelte",
    aliases: ["svelte"],
  },
  vue: {
    name: "Vue",
    aliases: ["vue"],
  },
  ruby: {
    name: "Ruby",
    aliases: ["ruby", "rb"],
  },
  swift: {
    name: "Swift",
    aliases: ["swift"],
  },
  kotlin: {
    name: "Kotlin",
    aliases: ["kotlin", "kt", "kts"],
  },
  lua: {
    name: "Lua",
    aliases: ["lua"],
  },
  mermaid: {
    name: "Mermaid",
    aliases: ["mermaid", "mmd"],
  },
  latex: {
    name: "LaTeX",
    aliases: ["latex", "tex"],
  },
} satisfies NonNullable<CodeBlockOptions["supportedLanguages"]>;

const CODE_BLOCK_LANGUAGE_ALIASES = new Map<string, string>();

for (const [id, spec] of Object.entries(CODE_BLOCK_LANGUAGES)) {
  CODE_BLOCK_LANGUAGE_ALIASES.set(id, id);
  for (const alias of spec.aliases ?? []) {
    CODE_BLOCK_LANGUAGE_ALIASES.set(alias, id);
  }
}

export function normalizeCodeBlockLanguage(language: unknown): string {
  if (typeof language !== "string") return "text";
  const token = language.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!token) return "text";
  return CODE_BLOCK_LANGUAGE_ALIASES.get(token) ?? token;
}

export const MarkioCodeBlockSpec = createCodeBlockSpec({
  defaultLanguage: "text",
  supportedLanguages: CODE_BLOCK_LANGUAGES,
  createHighlighter: async () => {
    const { createHighlighter } = await import("shiki");
    return createHighlighter({
      themes: ["github-light", "github-dark"],
      langs: [],
    });
  },
});
