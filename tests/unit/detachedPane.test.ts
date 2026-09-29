import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/components/terminal/XTermWrapper", () => ({
  hasTerminalBuffer: () => false,
  getTerminalWriteCounter: () => 0,
  getTerminalBufferLines: () => [],
}));

import { portableSessionId, detachedOriginForDrag, isDetachableTab, isTransferableTab, detachedWorkspaceConfig, detachedWorkspaceForWindow, resolveDetachedReturnTarget } from "../../src/lib/detachedPane";
import { restoreWorkspaceConfigs } from "../../src/lib/workspaceRestore";
import * as ipc from "../../src/lib/ipc";
import { tearOutWorkspaceToNewWindow } from "../../src/lib/workspaceTearOut";
import { toConfig } from "../../src/components/layout/SocketListener";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import type { PaneConfig } from "../../src/lib/ipc";
import type { Workspace } from "../../src/types";

const carriedId = "pty-original-workspace-original-pane-original-tab";

function config(sessionId?: string | null, tabId = "tab"): PaneConfig {
  return {
    pane_id: "pane",
    agent_id: "claude-code",
    label: null,
    tabs: [{ tab_id: tabId, agent_id: "claude-code", session_id: sessionId }],
  };
}

function restore(configs: PaneConfig[]) {
  return useWorkspaceLayoutStore.getState().restorePanes("destination", configs, undefined, "1x1").panes;
}

beforeEach(() => {
  useWorkspaceListStore.getState()._replaceWorkspaces([]);
});

describe("portableSessionId", () => {
  it("accepts an unoccupied PTY identity without mutating the occupied set", () => {
    const occupied = new Set(["pty-another"]);
    expect(portableSessionId(carriedId, occupied)).toBe(carriedId);
    expect([...occupied]).toEqual(["pty-another"]);
  });

  it.each([undefined, null, "", "session-tab", "PTY-tab"])(
    "rejects a missing or invalid identity: %s", (id) => {
      expect(portableSessionId(id, new Set())).toBeUndefined();
    },
  );

  it("rejects an identity already owned by a local tab", () => {
    expect(portableSessionId(carriedId, new Set([carriedId]))).toBeUndefined();
  });
});

describe("restored PTY identities", () => {
  it("preserves session_id across different workspace and pane identities", () => {
    expect(restore([config(carriedId)])[0].tabs[0].sessionId).toBe(carriedId);
  });

  it("keeps the legacy session ID format when session_id is absent", () => {
    const legacy = config();
    delete legacy.tabs![0].session_id;
    expect(restore([legacy])[0].tabs[0].sessionId).toBe("pty-destination-pane-tab");
  });

  it.each([null, "session-foreign"])("rebuilds invalid session_id %s", (id) => {
    expect(restore([config(id)])[0].tabs[0].sessionId).toBe("pty-destination-pane-tab");
  });

  it("rebuilds an ID already present even on an inactive tab in another workspace", () => {
    const panes = restore([config("pty-active", "active")]);
    panes[0].tabs.push({ id: "inactive", sessionId: carriedId, agentId: "claude-code", type: "terminal" });
    useWorkspaceListStore.getState().createWorkspace("Existing", "1x1", panes, [["pane"]], {
      id: "existing", activate: false,
    });
    expect(restore([config(carriedId)])[0].tabs[0].sessionId).toBe("pty-destination-pane-tab");
    expect(useWorkspaceListStore.getState().workspaces[0].panes[0].tabs[1].sessionId).toBe(carriedId);
  });

  it("does not carry the same identity twice in one incoming batch", () => {
    const first = config(carriedId, "first");
    const second = { ...config(carriedId, "second"), pane_id: "second-pane" };
    const panes = restore([first, second]);
    expect(panes.map((pane) => pane.tabs[0].sessionId)).toEqual([
      carriedId, "pty-destination-second-pane-second",
    ]);
  });

  it("preserves session IDs through toConfig then restorePanes", () => {
    const panes = restore([config(carriedId)]);
    const workspace: Workspace = {
      id: "source", name: "Source", gridTemplateId: "1x1", status: "running",
      createdAt: 1, panes, splitColumns: [["pane"]],
    };
    const saved = toConfig(workspace);
    expect(saved.panes[0].tabs![0].session_id).toBe(carriedId);
    expect(restore(saved.panes)[0].tabs[0].sessionId).toBe(carriedId);
  });
});


