/**
 * The usage tab — absolute volume, by day and by model.
 *
 * This is the one surface that must render whenever the database has rows. It
 * reads only SQL aggregates: no summariser subprocess, no LLM, no network. A
 * failure is scoped to this tab's own `usageError` and never blanks the panel.
 */

import { useMemo, useState } from "react";

import { type SeriesReport, type UsageRhythmReport } from "../../lib/ailog";
import { UsageDailyChart } from "./UsageDailyChart";
import { UsageModelTable } from "./UsageModelTable";
import { UsageRhythm } from "./UsageRhythm";
import { UsageTotals } from "./UsageTotals";
import { USAGE_METRICS, buildUsageModel, isStackable, type UsageMetric } from "./usageModel";
import { ButtonGroup, DeferredDetails, EmptyState, Section, SkeletonBlock, noteStyle } from "./ui";

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
  onRetry,
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
  granularity: "provider" | "family" | "raw";
  onGranularity: (value: "provider" | "family" | "raw") => void;
  rangeReady: boolean;
  onRetry: () => void;
  onPickDay?: (day: number) => void;
  onOpenDigest?: (day: number) => void;
  digestLinkLabel?: string;
}) {
  const [highlight, setHighlight] = useState<string | null>(null);
  const model = useMemo(
    () => (series ? buildUsageModel(series.buckets, metric) : null),
    [series, metric],
  );
  const groupingLabel = granularity === "provider" ? "会社" : granularity === "family" ? "系統" : "モデル";

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
          <EmptyState kind="no-data" />
        )}
      </Section>
    );
  }

  return (
    <>
      <Section
        title="トータル"
        subtitle="コスト相当ではなく、実際に処理した量で並べています。指標を切り替えると順位が変わります。"
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          <ButtonGroup
            ariaLabel="指標"
            roleLabel="指標"
            value={metric}
            onChange={onMetric}
            options={USAGE_METRICS.map((entry) => ({
              value: entry.id,
              label: entry.label,
              title: entry.hint,
            }))}
          />

          <UsageTotals report={series} metric={metric} />
        </div>
      </Section>

      <Section
        title={isStackable(metric) ? `日別 × ${groupingLabel}別` : "日別 (ターン数)"}
        subtitle={
          isStackable(metric)
            ? `棒をクリックするとその日だけに期間を絞ります。凡例をクリックすると1${groupingLabel}を強調します。`
            : `セッションは1本が複数${groupingLabel}に跨るため積み上げず、代わりにターン数を出しています。日ごとのセッション本数は棒のツールチップにあります。`
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <ButtonGroup ariaLabel="単位" roleLabel="単位" value={bucket} onChange={onBucket} options={[{ value: "day", label: "日" }, { value: "week", label: "週" }, { value: "month", label: "月" }]} />
            <ButtonGroup ariaLabel="表示" roleLabel="表示" value={stack} onChange={onStack} options={[{ value: "absolute", label: "実数" }, { value: "share", label: "構成比" }]} />
            <ButtonGroup ariaLabel="まとめ方" roleLabel="まとめ方" value={granularity} onChange={onGranularity} options={[{ value: "provider", label: "会社" }, { value: "family", label: "系統", title: "gpt-5.6 のように系統でまとめます" }, { value: "raw", label: "モデル", title: "sol / terra / luna を分けて表示します" }]} />
          </div>
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
              groupBy={series.groupBy}
            />
          ) : null}
        </div>
      </Section>

      <DeferredDetails summary="稼働リズム" subtitle="記録の全期間から算出しています (期間フィルタは適用されます)。">
        <UsageRhythm report={rhythm} metric={metric} />
      </DeferredDetails>

      <DeferredDetails summary={groupingLabel}>
        <UsageModelTable report={series} metric={metric} />
      </DeferredDetails>
    </>
  );
}
