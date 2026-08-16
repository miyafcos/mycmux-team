import { useSettingsStore } from "../../../stores/settingsStore";
import { notificationSettingsStrings } from "../settingsStrings";
import { checkboxLabelStyle, checkboxLabelStyleFor, sectionHeadingStyle } from "../tabStyles";

// Ported from SettingsMenu.tsx: notification checkboxes (with the exact
// parent/child disabled+dim pattern for 通知 -> 通知サウンド) plus the pane
// split-button visibility toggles, now with pure Japanese labels.
export function NotificationsLayoutTab() {
  const notificationsEnabled = useSettingsStore((s) => s.notificationsEnabled);
  const setNotificationsEnabled = useSettingsStore((s) => s.setNotificationsEnabled);
  const notificationSoundEnabled = useSettingsStore((s) => s.notificationSoundEnabled);
  const setNotificationSoundEnabled = useSettingsStore((s) => s.setNotificationSoundEnabled);
  const dispatchWatchdogNotify = useSettingsStore((s) => s.dispatchWatchdogNotify);
  const setDispatchWatchdogNotify = useSettingsStore((s) => s.setDispatchWatchdogNotify);
  const showSplitRightButton = useSettingsStore((s) => s.showSplitRightButton);
  const setShowSplitRightButton = useSettingsStore((s) => s.setShowSplitRightButton);
  const showSplitDownButton = useSettingsStore((s) => s.showSplitDownButton);
  const setShowSplitDownButton = useSettingsStore((s) => s.setShowSplitDownButton);
  const paneComposerEnabled = useSettingsStore((s) => s.paneComposerEnabled);
  const setPaneComposerEnabled = useSettingsStore((s) => s.setPaneComposerEnabled);

  return (
    <div>
      <div style={sectionHeadingStyle}>{notificationSettingsStrings.title}</div>
      <label style={checkboxLabelStyle}>
        <input
          type="checkbox"
          checked={notificationsEnabled}
          onChange={(e) => setNotificationsEnabled(e.target.checked)}
        />
        <span>{notificationSettingsStrings.enabledLabel}</span>
      </label>
      <label style={checkboxLabelStyleFor(notificationsEnabled)}>
        <input
          type="checkbox"
          checked={notificationSoundEnabled}
          disabled={!notificationsEnabled}
          onChange={(e) => setNotificationSoundEnabled(e.target.checked)}
        />
        <span>{notificationSettingsStrings.soundLabel}</span>
      </label>

      <div style={{ ...sectionHeadingStyle, marginTop: 20 }}>{notificationSettingsStrings.delegationWatchTitle}</div>
      <label style={checkboxLabelStyleFor(notificationsEnabled)}>
        <input
          type="checkbox"
          checked={dispatchWatchdogNotify}
          disabled={!notificationsEnabled}
          onChange={(e) => setDispatchWatchdogNotify(e.target.checked)}
        />
        <span>{notificationSettingsStrings.delegationWatchLabel}</span>
      </label>
      <div style={{ color: "var(--cmux-text-dim)", fontSize: 12, marginTop: 4 }}>
        {notificationSettingsStrings.delegationWatchHint}
      </div>

      <div style={{ ...sectionHeadingStyle, marginTop: 20 }}>{notificationSettingsStrings.layoutTitle}</div>
      <label style={checkboxLabelStyle}>
        <input
          type="checkbox"
          checked={showSplitRightButton}
          onChange={(e) => setShowSplitRightButton(e.target.checked)}
        />
        <span>{notificationSettingsStrings.splitRightLabel}</span>
      </label>
      <label style={checkboxLabelStyle}>
        <input
          type="checkbox"
          checked={showSplitDownButton}
          onChange={(e) => setShowSplitDownButton(e.target.checked)}
        />
        <span>{notificationSettingsStrings.splitDownLabel}</span>
      </label>

      <div style={{ ...sectionHeadingStyle, marginTop: 20 }}>{notificationSettingsStrings.terminalInputTitle}</div>
      <label style={checkboxLabelStyle}>
        <input
          type="checkbox"
          checked={paneComposerEnabled}
          onChange={(e) => setPaneComposerEnabled(e.target.checked)}
        />
        <span>{notificationSettingsStrings.paneComposerLabel}</span>
      </label>
      <div style={{ color: "var(--cmux-text-dim)", fontSize: 12, marginTop: 4 }}>
        {notificationSettingsStrings.paneComposerHint}
      </div>
    </div>
  );
}
