// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pane, PaneTab, Workspace } from "../../src/types";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useKeybindingStore } from "../../src/stores/keybindingStore";
import { focusController } from "../../src/lib/focusController";
import { isEditableTarget } from "../../src/lib/keybindings";
import { closePaneOperation, resetPaneCloseOperationsForTests } from "../../src/lib/paneCloseOperation";
import { artifactEditorStrings } from "../../src/components/workspace/artifactEditorStrings";
import { makeAppShellKeydown, trackAppShellPaneFocus } from "./fixtures/appShellKeydown";

const mocks = vi.hoisted(() => ({ kill: vi.fn(), reveal: vi.fn(), open: vi.fn() }));
vi.mock("../../src/lib/ipc", async original => ({ ...await original<object>(), killSession: mocks.kill,
  revealInExplorer: mocks.reveal, openWithDefault: mocks.open,
  readEditableArtifact: vi.fn(async () => ({ content: "<p>Read me</p>", sourceKind: "markdown", sourcePath: "/preview.md" })),
  onSavepointPublishProgress: vi.fn().mockResolvedValue(() => {}), crsmListSessions: vi.fn().mockResolvedValue([]),
  listOnlineSavepoints: vi.fn().mockResolvedValue([]), listTrashedOnlineSavepoints: vi.fn().mockResolvedValue([]),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null), isTauri: () => false,
  convertFileSrc: (path: string) => `https://asset.localhost${path}`, Channel: class {} }));
