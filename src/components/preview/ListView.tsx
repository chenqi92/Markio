import { useMemo, useState } from "react";
import { writeText } from "@/lib/clipboard";
import { openExternal } from "@/lib/opener";

interface Item {
  name?: string;
  title?: string;
  role?: string;
  subtitle?: string;
  status?: string;
  tag?: string;
  loc?: string;
  ip?: string;
  os?: string;
  uptime?: string;
  cost?: string;
  cpu?: number;
  mem?: number;
  disk?: number;
  note?: string;
  ssh?: string;
  panel?: string;
  logs?: string;
  [key: string]: unknown;
}

const STATUS_META: Record<string, { color: string; text: string }> = {
  up: { color: "#28c840", text: "运行中" },
  warn: { color: "#ff9500", text: "警告" },
  down: { color: "#ff453a", text: "离线" },
  stale: { color: "var(--text-4, var(--text-3))", text: "已停用" },
};

/** 从 body 里找第一个 ```json fenced block 解析成 Item[]。 */
function parseItems(body: string): Item[] {
  const m = body.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!m) return [];
  try {
    const parsed = JSON.parse(m[1]);
    if (Array.isArray(parsed)) return parsed as Item[];
  } catch {
    /* ignore */
  }
  return [];
}

function Meter({
  label,
  value,
  warn,
}: {
  label: string;
  value: number;
  warn?: boolean;
}) {
  return (
    <div className="lv-meter">
      <div className="lv-meter-h">
        <span className="lv-meter-l">{label}</span>
        <span
          className="lv-meter-v"
          style={{ color: warn ? "#ff9500" : "var(--text-2)" }}
        >
          {value}%
        </span>
      </div>
      <div className="lv-meter-bar">
        <div
          style={{
            width: `${Math.max(0, Math.min(100, value))}%`,
            background: warn
              ? "#ff9500"
              : value > 70
              ? "#ff9500"
              : "var(--accent)",
          }}
        />
      </div>
    </div>
  );
}

