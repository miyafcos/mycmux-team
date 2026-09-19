import { useEffect, useState } from "react";
import { getPocketEntry, type PocketEntry } from "../../../lib/ipc";
import { settingsStrings } from "../settingsStrings";
import { dialogButtonStyle, sectionHeadingStyle } from "../tabStyles";

// Replaces the old Remote tab, which showed a token URL into mycmux's own
// mobile web UI (removed 2026-09). The phone app is a separate service, so
// this panel only shows the QR that opens it. Scanning lands in the phone's
// browser: the iOS app's Universal Links entitlement is written but not
// signed into the build, so no hand-off happens yet (see pocket.rs).
export function PocketTab() {
  const [entry, setEntry] = useState<PocketEntry | null>(null);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");

  const loadEntry = async () => {
    setLoading(true);
    setMsg("");
    try {
      setEntry(await getPocketEntry());
    } catch (e) {
      console.error("Failed to resolve the pocket entry", e);
      setMsg("入口を確認できませんでした");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Load once when this tab becomes active (SettingsDialog only renders
    // the active tab, so mounting is the trigger).
    void loadEntry();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const copyUrl = async () => {
    if (!entry?.url) return;
    try {
      await navigator.clipboard.writeText(entry.url);
      setMsg("URL をコピーしました");
    } catch (e) {
      console.error("Failed to copy the pocket URL", e);
      setMsg("URL コピーに失敗しました");
    }
  };

  return (
    <div>
      <div style={sectionHeadingStyle}>{settingsStrings.pocketTabLabel}</div>
      <div
        style={{
          maxWidth: "min(900px, 100%)",
          fontSize: 11,
          lineHeight: 1.65,
          color: "var(--cmux-text-dim)",
          marginBottom: 14,
        }}
      >
        {settingsStrings.pocketDescription}
      </div>

      {loading && (
        <div style={{ fontSize: 12, color: "var(--cmux-text-dim)", marginBottom: 10 }}>
          読み込み中…
        </div>
      )}
      {msg && (
        <div style={{ fontSize: 12, color: "var(--cmux-text-dim)", marginBottom: 10 }}>{msg}</div>
      )}

      {entry && entry.url ? (
        <>
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              background: "#fff",
              borderRadius: 6,
              padding: 12,
              marginBottom: 12,
              maxWidth: 260,
            }}
            dangerouslySetInnerHTML={{ __html: entry.qr_svg }}
          />
          <div
            style={{
              fontFamily: "var(--cmux-font-mono)",
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
            {entry.url}
          </div>
          {!entry.reachable && (
            <div
              style={{
                fontSize: 11,
                lineHeight: 1.65,
                color: "var(--cmux-red)",
                marginBottom: 10,
              }}
            >
              {settingsStrings.pocketUnreachableNote}
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={copyUrl} style={dialogButtonStyle}>
              URLをコピー
            </button>
            <button onClick={loadEntry} style={dialogButtonStyle}>
              更新
            </button>
          </div>
        </>
      ) : (
        !loading && (
          <div
            style={{
              border: "1px solid var(--cmux-border)",
              borderRadius: 6,
              padding: 12,
              fontSize: 12,
              lineHeight: 1.65,
              color: "var(--cmux-text)",
            }}
          >
            <div style={{ marginBottom: 8 }}>{settingsStrings.pocketMissingHeading}</div>
            <div style={{ color: "var(--cmux-text-dim)", marginBottom: 10 }}>
              {settingsStrings.pocketMissingBody}
            </div>
            <button onClick={loadEntry} style={dialogButtonStyle}>
              更新
            </button>
          </div>
        )
      )}
    </div>
  );
}
