import { useEffect, useState } from "react";
import {
  jevErrorMessage, loadJevSettings, saveJevSettings, testJevConnection, useJevSettingsStore,
} from "../../../stores/jevSettingsStore";
import { checkboxLabelStyle, dividerStyle, sectionHeadingStyle } from "../tabStyles";

const field = { width: "100%", maxWidth: 420, padding: "7px 9px", fontSize: 12 } as const;
const hint = { fontSize: 11, lineHeight: 1.65, color: "var(--cmux-text-dim)" } as const;

export function JevSettingsSection({ aiEnabled }: { aiEnabled: boolean }) {
  const settings = useJevSettingsStore();
  const [enabled, setEnabled] = useState(settings.enabled);
  const [model, setModel] = useState(settings.model);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { void loadJevSettings().catch(() => undefined); }, []);
  useEffect(() => {
    if (settings.loaded) { setEnabled(settings.enabled); setModel(settings.model); }
  }, [settings.loaded, settings.revision, settings.enabled, settings.model]);
  const run = async (action: "save" | "test") => {
    setBusy(action); setMessage(""); setError("");
    try {
      if (action === "test") {
        const ms = await testJevConnection(model, apiKey);
        setMessage(`Jevに接続できました（${(ms / 1000).toFixed(2)}秒）。`);
      } else {
        await saveJevSettings(enabled, model, apiKey);
        setApiKey("");
        setMessage(enabled ? "保存しました。次のペイン再配置からJevを使います。" : "保存しました。ペイン再配置は従来のAIを使います。");
      }
    } catch (caught) { setError(jevErrorMessage(caught)); }
    finally { setBusy(null); }
  };
  return <section aria-labelledby="jev-settings-heading">
    <div style={dividerStyle} />
    <h3 id="jev-settings-heading" style={sectionHeadingStyle}>ペイン再配置 — Jev</h3>
    <p style={hint}>関連するタスクを見つけて、案件別・役割別・移動を抑えた3つの配置案を作ります。</p>
    <label style={checkboxLabelStyle}>
      <input type="checkbox" checked={enabled} disabled={!aiEnabled || Boolean(busy) || !settings.loaded}
        onChange={(event) => setEnabled(event.target.checked)} />
      <span>ペイン再配置にJevを使う</span>
    </label>
    {!aiEnabled ? <p style={hint}>上の「AI機能を有効にする」をオンにすると利用できます。</p> : null}
    <div style={{ display: "grid", gap: 12, marginTop: 14 }}>
      <label style={{ display: "grid", gap: 5, fontSize: 12 }}>
        接続先
        <select aria-label="Jevの接続先" value="openrouter" disabled style={field}>
          <option value="openrouter">OpenRouter</option>
        </select>
      </label>
      <label style={{ display: "grid", gap: 5, fontSize: 12 }}>
        OpenRouter APIキー
        <input type="password" value={apiKey} autoComplete="off" spellCheck={false} disabled={Boolean(busy)}
          placeholder={settings.hasApiKey ? "登録済み（変更するときだけ入力）" : "sk-or-…"}
          onChange={(event) => setApiKey(event.target.value)} style={field} />
      </label>
      <div style={hint}>{settings.hasApiKey ? "キーは登録済みです。" : "OpenRouterで発行したキーを入力してください。"} キーはこの端末で保護して保存します。</div>
      <label style={{ display: "grid", gap: 5, fontSize: 12 }}>
        Jevのモデル
        <input value={model} autoComplete="off" spellCheck={false} disabled={Boolean(busy)}
          onChange={(event) => setModel(event.target.value)} style={field} />
      </label>
      <div style={hint}>再配置時に、ペインの画面末尾12行・名前・作業フォルダ・親子関係をOpenRouter経由で送ります。接続テストは短い確認データだけを送り、少額のAPI利用料が発生します。</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" disabled={Boolean(busy) || (!apiKey.trim() && !settings.hasApiKey)}
          onClick={() => void run("test")}>{busy === "test" ? "接続を確認中…" : "接続テスト"}</button>
        <button type="button" disabled={Boolean(busy) || !settings.loaded || (enabled && !apiKey.trim() && !settings.hasApiKey)}
          onClick={() => void run("save")}>{busy === "save" ? "保存中…" : "Jev設定を保存"}</button>
        {!settings.loaded && settings.error ? <button type="button" onClick={() => void loadJevSettings().catch(() => undefined)}>設定を再読み込み</button> : null}
      </div>
      {error || settings.error ? <div role="alert" style={{ ...hint, color: "var(--cmux-usage-warn)" }}>{error || settings.error}</div> : null}
      {message ? <div role="status" style={hint}>{message}</div> : null}
    </div>
  </section>;
}
