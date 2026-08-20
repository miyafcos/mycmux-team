import { create } from "zustand";
import { homeDir } from "@tauri-apps/api/path";
import { confirm } from "@tauri-apps/plugin-dialog";
import {
  beginCliLogin,
  cancelCliLogin,
  killSession,
  type CliAccountProfile,
  type CliLoginCompletedPayload,
  type CliLoginFailedPayload,
  type CliLoginIdentityMismatchPayload,
  type CliLoginMode,
  type CliLoginSession,
  type CliProvider,
} from "../lib/ipc";
import {
  PROVIDER_ORDER,
  cliAccountMessage,
  loginIdentityMismatchMessage,
  loginTabLabel,
  runningAgentCounts,
  runningAgentPaneDetails,
  switchWarningText,
} from "../lib/cliAccounts";
import { evictTerminalCache } from "../components/terminal/terminalCache";
import type { Pane, PaneTab } from "../types";
import { useCliAccountStore } from "./cliAccountStore";
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
  /** Date.now() when the wait started; drives the countdown display. */
  startedAt: number | null;
  sessionId: string | null;
  tabId: string | null;
}

export interface CliLoginState {
  byProvider: Record<CliProvider, CliLoginEntry | null>;
  start(provider: CliProvider, mode: CliLoginMode, expectedProfileId?: string): Promise<void>;
  cancel(provider: CliProvider): Promise<void>;
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

const EMPTY_BY_PROVIDER: Record<CliProvider, CliLoginEntry | null> = { claude: null, codex: null, grok: null };

const NO_HOST_PANE_MESSAGE =
  "原因: ログイン画面を開くタブを用意できませんでした。次にすること: ターミナルのタブをひとつ開いてから、もう一度お試しください。";

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
 * A login opens as a new tab of an existing pane, never as a new pane: a pane
 * whose tabs are all ephemeral would be dropped from the saved layout, taking
 * its column with it.
 */
function pickHostPane(): HostPane | null {
  const listState = useWorkspaceListStore.getState();
  const workspace =
    listState.workspaces.find((candidate) => candidate.id === listState.activeWorkspaceId)
    ?? listState.workspaces[0];
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

async function openLoginTab(
  session: CliLoginSession,
  mode: CliLoginMode,
): Promise<{ sessionId: string; tabId: string } | null> {
  const host = pickHostPane();
  if (!host) return null;
  // Home rather than the project directory: a project cwd makes the CLI write
  // `hasTrustDialogAccepted: false` into the staging config and greet the user
  // with a trust prompt before the login can even start.
  const home = await homeDir().catch(() => undefined);
  const before = new Set(tabsOf(host).map((tab) => tab.id));
  useWorkspaceLayoutStore.getState().addTabToPaneWithOptions(host.workspaceId, host.paneId, {
    // Plain shell: the agent presets inject resume/handoff variables that have
    // no meaning for a login and would confuse session tracking.
    agentId: "shell",
    label: loginTabLabel(session.provider, mode),
    cwd: home,
    launchEnv: { ...session.env },
    commandArgv: [session.command, ...session.args],
    ephemeral: true,
    activate: true,
  });
  const added = tabsOf(host).find((tab) => !before.has(tab.id));
  return added ? { sessionId: added.sessionId, tabId: added.id } : null;
}

function closeLoginTab(sessionId: string): void {
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

async function offerSwitch(provider: CliProvider, profile: CliAccountProfile): Promise<void> {
  const paneMetadataState = usePaneMetadataStore.getState();
  const metadata = paneMetadataState.metadata;
  const accepted = await confirm(
    switchWarningText(
      runningAgentCounts(metadata)[provider],
      provider,
      profile.label,
      runningAgentPaneDetails(metadata, provider, paneMetadataState.volatileMetadata),
    ),
    {
      title: "このアカウントに今すぐ切り替えますか？",
      kind: "warning",
      okLabel: "切り替える",
      cancelLabel: "あとで",
    },
  ).catch(() => false);
  if (!accepted) return;
  await useCliAccountStore.getState().switchTo(provider, profile.id);
}

export const useCliLoginStore = create<CliLoginState>((set, get) => {
  const setEntry = (provider: CliProvider, entry: CliLoginEntry | null) =>
    set((state) => ({ byProvider: { ...state.byProvider, [provider]: entry } }));

  /**
   * Every exit path goes through here. Releasing the provider is the part that
   * must never be skipped: a login left holding `busyByProvider` locks switch
   * and capture for the rest of the session.
   */
  const finalize = (provider: CliProvider, options: { closeTab: boolean }) => {
    const entry = get().byProvider[provider];
    setEntry(provider, null);
    useCliAccountStore.getState().setLoginBusy(provider, null);
    if (options.closeTab && entry?.sessionId) closeLoginTab(entry.sessionId);
  };

  const providerForLogin = (loginId: string): CliProvider | null =>
    PROVIDER_ORDER.find((provider) => get().byProvider[provider]?.loginId === loginId) ?? null;

  return {
    byProvider: { ...EMPTY_BY_PROVIDER },

    start: async (provider, mode, expectedProfileId) => {
      const accounts = useCliAccountStore.getState();
      if (accounts.busyByProvider[provider] !== null) return;
      // Claimed before the first await so a double click cannot start two
      // logins while `begin_cli_login` is in flight.
      accounts.setLoginBusy(provider, `login:${provider}`);
      setEntry(provider, {
        stage: "spawning",
        loginId: null,
        mode,
        startedAt: Date.now(),
        sessionId: null,
        tabId: null,
      });

      let session: CliLoginSession;
      try {
        session = await beginCliLogin(provider, mode, expectedProfileId);
      } catch (error) {
        useToastStore.getState().pushToast(cliAccountMessage(error), "error");
        finalize(provider, { closeTab: false });
        return;
      }

      let opened: { sessionId: string; tabId: string } | null = null;
      try {
        opened = await openLoginTab(session, mode);
      } catch {
        opened = null;
      }
      if (!opened) {
        cancelCliLogin(session.login_id).catch(() => {});
        useToastStore.getState().pushToast(NO_HOST_PANE_MESSAGE, "error");
        finalize(provider, { closeTab: false });
        return;
      }

      setEntry(provider, {
        stage: "waiting",
        loginId: session.login_id,
        mode,
        startedAt: Date.now(),
        sessionId: opened.sessionId,
        tabId: opened.tabId,
      });
    },

    cancel: async (provider) => {
      const entry = get().byProvider[provider];
      if (!entry) return;
      // Clear locally first: the backend answers a cancel with a
      // `login_cancelled` failure event, and an already-cleared entry makes
      // that event a no-op instead of a second toast.
      finalize(provider, { closeTab: true });
      if (entry.loginId) await cancelCliLogin(entry.loginId).catch(() => {});
    },

    handleCompleted: async (payload) => {
      const provider = providerForLogin(payload.login_id);
      if (!provider) return;
      const entry = get().byProvider[provider];
      if (entry) setEntry(provider, { ...entry, stage: "capturing" });

      const label = payload.profile.label;
      useToastStore
        .getState()
        .pushToast(
          payload.updated_existing
            ? `「${label}」の登録を更新しました。`
            : `「${label}」を登録しました。`,
          "info",
        );
      await Promise.all([
        useCliAccountStore.getState().fetch(),
        useUsageStore.getState().fetch(),
      ]);
      // Release before offering the switch: `switchTo` refuses to run while the
      // provider is busy.
      finalize(provider, { closeTab: true });
      await offerSwitch(provider, payload.profile);
    },

    handleFailed: (payload) => {
      const provider = providerForLogin(payload.login_id);
      if (!provider) return;
      useToastStore.getState().pushToast(cliAccountMessage(payload.code), "error");
      finalize(provider, { closeTab: true });
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
      for (const provider of PROVIDER_ORDER) {
        const entry = get().byProvider[provider];
        if (!entry?.sessionId || liveSessionIds.has(entry.sessionId)) continue;
        const loginId = entry.loginId;
        finalize(provider, { closeTab: false });
        if (loginId) cancelCliLogin(loginId).catch(() => {});
      }
    },
  };
});

export function __resetCliLoginStoreForTests(): void {
  useCliLoginStore.setState({ byProvider: { ...EMPTY_BY_PROVIDER } });
}