vi.mock("@tauri-apps/api/event", async original => ({ ...await original<object>(), listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("../../src/lib/paneCloseConfirmation", () => ({ confirmPaneClose: vi.fn().mockResolvedValue(true) }));
vi.mock("../../src/hooks/usePaneDragSource", () => ({ usePaneDragSource: () => ({ beginPointerDrag: vi.fn(), shouldSuppressClick: () => false }) }));
vi.mock("../../src/components/composer/PaneComposer", () => ({ PaneComposer: () => null }));
vi.mock("../../src/components/terminal/XTermWrapper", () => ({ default: () => <div className="xterm"><textarea className="xterm-helper-textarea" /></div>, hasTerminalBuffer: () => false }));
import TerminalPane from "../../src/components/workspace/TerminalPane";

let root: Root;
let host: HTMLDivElement;
let handler: ((event: KeyboardEvent) => void) | undefined;
let tracking: ReturnType<typeof trackAppShellPaneFocus> | undefined;
const close = vi.fn(closePaneOperation);
function Harness() {
  const workspace = useWorkspaceListStore(state => state.workspaces[0]);
  return <>{workspace.panes.map(pane => <TerminalPane key={pane.id} pane={pane} workspaceId={workspace.id}
    onClose={() => { void closePaneOperation({ kind: "pane", workspaceId: workspace.id, paneId: pane.id }, "ui"); }} />)}</>;
}
async function mount(type: PaneTab["type"] = "browser", sibling = false): Promise<void> {
  const terminal: Pane = { id: "terminal", sessionId: "terminal-session", agentId: "shell-starter", activeTabId: "terminal-tab",
    tabs: [{ id: "terminal-tab", sessionId: "terminal-session", agentId: "shell-starter", type: "terminal" }] };
  const previewTab: PaneTab = { id: "preview-tab", sessionId: "preview-session", agentId: "shell-starter", type,
    sourceKind: "markdown", htmlPath: "/preview.html", sourcePath: "/preview.md" };
  const preview: Pane = { id: "preview", sessionId: previewTab.sessionId, agentId: "shell-starter", activeTabId: previewTab.id,
    tabs: [previewTab, ...(sibling ? [{ ...previewTab, id: "sibling-tab", sessionId: "sibling-session" }] : [])] };
  const workspace: Workspace = { id: "workspace", name: "Synthetic", gridTemplateId: "1x1", status: "running", createdAt: 1,
    panes: [terminal, preview] };
  useWorkspaceListStore.setState({ workspaces: [workspace], activeWorkspaceId: workspace.id });
  await act(async () => root.render(<Harness />));
}
function pane(): HTMLElement { return host.querySelector("[data-dnd-pane-id='preview']")!; }
function installShell(): void {
  tracking = trackAppShellPaneFocus(() => {
    const state = useWorkspaceListStore.getState(); return state.workspaces.find(ws => ws.id === state.activeWorkspaceId);
  });
  handler = makeAppShellKeydown({ current: { workspaces: useWorkspaceListStore.getState().workspaces,
    activeId: "workspace", activePaneId: "terminal-session", lastActivePaneId: "terminal-session",
    isKeybindingsOpen: false, isCrsmPaletteOpen: false, dashboardOpen: false } }, useWorkspaceListStore, useUiStore,
  useKeybindingStore.getState().getActionsForEvent, isEditableTarget, close, focusController,
  useWorkspaceLayoutStore.getState().setActivePaneTab, () => null, undefined, undefined, tracking.memory);
  window.addEventListener("keydown", handler);
}
async function closeKey(target: HTMLElement): Promise<void> {
  await act(async () => target.dispatchEvent(new KeyboardEvent("keydown", { key: "w", code: "KeyW", ctrlKey: true, altKey: true,
    bubbles: true, cancelable: true })));
}
async function pointer(target: HTMLElement, phase: "down" | "up" | "cancel", init: MouseEventInit = {}): Promise<void> {
  const event = new MouseEvent(`pointer${phase}`, { bubbles: true, cancelable: true, button: 0, clientX: 20, clientY: 30, ...init });
  Object.defineProperty(event, "pointerId", { value: 7 });
  await act(async () => target.dispatchEvent(event));
}
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.clearAllMocks(); mocks.kill.mockResolvedValue(undefined); mocks.open.mockResolvedValue(undefined); mocks.reveal.mockResolvedValue(undefined);
  resetPaneCloseOperationsForTests(); useKeybindingStore.getState().resetAll();
  focusController.request("tab-rename", { suppressMs: 0 });
  useSettingsStore.setState({ paneComposerEnabled: false, showTerminalHistoryButton: false });
  useUiStore.setState({ activePaneId: "terminal-session", lastActivePaneId: "terminal-session", focusRevision: 0, zoomedPaneId: null });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  if (handler) window.removeEventListener("keydown", handler); handler = undefined;
  tracking?.dispose(); tracking = undefined;
  await act(async () => root.unmount()); host.remove();
  resetPaneCloseOperationsForTests(); focusController.clearSession("terminal-session");
  window.getSelection()?.removeAllRanges(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

async function focusPreview(surface: string): Promise<HTMLElement> {
  if (surface === "embed") {
    await act(async () => useWorkspaceListStore.setState(current => ({ workspaces: current.workspaces.map(workspace => ({ ...workspace,
      panes: workspace.panes.map(pane => pane.id !== "preview" ? pane : { ...pane,
        tabs: pane.tabs.map(tab => ({ ...tab, sourceKind: "pdf" as const })) }),
    })) })));
  }
  const target = pane().querySelector<HTMLElement>(surface === "heading" ? ".pane-active-heading"
    : surface === "toolbar" ? `button[aria-label='${artifactEditorStrings.showLocation}']` : surface)!;
  if (surface === "embed") target.tabIndex = 0;
  await act(async () => target.focus());
  // H1's precondition includes a missed/stale logical selection even if the
  // normal iframe/embed focus activation correctly selected P first.
  await act(async () => useUiStore.getState().setActivePaneId("terminal-session"));
  return target;
}

describe("AppShell close attribution protects a terminal candidate in one direction", () => {
  it.each(["heading", "toolbar", "iframe", "embed"])("ignores close from a different live preview's %s", async surface => {
    await mount(); installShell(); const target = await focusPreview(surface);
    const before = useUiStore.getState(); const focus = vi.spyOn(focusController, "request");
    await closeKey(target);
    expect(close).not.toHaveBeenCalled(); expect(mocks.kill).not.toHaveBeenCalled(); expect(focus).not.toHaveBeenCalled();
    expect(useWorkspaceListStore.getState().workspaces[0].panes).toHaveLength(2);
    expect(useUiStore.getState().activePaneId).toBe(before.activePaneId);
    expect(useUiStore.getState().lastActivePaneId).toBe(before.lastActivePaneId);
    expect(useUiStore.getState().focusRevision).toBe(before.focusRevision); expect(document.activeElement).toBe(target);
  });

  it.each(["window", "document", "body"].flatMap(origin => ["iframe", "embed"].map(surface => [origin, surface])))
    ("uses the active %s fallback for a %s close event", async (origin, surface) => {
      await mount(); installShell(); const focused = await focusPreview(surface); const before = useUiStore.getState();
      const target = origin === "window" ? window : origin === "document" ? document : document.body;
      await act(async () => target.dispatchEvent(new KeyboardEvent("keydown", { key: "w", code: "KeyW", ctrlKey: true, altKey: true, bubbles: true, cancelable: true })));
      expect(close).not.toHaveBeenCalled(); expect(mocks.kill).not.toHaveBeenCalled();
      expect(useUiStore.getState().focusRevision).toBe(before.focusRevision); expect(document.activeElement).toBe(focused);
  });

  it("closes a newly selected preview while keyboard focus remains in the terminal input", async () => {
    await mount(); installShell();
    const input = host.querySelector<HTMLTextAreaElement>("[data-dnd-pane-id='terminal'] .xterm-helper-textarea")!;
    await act(async () => { input.focus(); useUiStore.getState().setActivePaneId("preview-session"); });
    await closeKey(input);
    expect(await close.mock.results[0].value).toMatchObject({ status: "closed" });
    expect(useWorkspaceListStore.getState().workspaces[0].panes.map(pane => pane.id)).toEqual(["terminal"]);
    expect(mocks.kill).not.toHaveBeenCalled();
  });

  it("uses the displayed preview when the logical session is its same-pane hidden terminal", async () => {
    await mount("browser", true); installShell();
    await act(async () => useWorkspaceListStore.setState(current => ({ workspaces: current.workspaces.map(workspace => ({ ...workspace,
      panes: workspace.panes.map(pane => pane.id !== "preview" ? pane : { ...pane,
        tabs: pane.tabs.map(tab => tab.id !== "sibling-tab" ? tab : { ...tab, type: "terminal" as const }) }),
    })) })));
    const input = host.querySelector<HTMLTextAreaElement>("[data-dnd-pane-id='terminal'] .xterm-helper-textarea")!;
    await act(async () => { input.focus(); useUiStore.getState().setActivePaneId("sibling-session"); }); await closeKey(input);
    expect(await close.mock.results[0].value).toMatchObject({ status: "closed" });
    expect(close).toHaveBeenCalledExactlyOnceWith({ kind: "tab", workspaceId: "workspace", paneId: "preview", tabId: "preview-tab" }, "ui");
    expect(useWorkspaceListStore.getState().workspaces[0].panes[1].tabs.map(tab => tab.id)).toEqual(["sibling-tab"]);
    expect(mocks.kill).not.toHaveBeenCalled();
  });

  it.each(["body", "same-pane", "outside", "unregistered", "background"])("keeps ordinary terminal close for a %s source", async origin => {
    await mount(); installShell(); let target: HTMLElement;
    if (origin === "body") { document.body.tabIndex = -1; target = document.body; }
    else if (origin === "same-pane") target = host.querySelector("[data-dnd-pane-id='terminal'] .xterm-helper-textarea")!;
    else {
      const container = document.createElement("div"); host.append(container);
      if (origin !== "outside") {
        container.dataset.dndPaneId = origin === "unregistered" ? "missing-pane" : "preview";
        container.dataset.dndWorkspaceId = origin === "background" ? "other-workspace" : "workspace";
      }
      target = document.createElement("button"); container.append(target);
    }
    target.focus(); await closeKey(target);
    expect(await close.mock.results[0].value).toMatchObject({ status: "closed" });
    expect(close).toHaveBeenCalledExactlyOnceWith({ kind: "pane", workspaceId: "workspace", paneId: "terminal" }, "ui");
    expect(useWorkspaceListStore.getState().workspaces[0].panes.map(pane => pane.id)).toEqual(["preview"]);
    if (origin === "body") document.body.removeAttribute("tabindex");
  });

  it("contains a missed name-menu selection after Escape independently of G1", async () => {
    await mount(); installShell(); const heading = pane().querySelector<HTMLElement>(".pane-active-heading")!;
    await pointer(heading, "down", { button: 2 }); await pointer(heading, "up", { button: 2 });
    await act(async () => heading.dispatchEvent(new MouseEvent("contextmenu", { button: 2, ctrlKey: true, bubbles: true, cancelable: true })));
    // A modified name-menu open naturally leaves T selected, independently of G1.
    expect(useUiStore.getState().activePaneId).toBe("terminal-session");
    const menu = document.querySelector<HTMLElement>("[role='menu']")!;
    await act(async () => menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    const before = useUiStore.getState(); const focus = vi.spyOn(focusController, "request");
    expect(document.activeElement).toBe(heading); await closeKey(heading);
    expect(close).not.toHaveBeenCalled(); expect(mocks.kill).not.toHaveBeenCalled(); expect(focus).not.toHaveBeenCalled();
    expect(useUiStore.getState().focusRevision).toBe(before.focusRevision);
  });

  it("keeps the real BrowserPane forwarded close after source activation with terminal focus retained", async () => {
    await mount(); installShell(); const frame = pane().querySelector("iframe")!;
    const srcdoc = frame.srcdoc; frame.removeAttribute("srcdoc"); frame.src = "about:blank";
    const doc = frame.contentDocument!; doc.open(); doc.write(srcdoc); doc.close();
    await act(async () => frame.dispatchEvent(new Event("load")));
    const input = host.querySelector<HTMLTextAreaElement>("[data-dnd-pane-id='terminal'] .xterm-helper-textarea")!; input.focus();
    await act(async () => doc.dispatchEvent(new KeyboardEvent("keydown", { key: "w", code: "KeyW", ctrlKey: true, altKey: true, bubbles: true, cancelable: true })));
    expect(await close.mock.results[0].value).toMatchObject({ status: "closed" });
    expect(useWorkspaceListStore.getState().workspaces[0].panes.map(pane => pane.id)).toEqual(["terminal"]); expect(mocks.kill).not.toHaveBeenCalled();
  });

  it("keeps eligible Web navigation forwarding followed by its normal close", async () => {
    await mount("web"); installShell();
    const { deriveWebPaneForwardedShortcuts, dispatchWebPaneKeydown, displayedPaneShortcutSource } = await import("../../src/components/workspace/webPaneShortcuts");
    const input = host.querySelector<HTMLTextAreaElement>("[data-dnd-pane-id='terminal'] .xterm-helper-textarea")!; input.focus();
    const registered = new Set(deriveWebPaneForwardedShortcuts(useKeybindingStore.getState().keybindings));
    expect(registered.has("ctrl+alt+w")).toBe(false); // Native close remains deferred.
    await act(async () => dispatchWebPaneKeydown({ tabId: "preview-tab", key: "PageDown", code: "PageDown", ctrlKey: true, altKey: true,
      shiftKey: false, metaKey: false, repeat: false, isComposing: false, location: 0 }, registered, new Set(["preview-tab"]), id => {
        const source = displayedPaneShortcutSource(id); if (!source) return false;
        useUiStore.getState().setActivePaneId(source.sessionId); return true;
      }));
    expect(useUiStore.getState().activePaneId).toBe("preview-session");
    await closeKey(input); expect(await close.mock.results[0].value).toMatchObject({ status: "closed" });
    expect(useWorkspaceListStore.getState().workspaces[0].panes.map(pane => pane.id)).toEqual(["terminal"]);
  });

  it("accepts a source-activated Web close at the frontend bridge boundary without registering native close", async () => {
    await mount("web"); installShell();
    const { deriveWebPaneForwardedShortcuts, dispatchWebPaneKeydown, displayedPaneShortcutSource } = await import("../../src/components/workspace/webPaneShortcuts");
    expect(deriveWebPaneForwardedShortcuts(useKeybindingStore.getState().keybindings)).not.toContain("ctrl+alt+w");
    // Exercise the frontend close guard's source ordering only. Production's
    // native registration still denies close until privileged input is proven.
    const activate = vi.fn((id: string) => {
      const source = displayedPaneShortcutSource(id); if (!source) return false;
      useUiStore.getState().setActivePaneId(source.sessionId); return true;
    });
    await act(async () => dispatchWebPaneKeydown({ tabId: "preview-tab", key: "w", code: "KeyW", ctrlKey: true, altKey: true,
      shiftKey: false, metaKey: false, repeat: false, isComposing: false, location: 0 }, new Set(["ctrl+alt+w"]), new Set(["preview-tab"]), activate));
    expect(activate).toHaveBeenCalledExactlyOnceWith("preview-tab");
    expect(close).toHaveBeenCalledExactlyOnceWith({ kind: "pane", workspaceId: "workspace", paneId: "preview" }, "ui");
    expect(await close.mock.results[0].value).toMatchObject({ status: "closed" });
    expect(useWorkspaceListStore.getState().workspaces[0].panes.map(pane => pane.id)).toEqual(["terminal"]);
    expect(mocks.kill).not.toHaveBeenCalled();
  });
});

async function key(target: HTMLElement, name: string): Promise<void> {
  await act(async () => target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })));
}
function renameDialog(): HTMLElement { return document.querySelector<HTMLElement>("[role='dialog']")!; }
async function beginRename(): Promise<HTMLElement> {
  const heading = pane().querySelector<HTMLElement>(".pane-active-heading")!;
  heading.focus(); await key(heading, "F2");
  expect(document.activeElement).toBe(renameDialog().querySelector("input"));
  return heading;
}

describe("rename completion preserves pane focus ownership without selecting it", () => {
  it.each(["browser", "web", "online"].flatMap(type => ["Escape", "Enter", "cancel", "save"].map(exit => [type, exit])))
    ("returns focus after %s rename via %s before AppShell close", async (type, exit) => {
      await mount(type as PaneTab["type"]); installShell();
      const heading = await beginRename(); const before = useUiStore.getState();
      const focus = vi.spyOn(focusController, "request");
      if (exit === "cancel" || exit === "save") {
        const buttons = renameDialog().querySelectorAll("button");
        const button = buttons[exit === "save" ? 1 : 0]; button.focus();
        await act(async () => button.click());
      } else await key(renameDialog().querySelector("input")!, exit);
      expect(renameDialog()).toBeNull();
      expect(useUiStore.getState().activePaneId).toBe(before.activePaneId);
      expect(useUiStore.getState().focusRevision).toBe(before.focusRevision); expect(focus).not.toHaveBeenCalled();
      await closeKey(document.activeElement as HTMLElement);
      expect(close).not.toHaveBeenCalled(); expect(mocks.kill).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(heading);
      expect(useWorkspaceListStore.getState().workspaces[0].panes).toHaveLength(2);
    });

  it("returns to the live heading when the invoking list row disappears", async () => {
    await mount("browser", true); installShell();
    const trigger = pane().querySelector<HTMLButtonElement>(".pane-hidden-tabs")!;
    await act(async () => trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1, shiftKey: true })));
    const row = pane().querySelector<HTMLElement>("[data-menu-tab-id='sibling-tab']")!;
    row.focus(); await act(async () => row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 })));
    expect(row.isConnected).toBe(false); await key(renameDialog().querySelector("input")!, "Escape");
    await closeKey(document.activeElement as HTMLElement); expect(close).not.toHaveBeenCalled(); expect(mocks.kill).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(pane().querySelector(".pane-active-heading"));
  });

  it.each(["selection", "other-focus"])("does not overwrite a newer %s when rename ends", async newer => {
    await mount(); await beginRename(); const input = renameDialog().querySelector<HTMLInputElement>("input")!;
    const next = host.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")!;
    if (newer === "selection") useUiStore.getState().bumpFocusRevision();
    next.focus(); await key(input, "Escape"); expect(document.activeElement).toBe(next);
  });

  it("does not return focus to a removed pane", async () => {
    await mount(); const heading = await beginRename();
    const focus = vi.spyOn(heading, "focus");
    await act(async () => useWorkspaceListStore.setState(state => ({ workspaces: state.workspaces.map(ws => ({ ...ws, panes: ws.panes.filter(p => p.id !== "preview") })) })));
    expect(renameDialog()).toBeNull(); expect(focus).not.toHaveBeenCalled();
  });

  it("keeps the returned heading alive across a committed label update", async () => {
    await mount(); const heading = await beginRename(); const input = renameDialog().querySelector<HTMLInputElement>("input")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setValue.call(input, "Renamed"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await key(input, "Enter");
    expect(pane().querySelector(".pane-active-heading")).toBe(heading);
    expect(document.activeElement).toBe(heading); expect(heading.isConnected).toBe(true);
    expect(useWorkspaceListStore.getState().workspaces[0].panes[1].tabs[0].label).toBe("Renamed");
  });
});

