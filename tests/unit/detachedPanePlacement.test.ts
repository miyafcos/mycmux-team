import { beforeEach, describe, expect, it } from "vitest";
import { restoreWorkspaceConfigs } from "../../src/lib/workspaceRestore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useUiStore } from "../../src/stores/uiStore";
import type { WorkspaceConfig } from "../../src/lib/ipc";
import type { DetachedReturnTarget } from "../../src/lib/detachedPane";
import type { Pane, Workspace } from "../../src/types";

function pane(id: string): Pane {
  const tab = { id: id + "-tab", agentId: "shell-starter", type: "terminal" as const, sessionId: "pty-" + id };
  return { id, agentId: tab.agentId, sessionId: tab.sessionId, tabs: [tab], activeTabId: tab.id };
}
function incoming(): WorkspaceConfig {
  return { id: "transfer", name: "Transfer", grid_template_id: "1x1", created_at: 1, split_columns: [[0]],
    panes: [{ pane_id: "incoming", agent_id: "shell-starter", label: null, active_tab_id: "pdf",
      tabs: [{ tab_id: "terminal", session_id: "pty-carried", agent_id: "shell-starter", type: "terminal" },
        { tab_id: "pdf", session_id: "pty-pdf", agent_id: "shell-starter", type: "browser", source_kind: "pdf", html_path: "C:/preview.html" }] }] };
}
beforeEach(() => {
  const ws: Workspace = { id: "destination", name: "Destination", gridTemplateId: "1x1", status: "running", createdAt: 1,
    panes: [pane("target"), pane("below"), pane("neighbor")], splitColumns: [["target", "below"], ["neighbor"]] };
  useWorkspaceListStore.setState({ workspaces: [ws], activeWorkspaceId: ws.id });
});

describe("detached pane placement adoption", () => {
  it.each([
    ["index", [["target", "below"], ["neighbor"]]],
    ["center", [["target", "below"], ["neighbor"]]],
    ["left", [["incoming"], ["target", "below"], ["neighbor"]]],
    ["right", [["target", "below"], ["incoming"], ["neighbor"]]],
    ["up", [["incoming", "target", "below"], ["neighbor"]]],
    ["down", [["target", "incoming", "below"], ["neighbor"]]],
  ] as const)("adopts terminal and PDF at %s with selection changed for header and center drops", (zone, columns) => {
    const placement: DetachedReturnTarget = zone === "index"
      ? { kind: "pane", workspaceId: "destination", paneId: "target", index: 0 }
      : { kind: "pane-zone", workspaceId: "destination", paneId: "target", zone };
    expect(restoreWorkspaceConfigs([incoming()], { dockDetached: true, placementByWorkspaceId: { transfer: placement } }).restoredWorkspaceIds)
      .toEqual(["destination"]);
    const store = useWorkspaceListStore.getState();
    const ws = store.getWorkspace("destination")!;
    expect(store.workspaces).toHaveLength(1); expect(store.activeWorkspaceId).toBe("destination");
    expect(ws.splitColumns).toEqual(columns);
    const target = ws.panes.find((pane) => pane.id === "target")!;
    const merged = zone === "index" || zone === "center";
    expect(target.activeTabId).toBe(merged ? "pdf" : "target-tab"); expect(target.sessionId).toBe(merged ? "pty-pdf" : "pty-target");
    const receiving = ws.panes.find((pane) => pane.tabs.some((tab) => tab.id === "pdf"))!;
    expect(receiving.tabs.find((tab) => tab.id === "terminal")!.sessionId).toBe("pty-carried");
    expect(receiving.tabs.find((tab) => tab.id === "pdf")).toMatchObject({ type: "browser", sourceKind: "pdf", htmlPath: "C:/preview.html" });
    if (zone === "index") expect(receiving.tabs.map((tab) => tab.id)).toEqual(["target-tab", "terminal", "pdf"]);
    else if (zone === "center") expect(receiving.tabs.map((tab) => tab.id)).toEqual(["target-tab", "terminal", "pdf"]);
    else { expect(receiving.tabs.map((tab) => tab.id)).toEqual(["terminal", "pdf"]); expect(receiving.activeTabId).toBe("pdf"); }
  });

  it.each([["center", false], ["center", true], ["header", false], ["header", true]] as const)(
    "selects a %s return without switching the working workspace, pinned=%s", (zone, pinned) => {
    const destination = useWorkspaceListStore.getState().workspaces[0];
    if (pinned) destination.panes[0].pinnedTabId = "target-tab";
    useWorkspaceListStore.setState({ workspaces: [destination, { ...destination, id: "working", panes: [pane("working")] }], activeWorkspaceId: "working" });
    useUiStore.setState({ activePaneId: "pty-working" });
    const result = restoreWorkspaceConfigs([incoming()], { dockDetached: true, activeWorkspaceId: "transfer", placementByWorkspaceId: {
      transfer: zone === "header"
        ? { kind: "pane", workspaceId: "destination", paneId: "target", index: 0 }
        : { kind: "pane-zone", workspaceId: "destination", paneId: "target", zone: "center" },
    } });
    const store = useWorkspaceListStore.getState();
    const target = store.getWorkspace("destination")!.panes[0];
    expect(target.activeTabId).toBe("pdf"); expect(target.sessionId).toBe("pty-pdf");
    expect(target.pinnedTabId).toBe(pinned ? "target-tab" : undefined);
    expect(target.tabs.map(tab => tab.id)).toEqual(["target-tab", "terminal", "pdf"]);
    expect(result.activePaneSessionId).toBe("pty-pdf");
    expect(store.activeWorkspaceId).toBe("working"); expect(useUiStore.getState().activePaneId).toBe("pty-working");
  });

  it("allocates a fresh pane ID if the returning pane ID already exists", () => {
    const cfg = incoming(); cfg.panes[0].pane_id = "target";
    restoreWorkspaceConfigs([cfg], { placementByWorkspaceId: {
      transfer: { kind: "pane-zone", workspaceId: "destination", paneId: "target", zone: "right" },
    } });
    const ws = useWorkspaceListStore.getState().getWorkspace("destination")!;
    const returned = ws.panes.find((pane) => pane.tabs.some((tab) => tab.id === "pdf"))!;
    expect(returned.id).not.toBe("target");
    expect(ws.splitColumns).toEqual([["target", "below"], [returned.id], ["neighbor"]]);
    expect(new Set(ws.panes.map((pane) => pane.id)).size).toBe(4);
  });

  it("falls back to a workspace if the hovered pane disappears before adoption", () => {
    restoreWorkspaceConfigs([incoming()], { dockDetached: true, placementByWorkspaceId: {
      transfer: { kind: "pane-zone", workspaceId: "destination", paneId: "removed", zone: "down" },
    } });
    const store = useWorkspaceListStore.getState();
    expect(store.getWorkspace("destination")!.panes).toHaveLength(3);
    expect(store.getWorkspace("transfer")!.panes[0].tabs).toHaveLength(2);
  });
});
