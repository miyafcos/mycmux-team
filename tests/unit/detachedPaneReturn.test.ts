import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ destroy: vi.fn(async () => {}), isMain: vi.fn(() => false) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "child", destroy: mocks.destroy }) }));
vi.mock("../../src/lib/windowContext", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/lib/windowContext")>(),
  isMainWindow: mocks.isMain, windowLabel: () => "child",
}));
vi.mock("../../src/components/terminal/XTermWrapper", () => ({
  hasTerminalBuffer: () => false, getTerminalWriteCounter: () => 0, getTerminalBufferLines: () => [],
}));
import * as ipc from "../../src/lib/ipc";
import { transferWindowWorkspacesAndClose, __resetWindowCloseStateForTests } from "../../src/components/layout/SocketListener";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import type { DetachedWorkspace } from "../../src/lib/detachedPane";

beforeEach(() => {
  __resetWindowCloseStateForTests();
  vi.spyOn(ipc, "setWindowCloseIntent").mockResolvedValue();
  mocks.isMain.mockReturnValue(false);
  const tab = { id: "tab", sessionId: "pty-original", agentId: "shell", type: "terminal" as const };
  const workspace: DetachedWorkspace = { id: "transfer", name: "Transfer", gridTemplateId: "1x1", status: "running", createdAt: 1,
    detached: true, detached_from: { workspace_id: "source", pane_id: "source-pane", tab_id: "tab", index: 1 },
    panes: [{ id: "pane", agentId: "shell", sessionId: tab.sessionId, activeTabId: tab.id, tabs: [tab] }] };
  useWorkspaceListStore.getState()._replaceWorkspaces([workspace]);
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); useWorkspaceListStore.getState()._replaceWorkspaces([]); });

describe("drag-only handoff", () => {
  it("publishes browser metadata on the final return handoff", async () => {
    const ws = useWorkspaceListStore.getState().workspaces[0];
    ws.panes[0].tabs[0] = { ...ws.panes[0].tabs[0], type: "browser", htmlPath: "C:/preview.html", sourceKind: "pdf" };
    const publish = vi.spyOn(ipc, "publishWindowFragment").mockResolvedValue();
    vi.spyOn(ipc, "releaseWorkspaces").mockResolvedValue(1);
    await transferWindowWorkspacesAndClose("mycmux-w2");
    expect(publish.mock.calls[0][0].workspaces[0].panes[0].tabs![0]).toMatchObject({
      type: "browser", html_path: "C:/preview.html", source_kind: "pdf",
    });
  });

  it("publishes the origin and PTY, then releases to the receiving peer, then destroys the child", async () => {
    const events: string[] = [];
    const publish = vi.spyOn(ipc, "publishWindowFragment").mockImplementation(async () => { events.push("publish"); });
    const release = vi.spyOn(ipc, "releaseWorkspaces").mockImplementation(async () => { events.push("release"); return 1; });
    mocks.destroy.mockImplementation(async () => { events.push("destroy"); });
    await transferWindowWorkspacesAndClose("mycmux-w2");
    expect(events).toEqual(["publish", "release", "destroy"]);
    expect(publish.mock.calls[0][0].workspaces[0]).toMatchObject({ detached_from: { workspace_id: "source", pane_id: "source-pane", tab_id: "tab", index: 1 } });
    expect(publish.mock.calls[0][0].workspaces[0].panes[0].tabs![0].session_id).toBe("pty-original");
    expect(release).toHaveBeenCalledWith("child", ["transfer"], "mycmux-w2");
  });

  it.each(["publish", "release"])("keeps the child alive when %s fails", async (failed) => {
    const publish = vi.spyOn(ipc, "publishWindowFragment").mockResolvedValue();
    const release = vi.spyOn(ipc, "releaseWorkspaces").mockResolvedValue(1);
    if (failed === "publish") publish.mockRejectedValue(new Error("handoff failed"));
    else release.mockRejectedValue(new Error("handoff failed"));
    await expect(transferWindowWorkspacesAndClose("mycmux-w2")).rejects.toThrow("handoff failed");
    expect(mocks.destroy).not.toHaveBeenCalled();
    if (failed === "publish") expect(release).not.toHaveBeenCalled();
    expect(useWorkspaceListStore.getState().workspaces).toHaveLength(1);
  });

  it("cannot destroy its own receiving window", async () => {
    const publish = vi.spyOn(ipc, "publishWindowFragment").mockResolvedValue();
    await transferWindowWorkspacesAndClose("child");
    expect(publish).not.toHaveBeenCalled();
    expect(mocks.destroy).not.toHaveBeenCalled();
  });
});
