// 服务器 / 凭据块渲染。markdown 里 ```server 围栏（别名 conn / credential …）
// 经 Rust md_render 变成 <div class="server-block" data-server="<urlencoded>">，
// 这里把它渲染成一张「连接卡」：主机 / 端口 / 账号 / 密码 / 网址 等字段排版成
// 带复制按钮的行，密码默认打码可一键显隐，并按协议类型给出「连接」动作
// （web 直接在浏览器打开；ssh / mysql / rdp 等复制对应命令到剪贴板）。
//
// 设计上跟 charts.ts / diagrams.ts 一致：纯 DOM 构建、本地离线、不外发任何内容
// （只有用户点「打开」时才用 opener 把 http(s) 网址交给系统浏览器）。卡片很轻，
// 不进 previewVisualCache —— 缓存会丢事件监听，重渲染反而更便宜也更安全
//（每次重置密码为打码态）。

import { openExternal } from "./opener";
import {
  scheduleVisualBlocks,
  type VisualBlockHandle,
  type VisualSchedulerOptions,
} from "./visualScheduler";

export type FieldKind =
  | "host"
  | "lan"
  | "port"
  | "user"
  | "password"
  | "url"
  | "db"
  | "note"
  | "text";

export interface ServerField {
  rawKey: string;
  label: string;
  value: string;
  kind: FieldKind;
}

export interface ServerEntry {
  name: string;
  type: string;
  fields: ServerField[];
}

interface KeySpec {
  kind: FieldKind | "name" | "type";
  label: string;
  aliases: string[];
}

// 顺序即匹配优先级。别名小写、去空格后比较。
const KEY_SPECS: KeySpec[] = [
  { kind: "name", label: "名称", aliases: ["name", "title", "名称", "标题", "名字"] },
  {
    kind: "type",
    label: "类型",
    aliases: ["type", "kind", "proto", "protocol", "类型", "协议"],
  },
  {
    kind: "lan",
    label: "内网",
    aliases: ["lan", "intranet", "internal", "private", "privateip", "内网", "内网ip", "局域网"],
  },
  {
    kind: "host",
    label: "主机",
    aliases: [
      "host",
      "ip",
      "server",
      "address",
      "addr",
      "endpoint",
      "公网",
      "公网ip",
      "主机",
      "地址",
      "服务器",
      "外网",
    ],
  },
  { kind: "port", label: "端口", aliases: ["port", "端口"] },
  {
    kind: "user",
    label: "账号",
    aliases: ["user", "username", "account", "login", "账号", "帐号", "用户", "用户名"],
  },
  {
    kind: "password",
    label: "密码",
    aliases: ["password", "pass", "pwd", "passwd", "secret", "密码", "口令", "密钥"],
  },
  {
    kind: "url",
    label: "网址",
    aliases: ["url", "link", "web", "website", "site", "网址", "链接", "网站"],
  },
  {
    kind: "db",
    label: "数据库",
    aliases: ["db", "database", "dbname", "schema", "数据库", "库名"],
  },
  {
    kind: "note",
    label: "备注",
    aliases: [
      "note",
      "remark",
      "desc",
      "description",
      "comment",
      "备注",
      "说明",
      "描述",
      "注释",
    ],
  },
];

function specForKey(rawKey: string): KeySpec | null {
  const key = rawKey.trim().toLowerCase().replace(/\s+/g, "");
  for (const spec of KEY_SPECS) {
    if (spec.aliases.includes(key)) return spec;
  }
  return null;
}

function splitEntries(source: string): string[][] {
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const rawLine of source.split(/\r?\n/)) {
    if (/^\s*(-{3,}|={3,})\s*$/.test(rawLine)) {
      if (current.length) blocks.push(current);
      current = [];
      continue;
    }
    current.push(rawLine);
  }
  if (current.length) blocks.push(current);
  return blocks.filter((lines) => lines.some((line) => line.trim()));
}

function parseEntry(lines: string[]): ServerEntry | null {
  const entry: ServerEntry = { name: "", type: "", fields: [] };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    const match = line.match(/^([^:：]+)[:：]\s*(.*)$/);
    if (!match) {
      // 没有冒号的首行当作名称（方便随手写一行标题）
      if (!entry.name) entry.name = line;
      continue;
    }
    const rawKey = match[1]!.trim();
    const value = match[2]!.trim();
    if (!value) continue;
    const spec = specForKey(rawKey);
    if (spec?.kind === "name") {
      if (!entry.name) entry.name = value;
      continue;
    }
    if (spec?.kind === "type") {
      if (!entry.type) entry.type = value.toLowerCase();
      continue;
    }
    entry.fields.push({
      rawKey,
      label: spec?.label ?? rawKey,
      value,
      kind: spec?.kind ?? "text",
    });
  }
  if (!entry.name && entry.fields.length === 0) return null;
  return entry;
}

export function parseServerSource(source: string): ServerEntry[] {
  return splitEntries(source)
    .map(parseEntry)
    .filter((entry): entry is ServerEntry => entry !== null);
}

