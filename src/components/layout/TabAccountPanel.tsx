import { useEffect, useRef, useState, type CSSProperties } from "react";
import { X } from "lucide-react";
import type { CliProvider } from "../../lib/ipc";
import { recheckTabAccount } from "../../lib/ipc";
import { formatPct } from "../../lib/accountRows";
import { resolveTabMark } from "../../lib/tabMark";
import type { PaneTab } from "../../types";
import { useCliAccountStore } from "../../stores/cliAccountStore";
import { useUsageStore } from "../../stores/usageStore";
import { OverlayShell } from "../common/OverlayShell";
import { useTabAccountEvidence } from "./useTabAccountEvidence";
import { accountEvidenceColor, accountEvidenceText, accountRecheckNotice, accountUsageText,
  defaultTabAccountText, tabAccountPanelTitle, type AccountRecheckNotice } from "./tabAccountStrings";

export function tabAccountProvider(tab?: PaneTab, liveKind?: string | null): CliProvider | null {
  if (!tab || (tab.type !== undefined && tab.type !== "terminal")) return null;
  const kind = resolveTabMark(tab, liveKind ?? undefined)?.kind ?? resolveTabMark(tab)?.kind
    ?? (tab.agentId === "claude-code" ? "claude" : tab.agentId);
  return kind === "claude" || kind === "codex" || kind === "grok" ? kind : null;
}
const buttonStyle: CSSProperties = {
  font: "inherit", padding: "4px 8px", border: "1px solid var(--cmux-border)",
  borderRadius: "var(--cmux-radius-sm)", color: "var(--cmux-text)", background: "var(--cmux-surface)",
};
export function TabAccountPanel({ tab, provider, onClose }: { tab: PaneTab; provider: CliProvider; onClose: () => void }) {
  const profiles = useCliAccountStore(state => state.profiles);
  const globalId = useCliAccountStore(state => state.active[provider]);
  const profile = profiles.find(profile => profile.id === tab.agentAccountId && profile.provider === provider);
  const globalName = profiles.find(profile => profile.id === globalId && profile.provider === provider)?.label ?? "なし";
  const name = profile?.label ?? "登録なし";
  const row = useUsageStore(state => state.accounts.find(row => row.provider === provider && row.profile_id === tab.agentAccountId));
  const { evidence, failed, accept } = useTabAccountEvidence(tab.sessionId, tab.agentAccountId);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [notice, setNotice] = useState<AccountRecheckNotice | null>(null);
  useEffect(() => {
    const state = useCliAccountStore.getState();
    if (!state.loading && state.profiles.length === 0) void state.fetch();
  }, []);
  const recheck = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const next = await recheckTabAccount(tab.sessionId);
      accept(next);
      setNotice(next ? accountRecheckNotice({
        provider: next.provider, result: next.result, owner_method: next.owner_method,
        owner_check_status: next.owner_check_status, checked_at: next.checked_at, mismatchName: name,
      }) : null);
    } catch (error) {
      setNotice(accountRecheckNotice({ error }));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const displayedNotice = notice ?? (failed ? accountRecheckNotice({ error: undefined }) : null);
  const confirmation = evidence ? accountEvidenceText(evidence, name, profile?.email) : "未取得";
  const usage = row?.five_hour && row?.seven_day
    ? `5 時間 ${formatPct(row.five_hour.pct)}・週 ${formatPct(row.seven_day.pct)}` : "未取得";
  const fields = [
    ["指定したアカウント", profile?.email ? `${name} (${profile.email})` : name],
    ["ログインの渡し方", provider === "claude" ? "登録した長期トークン (このタブだけに渡しています)" : "このアカウント専用のログイン (このタブだけが使います)"],
    ["確認", confirmation],
    ["今の全体のアカウント", globalName],
    [`${name} の使用量`, usage],
  ];
  return <OverlayShell open onClose={onClose} size="dialog" ariaLabel={tabAccountPanelTitle}>
    <div style={{ padding: "var(--cmux-space-6)", display: "grid", gap: "var(--cmux-space-5)",
      overflowY: "auto", fontSize: "var(--cmux-font-size-sm)", color: "var(--cmux-text)" }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--cmux-space-4)" }}>
        <h2 style={{ margin: 0, fontSize: "var(--cmux-font-size-md)" }}>{tabAccountPanelTitle}</h2>
        <button type="button" aria-label="閉じる" onClick={onClose} style={buttonStyle}><X size={14} aria-hidden="true" /></button>
      </header>
      {tab.agentAccountId === undefined ? <p style={{ margin: 0 }}>{defaultTabAccountText(globalName)}</p> : <>
        <dl style={{ display: "grid", gap: "var(--cmux-space-4)", margin: 0 }}>
          {fields.map(([label, value]) => <div key={label}>
            <dt style={{ color: "var(--cmux-text-secondary)", marginBottom: "var(--cmux-space-2)" }}>{label}</dt>
            <dd style={{ margin: 0, overflowWrap: "anywhere", color: label === "確認" ? accountEvidenceColor(evidence?.result) : undefined }}>{value}</dd>
          </div>)}
        </dl>
        <p style={{ margin: 0 }}>{accountUsageText(failed ? null : evidence, name, tab.agentAccountId === globalId)}</p>
        <div><button type="button" disabled={busy} aria-busy={busy} onClick={() => void recheck()} style={buttonStyle}>確かめ直す</button></div>
        {displayedNotice && <p role={displayedNotice.role} style={{ margin: 0, color: displayedNotice.color }}>{displayedNotice.message}</p>}
      </>}
    </div>
  </OverlayShell>;
}
