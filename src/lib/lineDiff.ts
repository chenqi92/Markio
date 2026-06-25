// 行级差异：把 old → new 的变化拆成「相等 / 删除 / 新增」三类行。
// 用于历史版本对比（old = 快照，new = 当前文档）。
//
// 先裁掉公共前后缀（最常见情形——只改了中间几行），再对中间用 LCS 回溯，
// 控制 O(m·n) DP 的规模；中间块过大时退化为「整段删 + 整段加」，避免内存爆掉。

export type DiffRowType = "eq" | "del" | "add";

export interface DiffRow {
  type: DiffRowType;
  text: string;
}

/** 中间块 m·n 的上限，超过则粗粒度对比（约 1600×1600 行）。 */
const LCS_CELL_CAP = 2_500_000;

function lcsDiff(a: string[], b: string[]): DiffRow[] {
  const m = a.length;
  const n = b.length;
  if (m === 0) return b.map((text) => ({ type: "add", text }));
  if (n === 0) return a.map((text) => ({ type: "del", text }));

  // 超大块：不建表，直接整段删旧、整段加新。
  if (m * n > LCS_CELL_CAP) {
    return [
      ...a.map((text): DiffRow => ({ type: "del", text })),
      ...b.map((text): DiffRow => ({ type: "add", text })),
    ];
  }

  // dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度。
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] =
        a[i] === b[j]
          ? dp[i + 1]![j + 1]! + 1
          : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      rows.push({ type: "eq", text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      rows.push({ type: "del", text: a[i]! });
      i++;
    } else {
      rows.push({ type: "add", text: b[j]! });
      j++;
    }
  }
  while (i < m) rows.push({ type: "del", text: a[i++]! });
  while (j < n) rows.push({ type: "add", text: b[j++]! });
  return rows;
}

/** 计算 old → new 的行级差异。 */
export function diffLines(oldText: string, newText: string): DiffRow[] {
  if (oldText === newText) {
    return oldText.split("\n").map((text) => ({ type: "eq", text }));
  }
  const a = oldText.split("\n");
  const b = newText.split("\n");

  // 公共前缀
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;

  // 公共后缀（不与前缀重叠）
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    suf++;
  }

  const head: DiffRow[] = a.slice(0, pre).map((text) => ({ type: "eq", text }));
  const tail: DiffRow[] = a
    .slice(a.length - suf)
    .map((text) => ({ type: "eq", text }));
  const midA = a.slice(pre, a.length - suf);
  const midB = b.slice(pre, b.length - suf);

  return [...head, ...lcsDiff(midA, midB), ...tail];
}

/** 统计新增 / 删除行数（相等行不计），用于头部摘要。 */
export function diffStat(rows: DiffRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const r of rows) {
    if (r.type === "add") added++;
    else if (r.type === "del") removed++;
  }
  return { added, removed };
}
