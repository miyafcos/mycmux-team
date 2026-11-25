import { create } from "zustand";
import { homeDir } from "@tauri-apps/api/path";
import { confirm } from "../lib/appConfirmation";
import { isPreparingLayoutQuit } from "../lib/layoutQuit";
import { createWorkspaceAtCwd } from "../lib/workspaceBootstrap";
import {
  beginCliLogin,
  cancelCliLogin,
  killSession,
  type CliAccountProfile,
  type CliLoginCompletedPayload,
  type CliLoginFailedPayload,
  type CliLoginIdentityMismatchPayload,
  type CliLoginMode,
  type CliLoginPurpose,
  type CliLoginSession,
  type SwitchableCliProvider,
} from "../lib/ipc";
import {
  SWITCHABLE_PROVIDERS,
  cliAccountMessage,
  cliAccountHomeLoginMessage,
  loginIdentityMismatchMessage,
  loginTabLabel,
  runningAgentCounts,
  pinnedAgentCounts,
  runningAgentPaneDetails,
  switchWarningText,
} from "../lib/cliAccounts";
import { evictTerminalCache } from "../components/terminal/terminalCache";
import type { Pane, PaneTab } from "../types";
import { useCliAccountStore } from "./cliAccountStore";
import { useDashboardViewStore } from "./dashboardViewStore";
import { usePaneMetadataStore } from "./paneMetadataStore";
import { useToastStore } from "./toastStore";
import { useUiStore } from "./uiStore";
import { useUsageStore } from "./usageStore";
import { useWorkspaceLayoutStore } from "./workspaceLayoutStore";
import { useWorkspaceListStore } from "./workspaceListStore";

export type CliLoginStage = "idle" | "spawning" | "waiting" | "capturing";

export interface CliLoginEntry {
  stage: CliLoginStage;
  loginId: string | null;
  mode: CliLoginMode;
  purpose?: CliLoginPurpose;
  /** Date.now() when the wait started; drives the countdown display. */
  startedAt: number | null;
  sessionId: string | null;
  tabId: string | null;
}

export interface CliLoginState {
  byProvider: Record<SwitchableCliProvider, CliLoginEntry | null>;
  start(provider: SwitchableCliProvider, mode: CliLoginMode, expectedProfileId?: string, purpose?: CliLoginPurpose): Promise<boolean>;
  startAccountHome(provider: "codex" | "grok", profileId: string): Promise<boolean>;
  cancel(provider: SwitchableCliProvider): Promise<void>;
  handleCompleted(payload: CliLoginCompletedPayload): Promise<void>;
  handleFailed(payload: CliLoginFailedPayload): void;
  handleIdentityMismatch(payload: CliLoginIdentityMismatchPayload): void;
  /**
   * Called with every session id the workspaces currently hold. A login whose
   * tab is gone was closed by hand, which is a cancellation — the backend has
   * to hear about it or its staging directory lives until the timeout.
   */
  handleTabsChanged(liveSessionIds: ReadonlySet<string>): void;
}

const EMPTY_BY_PROVIDER: Record<SwitchableCliProvider, CliLoginEntry | null> = { claude: null, codex: null, grok: null };

const NO_HOST_PANE_MESSAGE =
  "ログインのタブを開けませんでした。もう一度お試しください。";

interface HostPane {
  workspaceId: string;
  paneId: string;
}

function isTerminalTab(tab: PaneTab): boolean {
  return (tab.type ?? "terminal") === "terminal";
}

function hasTerminalTab(pane: Pane): boolean {
  return pane.tabs.some(isTerminalTab);
}

/**
 * Prefer an existing pane. A login-only pane has no persistent tab to
 * retain its position after a restart.
 */
function pickHostPane(): HostPane | null {
  const listState = useWorkspaceListStore.getState();
  const workspace =
    listState.workspaces.find(candidate => candidate.id === listState.activeWorkspaceId && candidate.panes.length > 0)
    ?? listState.workspaces.find(candidate => candidate.panes.length > 0);
  if (!workspace) return null;
  const activeSessionId = useUiStore.getState().activePaneId;
  const pane =
    workspace.panes.find(
      (candidate) =>
        hasTerminalTab(candidate)
        && candidate.tabs.some((tab) => tab.sessionId === activeSessionId),
    )
    ?? workspace.panes.find(hasTerminalTab)
    ?? workspace.panes[0];
  if (!pane) return null;
  return { workspaceId: workspace.id, paneId: pane.id };
}

function tabsOf(host: HostPane): PaneTab[] {
  return (
    useWorkspaceListStore
      .getState()
      .workspaces.find((workspace) => workspace.id === host.workspaceId)
      ?.panes.find((pane) => pane.id === host.paneId)
      ?.tabs ?? []
  );
}

