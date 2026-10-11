// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { htmlReviewStrings as s, type HtmlReviewCapture } from "../../src/lib/htmlReviewDraft";

const mocks = vi.hoisted(() => ({ searchHtmlReviewTargets: vi.fn(), captureHtmlReviewTarget: vi.fn(), readHtmlReviewSelection: vi.fn(), chooseHtmlReviewElement: vi.fn(), cancelHtmlReviewPicker: vi.fn(async () => {}), listen: vi.fn(async (..._args: unknown[]) => () => {}), validateHtmlReviewCapture: vi.fn(), writeText: vi.fn() }));
vi.mock("../../src/lib/htmlReviewCapture", () => mocks);
vi.mock("@tauri-apps/api/event", async original => ({ ...await original<object>(), listen: mocks.listen }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<object>(), convertFileSrc: (path: string) => `http://asset.localhost/${encodeURIComponent(path)}` }));
import HtmlReviewDraftBar from "../../src/components/workspace/HtmlReviewDraftBar";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import { useKeybindingStore } from "../../src/stores/keybindingStore";
import { isEditableTarget } from "../../src/lib/keybindings";
import { focusController } from "../../src/lib/focusController";
import { makeAppShellKeydown, trackAppShellPaneFocus } from "./fixtures/appShellKeydown";

const frame = { url: "http://asset.localhost/C%3A%2Ffixture.html", documentId: "doc", generation: 1, mutationRevision: 0,
  ref: "r1", fingerprint: "pay", selector: "#pay", rect: { x: 0, y: 0, width: 100, height: 30 },
  scrollX: 0, scrollY: 0, dpr: 1, cssZoom: 1, viewport: { width: 800, height: 600 } };
const node = { ref: "r1", name: "Pay", tag: "button", role: "button", rect: frame.rect, inViewport: true };
const capture: HtmlReviewCapture = { id: "finding-1", sourcePath: "C:/fixture.html", tabId: "preview", capturedAt: "2026-10-05T12:00:00Z",
  node, frame, coordinateSpace: "document-css", clip: frame.rect,
  screenshot: { tabId: "preview", path: "C:/shot.png", width: 100, height: 30, dpr: 1 } };
