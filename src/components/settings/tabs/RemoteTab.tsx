import { useEffect, useState } from "react";
import { getRemoteBindAll, getRemoteInfo, rotateRemoteToken, setRemoteBindAll, type RemoteInfo } from "../../../lib/ipc";
import { settingsStrings } from "../settingsStrings";
import { dialogButtonStyle, sectionHeadingStyle } from "../tabStyles";

// Ported from SettingsMenu.tsx's nested Remote Access modal — now rendered
// directly as the tab body instead of a second popup. Info loads once when
// the tab first mounts (i.e. becomes active, since SettingsDialog only
// renders the active tab). Token rotation is visually separated as a
// "危険な操作" danger zone at the bottom, per the settings-hierarchy audit.
export function RemoteTab() {
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

  useEffect(() => {
    void loadRemoteInfo();
    getRemoteBindAll()
      .then(setRemoteBindAllValue)
      .catch((e) => console.error("Failed to load remote bind-all setting", e));
    // Load once when this tab becomes active (mount-triggered).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  return (
    <div>
      <div style={sectionHeadingStyle}>{settingsStrings.remoteTabLabel}</div>
      <div style={{ maxWidth: "min(900px, 100%)", fontSize: 11, lineHeight: 1.65, color: "var(--cmux-text-dim)", marginBottom: 12 }}>
        {settingsStrings.remoteDescription}
      </div>
      <div style={{ fontSize: 11, color: "var(--cmux-text-dim)", marginBottom: 12 }}>
        token末尾: {remoteInfo?.token_suffix ?? "----"}
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
      <div style={{ fontSize: 11, color: "var(--cmux-text-dim)", marginBottom: 14 }}>
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
              maxWidth: 260,
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
          <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
            <button onClick={copyRemoteUrl} style={dialogButtonStyle}>
              URLをコピー
            </button>
            <button onClick={loadRemoteInfo} style={dialogButtonStyle}>
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
                  <span
                    style={{
                      gridColumn: "1 / -1",
                      color: "var(--cmux-text-dim)",
                      fontFamily: "Menlo, Consolas, monospace",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {client.attached_session_id ?? "dashboard"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <div
        style={{
          marginTop: 28,
          paddingTop: 16,
          borderTop: "1px solid var(--cmux-border)",
        }}
      >
        <div style={{ ...sectionHeadingStyle, color: "var(--cmux-red)" }}>危険な操作</div>
        <button
          onClick={handleRotateRemoteToken}
          disabled={remoteLoading}
          style={{
            ...dialogButtonStyle,
            borderColor: "var(--cmux-red)",
            color: "var(--cmux-red)",
            opacity: remoteLoading ? 0.5 : 1,
            cursor: remoteLoading ? "wait" : "pointer",
          }}
        >
          トークン再生成
        </button>
        <div style={{ fontSize: 11, color: "var(--cmux-text-dim)", marginTop: 6 }}>
          接続中の iPhone はすべて切断されます。
        </div>
      </div>
    </div>
  );
}
