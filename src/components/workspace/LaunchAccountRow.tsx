import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEventHandler } from "react";
import { getCliLaunchTokens, listCliAccountHomes, listCliAccounts, type CliAccountHomeStatus, type CliAccountProfile, type CliLaunchTokenStatus } from "../../lib/ipc";
import { launcherStrings as S } from "./launcherStrings";
import { ClaudeSetupTokenFlow } from "../settings/ClaudeSetupTokenFlow";
import { useCliLoginStore } from "../../stores/cliLoginStore";
import { useClaudeSetupTokenStore, type RegistrationOrigin } from "../../stores/claudeSetupTokenStore";

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
  const [reload, setReload] = useState(0);
  const homeEntries = useCliLoginStore(state => state.byProvider);
  const savedLogin = useClaudeSetupTokenStore(state => state.event?.state === "saved" ? state.event.login_id : null);
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
  }, [target, reload, homeEntries, savedLogin]);
  const choices = useMemo<AccountChoice[]>(() => {
    if (data.target !== target || data.failed || data.loading) return [];
    return data.profiles.filter(profile => profile.provider === target).map(profile => {
      const available = target === "claude"
        ? data.tokens.some(status => status.profile_id === profile.id && status.owner_check !== "mismatch" && Date.parse(status.expires_at) > Date.now())
        : data.homes.some(home => home.provider === target && home.profile_id === profile.id && home.state === "ready");
      return { id: profile.id, label: profile.label, available, reason: available ? "" : target === "claude" ? S.accountTokenMissing : S.accountLoginMissing };
    });
  }, [data, target]);
  return { target, choices, loading: data.target !== target || data.loading, failed: data.target === target && data.failed,
    refresh: () => setReload(value => value + 1), homeBusy: isLaunchAccountTarget(target) && homeEntries[target] !== null };
}

export type LaunchAccounts = ReturnType<typeof useLaunchAccounts>;

const chip: CSSProperties = {
  maxWidth: "100%", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  borderWidth: 1, borderStyle: "solid", borderColor: "var(--cmux-border)", borderRadius: 999, padding: "3px 8px", background: "transparent",
  fontFamily: "inherit", fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-text-secondary)", cursor: "pointer",
};