let container: HTMLDivElement; let root: Root;
const render = (reloadKey = "0") => root.render(<HtmlReviewDraftBar tabId="preview" sourcePath="C:/fixture.html" previewPath="C:/fixture.html" reloadKey={reloadKey} />);
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((el) => el.textContent === label)!;
async function click(label: string) { await act(async () => button(label).click()); }
async function prepareCapture() {
  await click(s.open); await click(s.search); await click("button : Pay");
  await act(async () => container.querySelector("img")!.dispatchEvent(new Event("load")));
  const textarea = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Make it larger");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(navigator, "clipboard", { value: { writeText: mocks.writeText }, configurable: true });
  vi.clearAllMocks();
  mocks.searchHtmlReviewTargets.mockResolvedValue({ page: frame, nodes: [node] });
  mocks.captureHtmlReviewTarget.mockResolvedValue(capture);
  mocks.validateHtmlReviewCapture.mockResolvedValue(undefined); mocks.writeText.mockResolvedValue(undefined);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => render());
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe("review draft UI", () => {
  it("L2 keeps outside body/H2 clear and permits terminal close after a delayed review capture", async () => {
    container.dataset.dndWorkspaceId = "workspace"; container.dataset.dndPaneId = "preview";
    useWorkspaceListStore.setState({ activeWorkspaceId: "workspace", workspaces: [{ id: "workspace", panes: [
      { id: "terminal", activeTabId: "t", tabs: [{ id: "t", sessionId: "terminal-session", type: "terminal" }] },
      { id: "preview", activeTabId: "p", tabs: [{ id: "p", sessionId: "preview-session", type: "browser" }] },
    ] }] } as never);
    useUiStore.setState({ activePaneId: "terminal-session", focusRevision: 0, zoomedPaneId: null }); useKeybindingStore.getState().resetAll();
    const heading = document.createElement("div"); heading.className = "pane-active-heading"; heading.tabIndex = 0; container.prepend(heading);
    const tracking = trackAppShellPaneFocus(() => useWorkspaceListStore.getState().workspaces[0]); const close = vi.fn().mockResolvedValue({ status: "closed" });
    const handler = makeAppShellKeydown({ current: { dashboardOpen: false } }, useWorkspaceListStore, useUiStore,
      useKeybindingStore.getState().getActionsForEvent, isEditableTarget, close, focusController,
      useWorkspaceLayoutStore.getState().setActivePaneTab, () => null, undefined, undefined, tracking.memory);
    window.addEventListener("keydown", handler); const outside = document.createElement("div"); document.body.append(outside);
    try {
      await click(s.open); await click(s.search); const choice = button("button : Pay"); choice.focus();
      let release!: (capture: HtmlReviewCapture) => void;
      mocks.captureHtmlReviewTarget.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
      await click("button : Pay"); expect(tracking.memory.current?.paneId).toBe("preview");
      outside.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      document.body.tabIndex = -1; document.body.focus(); document.body.removeAttribute("tabindex");
      expect(document.activeElement).toBe(document.body); expect(tracking.memory.current).toBeNull();
      await act(async () => release(capture)); expect.soft(choice.isConnected).toBe(false);
      expect.soft(document.activeElement).toBe(document.body); expect.soft(tracking.memory.current).toBeNull();
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "w", ctrlKey: true, altKey: true, bubbles: true, cancelable: true }));
      expect(close).toHaveBeenCalledExactlyOnceWith({ kind: "pane", workspaceId: "workspace", paneId: "terminal" }, "ui");
    } finally { tracking.dispose(); window.removeEventListener("keydown", handler); outside.remove(); }
  });
  it("builds a request only after showing an image and receiving a comment", async () => {
    await click(s.open); await click(s.search); await click("button : Pay");
    expect(button(s.copy).disabled).toBe(true);
    await click(s.close);
    await prepareCapture();
    expect(button(s.copy).disabled).toBe(false);
    await click(s.copy);
    expect(mocks.validateHtmlReviewCapture).toHaveBeenCalledExactlyOnceWith(capture, frame.url);
    expect(mocks.writeText).toHaveBeenCalledOnce();
    expect(mocks.writeText.mock.calls[0][0]).toContain("finding-1");
    expect(container.textContent).toContain(s.copied);
    expect(container.textContent).toContain(s.pending);
  });
  it("never copies stale evidence and prompts re-selection", async () => {
    await prepareCapture();
    mocks.validateHtmlReviewCapture.mockRejectedValue(new Error("review-stale"));
    await click(s.copy);
    expect(mocks.writeText).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(s.stale);
    expect(container.querySelector("img")).toBeNull();
  });
  it("does not treat clipboard failure as delivery or success", async () => {
    await prepareCapture(); mocks.writeText.mockRejectedValue(new Error("permission denied"));
    await click(s.copy);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(s.clipboard);
    expect(container.textContent).not.toContain(s.copied);
    expect(container.querySelector("img")).not.toBeNull();
  });
  it("rejects a broken preview image before copying", async () => {
    await prepareCapture();
    await act(async () => container.querySelector("img")!.dispatchEvent(new Event("error")));
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(s.failed);
    expect(mocks.writeText).not.toHaveBeenCalled();
  });
  it("invalidates outstanding search when closed, and allows a fresh search", async () => {
    let resolve!: (value: unknown) => void;
    mocks.searchHtmlReviewTargets.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    await click(s.open); await click(s.search); await click(s.close);
    await act(async () => resolve({ page: frame, nodes: [node] }));
    expect(container.textContent).not.toContain("button : Pay");
    await click(s.open); await click(s.search);
    expect(container.textContent).toContain("button : Pay");
  });
  it("invalidates a selected image on preview reload", async () => {
    await prepareCapture(); await act(async () => render("1"));
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).not.toContain(s.copied);
  });
  it("suppresses double sends while validation is pending", async () => {
    await prepareCapture();
    let resolve!: () => void;
    mocks.validateHtmlReviewCapture.mockReturnValueOnce(new Promise<void>((done) => { resolve = done; }));
    await click(s.copy); await click(s.copy);
    expect(mocks.validateHtmlReviewCapture).toHaveBeenCalledOnce();
    await act(async () => resolve());
    expect(mocks.writeText).toHaveBeenCalledOnce();
  });
  it("disables locations that were outside the viewport at search time", async () => {
    mocks.searchHtmlReviewTargets.mockResolvedValueOnce({ page: frame, nodes: [{ ...node, inViewport: false }] });
    await click(s.open); await click(s.search);
    expect(button("button : Pay").disabled).toBe(true);
    expect(button("button : Pay").title).toBe(s.outside);
  });
  it("uses a selected range and explains how to select when none exists", async () => {
    mocks.readHtmlReviewSelection.mockResolvedValueOnce({ page: frame, node: null });
    await click(s.open); await click(s.selection);
    expect(container.textContent).toContain(s.noSelection);
    expect(mocks.captureHtmlReviewTarget).not.toHaveBeenCalled();
    mocks.readHtmlReviewSelection.mockResolvedValueOnce({ page: frame, node });
    await click(s.selection);
    expect(mocks.captureHtmlReviewTarget).toHaveBeenCalledExactlyOnceWith("preview", frame.url, "C:/fixture.html", frame, node);
    expect(container.querySelector("img")).not.toBeNull();
  });

  it("captures the element chosen on screen and removes the choosing controls", async () => {
    mocks.chooseHtmlReviewElement.mockResolvedValueOnce({ page: frame, node });
    await click(s.open); await click(s.pick);
    expect(mocks.captureHtmlReviewTarget).toHaveBeenCalledExactlyOnceWith("preview", frame.url, "C:/fixture.html", frame, node);
    expect(container.querySelector("img")).not.toBeNull();
    expect(container.textContent).not.toContain(s.cancelPick);
  });
  it.each(["close", "reload", "navigation", "Escape", "cancel"])("cleans up active picking on %s and discards a late result", async (action) => {
    let resolve!: (value: unknown) => void;
    mocks.chooseHtmlReviewElement.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    await click(s.open); await click(s.pick);
    const [, , token, current] = mocks.chooseHtmlReviewElement.mock.calls[0];
    if (action === "close") await click(s.close);
    if (action === "reload") await act(async () => render("1"));
    if (action === "navigation") {
      const handler = mocks.listen.mock.calls[0][1] as (event: { payload: { tabId: string; url: string } }) => void;
      await act(async () => handler({ payload: { tabId: "preview", url: "https://example.test/other" } }));
    }
    if (action === "Escape") await act(async () => container.querySelector("section")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    if (action === "cancel") await click(s.cancelPick);
    expect(current()).toBe(false);
    expect(mocks.cancelHtmlReviewPicker).toHaveBeenCalledWith("preview", token);
    await act(async () => resolve({ page: frame, node }));
    expect(mocks.captureHtmlReviewTarget).not.toHaveBeenCalled();
    expect(container.querySelector("img")).toBeNull();
  });

});

