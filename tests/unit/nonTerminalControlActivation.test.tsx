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
import { onlineStrings } from "../../src/components/online/onlineStrings";
import { terminalPaneStrings } from "../../src/components/workspace/terminalPaneStrings";
import { makeAppShellKeydown } from "./fixtures/appShellKeydown";

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
vi.mock("../../src/components/terminal/XTermWrapper", () => ({ default: () => <textarea className="xterm-helper-textarea" />, hasTerminalBuffer: () => false }));
import TerminalPane from "../../src/components/workspace/TerminalPane";

let root: Root;
let host: HTMLDivElement;
let handler: ((event: KeyboardEvent) => void) | undefined;
const close = vi.fn(closePaneOperation);
const split = vi.fn();
function Harness() {
  const workspace = useWorkspaceListStore(state => state.workspaces[0]);
  return <>{workspace.panes.map(pane => <TerminalPane key={pane.id} pane={pane} workspaceId={workspace.id}
    onSplitRight={() => split(pane.id)}
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
  handler = makeAppShellKeydown({ current: { workspaces: useWorkspaceListStore.getState().workspaces,
    activeId: "workspace", activePaneId: "terminal-session", lastActivePaneId: "terminal-session",
    isKeybindingsOpen: false, isCrsmPaletteOpen: false, dashboardOpen: false } }, useWorkspaceListStore, useUiStore,
  useKeybindingStore.getState().getActionsForEvent, isEditableTarget, close, focusController,
  useWorkspaceLayoutStore.getState().setActivePaneTab, () => "terminal-session");
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
async function click(target: HTMLElement): Promise<void> {
  await pointer(target, "down"); target.focus(); await pointer(target, "up");
  await act(async () => target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 })));
}
async function keyboardClick(target: HTMLElement, key = "Enter"): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
    // jsdom doesn't synthesize a click from Enter/Space. Deliver the native
    // keyboard-click shape after the real key sequence on the focused control.
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 }));
  });
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
  host = document.createElement("div"); host.dataset.cmuxThemedRoot = "true"; document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  if (handler) window.removeEventListener("keydown", handler); handler = undefined;
  await act(async () => root.unmount()); host.remove();
  resetPaneCloseOperationsForTests(); focusController.clearSession("terminal-session");
  window.getSelection()?.removeAllRanges(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe("non-terminal content controls claim their pane without taking focus", () => {
  it.each(["browser", "web", "online"] as const)("claims the actual %s name context menu before Escape and AppShell close", async type => {
    await mount(type); installShell();
    const heading = pane().querySelector<HTMLElement>(".pane-active-heading")!;
    const focus = vi.spyOn(focusController, "request");
    await pointer(heading, "down", { button: 2 }); await pointer(heading, "up", { button: 2 });
    await act(async () => heading.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 })));
    const menu = document.querySelector<HTMLElement>("[role='menu']")!;
    expect(menu).not.toBeNull(); expect(useUiStore.getState().activePaneId).toBe("preview-session");
    await act(async () => menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(document.querySelector("[role='menu']")).toBeNull(); expect(document.activeElement).toBe(heading);
    expect(focus).not.toHaveBeenCalled();
    await closeKey(heading); expect(await close.mock.results[0].value).toMatchObject({ status: "closed" });
    expect(useWorkspaceListStore.getState().workspaces[0].panes.map(pane => pane.id)).toEqual(["terminal"]);
    expect(mocks.kill).not.toHaveBeenCalled();
  });

  it.each(["ContextMenu", "F10"])("selects the displayed non-terminal through the %s keyboard menu", async key => {
    await mount(); const heading = pane().querySelector<HTMLElement>(".pane-active-heading")!;
    const focus = vi.spyOn(focusController, "request");
    heading.focus(); expect(useUiStore.getState().activePaneId).toBe("terminal-session");
    await act(async () => heading.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey: key === "F10", bubbles: true, cancelable: true })));
    expect(document.querySelector("[role='menu']")).not.toBeNull();
    expect(useUiStore.getState().activePaneId).toBe("preview-session"); expect(focus).not.toHaveBeenCalled();
  });

  it.each(["terminal", "modified"])("preserves %s name-menu activation policy", async mode => {
    await mount(mode === "terminal" ? "terminal" : "browser");
    const heading = pane().querySelector<HTMLElement>(".pane-active-heading")!;
    const focus = vi.spyOn(focusController, "request");
    await act(async () => heading.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true,
      button: 2, ctrlKey: mode === "modified" })));
    expect(document.querySelector("[role='menu']")).not.toBeNull();
    expect(useUiStore.getState().activePaneId).toBe("terminal-session"); expect(focus).not.toHaveBeenCalled();
  });

  it.each(["Enter", " "])("claims keyboard maximize with %s before AppShell closes P and preserves hidden T", async key => {
    await mount(); installShell();
    const button = pane().querySelector<HTMLButtonElement>(".pane-tabbar-zoom")!;
    await act(async () => button.focus());
    expect(useUiStore.getState().activePaneId).toBe("terminal-session");
    await keyboardClick(button, key); await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(useUiStore.getState().zoomedPaneId).toBe("preview");
    expect(useUiStore.getState().activePaneId).toBe("preview-session"); expect(document.activeElement).toBe(button);
    await closeKey(button); expect(await close.mock.results[0].value).toMatchObject({ status: "closed" });
    expect(close).toHaveBeenCalledExactlyOnceWith({ kind: "pane", workspaceId: "workspace", paneId: "preview" }, "ui");
    expect(useWorkspaceListStore.getState().workspaces[0].panes.map(pane => pane.id)).toEqual(["terminal"]);
    expect(mocks.kill).not.toHaveBeenCalled();
  });

  it.each(["menu", "hidden"])("claims the keyboard %s control before opening and dismissing it", async control => {
    await mount("browser", true);
    const button = pane().querySelector<HTMLButtonElement>(control === "menu"
      ? `button[aria-label='${terminalPaneStrings.paneActions}']` : ".pane-hidden-tabs")!;
    await act(async () => button.focus()); expect(useUiStore.getState().activePaneId).toBe("terminal-session");
    await keyboardClick(button);
    const menu = host.querySelector<HTMLElement>("[role='menu']")!; expect(menu).not.toBeNull();
    expect(useUiStore.getState().activePaneId).toBe("preview-session");
    await act(async () => menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(host.querySelector("[role='menu']")).toBeNull();
    expect(useUiStore.getState().activePaneId).toBe("preview-session");
  });

  it.each(["browser-button", "online-button", "online-link"])("claims a keyboard %s before its own action", async kind => {
    await mount(kind === "browser-button" ? "browser" : "online");
    let target: HTMLElement;
    if (kind === "browser-button") {
      target = pane().querySelector(`button[aria-label='${artifactEditorStrings.showLocation}']`)!;
      mocks.reveal.mockImplementation(() => { expect(useUiStore.getState().activePaneId).toBe("preview-session"); return Promise.resolve(); });
    } else if (kind === "online-button") target = pane().querySelector(`button[aria-label='${onlineStrings.refresh}']`)!;
    else {
      const link = document.createElement("a"); link.href = "#details"; link.textContent = "Details";
      pane().querySelector(".online-savepoint-list")!.append(link); target = link;
    }
    await act(async () => target.focus()); expect(useUiStore.getState().activePaneId).toBe("terminal-session");
    await keyboardClick(target);
    expect(useUiStore.getState().activePaneId).toBe("preview-session"); expect(document.activeElement).toBe(target);
    if (kind === "browser-button") expect(mocks.reveal).toHaveBeenCalledOnce();
  });

  it.each(["modifier", "drag", "selection"])("does not turn a rejected mouse %s into activation on click", async kind => {
    await mount("online"); const button = pane().querySelector<HTMLButtonElement>(`button[aria-label='${onlineStrings.refresh}']`)!;
    const options = kind === "modifier" ? { ctrlKey: true } : {};
    await pointer(button, "down", options);
    if (kind === "selection") {
      const range = document.createRange(); range.selectNodeContents(button); window.getSelection()!.addRange(range);
    }
    await pointer(button, "up", kind === "drag" ? { clientX: 26 } : options);
    await act(async () => button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1, ...options })));
    expect(useUiStore.getState().activePaneId).toBe("terminal-session");
  });

  it.each(["menu", "hidden", "zoom"])("preserves terminal keyboard %s activation behavior", async control => {
    await mount("terminal", true);
    const button = pane().querySelector<HTMLButtonElement>(control === "menu"
      ? `button[aria-label='${terminalPaneStrings.paneActions}']` : control === "hidden" ? ".pane-hidden-tabs" : ".pane-tabbar-zoom")!;
    button.focus(); await keyboardClick(button); await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(useUiStore.getState().activePaneId).toBe("terminal-session");
    expect(document.activeElement).not.toBe(pane().querySelector("textarea"));
  });

  it.each([".pane-heading-spacer", ".pane-tabbar"])("claims a plain click on the real %s before AppShell close", async selector => {
    await mount(); installShell();
    const outside = document.createElement("button"); host.prepend(outside); outside.focus();
    const target = pane().querySelector<HTMLElement>(selector)!;
    await pointer(target, "down"); await pointer(target, "up");
    expect(useUiStore.getState().activePaneId).toBe("preview-session"); expect(document.activeElement).toBe(outside);
    await closeKey(outside);
    expect(await close.mock.results[0].value).toMatchObject({ status: "closed" });
    expect(close).toHaveBeenCalledExactlyOnceWith({ kind: "pane", workspaceId: "workspace", paneId: "preview" }, "ui");
    expect(useWorkspaceListStore.getState().workspaces[0].panes.map(pane => pane.id)).toEqual(["terminal"]);
    expect(mocks.kill).not.toHaveBeenCalled();
  });

  it.each(["shiftKey", "altKey", "ctrlKey", "metaKey", "drag", "selection", "cancel", "right"])(
    "preserves the blank-heading %s exclusion", async kind => {
      await mount(); const target = pane().querySelector<HTMLElement>(".pane-heading-spacer")!;
      const options = kind.endsWith("Key") ? { [kind]: true } : kind === "right" ? { button: 2 } : {};
      await pointer(target, "down", options);
      if (kind === "selection") {
        const range = document.createRange(); range.selectNodeContents(pane().querySelector(".pane-active-heading-name")!);
        window.getSelection()!.addRange(range); expect(window.getSelection()!.toString()).not.toBe("");
      }
      if (kind === "cancel") await pointer(target, "cancel");
      await pointer(target, "up", kind === "drag" ? { clientX: 26 } : options);
      expect(useUiStore.getState().activePaneId).toBe("terminal-session");
    },
  );

  it("keeps rename dialog pointer gestures out of pane activation", async () => {
    await mount();
    await act(async () => pane().querySelector<HTMLElement>(".pane-active-heading")!.dispatchEvent(
      new MouseEvent("dblclick", { bubbles: true, detail: 2 })));
    const input = document.querySelector<HTMLElement>("[data-pane-tab-rename-input]")!;
    expect(input).not.toBeNull(); await pointer(input, "down"); await pointer(input, "up");
    expect(useUiStore.getState().activePaneId).toBe("terminal-session"); expect(document.activeElement).toBe(input);
  });

  it("activates from the real BrowserPane toolbar before AppShell closes the preview and leaves the terminal", async () => {
    await mount();
    installShell();
    const button = pane().querySelector<HTMLButtonElement>(`button[aria-label='${artifactEditorStrings.showLocation}']`)!;
    expect(button).not.toBeNull(); await click(button);
    expect(mocks.reveal).toHaveBeenCalledExactlyOnceWith("/preview.md"); expect(document.activeElement).toBe(button);
    expect(useUiStore.getState().activePaneId).toBe("preview-session");
    await closeKey(button);
    expect(close).toHaveBeenCalledExactlyOnceWith({ kind: "pane", workspaceId: "workspace", paneId: "preview" }, "ui");
    expect(await close.mock.results[0].value).toMatchObject({ status: "closed" });
    expect(useWorkspaceListStore.getState().workspaces[0].panes.map(pane => pane.id)).toEqual(["terminal"]);
    expect(mocks.kill).not.toHaveBeenCalled();
  });

  it.each(["button", "link", "search"])("activates from the actual OnlinePanel's %s without moving its focus", async kind => {
    await mount("online");
    let target: HTMLElement;
    if (kind === "search") target = pane().querySelector("input[type='search']")!;
    else if (kind === "button") target = pane().querySelector(`button[aria-label='${onlineStrings.refresh}']`)!;
    else {
      // Online has no static anchor today; use its real content root to exercise
      // the same capture path for a document link added by content.
      const link = document.createElement("a"); link.href = "#details"; link.textContent = "Details";
      pane().querySelector(".online-savepoint-list")!.append(link); target = link;
    }
    await click(target); await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(useUiStore.getState().activePaneId).toBe("preview-session"); expect(document.activeElement).toBe(target);
  });

  it.each(["modifier", "drag", "selection", "right"])("ignores an Online button gesture with %s", async kind => {
    await mount("online");
    const target = pane().querySelector<HTMLButtonElement>(`button[aria-label='${onlineStrings.refresh}']`)!;
    const options = kind === "modifier" ? { ctrlKey: true } : kind === "right" ? { button: 2 } : {};
    await pointer(target, "down", options);
    if (kind === "selection") {
      const range = document.createRange(); range.selectNodeContents(target); window.getSelection()!.addRange(range);
      expect(window.getSelection()!.toString()).toBe(onlineStrings.refresh);
    }
    await pointer(target, "up", kind === "drag" ? { clientX: 26 } : options);
    expect(useUiStore.getState().activePaneId).toBe("terminal-session");
  });

  it("keeps terminal content buttons excluded from xterm activation and focus", async () => {
    await mount();
    const button = document.createElement("button"); button.textContent = "Action";
    host.querySelector("[data-dnd-pane-id='terminal'] [data-retained-terminal]")!.append(button);
    const focus = vi.spyOn(focusController, "request");
    await act(async () => useUiStore.getState().setActivePaneId("unrelated-session"));
    await click(button); await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(document.activeElement).toBe(button); expect(useUiStore.getState().activePaneId).toBe("unrelated-session");
    expect(focus).not.toHaveBeenCalled();
  });

  it.each(["menu", "hidden", "zoom", "split"])("activates before the %s heading control while preserving its operation", async control => {
    await mount("browser", true);
    const selector = control === "menu" ? `button[aria-label='${terminalPaneStrings.paneActions}']`
      : control === "hidden" ? ".pane-hidden-tabs" : control === "split" ? ".pane-tabbar-split" : ".pane-tabbar-zoom";
    const button = pane().querySelector<HTMLButtonElement>(selector)!;
    expect(button).not.toBeNull();
    await pointer(button, "down"); button.focus(); await pointer(button, "up");
    expect(useUiStore.getState().activePaneId).toBe("preview-session"); expect(document.activeElement).toBe(button);
    await act(async () => button.click());
    if (control === "menu") expect(host.querySelector(".pane-actions-menu")).not.toBeNull();
    if (control === "hidden") {
      await act(async () => host.querySelector<HTMLElement>("[data-menu-tab-id='sibling-tab']")!.click());
      expect(useUiStore.getState().activePaneId).toBe("sibling-session");
      expect(useWorkspaceListStore.getState().workspaces[0].panes[1].activeTabId).toBe("sibling-tab");
    }
    if (control === "zoom") expect(useUiStore.getState().zoomedPaneId).toBe("preview");
    if (control === "split") expect(split).toHaveBeenCalledExactlyOnceWith("preview");
  });

  it.each(["menu", "zoom"])("closes the displayed preview through AppShell after the %s action", async control => {
    await mount(); installShell();
    const button = pane().querySelector<HTMLButtonElement>(control === "menu"
      ? `button[aria-label='${terminalPaneStrings.paneActions}']` : ".pane-tabbar-zoom")!;
    await click(button);
    if (control === "menu") {
      await act(async () => host.querySelector<HTMLElement>(".pane-actions-menu")!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
      expect(host.querySelector(".pane-actions-menu")).toBeNull();
    }
    await closeKey(button);
    expect(close).toHaveBeenCalledExactlyOnceWith({ kind: "pane", workspaceId: "workspace", paneId: "preview" }, "ui");
    expect(await close.mock.results[0].value).toMatchObject({ status: "closed" });
    expect(useWorkspaceListStore.getState().workspaces[0].panes.map(pane => pane.id)).toEqual(["terminal"]);
    expect(mocks.kill).not.toHaveBeenCalled();
  });

  it("keeps the displayed preview active when the hidden-tab list is dismissed without selection", async () => {
    await mount("browser", true);
    const button = pane().querySelector<HTMLButtonElement>(".pane-hidden-tabs")!;
    await click(button);
    await act(async () => host.querySelector<HTMLElement>("[role='menu']")!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(host.querySelector("[role='menu']")).toBeNull();
    expect(useUiStore.getState().activePaneId).toBe("preview-session");
    expect(useWorkspaceListStore.getState().workspaces[0].panes[1].activeTabId).toBe("preview-tab");
  });

  it("leaves the close button's activation behavior and displayed-tab-only close unchanged", async () => {
    await mount("browser", true);
    const button = pane().querySelector<HTMLButtonElement>(".pane-header-close")!;
    await pointer(button, "down"); button.focus(); await pointer(button, "up");
    expect(useUiStore.getState().activePaneId).toBe("terminal-session");
    await act(async () => button.click());
    expect(useWorkspaceListStore.getState().workspaces[0].panes[1].tabs.map(tab => tab.id)).toEqual(["sibling-tab"]);
    expect(useWorkspaceListStore.getState().workspaces[0].panes[0].tabs[0].id).toBe("terminal-tab");
    expect(mocks.kill).not.toHaveBeenCalled();
  });

  it("closes the whole place from the right-edge × without activating it first", async () => {
    await mount("browser", true);
    const button = pane().querySelector<HTMLButtonElement>(".pane-place-close")!;
    await pointer(button, "down"); button.focus(); await pointer(button, "up");
    expect(useUiStore.getState().activePaneId).toBe("terminal-session");
    await act(async () => button.click());
    await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(useWorkspaceListStore.getState().workspaces[0].panes.map(pane => pane.id)).toEqual(["terminal"]);
  });

  it.each(["menu", "hidden", "zoom"])("leaves a terminal heading's %s activation behavior unchanged", async control => {
    await mount("terminal", true);
    await act(async () => useUiStore.getState().setActivePaneId("terminal-session"));
    const button = pane().querySelector<HTMLButtonElement>(control === "menu"
      ? `button[aria-label='${terminalPaneStrings.paneActions}']` : control === "hidden" ? ".pane-hidden-tabs" : ".pane-tabbar-zoom")!;
    const focus = vi.spyOn(focusController, "request");
    await click(button); await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(useUiStore.getState().activePaneId).toBe("terminal-session");
    expect(document.activeElement).not.toBe(pane().querySelector("textarea"));
    if (control === "menu") expect(host.querySelector("[role='menu']")?.contains(document.activeElement)).toBe(true);
    else expect(document.activeElement).toBe(button);
    expect(focus).not.toHaveBeenCalled();
  });
});
