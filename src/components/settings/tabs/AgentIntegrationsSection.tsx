import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  agentHooksSet, agentHooksStatus,
  type AgentHooksStatus, type HookProvider,
} from "../../../lib/agentHooksApi";

const copy = {
  title: "エージェント連携",
  lead: "mycmux は各エージェントの設定ファイルに hook を入れ、作業中・完了・質問の状態を受け取ります。エージェントごとに入れるか外すかを選べます。",
  agents: { claude: "Claude Code", codex: "Codex", grok: "Grok" },
  labels: { installed: "入っています", disabled: "外しています", unavailable: "使えません", "needs-repair": "直す必要があります" },
  reasons: {
    duplicate: "同じ hook が 2 つ以上あります",
    missing: "足りない hook があります",
    "helper-path": "hook の呼び先が違います",
    untrusted: "Codex の側でまだ許可されていません",
    "unknown-shape": "設定ファイルの形を読み取れないため、書き換えていません",
  },
  buttons: { enable: "入れる", repair: "直す", disable: "外す", busy: "変更中…", loading: "確認中…", retry: "再確認" },
  confirmDisable: "{agent} の設定ファイルから mycmux の hook を外します。ほかの hook はそのまま残ります。",
  execute: "外す", cancel: "やめる",
  error: "変更できませんでした。再確認してからもう一度お試しください。",
  statusError: "状態を確認できませんでした。",
};
const buttonStyle: CSSProperties = {
  padding: "var(--cmux-space-2) var(--cmux-space-4)", fontSize: "var(--cmux-font-size-sm)",
};
export function AgentIntegrationsSection() {
  const [status, setStatus] = useState<AgentHooksStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<HookProvider | null>(null);
  const running = useRef(false);
  const mounted = useRef(false);
  const refresh = async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      const next = await agentHooksStatus();
      if (mounted.current) { setStatus(next); setError(""); }
    } catch {
      if (mounted.current) setError(copy.statusError);
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; };
  }, []);
  const run = async (provider: HookProvider, enabled: boolean) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setConfirm(null);
    setError("");
    try {
      const next = await agentHooksSet(provider, enabled);
      if (mounted.current) setStatus(next);
    } catch {
      if (mounted.current) setError(copy.error);
      try {
        const next = await agentHooksStatus();
        if (mounted.current) setStatus(next);
      } catch { /* Keep the action error visible if the refresh also fails. */ }
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <section aria-label={copy.title} aria-busy={busy} style={{
      display: "grid", gap: "var(--cmux-space-5)", padding: "var(--cmux-space-6)",
      border: "1px solid var(--cmux-border-hairline)", borderRadius: "var(--cmux-radius-card)",
      fontSize: "var(--cmux-font-size-sm)", lineHeight: "var(--cmux-line-height-ui)",
      color: "var(--cmux-text)", overflowWrap: "anywhere",
    }}>
      <h3 style={{ margin: 0, fontSize: "var(--cmux-font-size-md)" }}>{copy.title}</h3>
      <p style={{ margin: 0 }}>{copy.lead}</p>
      {!status && !error && <div role="status">{copy.buttons.loading}</div>}
      {status?.providers.map((entry) => (
        <div key={entry.provider} role="group" aria-label={copy.agents[entry.provider]} style={{
          display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--cmux-space-4)",
        }}>
          <strong>{copy.agents[entry.provider]}</strong>
          <span>{copy.labels[entry.state]}</span>
          {entry.state === "needs-repair" && <span>{copy.reasons[entry.reason]}</span>}
          {entry.state !== "installed" && (
            <button style={buttonStyle} disabled={busy || confirm !== null} onClick={() => void run(entry.provider, true)}>
              {entry.state === "needs-repair" ? copy.buttons.repair : copy.buttons.enable}
            </button>
          )}
          {entry.enabled && (
            <button style={buttonStyle} disabled={busy || confirm !== null} onClick={() => setConfirm(entry.provider)}>
              {copy.buttons.disable}
            </button>
          )}
        </div>
      ))}
      {confirm && <div role="group" aria-label={copy.confirmDisable.replace("{agent}", copy.agents[confirm])}>
        <div>{copy.confirmDisable.replace("{agent}", copy.agents[confirm])}</div>
        <div style={{ display: "flex", gap: "var(--cmux-space-4)" }}>
          <button style={buttonStyle} disabled={busy} onClick={() => void run(confirm, false)}>{copy.execute}</button>
          <button style={buttonStyle} disabled={busy} onClick={() => setConfirm(null)}>{copy.cancel}</button>
        </div>
      </div>}
      {busy && status && <div role="status">{copy.buttons.busy}</div>}
      {error && <div role="alert">{error}</div>}
      <button style={buttonStyle} disabled={busy || confirm !== null} onClick={() => void refresh()}>{copy.buttons.retry}</button>
    </section>
  );
}
