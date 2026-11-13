import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { buildLaunchSpecEnv } from "../../src/lib/agentCatalog";
import { buildSpawnLaunchEnv } from "../../src/lib/spawnLaunchEnv";
import { persistentTabProjection } from "../../src/lib/persistentLayoutProjection";
import { toConfig, toTransferConfig } from "../../src/components/layout/SocketListener";
import { applyTabAccountToLaunchEnv, buildAgentRecoveryLaunch } from "../../src/components/terminal/terminalLaunchParams";
import { buildTerminalPaneLaunch } from "../../src/lib/terminalPaneLaunch";
import { getAgent, getDefaultAgent } from "../../src/lib/agents";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useUiStore } from "../../src/stores/uiStore";
import { __resetCliAccountStoreForTests } from "../../src/stores/cliAccountStore";
import { __resetCliLoginStoreForTests, useCliLoginStore } from "../../src/stores/cliLoginStore";
import { handleSocketCommand, startBackgroundTabSession } from "../../src/components/layout/socketCommands";
import { buildClonedDuplicateSessionPaneOptions, buildDuplicateSessionPaneOptions } from "../../src/lib/duplicateSession";
import { createSession, listCliAccountHomes, getCliAccountHomeLogin, unregisterCliAccountHome,
  type CliAccountHomeStatus, type CliAccountProfile } from "../../src/lib/ipc";
import { cliAccountMessage, cliAccountHomeLoginMessage } from "../../src/lib/cliAccounts";
import type { Pane, PaneTab, Workspace } from "../../src/types";

const mocks = vi.hoisted(() => ({ usageFetch: vi.fn().mockResolvedValue(undefined), toast: vi.fn() }));
vi.mock("@tauri-apps/api/core", async (original) => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: vi.fn() }));
vi.mock("@tauri-apps/api/path", async (original) => ({ ...await original<typeof import("@tauri-apps/api/path")>(), homeDir: vi.fn().mockResolvedValue("/fixture/home") }));
vi.mock("../../src/components/terminal/XTermWrapper", () => ({ hasTerminalBuffer: () => false, getTerminalWriteCounter: () => 0, getTerminalBufferLines: () => [] }));
vi.mock("../../src/lib/ipc", async (original) => ({ ...await original<typeof import("../../src/lib/ipc")>(), createSession: vi.fn().mockResolvedValue(undefined), killSession: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/stores/usageStore", () => ({ useUsageStore: { getState: () => ({ fetch: mocks.usageFetch }) } }));
vi.mock("../../src/stores/toastStore", () => ({ useToastStore: { getState: () => ({ pushToast: mocks.toast }) } }));

const homes = ["CODEX_HOME", "GROK_HOME", "CODEX_SQLITE_HOME", "GROK_AUTH_PATH", "GROK_LEADER_SOCKET", "MYCMUX_ACCOUNT_HOME_KIND", "MYCMUX_CLI_LOGIN_ID"];
const providers = ["codex", "grok"] as const;
const account = (kind: string) => `${kind}-fixture`;
function tab(kind: "codex" | "grok", overrides: Partial<PaneTab> = {}): PaneTab {
  return { id: "source-tab", sessionId: "source-pty", agentId: kind, agentKind: kind, type: "terminal", agentAccountId: account(kind), ...overrides };
}
function pane(id: string, tabs: PaneTab[]): Pane {
  return { id, agentId: tabs[0].agentId, sessionId: tabs[0].sessionId, activeTabId: tabs[0].id, tabs, launchEnv: tabs[0].launchEnv };
}
function workspace(panes: Pane[], id = "source"): Workspace {
  return { id, name: id, gridTemplateId: "1x1", status: "running", createdAt: 1, panes, splitColumns: panes.map(p => [p.id]) };
}
function install(panes: Pane[]): Workspace {
  const ws = workspace(panes); useWorkspaceListStore.setState({ workspaces: [ws], activeWorkspaceId: ws.id }); return ws;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(invoke).mockReset().mockImplementation(async (command) => command === "list_cli_accounts"
    ? { profiles: [], live: [], active: { claude: null, codex: null, grok: null }, orphans: [], backup_root: "fixture", generated_at: "fixture" }
    : undefined);
  useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null, lastActivePaneByWorkspace: {} });
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {} }); useUiStore.setState({ activePaneId: null, zoomedPaneId: null });
  __resetCliAccountStoreForTests(); __resetCliLoginStoreForTests();
});

