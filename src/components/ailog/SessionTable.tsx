/**
 * Session list: 100 rows at a time, sorted and paged in the browser over the
 * one capped fetch the dashboard already made.
 */

import { useMemo } from "react";
import { useVirtualRows } from "../../hooks/useVirtualRows";

import {
  formatCount,
  formatLocalDateTime,
  formatScore,
  formatUsd,
  kindLabel,
  workTagHint,
  workTagLabel,
  type PriceCoverage,
  type SessionRow,
  type SessionsReport,
} from "../../lib/ailog";
import type { SessionSort } from "../../stores/ailogStore";
import { useThemeStore } from "../../stores/themeStore";
import { pageSessions, sortSessions } from "./sessionFilter";
import { getSessionTableRowMetrics } from "./sessionTableRowHeight";
import { ButtonGroup, Chip, noteStyle, subtleButtonStyle, tableStyle, tdClipStyle, tdStyle, thLeftStyle, thStyle } from "./ui";
import { groupLabel } from "./usageModel";

function rangeModelName(name: string): string {
  return groupLabel(name);
}

export function sessionModelLabel(row: SessionRow): string {
  const rangeModels = row.rangeModels ?? [];
  if (rangeModels.length === 0) {
    return `${kindLabel(row.kind)} · ${row.primaryModel ?? "—"}${
      row.modelCount > 1 ? `（${formatCount(row.modelCount)} モデル）` : ""
    }`;
  }
  const names = rangeModels.map(rangeModelName).join(" + ");
  const extra =
    row.rangeModelCount > rangeModels.length
      ? ` ほか ${row.rangeModelCount - rangeModels.length}`
      : "";
  return `${kindLabel(row.kind)} · ${names}${extra}`;
}

export function sessionModelTitle(row: SessionRow): string | undefined {
  const rangeModels = row.rangeModels ?? [];
  if (rangeModels.length === 0) {
    return row.primaryModel ?? undefined;
  }
  return rangeModels.map(rangeModelName).join(" / ");
}

