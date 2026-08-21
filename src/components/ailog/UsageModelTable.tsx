/**
 * Per-model breakdown for the usage tab.
 *
 * Ordered by the selected metric, not by cost — the whole point of the tab is
 * that those two orders disagree. Model classes keep an unknown price visibly
 * distinct from a local or flat-rate $0.
 */

import { SYNTHETIC_MODEL, type SeriesGroupBy, type SeriesReport } from "../../lib/ailog";
import type { AilogSelection } from "../../stores/ailogStore";
import { seriesPaint, type SeriesPaint } from "./modelColors";
import {
  UNKNOWN_GROUP,
  costCoverageLabel,
  groupByLabel,
  groupLabel,
  metricUnit,
  metricValue,
  usageMetricInfo,
  type UsageMetric,
} from "./usageModel";
import {
  Chip,
  Num,
  ShareBar,
  ThCell,
  noteStyle,
  tableStyle,
  tdLeftStyle,
  tdStyle,
  thLeftStyle,
  paintSwatchBackground,
} from "./ui";

interface Row {
  group: string;
  turns: number;
  sessions: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  days: number;
  metric: number;
}

export function modelTablePaint(group: string, groupBy: SeriesGroupBy): SeriesPaint {
  return seriesPaint(group, groupBy);
}

export function buildModelRows(report: SeriesReport, metric: UsageMetric): Row[] {
  const rows = new Map<string, Row>();
  for (const bucket of report.buckets) {
    for (const group of bucket.groups) {
      const row = rows.get(group.group) ?? {
        group: group.group,
        turns: 0,
        sessions: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        costUsd: 0,
        days: 0,
        metric: 0,
      };
      row.turns += group.turns;
      row.sessions += group.sessions;
      row.input += group.input;
      row.output += group.output;
      row.cacheRead += group.cacheRead;
      row.cacheWrite += group.cacheWrite;
      row.costUsd += group.costUsd;
      row.days += 1;
      row.metric += metricValue(group, metric);
      rows.set(group.group, row);
    }
  }
  return [...rows.values()].sort((a, b) => b.metric - a.metric || a.group.localeCompare(b.group));
}

