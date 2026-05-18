#!/usr/bin/env node
// Generate stepped markdown fixtures for performance / jank testing.
// Output: tests/fixtures/perf/{10kb,100kb,1mb,5mb}.md
// Each fixture is a realistic mix of headings, paragraphs, code blocks,
// math, wikilinks, callouts, tables, and task lists — the constructs that
// stress Markio's render + DOM-enhancement pipeline.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, "../tests/fixtures/perf");
fs.mkdirSync(outDir, { recursive: true });

const STEPS = [
  { name: "10kb", bytes: 10 * 1024 },
  { name: "100kb", bytes: 100 * 1024 },
  { name: "1mb", bytes: 1024 * 1024 },
  { name: "5mb", bytes: 5 * 1024 * 1024 },
];

const SECTION_TEMPLATES = [
  (i) =>
    `## Section ${i} · 概述\n\n这是第 ${i} 节的概述，包含 **粗体**、*斜体*、` +
    `[外链](https://example.com/${i})、[[Section ${i - 1}|上一节]]、行内 \`code\` 与 $E=mc^2$。\n\n`,

  (i) =>
    `### Code Block ${i}\n\n\`\`\`ts\nfunction step${i}(x: number) {\n` +
    `  return x * ${i} + Math.sqrt(${i});\n}\nconst r = step${i}(42);\n` +
    `\`\`\`\n\n`,

  (i) =>
    `> [!note] 备注 ${i}\n> 这是 callout 内容，含 [[Note ${i}]] 和 **强调**。\n>\n` +
    `> - 子要点 1\n> - 子要点 2\n\n`,

  (i) =>
    `> [!warning]+ 警告 ${i}\n> 折叠展开的警告，含公式 $\\int_0^{${i}} f(x)\\,dx$。\n\n`,

  (i) => {
    const rows = Array.from({ length: 4 }, (_, r) =>
      `| col-a-${i}-${r} | col-b-${i}-${r} | col-c-${i}-${r} |`,
    ).join("\n");
    return `### Table ${i}\n\n| Col A | Col B | Col C |\n|---|---|---|\n${rows}\n\n`;
  },

  (i) =>
    `### Tasks ${i}\n\n` +
    `- [ ] 任务 ${i}.a #project !high @05-${(i % 28) + 1} ~2h\n` +
    `- [x] 任务 ${i}.b #docs {50%}\n` +
    `- [ ] 任务 ${i}.c #life !low @05-${((i + 7) % 28) + 1}\n\n`,

  (i) =>
    `### Math Block ${i}\n\n$$\n` +
    `\\sum_{k=1}^{${i}} k = \\frac{${i}(${i}+1)}{2}\n$$\n\n`,

  (i) =>
    `### Paragraph ${i}\n\n` +
    "Markio 是一个 Markdown 编辑器，支持 wikilinks、callouts、math、Mermaid、" +
    "图表、看板视图。这一段是普通正文用于撑文档体积。" +
    `相关：[[Section ${i}#Code Block ${i}]]、[[Section ${i + 1}|下一节]]。\n\n` +
    "再来一段长文本，里面有 `inline code` 和 [外链](https://example.com)，" +
    "以及 #tag1 #tag2 #project 等标签。" +
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod " +
    "tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam.\n\n",
];

function buildSection(i) {
  // round-robin pick a couple of templates
  const a = SECTION_TEMPLATES[i % SECTION_TEMPLATES.length](i);
  const b = SECTION_TEMPLATES[(i + 3) % SECTION_TEMPLATES.length](i);
  return `# Chapter ${i}\n\n${a}${b}`;
}

function generate(targetBytes) {
  const parts = [
    "---\ntitle: perf fixture\ntag: bench\nauthor: gen-script\n---\n\n",
  ];
  let bytes = parts[0].length;
  let i = 0;
  while (bytes < targetBytes) {
    const chunk = buildSection(i++);
    parts.push(chunk);
    bytes += chunk.length;
  }
  return parts.join("");
}

for (const { name, bytes } of STEPS) {
  const file = path.join(outDir, `${name}.md`);
  const content = generate(bytes);
  fs.writeFileSync(file, content);
  const actual = fs.statSync(file).size;
  console.log(
    `  wrote ${path.relative(process.cwd(), file)} (${(actual / 1024).toFixed(1)} KB, target ${(bytes / 1024).toFixed(1)} KB)`,
  );
}

console.log("done.");
