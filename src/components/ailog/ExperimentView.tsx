import {
  formatCount,
  formatPct,
  formatScore,
  formatUsd,
  type EfficiencyReport,
  type EfficiencyRow,
  type QuantileRow,
  type RuleCheckFinding,
  type RuleCheckReport,
} from "../../lib/ailog";
import { EmptyState, noteStyle, ScrollBox, SkeletonBlock, tableStyle, tdLeftStyle, tdStyle, thLeftStyle, thStyle, Section } from "./ui";

const insufficient = "データ不足 (比較対象が揃っていません)";

// Backend group keys are API identifiers; the screen speaks Japanese.
const rowKeyLabels: Record<string, string> = {
  main: "メイン",
  subagent: "サブエージェント",
  compacted: "compact あり",
  "not-compacted": "compact なし",
  char_count_only: "文字数のみ",
};
const rowKeyLabel = (key: string) => rowKeyLabels[key] ?? key;

function EfficiencyCard({ title, rows, note }: { title: string; rows: EfficiencyRow[]; note: string }) {
  return (
    <Section title={title}>
      {rows.length <= 1 ? <div style={noteStyle}>{insufficient}</div> : (
        <ScrollBox>
          <table style={tableStyle}>
            <thead><tr><th style={thLeftStyle}>—</th><th style={thStyle}>セッション</th><th style={thStyle}>平均コスト相当</th><th style={thStyle}>平均手戻り</th><th style={thStyle}>キャッシュ率</th><th style={thStyle}>出力密度</th><th style={thStyle}>中断率</th></tr></thead>
            <tbody>{rows.map((row) => <tr key={row.key}><td style={tdLeftStyle}>{rowKeyLabel(row.key)}</td><td style={tdStyle}>{formatCount(row.sessions)}</td><td style={tdStyle}>{formatUsd(row.avgSessionCost)}</td><td style={tdStyle}>{formatScore(row.avgRework)}</td><td style={tdStyle}>{formatPct(row.cacheHitRate * 100)}</td><td style={tdStyle}>{formatScore(row.outputDensity)}</td><td style={tdStyle}>{formatPct(row.abandonedRate * 100)}</td></tr>)}</tbody>
          </table>
        </ScrollBox>
      )}
      <div style={{ ...noteStyle, marginTop: 8 }}>{note}</div>
    </Section>
  );
}

function QuantileCard({ rows, note }: { rows: QuantileRow[]; note: string }) {
  return (
    <Section title="セッションの長さ">
      {rows.length <= 1 ? <div style={noteStyle}>{insufficient}</div> : (
        <ScrollBox>
          <table style={tableStyle}>
            <thead><tr><th style={thLeftStyle}>—</th><th style={thStyle}>ターン数</th><th style={thStyle}>セッション</th><th style={thStyle}>平均コスト相当</th><th style={thStyle}>平均手戻り</th></tr></thead>
            <tbody>{rows.map((row) => <tr key={row.quantile}><td style={tdLeftStyle}>{row.quantile}</td><td style={tdStyle}>{`${formatCount(row.minTurns)}–${formatCount(row.maxTurns)}`}</td><td style={tdStyle}>{formatCount(row.sessions)}</td><td style={tdStyle}>{formatUsd(row.avgCost)}</td><td style={tdStyle}>{formatScore(row.avgRework)}</td></tr>)}</tbody>
          </table>
        </ScrollBox>
      )}
      <div style={{ ...noteStyle, marginTop: 8 }}>{note}</div>
    </Section>
  );
}

function RuleList({ title, finding, onOpenDetail }: { title: string; finding: RuleCheckFinding; onOpenDetail: (kind: string, sessionId: string) => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ fontWeight: 700 }}>{`${title}: ${formatCount(finding.count)} 件`}</div>
      {finding.count === 0 ? <div style={noteStyle}>該当するセッションがありません (期間を広げると増えることがあります)</div> : finding.sessions.map((session) => (
        <button key={`${session.kind}:${session.sessionId}`} type="button" onClick={() => onOpenDetail(session.kind, session.sessionId)} style={{ textAlign: "left", border: "1px solid var(--cmux-border-hairline)", background: "var(--cmux-hover)", color: "var(--cmux-text)", borderRadius: 5, padding: "5px 8px", cursor: "pointer" }}>
          {session.title ?? session.sessionId} · {formatUsd(session.costUsd)}
        </button>
      ))}
    </div>
  );
}

export function ExperimentView({ report, rules, loading, error, onOpenDetail }: { report: EfficiencyReport | null; rules: RuleCheckReport | null; loading: boolean; error: string | null; onOpenDetail: (kind: string, sessionId: string) => void }) {
  // Each state says which one it is. Returning null for "no report yet" used to
  // render a blank panel with no loading indicator and no error — indis­tin­guish­able
  // from a tab that had silently failed. A half-filled custom range reaches
  // here that way, because the refresh short-circuits before it starts.
  if (loading) return <SkeletonBlock height={140} label="比較を読み込み中" />;
  if (error) return <EmptyState kind="error" message={error} />;
  if (!report || !rules) return <EmptyState kind="no-data" message="期間を2つの日付で指定すると反映されます。" />;
  return <>
    <EfficiencyCard title="effort" rows={report.byEffort} note={report.interpretationNote} />
    <EfficiencyCard title="サブエージェント" rows={report.bySubagent} note={report.interpretationNote} />
    <EfficiencyCard title="compact" rows={report.byCompaction} note={report.interpretationNote} />
    <QuantileCard rows={report.turnQuantiles} note={report.interpretationNote} />
    <Section title="ルール通信簿">
      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
        <RuleList title="巨大コンテキスト (300k超)" finding={rules.largeContext} onOpenDetail={onOpenDetail} />
        <RuleList title="compact 発生" finding={rules.compacted} onOpenDetail={onOpenDetail} />
      </div>
    </Section>
  </>;
}
