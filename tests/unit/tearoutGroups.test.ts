// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ callbacks: new Map<string, Set<Function>>(), invoke: vi.fn(), emitTo: vi.fn(),
  result: "keep" as "keep" | "escape" | "reject" | "show-failure", published: [] as any[] }));
vi.mock("@tauri-apps/api/core", async (original) => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async (name: string, callback: Function) => {
  const callbacks = mocks.callbacks.get(name) ?? new Set(); callbacks.add(callback); mocks.callbacks.set(name, callbacks);
  return () => callbacks.delete(callback);
}, emit: async () => {}, emitTo: mocks.emitTo }));
vi.mock("../../src/lib/windowContext", () => ({ windowLabel: () => "main", isMainWindow: () => true }));
vi.mock("../../src/lib/tearout/sessionAttachment", () => ({ rememberTearoutDormantSessions: vi.fn(), expectTearoutAttachments: () => ({ ready: Promise.resolve(), dispose: () => {} }) }));
vi.mock("../../src/components/terminal/terminalCache", async (original) => ({
  ...await original<typeof import("../../src/components/terminal/terminalCache")>(), evictTerminalCache: vi.fn(),
}));
import { installTearoutRuntime, tearoutPane, tearoutWorkspace } from "../../src/lib/tearout/runtime";
import { nativeDropAllowed, restoreTearoutGroup } from "../../src/lib/tearout/model";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { buildWindowFragment, toTransferConfig } from "../../src/components/layout/SocketListener";
import { restoreWorkspaceConfigs } from "../../src/lib/workspaceRestore";
import type { Workspace, Pane } from "../../src/types";
import type { DockTarget } from "../../src/stores/detachedDockStore";

function pane(id: string): Pane {
  return { id, agentId: "shell", sessionId: `pty-${id}-b`, activeTabId: `${id}-b`, pinnedTabId: `${id}-a`,
    tabs: ["a", "b"].map(suffix => ({ id: `${id}-${suffix}`, agentId: "shell", sessionId: `pty-${id}-${suffix}`, type: "terminal" })) };
}
function workspace(id: string, split = true): Workspace {
  const panes = split ? [pane(`${id}-first`), pane(`${id}-second`)] : [pane(`${id}-first`)];
  return { id, name: id, createdAt: 1, status: "running", gridTemplateId: "1x1", panes,
    splitColumns: panes.map(p => [p.id]), columnWidths: split ? [.35, .65] : [1],
    rowHeightsPerCol: panes.map(() => [1]), columnDividerPins: split ? [true] : [], rowDividerPinsPerCol: panes.map(() => []) };
}
function dispatch(name: string, payload: any) { for (const callback of [...(mocks.callbacks.get(name) ?? [])]) callback({ payload }); }
let stop = () => {};
beforeEach(() => {
  mocks.callbacks.clear(); mocks.published.length = 0; vi.clearAllMocks(); mocks.result = "keep";
  Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
  const source = workspace("source");
  useWorkspaceListStore.setState({ workspaces: [workspace("neighbor", false), source], activeWorkspaceId: source.id,
    lastActivePaneByWorkspace: { neighbor: "pty-neighbor-first-b", source: source.panes[1].sessionId } });
  useUiStore.setState({ activePaneId: source.panes[1].sessionId, zoomedPaneId: source.panes[1].id });
  useSettingsStore.setState({ nativePaneTearoutEnabled: true });
  mocks.emitTo.mockImplementation(async (_label, name, payload) => {
    if (name.endsWith("tearout-delivery")) dispatch("mycmux://tearout-receipt", { token: payload.token, ok: mocks.result !== "reject" });
    if (name.endsWith("tearout-revoke")) dispatch("mycmux://tearout-receipt", { token: payload.ack, ok: true });
  });
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "tearout_take_spare") return "mycmux-w42";
    if (command === "is_session_alive") return true;
    if (command === "tearout_show" && mocks.result === "show-failure") throw new Error("show failure");
    if (command === "tearout_start_move") dispatch("mycmux://tearout-native", {
      ...args, phase: "end", at: Date.now(), escaped: mocks.result === "escape", receiver: null,
      approval: null, error: null, scale: 1, monitor: null, focus_stolen: false,
    });
  });
  stop = installTearoutRuntime({ serialize: toTransferConfig, publish: async () => { mocks.published.push(buildWindowFragment("transfer")); } });
});
afterEach(() => { stop(); useSettingsStore.setState({ nativePaneTearoutEnabled: false }); });
const gap = { x: 0, y: 0, width: 300, height: 40 };
const offset = { x: 10, y: 10 };