function openLoginTab(home: string | undefined, label: string, launchEnv: Record<string, string>) {
  if (isPreparingLayoutQuit()) return null;
  let host = pickHostPane();
  if (!host) {
    createWorkspaceAtCwd(home, { name: "ログイン", gridTemplateId: "1x1" });
    host = pickHostPane();
  }
  if (!host) return null;
  const before = new Set(tabsOf(host).map(tab => tab.id));
  useWorkspaceLayoutStore.getState().addTabToPaneWithOptions(host.workspaceId, host.paneId, {
    agentId: "shell", label, cwd: home, launchEnv, ephemeral: true, activate: true,
  });
  const tab = tabsOf(host).find(item => !before.has(item.id));
  if (!tab) return null;
  const workspaces = useWorkspaceListStore.getState();
  if (workspaces.activeWorkspaceId !== host.workspaceId) workspaces.setActiveWorkspace(host.workspaceId);
  useUiStore.getState().setZoomedPaneId(null);
  useUiStore.getState().setWorkspaceSetupVisible(false);
  useDashboardViewStore.getState().close();
  return tab;
}

let openingGemini = false;

export async function openGeminiLogin(): Promise<boolean> {
  if (openingGemini) return false;
  openingGemini = true;
  try {
    const home = await homeDir().catch(() => undefined);
    if (openLoginTab(home, "Gemini ログイン", { MYCMUX_LAUNCH_TARGET: "agy" })) return true;
  } catch {
    // The layout can change while the home directory is being resolved.
  } finally {
    openingGemini = false;
  }
  useToastStore.getState().pushToast(NO_HOST_PANE_MESSAGE, "error");
  return false;
}

function closeLoginTab(sessionId: string): void {
  if (isPreparingLayoutQuit()) return;
  for (const workspace of useWorkspaceListStore.getState().workspaces) {
    for (const pane of workspace.panes) {
      const tab = pane.tabs.find((candidate) => candidate.sessionId === sessionId);
      if (!tab) continue;
      evictTerminalCache(sessionId);
      killSession(sessionId).catch(() => {
        /* the PTY may already be gone; the tab still has to disappear */
      });
      usePaneMetadataStore.getState().removeMetadata(sessionId);
      useWorkspaceLayoutStore.getState().removeTabFromPane(workspace.id, pane.id, tab.id);
      return;
    }
  }
}

function offerSwitch(provider: SwitchableCliProvider, profile: CliAccountProfile): void {
  let switching = false;
  useToastStore.getState().pushToast(
    `「${profile.label}」に切り替えられます。`,
    "warning",
    {
      label: "切り替える",
      run: () => {
        if (switching) return;
        switching = true;
        void (async () => {
          // The shared dialog handles foregrounding without waiting on IPC.
          // Read the live pane state for this user click.
          const paneMetadataState = usePaneMetadataStore.getState();
          const workspaces = useWorkspaceListStore.getState().workspaces;
          const accepted = await confirm(
            switchWarningText(
              runningAgentCounts(paneMetadataState.metadata, workspaces)[provider],
              provider,
              profile.label,
              runningAgentPaneDetails(paneMetadataState.metadata, provider, paneMetadataState.volatileMetadata, workspaces),
              pinnedAgentCounts(paneMetadataState.metadata, workspaces)[provider],
            ),
            {
              title: "このアカウントに今すぐ切り替えますか？",
              kind: "warning",
              okLabel: "切り替える",
              cancelLabel: "あとで",
            },
          );
          if (accepted) await useCliAccountStore.getState().switchTo(provider, profile.id);
        })().catch((error) => {
          useToastStore.getState().pushToast(cliAccountMessage(error), "error");
        }).finally(() => { switching = false; });
      },
    },
    undefined,
    60_000,
  );
}