function sourceWorkspace(): Workspace {
  const panes = restore([config(carriedId)]);
  panes[0].tabs.unshift({ id: "before", sessionId: "pty-before", agentId: "shell", type: "terminal" });
  return { id: "source", name: "Source", gridTemplateId: "1x1", status: "running", createdAt: 1,
    panes, splitColumns: [["pane"]] };
}

const origin = { workspace_id: "source", pane_id: "pane", tab_id: "tab", index: 1 };

function transferConfig() {
  const workspace = sourceWorkspace();
  workspace.id = "transfer";
  workspace.panes[0].tabs.shift();
  return toConfig(workspace);
}

describe("single-pane detached windows", () => {
  it("captures the original workspace, pane, tab and index before the move", () => {
    expect(detachedOriginForDrag(sourceWorkspace(), { kind: "tab", paneId: "pane", tabId: "tab" }))
      .toEqual({ ...origin, column: 0, row: 0, column_size: 1 });
  });

  it.each(["terminal", "launcher", "browser", "web"] as const)("accepts a single %s tab", (type) => {
    const source = sourceWorkspace();
    source.panes[0].tabs[1].type = type;
    expect(detachedOriginForDrag(source, { kind: "tab", paneId: "pane", tabId: "tab" }))
      .toEqual({ ...origin, column: 0, row: 0, column_size: 1 });
  });

  it.each(["online"] as const)("leaves %s transfers on the existing path", (type) => {
    const source = sourceWorkspace();
    source.panes[0].tabs[1].type = type;
    expect(detachedOriginForDrag(source, { kind: "tab", paneId: "pane", tabId: "tab" })).toBeUndefined();
  });

  it.each(["tab-bundle", "pane"])("leaves %s transfers on the existing path", (kind) => {
    expect(detachedOriginForDrag(sourceWorkspace(), { kind, paneId: "pane", tabId: "tab" })).toBeUndefined();
  });

  it("builds an isolated one-tab workspace with unchanged session identity and origin", () => {
    const input = transferConfig();
    const before = structuredClone(input);
    const result = detachedWorkspaceConfig(input, origin)!;
    expect(input).toEqual(before);
    expect(result).toMatchObject({ id: "transfer", detached: true, detached_from: origin,
      grid_template_id: "1x1", split_columns: [[0]], column_widths: [1], row_heights_per_col: [[1]] });
    expect(result.panes).toHaveLength(1);
    expect(result.panes[0].tabs).toHaveLength(1);
    expect(result.panes[0].tabs![0].session_id).toBe(carriedId);
    expect(result.detached_from).not.toBe(origin);
  });

  it("does not mark an empty or multi-tab workspace as detached", () => {
    const input = transferConfig();
    expect(detachedWorkspaceConfig({ ...input, panes: [] }, origin)).toBeNull();
    input.panes[0].tabs!.push({ tab_id: "extra", agent_id: "shell" });
    expect(detachedWorkspaceConfig(input, origin)).toBeNull();
  });

  it("restores and republishes detached metadata, including through a stripped persistence snapshot", () => {
    const saved = detachedWorkspaceConfig(transferConfig(), origin)!;
    restoreWorkspaceConfigs([saved]);
    const live = useWorkspaceListStore.getState().getWorkspace("transfer")!;
    expect(detachedWorkspaceForWindow([live], false)).toBe(live);
    expect(toConfig(live).detached_from).toEqual(origin);
    const snapshot = { ...live } as Workspace & { detached?: boolean; detached_from?: unknown };
    delete snapshot.detached;
    delete snapshot.detached_from;
    expect(toConfig(snapshot)).toMatchObject({ detached: true, detached_from: origin });
    expect(detachedWorkspaceForWindow([live], true)).toBeNull();
    expect(detachedWorkspaceForWindow([live, sourceWorkspace()], false)).toBeNull();
    expect(detachedWorkspaceForWindow([], false)).toBeNull();
    expect(detachedWorkspaceForWindow([sourceWorkspace()], false)).toBeNull();
  });
});


