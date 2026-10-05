import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emitTo: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));
vi.mock("../../src/lib/focusController", async importActual => {
  const actual = await importActual<typeof import("../../src/lib/focusController")>();
  return { ...actual, focusController: { ...actual.focusController, request: vi.fn() } };
});
import { selectOverviewTarget } from "../../src/lib/workOverviewNavigation";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { focusController } from "../../src/lib/focusController";
describe("existing overview session navigation", () => {
  it("selects the existing tab/session and rejects stale identities without restarting it", () => {
    const tab = { id: "t", sessionId: "s", agentId: "shell-starter" };
    useWorkspaceListStore.setState({ activeWorkspaceId: "w", workspaces: [{
      id: "w", name: "作業", createdAt: 1, status: "running", gridTemplateId: "1x1",
      panes: [{ id: "p", agentId: "shell-starter", sessionId: "s", activeTabId: "t", tabs: [tab] }], splitColumns: [["p"]],
    }] });
    expect(selectOverviewTarget({ workspaceId: "w", paneId: "p", tab })).toBe(true);
    expect(useWorkspaceListStore.getState().workspaces[0].panes[0].tabs[0].sessionId).toBe("s");
    expect(focusController.request).toHaveBeenCalledWith("programmatic", { sessionId: "s", focus: true });
    expect(selectOverviewTarget({ workspaceId: "w", paneId: "p", tab: { ...tab, sessionId: "old" } })).toBe(false);
  });
});
