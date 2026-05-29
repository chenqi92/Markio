#!/usr/bin/env node
/**
 * markio MCP server。
 *
 * 把 markio 仓库暴露成 MCP 工具，让 Claude Code / Codex 等外部 AI 工具直接
 * 搜笔记、读笔记、列笔记、打开笔记。
 *
 * 通过环境变量配置：
 *   MARKIO_MCP_PORT   markio 主进程开的 loopback HTTP 端口
 *   MARKIO_MCP_TOKEN  鉴权 token（启动时随机生成，前端"设置 → MCP"里看）
 *
 * 用法（在 Claude Code 配置里加一段）：
 *   {
 *     "mcpServers": {
 *       "markio": {
 *         "command": "node",
 *         "args": ["/path/to/markio/mcp-server/index.js"],
 *         "env": {
 *           "MARKIO_MCP_PORT": "7791",
 *           "MARKIO_MCP_TOKEN": "<token>"
 *         }
 *       }
 *     }
 *   }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const PORT = Number(process.env.MARKIO_MCP_PORT || 0);
const TOKEN = process.env.MARKIO_MCP_TOKEN || "";

if (!PORT || !TOKEN) {
  process.stderr.write(
    "[markio-mcp] 缺少 MARKIO_MCP_PORT 或 MARKIO_MCP_TOKEN 环境变量。\n" +
      "请打开 markio → 设置 → MCP server 复制完整配置片段。\n",
  );
  process.exit(1);
}

const BASE = `http://127.0.0.1:${PORT}`;

async function rpc(path, body) {
  const init = {
    method: body == null ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
    },
  };
  if (body != null) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`markio 返回 ${res.status}：${text || res.statusText}`);
  }
  return res.json();
}

const TOOLS = [
  {
    name: "search_notes",
    description:
      "在 markio 当前 vault 中按关键词全文搜索 markdown 笔记。返回命中行、文件路径、预览。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词" },
        workspace: {
          type: "string",
          description: "可选。指定 vault 路径，省略时用 markio 当前活跃 vault",
        },
        limit: {
          type: "number",
          description: "最大结果数（默认 50，上限 200）",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_note",
    description: "读取指定 markdown 文件的完整内容。路径必须落在已注册 vault 里。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "笔记的绝对路径" },
      },
      required: ["path"],
    },
  },
  {
    name: "list_notes",
    description: "列出当前 vault 下所有 markdown 笔记（路径/文件名/大小）。",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "可选 vault 路径" },
        limit: { type: "number", description: "最大数量（默认 500，上限 5000）" },
      },
    },
  },
  {
    name: "open_note",
    description: "在 markio UI 中打开一个笔记（产生 side effect）。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "笔记绝对路径" },
      },
      required: ["path"],
    },
  },
  {
    name: "get_vault_info",
    description: "返回 markio 当前活跃 vault 路径 + 所有已注册 vault 列表。",
    inputSchema: { type: "object", properties: {} },
  },
];

const HANDLERS = {
  async search_notes(args) {
    const data = await rpc("/rpc/search", {
      query: args.query,
      workspace: args.workspace,
      limit: args.limit,
    });
    if (!data.length) {
      return { content: [{ type: "text", text: "(无命中)" }] };
    }
    const lines = data
      .map((h) => `${h.path}:${h.line}  ${h.preview.trim().slice(0, 200)}`)
      .join("\n");
    return { content: [{ type: "text", text: lines }] };
  },

  async get_note(args) {
    const data = await rpc("/rpc/get_note", { path: args.path });
    return {
      content: [
        { type: "text", text: `# ${data.path}\n\n${data.content}` },
      ],
    };
  },

  async list_notes(args) {
    const data = await rpc("/rpc/list_notes", {
      workspace: args.workspace,
      limit: args.limit,
    });
    const lines = data
      .map((n) => `${n.name}\t${(n.size / 1024).toFixed(1)} KB\t${n.path}`)
      .join("\n");
    return {
      content: [
        {
          type: "text",
          text: `共 ${data.length} 篇笔记：\n${lines || "(无)"}`,
        },
      ],
    };
  },

  async open_note(args) {
    const data = await rpc("/rpc/open_note", { path: args.path });
    return {
      content: [{ type: "text", text: `已在 markio 打开：${data.opened}` }],
    };
  },

  async get_vault_info() {
    const data = await rpc("/rpc/get_vault_info", {});
    const active = data.active_workspace || "(无)";
    const vaults = data.vaults
      .map((v) => `- ${v.name}  ${v.path}`)
      .join("\n");
    return {
      content: [
        {
          type: "text",
          text: `当前活跃 vault：${active}\n\n所有已注册 vault：\n${vaults}`,
        },
      ],
    };
  },
};

const server = new Server(
  { name: "markio", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const handler = HANDLERS[req.params.name];
  if (!handler) {
    return {
      content: [{ type: "text", text: `未知工具：${req.params.name}` }],
      isError: true,
    };
  }
  try {
    return await handler(req.params.arguments || {});
  } catch (e) {
    return {
      content: [{ type: "text", text: `markio RPC 失败：${e.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[markio-mcp] connected → ${BASE}\n`);
