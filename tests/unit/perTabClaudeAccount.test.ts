import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  getCliLaunchTokens, setCliLaunchToken, removeCliLaunchToken,
  type CliLaunchTokenStatus,
} from "../../src/lib/ipc";
import { cliAccountMessage } from "../../src/lib/cliAccounts";
import { readFileSync } from "node:fs";
import { buildLaunchSpecEnv } from "../../src/lib/agentCatalog";
import { buildSpawnLaunchEnv, EPHEMERAL_LAUNCH_ENV_KEYS } from "../../src/lib/spawnLaunchEnv";
import { persistentTabProjection } from "../../src/lib/persistentLayoutProjection";
import { toConfig, toTransferConfig } from "../../src/components/layout/SocketListener";
import { buildAgentRecoveryLaunch, buildLaunchRequest } from "../../src/components/terminal/terminalLaunchParams";
import { buildTerminalPaneLaunch } from "../../src/lib/terminalPaneLaunch";
import { getAgent, getDefaultAgent } from "../../src/lib/agents";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useUiStore } from "../../src/stores/uiStore";
import { handleSocketCommand } from "../../src/components/layout/socketCommands";
import { buildClonedDuplicateSessionPaneOptions, buildDuplicateSessionPaneOptions } from "../../src/lib/duplicateSession";
import { createSession } from "../../src/lib/ipc";
import type { Pane, PaneTab, Workspace } from "../../src/types";

vi.mock("@tauri-apps/api/core", async (original) => ({
  ...await original<typeof import("@tauri-apps/api/core")>(),
  invoke: vi.fn(),
}));

vi.mock("../../src/components/terminal/XTermWrapper", () => ({
  hasTerminalBuffer: () => false, getTerminalWriteCounter: () => 0, getTerminalBufferLines: () => [],
}));
vi.mock("../../src/lib/ipc", async (original) => ({
  ...await original<typeof import("../../src/lib/ipc")>(), createSession: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
  useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null, lastActivePaneByWorkspace: {} });
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {} });
  useUiStore.setState({ activePaneId: null, zoomedPaneId: null });
});

const accountId = "claude-1a2b3c4d";

describe("per-tab Claude account registration (T-6, T-7)", () => {
  it("exposes only non-secret response types for the three commands", async () => {
    type ContainsToken<T> = "token" extends keyof T ? true : false;
    expectTypeOf<ContainsToken<Awaited<ReturnType<typeof getCliLaunchTokens>>[number]>>().toEqualTypeOf<false>();
    expectTypeOf<ContainsToken<Awaited<ReturnType<typeof setCliLaunchToken>>>>().toEqualTypeOf<false>();
    expectTypeOf<Awaited<ReturnType<typeof removeCliLaunchToken>>>().toEqualTypeOf<void>();
    const record: CliLaunchTokenStatus = { profile_id: accountId, registered_at: "2026-11-11T00:00:00Z",
      expires_at: "2027-11-11T00:00:00Z", owner_check: "unverified", owner_check_status: 403, fingerprint: "0123456789" };
    const mockedInvoke = vi.mocked(invoke);
    mockedInvoke.mockResolvedValueOnce([record]).mockResolvedValueOnce(record).mockResolvedValueOnce(undefined);
    expect(await getCliLaunchTokens()).toEqual([record]);
    const fake = `sk-ant-oat01-${"a".repeat(32)}`;
    expect(await setCliLaunchToken(accountId, fake)).toEqual(record);
    expect(mockedInvoke).toHaveBeenCalledWith("set_cli_launch_token", { profileId: accountId, token: fake });
    expect(await removeCliLaunchToken(accountId)).toBeUndefined();
    expect(mockedInvoke).toHaveBeenCalledWith("get_cli_launch_tokens");
    expect(mockedInvoke).toHaveBeenCalledWith("remove_cli_launch_token", { profileId: accountId });
    expect(Object.keys(record)).not.toContain("token");
    expect(JSON.stringify(record)).not.toContain("sk-ant-");
  });

  it.each(["launch_token_invalid", "launch_account_not_found", "launch_token_owner_mismatch",
    "launch_token_missing", "launch_token_expired"])("provides actionable non-secret wording for %s", (code) => {
    const message = cliAccountMessage(`cli_account.error.${code}`);
    expect(message).not.toBe(cliAccountMessage("unknown"));
    expect(message).toContain("\u6b21\u306b\u3059\u308b\u3053\u3068:");
    expect(message).not.toContain("sk-ant-");
    expect(message).not.toContain(accountId);
  });
});


