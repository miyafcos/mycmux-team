import { useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { useSettingsStore } from "../../stores/settingsStore";
import { runUpdateCheck, type UpdatePhase } from "../../lib/forcedAutoUpdater";
import { getRemoteInfo, rotateRemoteToken, type RemoteInfo } from "../../lib/ipc";
import { getRemoteBindAll, setRemoteBindAll } from "../../lib/ipc";

type UpdateStatus = "idle" | "checking" | "latest" | "downloading" | "ready" | "error";

function toSettingsUpdateStatus(phase: UpdatePhase): UpdateStatus {
  return phase === "skipped" ? "latest" : phase;
}

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
  const showSplitDownButton = useSettingsStore((s) => s.showSplitDownButton);
  const setShowSplitDownButton = useSettingsStore((s) => s.setShowSplitDownButton);
  const showSplitRightButton = useSettingsStore((s) => s.showSplitRightButton);
  const setShowSplitRightButton = useSettingsStore((s) => s.setShowSplitRightButton);

  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>("idle");
  const [updateMsg, setUpdateMsg] = useState<string>("");
  const [currentVersion, setCurrentVersion] = useState<string>("読み込み中…");
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [remoteInfo, setRemoteInfo] = useState<RemoteInfo | null>(null);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteMsg, setRemoteMsg] = useState<string>("");
  const [remoteBindAll, setRemoteBindAllValue] = useState(false);
  const [remoteBindAllLoading, setRemoteBindAllLoading] = useState(false);

  const loadRemoteInfo = async () => {
    setRemoteLoading(true);
    setRemoteMsg("");
    try {
      setRemoteInfo(await getRemoteInfo());
    } catch (e) {
      console.error("Failed to load remote info", e);
      setRemoteMsg("Remote 情報を取得できませんでした");
    } finally {
      setRemoteLoading(false);
    }
  };

  const handleOpenRemote = async () => {
    setRemoteOpen(true);
    await loadRemoteInfo();
    try {
      setRemoteBindAllValue(await getRemoteBindAll());
    } catch (e) {
      console.error("Failed to load remote bind-all setting", e);
    }
  };

  const handleToggleRemoteBindAll = async (checked: boolean) => {
    setRemoteBindAllLoading(true);
    try {
      const applied = await setRemoteBindAll(checked);
      setRemoteBindAllValue(applied);
      setRemoteMsg(
        applied
          ? "LAN公開をONにしました。次回アプリ再起動後に反映されます。"
          : "LAN公開をOFFにしました。次回アプリ再起動後に反映されます。"
      );
    } catch (e) {
      console.error("Failed to save remote bind-all setting", e);
      setRemoteMsg("設定の保存に失敗しました");
    } finally {
      setRemoteBindAllLoading(false);
    }
  };

  const handleRotateRemoteToken = async () => {
    if (!window.confirm("Remote token を再生成します。接続中の iPhone は切断されます。")) {
      return;
    }
    setRemoteLoading(true);
    setRemoteMsg("");
    try {
      const nextInfo = await rotateRemoteToken();
      setRemoteInfo(nextInfo);
      setRemoteOpen(true);
      setRemoteMsg(`token を再生成しました。末尾: ${nextInfo.token_suffix}`);
    } catch (e) {
      console.error("Failed to rotate remote token", e);
      setRemoteMsg("token 再生成に失敗しました");
    } finally {
      setRemoteLoading(false);
    }
  };

  const copyRemoteUrl = async () => {
    if (!remoteInfo?.url) return;
    try {
      await navigator.clipboard.writeText(remoteInfo.url);
      setRemoteMsg("URL をコピーしました");
    } catch (e) {
      console.error("Failed to copy remote URL", e);
      setRemoteMsg("URL コピーに失敗しました");
    }
  };

  const handleCheckUpdate = async () => {
    await runUpdateCheck({
      source: "manual",
      force: true,
      onStatus: (status) => {
        setUpdateStatus(toSettingsUpdateStatus(status.phase));
        setUpdateMsg(status.message);
      },
    });
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

      <button
        onClick={handleOpenRemote}
        className="cmux-menu-item"
        style={itemStyle}
      >
        <span>Remote: QR を表示</span>
        <span style={{ color: "var(--cmux-text-dim)" }}>{remoteInfo ? remoteInfo.token_suffix : ""}</span>
      </button>

      <button
        onClick={handleRotateRemoteToken}
        disabled={remoteLoading}
        className="cmux-menu-item"
        style={{
          ...itemStyle,
          opacity: remoteLoading ? 0.5 : 1,
          cursor: remoteLoading ? "wait" : "pointer",
        }}
      >
        <span>Remote: トークン再生成</span>
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
          checked={showSplitRightButton}
          onChange={(e) => setShowSplitRightButton(e.target.checked)}
        />
        <span>Split right ボタン（右に分割）を表示</span>
      </label>

      <label
        style={{
          padding: "0 12px 10px",
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
          checked={showSplitDownButton}
          onChange={(e) => setShowSplitDownButton(e.target.checked)}
        />
        <span>Split down ボタン（下に分割）を表示</span>
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
      {remoteOpen && (
        <div
          role="dialog"
          aria-modal="true"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              setRemoteOpen(false);
            }
          }}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
            background: "var(--cmux-backdrop)",
          }}
        >
          <div
            style={{
              width: "min(520px, calc(100vw - 32px))",
              maxHeight: "calc(100vh - 48px)",
              overflow: "auto",
              background: "var(--cmux-popover)",
              border: "1px solid var(--cmux-border)",
              borderRadius: 8,
              boxShadow: "var(--cmux-shadow-dialog)",
              padding: 16,
              color: "var(--cmux-text)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700 }}>Remote Access</div>
                <div style={{ fontSize: 11, color: "var(--cmux-text-dim)", marginTop: 2 }}>
                  token末尾: {remoteInfo?.token_suffix ?? "----"}
                </div>
              </div>
              <button
                onClick={() => setRemoteOpen(false)}
                style={{ ...itemStyle, width: "auto", padding: "6px 8px", border: "1px solid var(--cmux-border)", borderRadius: 6 }}
              >
                閉じる
              </button>
            </div>

            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 12,
                color: "var(--cmux-text)",
                cursor: remoteBindAllLoading ? "wait" : "pointer",
                marginBottom: 4,
              }}
            >
              <input
                type="checkbox"
                checked={remoteBindAll}
                disabled={remoteBindAllLoading}
                onChange={(e) => handleToggleRemoteBindAll(e.target.checked)}
              />
              <span>リモートを LAN に公開する（0.0.0.0 で待受）</span>
            </label>
            <div style={{ fontSize: 11, color: "var(--cmux-text-dim)", marginBottom: 10 }}>
              OFF（既定）では 127.0.0.1 のみで待受し、同一PCからしか接続できません。ON にすると同じ
              LAN / Tailscale 上の iPhone から接続できます。変更は次回アプリ再起動後に反映されます。
            </div>

            {remoteLoading && <div style={{ fontSize: 12, color: "var(--cmux-text-dim)", marginBottom: 10 }}>読み込み中…</div>}
            {remoteMsg && (
              <div style={{ fontSize: 12, color: "var(--cmux-text-dim)", marginBottom: 10 }}>
                {remoteMsg}
              </div>
            )}

            {remoteInfo && (
              <>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "center",
                    background: "#fff",
                    borderRadius: 6,
                    padding: 12,
                    marginBottom: 12,
                  }}
                  dangerouslySetInnerHTML={{ __html: remoteInfo.qr_svg }}
                />
                <div
                  style={{
                    fontFamily: "Menlo, Consolas, monospace",
                    fontSize: 11,
                    lineHeight: 1.45,
                    wordBreak: "break-all",
                    color: "var(--cmux-text)",
                    background: "color-mix(in srgb, var(--cmux-text) 10%, transparent)",
                    border: "1px solid var(--cmux-border)",
                    borderRadius: 6,
                    padding: 10,
                    marginBottom: 10,
                  }}
                >
                  {remoteInfo.url}
                </div>
                <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                  <button onClick={copyRemoteUrl} style={{ ...itemStyle, width: "auto", border: "1px solid var(--cmux-border)", borderRadius: 6 }}>
                    URLをコピー
                  </button>
                  <button onClick={loadRemoteInfo} style={{ ...itemStyle, width: "auto", border: "1px solid var(--cmux-border)", borderRadius: 6 }}>
                    更新
                  </button>
                </div>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>接続中クライアント</div>
                {remoteInfo.connected_clients.length === 0 ? (
                  <div style={{ fontSize: 12, color: "var(--cmux-text-dim)" }}>接続中の iPhone はありません</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {remoteInfo.connected_clients.map((client) => (
                      <div
                        key={client.id}
                        style={{
                          display: "grid",
                          gridTemplateColumns: "1fr auto",
                          gap: 6,
                          padding: 8,
                          border: "1px solid var(--cmux-border)",
                          borderRadius: 6,
                          fontSize: 12,
                        }}
                      >
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {client.peer_addr}
                        </span>
                        <span style={{ color: "var(--cmux-text-dim)" }}>
                          {new Date(client.connected_at).toLocaleTimeString()}
                        </span>
                        <span style={{ gridColumn: "1 / -1", color: "var(--cmux-text-dim)", fontFamily: "Menlo, Consolas, monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {client.attached_session_id ?? "dashboard"}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Resume (CRSM Palette) per-kind visibility checkboxes. Mirrors the
// notification checkbox styling for visual consistency.
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
