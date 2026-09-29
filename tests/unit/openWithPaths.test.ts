import { describe, expect, it, vi } from "vitest";
import { openPathsInMainWindow, selectOpenTarget, type OpenPathsDependencies } from "../../src/lib/openWithPaths";

const pane = (id: string, sessionId: string) => ({
  id, sessionId, activeTabId: `${id}-tab`, tabs: [{ id: `${id}-tab`, sessionId }],
});

function harness(main = true) {
  const selection = {
    workspaces: [
      { id: "old", panes: [pane("old-pane", "old-session")] },
      { id: "visible", panes: [pane("first", "first-session"), pane("active", "active-session")] },
    ],
    activeWorkspaceId: "visible",
  };
  const info = { previewPath: "preview.html", sourcePath: "note.md", sourceKind: "markdown" as const };
  const deps: OpenPathsDependencies = {
    main: () => main,
    selection: () => selection,
    activeSessionId: () => "active-session",
    createWorkspace: vi.fn(),
    preview: vi.fn(async () => info),
    openPreview: vi.fn(),
    showWorkspace: vi.fn(),
    reportError: vi.fn(),
  };
  return { deps, selection, info };
}

describe("open with routing", () => {
  it("chooses the visible workspace and its active pane", () => {
    const { selection } = harness();
    expect(selectOpenTarget(selection, "active-session")).toEqual({
      workspaceId: "visible", paneId: "active", sessionId: "active-session",
    });
    expect(selectOpenTarget(selection, null)?.paneId).toBe("first");
  });

  it("uses the existing preview and reload operation, then leaves the dashboard", async () => {
    const { deps, info } = harness();
    await openPathsInMainWindow(["C:\\work\\note.md", "C:\\work\\note.md"], deps);
    expect(deps.preview).toHaveBeenCalledTimes(2);
    expect(deps.preview).toHaveBeenCalledWith("active-session", "C:\\work\\note.md");
    expect(deps.openPreview).toHaveBeenNthCalledWith(1, "visible", "active", info);
    expect(deps.openPreview).toHaveBeenCalledTimes(2);
    expect(deps.showWorkspace).toHaveBeenCalledTimes(2);
  });

  it("ignores a detached window", async () => {
    const { deps } = harness(false);
    await openPathsInMainWindow(["C:\\work\\note.md"], deps);
    expect(deps.preview).not.toHaveBeenCalled();
  });

  it("creates a workspace for the first file and reports preview failures", async () => {
    const { deps, selection } = harness();
    selection.workspaces = [];
    deps.createWorkspace = vi.fn(() => {
      selection.workspaces.push({ id: "new", panes: [pane("new-pane", "new-session")] });
      selection.activeWorkspaceId = "new";
    });
    deps.preview = vi.fn(async () => { throw new Error("too large"); });
    await openPathsInMainWindow(["C:\\work\\note.md"], deps);
    expect(deps.createWorkspace).toHaveBeenCalledOnce();
    expect(deps.reportError).toHaveBeenCalledWith(expect.stringContaining("too large"));
    expect(deps.showWorkspace).not.toHaveBeenCalled();
  });
});
