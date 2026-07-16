import { useSettingsStore } from "../../../stores/settingsStore";
import { checkboxLabelStyle, checkboxLabelStyleFor, sectionHeadingStyle } from "../tabStyles";

// Ported from SettingsMenu.tsx: notification checkboxes (with the exact
// parent/child disabled+dim pattern for 通知 -> 通知サウンド) plus the pane
// split-button visibility toggles, now with pure Japanese labels.
export function NotificationsLayoutTab() {
  const notificationsEnabled = useSettingsStore((s) => s.notificationsEnabled);
  const setNotificationsEnabled = useSettingsStore((s) => s.setNotificationsEnabled);
  const notificationSoundEnabled = useSettingsStore((s) => s.notificationSoundEnabled);
  const setNotificationSoundEnabled = useSettingsStore((s) => s.setNotificationSoundEnabled);
  const showSplitRightButton = useSettingsStore((s) => s.showSplitRightButton);
  const setShowSplitRightButton = useSettingsStore((s) => s.setShowSplitRightButton);
  const showSplitDownButton = useSettingsStore((s) => s.showSplitDownButton);
  const setShowSplitDownButton = useSettingsStore((s) => s.setShowSplitDownButton);

  return (
    <div>
      <div style={sectionHeadingStyle}>通知</div>
      <label style={checkboxLabelStyle}>
        <input
          type="checkbox"
          checked={notificationsEnabled}
          onChange={(e) => setNotificationsEnabled(e.target.checked)}
        />
        <span>通知</span>
      </label>
      <label style={checkboxLabelStyleFor(notificationsEnabled)}>
        <input
          type="checkbox"
          checked={notificationSoundEnabled}
          disabled={!notificationsEnabled}
          onChange={(e) => setNotificationSoundEnabled(e.target.checked)}
        />
        <span>通知サウンド</span>
      </label>

      <div style={{ ...sectionHeadingStyle, marginTop: 20 }}>レイアウト</div>
      <label style={checkboxLabelStyle}>
        <input
          type="checkbox"
          checked={showSplitRightButton}
          onChange={(e) => setShowSplitRightButton(e.target.checked)}
        />
        <span>「右に分割」ボタンを表示</span>
      </label>
      <label style={checkboxLabelStyle}>
        <input
          type="checkbox"
          checked={showSplitDownButton}
          onChange={(e) => setShowSplitDownButton(e.target.checked)}
        />
        <span>「下に分割」ボタンを表示</span>
      </label>
    </div>
  );
}