describe("detached window transfer", () => {
  it("opens at the requested position and 720x520, preserving the PTY, then removes the source", async () => {
    restoreWorkspaceConfigs([transferConfig()]);
    const open = vi.spyOn(ipc, "openWorkspaceWindow").mockResolvedValue("child");
    try {
      expect(await tearOutWorkspaceToNewWindow("transfer", { x: 460, y: 580, detachedFrom: origin })).toBe("child");
      expect(open).toHaveBeenCalledWith(expect.objectContaining({ x: 460, y: 580, width: 720, height: 520,
        workspaces: [expect.objectContaining({ detached: true, detached_from: origin })] }));
      expect(open.mock.calls[0][0].workspaces[0].panes[0].tabs![0].session_id).toBe(carriedId);
      expect(useWorkspaceListStore.getState().getWorkspace("transfer")).toBeUndefined();
    } finally { open.mockRestore(); }
  });

  it("keeps the transfer workspace and its session if opening the child fails", async () => {
    restoreWorkspaceConfigs([transferConfig()]);
    const before = useWorkspaceListStore.getState().getWorkspace("transfer");
    const open = vi.spyOn(ipc, "openWorkspaceWindow").mockRejectedValue(new Error("open failed"));
    try {
      await expect(tearOutWorkspaceToNewWindow("transfer", { detachedFrom: origin })).rejects.toThrow("open failed");
      expect(useWorkspaceListStore.getState().getWorkspace("transfer")).toBe(before);
    } finally { open.mockRestore(); }
  });
});


