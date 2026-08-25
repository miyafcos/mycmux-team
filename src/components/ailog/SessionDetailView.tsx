/**
 * One session, opened from the list.
 *
 * The read/write split prints the backend's own caveat verbatim: the ingest
 * side includes the conversation history and the system prompt replayed on
 * every turn, which is why it dwarfs the generated side. The character counts
 * are a separate, clearly-labelled estimate — they are not costs.
 */

import { useMemo, useState } from "react";

import {
  formatCount,
  formatLocalDateTime,
  formatRatio,
  formatScore,
  formatMoney,
  kindLabel,
  workTagHint,
  workTagLabel,
  type SessionDetail,
  type TurnDetail,
  type TranscriptReport,
} from "../../lib/ailog";
import { modelPaint } from "./modelColors";
import { ChartHatchDefs, Chip, Num, noteStyle, paintFill, paintSwatchBackground, subtleButtonStyle, tableStyle, tdLeftStyle, tdStyle, thLeftStyle, thStyle } from "./ui";

/** Above this many turns the bars are grouped so the chart stays readable. */
const MAX_BARS = 240;

const OUTCOME_LABELS: Record<string, string> = { done: "完遂", partial: "途中まで", abandoned: "中断", unclear: "不明" };
const FINDING_LABELS: Record<string, string> = { cause: "原因", constraint: "制約", gotcha: "ハマり", decision: "決定", verified: "検証済" };
const REWORK_LABELS: Record<string, string> = { "spec-ambiguity": "仕様曖昧", "wrong-assumption": "思い込み", "env-issue": "環境問題", "tool-failure": "ツール失敗", "scope-creep": "スコープ拡大" };

function modelDisplayName(model: string): string {
  return model === "(unknown)" ? "ログにモデル名なし" : model;
}

export function summaryFindings(value: string | null): Array<{ text: string; kind: string }> {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is { text: string; kind: string } => Boolean(entry && typeof entry === "object" && typeof (entry as { text?: unknown }).text === "string" && typeof (entry as { kind?: unknown }).kind === "string"));
  } catch { return []; }
}

export interface TurnBar {
  fromSeq: number;
  toSeq: number;
  costUsd: number;
  model: string;
  turns: number;
}

