import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../src/components/terminal/XTermWrapper", () => ({
  hasTerminalBuffer: () => false, getTerminalWriteCounter: () => 0, getTerminalBufferLines: () => [],
}));
import { toConfig } from "../../src/components/layout/SocketListener";
import { serializePaneForSocket, handleSocketCommand } from "../../src/components/layout/socketCommands";
import { restoreWorkspaceConfigs } from "../../src/lib/workspaceRestore";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { pushClosedTab, popClosedPane } from "../../src/stores/closedPaneStore";
import type { Workspace } from "../../src/types";

function workspace(): Workspace {
  const tab = { id: "t", sessionId: "s", agentId: "shell-starter", type: "terminal" as const,
    label: "toolx-worker-1", labelSource: "ai" as const, displayName: "toolx 検査", displayNameSource: "auto" as const };
  return { id: "w", name: "今日", status: "running", createdAt: 1, gridTemplateId: "1x1",
    panes: [{ id: "p", agentId: tab.agentId, sessionId: tab.sessionId, activeTabId: tab.id, tabs: [tab] }], splitColumns: [["p"]] };
}
beforeEach(() => { useWorkspaceListStore.getState()._replaceWorkspaces([]); while (popClosedPane()) { /* drain fixture history */ } });
describe("persistent display names and control labels", () => {
  it.each([true, false])("round trips named=%s through data.json projection and restore", named => {
    const ws = workspace();
    if (!named) { ws.panes[0].tabs[0].displayName = undefined; ws.panes[0].tabs[0].displayNameSource = undefined; }
    const config = JSON.parse(JSON.stringify(toConfig(ws)));
    if (!named) { delete config.panes[0].tabs[0].display_name; delete config.panes[0].tabs[0].display_name_source; }
    restoreWorkspaceConfigs([config]);
    const restored = useWorkspaceListStore.getState().workspaces[0].panes[0].tabs[0];
    expect(restored.label).toBe("toolx-worker-1");
    expect(restored.displayName).toBe(named ? "toolx 検査" : undefined);
    expect(restored.displayNameSource).toBe(named ? "auto" : undefined);
  });
  it("carries closed names into the same add-pane options used by reopen", () => {
    const ws = workspace();
    useWorkspaceListStore.getState()._replaceWorkspaces([ws]);
    pushClosedTab(ws.panes[0], ws.panes[0].tabs[0]);
    const closed = popClosedPane()!;
    expect(closed).toMatchObject({ label: "toolx-worker-1", displayName: "toolx 検査", displayNameSource: "auto" });
    useWorkspaceLayoutStore.getState().addPaneToWorkspaceWithOptions(ws.id, ws.panes[0].id, "right", {
      agentId: "shell-starter", label: closed.label ?? undefined, labelSource: closed.labelSource,
      displayName: closed.displayName, displayNameSource: closed.displayNameSource,
    });
    expect(useWorkspaceListStore.getState().workspaces[0].panes[1].tabs[0]).toMatchObject({
      label: "toolx-worker-1", labelSource: "ai", displayName: "toolx 検査", displayNameSource: "auto",
    });
  });
  it("exposes display_name read-only alongside the original label through list_all", async () => {
    const ws = workspace(); useWorkspaceListStore.getState()._replaceWorkspaces([ws]);
    const context = { activeSessionId: null, metadata: {}, processMetadata: {}, processMetadataAvailable: false,
      lastOutputBySession: {}, isTerminalMounted: () => false };
    expect(serializePaneForSocket(ws.panes[0], context).tabs[0]).toMatchObject({ label: "toolx-worker-1", display_name: "toolx 検査" });
    const result = await handleSocketCommand("pane.list_all", {}) as { panes: Array<{ tabs: Array<{ label: string; display_name: string }> }> };
    expect(result.panes[0].tabs[0]).toMatchObject({ label: "toolx-worker-1", display_name: "toolx 検査" });
  });
});
