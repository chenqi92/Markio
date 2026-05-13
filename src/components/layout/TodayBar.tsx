import { Icon } from "../ui/Icon";
import { useStreak } from "@/stores/streak";

export function TodayBar() {
  const target = useStreak((s) => s.dailyTarget);
  const today = useStreak((s) => s.todayWords);
  const streak = useStreak((s) => s.streak);
  const pct = Math.min(100, Math.round((today / target) * 100));

  return (
    <div className="today-bar" title="今日写作进度">
      <span className="flame">
        <Icon name="flame" size={14} />
      </span>
      <span className="streak">{streak}</span>
      <span className="bar">
        <span style={{ width: `${pct}%` }} />
      </span>
      <span className="words">
        <b>{today}</b> / {target}
      </span>
    </div>
  );
}