function tab(overrides: Partial<PaneTab> = {}): PaneTab {
  return { id: "parent-tab", sessionId: "parent-pty", agentId: "claude-code", agentKind: "claude",
    type: "terminal", agentAccountId: accountId, ...overrides };
}
function pane(id: string, tabs: PaneTab[]): Pane {
  return { id, agentId: tabs[0].agentId, sessionId: tabs[0].sessionId,
    activeTabId: tabs[0].id, tabs, launchEnv: tabs[0].launchEnv };
}
function workspace(panes: Pane[]): Workspace {
  return { id: "source", name: "source", gridTemplateId: "1x1", status: "running", createdAt: 1,
    panes, splitColumns: panes.map((p) => [p.id]) };
}
function install(panes: Pane[]): Workspace {
  const ws = workspace(panes);
  useWorkspaceListStore.setState({ workspaces: [ws], activeWorkspaceId: ws.id });
  return ws;
}
function savedParent(): Pane {
  return pane("parent", [tab({ agentSessionId: "saved-claude-session", launchEnv: {
    MYCMUX_LAUNCH_TARGET: "claude", MYCMUX_LAUNCH_ACCOUNT: accountId,
    CLAUDE_CODE_OAUTH_TOKEN: `sk-ant-oat01-${"a".repeat(32)}`,
    mycmux_launch_account: accountId, claude_code_oauth_token: `sk-ant-oat01-${"b".repeat(32)}`, KEEP: "kept",
  } })]);
}

