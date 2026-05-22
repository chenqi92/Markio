// AI agent loop：和后端 ai_chat_with_tools 配合，让模型自己决定要 list_dir /
// read_file / grep 哪些内容，多轮 tool_use 直到模型返回 text。前端持有
// workspacePath，能直接复用 fs_grep / fs_read_text / fs_read_dir，避免在 Rust
// 端再做一份路径安全校验（所有底层命令已走 ensure_in_workspaces）。
//
// 流程：
//   1. messages = [user]
//   2. loop:
//      result = aiAgentTurn(messages, tools)
//      if text → done, return
//      else (tool_calls) → 执行工具 → 追加 assistant {tool_calls} + tool {output}
//   3. 上限 8 轮，避免模型反复打转烧 API 配额
//
// 失败策略：
// - 单个工具失败 → 把错误信息当作 tool output 喂回去，让模型自己决定怎么处理
// - readText 超过 8000 字符 → 截断 + 标注"已截断"，避免一次性灌爆上下文

import { api } from "./api";

const MAX_TURNS = 8;
const MAX_FILE_CHARS = 8000;
const MAX_DIR_ENTRIES = 80;
const MAX_GREP_HITS = 12;

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AgentToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type AgentMsg =
  | { role: "user"; content: string }
  | { role: "system"; content: string }
  | {
      role: "assistant";
      content?: string;
      tool_calls?: AgentToolCall[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

export const AGENT_TOOLS: AgentTool[] = [
  {
    name: "list_dir",
    description:
      "列出工作区里某个目录下的文件与子目录。path 为工作区相对路径，传 '' 列根目录。返回按行的 [dir]/[file] 列表。",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "工作区相对路径，根目录传 '' 或省略",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "read_file",
    description: `读取工作区内某个文本/markdown 文件的内容。path 可以是绝对路径或工作区相对路径。一次最多返回 ${MAX_FILE_CHARS} 字符。`,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "文件路径（绝对或工作区相对）",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "grep",
    description: `在工作区里按关键词搜索（FTS5 + 暴力扫的混合）。返回 path:line 片段。max 默认 ${MAX_GREP_HITS}。`,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "关键词；多词用空格分开，FTS 内部 OR",
        },
        max: { type: "number", description: `返回上限，默认 ${MAX_GREP_HITS}` },
      },
      required: ["query"],
    },
  },
];

function toAbs(workspacePath: string, p: string): string {
  if (!p) return workspacePath;
  if (
    p.startsWith(workspacePath) ||
    /^[A-Za-z]:[\\/]/.test(p) ||
    p.startsWith("/")
  ) {
    return p;
  }
  const sep = workspacePath.includes("\\") ? "\\" : "/";
  return `${workspacePath}${sep}${p.replace(/^[\\/]+/, "")}`;
}

/** 路径前缀比较：归一化 \ → /，加 trailing sep 防止 /foo/bar 误中 /foo/barbaz */
function pathStartsWith(child: string, parent: string): boolean {
  const c = child.replace(/\\/g, "/").replace(/\/+$/, "");
  const p = parent.replace(/\\/g, "/").replace(/\/+$/, "");
  return c === p || c.startsWith(p + "/");
}

/**
 * Scope 限制 —— 给 Agent 的工具加一层应用层守卫，与 AIPanel 里非 Agent 路径的
 * scope 含义保持一致：
 * - kind="dir"：rootPath 之外的 list_dir / read_file 直接拒绝；grep 把 root 钉死在 rootPath
 * - kind="set"：只放 allowedPaths 集合内的路径（open / tag / manual）；list_dir 会被告知不可用，建议直接 read_file
 *
 * 后端的 ensure_in_workspaces 仍是最后一道防线（仓库外路径连进都进不来），
 * 这里只是把"在仓库内但 scope 之外"的越界拦在前端。
 */
export interface AgentScopeRestriction {
  kind: "dir" | "set";
  rootPath?: string;
  allowedPaths?: string[];
  label: string;
}

