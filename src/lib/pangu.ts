// 在 CJK 与 ASCII 字母数字之间补一个 ASCII 空格（"盘古之白"）。
// 跳过：行内代码 `…`、围栏代码块 ```…```、链接 url 部分 (…)。

const CJK = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}";
// 中→英：CJK 紧跟 字母/数字
const RE_CJK_ASCII = new RegExp(`([${CJK}])([A-Za-z0-9@_])`, "gu");
// 英→中：字母/数字/) 紧跟 CJK
const RE_ASCII_CJK = new RegExp(`([A-Za-z0-9_)\\]])([${CJK}])`, "gu");

export function spaceCJK(input: string): string {
  if (!input) return input;
  // 按围栏块切分，奇数段是代码块，跳过
  const fences = input.split(/(\n```[\s\S]*?\n```|\n~~~[\s\S]*?\n~~~)/g);
  return fences
    .map((seg, i) => (i % 2 === 1 ? seg : spaceCJKLineByLine(seg)))
    .join("");
}

function spaceCJKLineByLine(seg: string): string {
  return seg
    .split("\n")
    .map((ln) => spaceCJKInLine(ln))
    .join("\n");
}

function spaceCJKInLine(line: string): string {
  // 行内代码段 `…` 一并保留
  const parts = line.split(/(`[^`\n]*`)/g);
  return parts
    .map((p, i) => {
      if (i % 2 === 1) return p; // 行内代码不动
      // markdown 链接 url：跳过 ](...) 内
      return p.replace(/(\]\([^)\n]*\))|([^\]]+)/g, (_m, link, plain) => {
        if (link) return link;
        return plain.replace(RE_CJK_ASCII, "$1 $2").replace(RE_ASCII_CJK, "$1 $2");
      });
    })
    .join("");
}
