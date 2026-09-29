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
