// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactSourceKind, Pane, Workspace } from "../../src/types";
import { isEditableTarget } from "../../src/lib/keybindings";
import { useKeybindingStore } from "../../src/stores/keybindingStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useDashboardViewStore } from "../../src/stores/dashboardViewStore";
import { closePaneOperation, resetPaneCloseOperationsForTests } from "../../src/lib/paneCloseOperation";
import { makeAppShellKeydown } from "./fixtures/appShellKeydown";

const mocks = vi.hoisted(() => ({ confirm: vi.fn(), kill: vi.fn(), evict: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (path: string) => `https://asset.localhost${path}`, isTauri: () => false, invoke: vi.fn(), Channel: class {} }));
vi.mock("../../src/lib/ipc", async original => ({ ...await original<object>(), killSession: mocks.kill,
  readEditableArtifact: vi.fn(async (sourcePath: string) => ({ sourcePath, sourceKind: sourcePath.endsWith(".docx") ? "office" : "markdown",
    content: '<p id="text">A document to read</p><a href="https://example.test">Link</a><input id="field">' })),
}));
vi.mock("../../src/lib/paneCloseConfirmation", () => ({ confirmPaneClose: mocks.confirm }));
vi.mock("../../src/components/terminal/terminalCache", async original => ({ ...await original<object>(), evictTerminalCache: mocks.evict }));
import BrowserPane from "../../src/components/workspace/BrowserPane";

