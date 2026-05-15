const CALLOUT_TITLES: Record<string, string> = {
  note: "备注",
  abstract: "摘要",
  summary: "摘要",
  tldr: "摘要",
  info: "信息",
  todo: "待办",
  tip: "提示",
  hint: "提示",
  important: "重要",
  success: "成功",
  check: "完成",
  done: "完成",
  question: "问题",
  help: "帮助",
  faq: "问题",
  warning: "警告",
  caution: "注意",
  attention: "注意",
  danger: "危险",
  error: "错误",
  bug: "问题",
  example: "示例",
  quote: "引用",
};

const CALLOUT_ALIASES: Record<string, string> = {
  hint: "tip",
  important: "important",
  caution: "warning",
  attention: "warning",
  error: "danger",
  check: "success",
  done: "success",
  help: "question",
  faq: "question",
  abstract: "note",
  summary: "note",
  tldr: "note",
};

const markerRe = /^\s*\[!([a-zA-Z][\w-]*)\]([+-])?(?:[ \t]+([^\r\n]+))?(?:\r?\n)?/;

function firstTextNode(root: HTMLElement): Text | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (parent?.closest("pre,code,script,style")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  return walker.nextNode() as Text | null;
}

function removeEmptyLeadingParagraph(blockquote: HTMLElement) {
  const first = blockquote.firstElementChild;
  if (first?.tagName === "P" && !first.textContent?.trim() && first.children.length === 0) {
    first.remove();
  }
}

export function enhanceCallouts(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>("blockquote:not([data-callout-enhanced])").forEach((blockquote) => {
    const textNode = firstTextNode(blockquote);
    if (!textNode) return;
    const match = textNode.nodeValue?.match(markerRe);
    if (!match) return;

    const rawType = match[1].toLowerCase();
    const type = CALLOUT_ALIASES[rawType] ?? rawType;
    const title = match[3]?.trim() || CALLOUT_TITLES[rawType] || CALLOUT_TITLES[type] || rawType.toUpperCase();
    const fold = match[2] ?? "";

    textNode.nodeValue = (textNode.nodeValue ?? "").slice(match[0].length).replace(/^\s+/, "");
    removeEmptyLeadingParagraph(blockquote);

    const head = document.createElement("div");
    head.className = "callout-head";
    const label = document.createElement("span");
    label.className = "callout-label";
    label.textContent = type.toUpperCase();
    const titleEl = document.createElement("span");
    titleEl.className = "callout-title";
    titleEl.textContent = title;
    head.append(label, titleEl);

    blockquote.classList.add("callout", `callout-${type}`);
    blockquote.dataset.calloutEnhanced = "1";
    blockquote.dataset.calloutType = type;
    if (fold) blockquote.dataset.calloutFold = fold;
    blockquote.prepend(head);
  });
}
