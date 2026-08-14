/**
 * The usage tab — absolute volume, by day and by model.
 *
 * This is the one surface that must render whenever the database has rows. It
 * reads only SQL aggregates: no summariser subprocess, no LLM, no network. A
 * failure is scoped to this tab's own `usageError` and never blanks the panel.
 */

import { useMemo, useState } from "react";

import { formatAgo, type SeriesReport, type UsageRhythmReport } from "../../lib/ailog";
import { UsageDailyChart } from "./UsageDailyChart";
import { UsageModelTable } from "./UsageModelTable";
import { UsageRhythm } from "./UsageRhythm";
import { UsageTotals } from "./UsageTotals";
import { USAGE_METRICS, buildUsageModel, isStackable, type UsageMetric } from "./usageModel";
import { ButtonGroup, Chip, EmptyState, Section, SkeletonBlock, noteStyle } from "./ui";

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export function UsageView({
  series,
  rhythm,
  loading,
  error,
  metric,
  onMetric,
  stack,
  onStack,
  bucket,
  onBucket,
  granularity,
  onGranularity,
  rangeReady,
  selectionLabel,
  onClearSelection,
  onRetry,
  onReindex,
  onPickDay,
  onOpenDigest,
  digestLinkLabel,
}: {
  series: SeriesReport | null;
  rhythm: UsageRhythmReport | null;
  loading: boolean;
  error: string | null;
  metric: UsageMetric;
  onMetric: (metric: UsageMetric) => void;
  stack: "absolute" | "share";
  onStack: (stack: "absolute" | "share") => void;
  bucket: "day" | "week" | "month";
  onBucket: (bucket: "day" | "week" | "month") => void;
  granularity: "family" | "raw";
  onGranularity: (value: "family" | "raw") => void;
  rangeReady: boolean;
  selectionLabel: string | null;
  onClearSelection: () => void;
  onRetry: () => void;
  onReindex: () => void;
  onPickDay?: (day: number) => void;
  onOpenDigest?: (day: number) => void;
  digestLinkLabel?: string;
}) {
  const [highlight, setHighlight] = useState<string | null>(null);
  const model = useMemo(
    () => (series ? buildUsageModel(series.buckets, metric) : null),
    [series, metric],
  );

  if (!rangeReady) {
    return (
      <Section title="トータル">
        <div style={noteStyle}>期間を2つの日付で指定すると反映されます。</div>
      </Section>
    );
  }

  if (error) {
    return (
      <Section title="トータル">
        <EmptyState kind="error" message={error} onPrimary={onRetry} />
      </Section>
    );
  }

  if (!series || !rhythm) {
    return (
      <Section title="トータル">
        {loading ? (
          <SkeletonBlock height={220} label="集計を読み込み中" />
        ) : (
          <EmptyState kind="no-data" onPrimary={onReindex} />
        )}
      </Section>
    );
  }

  const freshness = rhythm.indexFreshness;
  const stale =
    freshness.lastIndexedAt > 0 && Date.now() - freshness.lastIndexedAt > STALE_AFTER_MS;

  return (
    <>
      <Section
        title="トータル"
        subtitle="コスト相当ではなく、実際に処理した量で並べています。指標を切り替えると順位が変わります。"
        actions={
          <ButtonGroup
            ariaLabel="指標"
            value={metric}
            onChange={onMetric}
            options={USAGE_METRICS.map((entry) => ({
              value: entry.id,
              label: entry.label,
              title: entry.hint,
            }))}
          />
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <ButtonGroup
              ariaLabel="粒度"
              value={granularity}
              onChange={onGranularity}
              options={[
                { value: "family", label: "ファミリー", title: "gpt-5.6 のように系統でまとめます" },
                { value: "raw", label: "モデル名", title: "sol / terra / luna を分けて表示します" },
              ]}
            />
            <ButtonGroup
              ariaLabel="バケット"
              value={bucket}
              onChange={onBucket}
              options={[
                { value: "day", label: "日" },
                { value: "week", label: "週" },
                { value: "month", label: "月" },
              ]}
            />
            <ButtonGroup
              ariaLabel="表示"
              value={stack}
              onChange={onStack}
              options={[
                { value: "absolute", label: "実数" },
                { value: "share", label: "構成比" },
              ]}
            />
            {freshness.lastIndexedAt > 0 ? (
              <Chip tone={stale ? "warn" : "neutral"} title="この画面が対象にしている記録の新しさ">
                {`記録は ${formatAgo(freshness.lastIndexedAt)}まで`}
              </Chip>
            ) : null}
            {stale ? (
              <button
                type="button"
                onClick={onReindex}
                style={{
                  border: "1px solid var(--cmux-border)",
                  borderRadius: 5,
                  background: "var(--cmux-hover)",
                  color: "var(--cmux-text)",
                  padding: "3px 9px",
                  fontSize: "var(--cmux-font-size-xs)",
                  cursor: "pointer",
                }}
              >
                再インデックス
              </button>
            ) : null}
            {selectionLabel ? (
              <button
                type="button"
                onClick={onClearSelection}
                title="絞り込みを解除します"
                style={{
                  border: "1px solid var(--cmux-accent)",
                  borderRadius: 999,
                  background: "var(--cmux-hover)",
                  color: "var(--cmux-accent)",
                  padding: "2px 9px",
                  fontSize: "var(--cmux-font-size-xs)",
                  cursor: "pointer",
                }}
              >
                {`絞り込み中: ${selectionLabel} ×`}
              </button>
            ) : null}
          </div>

          <UsageTotals report={series} metric={metric} />
        </div>
      </Section>

      <Section
        title={isStackable(metric) ? "日別 × モデル別" : "日別 (ターン数)"}
        subtitle={
          isStackable(metric)
            ? "棒をクリックするとその日だけに期間を絞ります。凡例をクリックすると1モデルを強調します。"
            : "セッションは1本が複数モデルに跨るため積み上げず、代わりにターン数を出しています。日ごとのセッション本数は棒のツールチップにあります。"
        }
      >
        {model ? (
          <UsageDailyChart
            model={model}
            metric={isStackable(metric) ? metric : "turns"}
            mode={stack}
            highlight={highlight}
            onHighlight={setHighlight}
            onPickDay={onPickDay}
            onOpenDigest={onOpenDigest}
            digestLinkLabel={digestLinkLabel}
          />
        ) : null}
      </Section>

      <Section title="稼働リズム" subtitle="記録の全期間から算出しています (期間フィルタは適用されます)。">
        <UsageRhythm report={rhythm} metric={metric} />
      </Section>

      <Section title="モデル別の内訳">
        <UsageModelTable report={series} metric={metric} />
      </Section>
    </>
  );
}
