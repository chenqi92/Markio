# @markio/mcp-server

把 markio 当前 vault 暴露成 MCP server，让 Claude Code / Codex 等外部 AI 工具
能直接搜笔记、读笔记、列笔记、打开笔记。

## 工作方式

```
Claude Code  ──stdio──▶  markio-mcp (Node)  ──HTTP──▶  markio (Tauri)
```

- markio 主进程在启动时开一个 loopback HTTP server（127.0.0.1，随机端口），
  端口和 token 在 markio 的"设置 → MCP server"里查看。
- 这个 Node 包是个轻量 MCP server，用 stdio 接 Claude Code，把每个 tool 调用
  转成对 markio 的 HTTP RPC。

只有从 127.0.0.1 才能访问 markio 的 HTTP，且必须带正确的 `Authorization`
header，外网不可达。

## 安装

```bash
cd mcp-server
pnpm install     # 或 npm install
```

## 接到 Claude Code

打开 markio → 设置 → MCP server，复制配置片段（已经填好端口和 token），粘到
Claude Code 的 mcp 配置里。形如：

```json
{
  "mcpServers": {
    "markio": {
      "command": "node",
      "args": ["/abs/path/to/markio/mcp-server/index.js"],
      "env": {
        "MARKIO_MCP_PORT": "12345",
        "MARKIO_MCP_TOKEN": "abcd..."
      }
    }
  }
}
```

## 提供的工具

| name | 说明 |
|------|------|
| `search_notes` | 全文检索 markdown，返回命中行 / 路径 / 预览 |
| `get_note` | 读取单文件完整内容 |
| `list_notes` | 列出当前 vault 所有笔记 |
| `open_note` | 让 markio UI 打开一个笔记（side effect） |
| `get_vault_info` | 当前活跃 vault + 所有已注册 vault |

后续可以扩 `create_note` / `update_note` / `delete_note`，按需开权限。
