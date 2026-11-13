import { createContext, useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { confirm } from "../../lib/appConfirmation";
import { cliAccountMessage } from "../../lib/cliAccounts";
import { getCliLaunchTokens, listCliAccountHomes, removeCliLaunchToken, recheckCliLaunchToken, setCliLaunchToken, unregisterCliAccountHome, type CliAccountHomeStatus, type CliAccountProfile, type CliLaunchTokenStatus } from "../../lib/ipc";
import { useCliAccountStore } from "../../stores/cliAccountStore";
import { useCliLoginStore } from "../../stores/cliLoginStore";
import { launcherStrings } from "../workspace/launcherStrings";
import { accountRecheckNotice, tokenOwnerLabels, type AccountRecheckNotice } from "../layout/tabAccountStrings";

interface Registrations {
  tokens: CliLaunchTokenStatus[];
  homes: CliAccountHomeStatus[];
  tokenReadFailed: boolean;
  homeReadFailed: boolean;
  refresh: () => Promise<void>;
}
const RegistrationContext = createContext<Registrations>({
  tokens: [], homes: [], tokenReadFailed: false, homeReadFailed: false, refresh: async () => {},
});

/** Shared, non-secret status for the settings rows. Login completion/failure releases its existing store entry. */
export function TabAccountSettingsProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Omit<Registrations, "refresh">>({ tokens: [], homes: [], tokenReadFailed: false, homeReadFailed: false });
  const entries = useCliLoginStore(state => state.byProvider);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const version = ++request.current;
    const [tokens, homes] = await Promise.allSettled([
      Promise.resolve().then(() => getCliLaunchTokens()),
      Promise.resolve().then(() => listCliAccountHomes()),
    ]);
    if (request.current !== version) return;
    setStatus({
      tokens: tokens.status === "fulfilled" ? tokens.value : [],
      homes: homes.status === "fulfilled" ? homes.value : [],
      tokenReadFailed: tokens.status === "rejected",
      homeReadFailed: homes.status === "rejected",
    });
  }, []);
  useEffect(() => {
    void refresh();
    return () => { request.current += 1; };
  }, [refresh, entries]);
  return <RegistrationContext.Provider value={{ ...status, refresh }}>{children}</RegistrationContext.Provider>;
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

export function TabAccountSettings({ profile }: { profile: CliAccountProfile }) {
  return profile.provider === "claude" ? <ClaudeTokenSettings profile={profile} /> : <AccountHomeSettings profile={profile} />;
}

