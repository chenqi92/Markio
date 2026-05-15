// 解析 markdown body 为看板列 / 任务结构。
// 任务行支持 inline meta：
//   `- [ ] 文案 #tag !high @05-16 ~2h {30%}`
// 列头支持开头 emoji：
//   `# 📥 收件箱`

export type Priority = "high" | "med" | "low";

export interface Task {
  /** 原始行（不变） */
  raw: string;
  /** 在 source 中的 0-based 行号 */
  lineIndex: number;
  /** 去掉 meta token 后的纯文本 */
  text: string;
  done: boolean;
  tag?: string;
  prio?: Priority;
  due?: string;
  est?: string;
  /** 0-100；未声明则 undefined */
  progress?: number;
}

export interface Column {
  /** 不含 emoji */
  title: string;
  emoji?: string;
  tasks: Task[];
}

const PRIO_KEY: Record<string, Priority> = {
  high: "high",
  med: "med",
  mid: "med",
  low: "low",
};

function extractEmoji(raw: string): { emoji?: string; rest: string } {
  // 取头部第一个非 ASCII 字符当 emoji（够用，避免 grapheme 复杂度）
  const m = raw.match(/^([^\sA-Za-z0-9])\s*(.*)$/u);
  if (m) return { emoji: m[1], rest: m[2].trim() };
  return { rest: raw };
}

function parseTaskText(text: string): {
  text: string;
  tag?: string;
  prio?: Priority;
  due?: string;
  est?: string;
  progress?: number;
} {
  let t = text;
  let tag: string | undefined;
  let prio: Priority | undefined;
  let due: string | undefined;
  let est: string | undefined;
  let progress: number | undefined;

  // tag: 第一个 #word
  const tagM = t.match(/(^|\s)#([\p{L}\p{N}_-]+)/u);
  if (tagM) {
    tag = tagM[2];
    t = t.replace(tagM[0], tagM[1]).trim();
  }
  // priority: !high|!med|!low
  const prioM = t.match(/(^|\s)!(high|med|mid|low)\b/i);
  if (prioM) {
    prio = PRIO_KEY[prioM[2].toLowerCase()];
    t = t.replace(prioM[0], prioM[1]).trim();
  }
  // due: @text (no spaces)
  const dueM = t.match(/(^|\s)@(\S+)/);
  if (dueM) {
    due = dueM[2];
    t = t.replace(dueM[0], dueM[1]).trim();
  }
  // est: ~text (no spaces)
  const estM = t.match(/(^|\s)~(\S+)/);
  if (estM) {
    est = estM[2];
    t = t.replace(estM[0], estM[1]).trim();
  }
  // progress: {NN%}
  const pgM = t.match(/\{(\d{1,3})%\}/);
  if (pgM) {
    progress = Math.max(0, Math.min(100, parseInt(pgM[1], 10)));
    t = t.replace(pgM[0], "").trim();
  }

  return { text: t.replace(/\s{2,}/g, " ").trim(), tag, prio, due, est, progress };
}

export function parseKanban(body: string): Column[] {
  const lines = body.split("\n");
  const cols: Column[] = [];
  let current: Column | null = null;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const hMatch = ln.match(/^#{1,3}\s+(.+?)\s*$/);
    if (hMatch) {
      const { emoji, rest } = extractEmoji(hMatch[1].trim());
      current = { title: rest || hMatch[1].trim(), emoji, tasks: [] };
      cols.push(current);
      continue;
    }
    const tMatch = ln.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (tMatch && current) {
      const done = tMatch[1].toLowerCase() === "x";
      const parsed = parseTaskText(tMatch[2]);
      current.tasks.push({
        raw: ln,
        lineIndex: i,
        text: parsed.text,
        done,
        tag: parsed.tag,
        prio: parsed.prio,
        due: parsed.due,
        est: parsed.est,
        progress: parsed.progress,
      });
    }
  }
  return cols;
}

/** body 在 source 中的偏移行数 (frontmatter 占的行数) */
export function bodyLineOffset(source: string, body: string): number {
  return source.slice(0, source.length - body.length).split("\n").length - 1;
}

export function toggleTaskInSource(
  source: string,
  body: string,
  task: Task,
): string | null {
  const offset = bodyLineOffset(source, body);
  const lines = source.split("\n");
  const idx = offset + task.lineIndex;
  if (idx < 0 || idx >= lines.length) return null;
  const oldLine = lines[idx];
  if (!oldLine.includes("[ ]") && !/\[[xX]\]/.test(oldLine)) return null;
  const replaced = task.done
    ? oldLine.replace(/\[[xX]\]/, "[ ]")
    : oldLine.replace("[ ]", "[x]");
  if (replaced === oldLine) return null;
  lines[idx] = replaced;
  return lines.join("\n");
}

/** 在某列末尾插入新任务，返回新 source */
export function appendTaskToColumn(
  source: string,
  body: string,
  columnTitle: string,
  taskText: string,
): string | null {
  const offset = bodyLineOffset(source, body);
  const bodyLines = body.split("\n");
  // 找列头行
  let colStart = -1;
  for (let i = 0; i < bodyLines.length; i++) {
    const hm = bodyLines[i].match(/^#{1,3}\s+(.+?)\s*$/);
    if (!hm) continue;
    const { rest } = extractEmoji(hm[1].trim());
    if (rest === columnTitle || hm[1].trim() === columnTitle) {
      colStart = i;
      break;
    }
  }
  if (colStart < 0) return null;
  // 找下一个列头或文末
  let nextCol = bodyLines.length;
  for (let i = colStart + 1; i < bodyLines.length; i++) {
    if (/^#{1,3}\s+/.test(bodyLines[i])) {
      nextCol = i;
      break;
    }
  }
  // 找该列最后一个非空行
  let insertAt = nextCol;
  while (insertAt > colStart + 1 && bodyLines[insertAt - 1].trim() === "") {
    insertAt--;
  }
  const newLine = `- [ ] ${taskText}`;
  const lines = source.split("\n");
  lines.splice(offset + insertAt, 0, newLine);
  return lines.join("\n");
}

/** 计算总进度（done / total） */
export function computeProgress(cols: Column[]): { done: number; total: number; pct: number } {
  let done = 0;
  let total = 0;
  for (const c of cols) {
    for (const t of c.tasks) {
      total++;
      if (t.done) done++;
    }
  }
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return { done, total, pct };
}

export const TAG_PALETTE: Record<string, [string, string]> = {
  design: ["var(--accent-glow, rgba(10,132,255,0.18))", "var(--accent)"],
  work: ["rgba(94,158,255,0.18)", "#5e9eff"],
  meeting: ["rgba(189,147,249,0.18)", "#bd93f9"],
  life: ["rgba(255,180,80,0.18)", "#d97757"],
  project: ["var(--accent-glow, rgba(10,132,255,0.18))", "var(--accent)"],
  personal: ["rgba(91,138,106,0.18)", "#5b8a6a"],
  reading: ["rgba(168,56,84,0.18)", "#c43d63"],
  fitness: ["rgba(46,200,80,0.18)", "#28c840"],
  finance: ["rgba(123,148,73,0.18)", "#7b9449"],
  infra: ["rgba(123,123,123,0.18)", "#666"],
};

export const PRIO_COLOR: Record<Priority, string> = {
  high: "#ff453a",
  med: "#ff9500",
  low: "#5b8a6a",
};