function field(entry: ServerEntry, kind: FieldKind): string | undefined {
  return entry.fields.find((item) => item.kind === kind)?.value;
}

const TYPE_META: Record<string, { icon: string; label: string }> = {
  ssh: { icon: "🖥", label: "SSH" },
  sftp: { icon: "📁", label: "SFTP" },
  ftp: { icon: "📁", label: "FTP" },
  telnet: { icon: "🖥", label: "Telnet" },
  rdp: { icon: "🪟", label: "RDP" },
  windows: { icon: "🪟", label: "Windows" },
  vnc: { icon: "🖥", label: "VNC" },
  web: { icon: "🌐", label: "Web" },
  http: { icon: "🌐", label: "HTTP" },
  https: { icon: "🌐", label: "HTTPS" },
  site: { icon: "🌐", label: "网站" },
  mysql: { icon: "🗄", label: "MySQL" },
  mariadb: { icon: "🗄", label: "MariaDB" },
  postgres: { icon: "🗄", label: "PostgreSQL" },
  postgresql: { icon: "🗄", label: "PostgreSQL" },
  pg: { icon: "🗄", label: "PostgreSQL" },
  redis: { icon: "🗄", label: "Redis" },
  mongo: { icon: "🗄", label: "MongoDB" },
  mongodb: { icon: "🗄", label: "MongoDB" },
  oracle: { icon: "🗄", label: "Oracle" },
  mssql: { icon: "🗄", label: "SQL Server" },
};

function typeMeta(type: string) {
  return TYPE_META[type] ?? { icon: "🔒", label: type ? type.toUpperCase() : "凭据" };
}

interface ConnectAction {
  label: string;
  mode: "open" | "copy";
  payload: string;
}

function isWebUrl(value: string | undefined): value is string {
  return !!value && /^https?:\/\//i.test(value);
}

function connectAction(entry: ServerEntry): ConnectAction | null {
  const type = entry.type;
  const host = field(entry, "host") ?? field(entry, "lan");
  const port = field(entry, "port");
  const user = field(entry, "user");
  const url = field(entry, "url");

  const userPrefix = user ? `${user}@` : "";
  const portSuffix = (def: string) => (port && port !== def ? port : "");

  if (isWebUrl(url) || ["web", "http", "https", "site"].includes(type)) {
    const target = isWebUrl(url)
      ? url
      : url
        ? `https://${url}`
        : host
          ? `https://${host}${port ? `:${port}` : ""}`
          : null;
    if (target) return { label: "打开", mode: "open", payload: target };
  }

  if (!host) {
    return isWebUrl(url) ? { label: "打开", mode: "open", payload: url } : null;
  }

  switch (type) {
    case "ssh":
      return {
        label: "复制 SSH 命令",
        mode: "copy",
        payload: `ssh ${userPrefix}${host}${portSuffix("22") ? ` -p ${port}` : ""}`,
      };
    case "sftp":
      return {
        label: "复制 SFTP 命令",
        mode: "copy",
        payload: `sftp ${portSuffix("22") ? `-P ${port} ` : ""}${userPrefix}${host}`,
      };
    case "ftp":
      return { label: "复制 FTP 命令", mode: "copy", payload: `ftp ${host}` };
    case "telnet":
      return { label: "复制 Telnet 命令", mode: "copy", payload: `telnet ${host} ${port || 23}` };
    case "rdp":
    case "windows":
      return {
        label: "复制 RDP 地址",
        mode: "copy",
        payload: `mstsc /v:${host}${portSuffix("3389") ? `:${port}` : ""}`,
      };
    case "vnc":
      return { label: "复制 VNC 地址", mode: "copy", payload: `${host}:${port || 5900}` };
    case "mysql":
    case "mariadb":
      return {
        label: "复制 mysql 命令",
        mode: "copy",
        payload: `mysql -h ${host} -P ${port || 3306} -u ${user || "root"} -p`,
      };
    case "postgres":
    case "postgresql":
    case "pg":
      return {
        label: "复制 psql 命令",
        mode: "copy",
        payload: `psql -h ${host} -p ${port || 5432} -U ${user || "postgres"}`,
      };
    case "redis":
      return {
        label: "复制 redis-cli 命令",
        mode: "copy",
        payload: `redis-cli -h ${host} -p ${port || 6379}`,
      };
    case "mongo":
    case "mongodb":
      return {
        label: "复制 mongosh 命令",
        mode: "copy",
        payload: `mongosh "mongodb://${userPrefix}${host}:${port || 27017}"`,
      };
    default:
      return {
        label: "复制地址",
        mode: "copy",
        payload: `${host}${port ? `:${port}` : ""}`,
      };
  }
}

