import { useAilogStore } from "../../stores/ailogStore";
import { USAGE_METRICS, type RhythmMetric } from "./usageModel";
import { UsageRhythm } from "./UsageRhythm";
import { ReportPeriod } from "./ReportFeedback";
import { EmptyState, RefreshingBlock, SkeletonBlock, noteStyle, subtleButtonStyle } from "./ui";

/** Reports are prefetched by loadUsage; mounting this view never fetches. */
export function UsageRhythmDetails() {
  const report = useAilogStore(state => state.usageRhythm);
  const loading = useAilogStore(state => state.usageRhythmLoading);
  const error = useAilogStore(state => state.usageRhythmError);
  const refresh = useAilogStore(state => state.refreshUsageRhythm);
  const metric = useAilogStore(state => state.usageRhythmMetric);
  const setMetric = useAilogStore(state => state.setUsageRhythmMetric);
  return <div>
    <div style={{ marginBottom: 10 }}>
      <div style={noteStyle}>活動時間の指標</div>
      <div role="group" aria-label="活動時間の指標" style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
        {USAGE_METRICS.map(entry => {
          const disabled = entry.id === "costUsd" || entry.id === "sessions";
          const reason = disabled ? "時間帯・曜日の記録には、この指標の集計がありません" : entry.hint;
          return <button key={entry.id} type="button" disabled={disabled} aria-pressed={entry.id === metric}
            title={reason} onClick={() => { if (!disabled) setMetric(entry.id as RhythmMetric); }}
            style={{ ...subtleButtonStyle, opacity: disabled ? .5 : 1, background: entry.id === metric ? "var(--cmux-selected)" : "transparent" }}>{entry.label}</button>;
        })}
      </div>
      <div style={noteStyle}>コスト相当・セッション数は時間帯と曜日の集計がないため選べません。</div>
    </div>
    {error && !report ? <EmptyState kind="error" message={error} onPrimary={() => void refresh({ force: true })} />
      : !report ? <SkeletonBlock height={360} label="活動時間を読み込み中" />
      : <RefreshingBlock busy={loading}><ReportPeriod range={report.range} />{error ? <EmptyState kind="error" message={error} onPrimary={() => void refresh({ force: true })} /> : null}<UsageRhythm report={report} metric={metric} /></RefreshingBlock>}
  </div>;
}
