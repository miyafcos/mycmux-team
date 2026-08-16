import { useState } from "react";
import { formatElapsedSince } from "../../../lib/duration";
import { readDormantMinutes, writeDormantMinutes } from "../../../lib/agentDormancy";
import { useDispatchWatchdogStore, WATCHDOG_KIND_LABELS } from "../../../stores/dispatchWatchdogStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { delegationWatchStrings } from "../settingsStrings";
import { checkboxLabelStyle, checkboxLabelStyleFor, sectionHeadingStyle } from "../tabStyles";

interface SensitivityPreset {
  id: "relaxed" | "standard" | "eager";
  intervalMinutes: number;
  stallMinutes: number;
}

// Interval = how often the watchdog re-checks; stall = how long a session may
// stay silent before it is reported. Both move together so the user only ever
// chooses "how eagerly do you want to be told", never raw minutes.
const SENSITIVITY_PRESETS: readonly SensitivityPreset[] = [
  { id: "relaxed", intervalMinutes: 30, stallMinutes: 90 },
  { id: "standard", intervalMinutes: 10, stallMinutes: 45 },
  { id: "eager", intervalMinutes: 5, stallMinutes: 20 },
];

const DORMANCY_PRESETS = [0, 30, 60, 120] as const;

function presetDescription(preset: SensitivityPreset): string {
  return delegationWatchStrings.sensitivityDescription(preset.intervalMinutes, preset.stallMinutes);
}

export function AutomationTab() {
  const enabled = useSettingsStore((state) => state.dispatchWatchdogEnabled);
  const intervalMinutes = useSettingsStore((state) => state.dispatchWatchdogIntervalMinutes);
  const stallMinutes = useSettingsStore((state) => state.dispatchStallMinutes);
  const setEnabled = useSettingsStore((state) => state.setDispatchWatchdogEnabled);
  const setIntervalMinutes = useSettingsStore((state) => state.setDispatchWatchdogIntervalMinutes);
  const setStallMinutes = useSettingsStore((state) => state.setDispatchStallMinutes);
  const notify = useSettingsStore((state) => state.dispatchWatchdogNotify);
  const setNotify = useSettingsStore((state) => state.setDispatchWatchdogNotify);
  const queue = useDispatchWatchdogStore((state) => state.queue);
  const [dormantMinutes, setDormantMinutes] = useState(readDormantMinutes);
  const now = Date.now();

  const activePreset = SENSITIVITY_PRESETS.find(
    (preset) => preset.intervalMinutes === intervalMinutes && preset.stallMinutes === stallMinutes,
  );

  const enableWatchdog = (next: boolean): void => {
    setEnabled(next);
  };

  const applyPreset = (preset: SensitivityPreset): void => {
    setIntervalMinutes(preset.intervalMinutes);
    setStallMinutes(preset.stallMinutes);
  };

  return (
    <div>
      <div id="cmux-delegation-watch-heading" style={sectionHeadingStyle}>{delegationWatchStrings.heading}</div>
      <div style={{ fontSize: 12, color: "var(--cmux-text-dim)", lineHeight: 1.7, marginBottom: 10 }}>
        {delegationWatchStrings.description}
      </div>
      <label style={checkboxLabelStyle}>
        <input type="checkbox" checked={enabled} onChange={(event) => enableWatchdog(event.target.checked)} />
        <span>{delegationWatchStrings.enabledLabel}</span>
      </label>

      <div style={{ ...sectionHeadingStyle, marginTop: 16 }}>{delegationWatchStrings.sensitivityTitle}</div>
      <div role="radiogroup" aria-label={delegationWatchStrings.sensitivityAriaLabel}>
        {SENSITIVITY_PRESETS.map((preset) => (
          <label key={preset.id} style={checkboxLabelStyleFor(enabled)}>
            <input
              type="radio"
              name="watchdog-sensitivity"
              disabled={!enabled}
              checked={activePreset?.id === preset.id}
              onChange={() => applyPreset(preset)}
            />
            <span style={{ minWidth: 44, fontWeight: 600 }}>{delegationWatchStrings.sensitivityPresetLabel(preset.id)}</span>
            <span style={{ color: "var(--cmux-text-dim)" }}>{presetDescription(preset)}</span>
          </label>
        ))}
        {!activePreset && (
          <label style={checkboxLabelStyleFor(enabled)}>
            <input type="radio" name="watchdog-sensitivity" disabled={!enabled} checked readOnly />
            <span style={{ minWidth: 44, fontWeight: 600 }}>{delegationWatchStrings.customSensitivity}</span>
            <span style={{ color: "var(--cmux-text-dim)" }}>
              {delegationWatchStrings.currentSensitivity(intervalMinutes, stallMinutes)}
            </span>
          </label>
        )}
      </div>

      <div style={{ ...sectionHeadingStyle, marginTop: 16 }}>{delegationWatchStrings.notifyTitle}</div>
      <label style={checkboxLabelStyleFor(enabled)}>
        <input
          type="checkbox"
          checked={notify}
          disabled={!enabled}
          onChange={(event) => setNotify(event.target.checked)}
        />
        <span>{delegationWatchStrings.notifyLabel}</span>
      </label>
      <div style={{ color: "var(--cmux-text-dim)", fontSize: 12, marginTop: 4 }}>{delegationWatchStrings.notifyHint}</div>

      <div style={{ ...sectionHeadingStyle, marginTop: 24 }}>{delegationWatchStrings.dormancyTitle}</div>
      <div style={{ color: "var(--cmux-text-dim)", fontSize: 12, lineHeight: 1.7, marginBottom: 6 }}>{delegationWatchStrings.dormancyDescription}</div>
      <div role="radiogroup" aria-label={delegationWatchStrings.dormancyAriaLabel}>
        {DORMANCY_PRESETS.map((minutes) => (
          <label key={minutes} style={checkboxLabelStyle}>
            <input
              type="radio"
              name="agent-dormancy-minutes"
              checked={dormantMinutes === minutes}
              onChange={() => setDormantMinutes(writeDormantMinutes(minutes))}
            />
            <span>{delegationWatchStrings.dormancyPreset(minutes)}</span>
          </label>
        ))}
      </div>

      <div style={{ ...sectionHeadingStyle, marginTop: 24 }}>{delegationWatchStrings.queueTitle(queue.length)}</div>
      {queue.length === 0 ? (
        <div style={{ color: "var(--cmux-text-dim)", fontSize: 12 }}>{delegationWatchStrings.queueEmpty}</div>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {queue.map((item) => (
            <div key={item.key} style={{ border: "1px solid var(--cmux-border)", borderRadius: 6, padding: "8px 10px", fontSize: 12 }}>
              <div style={{ fontWeight: 600 }}>{WATCHDOG_KIND_LABELS[item.kind]} — {item.label ?? item.slug ?? item.sessionId ?? delegationWatchStrings.queueUnknownSubject}</div>
              <div style={{ color: "var(--cmux-text-dim)", marginTop: 3 }}>
                {delegationWatchStrings.queueContinuing(formatElapsedSince(now, item.since), item.confirmations)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
