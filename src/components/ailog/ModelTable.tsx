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
import { ButtonGroup, Chip, ScrollBox, ShareBar, noteStyle, tableStyle, tdLeftStyle, tdStyle, thLeftStyle, thStyle } from "./ui";

export function ModelTable({
  report,
  granularity,
  onGranularity,
  excludeSynthetic,
  selection,
  onSelect,
}: {
  report: ModelsReport;
  granularity: "family" | "raw";
  onGranularity: (value: "family" | "raw") => void;
  excludeSynthetic: boolean;
  selection: AilogSelection | null;
  onSelect: (selection: AilogSelection | null) => void;
}) {
  const hidden = report.rows.filter((row) => row.model === SYNTHETIC_MODEL || row.family === SYNTHETIC_MODEL);
  const rows = excludeSynthetic ? report.rows.filter((row) => !hidden.includes(row)) : report.rows;
  const sessionSum = rows.reduce((sum, row) => sum + row.sessions, 0);
  const hiddenCost = hidden.reduce((sum, row) => sum + row.costUsd, 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-text-tertiary)" }}>粒度</span>
        <ButtonGroup
          ariaLabel="モデルの粒度"
          value={granularity}
          onChange={onGranularity}
          options={[
            { value: "family" as const, label: "ファミリー", title: "opus-5 のように束ねる" },
            { value: "raw" as const, label: "生のモデル名", title: "terra / sol などの派生も分ける" },
          ]}
        />
      </div>

      <ScrollBox maxHeight={340}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thLeftStyle}>モデル</th>
              <th style={thStyle}>セッション</th>
              <th style={thStyle}>ターン</th>
              <th style={thStyle}>コスト相当</th>
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
                      {row.priced ? null : <Chip tone="warn" title="単価表に無いモデル">単価未設定 — $0 計上</Chip>}
                    </span>
                  </td>
                  <td style={tdStyle}>{formatCount(row.sessions)}</td>
                  <td style={tdStyle}>{formatCount(row.turns)}</td>
                  <td style={tdStyle}>{formatUsd(row.costUsd)}</td>
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
