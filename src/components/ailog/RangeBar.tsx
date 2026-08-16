/**
 * Header row: range picker, re-index control, and index freshness.
 */

import { useEffect } from "react";
import {
  RANGE_PRESETS,
  formatAgo,
  formatBytes,
  formatCount,
  formatDuration,
  type Overview,
  type RangePreset,
  type SummaryRangePreset,
  SUMMARY_RANGE_PRESETS,
  type UsageRhythmReport,
  listenIndexProgress,
  listenSummarizeProgress,
} from "../../lib/ailog";
import { useAilogPolling } from "../../hooks/useAilogPolling";
import { jobDisplayError, useAilogJobStore } from "../../stores/useAilogJobStore";
import { ButtonGroup, Chip, subtleButtonStyle } from "./ui";

export function RangeBar({
  preset,
  customFrom,
  customTo,
  onPreset,
  onCustomRange,
  summaryPreset,
  onSummaryPreset,
  open,
  onJobsSettled,
  onStartSummarize,
  overview,
  usageRhythm,
  aiDisabledReason,
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
  summaryPreset: SummaryRangePreset;
  onSummaryPreset: (preset: SummaryRangePreset) => void;
  open: boolean;
  onJobsSettled: () => void;
  /** Explicit-LLM gate owned by the panel; progress state remains local here. */
  onStartSummarize?: () => void;
  overview: Overview | null;
  /** Usage is the default segment, so it supplies freshness before dashboard prefetch settles. */
  usageRhythm: UsageRhythmReport | null;
  /** Set when the AI setting is off; also used as the button's tooltip. */
  aiDisabledReason?: string;
  onRefresh: () => void;
  loading: boolean;
  excludeSynthetic: boolean;
  onExcludeSynthetic: (value: boolean) => void;
  includeSidechain: boolean;
  onIncludeSidechain: (value: boolean) => void;
}) {
  const index = useAilogJobStore((state) => state.index);
  const summarize = useAilogJobStore((state) => state.summarize);
  const setIndexEventsAvailable = useAilogJobStore((state) => state.setIndexEventsAvailable);
  const setSummarizeEventsAvailable = useAilogJobStore((state) => state.setSummarizeEventsAvailable);
  const applyIndexProgress = useAilogJobStore((state) => state.applyIndexProgress);
  const applySummarizeProgress = useAilogJobStore((state) => state.applySummarizeProgress);
  const refreshIndexStatus = useAilogJobStore((state) => state.refreshIndexStatus);
  const refreshSummarizeStatus = useAilogJobStore((state) => state.refreshSummarizeStatus);
  const startIndex = useAilogJobStore((state) => state.startIndex);
  const cancelIndex = useAilogJobStore((state) => state.cancelIndex);
  const startSummarize = useAilogJobStore((state) => state.startSummarize);
  const cancelSummarize = useAilogJobStore((state) => state.cancelSummarize);
  const dismissIndexError = useAilogJobStore((state) => state.dismissIndexError);
  const dismissSummarizeError = useAilogJobStore((state) => state.dismissSummarizeError);
  useEffect(() => {
    if (!open) return;
    void refreshIndexStatus();
    void refreshSummarizeStatus(summaryPreset);
  }, [open, refreshIndexStatus, refreshSummarizeStatus, summaryPreset]);
  useEffect(() => {
    if (!open) return;
    let unlisten: (() => void) | undefined; let cancelled = false;
    setIndexEventsAvailable(true);
    void listenIndexProgress(applyIndexProgress).then((fn) => { if (cancelled) fn(); else unlisten = fn; }).catch(() => { if (!cancelled) setIndexEventsAvailable(false); });
    return () => { cancelled = true; unlisten?.(); };
  }, [applyIndexProgress, open, setIndexEventsAvailable]);
  useEffect(() => {
    if (!open) return;
    let unlisten: (() => void) | undefined; let cancelled = false;
    setSummarizeEventsAvailable(true);
    void listenSummarizeProgress(applySummarizeProgress).then((fn) => { if (cancelled) fn(); else unlisten = fn; }).catch(() => { if (!cancelled) setSummarizeEventsAvailable(false); });
    return () => { cancelled = true; unlisten?.(); };
  }, [applySummarizeProgress, open, setSummarizeEventsAvailable]);
  const running = index.status?.running ?? false;
  const summarizing = summarize.status?.running ?? false;
  useAilogPolling({ open, indexRunning: running, summarizeRunning: summarizing, eventsHealthy: (!running || index.eventsAvailable) && (!summarizing || summarize.eventsAvailable), refreshIndexStatus: async () => { if (await refreshIndexStatus()) onJobsSettled(); }, refreshSummarizeStatus: async () => { if (await refreshSummarizeStatus(summaryPreset)) onJobsSettled(); }, refreshReports: async () => { onJobsSettled(); } });
  const indexStatus = index.status;
  const indexProgress = index.progress;
  const summarizeStatus = summarize.status;
  const summarizeProgress = summarize.progress;
  const indexError = jobDisplayError(index);
  const summarizeError = jobDisplayError(summarize);
  const done = indexProgress?.filesDone ?? indexStatus?.filesDone ?? 0;
  const total = indexProgress?.filesTotal ?? indexStatus?.filesTotal ?? 0;
  const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
  const freshness = overview?.indexFreshness ?? usageRhythm?.indexFreshness;
  const summaryDone = summarizeProgress?.sessionsDone ?? summarizeStatus?.sessionsDone ?? 0;
  const summaryTotal = summarizeProgress?.sessionsTotal ?? summarizeStatus?.sessionsTotal ?? 0;
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
            <span style={{ color: "var(--cmux-text-tertiary)", fontSize: "var(--cmux-font-size-xs)" }}>〜</span>
            <input
              type="date"
              aria-label="終了日"
              value={customTo}
              onChange={(event) => onCustomRange(customFrom, event.target.value)}
              style={dateInputStyle}
            />
          </span>
        ) : null}

        <span style={{ fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-text-secondary)" }}>要約対象</span>
        <ButtonGroup
          ariaLabel="要約対象期間"
          value={summaryPreset}
          onChange={onSummaryPreset}
          options={SUMMARY_RANGE_PRESETS.map((entry) => ({ value: entry.id, label: entry.label }))}
        />

        <span style={{ flex: 1 }} />

        <button type="button" onClick={onRefresh} disabled={loading} style={{ ...subtleButtonStyle, opacity: loading ? 0.5 : 1 }}>
          {loading ? "集計を更新中…" : "再読込"}
        </button>
        {running ? (
          <button type="button" onClick={() => void cancelIndex()} style={{ ...subtleButtonStyle, color: "var(--cmux-red)" }}>
            インデックスを中断
          </button>
        ) : (
          <button type="button" onClick={() => void startIndex(false)} disabled={summarizing} style={{ ...subtleButtonStyle, opacity: summarizing ? 0.5 : 1 }}>
            再インデックス
          </button>
        )}
        {summarizing ? (
          <button type="button" onClick={() => void cancelSummarize(summaryPreset)} style={{ ...subtleButtonStyle, color: "var(--cmux-red)" }}>
            要約を中断
          </button>
        ) : (
          <button
            type="button"
            onClick={onStartSummarize ?? (() => void startSummarize(summaryPreset))}
            disabled={running || aiDisabledReason !== undefined}
            title={aiDisabledReason}
            style={{ ...subtleButtonStyle, opacity: running || aiDisabledReason !== undefined ? 0.5 : 1 }}
          >
            要約を実行
          </button>
        )}
      </div>

      {customIncomplete ? (
        <div style={{ fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-usage-warn)" }}>
          日付を 2 つ選ぶと反映されます（それまでは直前の期間のままです）
        </div>
      ) : null}

      {running ? (() => {
        const discovering = !indexProgress || (indexProgress.phase !== "parsing" && indexProgress.phase !== "done");
        const bytesDone = indexProgress?.bytesDone ?? 0;
        const bytesTotal = indexProgress?.bytesTotal ?? 0;
        const elapsedMs = indexProgress?.elapsedMs ?? 0;
        const etaMs = !discovering && bytesDone > 1_048_576 && bytesTotal > bytesDone
          ? (elapsedMs * (bytesTotal - bytesDone)) / bytesDone
          : null;
        return (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(pct)}
              aria-label="インデックス進捗"
              style={{ flex: 1, height: 5, borderRadius: 3, background: "var(--cmux-hover)", overflow: "hidden" }}
            >
              <div style={{ width: `${discovering ? 0 : pct}%`, height: "100%", background: "var(--cmux-accent)" }} />
            </div>
            <span style={{ fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-text-secondary)", whiteSpace: "nowrap" }}>
              {discovering
                ? "ファイル一覧を作成中…"
                : [
                    `${formatCount(done)} / ${formatCount(total)} ファイル`,
                    indexProgress?.sessions ? `${formatCount(indexProgress.sessions)} セッション` : null,
                    bytesTotal > 0 ? `${formatBytes(bytesDone)} / ${formatBytes(bytesTotal)}` : null,
                    `経過 ${formatDuration(elapsedMs)}`,
                    etaMs !== null ? `残り約 ${formatDuration(etaMs)}` : null,
                  ].filter(Boolean).join(" · ")}
            </span>
          </div>
        );
      })() : null}

      {summarizing ? (
        <div style={{ fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-text-secondary)" }}>
          {`処理済み ${formatCount(summaryDone)} / 全 ${formatCount(summaryTotal)} · 経過 ${formatDuration(summarizeProgress?.elapsedMs ?? 0)}`}
        </div>
      ) : null}
      {summarizeError ? <div style={{ fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-red)" }}>{summarizeError} <button type="button" onClick={dismissSummarizeError} style={subtleButtonStyle}>閉じる</button></div> : null}
      {overview && overview.excludedInternal.sessions > 0 ? (
        <div style={{ fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-text-secondary)" }}>
          {`内部処理 ${formatCount(overview.excludedInternal.sessions)} 件 ($${overview.excludedInternal.costUsd.toFixed(2)}) を除外`}
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
            {`記録は ${formatAgo(freshness.lastIndexedAt)}まで`}
          </Chip>
        ) : null}
        {freshness && freshness.staleFiles > 0 ? (
          <Chip tone="warn" title="前回のインデックス以降に更新されたファイル数">
            {`未取り込み ${formatCount(freshness.staleFiles)} ファイル`}
          </Chip>
        ) : null}
      </div>

      {indexError ? (
        <div style={{ fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-red)", overflowWrap: "anywhere" }}>{indexError} <button type="button" onClick={dismissIndexError} style={subtleButtonStyle}>閉じる</button></div>
      ) : null}

      {overview ? (
        <div style={{ fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-text-tertiary)", lineHeight: 1.5 }}>
          {overview.costNote}
          {overview.priceSource ? `（単価: ${{ default: "既定", user: "手入力", mixed: "既定+手入力" }[overview.priceSource] ?? overview.priceSource}）` : ""}
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
  fontSize: "var(--cmux-font-size-xs)",
  padding: "3px 6px",
  colorScheme: "light dark" as const,
};

const checkboxLabelStyle = {
  display: "flex",
  alignItems: "center",
  gap: 5,
  fontSize: "var(--cmux-font-size-xs)",
  color: "var(--cmux-text-secondary)",
  cursor: "pointer",
};
