// 18 个模板：每个 = { id, icon, title, sub, defaultName(now), build(now) }.
// build() 返回模板正文（已替换日期等占位符）。Welcome 的模板网格直接渲染数组。
// 注意：尽量用纯函数 / 静态字符串，方便未来加 e2e 测试。

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
    id: "reading",
    icon: "book",
    title: "读书笔记",
    sub: "金句 + 反应 + 行动",
    defaultName: () => "读书笔记",
    build: () => `# 《书名》

**作者**：
**进度**：
**评分**：☆☆☆☆☆

## 金句

>

## 我的反应


## 想去做的
-
`,
  },
  {
    id: "travel",
    icon: "external",
    title: "旅行日记",
    sub: "时间 + 行程 + 花销",
    defaultName: (d) => `${ymd(d)} 旅行`,
    build: (d) => `# 旅行 · ${ymd(d)}

**目的地**：
**同行**：

## 行程

| Day | 行程 | 花销 |
| --- | --- | --- |
| D1 |  |  |

## 印象最深


## 下次想做的
`,
  },
  {
    id: "recipe",
    icon: "list",
    title: "食谱",
    sub: "用料 + 步骤 + 心得",
    defaultName: () => "食谱",
    build: () => `# 菜名

**份量**：
**耗时**：

## 用料
-

## 步骤
1.

## 心得
`,
  },
  {
    id: "training",
    icon: "chart",
    title: "训练记录",
    sub: "组数 / 重量 / 感觉",
    defaultName: (d) => `${ymd(d)} 训练`,
    build: (d) => `# 训练 · ${ymd(d)}

**部位**：

## 动作

| 动作 | 组数 | 次数 | 重量 | 感觉 |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

## 总结
`,
  },
  {
    id: "resume",
    icon: "user",
    title: "求职简历",
    sub: "一页式 · 经历 + 项目",
    defaultName: () => "简历",
    build: () => `# 姓名

联系方式 · 邮箱 · 地点

## 教育


## 经历


## 项目
- **项目名** · 角色 · 时间
  - 做了什么 / 用了什么 / 结果如何

## 技能
`,
  },
  {
    id: "speech",
    icon: "users",
    title: "演讲稿",
    sub: "结构：钩子 / 论点 / 收束",
    defaultName: () => "演讲稿",
    build: () => `# 演讲稿

**主题**：
**时长**：

## 钩子（30 秒）


## 论点

### 一


### 二


### 三


## 收束


## 备用 Q&A
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
  {
    id: "habit",
    icon: "check",
    title: "习惯追踪",
    sub: "本月签到表",
    defaultName: (d) => `${ymMonth(d)} 习惯`,
    build: (d) => {
      const days = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      const header = "| 习惯 | " + Array.from({ length: days }, (_, i) => i + 1).join(" | ") + " |";
      const sep = "| --- | " + Array.from({ length: days }, () => "---").join(" | ") + " |";
      const row = "| 阅读 | " + Array.from({ length: days }, () => " ").join(" | ") + " |";
      return `# ${ymMonth(d)} 习惯追踪

${header}
${sep}
${row}
`;
    },
  },
  {
    id: "flashcard",
    icon: "note",
    title: "学习卡片",
    sub: "正 / 反 / 备注",
    defaultName: () => "学习卡片",
    build: () => `# 学习卡片

## 卡片 1
**正面**：

**反面**：

**备注**：

---

## 卡片 2
**正面**：

**反面**：

**备注**：
`,
  },
  {
    id: "canvas-map",
    icon: "diagram",
    title: "Canvas 知识地图",
    sub: "中心主题 + 分支",
    defaultName: () => "知识地图",
    build: () => `# 知识地图

## 中心主题
**主题**：

## 分支

### 分支 1
-

### 分支 2
-

### 分支 3
-

## 关键连接
- A → B：
- B → C：
`,
  },
];
