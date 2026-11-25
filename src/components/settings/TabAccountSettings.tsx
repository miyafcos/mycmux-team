import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { confirm } from "../../lib/appConfirmation";
import { cliAccountMessage } from "../../lib/cliAccounts";
import {
  getCliLaunchTokens, listCliAccountHomes, removeCliLaunchToken, recheckCliLaunchToken, setCliLaunchToken,
  unregisterCliAccountHome, type ClaudeSetupTokenEvent, type CliAccountHomeStatus, type CliAccountProfile,
  type CliLaunchTokenStatus,
} from "../../lib/ipc";
import { useCliAccountStore } from "../../stores/cliAccountStore";
import { useCliLoginStore } from "../../stores/cliLoginStore";
import { launcherStrings } from "../workspace/launcherStrings";
import {
  homeRegistrationState, tabRegistrationLabels, tokenRegistrationState, useAccountListRefresh, useTokenExpiryClock,
  type AccountListChange, type AccountManagementSection,
} from "../../lib/tabAccounts";
import { ClaudeSetupTokenFlow } from "./ClaudeSetupTokenFlow";
import { isSetupTokenActive, useClaudeSetupTokenStore } from "../../stores/claudeSetupTokenStore";
import { accountRecheckNotice, setupTokenStrings, tokenOwnerLabels, type AccountRecheckNotice } from "../layout/tabAccountStrings";

interface Registrations {
  tokens: CliLaunchTokenStatus[];
  homes: CliAccountHomeStatus[];
  tokenReadFailed: boolean;
  homeReadFailed: boolean;
  accountSection?: AccountManagementSection;
  refresh: () => Promise<boolean>;
  beginTokenWrite: (profileId: string) => RegistrationTokenWrite;
}
const RegistrationContext = createContext<Registrations>({
  tokens: [], homes: [], tokenReadFailed: false, homeReadFailed: false, refresh: async () => false,
  beginTokenWrite: () => ({ refresh: async () => {} }),
});

type RegistrationRead = { controller: AbortController; loginId?: string; done: Promise<boolean> };
type RegistrationTokenWrite = { id?: string; refresh: () => Promise<void> };
type TokenWrite = { id: string; read?: Promise<boolean> };

function completedSetupLogin(event: ClaudeSetupTokenEvent | null): string | undefined {
  return event?.state === "saved" || event?.state === "mismatch" ? event.login_id : undefined;
}