function subtitle(entry: ServerEntry): string {
  const host = field(entry, "host");
  const port = field(entry, "port");
  const url = field(entry, "url");
  const parts: string[] = [];
  parts.push(typeMeta(entry.type).label);
  if (host) parts.push(port ? `${host}:${port}` : host);
  else if (url) parts.push(url.replace(/^https?:\/\//i, ""));
  return parts.join(" · ");
}

function create<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.append(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
}

function flashCopied(button: HTMLElement, original: string) {
  button.classList.add("server-copied");
  button.textContent = "已复制";
  window.setTimeout(() => {
    button.classList.remove("server-copied");
    button.textContent = original;
  }, 1200);
}

function copyButton(value: string, ariaLabel: string): HTMLButtonElement {
  const button = create("button", "server-copy");
  button.type = "button";
  button.textContent = "复制";
  button.setAttribute("aria-label", ariaLabel);
  button.addEventListener("click", async (event) => {
    event.stopPropagation();
    await copyText(value);
    flashCopied(button, "复制");
  });
  return button;
}

const PASSWORD_MASK = "••••••••";

function passwordValue(value: string): { wrap: HTMLElement; reveal: HTMLButtonElement } {
  const span = create("span", "server-value server-secret", PASSWORD_MASK);
  span.dataset.revealed = "0";
  const reveal = create("button", "server-reveal");
  reveal.type = "button";
  reveal.textContent = "显示";
  reveal.setAttribute("aria-label", "显示 / 隐藏密码");
  reveal.addEventListener("click", (event) => {
    event.stopPropagation();
    const shown = span.dataset.revealed === "1";
    span.dataset.revealed = shown ? "0" : "1";
    span.textContent = shown ? PASSWORD_MASK : value;
    reveal.textContent = shown ? "显示" : "隐藏";
  });
  const wrap = create("span", "server-value-wrap");
  wrap.append(span);
  return { wrap, reveal };
}

function fieldRow(item: ServerField): HTMLElement {
  const row = create("div", "server-row");
  row.dataset.kind = item.kind;
  row.append(create("span", "server-label", item.label));

  if (item.kind === "note") {
    row.append(create("span", "server-value server-note", item.value));
    return row;
  }

  if (item.kind === "password") {
    const { wrap, reveal } = passwordValue(item.value);
    row.append(wrap, reveal, copyButton(item.value, "复制密码"));
    return row;
  }

  if (item.kind === "url" && isWebUrl(item.value)) {
    const link = create("a", "server-value server-link", item.value);
    link.href = item.value;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      void openExternal(item.value);
    });
    const wrap = create("span", "server-value-wrap");
    wrap.append(link);
    row.append(wrap, copyButton(item.value, `复制${item.label}`));
    return row;
  }

  const wrap = create("span", "server-value-wrap");
  wrap.append(create("span", "server-value", item.value));
  row.append(wrap, copyButton(item.value, `复制${item.label}`));
  return row;
}

function entryCard(entry: ServerEntry): HTMLElement {
  const meta = typeMeta(entry.type);
  const card = create("figure", "server-card");
  card.dataset.type = entry.type || "generic";

  const head = create("figcaption", "server-head");
  head.append(create("span", "server-icon", meta.icon));
  const headText = create("div", "server-head-text");
  headText.append(create("div", "server-name", entry.name || meta.label));
  headText.append(create("div", "server-subtitle", subtitle(entry)));
  head.append(headText);

  const action = connectAction(entry);
  if (action) {
    const button = create("button", "server-connect");
    button.type = "button";
    button.textContent = action.label;
    button.dataset.mode = action.mode;
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (action.mode === "open") {
        void openExternal(action.payload);
      } else {
        await copyText(action.payload);
        flashCopied(button, action.label);
      }
    });
    head.append(button);
  }
  card.append(head);

  if (entry.fields.length) {
    const body = create("div", "server-body");
    for (const item of entry.fields) body.append(fieldRow(item));
    card.append(body);
  }
  return card;
}

function decodeSource(encoded: string) {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function renderError(block: HTMLElement, message: string, source: string) {
  const pre = create("pre", "server-error");
  pre.textContent = `server 渲染失败：${message}\n\n${source}`;
  block.replaceChildren(pre);
  block.dataset.rendered = "1";
  block.classList.add("server-rendered", "server-failed");
}

export function renderServerBlock(block: HTMLElement) {
  if (block.dataset.rendered) return;
  const source = decodeSource(block.getAttribute("data-server") ?? block.textContent ?? "");
  try {
    const entries = parseServerSource(source);
    if (entries.length === 0) throw new Error("没有可用的连接信息");
    const stack = create("div", "server-stack");
    for (const entry of entries) stack.append(entryCard(entry));
    block.replaceChildren(stack);
    block.dataset.rendered = "1";
    block.classList.add("server-rendered");
  } catch (err) {
    renderError(block, (err as Error).message, source);
  }
}

export function renderServerBlocksIn(root: HTMLElement) {
  root
    .querySelectorAll<HTMLElement>(".server-block:not([data-rendered])")
    .forEach(renderServerBlock);
}

export function renderServerBlocksLazy(
  root: HTMLElement,
  options: VisualSchedulerOptions = {},
): VisualBlockHandle {
  return scheduleVisualBlocks<HTMLElement>(
    root,
    ".server-block:not([data-rendered])",
    renderServerBlock,
    options,
  );
}
