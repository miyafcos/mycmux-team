import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pane, PaneTab, Workspace } from "../../src/types";
import { handleSocketCommand, startBackgroundTabSession } from "../../src/components/layout/socketCommands";
import { getAgent, getDefaultAgent } from "../../src/lib/agents";
import { buildTerminalPaneLaunch } from "../../src/lib/terminalPaneLaunch";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useUiStore } from "../../src/stores/uiStore";

const ipc = vi.hoisted(() => ({
  createSession: vi.fn(), ackFrontendData: vi.fn(),
  listRunningSessionIds: vi.fn(), getSessionStatusSnapshot: vi.fn(), getWindowFragments: vi.fn(),
}));
vi.mock("../../src/lib/ipc", () => ipc);

const tab = (overrides: Partial<PaneTab> = {}): PaneTab => ({
  id: "restored-tab", sessionId: "restored-pty", type: "terminal", agentId: "codex",
  agentKind: "codex", agentSessionId: "saved-conversation", cwd: "C:/tab", ...overrides,
});
function workspace(id: string, tabs: PaneTab[], activeTab = tabs[0]): Workspace {
  return {
    id, name: id, gridTemplateId: "1x1", status: "running", createdAt: 1,
    panes: [{ id: `${id}-pane`, agentId: activeTab.agentId, sessionId: activeTab.sessionId,
      activeTabId: activeTab.id, cwd: "C:/pane", launchEnv: { KEEP: "inherited" }, tabs }],
    splitColumns: [[`${id}-pane`]],
  };
}
function install(target: PaneTab = tab(), background = true): Pane {
  const selected = tab({ id: "selected-tab", sessionId: "selected-pty", agentId: "shell" });
  const owner = workspace("owner", [selected, target], selected);
  const visible = workspace("visible", [tab({ id: "visible-tab", sessionId: "visible-pty" })]);
  useWorkspaceListStore.setState({
    workspaces: [visible, owner], activeWorkspaceId: background ? "visible" : "owner",
    lastActivePaneByWorkspace: { visible: "visible-pty", owner: "selected-pty" },
  });
  useUiStore.setState({ activePaneId: background ? "visible-pty" : "selected-pty", focusRevision: 12 });
  return owner.panes[0];
}
const snapshot = (lifecycle?: string) => ({
  server_epoch: "server", seq: 1,
  sessions: lifecycle ? [{ session_id: "restored-pty", status: { lifecycle } }] : [],
});
const foreground = () => ({
  workspace: useWorkspaceListStore.getState().activeWorkspaceId,
  lastActive: useWorkspaceListStore.getState().lastActivePaneByWorkspace,
  pane: useUiStore.getState().activePaneId, revision: useUiStore.getState().focusRevision,
  activeTabs: useWorkspaceListStore.getState().workspaces.flatMap((ws) => ws.panes.map((pane) => pane.activeTabId)),
});

beforeEach(() => {
  vi.resetAllMocks();
  ipc.createSession.mockResolvedValue(undefined);
  ipc.ackFrontendData.mockResolvedValue(undefined);
  ipc.listRunningSessionIds.mockResolvedValue([]);
  ipc.getSessionStatusSnapshot.mockResolvedValue(snapshot());
  ipc.getWindowFragments.mockResolvedValue([]);
  install();
});