async function openModifiedList(modifier: "shiftKey" | "ctrlKey" = "shiftKey"): Promise<HTMLButtonElement> {
  const trigger = pane().querySelector<HTMLButtonElement>(".pane-hidden-tabs")!;
  await pointer(trigger, "down", { [modifier]: true }); trigger.focus();
  await pointer(trigger, "up", { [modifier]: true });
  await act(async () => trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1, [modifier]: true })));
  expect(useUiStore.getState().activePaneId).toBe("terminal-session");
  return trigger;
}
describe("hidden-tab list dismissal returns only its own keyboard focus", () => {
  it.each(["shiftKey", "ctrlKey"] as const)("contains %s pointer open, row focus, Escape, AppShell close", async modifier => {
    await mount("browser", true); installShell(); const trigger = await openModifiedList(modifier);
    const row = pane().querySelector<HTMLElement>("[data-menu-tab-id='sibling-tab']")!;
    row.focus(); const before = useUiStore.getState(); const focus = vi.spyOn(focusController, "request");
    await key(row, "Escape"); expect(row.isConnected).toBe(false);
    await closeKey(document.activeElement as HTMLElement);
    expect(close).not.toHaveBeenCalled(); expect(mocks.kill).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger); expect(focus).not.toHaveBeenCalled();
    expect(useUiStore.getState().activePaneId).toBe(before.activePaneId); expect(useUiStore.getState().focusRevision).toBe(before.focusRevision);
  });
  it("does not take focus back after an outside pointer dismissal", async () => {
    await mount("browser", true); const trigger = await openModifiedList();
    pane().querySelector<HTMLElement>("[data-menu-tab-id='sibling-tab']")!.focus();
    const outside = document.createElement("button"); host.append(outside);
    await act(async () => outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))); outside.focus();
    expect(pane().querySelector("[data-menu-tab-id]")).toBeNull(); expect(document.activeElement).toBe(outside);
    expect(trigger.isConnected).toBe(true);
  });
  it.each(["selection", "focus"])("does not overwrite a newer %s on Escape", async newer => {
    await mount("browser", true); await openModifiedList();
    const row = pane().querySelector<HTMLElement>("[data-menu-tab-id='sibling-tab']")!; row.focus();
    const input = host.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")!;
    if (newer === "selection") useUiStore.getState().bumpFocusRevision();
    input.focus(); await key(row, "Escape"); expect(document.activeElement).toBe(input);
  });
});
it("does not restore rename's old focus after a newer selection with no DOM focus move", async () => {
  await mount(); const heading = await beginRename(); const focus = vi.spyOn(heading, "focus");
  useUiStore.getState().bumpFocusRevision(); await key(renameDialog().querySelector("input")!, "Escape");
  expect(focus).not.toHaveBeenCalled(); expect(document.activeElement).toBe(document.body);
});
it("does not restore the list's old trigger after a newer selection with no DOM focus move", async () => {
  await mount("browser", true); const trigger = await openModifiedList(); const focus = vi.spyOn(trigger, "focus");
  const row = pane().querySelector<HTMLElement>("[data-menu-tab-id='sibling-tab']")!; row.focus();
  useUiStore.getState().bumpFocusRevision(); await key(row, "Escape");
  expect(focus).not.toHaveBeenCalled(); expect(document.activeElement).toBe(document.body);
});

