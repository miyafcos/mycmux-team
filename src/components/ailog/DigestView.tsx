import { formatCount, formatDelta, formatUsd, type DigestReport, type SummarizeStatus } from "../../lib/ailog";
import { cardStyle, Chip, noteStyle, subtleButtonStyle } from "./ui";

export function DigestView({
  report,
  loading,
  generating,
  onPrevious,
  onNext,
  onRegenerate,
  summarizeStatus,
  summarizeError,
  onStartSummarize,
}: {
  report: DigestReport | null;
  loading: boolean;
  generating: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onRegenerate: () => void;
  summarizeStatus?: SummarizeStatus | null;
  summarizeError?: string | null;
  onStartSummarize?: () => void;
}) {
  const content = report?.digest?.content;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ ...cardStyle, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button type="button" onClick={onPrevious} style={subtleButtonStyle}>‹</button>
          <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>{report?.date ?? ""}</span>
          <button type="button" onClick={onNext} style={subtleButtonStyle}>›</button>
        </div>
        <button type="button" onClick={onRegenerate} disabled={generating} style={{ ...subtleButtonStyle, opacity: generating ? 0.5 : 1 }}>再生成</button>
      </div>

      {loading || generating ? <div style={noteStyle}>生成中…</div> : null}
      {summarizeStatus?.running ? <div style={noteStyle}>要約中 {summarizeStatus.sessionsDone.toLocaleString()} / {summarizeStatus.sessionsTotal.toLocaleString()}（残り {summarizeStatus.sessionsRemaining.toLocaleString()}）</div> : null}
      {summarizeError || summarizeStatus?.lastError || report?.parseError ? <div style={{ ...cardStyle, borderColor: "var(--cmux-usage-warn)" }}>エラー: {summarizeError ?? summarizeStatus?.lastError ?? report?.parseError}</div> : null}
      {!loading && !generating && !content ? <div style={cardStyle}>
        <div>{report?.reason ?? "この日の要約はまだありません"}</div>
        {(summarizeStatus?.sessionsRemaining ?? 0) > 0 && onStartSummarize ? <button type="button" onClick={onStartSummarize} style={{ ...subtleButtonStyle, marginTop: 10 }}>未要約 {summarizeStatus!.sessionsRemaining.toLocaleString()} 件 — 要約を実行</button> : null}
      </div> : null}
      {content ? (
        <>
          <section style={cardStyle}>
            <h2 style={{ margin: 0, fontSize: "var(--cmux-font-size-md)", color: "var(--cmux-text)" }}>{content.headline}</h2>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 12 }}>
              <Chip>完遂 {formatCount(report.metrics.outcomes.done)}</Chip>
              <Chip>途中まで {formatCount(report.metrics.outcomes.partial)}</Chip>
              <Chip tone="warn">中断 {formatCount(report.metrics.outcomes.abandoned)}</Chip>
              <Chip>不明 {formatCount(report.metrics.outcomes.unclear)}</Chip>
            </div>
            <div style={{ ...noteStyle, display: "flex", gap: 14, flexWrap: "wrap", marginTop: 12 }}>
              <span>セッション {formatCount(report.metrics.sessions)}</span>
              <span>コスト相当 {formatUsd(report.metrics.costUsd)}</span>
              <span>前日比 {formatDelta(report.metrics.costPct)}</span>
            </div>
          </section>

          {content.wins.length ? (
            <section style={cardStyle}>
              <h3 style={{ margin: 0, fontSize: "var(--cmux-font-size-sm)" }}>うまくいったこと</h3>
              <ul style={{ margin: "8px 0 0", paddingLeft: 20 }}>
                {content.wins.map((win, index) => <li key={`${index}-${win}`}>{win}</li>)}
              </ul>
            </section>
          ) : null}

          {content.biggestRework.exists ? (
            <section style={{ ...cardStyle, borderColor: "var(--cmux-usage-warn)" }}>
              <h3 style={{ margin: 0, fontSize: "var(--cmux-font-size-sm)" }}>最大の手戻り</h3>
              <p style={{ margin: "8px 0 0", lineHeight: 1.6 }}>{content.biggestRework.text}</p>
            </section>
          ) : null}

          <section style={cardStyle}>
            <h3 style={{ margin: 0, fontSize: "var(--cmux-font-size-sm)" }}>得られたもの</h3>
            <p style={{ margin: "8px 0 0", lineHeight: 1.6 }}>{content.valueNote}</p>
          </section>

          <section style={{ ...cardStyle, borderColor: "var(--cmux-accent)", background: "color-mix(in srgb, var(--cmux-accent) 8%, var(--cmux-surface))" }}>
            <h3 style={{ margin: 0, fontSize: "var(--cmux-font-size-sm)" }}>今日の提案</h3>
            <p style={{ margin: "8px 0 0", lineHeight: 1.6 }}>{content.suggestion}</p>
          </section>

          {content.confidence === "low" ? <div style={noteStyle}>低確度 (素材が少ない日)</div> : null}
        </>
      ) : null}
    </div>
  );
}