describe("docking detached panes", () => {
  it.each([
    { columns: [["pane"], ["neighbor"]], expected: [["pane"], ["neighbor"]] },
    { columns: [["neighbor"], ["pane"]], expected: [["neighbor"], ["pane"]] },
    { columns: [["pane", "neighbor"]], expected: [["pane", "neighbor"]] },
    { columns: [["neighbor", "pane"]], expected: [["neighbor", "pane"]] },
  ])("recreates a removed lone-tab pane at its captured position: $columns", ({ columns, expected }) => {
    const source = sourceWorkspace();
    source.panes[0].tabs.shift();
    source.panes[0].activeTabId = "tab";
    source.panes.push({ id: "neighbor", agentId: "shell", sessionId: "pty-neighbor", activeTabId: "neighbor-tab",
      tabs: [{ id: "neighbor-tab", agentId: "shell", sessionId: "pty-neighbor", type: "terminal" }] });
    source.splitColumns = columns;
    const store = useWorkspaceListStore.getState();
    store._replaceWorkspaces([source]);
    store.setActiveWorkspace(source.id);
    const captured = detachedOriginForDrag(source, { kind: "tab", paneId: "pane", tabId: "tab" })!;
    expect(useWorkspaceLayoutStore.getState().moveTabToNewWorkspace("source", "pane", "tab", "transfer", "Transfer", { activate: false }))
      .toBe(true);
    const transfer = useWorkspaceListStore.getState().getWorkspace("transfer")!;
    const saved = detachedWorkspaceConfig(toConfig(transfer), captured)!;
    const remaining = useWorkspaceListStore.getState().getWorkspace("source")!;
    expect(remaining.panes.map((pane) => pane.id)).toEqual(["neighbor"]);
    store._replaceWorkspaces([remaining]);
    expect(restoreWorkspaceConfigs([saved], { dockDetached: true }).restoredWorkspaceIds).toEqual(["source"]);
    const restored = useWorkspaceListStore.getState().getWorkspace("source")!;
    expect(restored.splitColumns).toEqual(expected);
    expect(restored.panes.find((pane) => pane.id === "pane")!.tabs[0].sessionId).toBe(carriedId);
    expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe("source");
    expect(useWorkspaceListStore.getState().workspaces).toHaveLength(1);
  });

  it("recreates a missing pane from column and row alone", () => {
    const source = sourceWorkspace();
    source.panes[0].id = "neighbor";
    source.panes[0].tabs.pop();
    source.splitColumns = [["neighbor"]];
    useWorkspaceListStore.getState()._replaceWorkspaces([source]);
    const saved = detachedWorkspaceConfig(transferConfig(), { ...origin, column: 0, row: 1 })!;
    restoreWorkspaceConfigs([saved], { dockDetached: true });
    expect(useWorkspaceListStore.getState().getWorkspace("source")!.splitColumns).toEqual([["neighbor", "pane"]]);
  });

  it("keeps legacy origins without coordinates on the workspace fallback", () => {
    const source = sourceWorkspace();
    source.panes = [];
    source.splitColumns = [];
    useWorkspaceListStore.getState()._replaceWorkspaces([source]);
    const saved = detachedWorkspaceConfig(transferConfig(), origin)!;
    expect(restoreWorkspaceConfigs([saved], { dockDetached: true }).restoredWorkspaceIds).toEqual(["transfer"]);
    expect(useWorkspaceListStore.getState().getWorkspace("source")!.panes).toHaveLength(0);
  });

  it.each([{ column: -1, row: 0 }, { column: 0.5, row: 0 }, { column: 0, row: -1 }, { column: 0 }])(
    "rejects incomplete or invalid origin coordinates %s", (coordinates) => {
      const source = sourceWorkspace();
      source.panes = [];
      expect(resolveDetachedReturnTarget(detachedWorkspaceConfig(transferConfig(), { ...origin, ...coordinates })!, [source]))
        .toEqual({ kind: "workspace" });
    });
  it("prefers explicit placement over detached origin and inserts at the requested index", () => {
    const source = sourceWorkspace();
    source.panes[0].tabs.pop();
    const destination = sourceWorkspace();
    destination.id = "destination";
    destination.panes[0].tabs.pop();
    destination.panes[0].tabs.push({ id: "after", agentId: "shell", sessionId: "pty-after", type: "terminal" });
    useWorkspaceListStore.getState()._replaceWorkspaces([source, destination]);
    const saved = detachedWorkspaceConfig(transferConfig(), origin)!;
    const result = restoreWorkspaceConfigs([saved], { dockDetached: true, placementByWorkspaceId: {
      transfer: { kind: "pane", workspaceId: "destination", paneId: "pane", index: 0 },
    } });
    expect(result.restoredWorkspaceIds).toEqual(["destination"]);
    expect(useWorkspaceListStore.getState().getWorkspace("destination")!.panes[0].tabs.map((tab) => tab.id))
      .toEqual(["tab", "before", "after"]);
    expect(useWorkspaceListStore.getState().getWorkspace("source")!.panes[0].tabs.map((tab) => tab.id))
      .toEqual(["before"]);
    expect(useWorkspaceListStore.getState().getWorkspace("destination")!.panes[0].tabs[0].sessionId).toBe(carriedId);
  });

  it("falls back safely if the placement pane disappeared before adoption", () => {
    const source = sourceWorkspace();
    source.panes[0].tabs.pop();
    useWorkspaceListStore.getState()._replaceWorkspaces([source]);
    const saved = detachedWorkspaceConfig(transferConfig(), origin)!;
    expect(restoreWorkspaceConfigs([saved], { dockDetached: true, placementByWorkspaceId: {
      transfer: { kind: "pane", workspaceId: "missing", paneId: "missing", index: 0 },
    } }).restoredWorkspaceIds).toEqual(["source"]);
  });
  it("resolves the current origin and clamps an index after siblings have closed", () => {
    const cfg = detachedWorkspaceConfig(transferConfig(), origin)!;
    expect(resolveDetachedReturnTarget(cfg, [sourceWorkspace()])).toEqual({ kind: "workspace" });
    const source = sourceWorkspace();
    source.panes[0].tabs.pop();
    expect(resolveDetachedReturnTarget(cfg, [source])).toEqual({ kind: "pane", workspaceId: "source", paneId: "pane", index: 1 });
    expect(resolveDetachedReturnTarget({ ...cfg, detached_from: { ...origin, index: 99 } }, [source]))
      .toEqual({ kind: "pane", workspaceId: "source", paneId: "pane", index: 1 });
    expect(resolveDetachedReturnTarget({ ...cfg, detached_from: { ...origin, index: -1 } }, [source]))
      .toEqual({ kind: "pane", workspaceId: "source", paneId: "pane", index: 0 });
  });

  it.each(["workspace", "pane", "origin"])("falls back when the original %s is missing", (missing) => {
    const cfg = detachedWorkspaceConfig(transferConfig(), origin)!;
    const source = sourceWorkspace();
    source.panes[0].tabs.pop();
    if (missing === "pane") source.panes = [];
    if (missing === "origin") delete cfg.detached_from;
    expect(resolveDetachedReturnTarget(cfg, missing === "workspace" ? [] : [source])).toEqual({ kind: "workspace" });
  });

  it.each(["terminal", "browser", "web"] as const)("round-trips %s through a child and back without changing selection", async (type) => {
    const source = sourceWorkspace();
    Object.assign(source.panes[0].tabs[1], {
      type,
      ...(type === "browser" ? { htmlPath: "C:/preview.pdf", sourcePath: "C:/source.pdf", sourceKind: "pdf" } : {}),
      ...(type === "web" ? { presetId: "browser", webInitialUrl: "https://example.com/" } : {}),
    });
    source.panes[0].tabs.push({ id: "after", sessionId: "pty-after", agentId: "shell", type: "terminal" });
    const store = useWorkspaceListStore.getState();
    store._replaceWorkspaces([source]);
    store.setActiveWorkspace(source.id);
    const capturedOrigin = detachedOriginForDrag(source, { kind: "tab", paneId: "pane", tabId: "tab" })!;
    expect(useWorkspaceLayoutStore.getState().moveTabToNewWorkspace("source", "pane", "tab", "transfer", "Transfer", { activate: false })).toBe(true);
    let childConfig: ipc.WorkspaceConfig | undefined;
    const open = vi.spyOn(ipc, "openWorkspaceWindow").mockImplementation(async (options) => {
      childConfig = options.workspaces[0];
      return "child";
    });
    try { await tearOutWorkspaceToNewWindow("transfer", { detachedFrom: capturedOrigin }); }
    finally { open.mockRestore(); }
    const mainAfterDetach = structuredClone(useWorkspaceListStore.getState().workspaces);
    const activeTabAfterDetach = mainAfterDetach[0].panes[0].activeTabId;
    store._replaceWorkspaces([]);
    restoreWorkspaceConfigs([childConfig!]);
    const child = useWorkspaceListStore.getState().getWorkspace("transfer")!;
    expect(child.panes[0].tabs[0].sessionId).toBe(carriedId);
    expect(detachedWorkspaceForWindow([child], false)).toBe(child);
    expect(child.panes[0].tabs[0].type).toBe(type);
    const returning = toConfig(child, {}, "transfer");
    store._replaceWorkspaces(mainAfterDetach);
    const result = restoreWorkspaceConfigs([returning], { dockDetached: true });
    expect(result.restoredWorkspaceIds).toEqual(["source"]);
    const docked = useWorkspaceListStore.getState().getWorkspace("source")!;
    expect(docked.panes[0].tabs.map((tab) => tab.id)).toEqual(["before", "tab", "after"]);
    expect(docked.panes[0].tabs[1].sessionId).toBe(carriedId);
    expect(docked.panes[0].tabs[1].type).toBe(type);
    if (type === "browser") expect(docked.panes[0].tabs[1]).toMatchObject({
      htmlPath: "C:/preview.pdf", sourcePath: "C:/source.pdf", sourceKind: "pdf",
    });
    if (type === "web") expect(docked.panes[0].tabs[1]).toMatchObject({
      presetId: "browser",
    });
    // The existing serializer does not carry webInitialUrl; it is outside this change.
    expect(docked.panes[0].activeTabId).toBe(activeTabAfterDetach);
    expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe("source");
    expect(useWorkspaceListStore.getState().workspaces).toHaveLength(1);
    expect(toConfig(docked).detached).toBeUndefined();
  });

  it("restores an ordinary workspace with the same PTY if the source pane was closed", () => {
    const source = sourceWorkspace();
    source.panes = [];
    useWorkspaceListStore.getState()._replaceWorkspaces([source]);
    const saved = detachedWorkspaceConfig(transferConfig(), origin)!;
    expect(restoreWorkspaceConfigs([saved], { dockDetached: true }).restoredWorkspaceIds).toEqual(["transfer"]);
    const fallback = useWorkspaceListStore.getState().getWorkspace("transfer")!;
    expect(fallback.panes[0].tabs[0].sessionId).toBe(carriedId);
    expect(toConfig(fallback).detached).toBeUndefined();
    expect(toConfig(fallback).detached_from).toBeUndefined();
  });

  it("applies Stage A's occupied-PTY guard while inserting a returned tab", () => {
    const source = sourceWorkspace();
    const saved = detachedWorkspaceConfig(transferConfig(), origin)!;
    source.panes[0].tabs.pop();
    source.panes[0].tabs[0].sessionId = carriedId;
    source.panes[0].sessionId = carriedId;
    source.panes[0].activeTabId = "before";
    useWorkspaceListStore.getState()._replaceWorkspaces([source]);
    restoreWorkspaceConfigs([saved], { dockDetached: true });
    const tabs = useWorkspaceListStore.getState().getWorkspace("source")!.panes[0].tabs;
    expect(tabs[0].sessionId).toBe(carriedId);
    expect(tabs[1].sessionId).toBe("pty-source-pane-tab");
  });
});

