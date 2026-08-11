/**
 * One session, opened from the list.
 *
 * The read/write split prints the backend's own caveat verbatim: the ingest
 * side includes the conversation history and the system prompt replayed on
 * every turn, which is why it dwarfs the generated side. The character counts
 * are a separate, clearly-labelled estimate — they are not costs.
 */

import { useMemo } from "react";

import {
  formatCount,
  formatLocalDateTime,
  formatRatio,
  formatScore,
  formatTokens,
  formatUsd,
  kindLabel,
  workTagHint,
  workTagLabel,
  type SessionDetail,
  type TurnDetail,
} from "../../lib/ailog";
import { hashedColor } from "./palette";
import { Chip, ScrollBox, noteStyle, subtleButtonStyle, tableStyle, tdLeftStyle, tdStyle, thLeftStyle, thStyle } from "./ui";

/** Above this many turns the bars are grouped so the chart stays readable. */
const MAX_BARS = 240;

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
        model: turn.modelFamily ?? turn.model ?? "(unknown)",
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
      const key = turn.modelFamily ?? turn.model ?? "(unknown)";
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

export function SessionDetailView({ detail, onClose }: { detail: SessionDetail; onClose: () => void }) {
  const { bars, grouped } = useMemo(() => bucketTurns(detail.turns), [detail.turns]);
  const peak = bars.reduce((max, bar) => Math.max(max, bar.costUsd), 0);
  const models = useMemo(() => {
    const set = new Set(bars.map((bar) => bar.model));
    return [...set];
  }, [bars]);

  const chartWidth = 900;
  const chartHeight = 120;
  const barWidth = bars.length > 0 ? chartWidth / bars.length : 0;
  const breakdown = detail.costBreakdown;
  const chars = breakdown.ioChars;
  const charTotal = chars.read + chars.exec + chars.write + chars.fetch + chars.prompt + chars.other;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, overflowWrap: "anywhere" }}>
            {detail.aiTitle?.trim() || detail.session.title?.trim() || "（無題）"}
          </div>
          <div style={{ ...noteStyle, marginTop: 3 }}>
            {`${kindLabel(detail.session.kind)} · ${detail.session.primaryModel ?? "—"} · ${formatLocalDateTime(detail.session.startedAt)} 〜 ${formatLocalDateTime(detail.session.endedAt)}`}
          </div>
          <div style={{ ...noteStyle, marginTop: 2, overflowWrap: "anywhere" }}>{detail.cwd ?? "作業フォルダ不明"}</div>
          <div style={{ ...noteStyle, marginTop: 2, overflowWrap: "anywhere" }}>
            {`要約: ${detail.session.goalSummary?.trim() || detail.aiTitle?.trim() || detail.firstPrompt?.trim() || "（無題）"}`}
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
        <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 4 }}>ターン別コスト推移</div>
        {bars.length === 0 ? (
          <div style={noteStyle}>ターンの記録がありません。</div>
        ) : (
          <ScrollBox>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(420px, 1fr)" }}>
              <svg
                viewBox={`0 0 ${chartWidth} ${chartHeight}`}
                role="img"
                aria-label="ターンごとのコスト"
                style={{ width: "100%", minWidth: 0, height: chartHeight, display: "block" }}
              >
              {bars.map((bar, index) => {
                const height = peak > 0 ? (bar.costUsd / peak) * (chartHeight - 8) : 0;
                return (
                  <rect
                    key={`${bar.fromSeq}-${index}`}
                    x={index * barWidth}
                    y={chartHeight - height}
                    width={Math.max(1, barWidth - 0.6)}
                    height={height}
                    style={{ fill: hashedColor(bar.model) }}
                  >
                    <title>
                      {`${bar.fromSeq === bar.toSeq ? `ターン ${bar.fromSeq}` : `ターン ${bar.fromSeq}–${bar.toSeq}（${bar.turns} 件）`}\n${bar.model}\n${formatUsd(bar.costUsd)}`}
                    </title>
                  </rect>
                );
              })}
              </svg>
            </div>
          </ScrollBox>
        )}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4, ...noteStyle }}>
          {models.map((model) => (
            <span key={model} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: hashedColor(model) }} />
              {model}
            </span>
          ))}
          <span>{`最大 ${formatUsd(peak)} / ターン`}</span>
          {grouped ? <span>{`${formatCount(detail.turns.length)} ターンを ${formatCount(bars.length)} 本にまとめて表示しています`}</span> : null}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 4 }}>取り込み側（読み）</div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{formatUsd(breakdown.ingest.costUsd)}</div>
          <div style={noteStyle}>
            {`${formatTokens(breakdown.ingest.tokens)}（入力 ${formatTokens(breakdown.ingest.input)} / キャッシュ読み ${formatTokens(breakdown.ingest.cacheRead)} / キャッシュ書き ${formatTokens(breakdown.ingest.cacheWrite)}）`}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 4 }}>生成側（書き）</div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{formatUsd(breakdown.generate.costUsd)}</div>
          <div style={noteStyle}>
            {`${formatTokens(breakdown.generate.tokens)}（出力 ${formatTokens(breakdown.generate.output)} / 推論 ${formatTokens(breakdown.generate.reasoning)}）`}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 4 }}>取り込み側の割合</div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{formatRatio(breakdown.ingestRatio)}</div>
          <div style={noteStyle}>{`キャッシュヒット率 ${formatRatio(breakdown.cacheHitRate)}`}</div>
        </div>
      </div>
      <div style={noteStyle}>{breakdown.note}</div>

      <div>
        <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 4 }}>文字数の内訳（推定）</div>
        <div style={noteStyle}>
          {`読み ${formatCount(chars.read)} / 実行 ${formatCount(chars.exec)} / 書き ${formatCount(chars.write)} / 取得 ${formatCount(chars.fetch)} / 指示 ${formatCount(chars.prompt)} / その他 ${formatCount(chars.other)}（合計 ${formatCount(charTotal)} 文字）`}
        </div>
        <div style={noteStyle}>{`推定方法: ${chars.estimation}　読んだファイル ${formatCount(detail.costBreakdown.ioFiles.readFiles)} / 書いたファイル ${formatCount(detail.costBreakdown.ioFiles.writtenFiles)}`}</div>
        <div style={noteStyle}>これは文字数の推定であってコストではありません。</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 4 }}>ツール別</div>
          <ScrollBox maxHeight={200}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thLeftStyle}>ツール</th>
                  <th style={thStyle}>実行</th>
                  <th style={thStyle}>失敗</th>
                  <th style={thStyle}>失敗率</th>
                </tr>
              </thead>
              <tbody>
                {detail.tools.map((tool) => (
                  <tr key={tool.name}>
                    <td style={tdLeftStyle}>{tool.name}</td>
                    <td style={tdStyle}>{formatCount(tool.calls)}</td>
                    <td style={tdStyle}>{formatCount(tool.errors)}</td>
                    <td style={tdStyle}>{formatRatio(tool.calls > 0 ? tool.errors / tool.calls : 0)}</td>
                  </tr>
                ))}
                {detail.tools.length === 0 ? (
                  <tr>
                    <td style={tdLeftStyle} colSpan={4}>
                      ツールの実行記録がありません
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </ScrollBox>
        </div>

        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 4 }}>手戻り</div>
          <table style={tableStyle}>
            <tbody>
              <tr>
                <td style={tdLeftStyle}>スコア</td>
                <td style={tdStyle}>{formatScore(detail.rework.score)}</td>
              </tr>
              <tr>
                <td style={tdLeftStyle}>ツール失敗</td>
                <td style={tdStyle}>{`${formatCount(detail.rework.toolErrorCount)} / ${formatCount(detail.rework.toolCallCount)}（${formatRatio(detail.rework.toolErrorRate)}）`}</td>
              </tr>
              <tr>
                <td style={tdLeftStyle}>やり直し指示</td>
                <td style={tdStyle}>{formatCount(detail.rework.correctionHits)}</td>
              </tr>
              <tr>
                <td style={tdLeftStyle}>3 回以上編集したファイル</td>
                <td style={tdStyle}>{`${formatCount(detail.rework.churnFiles)}（最多 ${formatCount(detail.rework.maxFileEdits)} 回）`}</td>
              </tr>
              <tr>
                <td style={tdLeftStyle}>失敗後に再実行したコマンド</td>
                <td style={tdStyle}>{formatCount(detail.rework.retryBash)}</td>
              </tr>
              <tr>
                <td style={tdLeftStyle}>ツール実行のまま終了</td>
                <td style={tdStyle}>{detail.rework.abandoned ? "あり" : "なし"}</td>
              </tr>
            </tbody>
          </table>
          <div style={{ ...noteStyle, marginTop: 4 }}>{detail.rework.scoreNote}</div>
        </div>
      </div>

      <div>
        <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 4 }}>要約</div>
        {detail.summary ? (
          <div style={{ fontSize: 11, color: "var(--cmux-text-secondary)", lineHeight: 1.7, whiteSpace: "pre-wrap" }}>
            {[detail.summary.findings, detail.summary.reworkNote, detail.summary.costNote]
              .filter((value): value is string => Boolean(value))
              .join("\n")}
            <div style={{ ...noteStyle, marginTop: 4 }}>
              {`${formatLocalDateTime(detail.summary.createdAt)} · ${detail.summary.modelUsed ?? "モデル不明"}`}
            </div>
          </div>
        ) : (
          <div style={noteStyle}>未要約（要約機能は F3 で追加予定です）</div>
        )}
      </div>

      <div style={noteStyle}>{detail.costNote}</div>
    </div>
  );
}