describe("pane.start_tab", () => {
  it("requires a session id and reports a missing tab before querying the backend", async () => {
    await expect(handleSocketCommand("pane.start_tab", {})).rejects.toThrow("pane.start_tab requires sessionId");
    await expect(handleSocketCommand("pane.start_tab", { sessionId: "gone" }))
      .rejects.toThrow("pane.start_tab session not found");
    expect(ipc.listRunningSessionIds).not.toHaveBeenCalled();
    expect(ipc.createSession).not.toHaveBeenCalled();
  });

  it.each(["web", "launcher", "browser", "online"] as const)("rejects %s tabs", async (type) => {
    install(tab({ type }));
    await expect(handleSocketCommand("pane.start_tab", { sessionId: "restored-pty" }))
      .rejects.toThrow("pane.start_tab requires a terminal tab");
    expect(ipc.createSession).not.toHaveBeenCalled();
  });

  it("does not bypass declared-tab lifecycle", async () => {
    install(tab({ lifecycle: "declared" }));
    await expect(handleSocketCommand("pane.start_tab", { sessionId: "restored-pty" }))
      .rejects.toThrow("use pane.launch_declared for declared tabs");
    expect(ipc.createSession).not.toHaveBeenCalled();
  });

  it.each(["running_ids", "canonical_alive"])("leaves an existing PTY alone via %s", async (source) => {
    if (source === "running_ids") ipc.listRunningSessionIds.mockResolvedValue(["restored-pty"]);
    else ipc.getSessionStatusSnapshot.mockResolvedValue(snapshot("alive"));
    const before = foreground();
    expect(await handleSocketCommand("pane.start_tab", { sessionId: "restored-pty" })).toEqual({
      started: false, reason: "already_running", sessionId: "restored-pty",
    });
    expect(ipc.createSession).not.toHaveBeenCalled();
    expect(foreground()).toEqual(before);
  });

  it.each([true, false])("starts a saved conversation in place (background workspace=%s)", async (background) => {
    install(tab(), background);
    const before = foreground();
    const workspaces = useWorkspaceListStore.getState().workspaces;
    expect(await handleSocketCommand("pane.start_tab", { sessionId: "restored-pty" })).toEqual({
      started: true, sessionId: "restored-pty",
    });
    expect(ipc.createSession).toHaveBeenCalledExactlyOnceWith(
      "restored-pty", "codex", ["resume", "--no-alt-screen", "-C", "C:/tab", "saved-conversation"],
      80, 24, expect.any(Function), "C:/tab", {
        KEEP: "inherited", MYCMUX_PANE_SESSION_ID: "restored-pty", MYCMUX_TAB_ID: "restored-tab",
        MYCMUX_AGENT_KIND: "codex", MYCMUX_SESSION_ID: "saved-conversation", MYCMUX_RESUME: "codex",
      },
    );
    expect(foreground()).toEqual(before);
    expect(useWorkspaceListStore.getState().workspaces).toBe(workspaces);
    ipc.createSession.mock.calls[0][5]({ generation: 2, seq: 3, bytes: 4 });
    expect(ipc.ackFrontendData).toHaveBeenCalledWith("restored-pty", 2, 3, 4);
  });

  it.each(["exited", "orphaned", "unknown"])("starts a non-running canonical %s PTY with the UI launch plan", async (lifecycle) => {
    const restored = tab({ type: undefined, commandArgv: ["custom.exe", "two words"], launchEnv: {} });
    const pane = install(restored);
    const uiLaunch = buildTerminalPaneLaunch(pane, restored, { getAgent, getDefaultAgent });
    ipc.getSessionStatusSnapshot.mockResolvedValue(snapshot(lifecycle));
    expect(await handleSocketCommand("pane.start_tab", { session_id: restored.sessionId })).toEqual({
      started: true, sessionId: restored.sessionId,
    });
    expect(ipc.createSession).toHaveBeenCalledExactlyOnceWith(
      restored.sessionId, uiLaunch.launchCommand, uiLaunch.launchArgs, 80, 24,
      expect.any(Function), uiLaunch.paneCwd, uiLaunch.launchEnv,
    );
  });

  it("consumes a successful handoff and later resumes its own conversation", async () => {
    install(tab({ agentId: "shell-starter", launchEnv: {
      MYCMUX_HANDOFF: "codex", MYCMUX_HANDOFF_PROMPT_FILE: "task.md", MYCMUX_LAUNCH_TARGET: "codex",
    } }));
    const before = foreground();
    await handleSocketCommand("pane.start_tab", { sessionId: "restored-pty" });
    const firstEnv = ipc.createSession.mock.calls[0][7];
    expect(firstEnv).toMatchObject({ MYCMUX_HANDOFF: "codex", MYCMUX_HANDOFF_PROMPT_FILE: "task.md" });
    expect(firstEnv).not.toHaveProperty("MYCMUX_RESUME");
    await handleSocketCommand("pane.start_tab", { sessionId: "restored-pty" });
    const resumedEnv = ipc.createSession.mock.calls[1][7];
    expect(resumedEnv).toMatchObject({
      MYCMUX_RESUME: "codex", MYCMUX_SESSION_ID: "saved-conversation", MYCMUX_AGENT_KIND: "codex",
    });
    expect(resumedEnv).not.toHaveProperty("MYCMUX_HANDOFF");
    expect(resumedEnv).not.toHaveProperty("MYCMUX_HANDOFF_PROMPT_FILE");
    expect(foreground()).toEqual(before);
  });

  it.each(["launch", "running_ids", "snapshot"])("preserves backend errors from %s without changing the tab", async (source) => {
    const original = tab({ launchEnv: { MYCMUX_HANDOFF: "codex", MYCMUX_HANDOFF_PROMPT_FILE: "task.md" } });
    install(original);
    const error = 'AGENT_SESSION_ALREADY_RUNNING:{"kind":"codex","agentSessionId":"saved-conversation","ownerSessionId":"owner"}';
    const operation = source === "launch" ? ipc.createSession
      : source === "running_ids" ? ipc.listRunningSessionIds : ipc.getSessionStatusSnapshot;
    operation.mockRejectedValueOnce(error);
    const before = useWorkspaceListStore.getState().workspaces;
    await expect(handleSocketCommand("pane.start_tab", { sessionId: original.sessionId })).rejects.toBe(error);
    expect(useWorkspaceListStore.getState().workspaces).toBe(before);
    expect(original.launchEnv?.MYCMUX_HANDOFF).toBe("codex");
    if (source !== "launch") expect(ipc.createSession).not.toHaveBeenCalled();
  });

  it("does not launch a tab closed during the backend guard", async () => {
    let finish!: (ids: string[]) => void;
    ipc.listRunningSessionIds.mockReturnValueOnce(new Promise<string[]>((resolve) => { finish = resolve; }));
    const pending = handleSocketCommand("pane.start_tab", { sessionId: "restored-pty" });
    const rejected = expect(pending).rejects.toThrow("pane.start_tab session not found");
    await vi.waitFor(() => expect(ipc.listRunningSessionIds).toHaveBeenCalled(), { timeout: 10_000 });
    useWorkspaceListStore.setState({ workspaces: [] });
    finish([]);
    await rejected;
    expect(ipc.createSession).not.toHaveBeenCalled();
  });
});

