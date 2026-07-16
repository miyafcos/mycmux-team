import { beforeEach, describe, expect, it } from "vitest";
import { usePaneDragStore } from "../../src/stores/paneDragStore";
import { useSavepointDragStore } from "../../src/stores/savepointDragStore";

const item = {
  kind: "savepoint" as const,
  sourceWorkspaceId: "source-workspace",
  bundleDir: "C:/shared/savepoint",
  label: "Review the handoff",
  sourceSessionId: "source-session",
  sourceAgentKind: "claude" as const,
  checkpointId: "checkpoint-1",
};
const owner = Symbol("owner");

describe("savepointDragStore", () => {
  beforeEach(() => {
    useSavepointDragStore.getState().clearDrag();
    usePaneDragStore.getState().clearDrag();
  });

  it("keeps the payload alive while the source card rerenders", () => {
    useSavepointDragStore.getState().beginDrag(item, { x: 10, y: 20 }, owner);
    useSavepointDragStore.getState().moveDrag({ x: 30, y: 40 });
    useSavepointDragStore.getState().setTarget({
      mode: "paste",
      workspaceId: "workspace-1",
      paneId: "pane-1",
      tabId: "tab-1",
      sessionId: "session-1",
      targetKind: "claude",
    });

    expect(useSavepointDragStore.getState()).toMatchObject({
      item,
      pointer: { x: 30, y: 40 },
      target: {
        mode: "paste",
        workspaceId: "workspace-1",
        paneId: "pane-1",
        tabId: "tab-1",
        sessionId: "session-1",
        targetKind: "claude",
      },
    });
  });

  it("stores a split-and-handoff edge target without pretending it is an agent tab", () => {
    useSavepointDragStore.getState().beginDrag(item, { x: 10, y: 20 }, owner);
    useSavepointDragStore.getState().setTarget({
      mode: "spawn",
      workspaceId: "workspace-1",
      paneId: "pane-1",
      direction: "left",
    });

    expect(useSavepointDragStore.getState().target).toEqual({
      mode: "spawn",
      workspaceId: "workspace-1",
      paneId: "pane-1",
      direction: "left",
    });
  });

  it("stores the temporary file-export target without pane coordinates", () => {
    useSavepointDragStore.getState().beginDrag(item, { x: 10, y: 20 }, owner);
    useSavepointDragStore.getState().setTarget({ mode: "export" });

    expect(useSavepointDragStore.getState().target).toEqual({ mode: "export" });
  });

  it("clears only the savepoint drag and never mutates pane movement state", () => {
    usePaneDragStore.getState().beginDrag({
      kind: "tab",
      workspaceId: "workspace-1",
      paneId: "pane-1",
      tabId: "tab-1",
      label: "Existing tab",
    }, { x: 1, y: 2 });
    useSavepointDragStore.getState().beginDrag(item, { x: 3, y: 4 }, owner);
    useSavepointDragStore.getState().clearDrag();

    expect(useSavepointDragStore.getState().item).toBeNull();
    expect(usePaneDragStore.getState().item?.kind).toBe("tab");
  });

  it("does not let another source replace or clear the active drag", () => {
    const otherOwner = Symbol("other-owner");
    expect(useSavepointDragStore.getState().beginDrag(item, { x: 1, y: 2 }, owner)).toBe(true);

    expect(useSavepointDragStore.getState().beginDrag(
      { ...item, sourceSessionId: "other-session" },
      { x: 3, y: 4 },
      otherOwner,
    )).toBe(false);
    useSavepointDragStore.getState().clearDrag(otherOwner);

    expect(useSavepointDragStore.getState()).toMatchObject({ item, owner });
    useSavepointDragStore.getState().clearDrag(owner);
    expect(useSavepointDragStore.getState().item).toBeNull();
  });
});