describe("per-tab provider selection (T-1)", () => {
  it.each(["claude", "codex", "grok"])("adds only a valid %s ID and preserves model/effort", kind => {
    const original = buildLaunchSpecEnv({ target: kind, model: "fixture-model", effort: "high" });
    expect(buildLaunchSpecEnv({ target: kind, account: account(kind), model: "fixture-model", effort: "high" }))
      .toEqual({ ...original, MYCMUX_LAUNCH_ACCOUNT: account(kind) });
    for (const bad of ["", " ", "../escape", "bad!", "a".repeat(65), "codex/bad"]) {
      expect(buildLaunchSpecEnv({ target: kind, account: bad })).not.toHaveProperty("MYCMUX_LAUNCH_ACCOUNT");
    }
  });
  it("does not attach an account to claude-codex or the wrong provider's new selection", () => {
    expect(buildLaunchSpecEnv({ target: "claude-codex", account: "claude-fixture" })).not.toHaveProperty("MYCMUX_LAUNCH_ACCOUNT");
    for (const kind of providers) expect(buildLaunchSpecEnv({ target: kind, account: "claude-fixture" })).not.toHaveProperty("MYCMUX_LAUNCH_ACCOUNT");
  });
});

describe.each(providers)("%s saved tabs (T-2, T-3)", kind => {
  it("persists/transfers the ID and strips every home/login/token alias", () => {
    const env: Record<string, string> = { KEEP: "kept", CLAUDE_CODE_OAUTH_TOKEN: "fixture-token", mycmux_launch_account: account(kind) };
    for (const key of homes) { env[key] = "/fixture/forged-home"; env[key.toLowerCase()] = "/fixture/forged-home"; }
    const candidate = tab(kind, { launchEnv: env }); const parent = pane("parent", [candidate]); const ws = install([parent]);
    expect(buildSpawnLaunchEnv(env)).toEqual({ KEEP: "kept" });
    expect(persistentTabProjection(candidate).launchEnv).toEqual({ KEEP: "kept" });
    for (const config of [toConfig(ws), toTransferConfig(ws)]) {
      const saved = config.panes[0].tabs![0]; expect(saved.agent_account_id).toBe(account(kind)); expect(saved.launch_env).toEqual({ KEEP: "kept" });
      expect(JSON.stringify(config)).not.toContain("fixture-token"); expect(JSON.stringify(config)).not.toContain("forged-home");
      const restored = useWorkspaceLayoutStore.getState().restorePanes("restored", config.panes, config.split_columns, "1x1");
      const restoredTab = restored.panes[0].tabs[0]; expect(restoredTab.agentAccountId).toBe(account(kind));
      expect(buildTerminalPaneLaunch(restored.panes[0], restoredTab, { getAgent, getDefaultAgent }).launchEnv?.MYCMUX_LAUNCH_ACCOUNT).toBe(account(kind));
      delete saved.agent_account_id;
      const legacy = useWorkspaceLayoutStore.getState().restorePanes("legacy", config.panes, config.split_columns, "1x1");
      expect(legacy.panes[0].tabs[0].agentAccountId).toBeUndefined();
    }
  });
  it.each([false, true])("restores and recovers this tab's ID (fresh=%s)", fresh => {
    for (const savedId of [account(kind), "claude-wrong-provider", "../corrupt-saved-id"]) {
      const candidate = tab(kind, { agentSessionId: "11111111-1111-4111-8111-111111111111", agentAccountId: savedId });
      const plan = buildTerminalPaneLaunch(pane("parent", [candidate]), candidate, { getAgent, getDefaultAgent });
      expect(plan.launchEnv?.MYCMUX_LAUNCH_ACCOUNT).toBe(savedId);
      expect(buildAgentRecoveryLaunch({ command: kind, args: [], agentAccountId: savedId }, kind, candidate.agentSessionId!, fresh)
        .launchEnv?.MYCMUX_LAUNCH_ACCOUNT).toBe(savedId);
    }
  });
  it("keeps the target explicit before the first conversation ID is saved", () => {
    const candidate = tab(kind, { agentKind: undefined });
    const plan = buildTerminalPaneLaunch(pane("parent", [candidate]), candidate, { getAgent, getDefaultAgent });
    expect(plan.launchEnv).toMatchObject({ MYCMUX_LAUNCH_TARGET: kind, MYCMUX_LAUNCH_ACCOUNT: account(kind) });
    const env = { MYCMUX_LAUNCH_ACCOUNT: "stale-parent", CODEX_HOME: "/forged", GROK_HOME: "/forged" };
    applyTabAccountToLaunchEnv(env, kind, undefined); expect(env).toEqual({});
  });
  it("keeps its ID on a background start before agentKind was saved", async () => {
    const candidate = tab(kind, { agentKind: undefined, launchEnv: undefined });
    await startBackgroundTabSession(candidate, pane("parent", [candidate]));
    const sent = vi.mocked(createSession).mock.calls.at(-1)![7];
    expect(sent).toMatchObject({ MYCMUX_LAUNCH_TARGET: kind, MYCMUX_LAUNCH_ACCOUNT: account(kind) });
    for (const key of homes) expect(sent).not.toHaveProperty(key);
  });
  it("keeps the same tab through moves and drops the account from clones and forks", () => {
    const parent = pane("parent", [tab(kind)]); const target = pane("target", [tab(kind, { id: "target-tab", sessionId: "target-pty", agentAccountId: undefined })]);
    install([parent, target]); const store = useWorkspaceLayoutStore.getState();
    store.moveTabToPane("source", "parent", "source-tab", "source", "target");
    expect(useWorkspaceListStore.getState().getWorkspace("source")!.panes.flatMap(p => p.tabs).find(t => t.id === "source-tab")!.agentAccountId).toBe(account(kind));
    store.moveTabToNewWorkspace("source", "target", "source-tab", "destination", "destination");
    expect(useWorkspaceListStore.getState().getWorkspace("destination")!.panes[0].tabs[0].agentAccountId).toBe(account(kind));
    const source = { agentKind: kind, agentSessionId: "source-session", label: "copy", agentAccountId: account(kind) };
    for (const options of [buildClonedDuplicateSessionPaneOptions(source, { agent_kind: kind, source_session_id: "source-session", new_session_id: "new-session", resolved_cwd: "/fixture" }), buildDuplicateSessionPaneOptions(source, "/fixture/handoff.md")]) {
      expect(options).not.toHaveProperty("agentAccountId"); expect("launchEnv" in options ? options.launchEnv : {}).not.toHaveProperty("MYCMUX_LAUNCH_ACCOUNT");
    }
  });
  it.each(["pane.spawn", "pane.spawn_tab"])("does not inherit an account through %s", async command => {
    const parent = pane("parent", [tab(kind, { launchEnv: { MYCMUX_LAUNCH_TARGET: kind, MYCMUX_LAUNCH_ACCOUNT: account(kind), CODEX_HOME: "/forged", GROK_HOME: "/forged" } })]);
    const background = install([parent]); const foreground = workspace([pane("foreground", [tab(kind, { id: "foreground-tab", sessionId: "foreground-pty", agentAccountId: undefined })])], "foreground");
    useWorkspaceListStore.setState({ workspaces: [foreground, background], activeWorkspaceId: foreground.id });
    const result = await handleSocketCommand(command, { workspaceId: "source", anchorSessionId: "source-pty", target: kind, activate: false }) as { sessionId: string };
    const child = useWorkspaceListStore.getState().getWorkspace("source")!.panes.flatMap(p => p.tabs).find(t => t.sessionId === result.sessionId)!;
    expect(child.agentAccountId).toBeUndefined(); expect(child.launchEnv).not.toHaveProperty("MYCMUX_LAUNCH_ACCOUNT");
    const childEnv = vi.mocked(createSession).mock.calls.at(-1)![7];
    for (const key of [...homes, "MYCMUX_LAUNCH_ACCOUNT"]) expect(childEnv).not.toHaveProperty(key);
  }, 15_000);
});