import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useUiStore } from "../../src/stores/uiStore";
function ownPane() {
  container.dataset.dndWorkspaceId = "focus-workspace"; container.dataset.dndPaneId = "focus-pane";
  useWorkspaceListStore.setState({ activeWorkspaceId: "focus-workspace", workspaces: [{ id: "focus-workspace", panes: [{ id: "focus-pane", tabs: [] }] }] as never });
  useUiStore.setState({ focusRevision: 0, zoomedPaneId: null });
}
it("returns focus when an asynchronously captured target row disappears", async () => {
  ownPane(); await click(s.open); await click(s.search);
  const row = button("button : Pay"); row.focus(); await click("button : Pay");
  expect(row.isConnected).toBe(false); expect(document.activeElement).toBe(button(s.close));
});
it("returns from the disappearing picker cancel button", async () => {
  ownPane(); mocks.chooseHtmlReviewElement.mockReturnValue(new Promise(() => {}));
  await click(s.open); const trigger = button(s.pick); trigger.focus(); await click(s.pick);
  const cancel = button(s.cancelPick); cancel.focus(); await click(s.cancelPick);
  expect(cancel.isConnected).toBe(false); expect(document.activeElement).toBe(button(s.close));
});
it("does not steal a newer outside focus after target capture", async () => {
  ownPane(); let resolve!: (value: unknown) => void;
  mocks.captureHtmlReviewTarget.mockReturnValue(new Promise(done => { resolve = done; }));
  await click(s.open); await click(s.search); button("button : Pay").focus(); await click("button : Pay");
  const outside = document.createElement("button"); container.append(outside); outside.focus(); useUiStore.getState().bumpFocusRevision();
  await act(async () => resolve(capture)); expect(document.activeElement).toBe(outside);
});
it("does not steal a newer focus within the same review surface after target capture", async () => {
  ownPane(); let resolve!: (value: unknown) => void;
  mocks.captureHtmlReviewTarget.mockReturnValue(new Promise(done => { resolve = done; }));
  await click(s.open); await click(s.search); button("button : Pay").focus(); await click("button : Pay");
  // Search controls are disabled while capturing. Add a live focus target in
  // the mounted surface to exercise the return guard independently of that.
  const input = document.createElement("input"); container.querySelector("section")!.append(input); input.focus();
  expect(document.activeElement).toBe(input);
  await act(async () => resolve(capture)); expect(document.activeElement).toBe(input);
});
it("does not restore an older picker focus on Escape after a newer selection", async () => {
  ownPane(); mocks.chooseHtmlReviewElement.mockReturnValue(new Promise(() => {}));
  await click(s.open); await click(s.pick); const cancel = button(s.cancelPick); cancel.focus();
  useUiStore.getState().bumpFocusRevision();
  await act(async () => cancel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(cancel.isConnected).toBe(false); expect(document.activeElement).toBe(document.body);
});
it("M1 returns a re-entered picker on Escape while its old async capture stays separate", async () => {
  ownPane(); mocks.chooseHtmlReviewElement.mockReturnValue(new Promise(() => {}));
  await click(s.open); await click(s.pick); const cancel = button(s.cancelPick); cancel.focus();
  const before = useUiStore.getState(); const outside = document.createElement("button"); document.body.append(outside);
  try {
    await act(async () => outside.focus()); await act(async () => cancel.focus());
    await act(async () => cancel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(cancel.isConnected).toBe(false); expect(document.activeElement).toBe(button(s.close));
    expect(useUiStore.getState().activePaneId).toBe(before.activePaneId); expect(useUiStore.getState().focusRevision).toBe(before.focusRevision);
  } finally { outside.remove(); }
});
