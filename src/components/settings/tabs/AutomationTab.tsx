import { formatElapsedMinutes, formatElapsedSince } from "../../../lib/duration";
import { useDispatchWatchdogStore, WATCHDOG_KIND_LABELS } from "../../../stores/dispatchWatchdogStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { checkboxLabelStyle, checkboxLabelStyleFor, sectionHeadingStyle } from "../tabStyles";

interface SensitivityPreset {
  id: string;
  label: string;
  intervalMinutes: number;
  stallMinutes: number;
}

// Interval = how often the watchdog re-checks; stall = how long a session may
// stay silent before it is reported. Both move together so the user only ever
// chooses "how eagerly do you want to be told", never raw minutes.
const SENSITIVITY_PRESETS: readonly SensitivityPreset[] = [
  { id: "relaxed", label: "控えめ", intervalMinutes: 30, stallMinutes: 90 },
  { id: "standard", label: "標準", intervalMinutes: 10, stallMinutes: 45 },
  { id: "eager", label: "敏感", intervalMinutes: 5, stallMinutes: 20 },
];

function presetDescription(preset: SensitivityPreset): string {
  return `${formatElapsedMinutes(preset.intervalMinutes)}ごとにチェック・${formatElapsedMinutes(preset.stallMinutes)}無反応で通知`;
}

export function AutomationTab() {
  const enabled = useSettingsStore((state) => state.dispatchWatchdogEnabled);
  const intervalMinutes = useSettingsStore((state) => state.dispatchWatchdogIntervalMinutes);
  const stallMinutes = useSettingsStore((state) => state.dispatchStallMinutes);
  const setEnabled = useSettingsStore((state) => state.setDispatchWatchdogEnabled);
  const setIntervalMinutes = useSettingsStore((state) => state.setDispatchWatchdogIntervalMinutes);
  const setStallMinutes = useSettingsStore((state) => state.setDispatchStallMinutes);
  const setNotify = useSettingsStore((state) => state.setDispatchWatchdogNotify);
  const queue = useDispatchWatchdogStore((state) => state.queue);
  const now = Date.now();

  const activePreset = SENSITIVITY_PRESETS.find(
    (preset) => preset.intervalMinutes === intervalMinutes && preset.stallMinutes === stallMinutes,
  );

  const enableWatchdog = (next: boolean): void => {
    setEnabled(next);
    // The notify toggle is no longer surfaced; turning the watchdog on from
    // here always means "and tell me", so heal a legacy notify=false too.
    if (next) setNotify(true);
  };

  const applyPreset = (preset: SensitivityPreset): void => {
    setIntervalMinutes(preset.intervalMinutes);
    setStallMinutes(preset.stallMinutes);
  };

  return (
    <div>
      <div id="cmux-delegation-watch-heading" style={sectionHeadingStyle}>委譲の見守り</div>
      <div style={{ fontSize: 12, color: "var(--cmux-text-dim)", lineHeight: 1.7, marginBottom: 10 }}>
        バックグラウンドで動かしている AI タブが止まっていないかを定期的にチェックし、
        放置すると困る状態 (質問待ち・完了未確認・停止など) を見つけたら通知でお知らせします。
      </div>
      <label style={checkboxLabelStyle}>
        <input type="checkbox" checked={enabled} onChange={(event) => enableWatchdog(event.target.checked)} />
        <span>見守りを有効にする</span>
      </label>

      <div style={{ ...sectionHeadingStyle, marginTop: 16 }}>通知の敏感さ</div>
      <div role="radiogroup" aria-label="通知の敏感さ">
        {SENSITIVITY_PRESETS.map((preset) => (
          <label key={preset.id} style={checkboxLabelStyleFor(enabled)}>
            <input
              type="radio"
              name="watchdog-sensitivity"
              disabled={!enabled}
              checked={activePreset?.id === preset.id}
              onChange={() => applyPreset(preset)}
            />
            <span style={{ minWidth: 44, fontWeight: 600 }}>{preset.label}</span>
            <span style={{ color: "var(--cmux-text-dim)" }}>{presetDescription(preset)}</span>
          </label>
        ))}
        {!activePreset && (
          <label style={checkboxLabelStyleFor(enabled)}>
            <input type="radio" name="watchdog-sensitivity" disabled={!enabled} checked readOnly />
            <span style={{ minWidth: 44, fontWeight: 600 }}>カスタム</span>
            <span style={{ color: "var(--cmux-text-dim)" }}>
              現在の設定: {formatElapsedMinutes(intervalMinutes)}ごとにチェック・{formatElapsedMinutes(stallMinutes)}無反応で通知
            </span>
          </label>
        )}
      </div>

      <div style={{ ...sectionHeadingStyle, marginTop: 24 }}>いま気になっているタブ ({queue.length}件)</div>
      {queue.length === 0 ? (
        <div style={{ color: "var(--cmux-text-dim)", fontSize: 12 }}>問題は見つかっていません。</div>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {queue.map((item) => (
            <div key={item.key} style={{ border: "1px solid var(--cmux-border)", borderRadius: 6, padding: "8px 10px", fontSize: 12 }}>
              <div style={{ fontWeight: 600 }}>{WATCHDOG_KIND_LABELS[item.kind]} — {item.label ?? item.slug ?? item.sessionId ?? "セッション"}</div>
              <div style={{ color: "var(--cmux-text-dim)", marginTop: 3 }}>
                {formatElapsedSince(now, item.since)}継続・連続確認 {item.confirmations} 回
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
