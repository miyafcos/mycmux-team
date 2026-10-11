// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emitTo: vi.fn(async () => {}) }));
vi.mock("../../src/components/terminal/XTermWrapper", () => ({ hasTerminalBuffer: () => false, getTerminalWriteCounter: () => 0, getTerminalBufferLines: () => [] }));
import * as ipc from "../../src/lib/ipc";
import { handleSocketCommand as handleRoutedSocketCommand } from "../../src/components/layout/socketCommands";
import { webPaneCommandContext } from "../../src/components/workspace/webPaneCommandQueue";
import { toConfig } from "../../src/components/layout/SocketListener";
import { delegationForCaller, resolveDelegationState, rememberDelegationFragments, delegationParentsFromFragments } from "../../src/components/dashboard/delegationModel";
import { detachedWorkspaceConfig } from "../../src/lib/detachedPane";
import { persistentTabProjection } from "../../src/lib/persistentLayoutProjection";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useUiStore } from "../../src/stores/uiStore";
import { beginSessionAttach, __resetAttachEpochStateForTests } from "../../src/lib/attachEpoch";
import type { Workspace, PaneTab } from "../../src/types";

function workspace(): Workspace {
  const parent: PaneTab = { id: "parent", sessionId: "parent-session", agentId: "claude", type: "terminal", label: "Coordinator" };
  return { id: "owner", name: "Workspace", gridTemplateId: "1x1", status: "running", createdAt: 1,
    panes: [{ id: "pane", sessionId: parent.sessionId, agentId: parent.agentId, activeTabId: parent.id, tabs: [parent] }],
    splitColumns: [["pane"]] };
}
function allTabs() { return useWorkspaceListStore.getState().workspaces.flatMap(ws => ws.panes.flatMap(pane => pane.tabs)); }
// Integration routing reads the accepted window registry before dispatching.
// These lane tests exercise the owner handler: delegation itself reads nothing.
function handleSocketCommand(cmd: string, args: Parameters<typeof handleRoutedSocketCommand>[1]) {
  const context = webPaneCommandContext(cmd);
  return handleRoutedSocketCommand(cmd, args, { context, expiresAt: context.deadline });
}
beforeEach(() => {
  vi.restoreAllMocks();
  rememberDelegationFragments([]);
  __resetAttachEpochStateForTests();
  useWorkspaceListStore.setState({ workspaces: [workspace()], activeWorkspaceId: null, lastActivePaneByWorkspace: {} });
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: { "parent-session": { ptyAlive: true, liveAgentKind: "claude" } }, lastLog: {}, lastLogAt: {} });
  useUiStore.setState({ activePaneId: null });
  useSettingsStore.setState({ declaredLaunchEnabled: true });
  vi.spyOn(ipc, "createSession").mockImplementation(async id => {
    beginSessionAttach(id, { deliver: () => {}, ackStale: () => {} }).commit();
  });
  vi.spyOn(ipc, "killSession").mockResolvedValue(undefined);
  vi.spyOn(ipc, "setFrontendVisible").mockResolvedValue(undefined);
  vi.spyOn(ipc, "listRunningSessionIds").mockResolvedValue([]);
  vi.spyOn(ipc, "getSessionStatusSnapshot").mockResolvedValue({ server_epoch: "test", seq: 1, sessions: [] } as never);
});