describe("whole-region and workspace transfers", () => {
  it.each(["tab", "workspace"] as const)("a kept %s leaves no transported pane or session in the source or published fragment", async kind => {
    const before = useWorkspaceListStore.getState().workspaces[1];
    const moved = kind === "tab" ? [before.panes[1]] : before.panes;
    const ids = moved.flatMap(p => p.tabs.map(t => t.id));
    if (kind === "tab") await tearoutPane({ kind: "pane", workspaceId: before.id, paneId: moved[0].id, label: "group", tabCount: 2 }, gap, offset);
    else await tearoutWorkspace(before.id, gap, offset);
    for (const current of [useWorkspaceListStore.getState().workspaces, ...mocks.published.map(f => f.workspaces)]) {
      expect(current.flatMap((w: any) => w.panes.flatMap((p: any) => p.tabs.map((t: any) => t.id ?? t.tab_id))).filter((id: string) => ids.includes(id))).toEqual([]);
    }
    expect(useWorkspaceListStore.getState().workspaces.map(w => w.id)).toEqual(kind === "tab" ? ["neighbor", "source"] : ["neighbor"]);
    const delivery = mocks.emitTo.mock.calls.find(([, event]) => event.endsWith("tearout-delivery"))![2];
    expect(delivery.configs.flatMap((w: any) => w.panes.flatMap((p: any) => p.tabs.map((t: any) => t.tab_id)))).toEqual(ids);
    expect(delivery.configs[0].panes.map((p: any) => p.active_tab_id)).toEqual(moved.map(p => p.activeTabId));
    expect(delivery.activeSessionId).toBe(before.panes[1].sessionId);
    expect(mocks.invoke).toHaveBeenCalledWith("tearout_settle", { label: "mycmux-w42" });
  });
  it.each(["tab", "workspace"] as const)("%s preserves split dimensions, selections and sessions after Esc or failure", async kind => {
    for (const outcome of ["escape", "reject", "show-failure"] as const) {
      const before = useWorkspaceListStore.getState().workspaces;
      const remembered = useWorkspaceListStore.getState().lastActivePaneByWorkspace;
      const source = before[1];
      mocks.result = outcome; mocks.invoke.mockClear();
      const pending = kind === "tab"
        ? tearoutPane({ kind: "pane", workspaceId: source.id, paneId: source.panes[1].id, label: "group", tabCount: 2 }, gap, offset)
        : tearoutWorkspace(source.id, gap, offset);
      if (outcome === "show-failure") await expect(pending).rejects.toThrow("show failure"); else await pending;
      expect(useWorkspaceListStore.getState().workspaces).toEqual(before);
      expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe(source.id);
      expect(useUiStore.getState().activePaneId).toBe(source.panes[1].sessionId);
      expect(useUiStore.getState().zoomedPaneId).toBe(source.panes[1].id);
      expect(useWorkspaceListStore.getState().lastActivePaneByWorkspace).toEqual(remembered);
      expect(mocks.invoke.mock.calls.filter(([command]) => command === "tearout_retire")).toHaveLength(1);
      expect(mocks.invoke.mock.calls.filter(([command, args]) => command === "tearout_phase" && args.phase === "rolled_back")).toHaveLength(1);
    }
  });
  it("a workspace window preserves its full split and every live session", async () => {
    const source = useWorkspaceListStore.getState().workspaces[1];
    await tearoutWorkspace(source.id, gap, offset);
    const cfg = mocks.emitTo.mock.calls.find(([, event]) => event.endsWith("tearout-delivery"))![2].configs[0];
    expect(cfg.split_columns).toEqual([[0], [1]]);
    expect(cfg.column_widths).toEqual([.35, .65]);
    expect(cfg.column_divider_pins).toEqual([true]);
    expect(cfg.panes.flatMap((p: any) => p.tabs.map((t: any) => t.session_id))).toEqual(source.panes.flatMap(p => p.tabs.map(t => t.sessionId)));
  });
  it("restoring a removed region keeps unrelated additions", () => {
    const before = workspace("source");
    const current = { ...before, panes: [before.panes[0], pane("new")], splitColumns: [[before.panes[0].id], ["new"]] };
    const restored = restoreTearoutGroup([current], before, [before.panes[1].id], 0)[0];
    expect(restored.panes.map(p => p.id)).toEqual(["source-first", "source-second", "new"]);
    expect(restored.panes[1]).toBe(before.panes[1]);
  });
  it("Esc preserves an implicit grid without introducing a split override", async () => {
    const before = { ...workspace("source"), splitColumns: undefined, columnWidths: undefined,
      rowHeightsPerCol: undefined, columnDividerPins: undefined, rowDividerPinsPerCol: undefined, gridTemplateId: "2x1" };
    useWorkspaceListStore.setState({ workspaces: [before], activeWorkspaceId: before.id });
    mocks.result = "escape";
    await tearoutPane({ kind: "pane", workspaceId: before.id, paneId: before.panes[1].id, label: "group", tabCount: 2 }, gap, offset);
    expect(useWorkspaceListStore.getState().workspaces).toEqual([before]);
    expect(useWorkspaceListStore.getState().workspaces[0].splitColumns).toBeUndefined();
  });
});

