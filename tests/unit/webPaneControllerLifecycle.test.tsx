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
  WEB_PANE_SIGNIN_EVENT: "mycmux:web-pane-signin",
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

  it("holds the pane closed while a sign-in window owns the profile, then reopens it", async () => {
    // Rust closes these webviews itself so the sign-in browser can take the
    // profile folder. If the controller still believed the webview existed the
    // pane would stay blank for good; if it rebuilt one straight away the two
    // browsers would fight over the folder.
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    const host = document.createElement("div");
    host.dataset.webPaneHostTabId = "web-tab";
    host.getBoundingClientRect = () => ({
      x: 0, y: 0, width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600,
      toJSON: () => ({}),
    }) as DOMRect;
    document.body.appendChild(host);

    const runFrame = async () => {
      const next = frames.shift();
      await act(async () => {
        next?.(0);
        await Promise.resolve();
        await Promise.resolve();
      });
    };

    await act(async () => {
      root.render(<WebPaneController />);
      await Promise.resolve();
    });
    await runFrame();
    expect(apiMocks.createWebPane).toHaveBeenCalledTimes(1);

    const signinListener = eventMocks.listen.mock.calls
      .find(([event]) => event === apiMocks.WEB_PANE_SIGNIN_EVENT)?.[1] as
        (event: { payload: unknown }) => void;
    expect(signinListener).toBeTypeOf("function");

    await act(async () => {
      signinListener({
        payload: { profileDir: "google", tabIds: ["web-tab"], state: "running", error: null },
      });
      await Promise.resolve();
    });
    await runFrame();
    await runFrame();
    expect(apiMocks.createWebPane).toHaveBeenCalledTimes(1);

    await act(async () => {
      signinListener({
        payload: { profileDir: "google", tabIds: ["web-tab"], state: "finished", error: null },
      });
      await Promise.resolve();
    });
    await runFrame();
    expect(apiMocks.createWebPane).toHaveBeenCalledTimes(2);

    host.remove();
  });
});