/** Shared status for the management rows. */
export function TabAccountSettingsProvider({ children, accountSection }: {
  children: ReactNode;
  accountSection?: AccountManagementSection;
}) {
  const [status, setStatus] = useState<Omit<Registrations, "refresh" | "beginTokenWrite" | "accountSection">>({ tokens: [], homes: [], tokenReadFailed: false, homeReadFailed: false });
  const currentRead = useRef<RegistrationRead | null>(null);
  const completedSetupReads = useRef(new Set<string>());
  const tokenWrites = useRef(new Map<string, TokenWrite>());
  const displayValid = useRef(false);
  const mounted = useRef(false);
  const refresh = useCallback(async (loginId?: string): Promise<boolean> => {
    if (!mounted.current) return false;
    const pending = currentRead.current;
    if (loginId && pending?.loginId === loginId) {
      await pending.done;
      if (!mounted.current) return false;
      if (currentRead.current?.loginId === loginId) return currentRead.current.done;
    }
    if (loginId && completedSetupReads.current.has(loginId)) return true;
    currentRead.current?.controller.abort();
    const controller = new AbortController();
    const { signal } = controller;
    const readLoginId = loginId ?? completedSetupLogin(useClaudeSetupTokenStore.getState().event);
    const done = new Promise<boolean>(resolve => {
      const discard = () => resolve(false);
      signal.addEventListener("abort", discard, { once: true });
      void Promise.allSettled([
        Promise.resolve().then(() => getCliLaunchTokens()),
        Promise.resolve().then(() => listCliAccountHomes()),
      ]).then(([tokens, homes]) => {
        if (signal.aborted) return;
        signal.removeEventListener("abort", discard);
        currentRead.current = null;
        displayValid.current = tokens.status === "fulfilled" && homes.status === "fulfilled";
        if (!displayValid.current) completedSetupReads.current.clear();
        else if (readLoginId) completedSetupReads.current.add(readLoginId);
        setStatus({
          tokens: tokens.status === "fulfilled" ? tokens.value : [],
          homes: homes.status === "fulfilled" ? homes.value : [],
          tokenReadFailed: tokens.status === "rejected",
          homeReadFailed: homes.status === "rejected",
        });
        resolve(displayValid.current);
      });
    });
    currentRead.current = { controller, loginId: readLoginId, done };
    return done;
  }, []);

  const refreshTokenWrite = useCallback(async (profileId: string, write: TokenWrite) => {
    if (tokenWrites.current.get(profileId) !== write) return;
    const pending = write.read;
    if (pending) {
      const displayed = await pending;
      if (tokenWrites.current.get(profileId) !== write || (displayed && displayValid.current)) return;
      if (write.read !== pending) { await write.read; return; }
    }
    write.read = refresh();
    await write.read;
  }, [refresh]);
  const beginTokenWrite = useCallback((profileId: string): RegistrationTokenWrite => {
    // Keep only the latest local write per profile, including its result for a late notice.
    const write: TokenWrite = { id: crypto.randomUUID() };
    tokenWrites.current.set(profileId, write);
    return { id: write.id, refresh: () => refreshTokenWrite(profileId, write) };
  }, [refreshTokenWrite]);
  const readLists = useCallback((_signal: AbortSignal, change?: AccountListChange) => {
    const write = change && tokenWrites.current.get(change.profile_id);
    if (change && write && change.claude_token_write_id === write.id) {
      void refreshTokenWrite(change.profile_id, write);
    } else {
      void refresh(change?.claude_setup_login_id);
    }
  }, [refresh, refreshTokenWrite]);
  useAccountListRefresh(readLists);
  useLayoutEffect(() => {
    mounted.current = true;
    const unsubscribe = useClaudeSetupTokenStore.subscribe(({ event }, previous) => {
      const loginId = completedSetupLogin(event);
      if (loginId && loginId !== completedSetupLogin(previous.event)) void refresh(loginId);
    });
    void useClaudeSetupTokenStore.getState().connect().catch(() => {});
    return () => {
      unsubscribe();
      mounted.current = false;
      currentRead.current?.controller.abort();
      currentRead.current = null;
      completedSetupReads.current.clear();
      tokenWrites.current.clear();
      displayValid.current = false;
    };
  }, [refresh]);
  return <RegistrationContext.Provider value={{ ...status, refresh, beginTokenWrite, accountSection }}>{children}</RegistrationContext.Provider>;
}

const sectionStyle: CSSProperties = {
  gridColumn: "2 / -1", display: "grid", gap: "var(--cmux-space-3)", minWidth: 0,
  marginTop: "var(--cmux-space-4)", paddingTop: "var(--cmux-space-4)", borderTop: "1px solid var(--cmux-border-hairline)",
  color: "var(--cmux-text-secondary)", fontSize: "var(--cmux-font-size-xs)",
};
const buttonStyle: CSSProperties = {
  padding: "2px 7px", borderRadius: 3, border: "1px solid var(--cmux-border)",
  background: "none", color: "var(--cmux-text-secondary)", fontSize: "inherit", fontFamily: "inherit", cursor: "pointer",
};

function expiryDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : "不明";
}

export function TabAccountSettings({ profile, onLoginOpened }: { profile: CliAccountProfile; onLoginOpened?: () => void }) {
  const { accountSection } = useContext(RegistrationContext);
  const recentProfileId = useCliAccountStore(state => state.recentlyAdded?.[profile.provider]);
  const requestedProfileId = accountSection?.provider === profile.provider
    && recentProfileId === accountSection.recentProfileIdAtOpen ? accountSection.profileId : undefined;
  const recentlyAdded = (requestedProfileId ?? recentProfileId) === profile.id;
  return profile.provider === "claude"
    ? <ClaudeTokenSettings profile={profile} recentlyAdded={recentlyAdded} />
    : <AccountHomeSettings profile={profile} recentlyAdded={recentlyAdded} onLoginOpened={onLoginOpened} />;
}