export const useCliLoginStore = create<CliLoginState>((set, get) => {
  const setEntry = (provider: SwitchableCliProvider, entry: CliLoginEntry | null) =>
    set((state) => ({ byProvider: { ...state.byProvider, [provider]: entry } }));

  /**
   * Every exit path goes through here. Releasing the provider is the part that
   * must never be skipped: a login left holding `busyByProvider` locks switch
   * and capture for the rest of the session.
   */
  const finalize = (provider: SwitchableCliProvider, entry: CliLoginEntry, options: { closeTab: boolean }) => {
    if (get().byProvider[provider] !== entry) return false;
    setEntry(provider, null);
    useCliAccountStore.getState().setLoginBusy(provider, null);
    if (options.closeTab && entry.sessionId) closeLoginTab(entry.sessionId);
    return true;
  };

  const providerForLogin = (loginId: string): SwitchableCliProvider | null =>
    SWITCHABLE_PROVIDERS.find((provider) => get().byProvider[provider]?.loginId === loginId) ?? null;

  return {
    byProvider: { ...EMPTY_BY_PROVIDER },

    startAccountHome: async (provider, profileId) => get().start(provider, "reauth", profileId, { kind: "account_home", profile_id: profileId }),

    start: async (provider, mode, expectedProfileId, purpose) => {
      const accounts = useCliAccountStore.getState();
      if (accounts.busyByProvider[provider] !== null) return false;
      // Claimed before the first await so a double click cannot start two
      // logins while `begin_cli_login` is in flight.
      accounts.setLoginBusy(provider, `login:${provider}`);
      const starting: CliLoginEntry = {
        stage: "spawning",
        loginId: null,
        mode,
        ...(purpose ? { purpose } : {}),
        startedAt: Date.now(),
        sessionId: null,
        tabId: null,
      };
      setEntry(provider, starting);

      let session: CliLoginSession;
      try {
        session = purpose
          ? await beginCliLogin(provider, mode, expectedProfileId, purpose)
          : await beginCliLogin(provider, mode, expectedProfileId);
      } catch (error) {
        if (get().byProvider[provider] === starting) {
          useToastStore.getState().pushToast(cliAccountMessage(error), "error");
          finalize(provider, starting, { closeTab: false });
        }
        return false;
      }

      // A project directory may produce a trust prompt in the isolated login.
      const home = await homeDir().catch(() => undefined);
      if (get().byProvider[provider] !== starting) {
        void cancelCliLogin(session.login_id).catch(() => {});
        return false;
      }
      let opened: PaneTab | null = null;
      try {
        opened = openLoginTab(home, loginTabLabel(session.provider, mode), { MYCMUX_CLI_LOGIN_ID: session.login_id });
      } catch {
        opened = null;
      }
      if (!opened) {
        cancelCliLogin(session.login_id).catch(() => {});
        useToastStore.getState().pushToast(NO_HOST_PANE_MESSAGE, "error");
        finalize(provider, starting, { closeTab: false });
        return false;
      }

      setEntry(provider, {
        stage: "waiting",
        loginId: session.login_id,
        mode,
        ...(purpose ? { purpose } : {}),
        startedAt: Date.now(),
        sessionId: opened.sessionId,
        tabId: opened.id,
      });
      return true;
    },

    cancel: async (provider) => {
      const entry = get().byProvider[provider];
      if (!entry) return;
      // Clear locally first: the backend answers a cancel with a
      // `login_cancelled` failure event, and an already-cleared entry makes
      // that event a no-op instead of a second toast.
      finalize(provider, entry, { closeTab: true });
      if (entry.loginId) await cancelCliLogin(entry.loginId).catch(() => {});
    },

    handleCompleted: async (payload) => {
      const provider = providerForLogin(payload.login_id);
      if (!provider) return;
      const entry = get().byProvider[provider];
      if (!entry || entry.stage === "capturing") return;
      const completing: CliLoginEntry = { ...entry, stage: "capturing" };
      setEntry(provider, completing);

      if (payload.purpose?.kind === "account_home" || entry.purpose?.kind === "account_home") {
        useToastStore.getState().pushToast("タブ用のログインが完了しました。", "info");
        finalize(provider, completing, { closeTab: true });
        return;
      }
      const label = payload.profile.label;
      const newAccount = !payload.updated_existing;
      if (newAccount) useCliAccountStore.getState().noteAdded(payload.profile);
      useToastStore
        .getState()
        .pushToast(
          payload.updated_existing
            ? `「${label}」の登録を更新しました。`
            : `「${label}」を登録しました。`,
          "info",
          newAccount ? {
            label: "このアカウントをタブ用にも登録",
            run: () => useUiStore.getState().requestSettingsTab("usage", provider, payload.profile.id),
          } : undefined,
        );
      await Promise.all([
        useCliAccountStore.getState().fetch(),
        useUsageStore.getState().fetch(false, undefined, { afterSwitch: true }),
      ]);
      // Release before offering the switch: `switchTo` refuses to run while the
      // provider is busy.
      if (finalize(provider, completing, { closeTab: true })) offerSwitch(provider, payload.profile);
    },

    handleFailed: (payload) => {
      const provider = providerForLogin(payload.login_id);
      if (!provider) return;
      const entry = get().byProvider[provider];
      if (!entry) return;
      const privateHome = entry.purpose?.kind === "account_home";
      useToastStore.getState().pushToast(privateHome ? cliAccountHomeLoginMessage(payload.code) : cliAccountMessage(payload.code), "error");
      finalize(provider, entry, { closeTab: true });
    },

    handleIdentityMismatch: (payload) => {
      const provider = providerForLogin(payload.login_id);
      if (!provider) return;
      // The watcher is still running, so the tab and the provider reservation
      // stay: the user can log out in that same window and come back as the
      // account this re-login is for.
      useToastStore
        .getState()
        .pushToast(loginIdentityMismatchMessage(payload.email), "warning");
    },

    handleTabsChanged: (liveSessionIds) => {
      for (const provider of SWITCHABLE_PROVIDERS) {
        const entry = get().byProvider[provider];
        if (!entry?.sessionId || liveSessionIds.has(entry.sessionId)) continue;
        const loginId = entry.loginId;
        finalize(provider, entry, { closeTab: false });
        if (loginId) cancelCliLogin(loginId).catch(() => {});
      }
    },
  };
});

export function __resetCliLoginStoreForTests(): void {
  useCliLoginStore.setState({ byProvider: { ...EMPTY_BY_PROVIDER } });
}