describe("FIX-2 non-blocking delegation entrypoints", () => {
  it.each(["pane.spawn", "pane.spawn_tab", "pane.declare_tab"])("G2 F8 %s succeeds once while the caller is unobserved with zero delegation RPCs", async cmd => {
    usePaneMetadataStore.setState({ volatileMetadata: {} });
    const snapshots = vi.spyOn(ipc, "getPtyMetadataSnapshot").mockImplementation(() => new Promise(() => {}));
    const fragments = vi.spyOn(ipc, "getWindowFragments").mockRejectedValue(new Error("unavailable"));
    await handleSocketCommand(cmd, { anchorSessionId: "parent-session", sessionId: "parent-session", label: "Worker", commandArgv: ["echo", "work"] });
    const child = allTabs().find(tab => tab.id !== "parent")!;
    expect(child).toBeDefined();
    expect(child.delegatedByTabId).toBe("parent");
    expect(child.delegatedByAgentSessionId).toBeUndefined();
    expect(child.delegatedAt).toEqual(expect.any(Number));
    expect(allTabs()).toHaveLength(2);
    expect(snapshots).not.toHaveBeenCalled();
    expect(fragments).not.toHaveBeenCalled();
  });
  it.each(["shell-to-agent", "agent-to-shell"])("G4 F8 %s cannot make creation depend on a stale process cache", async direction => {
    const before = Date.now();
    usePaneMetadataStore.setState({ volatileMetadata: { "parent-session": {
      ptyAlive: true, liveAgentKind: direction === "shell-to-agent" ? null : "claude", liveAgentObservedAt: before - 1000,
    } } });
    const snapshots = vi.spyOn(ipc, "getPtyMetadataSnapshot").mockRejectedValue(new Error("stale cache"));
    await handleSocketCommand("pane.spawn_tab", { anchorSessionId:"parent-session",commandArgv:["echo","work"] });
    const child = allTabs().find(tab => tab.id !== "parent")!;
    expect(child.delegatedByTabId).toBe("parent");
    expect(child.delegatedByAgentSessionId).toBeUndefined();
    const parent = {tabId:"parent",label:"Parent",alive:direction === "shell-to-agent",state:direction === "shell-to-agent" ? "alive" as const : "ended" as const,
      processStartedAt:child.delegatedAt!+1,checkedAt:Date.now()};
    expect(resolveDelegationState(child,parent,Date.now())).toBe("ended");
    expect(snapshots).not.toHaveBeenCalled();
  });
  it("G9 declare-tab resolves a moved destination without awaiting a delegation lookup", async () => {
    const snapshots = vi.spyOn(ipc,"getPtyMetadataSnapshot").mockImplementation(() => new Promise(() => {}));
    const old = workspace(), moved = {...workspace(),id:"new-ws"};
    const pending = handleSocketCommand("pane.declare_tab",{paneId:"pane",anchorSessionId:"parent-session",label:"Moved worker"});
    useWorkspaceListStore.setState({workspaces:[{...old,panes:[]},moved]});
    const result = await pending as {tabId:string};
    expect(useWorkspaceListStore.getState().getWorkspace("new-ws")!.panes[0].tabs.some(tab=>tab.id===result.tabId)).toBe(true);
    expect(allTabs()).toHaveLength(2);
    expect(snapshots).not.toHaveBeenCalled();
  });
  it("G2 a passed stable caller ID cannot select an unrelated peer without a PTY ID", () => {
    const config = toConfig(workspace());
    config.panes[0].tabs![0].session_id = undefined;
    config.panes[0].tabs![0].tab_id = "unrelated-peer";
    rememberDelegationFragments([{ window_label: "peer", workspaces: [config] }]);
    expect(delegationForCaller([workspace()], {}, undefined, "passed-caller")).toMatchObject({
      delegatedByTabId: "passed-caller", delegatedAt: expect.any(Number),
    });
  });
  it("G2 known current conversation is captured without looking up the process", async () => {
    usePaneMetadataStore.setState({volatileMetadata:{"parent-session":{ptyAlive:true,liveAgentKind:"claude",liveAgentSessionId:"conversation-A"}}});
    await handleSocketCommand("pane.spawn_tab",{anchorSessionId:"parent-session",commandArgv:["echo","work"]});
    expect(allTabs().find(tab=>tab.id!=="parent")?.delegatedByAgentSessionId).toBe("conversation-A");
  });
  it("F11 G9 cached peer caller facts survive declare and launch-declared with zero delegation RPCs", async () => {
    const peer = workspace(); peer.id = "peer-ws";
    peer.panes[0].tabs[0] = {...peer.panes[0].tabs[0],id:"remote-parent",sessionId:"remote-session"};
    peer.panes[0].sessionId="remote-session"; peer.panes[0].activeTabId="remote-parent";
    rememberDelegationFragments([{window_label:"peer",workspaces:[toConfig(peer)]}]);
    const fragments=vi.spyOn(ipc,"getWindowFragments").mockRejectedValue(new Error("unavailable"));
    const snapshots=vi.spyOn(ipc,"getPtyMetadataSnapshot").mockRejectedValue(new Error("unavailable"));
    const result=await handleSocketCommand("pane.declare_tab",{paneId:"pane",anchorSessionId:"remote-session",label:"Remote worker",declaredTarget:"codex"}) as {tabId:string};
    const declared=allTabs().find(tab=>tab.id===result.tabId)!;
    const created=declared.delegatedAt;
    expect(declared.delegatedByTabId).toBe("remote-parent");
    await handleSocketCommand("pane.launch_declared",{tabId:result.tabId,requestId:"F11-launch"});
    expect(allTabs().find(tab=>tab.id===result.tabId)).toMatchObject({delegatedByTabId:"remote-parent",delegatedAt:created,type:"terminal"});
    expect(fragments).not.toHaveBeenCalled(); expect(snapshots).not.toHaveBeenCalled();
  });
});

