import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  beginCliLogin: vi.fn(),
  cancelCliLogin: vi.fn(() => Promise.resolve()),
  killSession: vi.fn(() => Promise.resolve()),
  listCliAccounts: vi.fn(),
  usageFetch: vi.fn(() => Promise.resolve()),
  pushToast: vi.fn(),
  confirmDialog: vi.fn(() => Promise.resolve(false)),
  homeDir: vi.fn(() => Promise.resolve("C:\\Users\\test")),
}));

vi.mock("../../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/ipc")>();
  return {
    ...actual,
    beginCliLogin: mocks.beginCliLogin,
    cancelCliLogin: mocks.cancelCliLogin,
    killSession: mocks.killSession,
    listCliAccounts: mocks.listCliAccounts,
  };
});
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: mocks.confirmDialog }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: mocks.homeDir }));
vi.mock("../../src/stores/usageStore", () => ({
  useUsageStore: { getState: () => ({ fetch: mocks.usageFetch }) },
}));
vi.mock("../../src/stores/toastStore", () => ({
  useToastStore: { getState: () => ({ pushToast: mocks.pushToast }) },
}));

import type {
  CliAccountProfile,
  CliAccountsSnapshot,
  CliLoginSession,
} from "../../src/lib/ipc";
import type { Pane, PaneTab, Workspace } from "../../src/types";
import {
  __resetCliAccountStoreForTests,
  useCliAccountStore,
} from "../../src/stores/cliAccountStore";
import {
  __resetCliLoginStoreForTests,
  useCliLoginStore,
} from "../../src/stores/cliLoginStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";

const workspaceId = "workspace";
const paneId = "pane";
const hostTabId = "tab-host";
const hostSessionId = "session-host";
const loginId = "login-1";

const profile: CliAccountProfile = {
  id: "claude-a",
  provider: "claude",
  label: "A",
  email: "a@example.test",
  identity_key: "a",
  plan: "max",
  org_name: null,
  captured_at: "2026-01-01T00:00:00Z",
  last_switched_at: null,
  needs_relogin: false,
};

const snapshot: CliAccountsSnapshot = {
  profiles: [profile],
  live: [],
  active: { claude: null, codex: null },
  orphans: [],
  backup_root: "backups",
  generated_at: "2026-01-01T00:00:00Z",
};

const loginSession: CliLoginSession = {
  login_id: loginId,
  provider: "claude",
  command: "claude",
  args: [],
  env: { CLAUDE_CONFIG_DIR: "C:\\staging\\login-1" },
  staging_dir: "C:\\staging\\login-1",
};

function workspace(): Workspace {
  const tab: PaneTab = {
    id: hostTabId,
    sessionId: hostSessionId,
    agentId: "shell-starter",
    type: "terminal",
  };
  const pane: Pane = {
    id: paneId,
    agentId: tab.agentId,
    sessionId: tab.sessionId,
    tabs: [tab],
    activeTabId: tab.id,
  };
  return {
    id: workspaceId,
    name: "Workspace",
    gridTemplateId: "1x1",
    status: "running",
    createdAt: 1,
    panes: [pane],
    splitColumns: [[paneId]],
  };
}

function currentTabs(): PaneTab[] {
  return useWorkspaceListStore.getState().workspaces[0]?.panes[0]?.tabs ?? [];
}

function liveSessionIds(): Set<string> {
  const ids = new Set<string>();
  for (const ws of useWorkspaceListStore.getState().workspaces) {
    for (const pane of ws.panes) for (const tab of pane.tabs) ids.add(tab.sessionId);
  }
  return ids;
}

function loginTab(): PaneTab | undefined {
  return currentTabs().find((tab) => tab.id !== hostTabId);
}

async function startClaudeLogin(): Promise<void> {
  await useCliLoginStore.getState().start("claude", "new");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.beginCliLogin.mockResolvedValue(loginSession);
  mocks.listCliAccounts.mockResolvedValue(snapshot);
  useWorkspaceListStore.setState({
    workspaces: [workspace()],
    activeWorkspaceId: workspaceId,
    lastActivePaneByWorkspace: {},
  });
  useUiStore.setState({ activePaneId: hostSessionId, focusRevision: 0 });
  __resetCliAccountStoreForTests();
  __resetCliLoginStoreForTests();
});

describe("cliLoginStore.start", () => {
  it("refuses to start while the provider is already busy", async () => {
    useCliAccountStore.getState().setLoginBusy("claude", "capture:claude");

    await startClaudeLogin();

    expect(mocks.beginCliLogin).not.toHaveBeenCalled();
    expect(useCliLoginStore.getState().byProvider.claude).toBeNull();
    expect(currentTabs()).toHaveLength(1);
  });

  it("opens the backend-supplied command as an ephemeral tab of an existing pane", async () => {
    await startClaudeLogin();

    expect(mocks.beginCliLogin).toHaveBeenCalledWith("claude", "new", undefined);
    // One pane still: a pane made only of ephemeral tabs would vanish from the
    // saved layout and take its column with it.
    expect(useWorkspaceListStore.getState().workspaces[0].panes).toHaveLength(1);
    const tab = loginTab();
    expect(tab).toBeDefined();
    expect(tab?.ephemeral).toBe(true);
    expect(tab?.commandArgv).toEqual(["claude"]);
    expect(tab?.launchEnv).toEqual({ CLAUDE_CONFIG_DIR: "C:\\staging\\login-1" });
    expect(tab?.cwd).toBe("C:\\Users\\test");
    expect(tab?.label).toBe("Claude Code ログイン");

    const entry = useCliLoginStore.getState().byProvider.claude;
    expect(entry?.stage).toBe("waiting");
    expect(entry?.loginId).toBe(loginId);
    expect(entry?.sessionId).toBe(tab?.sessionId);
    expect(useCliAccountStore.getState().busyByProvider.claude).toBe("login:claude");
  });

  it("releases the provider and reports the code when the backend refuses", async () => {
    mocks.beginCliLogin.mockRejectedValueOnce(
      new Error("cli_account.error.login_already_running"),
    );

    await startClaudeLogin();

    expect(mocks.pushToast).toHaveBeenCalledWith(
      expect.stringContaining("すでに進行中"),
      "error",
    );
    expect(useCliAccountStore.getState().busyByProvider.claude).toBeNull();
    expect(useCliLoginStore.getState().byProvider.claude).toBeNull();
  });

  it("labels a re-login tab and forwards the profile it must match", async () => {
    await useCliLoginStore.getState().start("claude", "reauth", profile.id);

    expect(mocks.beginCliLogin).toHaveBeenCalledWith("claude", "reauth", profile.id);
    expect(loginTab()?.label).toBe("Claude Code 再ログイン");
  });
});

