/**
 * Session list: 100 rows at a time, sorted and paged in the browser over the
 * one capped fetch the dashboard already made.
 */

import { useMemo } from "react";

import {
  formatCount,
  formatLocalDateTime,
  formatScore,
  formatUsd,
  kindLabel,
  workTagHint,
  workTagLabel,
  type SessionsReport,
} from "../../lib/ailog";
import type { AilogSelection, SessionSort } from "../../stores/ailogStore";
import type { LeafDimension } from "./sankeyModel";
import { filterSessions, pageSessions, sortSessions } from "./sessionFilter";
import { ButtonGroup, Chip, ScrollBox, noteStyle, subtleButtonStyle, tableStyle, tdLeftStyle, tdStyle, thLeftStyle, thStyle } from "./ui";

export function SessionTable({
  report,
  sort,
  onSort,
  page,
  onPage,
  pageSize,
  selection,
  leafDimension,
  onOpenDetail,
  activeKey,
}: {
  report: SessionsReport;
  sort: SessionSort;
  onSort: (value: SessionSort) => void;
  page: number;
  onPage: (value: number) => void;
  pageSize: number;
  selection: AilogSelection | null;
  leafDimension: LeafDimension;
  onOpenDetail: (kind: string, sessionId: string) => void;
  activeKey: { kind: string; sessionId: string } | null;
}) {
  const view = useMemo(() => {
    const filtered = filterSessions(report.rows, selection, leafDimension);
    return pageSessions(sortSessions(filtered, sort), page, pageSize);
  }, [report.rows, selection, leafDimension, sort, page, pageSize]);

  const truncated = Math.max(0, report.total - report.rows.length);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-text-tertiary)" }}>並び順</span>
        <ButtonGroup
          ariaLabel="セッションの並び順"
          value={sort}
          onChange={onSort}
          options={[
            { value: "cost" as SessionSort, label: "コスト降順" },
            { value: "rework" as SessionSort, label: "手戻り降順" },
            { value: "recent" as SessionSort, label: "新しい順" },
          ]}
        />
      </div>

      <ScrollBox maxHeight={420}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thLeftStyle}>日時</th>
              <th style={thLeftStyle}>主題</th>
              <th style={thLeftStyle}>要約</th>
              <th style={thLeftStyle}>案件</th>
              <th style={thLeftStyle}>モデル</th>
              <th style={thStyle}>ターン</th>
              <th style={thStyle}>コスト</th>
              <th style={thStyle}>手戻り</th>
              <th style={thLeftStyle}>作業種別</th>
            </tr>
          </thead>
          <tbody>
            {view.rows.map((row) => {
              const active = activeKey?.kind === row.kind && activeKey.sessionId === row.sessionId;
              return (
                <tr
                  key={`${row.kind}:${row.sessionId}`}
                  aria-selected={active}
                  style={{ background: active ? "var(--cmux-selected)" : undefined, cursor: "pointer" }}
                  onClick={() => onOpenDetail(row.kind, row.sessionId)}
                >
                  <td style={tdStyle}>{formatLocalDateTime(row.startedAt)}</td>
                  <td style={tdLeftStyle} title={row.title ?? undefined}>
                    {row.title?.trim() || "（無題）"}
                  </td>
                  <td style={{ ...tdLeftStyle, maxWidth: 260 }} title={row.goalSummary?.trim() || row.title || undefined}>
                    {row.goalSummary?.trim() || row.title?.trim() || "（無題）"}
                  </td>
                  <td style={tdLeftStyle} title={row.projectLabel ?? undefined}>
                    {row.projectLabel ?? "—"}
                  </td>
                  <td style={tdLeftStyle} title={row.primaryModel ?? undefined}>
                    {`${kindLabel(row.kind)} · ${row.primaryModel ?? "—"}`}
                    {row.modelCount > 1 ? `（${formatCount(row.modelCount)} モデル）` : ""}
                  </td>
                  <td style={tdStyle}>{formatCount(row.turnCount)}</td>
                  <td style={tdStyle}>{formatUsd(row.costUsd)}</td>
                  <td style={tdStyle}>{formatScore(row.reworkScore)}</td>
                  <td style={{ ...tdLeftStyle, maxWidth: 220 }}>
                    <span style={{ display: "inline-flex", gap: 3, flexWrap: "wrap" }}>
                      {row.workTags.length === 0 ? (
                        <span style={{ color: "var(--cmux-text-tertiary)" }}>—</span>
                      ) : (
                        row.workTags.map((tag) => (
                          <Chip key={tag} title={workTagHint(tag)}>
                            {workTagLabel(tag)}
                          </Chip>
                        ))
                      )}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </ScrollBox>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          disabled={view.page <= 0}
          onClick={() => onPage(view.page - 1)}
          style={{ ...subtleButtonStyle, opacity: view.page <= 0 ? 0.4 : 1 }}
        >
          前の 100 件
        </button>
        <button
          type="button"
          disabled={view.page >= view.pageCount - 1}
          onClick={() => onPage(view.page + 1)}
          style={{ ...subtleButtonStyle, opacity: view.page >= view.pageCount - 1 ? 0.4 : 1 }}
        >
          次の 100 件
        </button>
        <span style={noteStyle}>
          {view.total === 0
            ? "該当するセッションはありません"
            : `${formatCount(view.from)}–${formatCount(view.to)} / ${formatCount(view.total)} 件（${view.page + 1} / ${view.pageCount} ページ）`}
        </span>
      </div>

      <div style={{ ...noteStyle, display: "flex", flexDirection: "column", gap: 2 }}>
        {truncated > 0 ? (
          <div>{`取得は上位 ${formatCount(report.rows.length)} 件までです（全 ${formatCount(report.total)} 件・残り ${formatCount(truncated)} 件は未取得）。`}</div>
        ) : null}
        {selection?.type === "tag" ? (
          <div>{`作業種別「${selection.label}」で絞り込み中です。作業種別の絞り込みはこの一覧にだけ効きます（上の集計は期間全体のままです）。`}</div>
        ) : null}
        <div>行をクリックすると詳細を開きます。</div>
      </div>
    </div>
  );
}