describe("delegating pane persistence and entrypoints", () => {
  it.each(["pane.spawn", "pane.spawn_tab"])("T16 %s records an agent caller using its stable tab id", async cmd => {
    await handleSocketCommand(cmd, { anchorSessionId: "parent-session", commandArgv: ["echo", "work"] });
    const child = allTabs().find(tab => tab.id !== "parent")!;
    expect(child.delegatedByTabId).toBe("parent");
    expect(useUiStore.getState().activePaneId).toBeNull();
  });
  it("declare-tab records the caller and launch-declared preserves the same owner", async () => {
    const declared = await handleSocketCommand("pane.declare_tab", {
      sessionId: "parent-session", anchorSessionId: "parent-session", label: "Worker", declaredTarget: "codex",
    }) as { tabId: string };
    expect(allTabs().find(tab => tab.id === declared.tabId)?.delegatedByTabId).toBe("parent");
    await handleSocketCommand("pane.launch_declared", { tabId: declared.tabId, requestId: "launch-worker" });
    expect(allTabs().find(tab => tab.id === declared.tabId)).toMatchObject({ delegatedByTabId: "parent", type: "terminal" });
  });
  it("start-tab preserves the recorded owner instead of changing it to the starter", async () => {
    const ws = workspace();
    ws.panes[0].tabs.push({ id: "child", sessionId: "child-session", agentId: "shell-starter", type: "terminal", delegatedByTabId: "parent" });
    useWorkspaceListStore.setState({ workspaces: [ws] });
    await handleSocketCommand("pane.start_tab", { sessionId: "child-session", anchorSessionId: "parent-session" });
    expect(allTabs().find(tab => tab.id === "child")?.delegatedByTabId).toBe("parent");
  });
  it.each(["pane.spawn", "pane.spawn_tab"])("T19 %s records caller facts but a plain shell cannot become a delegation parent", async cmd => {
    usePaneMetadataStore.setState({ volatileMetadata: { "parent-session": { ptyAlive: true, liveAgentKind: null } } });
    await handleSocketCommand(cmd, { anchorSessionId: "parent-session", commandArgv: ["echo", "work"] });
    const child = allTabs().find(tab => tab.id !== "parent")!;
    expect(child.delegatedByTabId).toBe("parent");
    expect(resolveDelegationState(child, { tabId:"parent",label:"Shell",alive:false,state:"ended" }, Date.now())).toBe("ended");
  });
  it("T19 saved agent identity and a non-agent caller cannot claim delegation", () => {
    const ws = workspace(); ws.panes[0].tabs[0].agentKind = "claude";
    const facts = delegationForCaller([ws], {}, "parent-session");
    expect(facts.delegatedByTabId).toBe("parent");
    expect(facts.delegatedByAgentSessionId).toBeUndefined();
    expect(resolveDelegationState(facts, {tabId:"parent",label:"later agent",alive:true,state:"alive",processStartedAt:facts.delegatedAt!+1}, Date.now())).toBe("ended");
    expect(delegationForCaller([ws], {}, undefined)).toEqual({});
  });
  it("T20 old data without delegation survives hydration and serialization", () => {
    const old: ipc.PaneConfig = { pane_id: "old-pane", agent_id: "shell-starter", label: null, tabs: [
      { tab_id: "old-tab", agent_id: "shell-starter", type: "terminal", label: "Old" },
    ] };
    const restored = useWorkspaceLayoutStore.getState().restorePanes("restored", [old], undefined, "1x1");
    expect(restored.panes[0].tabs[0].delegatedByTabId).toBeUndefined();
    const ws = { ...workspace(), id: "restored", panes: restored.panes };
    const saved = toConfig(ws, { "shell-starter": "shell-starter" });
    expect(saved.panes[0].tabs?.[0].delegated_by_tab_id).toBeNull();
    expect(saved.panes[0].tabs?.[0].label).toBe("Old");
  });
  it("delegation survives save, app restore, projection and moving to another tab", () => {
    const ws = workspace();
    ws.panes[0].tabs.push({ id: "child", sessionId: "child-session", agentId: "codex", type: "terminal", delegatedByTabId: "parent", delegatedByAgentSessionId: "conversation-A", delegatedAt: 123456 });
    const saved = toConfig(ws, { claude: "claude", codex: "codex" });
    expect(saved.panes[0].tabs?.find(tab => tab.tab_id === "child")?.delegated_by_tab_id).toBe("parent");
    const restored = useWorkspaceLayoutStore.getState().restorePanes("owner", saved.panes, undefined, "1x1");
    useWorkspaceListStore.setState({ workspaces: [{ ...ws, panes: restored.panes }] });
    const child = allTabs().find(tab => tab.id === "child")!;
    expect(persistentTabProjection(child)).toMatchObject({delegatedByTabId:"parent",delegatedByAgentSessionId:"conversation-A",delegatedAt:123456});
    const parentPane = useWorkspaceListStore.getState().workspaces[0].panes[0];
    useWorkspaceLayoutStore.getState().addPaneToWorkspace("owner", parentPane.id, "right");
    const destination = useWorkspaceListStore.getState().workspaces[0].panes.find(pane => pane.id !== parentPane.id)!;
    useWorkspaceLayoutStore.getState().moveTabToPane("owner", parentPane.id, "child", "owner", destination.id);
    expect(allTabs().find(tab => tab.id === "child")?.delegatedByTabId).toBe("parent");
  });
  it("T16 stable parent ids still resolve through a detached-window fragment and process snapshot", () => {
    const config = toConfig(workspace(), { claude: "claude" }, "transfer");
    const detached = detachedWorkspaceConfig(config, { workspace_id: "owner", pane_id: "pane", tab_id: "parent", index: 0 })!;
    expect(detached.panes[0].tabs?.[0].tab_id).toBe("parent");
    const fragments = [{ window_label: "mycmux-w2", workspaces: [detached] }];
    const parents = delegationParentsFromFragments(fragments, { "parent-session": { live_agent_kind: "claude" } } as ipc.PtyMetadataSnapshot);
    expect(parents.parent).toMatchObject({ tabId: "parent", label: "Coordinator", alive: true, state: "alive", sessionId: "parent-session" });
    expect(delegationParentsFromFragments(fragments, {}).parent.alive).toBe(false);
    expect(delegationParentsFromFragments([], {})).toEqual({});
  });
});
