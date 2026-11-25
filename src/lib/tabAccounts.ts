import { createContext, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getAllWindows } from "@tauri-apps/api/window";
import {
  focusWindow, getCliLaunchTokens, getWindowTabIndex, listCliAccountHomes, listCliAccounts, OPEN_DASHBOARD_EVENT,
  type CliAccountHomeStatus, type CliLaunchTokenStatus, type SwitchableCliProvider, type WindowAccountManagementSubscription,
} from "./ipc";
import { MAIN_WINDOW_LABEL, windowLabel } from "./windowContext";
import { useUiStore } from "../stores/uiStore";
import { delegationReadWithTimeout } from "../components/dashboard/delegationModel";
import {
  ACCOUNT_MANAGEMENT_RESULT_EVENT, ACCOUNT_MANAGEMENT_TIMEOUT_MS, canOpenAccountManagementHere, isAccountManagementBlocked,
} from "./mainDashboardRequests";
import { isLaunchAccountTarget, isValidLaunchAccountId } from "./agentCatalog";

export const LauncherCoveredContext = createContext(false);

const ACCOUNT_LIST_CHANGED = "tab-account-evidence-updated";

export type AccountManagementSection = {
  provider: SwitchableCliProvider;
  profileId?: string;
  recentProfileIdAtOpen?: string;
};

async function readWindowList<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await delegationReadWithTimeout(read());
  } catch {
    return delegationReadWithTimeout(read());
  }
}

type ManagementDestination = WindowAccountManagementSubscription & { label: string };
type ManagementDelivery = "opened" | "refused" | "rejected" | "unconfirmed";

function deliverAccountManagement(
  destination: ManagementDestination,
  sourceWindow: string,
  accountProvider: SwitchableCliProvider,
): Promise<ManagementDelivery> {
  const requestId = crypto.randomUUID();
  const expiresAt = Date.now() + ACCOUNT_MANAGEMENT_TIMEOUT_MS;
  const targetWindow = destination.label;
  return new Promise(resolve => {
    let settled = false;
    let stop: (() => void) | undefined;
    const finish = (result: ManagementDelivery) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop?.();
      resolve(result);
    };
    const timer = setTimeout(() => finish("unconfirmed"), ACCOUNT_MANAGEMENT_TIMEOUT_MS);
    void listen<unknown>(ACCOUNT_MANAGEMENT_RESULT_EVENT, ({ payload }) => {
      if (Date.now() >= expiresAt || !payload || typeof payload !== "object") return;
      const result = payload as Record<string, unknown>;
      if (result.requestId !== requestId || result.fromWindow !== targetWindow) return;
      const reason = result.reason;
      finish(Object.keys(result).length === 3 && (reason === "opened" || reason === "refused") ? reason : "unconfirmed");
    }, { target: { kind: "Webview", label: sourceWindow } }).then(unlisten => {
      if (settled) {
        unlisten();
        return;
      }
      stop = unlisten;
      if (isAccountManagementBlocked(sourceWindow) || Date.now() >= expiresAt) {
        finish("unconfirmed");
        return;
      }
      void emitTo({ kind: "Webview", label: targetWindow }, OPEN_DASHBOARD_EVENT, {
        accountProvider, sourceWindow, targetWindow, requestId, expiresAt,
        publicationId: destination.publication_id, subscriptionId: destination.subscription_id,
      }).catch(() => finish("rejected"));
    }).catch(() => finish("unconfirmed"));
  });
}

const readLiveWindowLabels = async () => new Set((await readWindowList(getAllWindows)).map(window => window.label));

export async function openAccountManagement(provider: SwitchableCliProvider): Promise<void> {
  const source = windowLabel();
  if (isAccountManagementBlocked(source)) return;
  const openHere = () => useUiStore.getState().requestSettingsTab("usage", provider);
  if (source === MAIN_WINDOW_LABEL && canOpenAccountManagementHere(source)) return openHere();

  const unavailable = new Error("No application window can open account management");
  let excluded: string | undefined;
  let liveLabels = await readLiveWindowLabels();
  while (!isAccountManagementBlocked(source)) {
    const localWithoutMain = !excluded && !liveLabels.has(MAIN_WINDOW_LABEL) && canOpenAccountManagementHere(source);
    const index = await readWindowList(() => getWindowTabIndex({ includeQuitState: true }));
    if (isAccountManagementBlocked(source) || (!Array.isArray(index) && index.quitting)) return;
    if (localWithoutMain && canOpenAccountManagementHere(source)) return openHere();
    const windows = Array.isArray(index) ? index : index.windows;
    const ready = windows.flatMap(entry => {
      const label = entry.window_label;
      const subscription = entry.account_management_subscription;
      if (entry.pending || entry.account_management_ready !== true || label === source || label === excluded
        || !liveLabels.has(label) || typeof subscription?.publication_id !== "string"
        || typeof subscription.subscription_id !== "string" || !subscription.subscription_id) return [];
      return [{ label, ...subscription }];
    });
    const main = ready.find(entry => entry.label === MAIN_WINDOW_LABEL);
    if (!main && canOpenAccountManagementHere(source)) return openHere();
    const destination = main ?? ready[0];
    if (!destination) throw unavailable;

    const result = await deliverAccountManagement(destination, source, provider);
    if (isAccountManagementBlocked(source)) return;
    if (result === "opened") {
      try {
        const { label, ...accountManagementSubscription } = destination;
        await focusWindow(label, { accountManagementSubscription });
      } catch (error) {
        if (error === "window_focus_refused" || isAccountManagementBlocked(source)) return;
        const vanished = error === "window_generation_mismatch"
          || await readLiveWindowLabels().then(labels => !labels.has(destination.label), () => false);
        if (isAccountManagementBlocked(source)) return;
        if (vanished && canOpenAccountManagementHere(source)) {
          return openHere();
        }
        throw error;
      }
      return;
    }
    if (excluded || result === "unconfirmed") throw unavailable;

    liveLabels = await readLiveWindowLabels();
    if (result === "rejected" && liveLabels.has(destination.label)) throw unavailable;
    excluded = destination.label;
  }
}