describe("per-tab Claude launch, persistence and ownership (T-1 through T-5)", () => {
  it("adds a validated selector only for Claude without changing model or effort", () => {
    const chosen = buildLaunchSpecEnv({ target: "claude", account: accountId, model: "opus", effort: "max" });
    expect(chosen).toEqual({ MYCMUX_LAUNCH_TARGET: "claude", MYCMUX_LAUNCH_MODEL: "opus",
      MYCMUX_LAUNCH_EFFORT: "max", MYCMUX_LAUNCH_ACCOUNT: accountId });
    expect(buildLaunchSpecEnv({ target: "claude", account: ` \n${accountId}\n` })?.MYCMUX_LAUNCH_ACCOUNT).toBe(accountId);
    for (const target of ["codex", "claude-codex", "grok"]) {
      expect(buildLaunchSpecEnv({ target, account: accountId, model: "unchanged", effort: "high" })).toEqual({
        MYCMUX_LAUNCH_TARGET: target, MYCMUX_LAUNCH_MODEL: "unchanged", MYCMUX_LAUNCH_EFFORT: "high",
      });
    }
    for (const account of ["", " ", "claude bad", "--x", "a".repeat(65), "bad!", "claude/bad", "claude.bad"]) {
      expect(buildLaunchSpecEnv({ target: "claude", account })).not.toHaveProperty("MYCMUX_LAUNCH_ACCOUNT");
    }
    const built = useWorkspaceLayoutStore.getState().buildInitialPanes("new", "1x1", { 0: { target: "claude", account: accountId } });
    expect(built.panes[0].tabs[0].agentAccountId).toBe(accountId);
  });

  it("keeps both ephemeral lists aligned and strips inherited case aliases", () => {
    const socket = readFileSync(new URL("../../src/components/layout/SocketListener.tsx", import.meta.url), "utf8");
    const list = socket.match(/const EPHEMERAL_LAUNCH_ENV_KEYS = new Set\(\[([\s\S]*?)\]\);/)![1];
    for (const key of ["MYCMUX_LAUNCH_ACCOUNT", "CLAUDE_CODE_OAUTH_TOKEN"]) {
      expect(EPHEMERAL_LAUNCH_ENV_KEYS.has(key)).toBe(true);
      expect(list).toContain(`"${key}"`);
    }
    const fake = `sk-ant-oat01-${"b".repeat(32)}`;
    expect(buildSpawnLaunchEnv({ KEEP: "kept", MYCMUX_LAUNCH_ACCOUNT: accountId,
      mycmux_launch_account: accountId, CLAUDE_CODE_OAUTH_TOKEN: fake, Claude_Code_Oauth_Token: fake }))
      .toEqual({ KEEP: "kept" });
  });

  it("persists and transfers only the account ID, then restores it onto the same tab", () => {
    const parent = savedParent();
    const ws = install([parent]);
    expect(persistentTabProjection(parent.tabs[0])).toMatchObject({ agentAccountId: accountId, launchEnv: { KEEP: "kept" } });
    expect(persistentTabProjection(parent.tabs[0]).launchEnv).not.toHaveProperty("MYCMUX_LAUNCH_ACCOUNT");
    expect(persistentTabProjection(parent.tabs[0]).launchEnv).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    for (const config of [toConfig(ws), toTransferConfig(ws)]) {
      expect(config.panes[0].tabs![0].agent_account_id).toBe(accountId);
      expect(config.panes[0].tabs![0].launch_env).toEqual({ KEEP: "kept" });
      expect(JSON.stringify(config)).not.toContain("sk-ant-");
      expect(JSON.stringify(config).toUpperCase()).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
      expect(JSON.stringify(config).toUpperCase()).not.toContain("MYCMUX_LAUNCH_ACCOUNT");
      const restored = useWorkspaceLayoutStore.getState().restorePanes("restored", config.panes, config.split_columns, "1x1");
      const restoredTab = restored.panes[0].tabs[0];
      expect(restoredTab.agentAccountId).toBe(accountId);
      const launch = buildTerminalPaneLaunch(restored.panes[0], restoredTab, { getAgent, getDefaultAgent });
      expect(launch.launchEnv?.MYCMUX_LAUNCH_ACCOUNT).toBe(accountId);
      expect(launch.launchEnv).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    }
  });

  it("keeps the Claude target explicit on cold restore before a conversation ID was saved", () => {
    const candidate = tab({ agentId: "shell", agentSessionId: undefined, launchEnv: undefined });
    const launch = buildTerminalPaneLaunch(pane("cold", [candidate]), candidate, { getAgent, getDefaultAgent });
    expect(launch.agent?.id).toBe("shell-starter");
    expect(launch.launchEnv).toMatchObject({ MYCMUX_LAUNCH_TARGET: "claude", MYCMUX_LAUNCH_ACCOUNT: accountId });
  });

  it.each([false, true])("keeps the explicit account across recovery (fresh=%s)", (fresh) => {
    const parent = savedParent();
    const initial = buildTerminalPaneLaunch(parent, parent.tabs[0], { getAgent, getDefaultAgent });
    const request = buildLaunchRequest(buildAgentRecoveryLaunch({ command: initial.launchCommand, args: initial.launchArgs,
      launchEnv: initial.launchEnv }, "claude", "saved-session", fresh));
    expect(request.env?.MYCMUX_LAUNCH_ACCOUNT).toBe(accountId);
    expect(request.env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(buildAgentRecoveryLaunch({ command: "claude", args: [], agentAccountId: accountId }, "claude", "saved", fresh)
      .launchEnv?.MYCMUX_LAUNCH_ACCOUNT).toBe(accountId);
  });

  it("omits the selector for default and non-Claude tabs, including stale pane fallbacks", () => {
    for (const kind of ["claude", "codex", "claude-codex", "grok"] as const) {
      const parent = savedParent();
      const candidate = tab({ agentKind: kind, agentId: kind === "claude" ? "claude-code" : kind,
        agentAccountId: kind === "claude" ? undefined : accountId, launchEnv: {} });
      const launch = buildTerminalPaneLaunch(parent, candidate, { getAgent, getDefaultAgent });
      // ANSWER-2A-1: saved Codex/Grok IDs reach backend provider validation.
      const expectsAccount = kind === "codex" || kind === "grok";
      if (expectsAccount) expect(launch.launchEnv?.MYCMUX_LAUNCH_ACCOUNT).toBe(accountId);
      else expect(launch.launchEnv).not.toHaveProperty("MYCMUX_LAUNCH_ACCOUNT");
      const recovery = buildAgentRecoveryLaunch({ command: kind, args: [], launchEnv: launch.launchEnv }, kind, "saved", false);
      if (expectsAccount) expect(recovery.launchEnv?.MYCMUX_LAUNCH_ACCOUNT).toBe(accountId);
      else expect(recovery.launchEnv).not.toHaveProperty("MYCMUX_LAUNCH_ACCOUNT");
    }
    const parent = savedParent();
    const sibling = tab({ id: "fresh", agentAccountId: undefined, launchEnv: undefined, agentSessionId: undefined });
    expect(buildTerminalPaneLaunch(parent, sibling, { getAgent, getDefaultAgent }).launchEnv).not.toHaveProperty("MYCMUX_LAUNCH_ACCOUNT");
  });

  it.each(["pane.spawn", "pane.spawn_tab"])("does not copy an account into a new session through %s", async (command) => {
    const parent = savedParent();
    const background = install([parent]);
    const foreground = { ...workspace([pane("foreground", [tab({ id: "foreground-tab", sessionId: "foreground-pty", agentAccountId: undefined })])]), id: "foreground" };
    useWorkspaceListStore.setState({ workspaces: [foreground, background], activeWorkspaceId: foreground.id });
    const result = await handleSocketCommand(command, { workspaceId: "source", anchorSessionId: "parent-pty",
      target: "claude", activate: false }) as { sessionId: string };
    const child = useWorkspaceListStore.getState().getWorkspace("source")!.panes.flatMap((p) => p.tabs)
      .find((candidate) => candidate.sessionId === result.sessionId)!;
    expect(child).toBeDefined();
    expect(child.agentAccountId).toBeUndefined();
    expect(child.launchEnv).not.toHaveProperty("MYCMUX_LAUNCH_ACCOUNT");
    expect(vi.mocked(createSession)).toHaveBeenCalled();
    const env = vi.mocked(createSession).mock.calls.at(-1)![7];
    expect(env).not.toHaveProperty("MYCMUX_LAUNCH_ACCOUNT");
    expect(env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(parent.tabs[0].agentAccountId).toBe(accountId);
  }, 15_000);

  it("retains the ID across pane moves and new-workspace moves", () => {
    const parent = savedParent();
    const target = pane("target", [tab({ id: "target-tab", sessionId: "target-pty", agentAccountId: undefined })]);
    install([parent, target]);
    const store = useWorkspaceLayoutStore.getState();
    store.moveTabToPane("source", "parent", "parent-tab", "source", "target");
    let moved = useWorkspaceListStore.getState().getWorkspace("source")!.panes.flatMap((p) => p.tabs).find((t) => t.id === "parent-tab")!;
    expect(moved.agentAccountId).toBe(accountId);
    store.moveTabToNewWorkspace("source", "target", "parent-tab", "destination", "destination");
    moved = useWorkspaceListStore.getState().getWorkspace("destination")!.panes[0].tabs[0];
    expect(moved.agentAccountId).toBe(accountId);
    expect(moved.sessionId).toBe("parent-pty");
  });

  it("retains the ID when a tab is moved into a split", () => {
    const parent = savedParent();
    const target = pane("target", [tab({ id: "target-tab", sessionId: "target-pty", agentAccountId: undefined })]);
    install([parent, target]);
    useWorkspaceLayoutStore.getState().moveTabToSplit("source", "parent", "parent-tab", "source", "target", "right");
    const moved = useWorkspaceListStore.getState().getWorkspace("source")!.panes.flatMap((p) => p.tabs).find((t) => t.id === "parent-tab")!;
    expect(moved.agentAccountId).toBe(accountId);
  });

  it("does not copy account metadata into duplicated or handoff sessions", () => {
    const source = { agentKind: "claude" as const, agentSessionId: "source-agent", label: "copy",
      cwd: "C:/repo", agentAccountId: accountId };
    const cloned = buildClonedDuplicateSessionPaneOptions(source, { agent_kind: "claude", source_session_id: "source-agent",
      new_session_id: "new-agent", resolved_cwd: "C:/repo" });
    const handed = buildDuplicateSessionPaneOptions(source, "C:/handoff.md");
    for (const options of [cloned, handed]) {
      expect(options).not.toHaveProperty("agentAccountId");
      install([savedParent()]);
      useWorkspaceLayoutStore.getState().addPaneToWorkspaceWithOptions("source", "parent", "right", options);
      const childPane = useWorkspaceListStore.getState().getWorkspace("source")!.panes.find((p) => p.id !== "parent")!;
      expect(childPane.tabs[0].agentAccountId).toBeUndefined();
      expect(buildTerminalPaneLaunch(childPane, childPane.tabs[0], { getAgent, getDefaultAgent }).launchEnv)
        .not.toHaveProperty("MYCMUX_LAUNCH_ACCOUNT");
    }
  });
});


describe("P1-0912-002 record mismatch recovery", () => {
  it("maps the record mismatch error to the exact UTF-8 recovery message", () => {
    const expected = "原因: 登録した長期トークンと、持ち主の確認の記録が合いません。次にすること: 設定のアカウントの画面で、トークンを登録し直してください。";
    expect(Buffer.from(cliAccountMessage("cli_account.error.launch_token_record_mismatch"), "utf8"))
      .toEqual(Buffer.from(expected, "utf8"));
  });
});