export function SessionTable({
  report,
  sort,
  onSort,
  page,
  onPage,
  pageSize,
  onOpenDetail,
  activeKey,
  priceCoverage,
}: {
  report: SessionsReport;
  sort: SessionSort;
  onSort: (value: SessionSort) => void;
  page: number;
  onPage: (value: number) => void;
  pageSize: number;
  onOpenDetail: (kind: string, sessionId: string) => void;
  activeKey: { kind: string; sessionId: string } | null;
  priceCoverage?: PriceCoverage;
}) {
  const view = useMemo(() => {
    return pageSessions(sortSessions(report.rows, sort), page, pageSize);
  }, [report.rows, sort, page, pageSize]);
  const uiDensity = useThemeStore((state) => state.uiDensity);
  const uiFontScale = useThemeStore((state) => state.uiFontScale);
  const rowMetrics = useMemo(
    () => getSessionTableRowMetrics(uiDensity, uiFontScale),
    [uiDensity, uiFontScale],
  );

  const truncated = Math.max(0, report.total - report.rows.length);
  const virtual = useVirtualRows(view.rows.length, rowMetrics.rowHeight);
  const costLabel = priceCoverage && priceCoverage.coveredTokenRatio < 1
    ? `コスト相当 (単価既知の ${Math.round(priceCoverage.coveredTokenRatio * 100)}% 分)`
    : "コスト相当";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-text-tertiary)" }}>並び順</span>
        <ButtonGroup
          ariaLabel="セッションの並び順"
          value={sort}
          onChange={onSort}
          options={[
            { value: "cost" as SessionSort, label: "コスト相当降順" },
            { value: "rework" as SessionSort, label: "手戻り降順" },
            { value: "recent" as SessionSort, label: "新しい順" },
            { value: "turns" as SessionSort, label: "ターン数降順" },
          ]}
        />
      </div>

      <div ref={virtual.ref} onScroll={virtual.onScroll} style={{ maxHeight: 420, overflowY: "auto", overflowX: "hidden", border: "1px solid var(--cmux-border)", borderRadius: 6 }}>
        <table style={tableStyle}>
          <colgroup>
            <col style={{ width: "10%" }} />
            <col style={{ width: "16%" }} />
            <col style={{ width: "22%" }} />
            <col style={{ width: "11%" }} />
            <col style={{ width: "15%" }} />
            <col style={{ width: "5%" }} />
            <col style={{ width: "8%" }} />
            <col style={{ width: "5%" }} />
            <col style={{ width: "8%" }} />
          </colgroup>
          <thead>
            <tr>
              <th style={thLeftStyle}>日時</th>
              <th style={thLeftStyle}>主題</th>
              <th style={thLeftStyle}>要約</th>
              <th style={thLeftStyle}>案件</th>
              <th style={thLeftStyle}>モデル</th>
              <th style={thStyle}>ターン</th>
              <th style={thStyle}>{costLabel}</th>
              <th style={thStyle}>手戻り</th>
              <th style={thLeftStyle}>作業種別</th>
            </tr>
          </thead>
          <tbody>
            {virtual.paddingTop > 0 && <tr><td colSpan={9} style={{ height: virtual.paddingTop, padding: 0 }} /></tr>}
            {view.rows.slice(virtual.start, virtual.end).map((row) => {
              const active = activeKey?.kind === row.kind && activeKey.sessionId === row.sessionId;
              return (
                <tr
                  key={`${row.kind}:${row.sessionId}`}
                  aria-selected={active}
                  style={{
                    height: rowMetrics.rowHeight,
                    lineHeight: rowMetrics.lineHeight,
                    background: active ? "var(--cmux-selected)" : undefined,
                    cursor: "pointer",
                  }}
                  onClick={() => onOpenDetail(row.kind, row.sessionId)}
                >
                  <td style={tdStyle}>{formatLocalDateTime(row.startedAt)}</td>
                  <td style={tdClipStyle} title={row.title ?? undefined}>
                    {row.title?.trim() || "（無題）"}
                  </td>
                  <td style={tdClipStyle} title={row.goalSummary?.trim() || undefined}>
                    {row.goalSummary?.trim() ? row.goalSummary.trim() : <Chip tone="warn">未要約</Chip>}
                  </td>
                  <td style={tdClipStyle} title={row.projectLabel ?? undefined}>
                    {row.projectLabel ?? "—"}
                  </td>
                  <td style={tdClipStyle} title={sessionModelTitle(row)}>
                    {sessionModelLabel(row)}
                  </td>
                  <td style={tdStyle}>{formatCount(row.turnCount)}</td>
                  <td style={tdStyle}>{formatUsd(row.costUsd)}</td>
                  <td style={tdStyle}>{formatScore(row.reworkScore)}</td>
                  <td style={tdClipStyle}>
                    <span style={{ display: "inline-flex", gap: 3, maxWidth: "100%", overflow: "hidden", flexWrap: "nowrap" }}>
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
            {virtual.paddingBottom > 0 && <tr><td colSpan={9} style={{ height: virtual.paddingBottom, padding: 0 }} /></tr>}
          </tbody>
        </table>
      </div>

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
            ? "該当するセッションはありません (絞り込みや期間を変えると表示されます)"
            : `${formatCount(view.from)}–${formatCount(view.to)} / ${formatCount(view.total)} 件（${view.page + 1} / ${view.pageCount} ページ）`}
        </span>
      </div>

      <div style={{ ...noteStyle, display: "flex", flexDirection: "column", gap: 2 }}>
        {truncated > 0 ? (
          <div>{`取得は上位 ${formatCount(report.rows.length)} 件までです（全 ${formatCount(report.total)} 件・残り ${formatCount(truncated)} 件は未取得）。`}</div>
        ) : null}
        <div>行をクリックすると詳細を開きます。</div>
      </div>
    </div>
  );
}
