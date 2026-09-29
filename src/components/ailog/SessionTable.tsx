/**
 * Session list: 100 rows at a time from the dedicated server-paged endpoint.
 */

import { useEffect, useMemo, useState } from "react";
import { useVirtualRows } from "../../hooks/useVirtualRows";

import {
  formatCount,
  formatLocalDateTime,
  formatScore,
  formatMoney,
  kindLabel,
  workTagHint,
  workTagLabel,
  type SessionRow,
  type SessionsReport,
} from "../../lib/ailog";
import type { SessionSort } from "../../stores/ailogStore";
import { useThemeStore } from "../../stores/themeStore";
import { getSessionTableRowMetrics } from "./sessionTableRowHeight";
import { ButtonGroup, Chip, noteStyle, subtleButtonStyle, tableStyle, tdClipStyle, tdStyle, thLeftStyle, thStyle } from "./ui";
import { groupLabel } from "./usageModel";

function rangeModelName(name: string): string {
  return groupLabel(name);
}

export function sessionModelLabel(row: SessionRow): string {
  const rangeModels = row.rangeModels ?? [];
  if (rangeModels.length === 0) {
    return `${kindLabel(row.kind)} · ${row.primaryModel ?? "ログにモデル名なし"}${
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
  appliedSort = sort,
  onSort,
  page,
  appliedPage = page,
  onPage,
  pageSize,
  onOpenDetail,
  activeKey,
  query,
  appliedQuery,
  onQuery,
  onRetry,
  loading,
  error,
  modelFilterActive,
}: {
  report: SessionsReport;
  sort: SessionSort;
  appliedSort: SessionSort;
  onSort: (value: SessionSort) => void;
  page: number;
  appliedPage: number;
  onPage: (value: number) => void;
  pageSize: number;
  onOpenDetail: (kind: string, sessionId: string) => void;
  activeKey: { kind: string; sessionId: string } | null;
  query: string;
  appliedQuery: string;
  onQuery: (value: string) => void;
  onRetry: () => void;
  loading: boolean;
  error: string | null;
  modelFilterActive: boolean;
}) {
  const pageCount = Math.max(1, Math.ceil(report.total / pageSize));
  const currentPage = Math.min(appliedPage, pageCount - 1);
  const from = report.rows.length === 0 ? 0 : currentPage * pageSize + 1;
  const to = Math.min(report.total, currentPage * pageSize + report.rows.length);
  const uiDensity = useThemeStore((state) => state.uiDensity);
  const uiFontScale = useThemeStore((state) => state.uiFontScale);
  const rowMetrics = useMemo(
    () => getSessionTableRowMetrics(uiDensity, uiFontScale),
    [uiDensity, uiFontScale],
  );
  const [draftQuery, setDraftQuery] = useState(query);
  useEffect(() => setDraftQuery(query), [query]);
  useEffect(() => {
    if (draftQuery === query) return;
    const timer = window.setTimeout(() => onQuery(draftQuery), 250);
    return () => window.clearTimeout(timer);
  }, [draftQuery, onQuery, query]);

  const virtual = useVirtualRows(report.rows.length, rowMetrics.rowHeight);
  const costLabel = "コスト相当";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, flex: "1 1 280px", minWidth: 0 }}>
          <span style={{ fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-text-tertiary)", flex: "0 0 auto" }}>検索</span>
          <input
            type="search"
            name="ailog-session-search"
            autoComplete="off"
            value={draftQuery}
            onChange={(event) => setDraftQuery(event.currentTarget.value)}
            placeholder="主題・最初の依頼・案件を検索"
            style={{ flex: "1 1 auto", minWidth: 160, padding: "5px 7px", border: "1px solid var(--cmux-border)", borderRadius: 5, background: "var(--cmux-bg)", color: "var(--cmux-text)" }}
          />
        </label>
        <span style={{ fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-text-tertiary)" }}>並び順</span>
        <ButtonGroup
          ariaLabel="セッションの並び順"
          value={sort}
          onChange={onSort}
          options={[
            { value: "cost" as SessionSort, label: modelFilterActive ? "該当モデル分のコスト相当順" : "コスト相当降順" },
            { value: "rework" as SessionSort, label: "手戻り降順" },
            { value: "recent" as SessionSort, label: modelFilterActive ? "該当モデルの最終記録順" : "新しい順" },
            { value: "turns" as SessionSort, label: modelFilterActive ? "該当モデル分のターン数順" : "ターン数降順" },
          ]}
        />
      </div>
      {draftQuery !== query ? <div role="status" style={noteStyle}>入力中の検索語は0.25秒後に一覧へ反映します。</div> : null}
      <div role="note" style={noteStyle}>{modelFilterActive ? "選択中のモデルを含むセッションだけを表示しています。" : "選んだ期間に記録のあるセッションを表示しています。"}行のターン・コスト相当・手戻りはセッション全体の値です。{modelFilterActive ? "コスト相当・ターン・新しさの並び順だけは、該当モデルの記録から計算します。" : ""}</div>
      {error ? <div role="alert" style={{ ...noteStyle, color: "var(--cmux-red)" }}>指定した条件でセッション一覧を取得できませんでした。{appliedQuery ? `直前の「${appliedQuery}」の一覧を表示しています。` : "直前の一覧を表示しています。"}<button type="button" onClick={onRetry} style={{ ...subtleButtonStyle, marginLeft: 6 }}>同じ条件で再試行</button><details><summary>技術情報</summary>{error}</details></div> : null}

      <div ref={virtual.ref} onScroll={virtual.onScroll} aria-busy={loading} style={{ maxHeight: 420, overflow: "auto", border: "1px solid var(--cmux-border)", borderRadius: 6 }}>
        <table style={{ ...tableStyle, minWidth: 1100 }}>
          <caption style={{ textAlign: "left", padding: "6px 8px", color: "var(--cmux-text-tertiary)", fontSize: "var(--cmux-font-size-xs)" }}>セッションの検索結果。詳細は主題ボタンから開きます。</caption>
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
              <th scope="col" style={thLeftStyle}>日時</th>
              <th scope="col" style={thLeftStyle}>主題</th>
              <th scope="col" style={thLeftStyle}>要約</th>
              <th scope="col" style={thLeftStyle}>案件</th>
              <th scope="col" style={thLeftStyle}>モデル</th>
              <th scope="col" style={thStyle}>{modelFilterActive ? "ターン（全体）" : "ターン"}</th>
              <th scope="col" style={thStyle}>{modelFilterActive ? `${costLabel}（全体）` : costLabel}</th>
              <th scope="col" style={thStyle}>{modelFilterActive ? "手戻り（全体）" : "手戻り"}</th>
              <th scope="col" style={thLeftStyle}>作業種別</th>
            </tr>
          </thead>
          <tbody>
            {virtual.paddingTop > 0 && <tr><td colSpan={9} style={{ height: virtual.paddingTop, padding: 0 }} /></tr>}
            {report.rows.slice(virtual.start, virtual.end).map((row) => {
              const active = activeKey?.kind === row.kind && activeKey.sessionId === row.sessionId;
              return (
                <tr
                  key={`${row.kind}:${row.sessionId}`}
                  aria-selected={active}
                  style={{
                    height: rowMetrics.rowHeight,
                    lineHeight: rowMetrics.lineHeight,
                    background: active ? "var(--cmux-selected)" : undefined,
                  }}
                >
                  <td style={tdStyle}>{formatLocalDateTime(row.startedAt)}</td>
                  <th scope="row" style={{ ...tdClipStyle, fontWeight: 400, textAlign: "left" }} title={row.title ?? undefined}>
                    <button type="button" onClick={() => onOpenDetail(row.kind, row.sessionId)} style={{ width: "100%", padding: 0, border: 0, background: "transparent", color: "var(--cmux-accent)", textAlign: "left", textDecoration: "underline", textUnderlineOffset: 2, cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {row.title?.trim() || "（無題）"}
                    </button>
                  </th>
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
                  <td style={tdStyle}>{formatMoney(row.costUsd)}</td>
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
          disabled={currentPage <= 0 || loading}
          onClick={() => onPage(currentPage - 1)}
          style={{ ...subtleButtonStyle, opacity: currentPage <= 0 || loading ? 0.4 : 1 }}
        >
          前の 100 件
        </button>
        <button
          type="button"
          disabled={currentPage >= pageCount - 1 || loading}
          onClick={() => onPage(currentPage + 1)}
          style={{ ...subtleButtonStyle, opacity: currentPage >= pageCount - 1 || loading ? 0.4 : 1 }}
        >
          次の 100 件
        </button>
        <span style={noteStyle}>
          {report.total === 0
            ? "該当するセッションはありません (絞り込みや期間を変えると表示されます)"
            : `${formatCount(from)}–${formatCount(to)} / ${formatCount(report.total)} 件（${currentPage + 1} / ${pageCount} ページ）${loading ? ` · ${page + 1}ページ目・${sort === appliedSort ? "同じ並び順" : "新しい並び順"}を更新中` : ""}`}
        </span>
      </div>

      <div style={noteStyle}>主題を選ぶと詳細を開きます。</div>
    </div>
  );
}