describe("isTransferableTab", () => {
  it("allows browser transfers while rejecting online and ephemeral tabs", () => {
    expect(isTransferableTab({ type: "terminal" })).toBe(true);
    expect(isTransferableTab({ type: "launcher" })).toBe(true);
    expect(isTransferableTab({})).toBe(true);
    // Browser previews can transfer; online and ephemeral tabs cannot.
    expect(isTransferableTab({ type: "browser" })).toBe(true);
    expect(isTransferableTab({ type: "online" })).toBe(false);
    expect(isTransferableTab({ type: "terminal", ephemeral: true })).toBe(false);
  });

  it("agrees with the transfer serialization filter", () => {
    for (const type of ["terminal", "launcher", "browser", "online"] as const) {
      const workspace = {
        id: "w", name: "w", gridTemplateId: "1x1", status: "running" as const, createdAt: 0,
        panes: [{ id: "p", agentId: "shell", sessionId: "pty-w-p-t", activeTabId: "t",
          tabs: [{ id: "t", agentId: "shell", sessionId: "pty-w-p-t", label: "t", type }] }],
      } as unknown as Workspace;
      const survives = toConfig(workspace, {}, "transfer").panes.length === 1;
      expect(`${type}:${isTransferableTab({ type })}`).toBe(`${type}:${survives}`);
    }
  });
});

describe("isDetachableTab", () => {
  it.each([undefined, null, "terminal", "launcher", "browser", "web"])(
    "accepts supported type %s and rejects its ephemeral variant", (type) => {
      expect(isDetachableTab({ type })).toBe(true);
      expect(isDetachableTab({ type, ephemeral: true })).toBe(false);
    },
  );
  it.each(["online", "unknown"])("rejects unsupported type %s", (type) => {
    expect(isDetachableTab({ type })).toBe(false);
  });
});
