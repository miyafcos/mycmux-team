import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionKind, PaneTab, Workspace } from "../../src/types";
import type { PtyMetadata } from "../../src/lib/ipc";
import { applyPtyMetadata, connectLiveAgentHydration, hydrateLiveAgents } from "../../src/lib/liveAgentMetadata";
import { resetShellObservation } from "../../src/lib/agentSessionClearGuard";
import { resolveTabMark } from "../../src/lib/tabMark";
import { resolveDisplayAgentKind } from "../../src/lib/agentDisplayKind";
import { deriveEffectiveStatus } from "../../src/lib/notificationStatus";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { toConfig, toTransferConfig } from "../../src/components/layout/SocketListener";
import { restoreWorkspaceConfigs } from "../../src/lib/workspaceRestore";
import { serializePaneForSocket, handleSocketCommand } from "../../src/components/layout/socketCommands";
import { otherWindowWorkspaces, serializeOtherWindowPanes } from "../../src/lib/socketTabWindows";
import { buildDashboardCards } from "../../src/components/dashboard/dashboardModel";
import { buildMinimapModel } from "../../src/components/dashboard/minimapModel";
import { resolveActiveAgentLabel } from "../../src/components/workspace/PaneTabBar";

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(), exits: new Map<string, () => void>(), unlisten: vi.fn(),
}));
vi.mock("../../src/lib/ipc", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/lib/ipc")>(),
  getPtyMetadataSnapshot: mocks.snapshot,
  onPtyExit: async (id: string, callback: () => void) => { mocks.exits.set(id, callback); return mocks.unlisten; },
}));
const A = "401caf0d-c8d1-4c12-b0d4-ed291d41d356";
const B = "e78c5e20-7286-4008-8c19-145dcc08211e";
const stops: Array<() => void> = [];

function workspace(id = "main", overrides: Partial<PaneTab> = {}): Workspace {
  const tab: PaneTab = { id: "tab-" + id, sessionId: "pty-" + id, agentId: "claude-code",
    type: "terminal", agentKind: "claude", agentSessionId: A, claudeSessionId: A, ...overrides };
  return { id, name: id, createdAt: 1, status: "running", gridTemplateId: "1x1",
    panes: [{ id: "pane-" + id, agentId: tab.agentId, sessionId: tab.sessionId, activeTabId: tab.id, tabs: [tab] }],
    splitColumns: [["pane-" + id]] };
}
function metadata(overrides: Partial<PtyMetadata> = {}): PtyMetadata {
  return { session_id: "pty-main", cwd: "C:/work", process_name: "claude.exe", process_status: "working",
    agent_active: true, live_agent_kind: "claude", agent_kind: "claude", agent_session_id: A, claude_session_id: A,
    ...overrides };
}
function tab(id = "main"): PaneTab {
  return useWorkspaceListStore.getState().workspaces.find(ws => ws.id === id)!.panes[0].tabs[0];
}
function mark(id = "main") {
  const current = tab(id);
  const live = usePaneMetadataStore.getState().volatileMetadata[current.sessionId];
  return resolveTabMark(current, live?.liveAgentKind, live?.ptyAlive === true);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks(); mocks.exits.clear(); mocks.snapshot.mockResolvedValue({});
  useWorkspaceListStore.getState()._replaceWorkspaces([workspace()]);
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {}, lastLog: {}, lastLogAt: {} });
  resetShellObservation("pty-main");
});
afterEach(() => { for (const stop of stops.splice(0)) stop(); vi.useRealTimers(); });