function ClaudeTokenSettings({ profile }: { profile: CliAccountProfile }) {
  const { tokens, tokenReadFailed, refresh } = useContext(RegistrationContext);
  const status = tokens.find(token => token.profile_id === profile.id);
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
    if (busyRef.current || providerBusy || !input?.value) return;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    try {
      // The password value has exactly one destination. Clear the DOM before awaiting IPC.
      const pending = setCliLaunchToken(profile.id, input.value);
      input.value = "";
      await pending;
      await refresh();
    } catch (error) {
      setNotice(accountRecheckNotice({ error }));
      await refresh();
    } finally {
      input.value = "";
      closeEditor();
      busyRef.current = false;
      setBusy(false);
    }
  };

  const recheck = async () => {
    if (busyRef.current || providerBusy) return;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const result = await recheckCliLaunchToken(profile.id);
      await refresh();
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
    if (busyRef.current || providerBusy) return;
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
    <strong>このタブだけで使う — タブ用の長期トークン</strong>
    <div>{status ? `登録済み・期限 ${expiryDate(status.expires_at)}・持ち主: ${tokenOwnerLabels[status.owner_check]}` : "未登録"}</div>
    {tokenReadFailed && <div role="alert">タブ用の登録を読み取れませんでした。もう一度設定を開いてください。</div>}
    {status?.owner_check === "unverified" && <div role="note" style={{ color: "var(--cmux-usage-warn)" }}>
      このトークンのアカウントを確かめられませんでした。ブラウザで別のアカウントにログインしていなかったか確かめてください
    </div>}
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      <button type="button" style={buttonStyle} disabled={busy || providerBusy} onClick={() => { setNotice(null); setEditing(true); }}>登録</button>
      {status && <button type="button" style={buttonStyle} disabled={busy || providerBusy} onClick={() => void recheck()}>確かめ直す</button>}
      {status && <button type="button" style={buttonStyle} disabled={busy || providerBusy} onClick={() => void remove()}>外す</button>}
    </div>
    {editing && <form onSubmit={event => { event.preventDefault(); void save(); }} style={{ display: "grid", gap: 4 }}>
      <p style={{ margin: 0 }}>
        mycmux の外のターミナル (Windows ターミナル・macOS のターミナルなど) で <code>claude setup-token</code> を実行し、このアカウントでブラウザのログインを済ませて、表示されたトークンを貼り付けてください。mycmux のタブで実行すると、トークンがタブの履歴に残ります
      </p>
      <input ref={inputRef} type="password" autoComplete="off" spellCheck={false} aria-label="タブ用の長期トークン" autoFocus
        onKeyDown={event => { if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.preventDefault(); closeEditor(); } }}
        style={{ minWidth: 0, width: "100%", boxSizing: "border-box", border: "1px solid var(--cmux-border)", borderRadius: 3,
          background: "var(--cmux-bg)", color: "var(--cmux-text)", fontSize: "inherit", padding: 4 }} />
      <div style={{ display: "flex", gap: 4 }}>
        <button type="submit" disabled={busy || providerBusy} style={buttonStyle}>{busy ? "保存中…" : "保存"}</button>
        <button type="button" style={buttonStyle} onClick={closeEditor}>取消</button>
      </div>
    </form>}
    <p style={{ margin: 0 }}>{launcherStrings.accountClaudeLimitations}</p>
    {notice && <div role={notice.role} style={{ color: notice.color }}>{notice.message}</div>}
  </section>;
}

const HOME_STATE_LABELS = { created: "ログイン待ち", awaiting_login: "ログイン待ち", ready: "使える", needs_login: "再ログインが必要" } as const;
const HOME_EXPLANATION = "タブ用の設定は、ログイン前と、使用中のタブがない状態で次に起動するときに、全体のCLI設定から反映します。Codexで各フォルダに設定した信頼は残しますが、同じフォルダの全体設定があればそちらを優先します。モデルなどをタブのCLI内で変更しても、次の反映で全体の設定に戻ります。Grok側の変更は残しません。戻す前の設定ファイルは、アカウントのフォルダの中に控えとして残します。タブが使用中の間は設定を上書きしません。登録を外しても会話と設定は残ります。";

function AccountHomeSettings({ profile }: { profile: CliAccountProfile }) {
  const { homes, homeReadFailed, refresh } = useContext(RegistrationContext);
  const home = homes.find(item => item.provider === profile.provider && item.profile_id === profile.id);
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
    void useCliLoginStore.getState().startAccountHome(profile.provider, profile.id);
  };
  return <section aria-label={`${profile.label}をこのタブだけで使う`} style={sectionStyle}>
    <strong>このタブだけで使う — タブ用のログイン</strong>
    <div>{home ? `${HOME_STATE_LABELS[home.state]}・持ち主: ${home.owner === "matched" ? "確認済み" : "未確認"}` : "未作成"}</div>
    {homeReadFailed && <div role="alert">タブ用の登録を読み取れませんでした。もう一度設定を開いてください。</div>}
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      <button type="button" style={buttonStyle} disabled={busy || providerBusy} onClick={login}>
        {home?.state === "ready" || home?.state === "needs_login" ? "再ログイン" : "タブ用にログイン"}
      </button>
      {home && <button type="button" style={buttonStyle} disabled={busy || providerBusy} onClick={() => void remove()}>タブ用の登録を外す</button>}
    </div>
    <details><summary style={{ cursor: "pointer" }}>詳しく</summary><p style={{ margin: "4px 0 0" }}>{HOME_EXPLANATION}</p></details>
    {notice && <div role="alert" style={{ color: "var(--cmux-usage-danger)" }}>{notice}</div>}
  </section>;
}
