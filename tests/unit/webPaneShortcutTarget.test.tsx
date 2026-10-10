// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useKeybindingStore } from "../../src/stores/keybindingStore";
import { usePaneDragStore } from "../../src/stores/paneDragStore";
import { useSavepointDragStore } from "../../src/stores/savepointDragStore";
import { useWebPaneTranscriptStore } from "../../src/stores/webPaneTranscriptStore";
import type { Workspace } from "../../src/types";

vi.mock("../../src/components/workspace/webPaneApi", () => ({
  createWebPane: vi.fn().mockResolvedValue("web-pane-web-tab"),
  destroyWebPane: vi.fn().mockResolvedValue(undefined),
  updateWebPane: vi.fn().mockResolvedValue(undefined),
  reloadPreviewWebPane: vi.fn().mockResolvedValue(undefined),
  WEB_PANE_SIGNIN_EVENT: "mycmux:web-pane-signin",
}));
// Use the installed Tauri event/webview SDK, including its actual listen target.
import WebPaneController from "../../src/components/workspace/WebPaneController";

interface Subscription {
  owner: string;
  event: string;
  target: { kind: string; label?: string };
  handler: number;
}
const roots: { root: Root; container: HTMLDivElement }[] = [];
let subscriptions: Map<number, Subscription>;
let callbacks: Map<number, (event: unknown) => void>;
let metadata: { currentWebview: { label: string }; currentWindow: { label: string } };
let nextId: number;
let received: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  subscriptions = new Map(); callbacks = new Map(); nextId = 0;
  metadata = { currentWebview: { label: "main" }, currentWindow: { label: "main" } };
  vi.stubGlobal("__TAURI_INTERNALS__", {
    metadata,
    transformCallback: (callback: (event: unknown) => void) => {
      const id = ++nextId; callbacks.set(id, callback); return id;
    },
    invoke: async (command: string, args: { event?: string; target?: Subscription["target"]; handler?: number; eventId?: number }) => {
      if (command === "plugin:event|listen") {
        const id = ++nextId;
        subscriptions.set(id, {
          owner: metadata.currentWebview.label, event: args.event!, target: args.target!, handler: args.handler!,
        });
        return id;
      }
      if (command === "plugin:event|unlisten") { subscriptions.delete(args.eventId!); return; }
      throw new Error(`unexpected IPC in isolated subscription fixture: ${command}`);
    },
  });
  vi.stubGlobal("__TAURI_EVENT_PLUGIN_INTERNALS__", {
    unregisterListener: (_event: string, id: number) => {
      const subscription = subscriptions.get(id);
      if (subscription) callbacks.delete(subscription.handler);
    },
  });
  useKeybindingStore.getState().resetAll();
  usePaneDragStore.setState({ item: null }); useSavepointDragStore.setState({ item: null });
  useWebPaneTranscriptStore.setState({ readingTabIds: [] });
  const workspace: Workspace = {
    id: "workspace", name: "Workspace", gridTemplateId: "1x1", status: "running", createdAt: 1,
    panes: [{ id: "pane", agentId: "web", sessionId: "web-session", activeTabId: "web-tab",
      tabs: [{ id: "web-tab", agentId: "web", sessionId: "web-session", type: "web", presetId: "chatgpt" }] }],
    splitColumns: [["pane"]],
  };
  // Both controllers intentionally recognize the tab during an ownership handoff.
  useWorkspaceListStore.setState({ workspaces: [workspace], activeWorkspaceId: workspace.id });
  received = vi.fn(); window.addEventListener("keydown", received);
});

afterEach(async () => {
  for (const { root, container } of roots.splice(0)) {
    await act(async () => root.unmount()); container.remove();
  }
  window.removeEventListener("keydown", received); vi.unstubAllGlobals();
});

async function mount(label: string): Promise<void> {
  metadata.currentWebview.label = label; metadata.currentWindow.label = label;
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container); roots.push({ root, container });
  await act(async () => root.render(<WebPaneController />));
}
async function emitShortcut(owner: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const payload = {
    tabId: "web-tab", key: "Tab", code: "Tab", location: 0, ctrlKey: true,
    altKey: false, shiftKey: false, metaKey: false, repeat: false, isComposing: false, ...overrides,
  };
  await act(async () => {
    for (const [id, subscription] of subscriptions) {
      if (subscription.event !== "mycmux:web-pane-keydown") continue;
      // Pinned Tauri admits Any listeners for every targeted emit; Webview is exact.
      if (subscription.target.kind === "Any"
        || (subscription.target.kind === "Webview" && subscription.target.label === owner)) {
        callbacks.get(subscription.handler)?.({ event: subscription.event, id, payload });
      }
    }
  });
}

describe("F4 actual shortcut subscription", () => {
  it("registers each controller with its own Webview target", async () => {
    await mount("main"); await mount("mycmux-w1");
    const shortcutListeners = [...subscriptions.values()].filter((entry) => entry.event === "mycmux:web-pane-keydown");
    expect(shortcutListeners).toHaveLength(2);
    for (const entry of shortcutListeners) expect(entry.target).toEqual({ kind: "Webview", label: entry.owner });
  });
  it("delivers once across two windows, detach and return even with overlapping tab ownership", async () => {
    await mount("main"); await mount("mycmux-w1");
    await emitShortcut("main"); expect(received).toHaveBeenCalledTimes(1);
    await emitShortcut("mycmux-w1"); expect(received).toHaveBeenCalledTimes(2);
    await emitShortcut("main"); expect(received).toHaveBeenCalledTimes(3);
    await emitShortcut("main", { tabId: "other-tab" });
    await emitShortcut("main", { key: "r", code: "KeyR" });
    await emitShortcut("main", { isComposing: true });
    expect(received).toHaveBeenCalledTimes(3);
  });
});
