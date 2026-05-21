// 从 `- [ ] ...` 这种 markdown 任务行里抽出结构化数据。
// 支持的标记（在文本里出现的顺序任意）：
//   #tag              → tag
//   @YYYY-MM-DD       → due
//   📅 YYYY-MM-DD      → due (Obsidian style)
//   (YYYY-MM-DD)      → due，括在末尾
//   !high / !med / !low → priority
//   🔴 / 🟡 / 🟢       → priority (high/med/low)
//
// 解析出的结构会被 TaskInbox 用来分组与排序；没有的字段 = undefined。

export type TaskPriority = "high" | "med" | "low";

export interface ParsedTask {
  text: string;
  tags: string[];
  due?: string; // YYYY-MM-DD
  priority?: TaskPriority;
}

const TASK_LINE = /^\s*[-*+]\s+\[\s+\]\s+(.+?)\s*$/;
const DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b/;

/** 不是任务行返回 null。是的话返回结构化任务。 */
export function parseTask(rawLine: string): ParsedTask | null {
  const m = rawLine.match(TASK_LINE);
  if (!m) return null;
  let text = m[1]!;

  const tags: string[] = [];
  text = text.replace(/(^|\s)#([\w一-鿿/.-]+)/g, (_, lead: string, name: string) => {
    tags.push(name);
    return lead;
  });

  let priority: TaskPriority | undefined;
  // emoji 优先
  if (/🔴/.test(text)) {
    priority = "high";
    text = text.replace(/🔴/g, "");
  } else if (/🟡/.test(text)) {
    priority = "med";
    text = text.replace(/🟡/g, "");
  } else if (/🟢/.test(text)) {
    priority = "low";
    text = text.replace(/🟢/g, "");
  } else {
    const pm = text.match(/(?:^|\s)!(high|med|low)\b/);
    if (pm) {
      priority = pm[1] as TaskPriority;
      text = text.replace(/(?:^|\s)!(?:high|med|low)\b/, "");
    }
  }

  let due: string | undefined;
  // 📅 YYYY-MM-DD
  const obs = text.match(/📅\s*(\d{4}-\d{2}-\d{2})/);
  if (obs) {
    due = obs[1];
    text = text.replace(/📅\s*\d{4}-\d{2}-\d{2}/, "");
  }
  if (!due) {
    // @YYYY-MM-DD
    const at = text.match(/(?:^|\s)@(\d{4}-\d{2}-\d{2})\b/);
    if (at) {
      due = at[1];
      text = text.replace(/(?:^|\s)@\d{4}-\d{2}-\d{2}\b/, "");
    }
  }
  if (!due) {
    // 末尾 (YYYY-MM-DD)
    const tail = text.match(/\((\d{4}-\d{2}-\d{2})\)\s*$/);
    if (tail) {
      due = tail[1];
      text = text.replace(/\(\d{4}-\d{2}-\d{2}\)\s*$/, "");
    }
  }
  // fallback：行内任意位置出现的 ISO 日期也认（最后兜底，不消耗）
  if (!due) {
    const any = text.match(DATE_RE);
    if (any) due = any[1];
  }

  text = text.replace(/\s+/g, " ").trim();
  return { text, tags, due, priority };
}

/** 按优先级 → 截止日期 → 文本顺序排序，方便 list 渲染。 */
export function compareTasks(a: ParsedTask, b: ParsedTask): number {
  const prioRank: Record<TaskPriority | "_", number> = { high: 0, med: 1, low: 2, _: 3 };
  const pa = prioRank[a.priority ?? "_"];
  const pb = prioRank[b.priority ?? "_"];
  if (pa !== pb) return pa - pb;
  if (a.due && b.due) return a.due < b.due ? -1 : a.due > b.due ? 1 : 0;
  if (a.due) return -1;
  if (b.due) return 1;
  return a.text.localeCompare(b.text);
}

/** 把 ISO 日期分类到 今天/明天/本周/下周/晚些时候/已过期 */
export type DueBucket = "overdue" | "today" | "tomorrow" | "thisWeek" | "later" | "none";
export function dueBucket(due: string | undefined, now = new Date()): DueBucket {
  if (!due) return "none";
  const todayIso = now.toISOString().slice(0, 10);
  if (due < todayIso) return "overdue";
  if (due === todayIso) return "today";
  const tmrw = new Date(now);
  tmrw.setDate(now.getDate() + 1);
  if (due === tmrw.toISOString().slice(0, 10)) return "tomorrow";
  // 7 天内
  const wkEnd = new Date(now);
  wkEnd.setDate(now.getDate() + 7);
  if (due <= wkEnd.toISOString().slice(0, 10)) return "thisWeek";
  return "later";
}
