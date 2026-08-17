/**
 * Per-model breakdown for the usage tab.
 *
 * Ordered by the selected metric, not by cost — the whole point of the tab is
 * that those two orders disagree. Model classes keep an unknown price visibly
 * distinct from a local or flat-rate $0.
 */

import { formatCount, formatTokens, formatUsd, SYNTHETIC_MODEL, type SeriesReport } from "../../lib/ailog";
import {
  UNKNOWN_GROUP,
  costCoverageLabel,
  formatMetric,
  groupByLabel,
  groupLabel,
  metricValue,
  type UsageMetric,
} from "./usageModel";
import {
  Chip,
  ScrollBox,
  ShareBar,
  noteStyle,
  tableStyle,
  tdLeftStyle,
  tdStyle,
  thLeftStyle,
  thStyle,
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
}: {
  report: SeriesReport;
  metric: UsageMetric;
  excludeSynthetic?: boolean;
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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
      <ScrollBox>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thLeftStyle}>{groupingLabel}</th>
              <th style={thStyle}>選択中の指標</th>
              <th style={thStyle}>シェア</th>
              <th style={thStyle}>入力</th>
              <th style={thStyle}>出力</th>
              <th style={thStyle}>キャッシュ読み</th>
              <th style={thStyle}>キャッシュ書き</th>
              <th style={thStyle}>ターン</th>
              <th style={thStyle}>セッション</th>
              <th style={thStyle}>使用日数</th>
              <th style={thStyle}>{costLabel}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const share = total > 0 ? (row.metric / total) * 100 : 0;
              const isUnknown = row.group === UNKNOWN_GROUP;
              const modelClass = classForGroup(row.group);
              const cost = modelClass === "unknown" || isUnknown
                ? { value: "—", title: "単価未公表のため除外" }
                : modelClass === "local"
                  ? { value: formatUsd(0), title: "ローカル実行 — 費用なし" }
                  : modelClass === "flat"
                    ? { value: formatUsd(0), title: "定額プラン — 従量費用なし" }
                    : { value: formatUsd(row.costUsd), title: undefined };
              return (
                <tr key={row.group}>
                  <td style={tdLeftStyle}>
                    <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                      {groupLabel(row.group, report.groupBy)}
                      {isUnknown ? (
                        <Chip tone="warn" title="Codex の token_count イベントにモデルが無い記録です">
                          モデルなし
                        </Chip>
                      ) : null}
                    </span>
                  </td>
                  <td style={tdStyle}>{formatMetric(row.metric, metric)}</td>
                  <td style={tdStyle}>
                    <ShareBar pct={share} title={`${share.toFixed(1)}%`} />
                    <span style={{ marginLeft: 6 }}>{`${share.toFixed(1)}%`}</span>
                  </td>
                  <td style={tdStyle}>{formatTokens(row.input)}</td>
                  <td style={tdStyle}>{formatTokens(row.output)}</td>
                  <td style={tdStyle}>{formatTokens(row.cacheRead)}</td>
                  <td style={tdStyle}>{formatTokens(row.cacheWrite)}</td>
                  <td style={tdStyle}>{formatCount(row.turns)}</td>
                  <td style={tdStyle}>{formatCount(row.sessions)}</td>
                  <td style={tdStyle}>{formatCount(row.days)}</td>
                  <td style={{ ...tdStyle, color: cost.value === "—" ? "var(--cmux-text-tertiary)" : undefined }} title={cost.title}>{cost.value}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </ScrollBox>
      <div style={noteStyle}>
        セッション数は{groupingLabel}ごとに数えているため、合計は実際のセッション本数より多くなります (1 本が複数{groupingLabel}を使うため)。
      </div>
    </div>
  );
}