export function ListView({ body, title }: { body: string; title?: string }) {
  const items = useMemo(() => parseItems(body), [body]);
  const [filter, setFilter] = useState<string>("all");

  const stats = useMemo(() => {
    const m: Record<string, number> = { up: 0, warn: 0, down: 0, stale: 0, other: 0 };
    for (const it of items) {
      const key = (it.status as string) ?? "other";
      m[key] = (m[key] ?? 0) + 1;
    }
    return m;
  }, [items]);

  const tags = useMemo(() => {
    const s = new Set<string>();
    for (const it of items) {
      const t = it.tag;
      if (typeof t === "string" && t.length > 0) s.add(t);
    }
    return Array.from(s);
  }, [items]);

  const filtered = useMemo(() => {
    if (filter === "all") return items;
    return items.filter(
      (it) => it.tag === filter || it.status === filter,
    );
  }, [items, filter]);

  if (items.length === 0) {
    return (
      <div className="preview" style={{ padding: 24 }}>
        <h2 style={{ marginTop: 0 }}>{title ?? "列表视图"}</h2>
        <p style={{ color: "var(--text-3)" }}>
          在 frontmatter 设 <code>view: list</code>，然后在正文里放一段
          fenced JSON：
        </p>
        <pre>
          <code>{`\`\`\`json
[
  { "name": "atlas", "role": "K3s 主节点", "status": "up", "ip": "10.0.1.10" }
]
\`\`\``}</code>
        </pre>
      </div>
    );
  }

  return (
    <div className="preview lv-view">
      <div className="lv-header">
        <div>
          <h1 className="lv-title">{title ?? "列表"}</h1>
          <div className="lv-meta">
            <span>{items.length} 项</span>
            {stats.up > 0 && (
              <>
                <span className="dot">·</span>
                <span style={{ color: STATUS_META.up.color }}>
                  ● {stats.up} 运行
                </span>
              </>
            )}
            {stats.warn > 0 && (
              <>
                <span className="dot">·</span>
                <span style={{ color: STATUS_META.warn.color }}>
                  ● {stats.warn} 警告
                </span>
              </>
            )}
            {stats.down > 0 && (
              <>
                <span className="dot">·</span>
                <span style={{ color: STATUS_META.down.color }}>
                  ● {stats.down} 离线
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      {(tags.length > 0 || stats.warn > 0 || stats.down > 0) && (
        <div className="lv-filters">
          <button
            type="button"
            className={"lv-filter" + (filter === "all" ? " active" : "")}
            onClick={() => setFilter("all")}
          >
            全部
          </button>
          {tags.map((t) => (
            <button
              key={`tag-${t}`}
              type="button"
              className={"lv-filter" + (filter === t ? " active" : "")}
              onClick={() => setFilter(t)}
            >
              {t}
            </button>
          ))}
          {stats.warn > 0 && (
            <button
              type="button"
              className={"lv-filter" + (filter === "warn" ? " active" : "")}
              onClick={() => setFilter("warn")}
            >
              需要关注
            </button>
          )}
          {stats.down > 0 && (
            <button
              type="button"
              className={"lv-filter" + (filter === "down" ? " active" : "")}
              onClick={() => setFilter("down")}
            >
              离线
            </button>
          )}
        </div>
      )}

      <div className="lv-grid">
        {filtered.map((s, i) => {
          const status = s.status as string | undefined;
          const meta = status ? STATUS_META[status] : undefined;
          const name = s.name ?? s.title ?? `item ${i + 1}`;
          const role = s.role ?? s.subtitle;
          return (
            <div className="lv-card" key={i}>
              <div className="lv-card-h">
                {meta && (
                  <div
                    className="lv-card-stat"
                    style={{ background: meta.color }}
                    title={meta.text}
                  >
                    <span className="pulse" />
                  </div>
                )}
                <div className="lv-card-h-meta">
                  <div className="lv-card-name">{name}</div>
                  {role && <div className="lv-card-role">{role}</div>}
                </div>
                {s.tag && (
                  <div className="lv-card-tag" data-tag={s.tag}>
                    {s.tag}
                  </div>
                )}
              </div>

              <div className="lv-card-info">
                {s.loc && (
                  <div className="lv-info-row">
                    <span className="l" aria-hidden>📍</span>
                    <span>{s.loc}</span>
                  </div>
                )}
                {s.ip && (
                  <div className="lv-info-row">
                    <span className="l" aria-hidden>🌐</span>
                    <span className="ip">{s.ip}</span>
                  </div>
                )}
                {s.os && (
                  <div className="lv-info-row">
                    <span className="l" aria-hidden>💿</span>
                    <span>{s.os}</span>
                  </div>
                )}
                {(s.uptime || s.cost) && (
                  <div className="lv-info-row">
                    <span className="l" aria-hidden>⏱</span>
                    <span>
                      {s.uptime ?? ""}
                      {s.cost && s.cost !== "—" ? ` · ${s.cost}` : ""}
                    </span>
                  </div>
                )}
              </div>

              {status !== "down" &&
                (typeof s.cpu === "number" ||
                  typeof s.mem === "number" ||
                  typeof s.disk === "number") && (
                  <div className="lv-card-meters">
                    {typeof s.cpu === "number" && (
                      <Meter label="CPU" value={s.cpu} />
                    )}
                    {typeof s.mem === "number" && (
                      <Meter label="MEM" value={s.mem} />
                    )}
                    {typeof s.disk === "number" && (
                      <Meter
                        label="DISK"
                        value={s.disk}
                        warn={s.disk > 85}
                      />
                    )}
                  </div>
                )}

              {s.note && <div className="lv-card-note">⚠ {s.note}</div>}

              {(s.ip || s.ssh || s.panel || s.logs) && (
                <div className="lv-card-actions">
                  {(s.ssh || s.ip) && (
                    <button
                      type="button"
                      title={typeof s.ssh === "string" ? s.ssh : `ssh ${s.ip ?? ""}`}
                      onClick={() => {
                        const cmd =
                          typeof s.ssh === "string" ? s.ssh : `ssh ${s.ip}`;
                        void writeText(cmd);
                      }}
                    >
                      ⌨ SSH
                    </button>
                  )}
                  {typeof s.panel === "string" && (
                    <button
                      type="button"
                      title={s.panel}
                      onClick={() => void openExternal(s.panel as string)}
                    >
                      ▦ 面板
                    </button>
                  )}
                  {typeof s.logs === "string" && (
                    <button
                      type="button"
                      title={s.logs}
                      onClick={() => void openExternal(s.logs as string)}
                    >
                      ≣ 日志
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
