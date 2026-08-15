/**
 * Per-model table.
 *
 * Two facts the table states rather than smooths over: a session that switched
 * models is counted under each of them (so the session column sums above the
 * total), and a model with no price entry is billed at $0 and carries a badge
 * saying exactly that.
 */

import {
  SYNTHETIC_MODEL,
  formatCount,
  formatLocalDateTime,
  formatPct,
  formatRatio,
  formatScore,
  formatUsd,
  type ModelsReport,
} from "../../lib/ailog";
import type { AilogSelection } from "../../stores/ailogStore";
import { ScrollBox, ShareBar, noteStyle, tableStyle, tdLeftStyle, tdStyle, thLeftStyle, thStyle } from "./ui";

function costCell(modelClass: ModelsReport["rows"][number]["modelClass"], costUsd: number) {
  if (modelClass === "unknown") return { value: "—", title: "単価未公表のため除外" };
  if (modelClass === "local") return { value: formatUsd(0), title: "ローカル実行 — 費用なし" };
  if (modelClass === "flat") return { value: formatUsd(0), title: "定額プラン — 従量費用なし" };
  return { value: formatUsd(costUsd), title: undefined };
}

export function ModelTable({
  report,
  excludeSynthetic,
  selection,
  onSelect,
}: {
  report: ModelsReport;
  excludeSynthetic: boolean;
  selection: AilogSelection | null;
  onSelect: (selection: AilogSelection | null) => void;
}) {
  const hidden = report.rows.filter((row) => row.model === SYNTHETIC_MODEL || row.family === SYNTHETIC_MODEL);
  const rows = excludeSynthetic ? report.rows.filter((row) => !hidden.includes(row)) : report.rows;
  const sessionSum = rows.reduce((sum, row) => sum + row.sessions, 0);
  const hiddenCost = hidden.reduce((sum, row) => sum + row.costUsd, 0);
  const costLabel = report.priceCoverage.coveredTokenRatio < 1
    ? `コスト相当 (単価既知の ${Math.round(report.priceCoverage.coveredTokenRatio * 100)}% 分)`
    : "コスト相当";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
      {selection?.type === "model" ? <button type="button" onClick={() => onSelect(null)} title="絞り込みを解除します" style={clearFilterStyle}>{`絞り込み中: ${selection.label} ×`}</button> : null}

      <ScrollBox maxHeight={340}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thLeftStyle}>モデル</th>
              <th style={thStyle}>セッション</th>
              <th style={thStyle}>ターン</th>
              <th style={thStyle}>{costLabel}</th>
              <th style={thStyle}>シェア</th>
              <th style={thStyle} title="プロンプト・キャッシュ読み書きなど入力側">取り込み側</th>
              <th style={thStyle} title="出力・推論トークンなど生成側">生成側</th>
              <th style={thStyle}>キャッシュ率</th>
              <th style={thStyle} title="1 ターンあたりの出力トークン">出力密度</th>
              <th style={thStyle}>平均手戻り</th>
              <th style={thStyle}>ツール失敗率</th>
              <th style={thStyle} title="ツール実行のまま終わったセッションの割合">中断率</th>
              <th style={thStyle}>初回使用</th>
              <th style={thStyle}>最終使用</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const selected = selection?.type === "model" && selection.key === row.model;
              const cost = costCell(row.modelClass, row.costUsd);
              return (
                <tr
                  key={row.model}
                  aria-selected={selected}
                  style={{ background: selected ? "var(--cmux-selected)" : undefined, cursor: "pointer" }}
                  onClick={() =>
                    onSelect(selected ? null : { type: "model", key: row.model, label: row.model })
                  }
                >
                  <td style={tdLeftStyle} title={row.model}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                      {row.model}
                    </span>
                  </td>
                  <td style={tdStyle}>{formatCount(row.sessions)}</td>
                  <td style={tdStyle}>{formatCount(row.turns)}</td>
                  <td style={tdStyle} title={cost.title}>{cost.value}</td>
                  <td style={tdStyle}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                      <ShareBar pct={row.sharePct} />
                      {formatPct(row.sharePct)}
                    </span>
                  </td>
                  <td style={tdStyle}>{formatUsd(row.ingestCostUsd)}</td>
                  <td style={tdStyle}>{formatUsd(row.generateCostUsd)}</td>
                  <td style={tdStyle}>{formatRatio(row.cacheHitRate)}</td>
                  <td style={tdStyle}>{formatCount(row.outputDensity)}</td>
                  <td style={tdStyle}>{formatScore(row.avgRework)}</td>
                  <td style={tdStyle}>{formatRatio(row.toolErrorRate)}</td>
                  <td style={tdStyle}>{formatRatio(row.abandonedRate)}</td>
                  <td style={tdStyle}>{formatLocalDateTime(row.firstUsedAt)}</td>
                  <td style={tdStyle}>{formatLocalDateTime(row.lastUsedAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </ScrollBox>

      <div style={{ ...noteStyle, display: "flex", flexDirection: "column", gap: 2 }}>
        <div>
          {`モデル別セッション数の合計 ${formatCount(sessionSum)} は総セッション数 ${formatCount(report.totalSessions)} を超えます（1 セッションで複数モデルを使うため）。モデルを切り替えたセッション ${formatCount(report.mixedSessions)} 件。`}
        </div>
        {excludeSynthetic && hidden.length > 0 ? (
          <div>{`<synthetic> の ${formatCount(hidden.length)} 行（${formatUsd(hiddenCost)}）を除外中です。`}</div>
        ) : null}
        <div>行をクリックするとそのモデルで全体を絞り込みます。</div>
      </div>
    </div>
  );
}

const clearFilterStyle = {
  alignSelf: "flex-start",
  border: "1px solid var(--cmux-accent)",
  borderRadius: 999,
  background: "var(--cmux-hover)",
  color: "var(--cmux-accent)",
  padding: "2px 9px",
  fontSize: "var(--cmux-font-size-xs)",
  cursor: "pointer",
};