export function UsageModelTable({
  report,
  metric,
  excludeSynthetic = true,
  selection,
  onSelect,
}: {
  report: SeriesReport;
  metric: UsageMetric;
  excludeSynthetic?: boolean;
  selection: AilogSelection | null;
  onSelect: (selection: AilogSelection | null) => void;
}) {
  const rows = buildModelRows(report, metric).filter((row) => !excludeSynthetic || row.group !== SYNTHETIC_MODEL);
  const total = rows.reduce((sum, row) => sum + row.metric, 0);
  const groupingLabel = groupByLabel(report.groupBy);
  const classForGroup = (group: string) => {
    if (report.groupBy === "provider") {
      return group === "local" ? "local" : group === "google" || group === "other" ? "unknown" : "priced";
    }
    const matches = (models: string[]) => models.some((model) => model === group || model.startsWith(`${group}-`));
    if (matches(report.priceCoverage.unknown.models)) return "unknown";
    if (matches(report.priceCoverage.local.models)) return "local";
    if (matches(report.priceCoverage.flat.models)) return "flat";
    if (matches(report.priceCoverage.internal.models)) return "internal";
    return "priced";
  };
  const costLabel = costCoverageLabel(report.priceCoverage);

  if (rows.length === 0) {
    return <div style={noteStyle}>この期間に記録がありません。期間を広げるか、再インデックスしてください。</div>;
  }

  const metricKind = metricUnit(metric);
  const costSub = report.priceCoverage.coveredTokenRatio < 1
    ? `単価既知の ${Math.round(report.priceCoverage.coveredTokenRatio * 100)}% 分`
    : undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
        <table style={tableStyle}>
          <colgroup>
            <col style={{ width: "18%" }} />
            <col style={{ width: "9%" }} />
            <col style={{ width: "12%" }} />
            <col style={{ width: "8%" }} />
            <col style={{ width: "8%" }} />
            <col style={{ width: "8%" }} />
            <col style={{ width: "8%" }} />
            <col style={{ width: "6%" }} />
            <col style={{ width: "7%" }} />
            <col style={{ width: "6%" }} />
            <col style={{ width: "10%" }} />
          </colgroup>
          <thead>
            <tr>
              <th style={thLeftStyle}>{groupingLabel}</th>
              <ThCell main={usageMetricInfo(metric).label} />
              <ThCell main="シェア" />
              <ThCell main="入力" />
              <ThCell main="出力" />
              <ThCell main="キャッシュ" sub="読み" />
              <ThCell main="キャッシュ" sub="書き" />
              <ThCell main="ターン" />
              <ThCell main="セッション" />
              <ThCell main="使用" sub="日数" />
              <ThCell main="コスト相当" sub={costSub} title={costLabel} />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const share = total > 0 ? (row.metric / total) * 100 : 0;
              const isUnknown = row.group === UNKNOWN_GROUP;
              const clickable = (report.groupBy === "model" || report.groupBy === "model_raw")
                && row.group !== UNKNOWN_GROUP
                && row.group !== SYNTHETIC_MODEL;
              const selected = Boolean(clickable && selection?.model?.key === row.group);
              const modelClass = classForGroup(row.group);
              const paint = modelTablePaint(row.group, report.groupBy);
              const cost = modelClass === "unknown" || isUnknown
                ? { value: "—", title: "単価未公表のため除外" }
                : modelClass === "local"
                  ? { value: "usd", title: "ローカル実行 — 費用なし" }
                  : modelClass === "flat"
                    ? { value: "usd", title: "定額プラン — 従量費用なし" }
                    : report.groupBy === "provider" && row.group === "xai"
                      ? { value: "usd", title: "Grok の自己申告コスト" }
                      : { value: "usd", title: undefined };
              return (
                <tr
                  key={row.group}
                  aria-selected={selected || undefined}
                  style={{
                    background: selected ? "var(--cmux-selected)" : undefined,
                    cursor: clickable ? "pointer" : undefined,
                  }}
                  onClick={() => {
                    if (!clickable) return;
                    if (selected) {
                      onSelect(selection?.project ? { project: selection.project } : null);
                    } else {
                      onSelect({ ...selection, model: { key: row.group, label: groupLabel(row.group, report.groupBy) } });
                    }
                  }}
                >
                  <td style={tdLeftStyle}>
                    <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                      <span aria-hidden="true" style={{ width: 9, height: 9, borderRadius: 2, background: paintSwatchBackground(paint), display: "inline-block" }} />
                      {groupLabel(row.group, report.groupBy)}
                      {isUnknown ? (
                        <Chip tone="warn" title="Codex の token_count イベントにモデルが無い記録です">
                          モデルなし
                        </Chip>
                      ) : null}
                    </span>
                  </td>
                  <td style={tdStyle}><Num value={row.metric} kind={metricKind} bare={metricKind === "tokens"} /></td>
                  <td style={tdStyle}>
                    <ShareBar pct={share} title={`${share.toFixed(1)}%`} />
                    <span style={{ marginLeft: 6 }}>{`${share.toFixed(1)}%`}</span>
                  </td>
                  <td style={tdStyle}><Num value={row.input} kind="tokens" bare /></td>
                  <td style={tdStyle}><Num value={row.output} kind="tokens" bare /></td>
                  <td style={tdStyle}><Num value={row.cacheRead} kind="tokens" bare /></td>
                  <td style={tdStyle}><Num value={row.cacheWrite} kind="tokens" bare /></td>
                  <td style={tdStyle}><Num value={row.turns} kind="count" /></td>
                  <td style={tdStyle}><Num value={row.sessions} kind="count" /></td>
                  <td style={tdStyle}><Num value={row.days} kind="count" /></td>
                  <td style={{ ...tdStyle, color: cost.value === "—" ? "var(--cmux-text-tertiary)" : undefined }}>
                    {cost.value === "—" ? "—" : <Num value={row.costUsd} kind="usd" title={cost.title} />}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      <div style={noteStyle}>
        セッション数は{groupingLabel}ごとに数えているため、合計は実際のセッション本数より多くなります (1 本が複数{groupingLabel}を使うため)。行をクリックするとそのモデルで全体を絞り込みます。
      </div>
    </div>
  );
}
