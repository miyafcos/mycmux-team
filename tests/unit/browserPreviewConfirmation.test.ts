import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const confirmation = vi.hoisted(() => ({ confirm: vi.fn() }));
vi.mock("../../src/lib/appConfirmation", () => confirmation);
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import type { PaneTab, Workspace } from "../../src/types";
const initial = useWorkspaceListStore.getState();
let answer: (accepted: boolean) => void;
const edited: PaneTab = { id: "edited", sessionId: "browser-session", agentId: "shell", type: "browser", sourcePath: "/report.html", previewPath: "/report.html", sourceKind: "html", sourceMtimeMs: 1, isDirty: true, reloadCounter: 0 };
function tree(): Workspace {
  return { id: "workspace", name: "workspace", gridTemplateId: "single", status: "running", createdAt: 1,
    panes: [{ id: "source", agentId: "shell", sessionId: "pty", activeTabId: "terminal", tabs: [{ id: "terminal", sessionId: "pty", agentId: "shell", type: "terminal" }] },
    { id: "preview", agentId: "shell", sessionId: edited.sessionId, activeTabId: edited.id, tabs: [edited] }], splitColumns: [["source"], ["preview"]] };
}
const open = (mtime = 2) => useWorkspaceLayoutStore.getState().openOrReloadHtmlPreviewPane("workspace", "source", { sourcePath: "/report.html", previewPath: "/report.html", sourceKind: "html", sourceMtimeMs: mtime });
async function decide(accepted: boolean) { answer(accepted); for (let i = 0; i < 8; i++) await Promise.resolve(); }
beforeEach(() => {
  confirmation.confirm.mockReset().mockImplementation(() => new Promise<boolean>((resolve) => { answer = resolve; }));
  useWorkspaceListStore.setState({ workspaces: [tree()], activeWorkspaceId: "workspace" });
});
afterEach(() => useWorkspaceListStore.setState(initial, true));
describe("OSC preview confirmation on the actual layout tree", () => {
  it("stays unchanged until a decision and coalesces repeated output to the latest file version", async () => {
    open(2); open(3);
    expect(confirmation.confirm).toHaveBeenCalledOnce();
    expect(useWorkspaceListStore.getState().getWorkspace("workspace")?.panes[1].tabs[0]).toBe(edited);
    const other = { ...tree(), name: "Renamed while waiting" };
    useWorkspaceListStore.setState({ workspaces: [other] });
    await decide(true);
    const current = useWorkspaceListStore.getState().getWorkspace("workspace")!;
    expect(current.name).toBe("Renamed while waiting");
    expect(current.panes[1].tabs[0]).toMatchObject({ sourceMtimeMs: 3, isDirty: false, reloadCounter: 1 });
  });
  it("declining keeps edits and permits a later request", async () => {
    open(); await decide(false);
    expect(useWorkspaceListStore.getState().getWorkspace("workspace")?.panes[1].tabs[0]).toBe(edited);
    open(); expect(confirmation.confirm).toHaveBeenCalledTimes(2); await decide(false);
  });
  it.each(["closed", "changed", "moved"])("does not overwrite a %s target after awaiting", async (change) => {
    open();
    const next = tree();
    if (change === "changed") next.panes[1].tabs = [{ ...edited, sourceMtimeMs: 9 }];
    else next.panes = next.panes.slice(0, 1);
    const workspaces = change === "moved" ? [next, { ...tree(), id: "other" }] : [next];
    useWorkspaceListStore.setState({ workspaces });
    await decide(true);
    expect(useWorkspaceListStore.getState().workspaces).toEqual(workspaces);
  });
});