describe("existing spawn launch requests", () => {
  it.each([
    { agentId: "shell", commandArgv: ["custom.exe", "--flag"], launchEnv: { KEEP: "explicit" } },
    { agentId: "codex", launchEnv: { MYCMUX_LAUNCH_TARGET: "codex" } },
    { agentId: "codex", launchEnv: { MYCMUX_RESUME: "codex", MYCMUX_SESSION_ID: "requested-resume" } },
    { agentId: "codex", launchEnv: { MYCMUX_HANDOFF: "codex", MYCMUX_HANDOFF_PROMPT_FILE: "task.md" } },
    { agentId: "shell-starter", launchEnv: {} },
    { agentId: "shell", launchEnv: undefined },
  ])("keeps the original background create parameters for %j", async (options) => {
    const fresh = tab({ ...options, agentKind: undefined, agentSessionId: undefined, cwd: undefined });
    const pane = install(fresh);
    pane.launchEnv = { KEEP: "inherited", MYCMUX_HANDOFF: "do-not-inherit" };
    const launcherDispatch = Boolean(!fresh.commandArgv?.length && (
      options.launchEnv?.MYCMUX_LAUNCH_TARGET || options.launchEnv?.MYCMUX_RESUME || options.launchEnv?.MYCMUX_HANDOFF
    ));
    const agent = launcherDispatch ? getDefaultAgent() : getAgent(fresh.agentId) ?? getDefaultAgent();
    const expectedEnv = {
      ...(options.launchEnv ?? { KEEP: "inherited" }),
      MYCMUX_PANE_SESSION_ID: fresh.sessionId, MYCMUX_TAB_ID: fresh.id,
      ...(launcherDispatch || fresh.agentId === "shell-starter" ? { __CMUX_LAUNCHER_DONE: "1" } : {}),
    };
    await startBackgroundTabSession(fresh, pane);
    expect(ipc.createSession).toHaveBeenCalledExactlyOnceWith(
      fresh.sessionId, fresh.commandArgv?.[0] ?? agent.command,
      fresh.commandArgv?.length ? fresh.commandArgv.slice(1) : agent.args,
      80, 24, expect.any(Function), "C:/pane", expectedEnv,
    );
  });
});