async function losePreviewFocus(): Promise<void> {
  const temporary = document.createElement("button"); pane().append(temporary); temporary.focus(); temporary.remove();
  expect(document.activeElement).toBe(document.body);
}
describe("AppShell last pane focus fallback only supplements a body source", () => {
  it.each(["rename", "list"])("contains the actual %s Escape flow even without J1/J2 restoration", async part => {
    await mount("browser", true); installShell();
    if (part === "rename") {
      await beginRename(); const dialog = renameDialog(); const input = dialog.querySelector<HTMLInputElement>("input")!;
      await key(input, "Escape");
    } else {
      await openModifiedList(); const row = pane().querySelector<HTMLElement>("[data-menu-tab-id='sibling-tab']")!; row.focus(); await key(row, "Escape");
    }
    if (process.env.U6_FOCUS_RETURN_OFF === "1") expect(document.activeElement).toBe(document.body);
    else expect(pane().contains(document.activeElement)).toBe(true);
    const before = useUiStore.getState(); const focus = vi.spyOn(focusController, "request");
    await closeKey(document.activeElement as HTMLElement);
    expect(close).not.toHaveBeenCalled(); expect(mocks.kill).not.toHaveBeenCalled(); expect(focus).not.toHaveBeenCalled();
    expect(useUiStore.getState().activePaneId).toBe(before.activePaneId); expect(useUiStore.getState().focusRevision).toBe(before.focusRevision);
  });
  it("keeps rename portal focus owned by its live workspace and pane", async () => {
    await mount(); installShell(); await beginRename();
    expect(tracking!.memory.current).toEqual({ workspaceId: "workspace", paneId: "preview" });
    expect(renameDialog().dataset.paneFocusWorkspaceId).toBe("workspace"); expect(renameDialog().dataset.paneFocusPaneId).toBe("preview");
  });
  it("contains a temporary pane control that disappeared without restoring focus", async () => {
    await mount(); installShell(); await losePreviewFocus(); const before = useUiStore.getState();
    await closeKey(document.body); expect(close).not.toHaveBeenCalled(); expect(mocks.kill).not.toHaveBeenCalled();
    expect(useUiStore.getState().focusRevision).toBe(before.focusRevision);
  });
  it.each(["pointer", "input", "button"])("forgets pane focus after an outside %s before a body close", async kind => {
    await mount(); installShell(); await losePreviewFocus();
    const outside = kind === "input" ? document.createElement("input") : document.createElement("button"); host.append(outside);
    if (kind === "pointer") await pointer(outside, "down"); else { outside.focus(); outside.remove(); }
    await closeKey(document.body); expect(await close.mock.results[0].value).toMatchObject({ status: "closed" });
    expect(mocks.kill).toHaveBeenCalledExactlyOnceWith("terminal-session");
  });
  it("does not use a remembered removed pane", async () => {
    await mount(); installShell(); await losePreviewFocus();
    await act(async () => useWorkspaceListStore.setState(state => ({ workspaces: state.workspaces.map(ws => ({ ...ws,
      panes: [ws.panes[0], { ...ws.panes[1], id: "replacement", sessionId: "replacement-session", tabs: [{ ...ws.panes[1].tabs[0], sessionId: "replacement-session", id: "replacement-tab" }], activeTabId: "replacement-tab" }],
    })) })));
    await closeKey(document.body); expect(close).toHaveBeenCalledOnce(); expect(mocks.kill).toHaveBeenCalledExactlyOnceWith("terminal-session");
  });
  it("does not use a remembered background workspace", async () => {
    await mount(); installShell(); await losePreviewFocus();
    const old = useWorkspaceListStore.getState().workspaces[0];
    const foreground: Workspace = { ...old, id: "foreground", panes: old.panes.map(p => ({ ...p, id: `front-${p.id}`,
      sessionId: `front-${p.sessionId}`, tabs: p.tabs.map(t => ({ ...t, id: `front-${t.id}`, sessionId: `front-${t.sessionId}` })), activeTabId: `front-${p.activeTabId}` })) };
    await act(async () => { useWorkspaceListStore.setState({ workspaces: [old, foreground], activeWorkspaceId: foreground.id }); useUiStore.getState().setActivePaneId("front-terminal-session"); });
    await closeKey(document.body); expect(close).toHaveBeenCalledExactlyOnceWith({ kind: "pane", workspaceId: "foreground", paneId: "front-terminal" }, "ui");
  });
  it("does not borrow a remembered pane while a live outside element has focus", async () => {
    await mount(); installShell(); await losePreviewFocus(); const outside = document.createElement("button"); host.append(outside); outside.focus();
    // Even a stale remembered owner cannot override H1's outside-element path.
    tracking!.memory.current = { workspaceId: "workspace", paneId: "preview" };
    await closeKey(document.body); expect(close).toHaveBeenCalledOnce(); expect(mocks.kill).toHaveBeenCalledExactlyOnceWith("terminal-session");
  });
  it("scopes each focus tracker to its own document and supplied live workspace", async () => {
    await mount(); installShell(); await losePreviewFocus();
    const frame = document.createElement("iframe"); host.append(frame); const doc = frame.contentDocument!;
    doc.body.innerHTML = `<div data-dnd-workspace-id="child" data-dnd-pane-id="child-pane"><button>Child</button></div>`;
    const child = trackAppShellPaneFocus(() => ({ id: "child", panes: [{ id: "child-pane" }] }), doc);
    try {
      const button = doc.querySelector<HTMLButtonElement>("button")!; button.focus();
      expect(child.memory.current).toEqual({ workspaceId: "child", paneId: "child-pane" });
      expect(tracking!.memory.current?.paneId).not.toBe("child-pane");
      doc.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); expect(child.memory.current).toBeNull();
    } finally { child.dispose(); frame.remove(); }
  });
});
