/**
 * Per-project table. The "主な主題" column is filled from the overview's top
 * projects, which is the only place F1 exposes a representative title; rows the
 * overview did not reach show "—" rather than a guess.
 */

import {
  formatCount,
  formatPct,
  formatScore,
  formatMoney,
  type BreakdownReport,
  type Overview,
} from "../../lib/ailog";
import type { AilogSelection } from "../../stores/ailogStore";
import { ShareBar, VScrollBox, noteStyle, tableActionButtonStyle, tableStyle, tdLeftStyle, tdStyle, thLeftStyle, thStyle } from "./ui";

function breakdownValueLabel(value: string, dimensionLabel: string): string {
  if (!value || value === "(none)") return "未指定";
  if (value === "(unknown)") return dimensionLabel === "案件" ? "案件未指定" : "不明";
  if (value === "(untitled)") return "主題なし";
  if (value === "(main)") return "母艦";
  if (value === "unknown") return "不明";
  return value;
}

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
    ? `コスト相当 (対象トークンのうち価格情報あり ${Math.round(report.priceCoverage.coveredTokenRatio * 100)}%)`
    : "コスト相当";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
      {report.dimension === "agent" ? (
        <div role="note" style={noteStyle}>この内訳だけは「サブエージェントのターンも含める」がオフでもサブエージェントを含みます。{report.overlapping ? "関係するエージェントそれぞれに同じターンを計上するため、行同士が重複し合計できません。" : "この期間の行同士に重複はありません。"}</div>
      ) : null}
      <VScrollBox maxHeight={320} label={`${dimensionLabel}別の内訳`}>
        <table style={{ ...tableStyle, minWidth: projectMode ? 760 : 600 }}>
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
              <th scope="col" style={thLeftStyle}>{dimensionLabel}</th>
              <th scope="col" style={thStyle}>セッション</th>
              <th scope="col" style={thStyle}>{costLabel}</th>
              <th scope="col" style={thStyle}>シェア</th>
              {projectMode ? <th scope="col" style={thLeftStyle}>主な主題</th> : null}
              <th scope="col" style={thStyle}>平均手戻り</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((row) => {
              const filterableProject = projectMode && row.key !== "(unknown)" && row.key !== "unknown";
              const selected = filterableProject && selection?.project?.key === row.key;
              return (
                <tr
                  key={row.key}
                  aria-selected={selected}
                  style={{ background: selected ? "var(--cmux-selected)" : undefined }}
                >
                  <th scope="row" style={{ ...tdLeftStyle, fontWeight: 400 }} title={row.key}>
                    {filterableProject ? <button
                      type="button"
                      aria-pressed={selected}
                      onClick={() => {
                        if (selected) {
                          onSelect(selection?.model ? { model: selection.model } : null);
                        } else {
                          onSelect({ ...selection, project: { key: row.key, label: breakdownValueLabel(row.key, dimensionLabel) } });
                        }
                      }}
                      style={tableActionButtonStyle}
                    >{breakdownValueLabel(row.key, dimensionLabel)}</button> : breakdownValueLabel(row.key, dimensionLabel)}
                  </th>
                  <td style={tdStyle}>{formatCount(row.sessions)}</td>
                  <td style={tdStyle}>{formatMoney(row.costUsd)}</td>
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
        {projectMode ? `${formatCount(report.rows.length)} 案件。案件名を選ぶと全体を絞り込みます。案件名は作業パスと編集・参照ファイルから決定します。` : `${formatCount(report.rows.length)} 件`}
      </div>
    </div>
  );
}
