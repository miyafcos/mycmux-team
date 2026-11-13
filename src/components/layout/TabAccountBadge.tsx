import { useEffect } from "react";
import { CircleCheck, TriangleAlert, CircleX } from "lucide-react";
import { useCliAccountStore } from "../../stores/cliAccountStore";
import { useTabAccountEvidence } from "./useTabAccountEvidence";
import { accountEvidenceColor, accountEvidenceText } from "./tabAccountStrings";

/** Registrations and PTY evidence contain no token or home path. */
export function TabAccountBadge({ accountId, sessionId }: { accountId?: string; sessionId?: string }) {
  const profile = useCliAccountStore(state => state.profiles.find(profile => profile.id === accountId));
  const { evidence } = useTabAccountEvidence(sessionId, accountId);
  useEffect(() => {
    if (accountId === undefined) return;
    const state = useCliAccountStore.getState();
    // Standalone windows have no title bar to load registrations. Share its loading guard.
    if (!state.loading && !state.profiles.some(profile => profile.id === accountId)) void state.fetch();
  }, [accountId]);
  if (accountId === undefined) return null;
  const display = profile?.label ?? "登録なし";
  const result = evidence?.result;
  const icon = result === "mismatch" ? "mismatch"
    : result === "org_shared" || result === "unverified" || result === "stale" ? "warning" : "check";
  const Icon = icon === "mismatch" ? CircleX : icon === "warning" ? TriangleAlert : CircleCheck;
  const title = `アカウント: ${display} (このタブだけ)`
    + (evidence ? `\n${accountEvidenceText(evidence, display, profile?.email)}` : "");
  return <span data-tab-account-badge="true" data-account-result={result} title={title} style={{
    display: "inline-flex", alignItems: "center", gap: 2, minWidth: 0, maxWidth: 76, flexShrink: 1, overflow: "hidden", whiteSpace: "nowrap",
    padding: "0 4px", border: "1px solid var(--cmux-border)", borderRadius: "var(--cmux-radius-sm)",
    fontSize: "var(--cmux-font-size-xs)", color: accountEvidenceColor(result), background: "var(--cmux-surface)",
  }}>
    {evidence && <Icon size={11} aria-hidden="true" data-account-evidence-icon={icon} style={{ flexShrink: 0 }} />}
    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{display}</span>
  </span>;
}