export type AccountListChange = { profile_id: string; claude_setup_login_id?: string; claude_token_write_id?: string };

/** Subscribe before the initial read. A later reload supersedes an older response. */
export function useAccountListRefresh(
  read: (signal: AbortSignal, change: AccountListChange | undefined, subscribed: boolean) => void,
  enabled = true,
  viewHasFocus?: boolean,
  onDispose?: () => void,
) {
  const refresh = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let subscribed = false;
    let reading = new AbortController();
    const reload = (change?: AccountListChange) => {
      if (disposed) return;
      reading.abort();
      reading = new AbortController();
      read(reading.signal, change, subscribed);
    };
    const onFocus = () => reload();
    const subscription = listen<AccountListChange>(ACCOUNT_LIST_CHANGED, event => {
      // The initial read covers notifications sent before the listener is confirmed.
      if (subscribed) reload(event?.payload);
    });
    const start = (established: boolean) => {
      if (disposed) return;
      subscribed = established;
      refresh.current = onFocus;
      reload();
    };
    void subscription.then(() => start(true), () => start(false));
    window.addEventListener("focus", onFocus);
    return () => {
      disposed = true;
      refresh.current = null;
      reading.abort();
      onDispose?.();
      window.removeEventListener("focus", onFocus);
      void subscription.then(unlisten => unlisten()).catch(() => {});
    };
  }, [enabled, read, viewHasFocus, onDispose]);
  return { refresh: useCallback(() => refresh.current?.(), []) };
}

export type TabRegistrationState = "unregistered" | "ready" | "expired" | "mismatch" | "needs_login";

export const tabRegistrationLabels: Record<TabRegistrationState, string> = {
  unregistered: "未登録",
  ready: "登録済み",
  expired: "期限切れ",
  mismatch: "不一致",
  needs_login: "再ログインが必要",
};

export function tokenRegistrationState(token: CliLaunchTokenStatus | undefined, now: number): TabRegistrationState {
  if (!token) return "unregistered";
  if (token.owner_check === "mismatch") return "mismatch";
  return Date.parse(token.expires_at) > now ? "ready" : "expired";
}

export function homeRegistrationState(home: CliAccountHomeStatus | undefined): TabRegistrationState {
  if (home?.owner === "mismatch") return "mismatch";
  if (home?.state === "ready") return "ready";
  return home?.state === "needs_login" ? "needs_login" : "unregistered";
}

export function useTokenExpiryClock(tokens: readonly CliLaunchTokenStatus[]): number {
  const [tick, setTick] = useState(0);
  const now = Date.now();
  const nextExpiry = tokens.reduce((next, token) => {
    const expiry = Date.parse(token.expires_at);
    return expiry > now ? Math.min(next, expiry) : next;
  }, Infinity);
  useEffect(() => {
    if (!Number.isFinite(nextExpiry)) return;
    const timer = window.setTimeout(() => setTick(value => value + 1),
      Math.min(2_147_483_647, Math.max(1, nextExpiry - Date.now())));
    return () => window.clearTimeout(timer);
  }, [nextExpiry, tick]);
  return now;
}

export async function readLaunchAccounts(provider: SwitchableCliProvider) {
  const [snapshot, tokens, homes] = await Promise.all([
    listCliAccounts(),
    provider === "claude" ? getCliLaunchTokens() : Promise.resolve([]),
    provider !== "claude" ? listCliAccountHomes() : Promise.resolve([]),
  ]);
  return { profiles: snapshot.profiles.filter(profile => profile.provider === provider), tokens,
    homes: homes.filter(home => home.provider === provider) };
}

export type LaunchAccountData = Awaited<ReturnType<typeof readLaunchAccounts>>;
export type LaunchAccountListResult = { target: SwitchableCliProvider; data: LaunchAccountData | null };
export type LaunchAccountListRead = AbortSignal | LaunchAccountListResult;
export type LaunchAccountListListener = (slot: number, read: LaunchAccountListRead, established?: boolean) => void;

