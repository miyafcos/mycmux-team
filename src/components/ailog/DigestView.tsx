import { formatCount, formatDelta, formatUsd, type DigestReport, type SummarizeStatus } from "../../lib/ailog";
import { cardStyle, Chip, DeferredDetails, noteStyle, SkeletonBlock, subtleButtonStyle } from "./ui";

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
  aiDisabledReason,
  error,
  onRetry,
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
  /** Set when the AI setting is off; also used as each button's tooltip. */
  aiDisabledReason?: string;
  /** A saved-digest GET failed; retrying never starts LLM work. */
  error?: string | null;
  onRetry?: () => void;
}) {
  const aiOff = aiDisabledReason !== undefined;
  const content = report?.digest?.content;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ ...cardStyle, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button type="button" onClick={onPrevious} style={subtleButtonStyle}>‹</button>
          <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>{report?.date ?? ""}</span>
          <button type="button" onClick={onNext} style={subtleButtonStyle}>›</button>
        </div>
        <button type="button" onClick={onRegenerate} disabled={generating || aiOff} title={aiDisabledReason} style={{ ...subtleButtonStyle, opacity: generating || aiOff ? 0.5 : 1 }}>再生成</button>
      </div>

      {aiOff ? <div style={noteStyle}>{aiDisabledReason}</div> : null}

      {loading || generating ? <div style={noteStyle}>生成中…</div> : null}
      {!report && (loading || generating) ? <SkeletonBlock height={160} label="更新中…" /> : null}
      {summarizeStatus?.running ? <div style={noteStyle}>要約中 {summarizeStatus.sessionsDone.toLocaleString()} / {summarizeStatus.sessionsTotal.toLocaleString()}（残り {summarizeStatus.sessionsRemaining.toLocaleString()}）</div> : null}
      {error ? <div style={{ ...cardStyle, borderColor: "var(--cmux-usage-warn)" }}><div>読み込みに失敗しました: {error}</div>{onRetry ? <button type="button" onClick={onRetry} style={{ ...subtleButtonStyle, marginTop: 10 }}>再試行</button> : null}</div> : null}
      {summarizeError || report?.parseError ? <div style={{ ...cardStyle, borderColor: "var(--cmux-usage-warn)" }}>エラー: {summarizeError ?? report?.parseError}</div> : null}
      {!loading && !generating && !content ? <div style={cardStyle}>
        <div>{report?.reason ?? "この日の要約はまだありません。要約を実行すると表示されます。"}</div>
        {(summarizeStatus?.sessionsRemaining ?? 0) > 0 && onStartSummarize ? <button type="button" onClick={onStartSummarize} disabled={aiOff} title={aiDisabledReason} style={{ ...subtleButtonStyle, marginTop: 10, opacity: aiOff ? 0.5 : 1 }}>未要約 {summarizeStatus!.sessionsRemaining.toLocaleString()} 件 — 要約を実行</button> : null}
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
            <DeferredDetails summary="うまくいったこと">
              <ul style={{ margin: "8px 0 0", paddingLeft: 20 }}>
                {content.wins.map((win, index) => <li key={`${index}-${win}`}>{win}</li>)}
              </ul>
            </DeferredDetails>
          ) : null}

          {content.biggestRework.exists ? (
            <section style={{ ...cardStyle, borderColor: "var(--cmux-usage-warn)" }}>
              <h3 style={{ margin: 0, fontSize: "var(--cmux-font-size-sm)" }}>最大の手戻り</h3>
              <p style={{ margin: "8px 0 0", lineHeight: 1.6 }}>{content.biggestRework.text}</p>
            </section>
          ) : null}

          <DeferredDetails summary="得られたもの">
            <p style={{ margin: "8px 0 0", lineHeight: 1.6 }}>{content.valueNote}</p>
          </DeferredDetails>

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