describe("cliLoginStore events", () => {
  it("refreshes accounts and usage, closes the tab and frees the provider on completion", async () => {
    await startClaudeLogin();
    const sessionId = loginTab()?.sessionId;

    await useCliLoginStore
      .getState()
      .handleCompleted({ login_id: loginId, profile, updated_existing: false });

    expect(mocks.listCliAccounts).toHaveBeenCalled();
    expect(mocks.usageFetch).toHaveBeenCalled();
    expect(mocks.pushToast).toHaveBeenCalledWith("「A」を登録しました。", "info");
    expect(liveSessionIds().has(sessionId ?? "")).toBe(false);
    expect(useCliAccountStore.getState().busyByProvider.claude).toBeNull();
    expect(useCliLoginStore.getState().byProvider.claude).toBeNull();
    // The provider must already be free when the switch offer appears, or
    // switchTo would refuse it.
    expect(mocks.confirmDialog).toHaveBeenCalled();
  });

  it("says the registration was updated when the profile already existed", async () => {
    await startClaudeLogin();

    await useCliLoginStore
      .getState()
      .handleCompleted({ login_id: loginId, profile, updated_existing: true });

    expect(mocks.pushToast).toHaveBeenCalledWith("「A」の登録を更新しました。", "info");
  });

  it("closes the tab and frees the provider on failure", async () => {
    await startClaudeLogin();
    const sessionId = loginTab()?.sessionId;

    useCliLoginStore
      .getState()
      .handleFailed({ login_id: loginId, code: "cli_account.error.login_timeout" });

    expect(mocks.pushToast).toHaveBeenCalledWith(
      expect.stringContaining("制限時間内にログインが完了しませんでした"),
      "error",
    );
    expect(liveSessionIds().has(sessionId ?? "")).toBe(false);
    expect(useCliAccountStore.getState().busyByProvider.claude).toBeNull();
    expect(useCliLoginStore.getState().byProvider.claude).toBeNull();
  });

  it("keeps the tab and the reservation on an identity mismatch", async () => {
    await startClaudeLogin();
    const sessionId = loginTab()?.sessionId;

    useCliLoginStore
      .getState()
      .handleIdentityMismatch({ login_id: loginId, email: "other@example.test" });

    expect(mocks.pushToast).toHaveBeenCalledWith(
      expect.stringContaining("other@example.test"),
      "warning",
    );
    expect(liveSessionIds().has(sessionId ?? "")).toBe(true);
    expect(useCliAccountStore.getState().busyByProvider.claude).toBe("login:claude");
    expect(useCliLoginStore.getState().byProvider.claude?.stage).toBe("waiting");
  });

  it("ignores events belonging to another login", async () => {
    await startClaudeLogin();

    useCliLoginStore
      .getState()
      .handleFailed({ login_id: "someone-else", code: "cli_account.error.login_timeout" });

    expect(mocks.pushToast).not.toHaveBeenCalled();
    expect(useCliAccountStore.getState().busyByProvider.claude).toBe("login:claude");
  });
});

describe("cliLoginStore tab lifetime", () => {
  it("cancels the backend watch when the login tab is closed by hand", async () => {
    await startClaudeLogin();
    const tabId = loginTab()?.id ?? "";

    useWorkspaceLayoutStore.getState().removeTabFromPane(workspaceId, paneId, tabId);
    useCliLoginStore.getState().handleTabsChanged(liveSessionIds());

    expect(mocks.cancelCliLogin).toHaveBeenCalledWith(loginId);
    expect(useCliAccountStore.getState().busyByProvider.claude).toBeNull();
    expect(useCliLoginStore.getState().byProvider.claude).toBeNull();
  });

  it("leaves a running login alone while its tab is still open", async () => {
    await startClaudeLogin();

    useCliLoginStore.getState().handleTabsChanged(liveSessionIds());

    expect(mocks.cancelCliLogin).not.toHaveBeenCalled();
    expect(useCliLoginStore.getState().byProvider.claude?.stage).toBe("waiting");
  });

  it("cancels the backend watch and closes the tab when the user aborts", async () => {
    await startClaudeLogin();
    const sessionId = loginTab()?.sessionId;

    await useCliLoginStore.getState().cancel("claude");

    expect(mocks.cancelCliLogin).toHaveBeenCalledWith(loginId);
    expect(liveSessionIds().has(sessionId ?? "")).toBe(false);
    expect(useCliAccountStore.getState().busyByProvider.claude).toBeNull();
    // The cancellation event that follows must not raise a second toast.
    useCliLoginStore
      .getState()
      .handleFailed({ login_id: loginId, code: "cli_account.error.login_cancelled" });
    expect(mocks.pushToast).not.toHaveBeenCalled();
  });
});