export function launchAccountChoices(data: LaunchAccountData, provider: SwitchableCliProvider, now: number) {
  return data.profiles.map(profile => {
    const state = provider === "claude"
      ? tokenRegistrationState(data.tokens.find(item => item.profile_id === profile.id), now)
      : homeRegistrationState(data.homes.find(item => item.profile_id === profile.id));
    return { id: profile.id, label: profile.label, state, available: state === "ready" };
  });
}

const chooseAgain = "選んだアカウントを使えません。選び直してください。";
const accountReadFailed = "アカウントの一覧を読めませんでした。選び直すか、もう一度お試しください。";

type LaunchAccountSelection = { slot: number; target?: string; account: string };
type SelectedAccountRead = { error: string } | { target: SwitchableCliProvider; account: string; data: LaunchAccountData };

async function readSelectedAccount({ target, account }: LaunchAccountSelection): Promise<SelectedAccountRead> {
  if (!isLaunchAccountTarget(target) || !isValidLaunchAccountId(target, account)) return { error: chooseAgain };
  try {
    return { target, account, data: await readLaunchAccounts(target) };
  } catch {
    return { error: accountReadFailed };
  }
}

function unavailableAccount(
  account: string, target: SwitchableCliProvider, data: LaunchAccountData, now: number,
): string | null {
  const choice = launchAccountChoices(data, target, now).find(item => item.id === account);
  if (choice?.available) return null;
  return choice && choice.state !== "unregistered"
    ? `選んだアカウント: ${tabRegistrationLabels[choice.state]}。選び直してください。`
    : chooseAgain;
}

type LaunchAccountCheckSnapshot = {
  selected: readonly LaunchAccountSelection[];
  listRead?: LaunchAccountListRead;
  draft: object | null;
};

/** These references come from the chosen IDs, the list read and the view's draft. */
export function canApplyLaunchAccountCheck(started: LaunchAccountCheckSnapshot, current: LaunchAccountCheckSnapshot): boolean {
  return started.selected === current.selected && started.listRead === current.listRead && started.draft === current.draft;
}

export function useLaunchAccountCheck(
  selected: readonly LaunchAccountSelection[],
  draft: object | null,
) {
  const [checking, setChecking] = useState(false);
  const [lists, setLists] = useState<Record<number, LaunchAccountListResult>>({});
  const [checkError, setCheckError] = useState<{ selection: LaunchAccountSelection; reason: string } | null>(null);
  const current = useRef<LaunchAccountCheckSnapshot>({ selected, draft });
  const pending = useRef<LaunchAccountCheckSnapshot | null>(null);
  const establishedSlots = useRef(new Set<number>());
  const clearError = useCallback(() => setCheckError(null), []);
  const cancel = useCallback(() => {
    if (!pending.current) return;
    pending.current = null;
    setChecking(false);
  }, []);

  useLayoutEffect(() => {
    current.current = { ...current.current, selected, draft };
    cancel();
  }, [selected, draft, cancel]);
  useLayoutEffect(() => () => { pending.current = null; }, []);

  const onListRead = useCallback<LaunchAccountListListener>((slot, listRead, established) => {
    current.current = { ...current.current, listRead };
    if (established === true) establishedSlots.current.add(slot);
    if (established === false) {
      establishedSlots.current.delete(slot);
      cancel();
    }
    if (!("data" in listRead)) return;
    setLists(previous => ({ ...previous, [slot]: listRead }));
    if (established) {
      setCheckError(previous => previous?.selection.slot === slot && previous.selection.target === listRead.target
        ? null : previous);
    }
    // A displayed result also invalidates checks started during the read.
    cancel();
  }, [cancel]);

  let listError: string | null = null;
  for (const { slot, target, account } of selected) {
    const list = lists[slot];
    if (!list?.data || list.target !== target) continue;
    listError = unavailableAccount(account, list.target, list.data, Date.now());
    if (listError) break;
  }
  const error = listError ?? (checkError && selected.some(({ slot, target, account }) =>
    slot === checkError.selection.slot && target === checkError.selection.target && account === checkError.selection.account)
    ? checkError.reason : null);

  const run = async (canLaunch: () => boolean, launch: () => void) => {
    if (!current.current.draft || pending.current || !canLaunch()) return;
    if (!current.current.selected.length) { launch(); return; }
    const unestablished = current.current.selected.find(({ slot }) => !establishedSlots.current.has(slot));
    if (unestablished) {
      setCheckError({ selection: unestablished, reason: accountReadFailed });
      return;
    }
    const started = { ...current.current };
    pending.current = started;
    setChecking(true);
    try {
      const results = await Promise.all(started.selected.map(readSelectedAccount));
      if (pending.current !== started || !canApplyLaunchAccountCheck(started, current.current) || !canLaunch()) return;
      const now = Date.now();
      for (const [index, result] of results.entries()) {
        const reason = "error" in result ? result.error : unavailableAccount(result.account, result.target, result.data, now);
        if (reason) {
          setCheckError({ selection: started.selected[index], reason });
          return;
        }
      }
      launch();
    } finally {
      if (pending.current === started) cancel();
    }
  };

  return { checking, error, clearError, onListRead, cancel, run };
}