export async function executeTool(
  call: AgentToolCall,
  workspacePath: string,
  scope?: AgentScopeRestriction,
): Promise<string> {
  const allowedSet = scope?.allowedPaths
    ? new Set(scope.allowedPaths.map((p) => p.replace(/\\/g, "/")))
    : null;
  const inScope = (abs: string): boolean => {
    if (!scope) return true;
    const norm = abs.replace(/\\/g, "/");
    if (scope.kind === "dir" && scope.rootPath) {
      return pathStartsWith(norm, scope.rootPath);
    }
    if (allowedSet) {
      return allowedSet.has(norm);
    }
    return true;
  };

  try {
    if (call.name === "list_dir") {
      const rel = String(call.input.path ?? "");
      // set 范围 (open / tag / manual)：目录概念不适用，直接报告允许列表
      if (scope?.kind === "set" && allowedSet) {
        if (!rel) {
          const files = [...allowedSet].slice(0, MAX_DIR_ENTRIES);
          const tail =
            allowedSet.size > MAX_DIR_ENTRIES
              ? `\n... 共 ${allowedSet.size} 项，已截断到前 ${MAX_DIR_ENTRIES}`
              : "";
          return `当前 scope 是 ${scope.label}，工具可访问以下 ${allowedSet.size} 个文件 (直接用 read_file 即可):\n${files.join("\n")}${tail}`;
        }
        return `Error: 当前 scope = ${scope.label}，list_dir 不可用，请用 read_file 直接读上面列出的某个文件`;
      }
      // dir 范围 / 无范围：默认入口
      const defaultRoot = scope?.rootPath ?? workspacePath;
      const abs = rel ? toAbs(workspacePath, rel) : defaultRoot;
      if (!inScope(abs)) {
        return `Error: 路径 ${abs} 不在当前 scope (${scope?.label}) 内。允许的根：${scope?.rootPath ?? workspacePath}`;
      }
      const entry = await api.readDir(abs);
      const children = (entry.children ?? []).slice(0, MAX_DIR_ENTRIES);
      if (children.length === 0) return "(空目录)";
      const lines = children.map(
        (c) => `${c.isDir ? "[dir] " : "[file] "}${c.name}`,
      );
      const tail =
        (entry.children?.length ?? 0) > MAX_DIR_ENTRIES
          ? `\n... 共 ${entry.children?.length} 项，已截断到前 ${MAX_DIR_ENTRIES}`
          : "";
      return lines.join("\n") + tail;
    }

    if (call.name === "read_file") {
      const p = String(call.input.path ?? "");
      if (!p) return "Error: path 必填";
      const abs = toAbs(workspacePath, p);
      if (!inScope(abs)) {
        return `Error: 文件 ${abs} 不在当前 scope (${scope?.label}) 内`;
      }
      const text = await api.readText(abs);
      if (text.length > MAX_FILE_CHARS) {
        return text.slice(0, MAX_FILE_CHARS) + `\n\n[已截断，原文共 ${text.length} 字符]`;
      }
      return text || "(空文件)";
    }

    if (call.name === "grep") {
      const query = String(call.input.query ?? "").trim();
      if (!query) return "Error: query 必填";
      const max = Math.min(
        50,
        Math.max(1, Number(call.input.max ?? MAX_GREP_HITS)),
      );
      // dir 范围：root 钉成 scope root，让 fs_grep 自然只走子树
      const grepRoot =
        scope?.kind === "dir" && scope.rootPath
          ? scope.rootPath
          : workspacePath;
      let hits = await api.grep(grepRoot, query, max);
      // set 范围：grep 仍跑全仓 (没有子集 root)，结果靠 allowedSet 过滤
      if (scope?.kind === "set" && allowedSet) {
        hits = hits.filter((h) =>
          allowedSet.has(h.path.replace(/\\/g, "/")),
        );
      }
      if (hits.length === 0) {
        return `(无匹配 query=${query}${scope ? ` · scope=${scope.label}` : ""})`;
      }
      return hits
        .map((h) => `${h.path}:${h.line}: ${h.preview.slice(0, 240)}`)
        .join("\n");
    }

    return `Error: 未知工具 ${call.name}`;
  } catch (e) {
    return `Error: 工具 ${call.name} 失败：${(e as Error).message}`;
  }
}

