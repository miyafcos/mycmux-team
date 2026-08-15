import { ButtonGroup, Chip, EmptyState, ScrollBox, Section, SkeletonBlock, noteStyle, subtleButtonStyle, tableStyle, tdLeftStyle, tdStyle, thLeftStyle, thStyle } from "./ui";
import type { FindingKind, FindingsReport, ReworkRankingsReport } from "../../lib/ailog";

const KIND_OPTIONS: { value: FindingKind | "all"; label: string }[] = [
  { value: "all", label: "すべて" },
  { value: "cause", label: "原因" },
  { value: "constraint", label: "制約" },
  { value: "gotcha", label: "ハマり" },
  { value: "decision", label: "決めた" },
  { value: "verified", label: "確かめた" },
];

const KIND_LABELS: Record<FindingKind, string> = {
  cause: "原因", constraint: "制約", gotcha: "ハマり", decision: "決めた", verified: "確かめた",
};

export function LearningView({
  findings, rankings, kind, query, loading, error, onKindChange, onQueryChange, onLoadMore, onOpenDetail, onOpenBreakdown, title, allowedKinds, showRankings, hasMore,
}: {
  findings: FindingsReport | null;
  rankings: ReworkRankingsReport | null;
  kind: FindingKind | null;
  query: string;
  loading: boolean;
  error: string | null;
  onKindChange: (kind: FindingKind | null) => void;
  onQueryChange: (query: string) => void;
  onLoadMore: () => void;
  onOpenDetail: (kind: string, sessionId: string) => void;
  onOpenBreakdown?: (date: number) => void;
  title?: string;
  allowedKinds?: FindingKind[];
  showRankings?: boolean;
  hasMore?: boolean;
}) {
  const rows = findings?.rows ?? [];
  const sectionTitle = title ?? "学び";
  const permittedKinds = allowedKinds ?? Object.keys(KIND_LABELS) as FindingKind[];
  const options = KIND_OPTIONS.filter((option) => option.value === "all" || permittedKinds.includes(option.value));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Section title={sectionTitle}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <ButtonGroup options={options} value={kind ?? "all"} onChange={(value) => onKindChange(value === "all" ? null : value)} ariaLabel={sectionTitle} />
          <input aria-label="検索" type="search" value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="検索" style={{ height: 28, minWidth: 180, border: "1px solid var(--cmux-border)", borderRadius: 5, background: "var(--cmux-hover)", color: "var(--cmux-text)", padding: "0 8px", fontSize: "var(--cmux-font-size-xs)" }} />
        </div>
        {error ? <EmptyState kind="error" message={error} /> : loading && !findings ? <div style={{ marginTop: 12 }}><SkeletonBlock height={140} label="更新中…" /></div> : (
          <>{rows.length === 0 && !loading ? <div style={{ ...noteStyle, marginTop: 12 }}>この分類の記録はまだありません (要約が進むと増えます)</div> : <div style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 12 }}>
              {rows.map((row, index) => <div key={`${row.sessionKind}:${row.sessionId}:${index}`} style={{ textAlign: "left", border: "1px solid var(--cmux-border-hairline)", borderRadius: 6, background: "var(--cmux-hover)", color: "var(--cmux-text)", padding: "8px 10px" }}>
                <button type="button" onClick={() => onOpenDetail(row.sessionKind, row.sessionId)} style={{ width: "100%", textAlign: "left", border: 0, background: "transparent", color: "inherit", padding: 0, cursor: "pointer" }}>
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}><Chip tone="accent">{KIND_LABELS[row.kind]}</Chip><Chip>要約</Chip>{row.repeatCount >= 2 ? <Chip tone="warn">同じ罠 {row.repeatCount} 回目</Chip> : null}<span style={noteStyle}>{new Date(row.date).toLocaleDateString("ja-JP")} · {row.projectLabel ?? "—"}</span></div>
                <div style={{ marginTop: 5, fontSize: "var(--cmux-font-size-sm)" }}>{row.text}</div>
                </button>
                {row.kind === "gotcha" && row.repeatCount >= 2 && Number.isFinite(row.date) && row.date > 0 && onOpenBreakdown ? <button type="button" onClick={() => onOpenBreakdown(row.date)} style={{ ...subtleButtonStyle, marginTop: 8 }}>その日の内訳へ</button> : null}
              </div>)}
            </div>}
            {findings && (hasMore ?? rows.length < findings.total) ? <button type="button" onClick={onLoadMore} disabled={loading} style={{ ...subtleButtonStyle, alignSelf: "flex-start", marginTop: 10 }}>さらに読み込む</button> : null}
          </>
        )}
      </Section>
      {showRankings !== false ? <><Section title="失敗コマンド上位" actions={<Chip>数えた</Chip>}>
        <RankingTable headers={["コマンド", "実行", "失敗", "失敗率"]} rows={(rankings?.failedCommands ?? []).map((row) => [row.target ? `${row.name} ${row.target}` : row.name, String(row.executions), String(row.failures), `${(row.failureRate * 100).toFixed(0)}%`])} />
      </Section><Section title="書き直しファイル上位" actions={<Chip>数えた</Chip>}>
        <RankingTable headers={["ファイル", "編集回数", "セッション数"]} rows={(rankings?.rewrittenFiles ?? []).map((row) => [row.path, String(row.editCount), String(row.sessionCount)])} />
      </Section></> : null}
    </div>
  );
}

function RankingTable({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return <ScrollBox><table style={tableStyle}><thead><tr>{headers.map((header, index) => <th key={header} style={index === 0 ? thLeftStyle : thStyle}>{header}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={`${row[0]}:${index}`}>{row.map((value, cell) => <td key={cell} style={cell === 0 ? tdLeftStyle : tdStyle} title={value}>{value}</td>)}</tr>)}</tbody></table></ScrollBox>;
}
