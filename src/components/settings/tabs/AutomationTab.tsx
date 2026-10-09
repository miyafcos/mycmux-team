import { useEffect, useState } from "react";
import { readDormantMinutes, writeDormantMinutes, type DormancyPressureSettings } from "../../../lib/agentDormancy";
import { getAvailableMemoryMiB } from "../../../lib/ipc";
import { useAgentDormancyStore } from "../../../stores/agentDormancyStore";
import { autonomyGetSettings, autonomySetSettings, type AutonomySettings } from "../../../lib/autonomyBridge";
import { useSettingsStore } from "../../../stores/settingsStore";
import { autonomySettingsStrings, delegationWatchStrings } from "../settingsStrings";
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
const DEFAULT_AUTONOMY_SETTINGS: AutonomySettings = { autoAdvance: true, attentionCards: true };

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
  const [dormantMinutes, setDormantMinutes] = useState(readDormantMinutes);
  const closeWithoutConfirmation = useSettingsStore((state) => state.autoSweepCloseWithoutConfirmation);
  const setCloseWithoutConfirmation = useSettingsStore((state) => state.setAutoSweepCloseWithoutConfirmation);
  const pressure = useSettingsStore((state) => state.dormancyPressureSettings);
  const setPressure = useSettingsStore((state) => state.setDormancyPressureSettings);
  const allowCompletion = useSettingsStore((state) => state.dormancyAllowUnreadCompletion);
  const setAllowCompletion = useSettingsStore((state) => state.setDormancyAllowUnreadCompletion);
  const [memory, setMemory] = useState<number | null | undefined>(() => {
    const state = useAgentDormancyStore.getState();
    return state.sampled ? state.sample.availableMemoryMiB : undefined;
  });
  const [autonomySettings, setAutonomySettings] = useState<AutonomySettings>(DEFAULT_AUTONOMY_SETTINGS);

  useEffect(() => {
    void autonomyGetSettings().then(setAutonomySettings).catch(() => undefined);
    let cancelled = false;
    void getAvailableMemoryMiB().then((value) => { if (!cancelled) setMemory(value); })
      .catch(() => { if (!cancelled) setMemory(null); });
    return () => { cancelled = true; };
  }, []);

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

  const updateAutonomySettings = (input: Partial<AutonomySettings>): void => {
    void autonomySetSettings(input).then(setAutonomySettings).catch(() => undefined);
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

      <div id="cmux-autonomy-heading" style={{ ...sectionHeadingStyle, marginTop: 24 }}>{autonomySettingsStrings.heading}</div>
      <label style={checkboxLabelStyle}>
        <input
          data-autonomy-toggle="autoAdvance"
          type="checkbox"
          checked={autonomySettings.autoAdvance}
          onChange={(event) => updateAutonomySettings({ autoAdvance: event.target.checked })}
        />
        <span>{autonomySettingsStrings.autoAdvanceLabel}</span>
      </label>
      <div style={{ color: "var(--cmux-text-dim)", fontSize: 12, marginTop: 4 }}>{autonomySettingsStrings.autoAdvanceHint}</div>
      <label style={{ ...checkboxLabelStyle, marginTop: 10 }}>
        <input
          data-autonomy-toggle="attentionCards"
          type="checkbox"
          checked={autonomySettings.attentionCards}
          onChange={(event) => updateAutonomySettings({ attentionCards: event.target.checked })}
        />
        <span>{autonomySettingsStrings.attentionCardsLabel}</span>
      </label>
      <div style={{ color: "var(--cmux-text-dim)", fontSize: 12, marginTop: 4 }}>{autonomySettingsStrings.attentionCardsHint}</div>

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

      <div style={{ ...sectionHeadingStyle, marginTop: 24 }}>ペイン掃除の確認</div>
      <label style={checkboxLabelStyle}>
        <input type="checkbox" checked={closeWithoutConfirmation} onChange={(event) => setCloseWithoutConfirmation(event.target.checked)} />
        <span>AI判定後、確認せずにペインを閉じる</span>
      </label>
      <div style={{ color: "var(--cmux-text-dim)", fontSize: 12, lineHeight: 1.7, marginTop: 4 }}>
        既定はオフです。候補と理由を確認してから閉じます。閉じるとプロセスは終了し、取り消しても実行状態は戻りません。
      </div>

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
      <label style={{ ...checkboxLabelStyle, marginTop: 10 }}>
        <input type="checkbox" checked={pressure.enabled} onChange={(event) => setPressure({ enabled: event.target.checked })} />
        <span>メモリ圧と席数に応じて休止候補を提示する</span>
      </label>
      <div role="status" style={{ color: "var(--cmux-text-dim)", fontSize: 12, lineHeight: 1.7 }}>
        {memory === undefined ? "空きメモリを確認中です" : memory === null || !Number.isFinite(memory) || memory < 0
          ? "この環境では空きメモリを取得できないため、時間制のみで動きます" : `現在の空きメモリ: ${memory} MiB`}
        <div>圧があるときは候補の提示だけです。作業中・権限待ち・質問待ちは休止しません。</div>
      </div>
      <div style={{ display: "grid", gap: 8, marginTop: 8, fontSize: 12 }}>
        {([
          ["memoryPressureMiB", "圧を知らせる空きメモリ (MiB)"],
          ["severeMemoryMiB", "強い圧を知らせる空きメモリ (MiB)"],
          ["panePressureCount", "圧を知らせる全ペイン数"],
          ["severePaneCount", "強い圧を知らせる全ペイン数"],
          ["pressureIdleMinutes", "圧があるときの待機時間 (分)"],
          ["severeIdleMinutes", "強い圧があるときの待機時間 (分)"],
        ] as const satisfies readonly (readonly [Exclude<keyof DormancyPressureSettings, "enabled">, string])[]).map(([key, label]) => (
          <label key={key} style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ flex: 1 }}>{label}</span>
            <input type="number" min={1} step={1} aria-label={label} disabled={!pressure.enabled} value={pressure[key]}
              onChange={(event) => setPressure({ [key]: event.target.valueAsNumber })} style={{ width: 90 }} />
          </label>
        ))}
      </div>
      <label style={{ ...checkboxLabelStyle, marginTop: 12 }}>
        <input type="checkbox" checked={allowCompletion} onChange={(event) => setAllowCompletion(event.target.checked)} />
        <span>完了通知だけが未読のペインは、会話の記録を保存してから休止する</span>
      </label>
      <div style={{ color: "var(--cmux-text-dim)", fontSize: 12, lineHeight: 1.7 }}>
        完了通知は未読のまま残り、押すと会話の記録を開きます。休止は会話の再開のための状態で、プロセスは終了しています。
      </div>
    </div>
  );
}
