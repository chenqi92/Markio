# 中国大陆 App Store AI 策略

markio 的 AI 源现在统一经过 `src/lib/ai-region-policy.ts` 判断。中国大陆策略启用后，应用只展示本地模型与国内模型源，并会把已持久化的境外模型源切回允许的默认源。

## 构建方式

用于中国大陆 App Store 的包请使用：

```bash
pnpm tauri:build:cn
```

这个脚本会设置：

```bash
VITE_MARKIO_AI_REGION=cn
```

可选值：

- `cn`：强制中国大陆策略，适合中国大陆 App Store 包。
- `global`：强制全球策略，展示完整模型源。
- `auto` 或留空：按运行环境做启发式判断，主要用于开发和普通分发。

## 策略内容

中国大陆策略下：

- AI 设置页只保留 `DeepSeek`、`SiliconFlow`、`智谱`、`通义千问`、`Moonshot`、`本地 Ollama`。
- 已保存的境外 AI 源不会继续出现在源池中，当前源会自动切到允许源。
- 智能通道会隐藏境外固定模型选项。
- RAG embedding 会隐藏不允许的云端预设，必要时回落到本地 Ollama。
- 本地外部 Agent 入口会从命令面板中移除。
- MCP 设置页使用通用客户端文案，不再绑定特定品牌名称。

`auto` 模式会参考系统 locale 与时区，但上架包不要依赖自动判断；请使用 `cn` 强制构建。