function ClaudeTokenSettings({ profile, recentlyAdded }: { profile: CliAccountProfile; recentlyAdded: boolean }) {
  const { tokens, tokenReadFailed, refresh, beginTokenWrite } = useContext(RegistrationContext);
  const status = tokens.find(token => token.profile_id === profile.id);
  const registration = tokenRegistrationState(status, useTokenExpiryClock(tokens));
  const setupBusy = useClaudeSetupTokenStore(state => isSetupTokenActive(state.event) || state.pendingProfileId !== null);
  const providerBusy = useCliAccountStore(state => state.busyByProvider.claude !== null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [notice, setNotice] = useState<AccountRecheckNotice | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Capture the node before React clears its ref on unmount, including closing settings.
  useEffect(() => {
    const input = inputRef.current;
    return () => { if (input) input.value = ""; };
  }, [editing]);

  const closeEditor = () => {
    if (inputRef.current) inputRef.current.value = "";
    setEditing(false);
  };

  const save = async () => {
    const input = inputRef.current;
    if (busyRef.current || providerBusy || setupBusy || !input?.value) return;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    const write = beginTokenWrite(profile.id);
    try {
      // The password value has exactly one destination. Clear the DOM before awaiting IPC.
      const pending = setCliLaunchToken(profile.id, input.value, write.id);
      input.value = "";
      await pending;
      await write.refresh();
    } catch (error) {
      setNotice(accountRecheckNotice({ error }));
      await write.refresh();
    } finally {
      input.value = "";
      closeEditor();
      busyRef.current = false;
      setBusy(false);
    }
  };

  const recheck = async () => {
    if (busyRef.current || providerBusy || setupBusy) return;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    const write = beginTokenWrite(profile.id);
    try {
      const result = await recheckCliLaunchToken(profile.id, write.id);
      await write.refresh();
      setNotice(accountRecheckNotice({
        provider: "claude", result: result.owner_check, owner_method: result.owner_method,
        owner_check_status: result.owner_check_status, checked_at: result.owner_checked_at,
      }));
    } catch (error) {
      setNotice(accountRecheckNotice({ error }));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busyRef.current || providerBusy || setupBusy) return;
    closeEditor();
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const accepted = await confirm("このアカウントのタブ用のトークンを mycmux から外します。トークン自体は期限まで有効のままです。", {
        title: "タブ用のトークンを外す", kind: "warning", okLabel: "外す", cancelLabel: "キャンセル",
      }).catch(() => false);
      if (!accepted) return;
      await removeCliLaunchToken(profile.id);
      await refresh();
    } catch (error) {
      setNotice(accountRecheckNotice({ error }));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return <section aria-label={`${profile.label}をこのタブだけで使う`} style={sectionStyle}>
    <strong>タブ用の登録 — 長期トークン</strong>
    <div>{tabRegistrationLabels[registration]}{status && `・期限 ${expiryDate(status.expires_at)}・持ち主: ${tokenOwnerLabels[status.owner_check]}`}</div>
    {tokenReadFailed && <div role="alert">タブ用の登録を読み取れませんでした。もう一度設定を開いてください。</div>}
    {status?.owner_check === "unverified" && <div role="note" style={{ color: "var(--cmux-usage-warn)" }}>
      このトークンのアカウントを確かめられませんでした。ブラウザで別のアカウントにログインしていなかったか確かめてください
    </div>}
    <ClaudeSetupTokenFlow profile={profile} registered={!!status} continueRegistration={recentlyAdded}
      disabled={busy || providerBusy || editing || tokenReadFailed} />
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      {status && <button type="button" style={buttonStyle} disabled={busy || providerBusy || setupBusy} onClick={() => void recheck()}>確かめ直す</button>}
      {status && <button type="button" style={buttonStyle} disabled={busy || providerBusy || setupBusy} onClick={() => void remove()}>外す</button>}
    </div>
    <details><summary style={{ cursor: "pointer" }}>詳しく</summary>
      <button type="button" style={buttonStyle} disabled={busy || providerBusy || setupBusy} onClick={() => { setNotice(null); setEditing(true); }}>登録</button>
    {editing && <form onSubmit={event => { event.preventDefault(); void save(); }} style={{ display: "grid", gap: 4 }}>
      <p style={{ margin: 0 }}>
        mycmux の外のターミナル (Windows ターミナル・macOS のターミナルなど) で <code>claude setup-token</code> を実行し、このアカウントでブラウザのログインを済ませて、表示されたトークンを貼り付けてください。mycmux のタブで実行すると、トークンがタブの履歴に残ります
      </p>
      <input ref={inputRef} type="password" autoComplete="off" spellCheck={false} aria-label="タブ用の長期トークン" autoFocus
        onKeyDown={event => { if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.preventDefault(); closeEditor(); } }}
        style={{ minWidth: 0, width: "100%", boxSizing: "border-box", border: "1px solid var(--cmux-border)", borderRadius: 3,
          background: "var(--cmux-bg)", color: "var(--cmux-text)", fontSize: "inherit", padding: 4 }} />
      <div style={{ display: "flex", gap: 4 }}>
        <button type="submit" disabled={busy || providerBusy || setupBusy} style={buttonStyle}>{busy ? "保存中…" : "保存"}</button>
        <button type="button" style={buttonStyle} onClick={closeEditor}>取消</button>
      </div>
    </form>}
    </details>
    <p style={{ margin: 0 }}>{launcherStrings.accountClaudeLimitations}</p>
    {notice && <div role={notice.role} style={{ color: notice.color }}>{notice.message}</div>}
  </section>;
}

const HOME_EXPLANATION = "タブ用の設定は、ログイン前と、使用中のタブがない状態で次に起動するときに、全体のCLI設定から反映します。Codexで各フォルダに設定した信頼は残しますが、同じフォルダの全体設定があればそちらを優先します。モデルなどをタブのCLI内で変更しても、次の反映で全体の設定に戻ります。Grok側の変更は残しません。戻す前の設定ファイルは、アカウントのフォルダの中に控えとして残します。タブが使用中の間は設定を上書きしません。登録を外しても会話と設定は残ります。";

function AccountHomeSettings({ profile, recentlyAdded, onLoginOpened }: {
  profile: CliAccountProfile;
  recentlyAdded: boolean;
  onLoginOpened?: () => void;
}) {
  const { homes, homeReadFailed, refresh } = useContext(RegistrationContext);
  const home = homes.find(item => item.provider === profile.provider && item.profile_id === profile.id);
  const registration = homeRegistrationState(home);
  const wasRegistered = (home?.generation ?? 0) > 0 || registration !== "unregistered";
  const providerBusy = useCliAccountStore(state => state.busyByProvider[profile.provider] !== null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const remove = async () => {
    if (busyRef.current || providerBusy) return;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const accepted = await confirm("タブ用のログインの登録を外します。このアカウントのタブの会話と設定は残ります。", {
        title: "タブ用の登録を外す", kind: "warning", okLabel: "外す", cancelLabel: "キャンセル",
      }).catch(() => false);
      if (!accepted) return;
      await unregisterCliAccountHome(profile.provider, profile.id);
      await refresh();
    } catch (error) {
      setNotice(cliAccountMessage(error));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const login = () => {
    if (busy || providerBusy || (profile.provider !== "codex" && profile.provider !== "grok")) return;
    setNotice(null);
    void useCliLoginStore.getState().startAccountHome(profile.provider, profile.id).then(opened => {
      if (opened) onLoginOpened?.();
    });
  };
  return <section aria-label={`${profile.label}をこのタブだけで使う`} style={sectionStyle}>
    <strong>タブ用の登録 — ログイン</strong>
    <div>{tabRegistrationLabels[registration]}{home && `・持ち主: ${home.owner === "matched" ? "確認済み" : home.owner === "mismatch" ? "不一致" : "未確認"}`}</div>
    {homeReadFailed && <div role="alert">タブ用の登録を読み取れませんでした。もう一度設定を開いてください。</div>}
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      <button type="button" style={buttonStyle} disabled={busy || providerBusy || homeReadFailed} onClick={login}>
        {wasRegistered ? setupTokenStrings.registerAgain : recentlyAdded ? setupTokenStrings.continueRegistration : setupTokenStrings.useInTab}
      </button>
      {home && <button type="button" style={buttonStyle} disabled={busy || providerBusy} onClick={() => void remove()}>外す</button>}
    </div>
    <details><summary style={{ cursor: "pointer" }}>詳しく</summary><p style={{ margin: "4px 0 0" }}>{HOME_EXPLANATION}</p></details>
    {notice && <div role="alert" style={{ color: "var(--cmux-usage-danger)" }}>{notice}</div>}
  </section>;
}