describe("home API and isolated login flow (T-4)", () => {
  it("returns only typed status fields and sends a provider/id to unregister", async () => {
    const home: CliAccountHomeStatus = { provider: "codex", profile_id: account("codex"), state: "ready", owner: "matched", generation: 1 };
    expectTypeOf<Awaited<ReturnType<typeof listCliAccountHomes>>>().toEqualTypeOf<CliAccountHomeStatus[]>();
    vi.mocked(invoke).mockResolvedValueOnce([home]).mockResolvedValueOnce({ login_id: "fixture-login", provider: "codex", profile_id: home.profile_id, state: "ready", reason: null, home }).mockResolvedValueOnce(undefined);
    expect(await listCliAccountHomes()).toEqual([home]); expect((await getCliAccountHomeLogin("fixture-login")).home).toEqual(home);
    await unregisterCliAccountHome("codex", home.profile_id);
    expect(invoke).toHaveBeenCalledWith("unregister_cli_account_home", { provider: "codex", profileId: home.profile_id });
    expect(Object.keys(home).sort()).toEqual(["generation", "owner", "profile_id", "provider", "state"]);
  });
  it.each(["global_staging", "account_home"] as const)("opens %s using only its opaque login ID", async purpose => {
    install([pane("parent", [tab("codex", { agentAccountId: undefined })])]);
    vi.mocked(invoke).mockResolvedValueOnce({ login_id: "fixture-login", provider: "codex", command: "", args: [], env: {}, staging_dir: "" });
    if (purpose === "account_home") await useCliLoginStore.getState().startAccountHome("codex", account("codex"));
    else await useCliLoginStore.getState().start("codex", "new");
    const entry = useCliLoginStore.getState().byProvider.codex!;
    const loginTab = useWorkspaceListStore.getState().workspaces[0].panes[0].tabs.find(t => t.sessionId === entry.sessionId)!;
    expect(loginTab.ephemeral).toBe(true); expect(loginTab.commandArgv).toBeUndefined(); expect(loginTab.launchEnv).toEqual({ MYCMUX_CLI_LOGIN_ID: "fixture-login" });
    const profile: CliAccountProfile = { id: account("codex"), provider: "codex", label: "fixture", email: null, identity_key: "fixture-owner", plan: null, org_name: null, captured_at: "fixture", last_switched_at: null, needs_relogin: false };
    await useCliLoginStore.getState().handleCompleted({ login_id: "fixture-login", profile, updated_existing: true,
      purpose: purpose === "account_home" ? { kind: "account_home", profile_id: profile.id } : { kind: "global_staging" } });
    if (purpose === "account_home") {
      expect(mocks.usageFetch).not.toHaveBeenCalled();
      expect(mocks.toast.mock.calls.some(call => call[2]?.run)).toBe(false);
      expect(vi.mocked(invoke).mock.calls.some(call => ["capture_cli_account", "switch_cli_account", "list_cli_accounts"].includes(call[0]))).toBe(false);
      expect(invoke).toHaveBeenCalledWith("begin_cli_login", { provider: "codex", mode: "reauth", expectedProfileId: profile.id, purpose: { kind: "account_home", profile_id: profile.id } });
    } else {
      expect(mocks.usageFetch).toHaveBeenCalledOnce(); expect(invoke).toHaveBeenCalledWith("list_cli_accounts");
      expect(mocks.toast.mock.calls.some(call => call[2]?.run)).toBe(true);
    }
    expect(useCliLoginStore.getState().byProvider.codex).toBeNull();
  });
  it.each(["login_timeout", "login_cancelled"])("keeps home files in the wording for %s", key => {
    const message = cliAccountHomeLoginMessage(`cli_account.error.${key}`);
    expect(message).not.toBe(cliAccountMessage(`cli_account.error.${key}`));
    expect(message).toContain("\u6b8b"); expect(message).not.toContain("\u7834\u68c4");
  });
  it.each(["home_not_ready", "home_owner_mismatch", "home_isolation_unavailable", "home_in_use", "home_path_invalid"])("provides an actionable message for %s without paths or IDs", key => {
    const message = cliAccountMessage(`cli_account.error.${key}`); expect(message).not.toBe(cliAccountMessage("unknown"));
    expect(message).toContain("\u6b21\u306b\u3059\u308b\u3053\u3068:"); expect(message).not.toContain(account("codex")); expect(message).not.toContain("auth.json");
  });
});

it("explains home_session_unsupported without paths, tokens or internal IDs", () => {
  const message = cliAccountMessage("cli_account.error.home_session_unsupported");
  expect(message).toBe("このアカウント用のタブの会話は、複製と共有にまだ対応していません。元のタブで続けてください。");
  expect(message).not.toMatch(/auth\.json|token|sk-|[A-Za-z]:[\\/]|\.codex|\.grok|cli_account_homes|codex-[a-z0-9]|grok-[a-z0-9]/i);
});
