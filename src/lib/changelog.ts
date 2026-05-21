// 发布日志数据源：每发一版往数组顶部加一条；ChangelogDialog 直接渲染。
// 不走 GitHub API（离线可看 + 不发网络请求）。
export interface ChangelogEntry {
  version: string;
  date: string;
  major?: boolean;
  added?: string[];
  changed?: string[];
  fixed?: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "1.0.0",
    date: "2026-05-21",
    major: true,
    added: [
      "16 个 AI 提供方（OpenAI / Anthropic / Google / DeepSeek / NVIDIA / xAI / Groq / OpenRouter / SiliconFlow / Zhipu / DashScope / Moonshot / Mistral / Together / Ollama / Custom）",
      "联网拉取模型列表 + 24h 缓存 + 按 vendor 分组的搜索下拉",
      "每个 provider 独立记忆 endpoint / model / API Key",
      "设置改为嵌入式覆盖页（取代弹窗，4 类分组导航 + 顶部搜索）",
      "Bubble menu 4 分组重做 · 文件右键菜单 6 分组扩展",
    ],
    changed: [
      "AI 引用条改为 2 列 grid，长文件名 + 长来源名同时存在时不会互相挤掉",
      "分屏滚动同步改为 DOM bus，配合 Rust 流式渲染 line offset 修复长文档错位",
    ],
    fixed: [
      "WebView2 抢占编辑器 / 预览区 / 标签栏的原生右键菜单",
      "Git 同步冲突策略可在设置切换",
      "大仓库初次加载性能加固",
    ],
  },
];
