/**
 * Header row: range picker, re-index control, index freshness and the cost
 * caveat. The caveat is printed verbatim from the backend so the wording can
 * never drift from what the numbers actually mean.
 */

import {
  RANGE_PRESETS,
  formatAgo,
  formatCount,
  formatLocalDateTime,
  type IndexProgress,
  type IndexStatus,
  type Overview,
  type RangePreset,
} from "../../lib/ailog";
import { ButtonGroup, Chip, subtleButtonStyle } from "./ui";

export function RangeBar({
  preset,
  customFrom,
  customTo,
  onPreset,
  onCustomRange,
  overview,
  indexStatus,
  indexProgress,
  indexError,
  onStartIndex,
  onCancelIndex,
  onRefresh,
  loading,
  excludeSynthetic,
  onExcludeSynthetic,
  includeSidechain,
  onIncludeSidechain,
}: {
  preset: RangePreset;
  customFrom: string;
  customTo: string;
  onPreset: (preset: RangePreset) => void;
  onCustomRange: (from: string, to: string) => void;
  overview: Overview | null;
  indexStatus: IndexStatus | null;
  indexProgress: IndexProgress | null;
  indexError: string | null;
  onStartIndex: () => void;
  onCancelIndex: () => void;
  onRefresh: () => void;
  loading: boolean;
  excludeSynthetic: boolean;
  onExcludeSynthetic: (value: boolean) => void;
  includeSidechain: boolean;
  onIncludeSidechain: (value: boolean) => void;
}) {
  const running = indexStatus?.running ?? false;
  const done = indexProgress?.filesDone ?? indexStatus?.filesDone ?? 0;
  const total = indexProgress?.filesTotal ?? indexStatus?.filesTotal ?? 0;
  const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
  const freshness = overview?.indexFreshness;
  const customIncomplete = preset === "custom" && (!customFrom || !customTo);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <ButtonGroup
          ariaLabel="期間"
          value={preset}
          onChange={onPreset}
          options={RANGE_PRESETS.map((entry) => ({ value: entry.id, label: entry.label }))}
        />

        {preset === "custom" ? (
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <input
              type="date"
              aria-label="開始日"
              value={customFrom}
              onChange={(event) => onCustomRange(event.target.value, customTo)}
              style={dateInputStyle}
            />
            <span style={{ color: "var(--cmux-text-tertiary)", fontSize: 11 }}>〜</span>
            <input
              type="date"
              aria-label="終了日"
              value={customTo}
              onChange={(event) => onCustomRange(customFrom, event.target.value)}
              style={dateInputStyle}
            />
          </span>
        ) : null}

        <span style={{ flex: 1 }} />

        <button type="button" onClick={onRefresh} disabled={loading} style={{ ...subtleButtonStyle, opacity: loading ? 0.5 : 1 }}>
          {loading ? "読み込み中…" : "再読込"}
        </button>
        {running ? (
          <button type="button" onClick={onCancelIndex} style={{ ...subtleButtonStyle, color: "var(--cmux-red)" }}>
            インデックスを中断
          </button>
        ) : (
          <button type="button" onClick={onStartIndex} style={subtleButtonStyle}>
            再インデックス
          </button>
        )}
      </div>

      {customIncomplete ? (
        <div style={{ fontSize: 10, color: "var(--cmux-usage-warn)" }}>
          日付を 2 つ選ぶと反映されます（それまでは直前の期間のままです）
        </div>
      ) : null}

      {running ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(pct)}
            aria-label="インデックス進捗"
            style={{ flex: 1, height: 5, borderRadius: 3, background: "var(--cmux-hover)", overflow: "hidden" }}
          >
            <div style={{ width: `${pct}%`, height: "100%", background: "var(--cmux-accent)" }} />
          </div>
          <span style={{ fontSize: 10, color: "var(--cmux-text-secondary)", whiteSpace: "nowrap" }}>
            {`${formatCount(done)} / ${formatCount(total)} ファイル`}
            {indexProgress?.sessions ? ` · ${formatCount(indexProgress.sessions)} セッション` : ""}
          </span>
        </div>
      ) : null}

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <label style={checkboxLabelStyle}>
          <input
            type="checkbox"
            checked={excludeSynthetic}
            onChange={(event) => onExcludeSynthetic(event.target.checked)}
          />
          {"<synthetic> を図と表から除外"}
        </label>
        <label style={checkboxLabelStyle}>
          <input
            type="checkbox"
            checked={includeSidechain}
            onChange={(event) => onIncludeSidechain(event.target.checked)}
          />
          サブエージェントのターンも含める
        </label>
        {freshness ? (
          <Chip title="最後にインデックスが完了した時刻">
            {`最終インデックス ${formatLocalDateTime(freshness.lastIndexedAt)}（${formatAgo(freshness.lastIndexedAt)}）`}
          </Chip>
        ) : null}
        {freshness && freshness.staleFiles > 0 ? (
          <Chip tone="warn" title="前回のインデックス以降に更新されたファイル数">
            {`未取り込み ${formatCount(freshness.staleFiles)} ファイル`}
          </Chip>
        ) : null}
      </div>

      {indexError ? (
        <div style={{ fontSize: 10, color: "var(--cmux-red)", overflowWrap: "anywhere" }}>{indexError}</div>
      ) : null}

      {overview ? (
        <div style={{ fontSize: 10, color: "var(--cmux-text-tertiary)", lineHeight: 1.5 }}>
          {overview.costNote}
          {overview.priceSource ? `（単価: ${overview.priceSource}）` : ""}
          {overview.unpricedModels.length > 0
            ? `　単価未設定: ${overview.unpricedModels.join(", ")}（$0 で計上）`
            : ""}
        </div>
      ) : null}
    </div>
  );
}

const dateInputStyle = {
  background: "var(--cmux-hover)",
  border: "1px solid var(--cmux-border)",
  borderRadius: 5,
  color: "var(--cmux-text)",
  fontSize: 11,
  padding: "3px 6px",
  colorScheme: "light dark" as const,
};

const checkboxLabelStyle = {
  display: "flex",
  alignItems: "center",
  gap: 5,
  fontSize: 10,
  color: "var(--cmux-text-secondary)",
  cursor: "pointer",
};
