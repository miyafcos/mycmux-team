import { useEffect, useMemo, useState, type CSSProperties, type MouseEventHandler } from "react";
import { getCliLaunchTokens, listCliAccountHomes, listCliAccounts, type CliAccountHomeStatus, type CliAccountProfile, type CliLaunchTokenStatus } from "../../lib/ipc";
import { launcherStrings as S } from "./launcherStrings";

export function isLaunchAccountTarget(target: string | null | undefined): target is "claude" | "codex" | "grok" {
  return target === "claude" || target === "codex" || target === "grok";
}

interface AccountChoice {
  id: string;
  label: string;
  available: boolean;
  reason: string;
}

interface AccountData {
  target: string | null | undefined;
  profiles: CliAccountProfile[];
  tokens: CliLaunchTokenStatus[];
  homes: CliAccountHomeStatus[];
  loading: boolean;
  failed: boolean;
}

/** Load registrations only while a supported launch editor is open. Never read credentials. */
export function useLaunchAccounts(target: string | null | undefined) {
  const [data, setData] = useState<AccountData>({ target: null, profiles: [], tokens: [], homes: [], loading: false, failed: false });
  useEffect(() => {
    if (!isLaunchAccountTarget(target)) return;
    let current = true;
    setData({ target, profiles: [], tokens: [], homes: [], loading: true, failed: false });
    void (async () => {
      try {
        const [snapshot, tokens, homes] = await Promise.all([listCliAccounts(), getCliLaunchTokens(), listCliAccountHomes()]);
        if (current) setData({ target, profiles: snapshot.profiles, tokens, homes, loading: false, failed: false });
      } catch {
        if (current) setData({ target, profiles: [], tokens: [], homes: [], loading: false, failed: true });
      }
    })();
    return () => { current = false; };
  }, [target]);
  const choices = useMemo<AccountChoice[]>(() => {
    if (data.target !== target || data.failed || data.loading) return [];
    return data.profiles.filter(profile => profile.provider === target).map(profile => {
      const available = target === "claude"
        ? data.tokens.some(status => status.profile_id === profile.id && Date.parse(status.expires_at) > Date.now())
        : data.homes.some(home => home.provider === target && home.profile_id === profile.id && home.state === "ready");
      return { id: profile.id, label: profile.label, available, reason: available ? "" : target === "claude" ? S.accountTokenMissing : S.accountLoginMissing };
    });
  }, [data, target]);
  return { target, choices, loading: data.target !== target || data.loading, failed: data.target === target && data.failed };
}

export type LaunchAccounts = ReturnType<typeof useLaunchAccounts>;

const chip: CSSProperties = {
  maxWidth: "100%", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  borderWidth: 1, borderStyle: "solid", borderColor: "var(--cmux-border)", borderRadius: 999, padding: "3px 8px", background: "transparent",
  fontFamily: "inherit", fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-text-secondary)", cursor: "pointer",
};

/** One shared account row for the launcher and new-workspace setup. Selection is an ID only. */
export function LaunchAccountRow({ accounts, value, onChange, highlighted = false, onMouseDown }: {
  accounts: LaunchAccounts;
  value: string;
  onChange: (id: string) => void;
  highlighted?: boolean;
  onMouseDown?: MouseEventHandler<HTMLButtonElement>;
}) {
  if (!isLaunchAccountTarget(accounts.target)) return null;
  const hasChoices = accounts.choices.length > 0;
  const showDefault = hasChoices || accounts.failed || accounts.loading;
  const buttonStyle = (selected: boolean): CSSProperties => ({
    ...chip, ...(selected ? { borderColor: "var(--cmux-accent)", background: "var(--cmux-selected)", color: "var(--cmux-text)" } : {}),
  });
  return (
    <div data-launch-account-row="true" style={{ display: "grid", gap: 4, minWidth: 0, fontSize: "var(--cmux-font-size-xs)" }}>
      <div style={{ color: highlighted ? "var(--cmux-accent-text)" : "var(--cmux-text-tertiary)" }}>{S.accountLabel}</div>
      {accounts.failed && <div role="alert" style={{ color: "var(--cmux-text-secondary)" }}>{S.accountReadFailed}</div>}
      {accounts.loading && <div role="status" style={{ color: "var(--cmux-text-tertiary)" }}>{S.accountLoading}</div>}
      {/* Chips keep the model/effort chip size: a reason line under one chip must not stretch "default" taller or a chip wider. */}
      {showDefault ? <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: 4, minWidth: 0 }}>
        <button type="button" aria-pressed={value === ""} onMouseDown={onMouseDown} onClick={() => onChange("")} style={buttonStyle(value === "")}>{S.specDefault}</button>
        {accounts.choices.map(choice => (
          <span key={choice.id} style={{ display: "grid", justifyItems: "start", gap: 2, minWidth: 0, maxWidth: "100%" }}>
            <button type="button" title={choice.label} disabled={!choice.available} aria-pressed={value === choice.id}
              onMouseDown={onMouseDown} onClick={() => onChange(choice.id)}
              style={{ ...buttonStyle(value === choice.id), ...(!choice.available ? { color: "var(--cmux-text-dim)", cursor: "default" } : {}) }}>{choice.label}</button>
            {choice.reason && <span style={{ color: "var(--cmux-text-tertiary)" }}>{choice.reason}</span>}
          </span>
        ))}
      </div> : <div style={{ color: "var(--cmux-text-tertiary)" }}>{S.accountEmpty}</div>}
      {accounts.target === "claude" && value !== "" && accounts.choices.some(choice => choice.id === value && choice.available)
        && <div style={{ color: "var(--cmux-text-secondary)" }}>{S.accountClaudeLimitations}</div>}
    </div>
  );
}
