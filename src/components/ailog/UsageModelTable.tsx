/**
 * Per-model breakdown for the usage tab.
 *
 * Ordered by the selected metric, not by cost — the whole point of the tab is
 * that those two orders disagree. Models with no published rate show 未設定
 * rather than $0.00, which would read as "this was free".
 */

import { formatCount, formatTokens, formatUsd, type SeriesReport } from "../../lib/ailog";
import {
  UNKNOWN_GROUP,
  formatMetric,
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
}: {
  report: SeriesReport;
  metric: UsageMetric;
}) {
  const rows = buildModelRows(report, metric);
  const total = rows.reduce((sum, row) => sum + row.metric, 0);
  const unpriced = new Set(report.unpricedModels);
  // The backend reports unpriced models by their raw name. When the table is
  // grouped by family, a family counts as unpriced if any of its variants is:
  // `gpt-5.6` is priced through sol/terra/luna, but a new variant would not be.
  const isUnpricedGroup = (group: string) =>
    unpriced.has(group) || report.unpricedModels.some((model) => model.startsWith(`${group}-`));

  if (rows.length === 0) {
    return <div style={noteStyle}>この期間に記録がありません。</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
      <ScrollBox>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thLeftStyle}>モデル</th>
              <th style={thStyle}>選択中の指標</th>
              <th style={thStyle}>シェア</th>
              <th style={thStyle}>入力</th>
              <th style={thStyle}>出力</th>
              <th style={thStyle}>キャッシュ読み</th>
              <th style={thStyle}>キャッシュ書き</th>
              <th style={thStyle}>ターン</th>
              <th style={thStyle}>セッション</th>
              <th style={thStyle}>使用日数</th>
              <th style={thStyle}>コスト相当</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const share = total > 0 ? (row.metric / total) * 100 : 0;
              const isUnknown = row.group === UNKNOWN_GROUP;
              const isUnpriced = isUnpricedGroup(row.group);
              return (
                <tr key={row.group}>
                  <td style={tdLeftStyle}>
                    <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                      {groupLabel(row.group)}
                      {isUnknown ? (
                        <Chip tone="warn" title="Codex の token_count イベントにモデル名が無い記録です">
                          モデル名なし
                        </Chip>
                      ) : null}
                      {isUnpriced ? (
                        <Chip tone="warn" title="公表料率が登録されていないため、コスト相当に一切含まれていません">
                          単価未設定
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
                  <td style={{ ...tdStyle, color: isUnknown || isUnpriced ? "var(--cmux-text-tertiary)" : undefined }}>
                    {isUnknown ? "算出不可" : isUnpriced ? "未設定" : formatUsd(row.costUsd)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </ScrollBox>
      <div style={noteStyle}>
        セッション数はモデルごとに数えているため、合計は実際のセッション本数より多くなります (1 本が複数モデルを使うため)。
      </div>
    </div>
  );
}
