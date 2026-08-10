/**
 * Per-project table. The "主な主題" column is filled from the overview's top
 * projects, which is the only place F1 exposes a representative title; rows the
 * overview did not reach show "—" rather than a guess.
 */

import {
  formatCount,
  formatPct,
  formatScore,
  formatUsd,
  type BreakdownReport,
  type Overview,
} from "../../lib/ailog";
import type { AilogSelection } from "../../stores/ailogStore";
import { ScrollBox, ShareBar, noteStyle, tableStyle, tdLeftStyle, tdStyle, thLeftStyle, thStyle } from "./ui";

export function ProjectTable({
  report,
  overview,
  selection,
  onSelect,
}: {
  report: BreakdownReport;
  overview: Overview | null;
  selection: AilogSelection | null;
  onSelect: (selection: AilogSelection | null) => void;
}) {
  const topTitles = new Map(
    (overview?.topProjects ?? []).map((project) => [project.projectLabel, project.topTitle]),
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
      <ScrollBox maxHeight={320}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thLeftStyle}>案件</th>
              <th style={thStyle}>セッション</th>
              <th style={thStyle}>コスト</th>
              <th style={thStyle}>シェア</th>
              <th style={thLeftStyle}>主な主題</th>
              <th style={thStyle}>平均手戻り</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((row) => {
              const selected =
                (selection?.type === "project" || selection?.type === "leaf") && selection.key === row.key;
              return (
                <tr
                  key={row.key}
                  aria-selected={selected}
                  style={{ background: selected ? "var(--cmux-selected)" : undefined, cursor: "pointer" }}
                  onClick={() => onSelect(selected ? null : { type: "project", key: row.key, label: row.key })}
                >
                  <td style={tdLeftStyle} title={row.key}>
                    {row.key}
                  </td>
                  <td style={tdStyle}>{formatCount(row.sessions)}</td>
                  <td style={tdStyle}>{formatUsd(row.costUsd)}</td>
                  <td style={tdStyle}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                      <ShareBar pct={row.sharePct} />
                      {formatPct(row.sharePct)}
                    </span>
                  </td>
                  <td style={tdLeftStyle} title={topTitles.get(row.key) ?? undefined}>
                    {topTitles.get(row.key) ?? "—"}
                  </td>
                  <td style={tdStyle}>{formatScore(row.avgRework)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </ScrollBox>
      <div style={noteStyle}>
        {`${formatCount(report.rows.length)} 案件。行をクリックするとその案件で全体を絞り込みます。案件名はセッションの作業フォルダ（末尾 2 階層）です。`}
      </div>
    </div>
  );
}