describe("live agent marks and restoration authority", () => {
  it("U1 clears a live mark on one null event even when waiting blocks restoration clearing", () => {
    applyPtyMetadata(metadata());
    usePaneMetadataStore.getState().setMetadata("pty-main", { agentStatus: "waiting" });
    applyPtyMetadata(metadata({ agent_active: false, live_agent_kind: null, process_name: "bash.exe", process_status: "idle" }));
    expect(mark()).toBeNull();
    expect(tab()).toMatchObject({ agentKind: "claude", agentSessionId: A });
    expect(usePaneMetadataStore.getState().volatileMetadata["pty-main"]).toMatchObject({ liveAgentKind: null, ptyAlive: true });
  });

  it("U2 preserves a Claude root across two PowerShell foreground observations", () => {
    vi.useFakeTimers(); vi.setSystemTime(100_000);
    const root = metadata({ process_name: "powershell.exe", agent_active: false });
    applyPtyMetadata(root);
    vi.setSystemTime(140_000);
    applyPtyMetadata(root);
    expect(mark()).toMatchObject({ kind: "claude", source: "live", dormant: false });
    expect(tab()).toMatchObject({ agentKind: "claude", agentSessionId: A });
    const saved = usePaneMetadataStore.getState().metadata["pty-main"];
    expect(saved.processIsShell).toBe(false);
    expect(saved.backendProcessStatus).toBe("working");
    expect(deriveEffectiveStatus(saved)).toBe("working");
  });

  it("U3 rejects a descendant's Codex conversation when the selected live agent is Claude", () => {
    applyPtyMetadata(metadata());
    applyPtyMetadata(metadata({ agent_kind: "codex", agent_session_id: B, claude_session_id: undefined }));
    expect(tab()).toMatchObject({ agentKind: "claude", agentSessionId: A });
    expect(usePaneMetadataStore.getState().metadata["pty-main"]).toMatchObject({ agentKind: "claude", agentSessionId: A });
    expect(mark()?.kind).toBe("claude");
  });

  it.each(["tear-out", "dock", "child"])("U4 hydrates an adopted %s workspace without a change event", async path => {
    const ready = deferred<void>();
    useWorkspaceListStore.getState()._replaceWorkspaces([]);
    mocks.snapshot.mockResolvedValue({ "pty-main": metadata() });
    stops.push(connectLiveAgentHydration(ready.promise));
    restoreWorkspaceConfigs([toTransferConfig(workspace())], { dockDetached: path === "dock" });
    ready.resolve();
    await vi.waitFor(() => expect(mark()).toMatchObject({ kind: "claude", source: "live" }), { timeout: 3000 });
    expect(mocks.snapshot).toHaveBeenCalledTimes(1);
    expect(mark()?.source).toBe("live");
    const moved = workspace("next", { agentKind: "codex", agentSessionId: B, claudeSessionId: undefined });
    mocks.snapshot.mockResolvedValue({ "pty-next": metadata({ session_id: "pty-next", live_agent_kind: "codex" }) });
    restoreWorkspaceConfigs([toTransferConfig(moved)], { dockDetached: true });
    await vi.waitFor(() => expect(mark("next")).toMatchObject({ kind: "codex", source: "live" }), { timeout: 3000 });
    expect(mocks.snapshot).toHaveBeenCalledTimes(2);
  });

  it("U5 detects an agy pane after launch env is stripped and clears it on null", () => {
    const agy = workspace("main", { agentKind: undefined, agentSessionId: undefined, claudeSessionId: undefined,
      commandArgv: ["agy.exe"], launchEnv: { MYCMUX_LAUNCH_TARGET: "agy" } });
    const config = toTransferConfig(agy);
    expect(JSON.stringify(config)).not.toContain("MYCMUX_LAUNCH_TARGET");
    useWorkspaceListStore.getState()._replaceWorkspaces([]);
    restoreWorkspaceConfigs([config]);
    applyPtyMetadata(metadata({ live_agent_kind: "antigravity", agent_kind: undefined, agent_session_id: undefined, claude_session_id: undefined }));
    expect(mark()?.kind).toBe("antigravity");
    applyPtyMetadata(metadata({ agent_active: false, live_agent_kind: null, process_name: "bash.exe" }));
    expect(mark()).toBeNull();
    expect(tab().agentKind).toBeUndefined();
  });

  it("U6 gives a not-started PTY a dormant saved mark", () => {
    expect(mark()).toMatchObject({ kind: "claude", source: "saved", dormant: true });
  });

  it("U7 ignores unknown sticky metadata and skips unknown saved strings to command evidence", () => {
    usePaneMetadataStore.getState().setMetadata("pty-main", { agentKind: "future-agent" as AgentSessionKind });
    expect(mark()?.kind).toBe("claude");
    expect(resolveDisplayAgentKind("future-agent", ["codex.exe"])).toBe("codex");
    expect(resolveDisplayAgentKind("future-agent", ["unknown"], "hermes")).toBe("hermes");
    expect(resolveDisplayAgentKind("__proto__", ["constructor"], "__proto__")).toBeNull();
  });

  it("U8 still displays live identity when the saved conversation claim loses", () => {
    useWorkspaceListStore.getState()._replaceWorkspaces([workspace(), workspace("owner", {
      agentKind: "codex", agentSessionId: B, claudeSessionId: undefined,
    })]);
    applyPtyMetadata(metadata({ live_agent_kind: "codex", agent_kind: "codex", agent_session_id: B, claude_session_id: undefined }));
    expect(tab()).toMatchObject({ agentKind: "claude", agentSessionId: A });
    expect(mark()).toMatchObject({ kind: "codex", source: "live" });
  });

  it("keeps the eight-second restore clear guard independent of immediate display null", () => {
    vi.useFakeTimers(); vi.setSystemTime(100_000);
    applyPtyMetadata(metadata());
    const shell = metadata({ agent_active: false, live_agent_kind: null, process_name: "bash.exe" });
    applyPtyMetadata(shell);
    expect(mark()).toBeNull();
    expect(tab().agentSessionId).toBe(A);
    vi.setSystemTime(107_999); applyPtyMetadata(shell);
    expect(tab().agentSessionId).toBe(A);
    vi.setSystemTime(108_000); applyPtyMetadata(shell);
    expect(tab().agentSessionId).toBeUndefined();
    expect(tab().agentKind).toBeUndefined();
  });

  it("writes live and null observations only into the volatile slice and never into data.json", () => {
    applyPtyMetadata(metadata());
    const persisted = usePaneMetadataStore.getState().metadata;
    usePaneMetadataStore.getState().setLiveAgent("pty-main", null, true);
    expect(usePaneMetadataStore.getState().metadata).toBe(persisted);
    expect(JSON.stringify(toConfig(useWorkspaceListStore.getState().workspaces[0]))).not.toMatch(/liveAgentKind|live_agent_kind|ptyAlive/);
    expect(tab().agentSessionId).toBe(A);
  });

  it("preserves the last usable CWD during an empty monitor observation", () => {
    applyPtyMetadata(metadata());
    applyPtyMetadata(metadata({ cwd: "" }));
    expect(usePaneMetadataStore.getState().metadata["pty-main"].cwd).toBe("C:/work");
    expect(mark()?.source).toBe("live");
  });

  it("disposes a late exit listener from before same-id removal and re-adoption", async () => {
    const ipc = await import("../../src/lib/ipc");
    const old = deferred<() => void>();
    const oldUnlisten = vi.fn();
    vi.spyOn(ipc, "onPtyExit").mockImplementationOnce(() => old.promise);
    mocks.snapshot.mockResolvedValue({ "pty-main": metadata() });
    stops.push(connectLiveAgentHydration(Promise.resolve()));
    await vi.waitFor(() => expect(mark()?.source).toBe("live"), { timeout: 3000 });
    useWorkspaceListStore.getState()._replaceWorkspaces([]);
    useWorkspaceListStore.getState()._replaceWorkspaces([workspace()]);
    await vi.waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(2), { timeout: 3000 });
    old.resolve(oldUnlisten);
    await vi.waitFor(() => expect(oldUnlisten).toHaveBeenCalledOnce(), { timeout: 3000 });
    expect(mark()?.source).toBe("live");
    mocks.exits.get("pty-main")!();
    expect(mark()?.source).toBe("saved");
  });

  it("never resurrects a newer live null from an older in-flight snapshot", async () => {
    const old = deferred<Record<string, PtyMetadata>>();
    mocks.snapshot.mockReturnValueOnce(old.promise);
    const pending = hydrateLiveAgents(["pty-main"]);
    applyPtyMetadata(metadata({ agent_active: false, live_agent_kind: null }));
    old.resolve({ "pty-main": metadata() });
    await pending;
    expect(mark()).toBeNull();
  });

  it("drops an in-flight snapshot after the session leaves this window", async () => {
    const old = deferred<Record<string, PtyMetadata>>();
    mocks.snapshot.mockReturnValueOnce(old.promise);
    const pending = hydrateLiveAgents(["pty-main"]);
    useWorkspaceListStore.getState()._replaceWorkspaces([]);
    old.resolve({ "pty-main": metadata() });
    await pending;
    expect(usePaneMetadataStore.getState().volatileMetadata["pty-main"]).toBeUndefined();
  });

  it("exits to a saved dormant mark and protects the exit from an in-flight snapshot", async () => {
    applyPtyMetadata(metadata());
    const old = deferred<Record<string, PtyMetadata>>();
    mocks.snapshot.mockReturnValueOnce(old.promise);
    stops.push(connectLiveAgentHydration(Promise.resolve()));
    await vi.waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(1), { timeout: 3000 });
    mocks.exits.get("pty-main")!();
    old.resolve({ "pty-main": metadata() });
    await vi.waitFor(() => expect(mark()?.source).toBe("saved"), { timeout: 3000 });
    expect(mark()?.dormant).toBe(true);
    expect(usePaneMetadataStore.getState().volatileMetadata["pty-main"]).toMatchObject({ ptyAlive: false, liveAgentKind: null });
  });

  it("uses the same identity in the heading, dashboard, minimap and socket rows", () => {
    applyPtyMetadata(metadata({ live_agent_kind: "codex", agent_kind: "codex", agent_session_id: B }));
    const state = usePaneMetadataStore.getState();
    const ws = useWorkspaceListStore.getState().workspaces[0];
    const cards = buildDashboardCards([ws], { metadataBySession: state.metadata,
      volatileMetadataBySession: state.volatileMetadata, lastLogBySession: {}, lastLogAtBySession: {},
      attentionBySession: {}, seenAttentionByTab: new Map(), doneMarkByTab: new Map(), stallsBySession: {},
      now: Date.now(), hasTerminalBuffer: () => true });
    const mini = buildMinimapModel(ws, { metadataBySession: state.volatileMetadata });
    expect(cards[0].mark?.kind).toBe("codex");
    expect(cards[0].agentKind).toBe("codex");
    expect(mini.columns[0].cells[0].chips[0].mark?.kind).toBe("codex");
    expect(resolveActiveAgentLabel(tab().agentId, mark()?.kind ?? null)).toBe("Codex");
    usePaneMetadataStore.getState().setLiveAgent("pty-main", null, true);
    expect(resolveActiveAgentLabel(tab().agentId, mark()?.kind ?? null)).toBe("シェル");
  });

  it("serializes live/null/saved/preset authority for local and other-window tabs", async () => {
    const ws = useWorkspaceListStore.getState().workspaces[0];
    const process = metadata({ live_agent_kind: "codex", agent_kind: "codex" });
    const context = { activeSessionId: null, metadata: {}, processMetadata: { "pty-main": process },
      processMetadataAvailable: true, lastOutputBySession: {}, isTerminalMounted: () => false };
    expect(serializePaneForSocket(ws.panes[0], context).tabs[0]).toMatchObject({
      displayKind: "codex", liveAgentKind: "codex", markSource: "live", agentKind: "claude",
    });
    context.processMetadata["pty-main"].live_agent_kind = null;
    expect(serializePaneForSocket(ws.panes[0], context).tabs[0]).toMatchObject({
      displayKind: null, liveAgentKind: null, markSource: "live",
    });
    expect(serializePaneForSocket(ws.panes[0], { ...context, processMetadata: {} }).tabs[0]).toMatchObject({
      displayKind: "claude", liveAgentKind: null, markSource: "saved",
    });
    const peer = toTransferConfig(workspace("peer"));
    const entries = otherWindowWorkspaces([{ window_label: "mycmux-w2", workspaces: [peer] }], new Set());
    expect(serializeOtherWindowPanes(entries, { "pty-peer": metadata({ live_agent_kind: "hermes" }) })[0].tabs[0])
      .toMatchObject({ displayKind: "hermes", liveAgentKind: "hermes", markSource: "live" });
    mocks.snapshot.mockResolvedValue({ "pty-main": metadata({ live_agent_kind: "omp" }) });
    const ipc = await import("../../src/lib/ipc");
    vi.spyOn(ipc, "getWindowFragments").mockResolvedValue([]);
    vi.spyOn(ipc, "getSessionOutputSnapshot").mockResolvedValue({});
    const all = await handleSocketCommand("pane.list_all", {}) as { panes: Array<{ tabs: Array<Record<string, unknown>> }> };
    expect(all.panes[0].tabs[0]).toMatchObject({ displayKind: "omp", liveAgentKind: "omp", markSource: "live" });
    const web = workspace("web", { type: "web", presetId: "chatgpt" });
    expect(serializePaneForSocket(web.panes[0], { ...context, processMetadata: {} }).tabs[0])
      .toMatchObject({ displayKind: "codex", liveAgentKind: null, markSource: "preset" });
  });
});

it("SI display-only scans cannot rewrite saved tab or metadata fallback identities", () => {
  applyPtyMetadata(metadata({ agent_session_trusted: true }));
  applyPtyMetadata(metadata({ agent_session_trusted: false, agent_session_id: B, claude_session_id: B }));
  expect(tab()).toMatchObject({ agentSessionId: A, claudeSessionId: A });
  expect(usePaneMetadataStore.getState().metadata["pty-main"]).toMatchObject({ agentSessionId: A, claudeSessionId: A });
  const saved = toConfig(useWorkspaceListStore.getState().workspaces[0]);
  expect(saved.panes[0].tabs?.[0]).toMatchObject({ agent_session_id: A, claude_session_id: A });
});
