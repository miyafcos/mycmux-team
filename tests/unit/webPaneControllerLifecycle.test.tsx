// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PaneTab, Workspace } from "../../src/types";
import { usePaneDragStore } from "../../src/stores/paneDragStore";
import { useKeybindingStore } from "../../src/stores/keybindingStore";
import { useSavepointDragStore } from "../../src/stores/savepointDragStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";

const apiMocks = vi.hoisted(() => ({
  createWebPane: vi.fn(),
  destroyWebPane: vi.fn(),
  updateWebPane: vi.fn(),
}));
const eventMocks = vi.hoisted(() => ({
  listen: vi.fn(),
  unlisten: vi.fn(),
}));

vi.mock("../../src/components/workspace/webPaneApi", () => apiMocks);
vi.mock("@tauri-apps/api/event", () => ({ listen: eventMocks.listen }));

import WebPaneController from "../../src/components/workspace/WebPaneController";

let container: HTMLDivElement;
let root: Root;

function workspaceWithWebTab(): Workspace {
  const terminal: PaneTab = {
    id: "terminal-tab",
    sessionId: "terminal-session",
    agentId: "shell-starter",
    type: "terminal",
  };
  const web: PaneTab = {
    id: "web-tab",
    sessionId: "web-session",
    agentId: "web",
    type: "web",
    presetId: "chatgpt",
  };
  return {
    id: "workspace",
    name: "Workspace",
    gridTemplateId: "1x1",
    status: "running",
    createdAt: 1,
    panes: [{
      id: "pane",
      agentId: web.agentId,
      sessionId: web.sessionId,
      tabs: [terminal, web],
      activeTabId: web.id,
    }],
    splitColumns: [["pane"]],
  };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
  eventMocks.listen.mockResolvedValue(eventMocks.unlisten);
  apiMocks.createWebPane.mockResolvedValue("web-pane-web-tab");
  apiMocks.destroyWebPane.mockResolvedValue(undefined);
  apiMocks.updateWebPane.mockResolvedValue(undefined);
  usePaneDragStore.setState({ item: null });
  useKeybindingStore.getState().resetAll();
  useSavepointDragStore.setState({ item: null });
  const workspace = workspaceWithWebTab();
  useWorkspaceListStore.setState({ workspaces: [workspace], activeWorkspaceId: workspace.id });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("WebPaneController lifecycle", () => {
  it("destroys the native webview when its web tab leaves the workspace state", async () => {
    await act(async () => {
      root.render(<WebPaneController />);
      await Promise.resolve();
    });

    const current = useWorkspaceListStore.getState().workspaces[0];
    const terminal = current.panes[0].tabs[0];
    const next: Workspace = {
      ...current,
      panes: [{
        ...current.panes[0],
        agentId: terminal.agentId,
        sessionId: terminal.sessionId,
        tabs: [terminal],
        activeTabId: terminal.id,
      }],
    };
    await act(async () => {
      useWorkspaceListStore.setState({ workspaces: [next] });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiMocks.destroyWebPane).toHaveBeenCalledTimes(1);
    expect(apiMocks.destroyWebPane).toHaveBeenCalledWith("web-tab");
  });
});
