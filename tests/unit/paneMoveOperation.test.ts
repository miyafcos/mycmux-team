// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../src/types";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useSessionAttentionStore } from "../../src/stores/sessionAttentionStore";
import * as moves from "../../src/lib/paneMoveOperation";
import * as native from "../../src/lib/tearout/runtime";
import * as ordinary from "../../src/lib/workspaceTearOut";
import { commitPaneDragDrop } from "../../src/hooks/usePaneDragSource";

vi.mock("@tauri-apps/api/core", async original => ({ ...await original<object>(), invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));

const source = { kind: "tab", workspaceId: "w", paneId: "p", tabId: "t", label: "Terminal" } as const;
const split = { kind: "split", workspaceId: "w", paneId: "q", zone: "right" } as const;
const gap = { x: 0, y: 0, width: 90, height: 30 };
const nativeWindow = { kind: "native-window", gap, offset: { x: 10, y: 10 } } as const;
const ordinaryWindow = { kind: "window", x: 400, y: 300 } as const;

function workspace(): Workspace {
  const panes = ["p", "q"].map((id, i) => ({ id, agentId: "shell", sessionId: `pty-${i}`, activeTabId: i ? "q-tab" : "t",
    tabs: (i ? ["q-tab"] : ["t", "sibling"]).map(id => ({ id, sessionId: `pty-${id}`, agentId: "shell", type: "terminal" as const })) }));
  return { id: "w", name: "Test", gridTemplateId: "1x1", status: "running", createdAt: 0, panes, splitColumns: [["p", "q"]] };
}
function resetWorkspace() { useWorkspaceListStore.setState({ workspaces: [workspace()], activeWorkspaceId: "w" }); }
function feed(epoch: number, server = "server") {
  useSessionAttentionStore.getState().applySnapshot({ server_epoch: server, seq: epoch, sessions: [{ session_id: "pty-t", session_revision: epoch,
    status: { session_epoch: epoch, lifecycle: "alive", ui_state: "working", attention: { attention_id: null, kind: "none", detail: null, state_since: 0 } } }] });
}

beforeEach(() => {
  vi.restoreAllMocks();
  resetWorkspace();
  useSessionAttentionStore.getState().resetForTests();
  const transport = async (_request: unknown, execution: moves.PaneMoveExecution) => {
    execution.assertSource();
    execution.mark("committed", "child"); execution.mark("received", "child"); execution.mark("cleaned", "child");
    return execution.result("moved");
  };
  vi.spyOn(native, "performNativePaneMove").mockImplementation(transport);
  vi.spyOn(ordinary, "performWorkspaceWindowMove").mockImplementation(transport);
});

describe("common pane move contract", () => {
  it("commits a split synchronously through the existing store", () => {
    const result = moves.executePaneMove(moves.createPaneMoveRequest(source, split));
    expect(result).toMatchObject({ status: "moved", phase: "committed", receipt: "not_expected" });
    expect(useWorkspaceListStore.getState().workspaces[0].panes.find(p => p.id === "p")?.tabs.map(t => t.id)).toEqual(["sibling"]);
    expect(useWorkspaceListStore.getState().workspaces[0].panes.some(p => p.id !== "p" && p.tabs.some(t => t.id === "t"))).toBe(true);
  });

  it("uses the same original owner snapshot at all three actual entries", async () => {
    feed(7);
    const execute = vi.spyOn(moves, "executePaneMove");
    commitPaneDragDrop(source, { kind: "pane", workspaceId: "w", paneId: "q", zone: "right" });
    resetWorkspace();
    await native.tearoutTab(source, gap, nativeWindow.offset);
    resetWorkspace();
    commitPaneDragDrop(source, { kind: "new-window", screenX: 440, screenY: 320 });
    await vi.waitFor(() => expect(ordinary.performWorkspaceWindowMove).toHaveBeenCalledOnce());
    const requests = execute.mock.calls.map(([request]) => request);
    expect(requests.map(request => request.destination.kind)).toEqual(["split", "native-window", "window"]);
    expect(requests.map(request => request.source)).toEqual([source, source, source]);
    for (const request of requests) {
      expect(request.requestedBy).toEqual({ kind: "ui", windowLabel: "main" });
      expect(request.expected.owners).toEqual([{ paneId: "p", tabId: "t", sessionId: "pty-t", type: "terminal", lifecycle: undefined,
        execution: { serverEpoch: "server", sessionEpoch: 7 } }]);
    }
  });

  it.each([split, nativeWindow, ordinaryWindow])("rejects non-transferable tabs before %j execution", async destination => {
    for (const overrides of [{ type: "online" as const }, { ephemeral: true }]) {
      resetWorkspace();
      const tab = useWorkspaceListStore.getState().workspaces[0].panes[0].tabs[0]; Object.assign(tab, overrides);
      const before = structuredClone(useWorkspaceListStore.getState().workspaces);
      const result = await moves.executePaneMove(moves.createPaneMoveRequest(source, destination));
      expect(result).toMatchObject({ status: "refused", reason: "not_transferable", phase: "requested" });
      expect(useWorkspaceListStore.getState().workspaces).toEqual(before);
    }
    expect(native.performNativePaneMove).not.toHaveBeenCalled(); expect(ordinary.performWorkspaceWindowMove).not.toHaveBeenCalled();
  });

  it.each(["requester", "owner", "duplicate"] as const)("rejects a changed %s", kind => {
    const request = moves.createPaneMoveRequest(source, split);
    if (kind === "requester") request.requestedBy.windowLabel = "peer";
    if (kind === "owner") request.expected.windowLabel = "peer";
    if (kind === "duplicate") useWorkspaceListStore.getState().workspaces[0].panes[1].tabs.push({ ...workspace().panes[0].tabs[0] });
    expect(moves.executePaneMove(request)).toMatchObject({ status: "refused", reason: "owner_changed" });
  });

  it.each(["sessionId", "lifecycle", "epoch", "server"] as const)("refuses a stale %s before any store move", kind => {
    feed(7);
    const request = moves.createPaneMoveRequest(source, split);
    const tab = useWorkspaceListStore.getState().workspaces[0].panes[0].tabs[0];
    if (kind === "sessionId") tab.sessionId = "replacement";
    if (kind === "lifecycle") tab.lifecycle = "declared";
    if (kind === "epoch") feed(8);
    if (kind === "server") feed(7, "new-server");
    expect(moves.executePaneMove(request)).toMatchObject({ status: "refused", reason: "execution_changed", phase: "requested" });
  });

  it("leaves an unobserved execution explicit rather than inventing a generation", () => {
    expect(moves.createPaneMoveRequest(source, split).expected.owners[0].execution).toBeUndefined();
  });

  it("checks identity again after an asynchronous transport preparation", async () => {
    feed(7);
    let ready!: () => void;
    const waiting = new Promise<void>(resolve => { ready = resolve; });
    vi.mocked(ordinary.performWorkspaceWindowMove).mockImplementationOnce(async (_request, execution) => {
      await waiting; execution.assertSource(); execution.mark("committed", "child"); return execution.result("moved");
    });
    const request = moves.createPaneMoveRequest({ kind: "workspace", workspaceId: "w", label: "Test" }, ordinaryWindow);
    const pending = moves.executePaneMove(request);
    await vi.waitFor(() => expect(ordinary.performWorkspaceWindowMove).toHaveBeenCalledOnce());
    feed(8); ready();
    expect(await pending).toMatchObject({ status: "failed", phase: "requested", receipt: "pending", reason: expect.stringContaining("execution_changed") });
    expect(useWorkspaceListStore.getState().workspaces[0].panes).toHaveLength(2);
  });

  it("returns the receipt phase and operation id for both window destinations", async () => {
    for (const destination of [nativeWindow, ordinaryWindow]) {
      resetWorkspace();
      const request = moves.createPaneMoveRequest(source, destination);
      expect(await moves.executePaneMove(request)).toMatchObject({ operationId: request.operationId, status: "moved", phase: "cleaned",
        receipt: "acknowledged", destinationWindow: "child" });
    }
  });

  it("keeps the minimap pane anchor fallback when its active tab id is stale", () => {
    const originalPane = useWorkspaceListStore.getState().workspaces[0].panes[0];
    originalPane.activeTabId = "removed-tab";
    const result = moves.executePaneMove(moves.createPaneMoveRequest({ kind: "pane", workspaceId: "w", paneId: "p",
      label: "Terminal", surface: "minimap" }, { ...split, zone: "center", atomic: true }));
    expect(result).toMatchObject({ status: "moved", phase: "committed" });
    const state = useWorkspaceListStore.getState();
    expect(state.workspaces[0].panes.find(pane => pane.id === "p")).toBeUndefined();
    expect(state.workspaces[0].panes.find(pane => pane.id === "q")?.tabs.map(tab => tab.id)).toEqual(["q-tab", "t", "sibling"]);
    expect(state.activeWorkspaceId).toBe("w");
  });

  it("refuses a stale minimap revision without a partial layout commit", () => {
    const before = structuredClone(useWorkspaceListStore.getState().workspaces);
    const result = moves.executePaneMove(moves.createPaneMoveRequest({ ...source, surface: "minimap", sourceLayoutRevision: "stale" }, { ...split, atomic: true }));
    expect(result).toMatchObject({ status: "refused", reason: "stale_revision" });
    expect(useWorkspaceListStore.getState().workspaces).toEqual(before);
  });
});
