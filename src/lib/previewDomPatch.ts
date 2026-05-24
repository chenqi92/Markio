function replaceFindMarks(root: ParentNode) {
  if (root instanceof HTMLElement && root.matches("mark.find-hit")) {
    root.replaceWith(document.createTextNode(root.textContent ?? ""));
    return;
  }
  root.querySelectorAll("mark.find-hit").forEach((mark) => {
    mark.replaceWith(document.createTextNode(mark.textContent ?? ""));
  });
}

function unwrapTableHosts(root: ParentNode) {
  root.querySelectorAll<HTMLElement>(".md-table-add").forEach((button) => button.remove());
  const hosts = [
    ...(root instanceof HTMLElement && root.classList.contains("md-table-host")
      ? [root]
      : []),
    ...Array.from(root.querySelectorAll<HTMLElement>(".md-table-host")),
  ];
  hosts.forEach((host) => {
    const table = host.querySelector("table");
    if (!table || !host.parentNode) return;
    host.parentNode.insertBefore(table, host);
    host.remove();
  });
  if (root instanceof HTMLElement) {
    root.removeAttribute("data-md-table-index");
    root.removeAttribute("data-line");
  }
  root.querySelectorAll<HTMLElement>("[data-md-table-index]").forEach((node) => {
    node.removeAttribute("data-md-table-index");
  });
  root.querySelectorAll<HTMLElement>("[data-line]").forEach((node) => {
    node.removeAttribute("data-line");
  });
}

function normalizedClone(node: Node): Node {
  const clone = node.cloneNode(true);
  if (clone instanceof HTMLElement && clone.classList.contains("md-table-host")) {
    const table = clone.querySelector("table");
    if (table) return normalizedClone(table);
  }
  if (clone instanceof Element || clone instanceof DocumentFragment) {
    replaceFindMarks(clone);
    unwrapTableHosts(clone);
  }
  return clone;
}

function equivalentNode(current: Node, next: Node): boolean {
  if (current.isEqualNode(next)) return true;
  return normalizedClone(current).isEqualNode(normalizedClone(next));
}

function syncPreservedMetadata(current: Node, next: Node) {
  if (!(current instanceof HTMLElement) || !(next instanceof HTMLElement)) return;
  const line = next.getAttribute("data-line");
  const target = current.classList.contains("md-table-host")
    ? current.querySelector<HTMLElement>("table")
    : current;
  if (!target) return;
  if (line === null) target.removeAttribute("data-line");
  else target.setAttribute("data-line", line);
}

export function patchPreviewDom(root: HTMLElement | null, nextHtml: string) {
  if (!root) return;

  const template = document.createElement("template");
  template.innerHTML = nextHtml;

  const currentNodes = Array.from(root.childNodes);
  const nextNodes = Array.from(template.content.childNodes);

  let prefix = 0;
  while (
    prefix < currentNodes.length &&
    prefix < nextNodes.length &&
    equivalentNode(currentNodes[prefix], nextNodes[prefix])
  ) {
    syncPreservedMetadata(currentNodes[prefix], nextNodes[prefix]);
    prefix++;
  }

  let currentSuffix = currentNodes.length - 1;
  let nextSuffix = nextNodes.length - 1;
  while (
    currentSuffix >= prefix &&
    nextSuffix >= prefix &&
    equivalentNode(currentNodes[currentSuffix], nextNodes[nextSuffix])
  ) {
    syncPreservedMetadata(currentNodes[currentSuffix], nextNodes[nextSuffix]);
    currentSuffix--;
    nextSuffix--;
  }

  if (prefix === currentNodes.length && prefix === nextNodes.length) return;

  const before = currentNodes[currentSuffix + 1] ?? null;
  for (let i = prefix; i <= currentSuffix; i++) {
    if (currentNodes[i].parentNode === root) {
      root.removeChild(currentNodes[i]);
    }
  }

  const fragment = document.createDocumentFragment();
  for (let i = prefix; i <= nextSuffix; i++) {
    fragment.appendChild(nextNodes[i].cloneNode(true));
  }
  root.insertBefore(fragment, before?.parentNode === root ? before : null);
}
