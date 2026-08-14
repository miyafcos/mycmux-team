/**
 * Six headline numbers with their change against the previous window.
 *
 * The comparison is suppressed for the "全期間" preset: the window before "all
 * time" is empty, so every metric would read +100%. Showing "前期間データなし"
 * is the honest form of that (F1 backlog #4).
 */

import {
  deltaDirection,
  formatCount,
  formatDelta,
  formatHours,
  formatRatio,
  formatScore,
  formatUsd,
  type Overview,
  type RangePreset,
} from "../../lib/ailog";
import { cardStyle } from "./ui";

export function SummaryCards({ overview, preset }: { overview: Overview; preset: RangePreset }) {
  const showCompare = preset !== "all";
  const { totals, comparePrevious, rework } = overview;

  const cards: { label: string; value: string; delta: number | null; hint: string }[] = [
    {
      label: "セッション",
      value: formatCount(totals.sessions),
      delta: comparePrevious.sessionsPct,
      hint: "期間内に 1 ターン以上あったセッション数",
    },
    {
      label: "ターン",
      value: formatCount(totals.turns),
      delta: null,
      hint: "課金対象のやり取り 1 往復を 1 ターンとして数えた数",
    },
    {
      label: "コスト相当",
      value: formatUsd(totals.costUsd),
      delta: comparePrevious.costPct,
      hint: "従量課金だった場合の金額。請求額ではありません",
    },
    {
      label: "キャッシュ率",
      value: formatRatio(overview.cacheHitRate),
      delta: null,
      hint: "取り込み側トークンのうちキャッシュ読み出しが占める割合",
    },
    {
      label: "実稼働時間",
      value: formatHours(totals.activeMs),
      delta: null,
      hint: "無操作の空白を除いた実働時間",
    },
    {
      label: "手戻り平均",
      value: formatScore(rework.avgScore),
      delta: comparePrevious.reworkPct,
      hint: "ツール失敗・再編集・やり直し指示から算出したスコア（低いほど良い）",
    },
  ];

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
        gap: 8,
      }}
    >
      {cards.map((card) => (
        <div key={card.label} style={{ ...cardStyle, padding: "10px 12px 11px" }} title={card.hint}>
          <div style={{ fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-text-tertiary)" }}>{card.label}</div>
          <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-0.01em", marginTop: 2 }}>{card.value}</div>
          <div style={{ marginTop: 3, fontSize: "var(--cmux-font-size-xs)", minHeight: 14 }}>
            {card.delta === null ? (
              <span style={{ color: "var(--cmux-text-tertiary)" }}>—</span>
            ) : showCompare ? (
              <span style={{ color: deltaColor(card.label, card.delta) }}>
                {`${formatDelta(card.delta)} 前期間比`}
              </span>
            ) : (
              <span style={{ color: "var(--cmux-text-tertiary)" }}>前期間データなし</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * More sessions is neutral, more cost or more rework is worse. Colour follows
 * that meaning rather than the sign of the number.
 */
function deltaColor(label: string, delta: number): string {
  const direction = deltaDirection(delta);
  if (direction === "flat") return "var(--cmux-text-tertiary)";
  if (label === "コスト相当" || label === "手戻り平均") {
    return direction === "up" ? "var(--cmux-usage-warn)" : "var(--cmux-usage-ok)";
  }
  return "var(--cmux-text-secondary)";
}