/** One shared account row for the launcher and new-workspace setup. Selection is an ID only. */
export function LaunchAccountRow({ accounts, surface = "launcher", ownerKey, value, onChange, highlighted = false, cursorId, onRegistrationStart, onRegistrationActivityChange, onRegistrationEnd, onMouseDown }: {
  accounts: LaunchAccounts;
  surface?: RegistrationOrigin["surface"];
  ownerKey: string;
  value: string;
  onChange: (id: string) => void;
  highlighted?: boolean;
  cursorId?: string;
  onRegistrationStart?: () => void;
  onRegistrationActivityChange?: (active: boolean) => void;
  onRegistrationEnd?: (saved: boolean) => void;
  onMouseDown?: MouseEventHandler<HTMLButtonElement>;
}) {
  const [registrationFailed, setRegistrationFailed] = useState(false);
  const [activeRegistration, setActiveRegistration] = useState<string | null>(null);
  const [homeCompletion, setHomeCompletion] = useState<"idle" | "requested" | "loading">("idle");
  const origin = useClaudeSetupTokenStore(state => isLaunchAccountTarget(accounts.target) ? state.registrationOrigins[accounts.target] : null);
  const startingHome = useClaudeSetupTokenStore(state => isLaunchAccountTarget(accounts.target) && state.homeStartPending[accounts.target]);
  const ownsRegistration = origin?.surface === surface && origin.provider === accounts.target && origin.ownerKey === ownerKey;
  const homeProfileId = ownsRegistration && accounts.target !== "claude" ? origin.profileId : null;
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => () => {
    if (useClaudeSetupTokenStore.getState().resultFocus?.ownerKey === ownerKey) useClaudeSetupTokenStore.setState({ resultFocus: null });
  }, [ownerKey]);
  const homeEntry = useCliLoginStore(state => isLaunchAccountTarget(accounts.target) ? state.byProvider[accounts.target] : null);
  const homeRegistrationActive = homeProfileId !== null && (startingHome
    || (homeEntry?.purpose?.kind === "account_home" && homeEntry.purpose.profile_id === homeProfileId));
  useEffect(() => {
    onRegistrationActivityChange?.(accounts.target === "claude" ? activeRegistration !== null || ownsRegistration : homeProfileId !== null);
  }, [activeRegistration, accounts.target, ownsRegistration, homeProfileId, onRegistrationActivityChange]);
  useEffect(() => {
    if (!homeProfileId || !origin) { if (homeCompletion !== "idle") setHomeCompletion("idle"); return; }
    if (homeRegistrationActive) return;
    if (homeCompletion === "idle") {
      setHomeCompletion("requested"); accounts.refresh(); return;
    }
    if (accounts.loading) {
      if (homeCompletion === "requested") setHomeCompletion("loading");
      return;
    }
    if (homeCompletion !== "loading") return;
    const saved = accounts.choices.some(choice => choice.id === homeProfileId && choice.available);
    if (saved) onChange(homeProfileId);
    else [...(rowRef.current?.querySelectorAll<HTMLElement>("[data-launch-account-choice]") ?? [])]
      .find(node => node.dataset.launchAccountChoice === homeProfileId)
      ?.querySelector<HTMLButtonElement>("[data-launch-account-register]")?.focus();
    useClaudeSetupTokenStore.getState().clearRegistrationOrigin(origin);
    setHomeCompletion("idle");
    onRegistrationEnd?.(saved);
  }, [accounts.loading, accounts.choices, accounts.refresh, homeProfileId, origin, homeCompletion, homeRegistrationActive, onChange, onRegistrationEnd]);
  if (!isLaunchAccountTarget(accounts.target)) return null;
  const hasChoices = accounts.choices.length > 0;
  const showDefault = hasChoices || accounts.failed || accounts.loading;
  const buttonStyle = (selected: boolean, focused = false): CSSProperties => ({
    ...chip, outline: focused ? "1px solid var(--cmux-accent)" : undefined, ...(selected ? { borderColor: "var(--cmux-accent)", background: "var(--cmux-selected)", color: "var(--cmux-text)" } : {}),
  });
  return (
    <div ref={rowRef} data-launch-account-row="true" onClickCapture={event => {
      if ((!origin || ownsRegistration) && (event.target as HTMLElement).closest("[data-claude-setup-token], [data-launch-account-register]")) onRegistrationStart?.();
    }} style={{ display: "grid", gap: 4, minWidth: 0, fontSize: "var(--cmux-font-size-xs)" }}>
      <div style={{ color: highlighted ? "var(--cmux-accent-text)" : "var(--cmux-text-tertiary)" }}>{S.accountLabel}</div>
      {registrationFailed && <div role="alert">{S.accountRegistrationFailed}</div>}
      {accounts.failed && <div role="alert" style={{ color: "var(--cmux-text-secondary)" }}>{S.accountReadFailed}</div>}
      {accounts.loading && <div role="status" style={{ color: "var(--cmux-text-tertiary)" }}>{S.accountLoading}</div>}
      {/* Chips keep the model/effort chip size: a reason line under one chip must not stretch "default" taller or a chip wider. */}
      {showDefault ? <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: 4, minWidth: 0 }}>
        <button type="button" aria-pressed={value === ""} onMouseDown={onMouseDown} onClick={() => onChange("")} style={buttonStyle(value === "", highlighted && cursorId === "")}>{S.specDefault}</button>
        {accounts.choices.map(choice => (
          <span key={choice.id} data-launch-account-choice={choice.id} style={{ display: "grid", justifyItems: "start", gap: 2, minWidth: 0, maxWidth: "100%" }}>
            <button type="button" title={choice.label} disabled={!choice.available} aria-pressed={value === choice.id} aria-current={highlighted && cursorId === choice.id ? "true" : undefined}
              onMouseDown={onMouseDown} onClick={() => onChange(choice.id)}
              style={{ ...buttonStyle(value === choice.id, highlighted && cursorId === choice.id), ...(!choice.available ? { color: "var(--cmux-text-dim)", cursor: "default" } : {}) }}>{choice.label}</button>
            {choice.reason && <span style={{ color: "var(--cmux-text-tertiary)" }}>{choice.reason}</span>}
            {!choice.available && (accounts.target === "claude"
              ? <ClaudeSetupTokenFlow profile={choice} surface={surface} ownerKey={ownerKey} disabled={accounts.homeBusy} onSaved={state => {
                  accounts.refresh();
                  if (state === "saved") { onChange(choice.id); onRegistrationEnd?.(true); }
                }} onClosed={() => onRegistrationEnd?.(false)} onInteractionChange={active => {
                  setActiveRegistration(current => active ? choice.id : current === choice.id ? null : current);
                }} />
              : <button type="button" data-launch-account-register="true" style={chip} disabled={accounts.homeBusy}
                onKeyDown={event => event.stopPropagation()} onClick={() => {
                  const provider = accounts.target;
                  if (provider !== "codex" && provider !== "grok") return;
                  setRegistrationFailed(false);
                  const registration: RegistrationOrigin = { surface, provider, profileId: choice.id, ownerKey };
                  useClaudeSetupTokenStore.getState().startRegistration(registration);
                  void useCliLoginStore.getState().startAccountHome(provider, choice.id).catch(() => setRegistrationFailed(true))
                    .finally(() => useClaudeSetupTokenStore.getState().finishHomeStart(registration));
                }}>{S.accountUseInTab}</button>)}
          </span>
        ))}
      </div> : <div style={{ color: "var(--cmux-text-tertiary)" }}>{S.accountEmpty}</div>}
      {accounts.target === "claude" && value !== "" && accounts.choices.some(choice => choice.id === value && choice.available)
        && <div style={{ color: "var(--cmux-text-secondary)" }}>{S.accountClaudeLimitations}</div>}
    </div>
  );
}
