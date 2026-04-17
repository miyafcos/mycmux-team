import { useEffect, useRef } from "react";
import { useSettingsStore } from "../../stores/settingsStore";

interface SettingsMenuProps {
  onClose: () => void;
  onOpenThemes: () => void;
  onOpenKeybindings: () => void;
  onOpenCommandPalette: () => void;
}

const itemStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 12px",
  background: "transparent",
  border: "none",
  color: "var(--cmux-text)",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  fontSize: 12,
  textAlign: "left",
};

export default function SettingsMenu({
  onClose,
  onOpenThemes,
  onOpenKeybindings,
  onOpenCommandPalette,
}: SettingsMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const notificationsEnabled = useSettingsStore((s) => s.notificationsEnabled);
  const setNotificationsEnabled = useSettingsStore((s) => s.setNotificationsEnabled);
  const notificationSoundEnabled = useSettingsStore((s) => s.notificationSoundEnabled);
  const setNotificationSoundEnabled = useSettingsStore((s) => s.setNotificationSoundEnabled);
  const buddyEnabled = useSettingsStore((s) => s.buddyEnabled);
  const setBuddyEnabled = useSettingsStore((s) => s.setBuddyEnabled);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      style={{
        position: "absolute",
        top: "100%",
        right: 0,
        marginTop: 4,
        width: 260,
        background: "var(--cmux-sidebar)",
        border: "1px solid var(--cmux-border)",
        borderRadius: 6,
        zIndex: 100,
        boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
        fontSize: 12,
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        color: "var(--cmux-text)",
        overflow: "hidden",
      }}
    >
      <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--cmux-border)", fontWeight: 600, fontSize: 11 }}>
        Settings
      </div>

      <button
        onClick={() => {
          onOpenThemes();
          onClose();
        }}
        style={itemStyle}
        onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.05)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
      >
        <span>Themes</span>
      </button>

      <button
        onClick={() => {
          onOpenKeybindings();
          onClose();
        }}
        style={itemStyle}
        onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.05)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
      >
        <span>Keybindings</span>
      </button>

      <button
        onClick={() => {
          onOpenCommandPalette();
          onClose();
        }}
        style={itemStyle}
        onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.05)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
      >
        <span>Command palette</span>
      </button>

      <div style={{ height: 1, background: "var(--cmux-border)" }} />

      <label
        style={{
          padding: "10px 12px 4px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 12,
          color: "var(--cmux-text)",
          cursor: "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={notificationsEnabled}
          onChange={(e) => setNotificationsEnabled(e.target.checked)}
        />
        <span>通知</span>
      </label>

      <label
        style={{
          padding: "4px 12px 10px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 12,
          color: notificationsEnabled ? "var(--cmux-text)" : "var(--cmux-text-dim, rgba(255,255,255,0.4))",
          cursor: notificationsEnabled ? "pointer" : "not-allowed",
        }}
      >
        <input
          type="checkbox"
          checked={notificationSoundEnabled}
          disabled={!notificationsEnabled}
          onChange={(e) => setNotificationSoundEnabled(e.target.checked)}
        />
        <span>通知サウンド</span>
      </label>

      <div style={{ height: 1, background: "var(--cmux-border)" }} />

      <label
        style={{
          padding: "10px 12px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 12,
          color: "var(--cmux-text)",
          cursor: "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={buddyEnabled}
          onChange={(e) => setBuddyEnabled(e.target.checked)}
        />
        <span>Claude Buddy</span>
      </label>
    </div>
  );
}
