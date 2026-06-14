# 中国大陆 App Store AI 策略

markio 的 AI 源现在统一经过 `src/lib/ai-region-policy.ts` 判断。中国大陆策略启用后，应用只展示本地模型与国内模型源，并会把已持久化的境外模型源切回允许的默认源。

## 构建方式

如果只发布一个 App Store 构建包，请使用默认构建：

```bash
pnpm tauri:build
```

默认构建会进入 `auto` 模式：启动时优先读取 macOS StoreKit storefront，若 storefront 为中国大陆（如 `CHN` / `CN`）则隐藏境外模型源；其他 storefront 显示完整模型源。StoreKit 取不到时，再回退到系统 locale 与时区。

如果后续改成中国大陆专用包，请使用：

```bash
pnpm tauri:build:cn
```

这个脚本会设置：

```bash
VITE_MARKIO_AI_REGION=cn
```

可选值：

- `cn`：强制中国大陆策略，适合中国大陆 App Store 包。
- `global`：强制全球策略，展示完整模型源。**直发渠道（GitHub Releases / Developer ID 直发 dmg）应使用 `global`** —— 直发包不受 App Store 合规约束，且没有 StoreKit storefront 可读，若用 `auto` 会在中国大陆环境下按 locale / 时区误判成 `cn` 并隐藏境外模型源。`.github/workflows/release.yml` 已固定注入 `VITE_MARKIO_AI_REGION=global`。
- `auto` 或留空：单包发布模式，优先按 StoreKit storefront 判断，取不到再用 locale / 时区兜底。**仅适合 App Store 包**（有 storefront 可读）。

## 策略内容

中国大陆策略下：

- AI 设置页只保留 `DeepSeek`、`SiliconFlow`、`智谱`、`通义千问`、`Moonshot`、`小米 MiMo`、`本地 Ollama`。
- 用户界面不展示地区策略或备案状态提示，只展示当前版本可用的模型源。
- 已保存的境外 AI 源不会继续出现在源池中，当前源会自动切到允许源。
- 智能通道会隐藏境外固定模型选项。
- RAG embedding 会隐藏不允许的云端预设，必要时回落到本地 Ollama。
- 本地外部 Agent 入口会从命令面板中移除。
- MCP 设置页使用通用客户端文案，不再绑定特定品牌名称。
- NVIDIA NIM、OpenRouter 等境外服务或境外聚合入口不进入中国大陆构建；如果未来通过合规国内平台提供，应以国内平台作为模型源展示。

`cn` 构建会在前端产物中裁掉境外模型源字符串；`auto` 单包构建为了让海外 storefront 正常显示完整模型源，会把完整 provider 定义打进同一个包，但中国大陆 storefront 运行时不会展示或调用这些模型源。
