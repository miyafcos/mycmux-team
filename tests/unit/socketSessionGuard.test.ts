import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSocketCommand } from "../../src/components/layout/socketCommands";
import { createSession, killSession } from "../../src/lib/ipc";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useUiStore } from "../../src/stores/uiStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { popClosedPane } from "../../src/stores/closedPaneStore";
import type { PaneTab, Workspace } from "../../src/types";

vi.mock("../../src/lib/ipc", async (original) => ({
  ...await original<typeof import("../../src/lib/ipc")>(),
  createSession: vi.fn(async () => {}),
  killSession: vi.fn(async () => {}),
  ackFrontendData: vi.fn(async () => {}),
}));

function workspace(tabs: PaneTab[]): Workspace {
  return {
    id: "workspace", name: "Test", gridTemplateId: "1x1", status: "running", createdAt: 1,
    panes: [{ id: "pane", agentId: tabs[0].agentId, sessionId: tabs[0].sessionId,
      tabs, activeTabId: tabs[0].id }],
    splitColumns: [["pane"]],
  };
}
const tab = (id: string): PaneTab => ({
  id, sessionId: id, type: "terminal", agentId: "shell",
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createSession).mockResolvedValue(undefined);
  vi.mocked(killSession).mockResolvedValue(undefined);
  useUiStore.setState({ activePaneId: null });
  usePaneMetadataStore.setState({ metadata: {} });
  while (popClosedPane()) { /* Isolate undo history. */ }
});
afterEach(() => {
  vi.restoreAllMocks();
  while (popClosedPane()) { /* Isolate undo history. */ }
});

describe("socket session lifecycle", () => {
  it.each(["pane.spawn", "pane.spawn_tab"])("%s kills before removing a failed spawn, even if kill rejects", async (command) => {
    const original = tab("original");
    if (command === "pane.spawn") original.type = "launcher";
    useWorkspaceListStore.setState({ workspaces: [workspace([original])], activeWorkspaceId: "workspace" });
    vi.mocked(createSession).mockRejectedValueOnce(new Error("launch failed"));
    let finishKill!: () => void;
    vi.mocked(killSession).mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
      finishKill = () => reject(new Error("cleanup failed"));
    }));
    const args = command === "pane.spawn"
      ? { workspaceId: "workspace", target: "shell" }
      : { anchorSessionId: "original", commandArgv: ["cmd.exe"] };
    const failed = expect(handleSocketCommand(command, args)).rejects.toThrow("launch failed");
    await vi.waitFor(() => expect(killSession).toHaveBeenCalledOnce(), { timeout: 10_000 });
    const newSessionId = vi.mocked(createSession).mock.calls[0][0];
    expect(killSession).toHaveBeenCalledWith(newSessionId);
    expect(useWorkspaceListStore.getState().workspaces[0].panes[0].tabs.some(
      (candidate) => candidate.sessionId === newSessionId,
    )).toBe(true);
    finishKill();
    await failed;
    expect(useWorkspaceListStore.getState().workspaces[0].panes[0].tabs).toEqual([original]);
  });

  it("does not lose a tab queued during the close_tabs snapshot", async () => {
    useWorkspaceListStore.setState({
      workspaces: [workspace([tab("close"), tab("keep")])], activeWorkspaceId: "workspace",
    });
    const before = useWorkspaceListStore.getState();
    vi.spyOn(useWorkspaceListStore, "getState").mockImplementationOnce(() => {
      queueMicrotask(() => {
        useWorkspaceListStore.setState((state) => ({
          workspaces: state.workspaces.map((ws) => ({
            ...ws, panes: ws.panes.map((pane) => ({ ...pane, tabs: [...pane.tabs, tab("concurrent")] })),
          })),
        }));
      });
      return before;
    });
    await handleSocketCommand("pane.close_tabs", { tabIds: ["close"] });
    expect(useWorkspaceListStore.getState().workspaces[0].panes[0].tabs.map((item) => item.id))
      .toEqual(["keep", "concurrent"]);
    expect(killSession).toHaveBeenCalledExactlyOnceWith("close");
  });
});
