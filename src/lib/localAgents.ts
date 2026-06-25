// 本地 CLI Agent 的中性显示名（不直接打第三方品牌名，便于上架 / 商标稳妥）。
// AgentPanel（独立面板）与 AIPanel（AI 助手模型选择器）共用这一份，避免漂移。
import type { AgentProvider } from "@/types";

export const LOCAL_AGENT_LABEL: Record<AgentProvider, string> = {
  claude: "本地 Agent A",
  codex: "本地 Agent B",
  antigravity: "本地 Agent C",
  cursor: "本地 Agent D",
  opencode: "本地 Agent E",
  qwen: "本地 Agent F",
  copilot: "本地 Agent G",
  aider: "本地 Agent H",
  goose: "本地 Agent I",
};

export function localAgentLabel(id: AgentProvider): string {
  return LOCAL_AGENT_LABEL[id];
}
