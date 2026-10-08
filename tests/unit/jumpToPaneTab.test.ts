import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaneTab } from "../../src/types";

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  zoom: null as string | null,
  setActiveWorkspace: vi.fn(),
  setActivePaneTab: vi.fn(),
  setZoomedPaneId: vi.fn(),
  request: vi.fn(),
}));
vi.mock("../../src/stores/workspaceListStore", () => ({ useWorkspaceListStore: { getState: () => ({ setActiveWorkspace: mocks.setActiveWorkspace }) } }));
vi.mock("../../src/stores/workspaceLayoutStore", () => ({ useWorkspaceLayoutStore: { getState: () => ({ setActivePaneTab: mocks.setActivePaneTab }) } }));
vi.mock("../../src/stores/uiStore", () => ({ useUiStore: { getState: () => ({ zoomedPaneId: mocks.zoom, setZoomedPaneId: mocks.setZoomedPaneId }) } }));
vi.mock("../../src/lib/focusController", () => ({ focusController: { request: mocks.request } }));
import { jumpToPaneTab } from "../../src/lib/jumpToPaneTab";

beforeEach(() => {
  vi.clearAllMocks(); mocks.zoom = null; mocks.order = [];
  mocks.setActiveWorkspace.mockImplementation(() => mocks.order.push("workspace"));
  mocks.setActivePaneTab.mockImplementation(() => mocks.order.push("tab"));
  mocks.setZoomedPaneId.mockImplementation(() => mocks.order.push("zoom"));
  mocks.request.mockImplementation(() => mocks.order.push("focus"));
});

describe("shared pane tab navigation", () => {
  it.each([undefined, "terminal"] as const)("preserves the terminal focus intent for %s", type => {
    jumpToPaneTab({ workspaceId: "sample-workspace", paneId: "sample-pane", tab: { id: "sample-tab", sessionId: "sample-session", type } });
    expect(mocks.setActiveWorkspace).toHaveBeenCalledWith("sample-workspace");
    expect(mocks.setActivePaneTab).toHaveBeenCalledWith("sample-workspace", "sample-pane", "sample-tab");
    expect(mocks.request).toHaveBeenCalledWith("programmatic", { sessionId: "sample-session", focus: true });
    expect(mocks.order).toEqual(["workspace", "tab", "focus"]);
    expect(mocks.setZoomedPaneId).not.toHaveBeenCalled();
  });
  it.each(["browser", "online", "web", "launcher"] as PaneTab["type"][])("clears terminal focus for %s", type => {
    jumpToPaneTab({ workspaceId: "sample-workspace", paneId: "sample-pane", tab: { id: "sample-tab", sessionId: "sample-session", type } });
    expect(mocks.request).toHaveBeenCalledWith("programmatic", { sessionId: null, focus: false });
  });
  it("carries an existing zoom to the destination before requesting focus", () => {
    mocks.zoom = "sample-old-pane";
    jumpToPaneTab({ workspaceId: "sample-workspace", paneId: "sample-pane", tab: { id: "sample-tab", sessionId: "sample-session" } });
    expect(mocks.setZoomedPaneId).toHaveBeenCalledWith("sample-pane");
    expect(mocks.order).toEqual(["workspace", "tab", "zoom", "focus"]);
  });
});