let container: HTMLDivElement;
let root: Root;
let doc: Document;
let frame: HTMLIFrameElement;
let handler: ((event: KeyboardEvent) => void) | undefined;
const close = vi.fn(closePaneOperation);
const shellFocus = { request: vi.fn(), focusPaneSoon: vi.fn() };
const terminal: Pane = { id: "terminal", sessionId: "terminal-session", agentId: "shell-starter", activeTabId: "terminal-tab",
  tabs: [{ id: "terminal-tab", sessionId: "terminal-session", agentId: "shell-starter", type: "terminal" }] };

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks(); mocks.confirm.mockResolvedValue(true); mocks.kill.mockResolvedValue(undefined);
  resetPaneCloseOperationsForTests(); useKeybindingStore.getState().resetAll();
  useDashboardViewStore.setState({ open: false });
  useUiStore.setState({ activePaneId: "terminal-session", lastActivePaneId: "terminal-session", focusRevision: 0, zoomedPaneId: null });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {
  if (handler) window.removeEventListener("keydown", handler);
  handler = undefined;
  await act(async () => root.unmount()); container.remove();
  resetPaneCloseOperationsForTests(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function mount(sourceKind: ArtifactSourceKind = "markdown", context: "pane" | "dashboard" | "tabless" = "pane"): Promise<void> {
  const preview: Pane = { id: "preview", sessionId: "preview-session", agentId: "shell-starter", activeTabId: "preview-tab",
    tabs: [{ id: "preview-tab", sessionId: "preview-session", agentId: "shell-starter", type: "browser", sourceKind }] };
  const workspace: Workspace = { id: "workspace", name: "Synthetic", gridTemplateId: "1x2", status: "running", createdAt: 1,
    panes: [terminal, preview] };
  useWorkspaceListStore.setState({ workspaces: [workspace], activeWorkspaceId: workspace.id });
  await act(async () => root.render(<BrowserPane tabId={context === "pane" ? "preview-tab" : undefined}
    isDashboardPreview={context === "dashboard"} htmlPath="/synthetic/preview.html"
    sourcePath={sourceKind === "office" ? "/synthetic/preview.docx" : "/synthetic/preview.md"}
    sourceKind={sourceKind} reloadKey={0} isDirty={false} onDirtyChange={vi.fn()} onSaved={vi.fn()} />));
  frame = container.querySelector("iframe")!;
  expect(frame).not.toBeNull();
  // jsdom doesn't load srcdoc. Keep the real mounted iframe, navigate to its
  // same-origin about:blank document, and write the component's actual srcdoc.
  const source = frame.srcdoc;
  await act(async () => { frame.removeAttribute("srcdoc"); frame.src = "about:blank"; });
  doc = frame.contentDocument!;
  expect(doc).not.toBeNull();
  doc.open(); doc.write(source); doc.close();
  await act(async () => frame.dispatchEvent(new Event("load")));
  expect(doc.querySelector("#text")).not.toBeNull();
}
function pointer(phase: "down" | "up" | "cancel", target: Element = doc.querySelector("#text")!, init: MouseEventInit = {}, id = 7): void {
  const event = new MouseEvent(`pointer${phase}`, { bubbles: true, button: 0, clientX: 20, clientY: 30, ...init });
  Object.defineProperty(event, "pointerId", { value: id });
  target.dispatchEvent(event);
}
function closeKey(): void {
  doc.dispatchEvent(new KeyboardEvent("keydown", { key: "w", code: "KeyW", ctrlKey: true, altKey: true,
    bubbles: true, cancelable: true }));
}
function installShell(): void {
  const current = useWorkspaceListStore.getState().workspaces;
  handler = makeAppShellKeydown({ current: { workspaces: current, activeId: "workspace", activePaneId: "terminal-session",
    lastActivePaneId: "terminal-session", isKeybindingsOpen: false, isCrsmPaletteOpen: false, dashboardOpen: false } },
  useWorkspaceListStore, useUiStore, useKeybindingStore.getState().getActionsForEvent, isEditableTarget,
  close, shellFocus, useWorkspaceLayoutStore.getState().setActivePaneTab, () => "terminal-session");
  window.addEventListener("keydown", handler);
}

describe("real BrowserPane iframe activation", () => {
  it.each([
    ["toggle", "g"], ["previous column", "ArrowLeft"], ["next column", "ArrowRight"],
    ["close column", "Backspace"], ["pin column", "p"],
  ])("forwards the tabless dashboard %s shortcut without activating a pane", async (_, key) => {
    await mount("markdown", "dashboard");
    useDashboardViewStore.setState({ open: true }); useUiStore.getState().setActivePaneId(null);
    const before = useUiStore.getState(); const received = vi.fn((event: KeyboardEvent) => event.preventDefault());
    window.addEventListener("keydown", received);
    try {
      const event = new KeyboardEvent("keydown", { key, ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
      await act(async () => { pointer("down"); pointer("up"); doc.dispatchEvent(event); });
      expect(received).toHaveBeenCalledOnce(); expect(event.defaultPrevented).toBe(true);
      expect(useUiStore.getState().activePaneId).toBe(null);
      expect(useUiStore.getState().lastActivePaneId).toBe(before.lastActivePaneId);
      expect(useUiStore.getState().focusRevision).toBe(before.focusRevision);
    } finally { window.removeEventListener("keydown", received); }
  });

  it.each([
    { key: "w", ctrlKey: true, altKey: true }, { key: "Tab", ctrlKey: true },
    { key: "Enter", ctrlKey: true, shiftKey: true },
  ])("does not forward a pane/workspace action from dashboard context: %j", async keys => {
    await mount("markdown", "dashboard"); const received = vi.fn(); window.addEventListener("keydown", received);
    try {
      await act(async () => doc.dispatchEvent(new KeyboardEvent("keydown", { ...keys, bubbles: true, cancelable: true })));
      expect(received).not.toHaveBeenCalled(); expect(useUiStore.getState().activePaneId).toBe("terminal-session");
    } finally { window.removeEventListener("keydown", received); }
  });

  it("does not infer dashboard routing from a missing tab ID", async () => {
    await mount("markdown", "tabless"); const received = vi.fn(); window.addEventListener("keydown", received);
    try {
      await act(async () => doc.dispatchEvent(new KeyboardEvent("keydown", { key: "g", ctrlKey: true, shiftKey: true, cancelable: true })));
      expect(received).not.toHaveBeenCalled(); expect(useUiStore.getState().activePaneId).toBe("terminal-session");
    } finally { window.removeEventListener("keydown", received); }
  });

  it.each(["markdown", "text", "office"] as const)("activates %s from a document click without moving iframe focus", async kind => {
    await mount(kind);
    const field = doc.querySelector<HTMLInputElement>("input")!; field.focus();
    expect(document.activeElement).toBe(frame);
    await act(async () => { pointer("down"); pointer("up"); });
    expect(useUiStore.getState().activePaneId).toBe("preview-session");
    expect(useUiStore.getState().lastActivePaneId).toBe("preview-session");
    expect(doc.activeElement).toBe(field); expect(document.activeElement).toBe(frame);
  });

  it("routes an iframe close key through AppShell and closes the preview while preserving the terminal", async () => {
    await mount(); installShell();
    await act(async () => closeKey());
    expect(close).toHaveBeenCalledExactlyOnceWith({ kind: "pane", workspaceId: "workspace", paneId: "preview" }, "ui");
    const result = await close.mock.results[0].value;
    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ status: "closed" });
    expect(useWorkspaceListStore.getState().workspaces[0].panes.map(pane => pane.id)).toEqual(["terminal"]);
    expect(mocks.kill).not.toHaveBeenCalled();
  });

  it.each(["background", "hidden", "closing", "zoom"])("ignores click and suppresses forwarding from a %s iframe", async state => {
    await mount(); installShell();
    let finishClose: ((value: boolean) => void) | undefined;
    let closing: ReturnType<typeof closePaneOperation> | undefined;
    if (state === "background") useWorkspaceListStore.setState({ activeWorkspaceId: "other-workspace" });
    if (state === "zoom") useUiStore.getState().setZoomedPaneId("terminal");
    if (state === "hidden") useWorkspaceListStore.setState(current => ({ workspaces: current.workspaces.map(workspace => ({ ...workspace,
      panes: workspace.panes.map(pane => pane.id !== "preview" ? pane : { ...pane, activeTabId: "sibling-tab",
        tabs: [...pane.tabs, { ...pane.tabs[0], id: "sibling-tab", sessionId: "sibling-session" }] }),
    })) }));
    if (state === "closing") {
      mocks.confirm.mockImplementation(() => new Promise<boolean>(resolve => { finishClose = resolve; }));
      closing = closePaneOperation({ kind: "pane", workspaceId: "workspace", paneId: "preview" }, "ui");
      expect(finishClose).toBeTypeOf("function");
    }
    const forwarded = vi.fn(); window.addEventListener("keydown", forwarded);
    const before = useUiStore.getState();
    try {
      await act(async () => { pointer("down"); pointer("up"); closeKey(); });
      expect(useUiStore.getState().activePaneId).toBe("terminal-session");
      expect(useUiStore.getState().lastActivePaneId).toBe(before.lastActivePaneId);
      expect(useUiStore.getState().focusRevision).toBe(before.focusRevision);
      expect(close).not.toHaveBeenCalled(); expect(mocks.kill).not.toHaveBeenCalled();
      expect(forwarded).not.toHaveBeenCalled();
    } finally { window.removeEventListener("keydown", forwarded); finishClose?.(false); await closing; }
  });

  it.each(["link", "input", "editable", "modifier", "right", "drag", "selection", "cancel", "pointer-id"])("preserves document interaction for %s", async kind => {
    await mount();
    let target = doc.querySelector("#text")!;
    if (kind === "link") target = doc.querySelector("a")!;
    if (kind === "input") target = doc.querySelector("input")!;
    if (kind === "editable") target.setAttribute("contenteditable", "true");
    const options: MouseEventInit = kind === "modifier" ? { ctrlKey: true } : kind === "right" ? { button: 2 } : {};
    pointer("down", target, options);
    if (kind === "selection") {
      const range = doc.createRange(); range.selectNodeContents(target); doc.getSelection()!.addRange(range);
      expect(doc.getSelection()!.toString()).toBe("A document to read");
    }
    if (kind === "cancel") pointer("cancel", target);
    await act(async () => pointer("up", target, kind === "drag" ? { clientX: 26 } : options, kind === "pointer-id" ? 8 : 7));
    expect(useUiStore.getState().activePaneId).toBe("terminal-session");
  });
});
