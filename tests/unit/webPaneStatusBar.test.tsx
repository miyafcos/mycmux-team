// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  loadWebPanePresets: vi.fn(),
  startWebPaneSignin: vi.fn(),
  WEB_PANE_URL_EVENT: "mycmux:web-pane-url",
  WEB_PANE_SIGNIN_EVENT: "mycmux:web-pane-signin",
}));
const eventMocks = vi.hoisted(() => ({
  listen: vi.fn(),
  unlisten: vi.fn(),
}));

vi.mock("../../src/components/workspace/webPaneApi", () => apiMocks);
vi.mock("@tauri-apps/api/event", () => ({ listen: eventMocks.listen }));

import WebPaneStatusBar from "../../src/components/workspace/WebPaneStatusBar";
import { webPaneStrings } from "../../src/components/workspace/webPaneStrings";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import { useKeybindingStore } from "../../src/stores/keybindingStore";
import { isEditableTarget } from "../../src/lib/keybindings";
import { focusController } from "../../src/lib/focusController";
import { makeAppShellKeydown, trackAppShellPaneFocus } from "./fixtures/appShellKeydown";

let container: HTMLDivElement;
let root: Root;

function listenerFor(event: string) {
  const entry = eventMocks.listen.mock.calls.find(([name]) => name === event);
  return entry?.[1] as ((payload: { payload: unknown }) => void) | undefined;
}

async function emitUrl(payload: Record<string, unknown>) {
  const listener = listenerFor(apiMocks.WEB_PANE_URL_EVENT);
  expect(listener).toBeTypeOf("function");
  await act(async () => {
    listener?.({ payload });
    await Promise.resolve();
  });
}

function bar(): HTMLElement | null {
  return container.querySelector("[data-web-pane-status-bar]");
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
  eventMocks.listen.mockResolvedValue(eventMocks.unlisten);
  apiMocks.loadWebPanePresets.mockResolvedValue([
    { id: "chatgpt", label: "ChatGPT", url: "https://chatgpt.com/", profileDir: "google" },
  ]);
  apiMocks.startWebPaneSignin.mockResolvedValue({
    profileDir: "google",
    tabIds: ["web-tab"],
    browserPath: "msedge.exe",
  });
  await act(async () => {
    root.render(<WebPaneStatusBar tabId="web-tab" presetId="chatgpt" />);
    await Promise.resolve();
    await Promise.resolve();
  });
});

