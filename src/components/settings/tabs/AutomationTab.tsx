import { useDispatchWatchdogStore, WATCHDOG_KIND_LABELS } from "../../../stores/dispatchWatchdogStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { checkboxLabelStyle, checkboxLabelStyleFor, sectionHeadingStyle } from "../tabStyles";

function positiveInteger(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}

export function AutomationTab() {
  const enabled = useSettingsStore((state) => state.dispatchWatchdogEnabled);
  const intervalMinutes = useSettingsStore((state) => state.dispatchWatchdogIntervalMinutes);
  const stallMinutes = useSettingsStore((state) => state.dispatchStallMinutes);
  const notify = useSettingsStore((state) => state.dispatchWatchdogNotify);
  const setEnabled = useSettingsStore((state) => state.setDispatchWatchdogEnabled);
  const setIntervalMinutes = useSettingsStore((state) => state.setDispatchWatchdogIntervalMinutes);
  const setStallMinutes = useSettingsStore((state) => state.setDispatchStallMinutes);
  const setNotify = useSettingsStore((state) => state.setDispatchWatchdogNotify);
  const queue = useDispatchWatchdogStore((state) => state.queue);
  const now = Date.now();

  return (
    <div>
      <div style={sectionHeadingStyle}>自動監視</div>
      <label style={checkboxLabelStyle}>
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        <span>dispatch ウォッチドッグを有効にする</span>
      </label>
      <label style={checkboxLabelStyleFor(enabled)}>
        <input type="checkbox" checked={notify} disabled={!enabled} onChange={(event) => setNotify(event.target.checked)} />
        <span>ベル・バッジ・トーストで通知する</span>
      </label>
      <label style={{ ...checkboxLabelStyleFor(enabled), justifyContent: "space-between" }}>
        <span>確認間隔（分）</span>
        <input
          type="number"
          min={1}
          disabled={!enabled}
          value={intervalMinutes}
          onChange={(event) => setIntervalMinutes(positiveInteger(event.target.value, intervalMinutes))}
          style={{ width: 76 }}
        />
      </label>
      <label style={{ ...checkboxLabelStyleFor(enabled), justifyContent: "space-between" }}>
        <span>停止とみなすまで（分）</span>
        <input
          type="number"
          min={1}
          disabled={!enabled}
          value={stallMinutes}
          onChange={(event) => setStallMinutes(positiveInteger(event.target.value, stallMinutes))}
          style={{ width: 76 }}
        />
      </label>

      <div style={{ ...sectionHeadingStyle, marginTop: 24 }}>現在の要確認キュー</div>
      {queue.length === 0 ? (
        <div style={{ color: "var(--cmux-text-dim)", fontSize: 12 }}>現在の要確認項目はありません。</div>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {queue.map((item) => (
            <div key={item.key} style={{ border: "1px solid var(--cmux-border)", borderRadius: 6, padding: "8px 10px", fontSize: 12 }}>
              <div style={{ fontWeight: 600 }}>{WATCHDOG_KIND_LABELS[item.kind]} — {item.label ?? item.slug ?? item.sessionId ?? "セッション"}</div>
              <div style={{ color: "var(--cmux-text-dim)", marginTop: 3 }}>
                {Math.max(0, Math.floor((now - item.since) / 60_000))}分継続・連続確認 {item.confirmations} 回
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