export function bucketTurns(turns: TurnDetail[], maxBars = MAX_BARS): { bars: TurnBar[]; grouped: boolean } {
  if (turns.length === 0) return { bars: [], grouped: false };
  if (turns.length <= maxBars) {
    return {
      bars: turns.map((turn) => ({
        fromSeq: turn.seq,
        toSeq: turn.seq,
        costUsd: turn.costUsd,
        model: turn.model ?? turn.modelFamily ?? "(unknown)",
        turns: 1,
      })),
      grouped: false,
    };
  }
  const size = Math.ceil(turns.length / maxBars);
  const bars: TurnBar[] = [];
  for (let index = 0; index < turns.length; index += size) {
    const slice = turns.slice(index, index + size);
    // The group is coloured by the model that cost the most inside it.
    const perModel = new Map<string, number>();
    for (const turn of slice) {
      const key = turn.model ?? turn.modelFamily ?? "(unknown)";
      perModel.set(key, (perModel.get(key) ?? 0) + turn.costUsd);
    }
    const model = [...perModel.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "(unknown)";
    bars.push({
      fromSeq: slice[0].seq,
      toSeq: slice[slice.length - 1].seq,
      costUsd: slice.reduce((sum, turn) => sum + turn.costUsd, 0),
      model,
      turns: slice.length,
    });
  }
  return { bars, grouped: true };
}

export function SessionDetailView({ detail, transcript, transcriptLoading, transcriptError, sessionSummarizing, sessionSummarizeError, onSummarize, onLoadTranscript, onClose, aiDisabledReason }: { detail: SessionDetail; transcript: TranscriptReport | null; transcriptLoading: boolean; transcriptError: string | null; sessionSummarizing: boolean; sessionSummarizeError: string | null; onSummarize: () => void; onLoadTranscript: () => void; onClose: () => void; aiDisabledReason?: string }) {
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const { bars, grouped } = useMemo(() => bucketTurns(detail.turns), [detail.turns]);
  const peak = bars.reduce((max, bar) => Math.max(max, bar.costUsd), 0);
  const models = useMemo(() => {
    const set = new Set(bars.map((bar) => bar.model));
    return [...set];
  }, [bars]);
  const paints = models.map((model) => modelPaint(model));

  const chartWidth = 900;
  const chartHeight = 120;
  const axisWidth = 58;
  const plotHeight = chartHeight - 8;
  const barWidth = bars.length > 0 ? (chartWidth - axisWidth) / bars.length : 0;
  const ticks = peak > 0 ? [0, peak] : [0];
  const breakdown = detail.costBreakdown;
  const chars = breakdown.ioChars;
  const charTotal = chars.read + chars.exec + chars.write + chars.fetch + chars.prompt + chars.other;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: "var(--cmux-font-size-md)", fontWeight: 700, overflowWrap: "anywhere", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
            {detail.session.title?.trim() || "（無題）"}
          </div>
          <div style={{ ...noteStyle, marginTop: 3 }}>
            {`${kindLabel(detail.session.kind)} · ${detail.session.primaryModel ?? "ログにモデル名なし"} · ${formatLocalDateTime(detail.session.startedAt)} 〜 ${formatLocalDateTime(detail.session.endedAt)}`}
          </div>
          <div style={{ ...noteStyle, marginTop: 2, overflowWrap: "anywhere" }}>{detail.cwd ?? "作業フォルダ不明"}</div>
          <div style={{ ...noteStyle, marginTop: 2, overflowWrap: "anywhere" }}>
            {`要約: ${detail.session.goalSummary?.trim() || "未要約"}`}
            {detail.session.goalCluster?.trim() ? ` · トピック: ${detail.session.goalCluster.trim()}` : ""}
          </div>
          <div style={{ display: "flex", gap: 4, marginTop: 5, flexWrap: "wrap" }}>
            {detail.session.workTags.map((tag) => (
              <Chip key={tag} title={workTagHint(tag)}>
                {workTagLabel(tag)}
              </Chip>
            ))}
            {detail.agentNames.map((agent) => (
              <Chip key={agent} tone="accent" title="このセッションで使われたサブエージェント">
                {agent}
              </Chip>
            ))}
          </div>
        </div>
        <button type="button" onClick={onClose} style={subtleButtonStyle}>
          詳細を閉じる
        </button>
      </div>

      <div>
        <div style={{ fontSize: "var(--cmux-font-size-xs)", fontWeight: 700, marginBottom: 4 }}>ターン別コスト相当推移</div>
        {bars.length === 0 ? (
          <div style={noteStyle}>ターンの記録がありません。再インデックスすると取り込まれることがあります。</div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)" }}>
              <svg
                viewBox={`0 0 ${chartWidth} ${chartHeight}`}
                role="img"
                aria-label="ターンごとのコスト相当"
                style={{ width: "100%", minWidth: 0, height: chartHeight, display: "block" }}
              >
              <ChartHatchDefs paints={paints} />
              {ticks.map((tick) => {
                const y = peak > 0 ? chartHeight - (tick / peak) * plotHeight : chartHeight;
                return <g key={tick} pointerEvents="none"><line x1={axisWidth} x2={chartWidth} y1={y} y2={y} stroke="var(--cmux-border-hairline)" /><text x={axisWidth - 4} y={y} textAnchor="end" dominantBaseline="middle" fill="var(--cmux-text-tertiary)" fontSize="var(--cmux-font-size-xs)">{formatMoney(tick)}</text></g>;
              })}
              {bars.map((bar, index) => {
                const height = peak > 0 ? (bar.costUsd / peak) * plotHeight : 0;
                return (
                  <rect
                    key={`${bar.fromSeq}-${index}`}
                    x={axisWidth + index * barWidth}
                    y={chartHeight - height}
                    width={Math.max(1, barWidth - 0.6)}
                    height={height}
                    style={{ fill: paintFill(modelPaint(bar.model)) }}
                  >
                    <title>
                      {`${bar.fromSeq === bar.toSeq ? `ターン ${bar.fromSeq}` : `ターン ${bar.fromSeq}–${bar.toSeq}（${bar.turns} 件）`}\n${modelDisplayName(bar.model)}\n${formatMoney(bar.costUsd)}`}
                    </title>
                  </rect>
                );
              })}
              </svg>
            </div>
        )}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4, ...noteStyle }}>
          {models.map((model) => (
            <span key={model} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: paintSwatchBackground(modelPaint(model)) }} />
              {modelDisplayName(model)}
            </span>
          ))}
          <span>{`最大 ${formatMoney(peak)} / ${grouped ? "表示グループ" : "ターン"}`}</span>
          {grouped ? <span>{`${formatCount(detail.turns.length)} ターンを ${formatCount(bars.length)} 本にまとめて表示しています`}</span> : null}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))", gap: 10 }}>
        <div>
          <div style={{ fontSize: "var(--cmux-font-size-xs)", fontWeight: 700, marginBottom: 4 }}>取り込み側（読み）</div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{formatMoney(breakdown.ingest.costUsd)}</div>
          <div style={noteStyle}>
            <Num value={breakdown.ingest.tokens} kind="tokens" />
            （入力 <Num value={breakdown.ingest.input} kind="tokens" /> / キャッシュ読み <Num value={breakdown.ingest.cacheRead} kind="tokens" /> / キャッシュ書き <Num value={breakdown.ingest.cacheWrite} kind="tokens" />）
          </div>
        </div>
        <div>
          <div style={{ fontSize: "var(--cmux-font-size-xs)", fontWeight: 700, marginBottom: 4 }}>生成側（書き）</div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{formatMoney(breakdown.generate.costUsd)}</div>
          <div style={noteStyle}>
            <Num value={breakdown.generate.tokens} kind="tokens" />
            （出力 <Num value={breakdown.generate.output} kind="tokens" /> / 推論 <Num value={breakdown.generate.reasoning} kind="tokens" />）
          </div>
        </div>
        <div>
          <div style={{ fontSize: "var(--cmux-font-size-xs)", fontWeight: 700, marginBottom: 4 }}>取り込み側の割合</div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{formatRatio(breakdown.ingestRatio)}</div>
          <div style={noteStyle}>{`キャッシュ率 ${formatRatio(breakdown.cacheHitRate)}`}</div>
        </div>
      </div>
      <div style={noteStyle}>{breakdown.note}</div>

      <div>
        <div style={{ fontSize: "var(--cmux-font-size-xs)", fontWeight: 700, marginBottom: 4 }}>文字数の内訳（推定）</div>
        <div style={noteStyle}>
          {`読み ${formatCount(chars.read)} / 実行 ${formatCount(chars.exec)} / 書き ${formatCount(chars.write)} / 取得 ${formatCount(chars.fetch)} / 指示 ${formatCount(chars.prompt)} / その他 ${formatCount(chars.other)}（合計 ${formatCount(charTotal)} 文字）`}
        </div>
        <div style={noteStyle}>{`推定方法: ${chars.estimation === "char_count_only" ? "文字数のみ" : chars.estimation}　読んだファイル ${formatCount(detail.costBreakdown.ioFiles.readFiles)} / 書いたファイル ${formatCount(detail.costBreakdown.ioFiles.writtenFiles)}`}</div>
        <div style={noteStyle}>これは文字数の推定であってコスト相当ではありません。</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))", gap: 12 }}>
        <div style={{ minWidth: 0, overflowX: "auto" }} role="region" aria-label="ツール別の実行結果" tabIndex={0}>
          <div style={{ fontSize: "var(--cmux-font-size-xs)", fontWeight: 700, marginBottom: 4 }}>ツール別</div>
          <table style={{ ...tableStyle, minWidth: 420 }}>
              <caption style={{ ...noteStyle, textAlign: "left", paddingBottom: 4 }}>ツール別の実行・失敗件数</caption>
              <colgroup>
                <col style={{ width: "40%" }} />
                <col style={{ width: "20%" }} />
                <col style={{ width: "20%" }} />
                <col style={{ width: "20%" }} />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col" style={thLeftStyle}>ツール</th>
                  <th scope="col" style={thStyle}>実行</th>
                  <th scope="col" style={thStyle}>失敗</th>
                  <th scope="col" style={thStyle}>失敗率</th>
                </tr>
              </thead>
              <tbody>
                {detail.tools.map((tool) => (
                  <tr key={tool.name}>
                    <th scope="row" style={{ ...tdLeftStyle, fontWeight: 400 }}>{tool.name}</th>
                    <td style={tdStyle}>{formatCount(tool.calls)}</td>
                    <td style={tdStyle}>{formatCount(tool.errors)}</td>
                    <td style={tdStyle}>{formatRatio(tool.calls > 0 ? tool.errors / tool.calls : 0)}</td>
                  </tr>
                ))}
                {detail.tools.length === 0 ? (
                  <tr>
                    <td style={tdLeftStyle} colSpan={4}>
                      ツールの実行記録がありません (このセッションではツールが使われていません)
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
        </div>

        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: "var(--cmux-font-size-xs)", fontWeight: 700, marginBottom: 4 }}>手戻り</div>
          <table style={tableStyle}>
            <caption style={{ ...noteStyle, textAlign: "left", paddingBottom: 4 }}>手戻り兆候の機械指標</caption>
            <colgroup>
              <col style={{ width: "40%" }} />
              <col style={{ width: "60%" }} />
            </colgroup>
            <tbody>
              <tr>
                <th scope="row" style={{ ...tdLeftStyle, fontWeight: 400 }}>スコア</th>
                <td style={tdStyle}>{formatScore(detail.rework.score)}</td>
              </tr>
              <tr>
                <th scope="row" style={{ ...tdLeftStyle, fontWeight: 400 }}>ツール失敗</th>
                <td style={tdStyle}>{`${formatCount(detail.rework.toolErrorCount)} / ${formatCount(detail.rework.toolCallCount)}（${formatRatio(detail.rework.toolErrorRate)}）`}</td>
              </tr>
              <tr>
                <th scope="row" style={{ ...tdLeftStyle, fontWeight: 400 }}>修正・不満らしき発話</th>
                <td style={tdStyle}>{formatCount(detail.rework.correctionHits)}</td>
              </tr>
              <tr>
                <th scope="row" style={{ ...tdLeftStyle, fontWeight: 400 }}>3 回以上編集したファイル</th>
                <td style={tdStyle}>{`${formatCount(detail.rework.churnFiles)}（最多 ${formatCount(detail.rework.maxFileEdits)} 回）`}</td>
              </tr>
              <tr>
                <th scope="row" style={{ ...tdLeftStyle, fontWeight: 400 }}>失敗後に再実行したコマンド</th>
                <td style={tdStyle}>{formatCount(detail.rework.retryBash)}</td>
              </tr>
              <tr>
                <th scope="row" style={{ ...tdLeftStyle, fontWeight: 400 }}>ツール実行のまま終了</th>
                <td style={tdStyle}>{detail.rework.abandoned ? "あり" : "なし"}</td>
              </tr>
            </tbody>
          </table>
          <div style={{ ...noteStyle, marginTop: 4 }}>0〜100の機械指標です。セッション間の比較用で、品質の絶対評価ではありません。</div>
        </div>
      </div>

      <div>
        <div style={{ fontSize: "var(--cmux-font-size-xs)", fontWeight: 700, marginBottom: 4 }}>要約</div>
        {detail.summary ? (
          <div style={{ fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-text-secondary)", lineHeight: 1.7, whiteSpace: "pre-wrap" }}>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 4 }}>
              {detail.summary.outcome && OUTCOME_LABELS[detail.summary.outcome] ? <Chip>{OUTCOME_LABELS[detail.summary.outcome]}</Chip> : null}
              {detail.summary.confidence === "low" ? <Chip tone="warn">低確度</Chip> : null}
            </div>
            {summaryFindings(detail.summary.findings).map((finding, index) => (
              <div key={`${finding.kind}-${index}`}><span style={{ fontWeight: 700 }}>{FINDING_LABELS[finding.kind] ?? finding.kind}</span>{` ${finding.text}`}</div>
            ))}
            {detail.summary.reworkNote ? (() => {
              let cause = detail.summary.reworkNote;
              try { const value: unknown = JSON.parse(cause); if (value && typeof value === "object" && typeof (value as { cause?: unknown }).cause === "string") cause = (value as { cause: string }).cause; } catch { /* legacy text remains readable */ }
              const category = detail.summary.reworkCategory ? REWORK_LABELS[detail.summary.reworkCategory] : undefined;
              return cause ? <div>{category ? `${category} ${cause}` : cause}</div> : null;
            })() : null}
            {detail.summary.costNote ? <div>{detail.summary.costNote}</div> : null}
            <div style={{ ...noteStyle, marginTop: 4 }}>
              {`${formatLocalDateTime(detail.summary.createdAt)} · ${detail.summary.modelUsed ?? "ログにモデル名なし"}`}
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <Chip tone="warn">未要約</Chip>
            <button type="button" onClick={onSummarize} disabled={sessionSummarizing || aiDisabledReason !== undefined} title={aiDisabledReason} style={{ ...subtleButtonStyle, opacity: sessionSummarizing || aiDisabledReason !== undefined ? 0.6 : 1 }}>
              {sessionSummarizing ? "要約中…" : "このセッションを要約する"}
            </button>
            {sessionSummarizeError ? <span role="alert" style={{ ...noteStyle, color: "var(--cmux-red)" }}>{sessionSummarizeError}</span> : null}
          </div>
        )}
      </div>

      <details
        onToggle={(event) => {
          if (event.currentTarget.open && !transcript && !transcriptLoading) onLoadTranscript();
        }}
        style={{ border: "1px solid var(--cmux-border)", borderRadius: 6, padding: "6px 8px" }}
      >
        <summary style={{ cursor: "pointer", fontSize: "var(--cmux-font-size-xs)", fontWeight: 700 }}>{transcript ? "会話" : "会話を読み込む"}</summary>
        <div style={{ marginTop: 8 }}>
          {transcriptLoading ? <div style={noteStyle}>会話を読み込み中…</div> : null}
          {transcriptError ? <div role="alert" style={{ ...noteStyle, color: "var(--cmux-red)" }}>会話を読み込めませんでした。<button type="button" onClick={onLoadTranscript} style={{ ...subtleButtonStyle, marginLeft: 6 }}>再試行</button><details><summary>技術情報</summary>{transcriptError}</details></div> : null}
          {transcript ? <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {transcript.messages.length === 0 ? <div style={noteStyle}>このログには表示できる会話がありません。</div> : null}
            {transcript.messages.map((message, index) => message.role === "tool" ? (
              <details key={index} style={{ ...noteStyle, border: "1px solid var(--cmux-border)", borderRadius: 4, padding: "4px 6px" }}><summary>{`${message.toolName ?? "tool"}${message.toolTarget ? ` · ${message.toolTarget}` : ""}`}</summary>{message.text ? <pre style={{ margin: "6px 0 0", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "var(--cmux-font-mono, monospace)" }}>{message.text}</pre> : null}</details>
            ) : <div key={index} style={{ borderLeft: `3px solid ${message.role === "user" ? "var(--cmux-accent)" : "var(--cmux-border)"}`, paddingLeft: 8 }}><div style={{ ...noteStyle, fontWeight: 700 }}>{message.role === "user" ? "依頼" : "応答"}</div><div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.55, ...(expanded.has(index) ? {} : { display: "-webkit-box", WebkitLineClamp: 8, WebkitBoxOrient: "vertical", overflow: "hidden" }) }}>{message.text}</div>{message.text.split("\n").length > 8 ? <button type="button" style={subtleButtonStyle} onClick={() => setExpanded((old) => { const next = new Set(old); if (next.has(index)) next.delete(index); else next.add(index); return next; })}>{expanded.has(index) ? "折りたたむ" : "展開"}</button> : null}</div>)}
            {transcript.truncated ? <div style={noteStyle}>{`表示上限のため ${transcript.omittedCount} 件を省略しています`}</div> : null}
          </div> : null}
        </div>
      </details>

      <div style={noteStyle}>{detail.costNote}</div>
    </div>
  );
}