describe("pane-owned temporary sign-in controls", () => {
  async function ownedButton() {
    container.dataset.dndWorkspaceId = "workspace"; container.dataset.dndPaneId = "web-pane";
    useWorkspaceListStore.setState({ activeWorkspaceId: "workspace", workspaces: [{ id: "workspace", panes: [{ id: "web-pane", tabs: [] }] }] } as never);
    useUiStore.setState({ focusRevision: 0, zoomedPaneId: null });
    const heading = document.createElement("div"); heading.className = "pane-active-heading"; heading.tabIndex = 0;
    container.prepend(heading);
    await emitUrl({ tabId: "web-tab", signedOut: true });
    const button = bar()!.querySelector<HTMLButtonElement>("button")!;
    await act(async () => button.focus()); return { button, heading };
  }
  it.each(["click", "native-running", "navigation"])("returns a disappearing sign-in button to its heading on %s", async action => {
    const { button, heading } = await ownedButton();
    if (action === "click") await act(async () => button.click());
    if (action === "native-running") await act(async () => listenerFor(apiMocks.WEB_PANE_SIGNIN_EVENT)?.({ payload: { tabIds: ["web-tab"], state: "running" } }));
    if (action === "navigation") await emitUrl({ tabId: "web-tab", signedOut: false });
    expect(button.isConnected).toBe(false); expect(document.activeElement).toBe(heading);
  });
  it.each(["revision", "focus"])("does not steal a newer %s when the sign-in button disappears", async decision => {
    const { button, heading } = await ownedButton();
    if (decision === "revision") useUiStore.getState().bumpFocusRevision();
    if (decision === "focus") heading.focus();
    await emitUrl({ tabId: "web-tab", signedOut: false });
    expect(button.isConnected).toBe(false);
    expect(document.activeElement).toBe(decision === "focus" ? heading : document.body);
  });
  it("L2 keeps H2 cleared and permits terminal close after an outside pointer/body then navigation", async () => {
    const { button } = await ownedButton();
    const terminalTab = { id: "terminal-tab", type: "terminal", agentId: "shell-starter", sessionId: "terminal-session" };
    useWorkspaceListStore.setState({ workspaces: [{ id: "workspace", panes: [{ id: "terminal", activeTabId: "terminal-tab", tabs: [terminalTab] },
      { id: "web-pane", activeTabId: "web-tab", tabs: [{ ...terminalTab, id: "web-tab", type: "web", sessionId: "web-session" }] }] }] } as never);
    useUiStore.setState({ activePaneId: "terminal-session", lastActivePaneId: "terminal-session" }); useKeybindingStore.getState().resetAll();
    const tracking = trackAppShellPaneFocus(() => useWorkspaceListStore.getState().workspaces[0]); const close = vi.fn().mockResolvedValue({ status: "closed" });
    const handler = makeAppShellKeydown({ current: { dashboardOpen: false } }, useWorkspaceListStore, useUiStore,
      useKeybindingStore.getState().getActionsForEvent, isEditableTarget, close, focusController,
      useWorkspaceLayoutStore.getState().setActivePaneTab, () => null, undefined, undefined, tracking.memory);
    window.addEventListener("keydown", handler);
    const outside = document.createElement("div"); document.body.append(outside);
    try {
      await act(async () => { button.blur(); button.focus(); }); expect(tracking.memory.current?.paneId).toBe("web-pane");
      outside.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); button.blur();
      expect(document.activeElement).toBe(document.body); expect(tracking.memory.current).toBeNull();
      await emitUrl({ tabId: "web-tab", signedOut: false });
      expect.soft(document.activeElement).toBe(document.body); expect.soft(tracking.memory.current).toBeNull();
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "w", ctrlKey: true, altKey: true, bubbles: true, cancelable: true }));
      expect(close).toHaveBeenCalledExactlyOnceWith({ kind: "pane", workspaceId: "workspace", paneId: "terminal" }, "ui");
    } finally { tracking.dispose(); window.removeEventListener("keydown", handler); outside.remove(); }
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("WebPaneStatusBar", () => {
  it("says nothing before the pane has reported where it is", () => {
    // The bar this replaced was unconditional, so "log in somewhere else" was
    // the first thing every launch showed even when nothing was wrong.
    expect(bar()).toBeNull();
  });

  it("stays hidden once the service is signed in", async () => {
    await emitUrl({
      tabId: "web-tab",
      presetId: "chatgpt",
      url: "https://chatgpt.com/c/abc",
      signedOut: false,
    });
    expect(bar()).toBeNull();
  });

  it("ignores another tab's navigation", async () => {
    await emitUrl({
      tabId: "other-tab",
      presetId: "chatgpt",
      url: "https://chatgpt.com/auth/login",
      signedOut: true,
    });
    expect(bar()).toBeNull();
  });

  it("offers a sign-in window only while the service is signed out", async () => {
    await emitUrl({
      tabId: "web-tab",
      presetId: "chatgpt",
      url: "https://chatgpt.com/auth/login",
      signedOut: true,
    });
    const shown = bar();
    expect(shown).not.toBeNull();
    expect(shown?.textContent).toContain(webPaneStrings.signedOut("ChatGPT"));
    const button = shown?.querySelector("button");
    expect(button?.textContent).toBe(webPaneStrings.signInButton);

    await act(async () => {
      button?.click();
      await Promise.resolve();
    });
    expect(apiMocks.startWebPaneSignin).toHaveBeenCalledWith("chatgpt");
    // While the browser window is up there is nothing useful to press.
    expect(bar()?.querySelector("button")).toBeNull();
    expect(bar()?.textContent).toContain(webPaneStrings.signInRunning("ChatGPT"));
  });

  it("shows why the sign-in window did not open instead of failing quietly", async () => {
    apiMocks.startWebPaneSignin.mockRejectedValue(new Error("Microsoft Edge was not found"));
    await emitUrl({
      tabId: "web-tab",
      presetId: "chatgpt",
      url: "https://chatgpt.com/auth/login",
      signedOut: true,
    });
    await act(async () => {
      bar()?.querySelector("button")?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(bar()?.textContent).toContain("Microsoft Edge was not found");
  });
});