describe("transported groups land at the requested state", () => {
  const directions = ["left", "right", "up", "down"] as const;
  it.each(["strip", "center", ...directions, "sidebar"])("a region keeps all its panes ordered at %s", kind => {
    const incoming = workspace("incoming", false);
    const receiver = useWorkspaceListStore.getState().workspaces[0];
    const target = receiver.panes[0];
    const placement = kind === "sidebar" ? { kind: "workspace" as const }
      : kind === "strip" ? { kind: "pane" as const, workspaceId: receiver.id, paneId: target.id, index: 1 }
      : { kind: "pane-zone" as const, workspaceId: receiver.id, paneId: target.id, zone: kind as "center" | typeof directions[number] };
    const cfg = toTransferConfig(incoming);
    restoreWorkspaceConfigs([cfg], { dockDetached: true, placementByWorkspaceId: { [cfg.id]: placement } });
    const current = useWorkspaceListStore.getState().workspaces;
    const result = current.find(w => w.id === (kind === "sidebar" ? incoming.id : receiver.id))!;
    if (kind === "sidebar") expect(result.panes[0].tabs.map(t => t.id)).toEqual(["incoming-first-a", "incoming-first-b"]);
    else if (kind === "strip" || kind === "center") expect(result.panes[0].tabs.map(t => t.id)).toEqual(kind === "strip"
      ? ["neighbor-first-a", "incoming-first-a", "incoming-first-b", "neighbor-first-b"]
      : ["neighbor-first-a", "neighbor-first-b", "incoming-first-a", "incoming-first-b"]);
    else {
      expect(result.panes.find(p => p.id === "incoming-first")!.tabs.map(t => t.id)).toEqual(["incoming-first-a", "incoming-first-b"]);
      expect(result.splitColumns).toEqual(kind === "left" ? [["incoming-first"], [target.id]]
        : kind === "right" ? [[target.id], ["incoming-first"]]
        : kind === "up" ? [["incoming-first", target.id]] : [[target.id, "incoming-first"]]);
    }
  });
  it.each(["strip", "center", ...directions, "sidebar"])("receiver adoption and revocation restore selection and geometry at %s", async kind => {
    const before = useWorkspaceListStore.getState().workspaces;
    const remembered = useWorkspaceListStore.getState().lastActivePaneByWorkspace;
    const active = useUiStore.getState().activePaneId;
    const zoom = useUiStore.getState().zoomedPaneId;
    const receiver = before[0];
    const target = receiver.panes[0];
    const incoming = workspace("incoming", false);
    const placement = kind === "sidebar" ? { kind: "workspace" as const }
      : kind === "strip" ? { kind: "pane" as const, workspaceId: receiver.id, paneId: target.id, index: 1 }
      : { kind: "pane-zone" as const, workspaceId: receiver.id, paneId: target.id, zone: kind as "center" | typeof directions[number] };
    dispatch("mycmux://tearout-delivery", { token: `delivery-${kind}`, source: "peer", configs: [toTransferConfig(incoming)],
      placement, activeSessionId: incoming.panes[0].sessionId });
    await vi.waitFor(() => expect(mocks.emitTo).toHaveBeenCalledWith("peer", "mycmux://tearout-receipt", { token: `delivery-${kind}`, ok: true }));
    expect(useUiStore.getState().activePaneId).toBe(incoming.panes[0].sessionId);
    expect(useWorkspaceListStore.getState().workspaces.flatMap(ws => ws.panes).find(p => p.tabs.some(t => t.id === "incoming-first-b"))!.activeTabId).toBe("incoming-first-b");
    dispatch("mycmux://tearout-revoke", { token: `delivery-${kind}`, ack: `revoke-${kind}`, source: "peer" });
    await vi.waitFor(() => expect(mocks.emitTo).toHaveBeenCalledWith("peer", "mycmux://tearout-receipt", { token: `revoke-${kind}`, ok: true }));
    expect(useWorkspaceListStore.getState().workspaces).toEqual(before);
    expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe("source");
    expect(useUiStore.getState().activePaneId).toBe(active);
    expect(useUiStore.getState().zoomedPaneId).toBe(zoom);
    expect(useWorkspaceListStore.getState().lastActivePaneByWorkspace).toEqual(remembered);
  });
  it("only the sidebar accepts workspaces containing multiple regions", () => {
    const targets: DockTarget[] = [{ kind: "workspace" }, { kind: "tab-index", workspaceId: "w", paneId: "p", index: 0 },
      ...["center", ...directions].map(zone => ({ kind: "pane-zone" as const, workspaceId: "w", paneId: "p", zone: zone as "center" | typeof directions[number] }))];
    expect(targets.map(target => nativeDropAllowed(2, target))).toEqual([true, false, false, false, false, false, false]);
    expect(targets.every(target => nativeDropAllowed(1, target))).toBe(true);
    const cfg = toTransferConfig(workspace("incoming"));
    restoreWorkspaceConfigs([cfg], { dockDetached: true, placementByWorkspaceId: { [cfg.id]: { kind: "workspace" } } });
    const restored = useWorkspaceListStore.getState().getWorkspace("incoming")!;
    expect(restored.splitColumns).toEqual([["incoming-first"], ["incoming-second"]]);
    expect(restored.columnWidths).toEqual([.35, .65]);
  });
});
