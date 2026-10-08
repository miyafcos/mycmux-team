import { useSettingsStore } from "../../../stores/settingsStore";
import { supportsNativePaneTearout, isMacTearoutPlatform } from "../../../lib/tearout/feature";
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
  const toastAiActivityEnabled = useSettingsStore((s) => s.toastAiActivityEnabled);
  const setToastAiActivityEnabled = useSettingsStore((s) => s.setToastAiActivityEnabled);
  const toastUserActionEnabled = useSettingsStore((s) => s.toastUserActionEnabled);
  const setToastUserActionEnabled = useSettingsStore((s) => s.setToastUserActionEnabled);
  const toastSystemEnabled = useSettingsStore((s) => s.toastSystemEnabled);
  const setToastSystemEnabled = useSettingsStore((s) => s.setToastSystemEnabled);
  const showSplitRightButton = useSettingsStore((s) => s.showSplitRightButton);
  const setShowSplitRightButton = useSettingsStore((s) => s.setShowSplitRightButton);
  const showSplitDownButton = useSettingsStore((s) => s.showSplitDownButton);
  const setShowSplitDownButton = useSettingsStore((s) => s.setShowSplitDownButton);
  const groupingApplyAnimationEnabled = useSettingsStore((s) => s.groupingApplyAnimationEnabled);
  const setGroupingApplyAnimationEnabled = useSettingsStore((s) => s.setGroupingApplyAnimationEnabled);
  const paneComposerEnabled = useSettingsStore((s) => s.paneComposerEnabled);
  const setPaneComposerEnabled = useSettingsStore((s) => s.setPaneComposerEnabled);
  const showTerminalHistoryButton = useSettingsStore((s) => s.showTerminalHistoryButton);
  const setShowTerminalHistoryButton = useSettingsStore((s) => s.setShowTerminalHistoryButton);
  const terminalProgressDiagnosticsEnabled = useSettingsStore((s) => s.terminalProgressDiagnosticsEnabled);
  const setTerminalProgressDiagnosticsEnabled = useSettingsStore((s) => s.setTerminalProgressDiagnosticsEnabled);
  const nativePaneTearoutEnabled = useSettingsStore((s) => s.nativePaneTearoutEnabled);
  const setNativePaneTearoutEnabled = useSettingsStore((s) => s.setNativePaneTearoutEnabled);

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
      <div style={{ color: "var(--cmux-text-dim)", fontSize: 12, marginTop: 4 }}>
        {notificationSettingsStrings.enabledHint}
      </div>

      <div style={{ ...sectionHeadingStyle, marginTop: 20 }}>
        {notificationSettingsStrings.toastCategoryTitle}
      </div>
      <label style={checkboxLabelStyleFor(notificationsEnabled)}>
        <input
          type="checkbox"
          checked={toastAiActivityEnabled}
          disabled={!notificationsEnabled}
          onChange={(e) => setToastAiActivityEnabled(e.target.checked)}
        />
        <span>{notificationSettingsStrings.toastAiActivityLabel}</span>
      </label>
      <label style={checkboxLabelStyleFor(notificationsEnabled)}>
        <input
          type="checkbox"
          checked={toastUserActionEnabled}
          disabled={!notificationsEnabled}
          onChange={(e) => setToastUserActionEnabled(e.target.checked)}
        />
        <span>{notificationSettingsStrings.toastUserActionLabel}</span>
      </label>
      <label style={checkboxLabelStyleFor(notificationsEnabled)}>
        <input
          type="checkbox"
          checked={toastSystemEnabled}
          disabled={!notificationsEnabled}
          onChange={(e) => setToastSystemEnabled(e.target.checked)}
        />
        <span>{notificationSettingsStrings.toastSystemLabel}</span>
      </label>
      <div style={{ color: "var(--cmux-text-dim)", fontSize: 12, marginTop: 4 }}>
        {notificationSettingsStrings.toastFailureAlwaysShownHint}
      </div>

      <div style={{ ...sectionHeadingStyle, marginTop: 20 }}>{notificationSettingsStrings.layoutTitle}</div>
      {supportsNativePaneTearout() && (
        <label style={checkboxLabelStyle}>
          <input type="checkbox" checked={nativePaneTearoutEnabled}
            onChange={(e) => setNativePaneTearoutEnabled(e.target.checked)} />
          <span>{isMacTearoutPlatform() ? "Mac\u306e\u7a93\u306e\u5207\u308a\u96e2\u3057\u3092\u65b0\u3057\u3044\u52d5\u304d\u306b\u3059\u308b (\u8a66\u9a13\u4e2d)" : notificationSettingsStrings.nativePaneTearoutLabel}</span>
        </label>
      )}
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
      <label style={checkboxLabelStyle}>
        <input
          type="checkbox"
          checked={groupingApplyAnimationEnabled}
          onChange={(e) => setGroupingApplyAnimationEnabled(e.target.checked)}
        />
        <span>{notificationSettingsStrings.groupingApplyAnimationLabel}</span>
      </label>
      <div style={{ color: "var(--cmux-text-dim)", fontSize: 12, marginTop: 4 }}>
        {notificationSettingsStrings.groupingApplyAnimationHint}
      </div>

      <div style={{ ...sectionHeadingStyle, marginTop: 20 }}>{notificationSettingsStrings.terminalInputTitle}</div>
      <label style={checkboxLabelStyle}>
        <input type="checkbox" checked={showTerminalHistoryButton}
          onChange={(e) => setShowTerminalHistoryButton(e.target.checked)} />
        <span>{notificationSettingsStrings.terminalHistoryLabel}</span>
      </label>
      <div style={{ color: "var(--cmux-text-dim)", fontSize: 12, marginTop: 4 }}>
        {notificationSettingsStrings.terminalHistoryHint}
      </div>
      <label style={checkboxLabelStyle}>
        <input type="checkbox" checked={terminalProgressDiagnosticsEnabled}
          onChange={(e) => setTerminalProgressDiagnosticsEnabled(e.target.checked)} />
        <span>{notificationSettingsStrings.terminalProgressDiagnosticsLabel}</span>
      </label>
      <div style={{ color: "var(--cmux-text-dim)", fontSize: 12, marginTop: 4 }}>
        {notificationSettingsStrings.terminalProgressDiagnosticsHint}
      </div>
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
