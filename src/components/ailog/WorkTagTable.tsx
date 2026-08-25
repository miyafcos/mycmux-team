/**
 * Cost by work tag. Tags are not exclusive, so rows must not be read as a
 * partition of the period total.
 */

import {
  formatCount,
  formatMoney,
  workTagHint,
  workTagLabel,
  type ModelsReport,
  type PriceCoverage,
  type WorkTagRow,
} from "../../lib/ailog";
import { VScrollBox, noteStyle, tableStyle, tdLeftStyle, tdStyle, thLeftStyle, thStyle } from "./ui";

export interface WorkTagAggregate {
  workTag: string;
  sessions: number;
  costUsd: number;
}

export function aggregateWorkTags(rows: WorkTagRow[]): WorkTagAggregate[] {
  return rows
    .map((row) => ({
      workTag: row.workTag,
      sessions: row.sessionCount,
      costUsd: row.perModel.reduce((sum, entry) => sum + entry.costUsd, 0),
    }))
    .sort((left, right) => right.costUsd - left.costUsd || left.workTag.localeCompare(right.workTag));
}

export const WORK_TAG_OVERLAP_NOTE =
  "1つのセッションが複数の種別に入る場合があり、各行は重複して数えられるため足し合わせられません";

/**
 * Tokens that can carry a cost, matching backend `PriceCoverageAcc::finish`:
 * internal/synthetic sits outside both the numerator and the denominator.
 */
export function coverageCostTokens(coverage: PriceCoverage): { covered: number; total: number } {
  const covered = coverage.priced.tokens + coverage.local.tokens + coverage.flat.tokens + coverage.reported.tokens;
  return { covered, total: covered + coverage.unknown.tokens };
}

export function workTagCostLabel(coverage: PriceCoverage): string {
  if (coverage.coveredTokenRatio >= 1) return "コスト相当";
  const { covered, total } = coverageCostTokens(coverage);
  return `コスト相当 (価格情報あり ${formatCount(covered)} / ${formatCount(total)} tok)`;
}

export function WorkTagTable({
  report,
}: {
  report: ModelsReport;
}) {
  const rows = aggregateWorkTags(report.byWorkTag);
  const costLabel = workTagCostLabel(report.priceCoverage);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
      <VScrollBox maxHeight={320}>
        <table style={tableStyle}>
          <caption style={{ textAlign: "left", padding: "6px 8px", color: "var(--cmux-text-tertiary)", fontSize: "var(--cmux-font-size-xs)" }}>作業種別ごとのセッション数とコスト相当</caption>
          <colgroup>
            <col style={{ width: "36%" }} />
            <col style={{ width: "28%" }} />
            <col style={{ width: "36%" }} />
          </colgroup>
          <thead>
            <tr>
              <th scope="col" style={thLeftStyle}>作業種別</th>
              <th scope="col" style={thStyle}>セッション</th>
              <th scope="col" style={thStyle}>{costLabel}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.workTag} data-testid="work-tag-row">
                <th scope="row" style={{ ...tdLeftStyle, fontWeight: 400 }} title={workTagHint(row.workTag)}>
                  {workTagLabel(row.workTag)}
                </th>
                <td style={tdStyle}>{formatCount(row.sessions)}</td>
                <td style={tdStyle}>{formatMoney(row.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </VScrollBox>
      {report.overlapping ? <div style={noteStyle}>{WORK_TAG_OVERLAP_NOTE}</div> : null}
    </div>
  );
}
