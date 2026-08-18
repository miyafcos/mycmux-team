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
import { ShareBar, VScrollBox, noteStyle, tableStyle, tdLeftStyle, tdStyle, thLeftStyle, thStyle } from "./ui";

export function ProjectTable({
  report,
  overview,
  selection,
  onSelect,
  dimensionLabel = "案件",
  projectMode = true,
}: {
  report: BreakdownReport;
  overview: Overview | null;
  selection: AilogSelection | null;
  onSelect: (selection: AilogSelection | null) => void;
  dimensionLabel?: string;
  projectMode?: boolean;
}) {
  const topTitles = new Map(
    (overview?.topProjects ?? []).map((project) => [project.projectLabel, project.topTitle]),
  );
  const costLabel = report.priceCoverage.coveredTokenRatio < 1
    ? `コスト相当 (単価既知の ${Math.round(report.priceCoverage.coveredTokenRatio * 100)}% 分)`
    : "コスト相当";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
      <VScrollBox maxHeight={320}>
        <table style={tableStyle}>
          <colgroup>
            {projectMode ? (
              <>
                <col style={{ width: "26%" }} />
                <col style={{ width: "10%" }} />
                <col style={{ width: "14%" }} />
                <col style={{ width: "16%" }} />
                <col style={{ width: "24%" }} />
                <col style={{ width: "10%" }} />
              </>
            ) : (
              <>
                <col style={{ width: "50%" }} />
                <col style={{ width: "10%" }} />
                <col style={{ width: "14%" }} />
                <col style={{ width: "16%" }} />
                <col style={{ width: "10%" }} />
              </>
            )}
          </colgroup>
          <thead>
            <tr>
              <th style={thLeftStyle}>{dimensionLabel}</th>
              <th style={thStyle}>セッション</th>
              <th style={thStyle}>{costLabel}</th>
              <th style={thStyle}>シェア</th>
              {projectMode ? <th style={thLeftStyle}>主な主題</th> : null}
              <th style={thStyle}>平均手戻り</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((row) => {
              const selected = projectMode && selection?.project?.key === row.key;
              return (
                <tr
                  key={row.key}
                  aria-selected={selected}
                  style={{ background: selected ? "var(--cmux-selected)" : undefined, cursor: projectMode ? "pointer" : undefined }}
                  onClick={() => {
                    if (!projectMode) return;
                    if (selected) {
                      onSelect(selection?.model ? { model: selection.model } : null);
                    } else {
                      onSelect({ ...selection, project: { key: row.key, label: row.key } });
                    }
                  }}
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
                  {projectMode ? <td style={tdLeftStyle} title={topTitles.get(row.key) ?? undefined}>{topTitles.get(row.key) ?? "—"}</td> : null}
                  <td style={tdStyle}>{formatScore(row.avgRework)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </VScrollBox>
      <div style={noteStyle}>
        {projectMode ? `${formatCount(report.rows.length)} 案件。行をクリックするとその案件で全体を絞り込みます。案件名は作業パスと編集・参照ファイルから決定します。` : formatCount(report.rows.length)}
      </div>
    </div>
  );
}