export interface AgentRunOpts {
  provider: string;
  endpoint?: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  system?: string;
  workspacePath: string;
  /** scope 限制：dir 钉根 / set 限文件集合。runAgent 会自动追加一段 scope 说明到 system。 */
  scope?: AgentScopeRestriction;
  /** 初始 messages（通常只含一条 user）。会在循环中追加 assistant / tool。 */
  messages: AgentMsg[];
  /** 工具被模型调用时的回调（UI 显示"正在读 xxx"）。 */
  onToolCall?: (call: AgentToolCall) => void;
  /** 工具执行完的回调，传入截断后的输出（UI 展示） */
  onToolDone?: (call: AgentToolCall, output: string) => void;
  /** 模型最终文本（每轮 turn 都可能产出，但仅最后一轮代表 final 答案） */
  onFinalText?: (text: string) => void;
  /** 单轮 token 用量回调，给计费/调试用 */
  onUsage?: (usage: { inputTokens?: number; outputTokens?: number }) => void;
  /** 外部取消：返回 true 时跳出循环 */
  isCancelled?: () => boolean;
}

function buildScopeHint(scope: AgentScopeRestriction | undefined): string {
  if (!scope) return "";
  if (scope.kind === "dir") {
    return `\n\n工作范围限制：你的 list_dir / read_file / grep 操作只允许在「${scope.label}」(${scope.rootPath}) 内进行。list_dir 传 path="" 即可看到该范围的根目录；超出范围的路径会被拒绝。如果用户的问题在该范围内确实没有相关内容，直接说"未在选定范围找到"，不要再去全仓库里找。`;
  }
  const sample = (scope.allowedPaths ?? []).slice(0, 12);
  const more =
    (scope.allowedPaths?.length ?? 0) > sample.length
      ? `\n... 共 ${scope.allowedPaths?.length} 个文件`
      : "";
  return `\n\n工作范围限制：当前 scope = ${scope.label}，你只能访问以下 ${scope.allowedPaths?.length} 个文件 (list_dir 不可用，直接 read_file)：\n${sample.join("\n")}${more}`;
}

export interface AgentRunResult {
  text: string;
  turns: number;
  toolCalls: number;
  /** true = 触发 8 轮上限 */
  truncated: boolean;
}

export async function runAgent(opts: AgentRunOpts): Promise<AgentRunResult> {
  const messages = [...opts.messages];
  const scopedSystem = (opts.system ?? "") + buildScopeHint(opts.scope);
  let toolCallCount = 0;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (opts.isCancelled?.()) {
      return { text: "(已取消)", turns: turn, toolCalls: toolCallCount, truncated: false };
    }
    const result = await api.aiAgentTurn({
      provider: opts.provider,
      endpoint: opts.endpoint,
      model: opts.model,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      system: scopedSystem,
      messages,
      tools: AGENT_TOOLS,
    });
    opts.onUsage?.({
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    });

    if (result.kind === "text") {
      opts.onFinalText?.(result.text);
      return {
        text: result.text,
        turns: turn + 1,
        toolCalls: toolCallCount,
        truncated: false,
      };
    }

    // tool_calls 路径：追加 assistant 消息（携带 tool_calls），执行每个调用，追加 tool 消息
    messages.push({
      role: "assistant",
      tool_calls: result.calls,
    });
    for (const call of result.calls) {
      if (opts.isCancelled?.()) {
        return {
          text: "(已取消)",
          turns: turn + 1,
          toolCalls: toolCallCount,
          truncated: false,
        };
      }
      opts.onToolCall?.(call);
      const output = await executeTool(call, opts.workspacePath, opts.scope);
      opts.onToolDone?.(call, output);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: output,
      });
      toolCallCount++;
    }
  }
  const truncatedText = `(已达到 ${MAX_TURNS} 轮工具调用上限，停止)`;
  opts.onFinalText?.(truncatedText);
  return {
    text: truncatedText,
    turns: MAX_TURNS,
    toolCalls: toolCallCount,
    truncated: true,
  };
}
