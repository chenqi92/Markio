// 9 个工作流模板：blank / folder / daily / weekly / monthly-retro / okr /
// kickoff / meeting / bug-postmortem。Welcome 网格 / NewMenu 都直接渲染此数组。
// build() 返回模板正文（已替换日期等占位符）；文件夹模板返回空串走 mkdir。

import type { IconName } from "@/components/ui/Icon";

export interface NoteTemplate {
  id: string;
  icon: IconName;
  title: string;
  sub: string;
  /** 默认文件名（不含扩展名）；点进去后用户还可改 */
  defaultName: (now: Date) => string;
  /** 模板正文；空白 / 文件夹模板返回空串。文件夹模板由 UI 走 mkdir 而非 createNote */
  build: (now: Date) => string;
  /** 创建文件夹而非笔记 */
  isFolder?: boolean;
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function isoWeek(d: Date): { year: number; week: number } {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((+t - +yearStart) / 86_400_000 + 1) / 7);
  return { year: t.getUTCFullYear(), week };
}
function ymMonth(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function quarter(d: Date): { year: number; q: number } {
  return { year: d.getFullYear(), q: Math.floor(d.getMonth() / 3) + 1 };
}

export const NOTE_TEMPLATES: NoteTemplate[] = [
  {
    id: "blank",
    icon: "file",
    title: "空白笔记",
    sub: "从零开始",
    defaultName: () => "未命名",
    build: () => "",
  },
  {
    id: "folder",
    icon: "folder",
    title: "文件夹",
    sub: "新建一个空目录",
    defaultName: () => "新文件夹",
    build: () => "",
    isFolder: true,
  },
  {
    id: "daily",
    icon: "sun",
    title: "今日 Daily",
    sub: "三栏：要做 / 笔记 / 复盘",
    defaultName: (d) => ymd(d),
    build: (d) => `# ${ymd(d)} · Daily

## 今日要做
- [ ]

## 笔记


## 复盘
`,
  },
  {
    id: "weekly",
    icon: "calendar",
    title: "周报",
    sub: "目标 / 进展 / 下周计划",
    defaultName: (d) => {
      const { year, week } = isoWeek(d);
      return `${year}-W${String(week).padStart(2, "0")}`;
    },
    build: (d) => {
      const { year, week } = isoWeek(d);
      return `# ${year} 第 ${week} 周

## 本周目标


## 进展


## 下周计划

## 阻塞 / 风险
`;
    },
  },
  {
    id: "monthly-retro",
    icon: "moon",
    title: "月度 Retro",
    sub: "顺 / 不顺 / 想做",
    defaultName: (d) => `${ymMonth(d)} retro`,
    build: (d) => `# ${ymMonth(d)} 月度 Retro

## 顺利的


## 不顺利的


## 想做但没做


## 下月一定要的
`,
  },
  {
    id: "okr",
    icon: "target",
    title: "OKR 季度目标",
    sub: "Objective + 3 KR",
    defaultName: (d) => {
      const { year, q } = quarter(d);
      return `${year}-Q${q} OKR`;
    },
    build: (d) => {
      const { year, q } = quarter(d);
      return `# ${year} Q${q} OKR

## Objective


### KR 1


### KR 2


### KR 3

`;
    },
  },
  {
    id: "kickoff",
    icon: "sparkle",
    title: "项目启动",
    sub: "范围 / 里程碑 / 干系人",
    defaultName: () => "项目启动",
    build: () => `# 项目启动

## 一句话目标


## 范围
**在内**：

**不在内**：

## 里程碑
- M1 ·
- M2 ·
- M3 ·

## 干系人
| 角色 | 人 | 联系方式 |
| --- | --- | --- |
|  |  |  |

## 风险
-
`,
  },
  {
    id: "meeting",
    icon: "message",
    title: "会议纪要",
    sub: "议题 / 决议 / 行动",
    defaultName: (d) => `${ymd(d)} 会议`,
    build: (d) => `# 会议纪要 · ${ymd(d)}

**时间**：${ymd(d)}
**与会**：

## 议题


## 讨论


## 决议


## 行动项
- [ ] @负责人 · 截止 · 事项
`,
  },
  {
    id: "bug-postmortem",
    icon: "alert",
    title: "Bug 复盘",
    sub: "现象 / 根因 / 行动",
    defaultName: (d) => `${ymd(d)} Bug 复盘`,
    build: (d) => `# Bug 复盘 · ${ymd(d)}

**影响范围**：
**持续时长**：

## 现象


## 时间线


## 根因


## 修复


## 后续行动
- [ ]
`,
  },
];
