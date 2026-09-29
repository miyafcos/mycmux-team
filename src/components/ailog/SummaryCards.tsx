/**
 * Three action-oriented headline numbers with their change against the previous window.
 *
 * The comparison is suppressed for the "全期間" preset: the window before "all
 * time" is empty, so every metric would read +100%. Showing "前期間データなし"
 * is the honest form of that (F1 backlog #4).
 */

import {
  deltaDirection,
  formatDelta,
  formatRatio,
  formatScore,
  formatMoney,
  type Overview,
  type RangePreset,
} from "../../lib/ailog";
import { cardStyle } from "./ui";

export function SummaryCards({ overview, preset }: { overview: Overview; preset: RangePreset }) {
  const showCompare = preset !== "all";
  const { totals, comparePrevious, rework } = overview;

  const costLabel = overview.priceCoverage.coveredTokenRatio < 1
    ? `コスト相当 (対象トークンのうち価格情報あり ${Math.round(overview.priceCoverage.coveredTokenRatio * 100)}%)`
    : "コスト相当";
  const cards: { kind: "cost" | "rework"; label: string; value: string; delta: number | null; comparable: boolean; subtitle: string }[] = [
    {
      kind: "cost",
      label: costLabel,
      value: formatMoney(totals.costUsd),
      delta: comparePrevious.costPct,
      comparable: true,
      subtitle: "公表価格・ログ報告額・定額・ローカル情報から計算した参考値。請求額ではありません。円額は設定レートでの換算",
    },
    {
      kind: "rework",
      label: "手戻り平均",
      value: formatScore(rework.avgScore),
      delta: comparePrevious.reworkPct,
      comparable: true,
      subtitle: "0〜100の相対指標。低いほど機械的な手戻りの兆候が少ない",
    },
    {
      kind: "rework",
      label: "ツール実行のまま終了した割合",
      value: formatRatio(totals.sessions === 0 ? 0 : rework.abandonedSessions / totals.sessions),
      delta: null,
      comparable: false,
      subtitle: "ツール実行のまま終わったセッションの割合",
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
        <div key={card.label} style={{ ...cardStyle, padding: "10px 12px 11px" }}>
          <div style={{ fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-text-tertiary)" }}>{card.label}</div>
          <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-0.01em", marginTop: 2 }}>{card.value}</div>
          <div style={{ marginTop: 3, fontSize: "var(--cmux-font-size-xs)", minHeight: 14 }}>
            {card.comparable && card.delta !== null && showCompare ? (
              <span style={{ color: deltaColor(card.kind, card.delta) }}>
                {`${formatDelta(card.delta)} 前期間比`}
              </span>
            ) : card.comparable ? (
              <span style={{ color: "var(--cmux-text-tertiary)" }}>{showCompare ? "前期間 0 のため比率なし" : "全期間表示のため前期間比較なし"}</span>
            ) : null}
          </div>
          <div style={{ marginTop: 5, fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-text-secondary)", lineHeight: 1.4 }}>{card.subtitle}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * More sessions is neutral, more cost or more rework is worse. Colour follows
 * that meaning rather than the sign of the number.
 */
function deltaColor(kind: "default" | "cost" | "rework", delta: number): string {
  const direction = deltaDirection(delta);
  if (direction === "flat") return "var(--cmux-text-tertiary)";
  if (kind === "cost" || kind === "rework") {
    return direction === "up" ? "var(--cmux-usage-warn)" : "var(--cmux-usage-ok)";
  }
  return "var(--cmux-text-secondary)";
}
