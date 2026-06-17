import { useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { useSettingsStore } from "../../stores/settingsStore";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

type UpdateStatus = "idle" | "checking" | "latest" | "downloading" | "ready" | "error";

interface SettingsMenuProps {
  onClose: () => void;
  onOpenThemes: () => void;
  onOpenKeybindings: () => void;
  onOpenCrsmPalette?: () => void;
}

const itemStyle: React.CSSProperties = {
  width: "100%",
  padding: "var(--cmux-space-4) var(--cmux-space-6)",
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
  onOpenCrsmPalette,
}: SettingsMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const notificationsEnabled = useSettingsStore((s) => s.notificationsEnabled);
  const setNotificationsEnabled = useSettingsStore((s) => s.setNotificationsEnabled);
  const notificationSoundEnabled = useSettingsStore((s) => s.notificationSoundEnabled);
  const setNotificationSoundEnabled = useSettingsStore((s) => s.setNotificationSoundEnabled);

  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>("idle");
  const [updateMsg, setUpdateMsg] = useState<string>("");
  const [currentVersion, setCurrentVersion] = useState<string>("読み込み中…");

  const handleCheckUpdate = async () => {
    setUpdateStatus("checking");
    setUpdateMsg("確認中…");
    try {
      const update = await check();
      if (update) {
        setUpdateMsg(`更新があります: v${update.version}`);
        await new Promise((resolve) => window.setTimeout(resolve, 150));
        setUpdateStatus("downloading");
        setUpdateMsg(`v${update.version} を取得中…`);
        await update.downloadAndInstall();
        setUpdateStatus("ready");
        setUpdateMsg("インストール完了。再起動します…");
        await relaunch();
      } else {
        setUpdateStatus("latest");
        setUpdateMsg("最新版です");
      }
    } catch (e) {
      console.error("Failed to check or install update", e);
      setUpdateStatus("error");
      setUpdateMsg("更新に失敗しました");
    }
  };

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;

    getVersion()
      .then((version) => {
        if (!cancelled) {
          setCurrentVersion(`v${version}`);
        }
      })
      .catch((e) => {
        console.error("Failed to load app version", e);
        if (!cancelled) {
          setCurrentVersion("不明");
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div
      ref={menuRef}
      style={{
        position: "absolute",
        top: "100%",
        right: 0,
        marginTop: "var(--cmux-space-2)",
        width: 260,
        background: "var(--cmux-popover)",
        border: "1px solid var(--cmux-border)",
        borderRadius: "var(--cmux-radius-md)",
        zIndex: 100,
        boxShadow: "var(--cmux-shadow-popover)",
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
        className="cmux-menu-item"
        style={itemStyle}
      >
        <span>Themes</span>
      </button>

      <button
        onClick={() => {
          onOpenKeybindings();
          onClose();
        }}
        className="cmux-menu-item"
        style={itemStyle}
      >
        <span>Keybindings</span>
      </button>

      <div style={{ height: 1, background: "var(--cmux-border)" }} />

      <label
        style={{
          padding: "10px 12px",
          display: "flex",
          alignItems: "flex-start",
          gap: 8,
          fontSize: 12,
          color: "var(--cmux-text)",
          cursor: "default",
        }}
      >
        <input
          type="checkbox"
          checked={false}
          disabled
          style={{ marginTop: 2 }}
        />
        <span style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
          <span>Terminal renderer (stable DOM)</span>
          <span style={{ fontSize: 11, lineHeight: 1.35, color: "var(--cmux-text-dim, rgba(255,255,255,0.55))" }}>
            WebGL is disabled to prevent missing text in multi-pane Windows sessions.
          </span>
        </span>
      </label>

      <div style={{ height: 1, background: "var(--cmux-border)" }} />

      {onOpenCrsmPalette && (
        <>
          <button
            onClick={() => {
              onOpenCrsmPalette();
              onClose();
            }}
            className="cmux-menu-item"
            style={itemStyle}
          >
            <span>Resume</span>
            <span style={{ color: "var(--cmux-text-dim, rgba(255,255,255,0.55))", fontSize: 11 }}>Ctrl+P</span>
          </button>
          <CrsmPaletteSection />
        </>
      )}

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
          color: notificationsEnabled ? "var(--cmux-text)" : "var(--cmux-text-dim)",
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

      <div style={{ padding: "8px 12px 0", fontSize: 11, color: "var(--cmux-text-dim, rgba(255,255,255,0.55))" }}>
        現在のバージョン: {currentVersion}
      </div>

      <button
        onClick={handleCheckUpdate}
        disabled={updateStatus === "checking" || updateStatus === "downloading"}
        className="cmux-menu-item"
        style={{
          ...itemStyle,
          opacity: (updateStatus === "checking" || updateStatus === "downloading") ? 0.5 : 1,
          cursor: (updateStatus === "checking" || updateStatus === "downloading") ? "wait" : "pointer",
        }}
      >
        <span>更新を確認</span>
      </button>
      {updateMsg && (
        <div style={{
          padding: "0 12px 8px",
          fontSize: 11,
          color: updateStatus === "error"
            ? "var(--cmux-red)"
            : "var(--cmux-text-dim)",
        }}>
          {updateMsg}
        </div>
      )}
    </div>
  );
}

// Resume (CRSM Palette) per-kind visibility checkboxes. Mirrors the
// existing notification checkbox styling for visual consistency.
function CrsmPaletteSection() {
  const showClaude = useSettingsStore((s) => s.crsmShowClaude);
  const showCodex = useSettingsStore((s) => s.crsmShowCodex);
  const showClaudeCodex = useSettingsStore((s) => s.crsmShowClaudeCodex);
  const hideSessionsWithoutUserMessages = useSettingsStore((s) => s.hideSessionsWithoutUserMessages);
  const setShowClaude = useSettingsStore((s) => s.setCrsmShowClaude);
  const setShowCodex = useSettingsStore((s) => s.setCrsmShowCodex);
  const setShowClaudeCodex = useSettingsStore((s) => s.setCrsmShowClaudeCodex);
  const setHideSessionsWithoutUserMessages = useSettingsStore(
    (s) => s.setHideSessionsWithoutUserMessages,
  );

  const rows: Array<{ label: string; checked: boolean; onChange: (v: boolean) => void }> = [
    { label: "Claude Code", checked: showClaude, onChange: setShowClaude },
    { label: "Codex", checked: showCodex, onChange: setShowCodex },
    { label: "Hybrid (Claude+Codex)", checked: showClaudeCodex, onChange: setShowClaudeCodex },
    {
      label: "Hide sessions without user messages",
      checked: hideSessionsWithoutUserMessages,
      onChange: setHideSessionsWithoutUserMessages,
    },
  ];

  return (
    <>
      <div
        style={{
          padding: "10px 12px 4px",
          fontSize: 11,
          fontWeight: 600,
          color: "var(--cmux-text-dim, rgba(255,255,255,0.55))",
        }}
      >
        Resume で表示する種類
      </div>
      {rows.map((row, idx) => (
        <label
          key={row.label}
          style={{
            padding: idx === rows.length - 1 ? "4px 12px 10px" : "4px 12px",
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
            checked={row.checked}
            onChange={(e) => row.onChange(e.target.checked)}
          />
          <span>{row.label}</span>
        </label>
      ))}
    </>
  );
}
