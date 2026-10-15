// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pane, PaneTab, Workspace } from "../../src/types";
import { focusController } from "../../src/lib/focusController";
import { useUiStore } from "../../src/stores/uiStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import { useKeybindingStore } from "../../src/stores/keybindingStore";
import { isEditableTarget } from "../../src/lib/keybindings";
import { closePaneOperation, resetPaneCloseOperationsForTests } from "../../src/lib/paneCloseOperation";
import { makeAppShellKeydown } from "./fixtures/appShellKeydown";
import { crsmListSessions, onSavepointPublishProgress } from "../../src/lib/ipc";

vi.mock("../../src/lib/ipc");
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null), isTauri: () => false, Channel: class {} }));
vi.mock("../../src/lib/paneCloseConfirmation", () => ({ confirmPaneClose: vi.fn().mockResolvedValue(true) }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));
vi.mock("../../src/hooks/usePaneDragSource", () => ({
  usePaneDragSource: () => ({ beginPointerDrag: vi.fn(), shouldSuppressClick: () => false }),
}));
vi.mock("../../src/components/workspace/BrowserPane", () => ({ default: () => <div data-test-content="true" /> }));
vi.mock("../../src/components/workspace/WebPaneStatusBar", () => ({ default: () => null }));
vi.mock("../../src/components/online/OnlinePanel", () => ({ default: () => <div data-test-content="true" /> }));
vi.mock("../../src/components/composer/PaneComposer", () => ({ PaneComposer: () => null }));
vi.mock("../../src/components/terminal/XTermWrapper", () => ({
  default: ({ sessionId }: { sessionId: string }) => <div data-test-content="true" data-xterm-session={sessionId}>
    <textarea className="xterm-helper-textarea" />
  </div>,
  hasTerminalBuffer: () => false,
}));
import TerminalPane from "../../src/components/workspace/TerminalPane";

const nonTerminalTypes = ["browser", "web", "online"] as const;
const previousSessionId = "previous-session";
let container: HTMLDivElement;
let root: Root;
let focusedInput: HTMLTextAreaElement;
let handler: ((event: KeyboardEvent) => void) | undefined;
const close = vi.fn(closePaneOperation);

function tab(type: PaneTab["type"]): PaneTab {
  return { id: "target-tab", sessionId: "target-session", agentId: "shell-starter", type,
    label: "Target", htmlPath: "/synthetic/preview.html", presetId: "chatgpt" };
}

function Harness() {
  const workspace = useWorkspaceListStore(state => state.workspaces[0]);
  return <>{workspace.panes.map(pane => <TerminalPane key={pane.id} pane={pane} workspaceId={workspace.id} />)}</>;
}

async function renderPane(type: PaneTab["type"], options: { sibling?: PaneTab; background?: boolean; neighbor?: boolean; overrides?: Partial<PaneTab> } = {}): Promise<void> {
  const activeTab = { ...tab(type), ...options.overrides };
  const pane: Pane = { id: "target-pane", agentId: "shell-starter", sessionId: activeTab.sessionId,
    activeTabId: activeTab.id, tabs: [activeTab, ...(options.sibling ? [options.sibling] : [])] };
  const workspace: Workspace = { id: "workspace", name: "Synthetic", gridTemplateId: "1x1", createdAt: 1,
    status: "running", panes: [pane, ...(options.neighbor ? [{ ...pane, id: "previous-pane", sessionId: previousSessionId,
      activeTabId: "previous-tab", tabs: [{ ...tab("terminal"), id: "previous-tab", sessionId: previousSessionId }] }] : [])],
    splitColumns: [[pane.id], ...(options.neighbor ? [["previous-pane"]] : [])] };
  useWorkspaceListStore.setState({ workspaces: [workspace], activeWorkspaceId: options.background ? "other-workspace" : workspace.id,
    lastActivePaneByWorkspace: {} });
  await act(async () => root.render(<Harness />));
}

function content(): HTMLElement {
  return container.querySelector<HTMLElement>("[data-test-content], [data-web-pane-host-tab-id]")!;
}

async function pointer(target: HTMLElement, phase: "down" | "up" | "cancel", options: MouseEventInit = {}, pointerId = 7): Promise<void> {
  const event = new MouseEvent(`pointer${phase}`, { bubbles: true, cancelable: true, button: 0,
    clientX: 20, clientY: 30, ...options });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  await act(async () => target.dispatchEvent(event));
}

async function settleFocus(): Promise<void> {
  await act(async () => vi.runAllTimersAsync());
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  focusController.request("tab-rename", { suppressMs: 0 });
  vi.spyOn(focusController, "request");
  useSettingsStore.setState({ paneComposerEnabled: false, showTerminalHistoryButton: false, declaredLaunchEnabled: true });
  useKeybindingStore.getState().resetAll(); resetPaneCloseOperationsForTests(); close.mockClear();
  vi.mocked(onSavepointPublishProgress).mockResolvedValue(() => {});
  vi.mocked(crsmListSessions).mockResolvedValue([]);
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {} });
  useUiStore.setState({ activePaneId: previousSessionId, lastActivePaneId: previousSessionId, focusRevision: 0,
    zoomedPaneId: null });
  container = document.createElement("div"); container.dataset.cmuxThemedRoot = "true"; document.body.appendChild(container); root = createRoot(container);
  focusedInput = document.createElement("textarea"); document.body.appendChild(focusedInput); focusedInput.focus();
});

afterEach(async () => {
  if (handler) window.removeEventListener("keydown", handler);
  handler = undefined;
  await act(async () => root.unmount());
  container.remove(); focusedInput.remove();
  focusController.clearSession("target-session");
  focusController.clearSession(previousSessionId); resetPaneCloseOperationsForTests();
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe("non-terminal pane pointer activation", () => {
  it.each(nonTerminalTypes)("activates a %s tab after a plain click without moving keyboard focus", async type => {
    await renderPane(type);
    await pointer(content(), "down");
    expect(useUiStore.getState().activePaneId).toBe(previousSessionId);
    await pointer(content(), "up", { clientX: 23, clientY: 32 });
    await settleFocus();
    expect(useUiStore.getState().activePaneId).toBe("target-session");
    expect(document.activeElement).toBe(focusedInput);
    expect(focusController.request).not.toHaveBeenCalled();
    expect(container.querySelector("[data-active-pane='true']")?.getAttribute("data-dnd-pane-id")).toBe("target-pane");
  });

  it.each(nonTerminalTypes)("activates a %s tab after a right click without moving keyboard focus", async type => {
    await renderPane(type);
    await pointer(content(), "down", { button: 2 });
    expect(useUiStore.getState().activePaneId).toBe(previousSessionId);
    await pointer(content(), "up", { button: 2 });
    await settleFocus();
    expect(useUiStore.getState().activePaneId).toBe("target-session");
    expect(document.activeElement).toBe(focusedInput);
    expect(focusController.request).not.toHaveBeenCalled();
  });

  it.each(["shiftKey", "altKey", "ctrlKey", "metaKey"] as const)("ignores %s on either end of the click", async modifier => {
    await renderPane("browser");
    await pointer(content(), "down", { [modifier]: true }); await pointer(content(), "up");
    expect(useUiStore.getState().activePaneId).toBe(previousSessionId);
    await pointer(content(), "down"); await pointer(content(), "up", { [modifier]: true });
    await settleFocus();
    expect(useUiStore.getState().activePaneId).toBe(previousSessionId);
    expect(document.activeElement).toBe(focusedInput);
    expect(focusController.request).not.toHaveBeenCalled();
  });

  it.each(["iframe", "composer", "transcript", "drag-handle"])(
    "keeps the structural %s target excluded", async kind => {
      await renderPane("browser");
      const target = document.createElement(["editable", "composer", "transcript", "drag-handle"].includes(kind) ? "div" : kind);
      if (kind === "editable") target.setAttribute("contenteditable", "true");
      if (kind === "composer") target.setAttribute("data-composer-session", "target-session");
      if (kind === "transcript") target.setAttribute("data-terminal-transcript-panel", "true");
      if (kind === "drag-handle") target.setAttribute("data-pane-drag-handle", "true");
      content().appendChild(target);
      await pointer(target, "down"); await pointer(target, "up"); await settleFocus();
      expect(useUiStore.getState().activePaneId).toBe(previousSessionId);
      expect(focusController.request).not.toHaveBeenCalled();
    },
  );

  it.each(["button", "a", "input", "textarea", "select", "editable"])("activates a non-terminal interactive %s target without terminal focus", async kind => {
    await renderPane("browser");
    const target = document.createElement(kind === "editable" ? "div" : kind);
    if (kind === "editable") target.setAttribute("contenteditable", "true");
    content().appendChild(target);
    await pointer(target, "down"); await pointer(target, "up"); await settleFocus();
    expect(useUiStore.getState().activePaneId).toBe("target-session");
    expect(document.activeElement).toBe(focusedInput); expect(focusController.request).not.toHaveBeenCalled();
  });

  it.each([0, 2])("ignores a drag and changed text selection for button %i", async button => {
    await renderPane("online");
    await pointer(content(), "down", { button }); await pointer(content(), "up", { button, clientX: 26 });
    expect(useUiStore.getState().activePaneId).toBe(previousSessionId);
    const text = document.createTextNode("selected text"); content().appendChild(text);
    focusedInput.blur();
    await pointer(content(), "down", { button });
    const range = document.createRange(); range.selectNodeContents(text); window.getSelection()!.addRange(range);
    expect(window.getSelection()!.toString()).toBe("selected text");
    await pointer(content(), "up", { button }); await settleFocus();
    expect(useUiStore.getState().activePaneId).toBe(previousSessionId);
    expect(document.activeElement).toBe(document.body);
    expect(focusController.request).not.toHaveBeenCalled();
  });

  it("accepts an unchanged selection and ignores cancellation, middle click, and mismatched pointer IDs", async () => {
    await renderPane("web");
    await pointer(content(), "down"); await pointer(content(), "cancel"); await pointer(content(), "up");
    await pointer(content(), "down", { button: 1 }); await pointer(content(), "up", { button: 1 });
    await pointer(content(), "down"); await pointer(content(), "up", {}, 8);
    expect(useUiStore.getState().activePaneId).toBe(previousSessionId);
    const text = document.createTextNode("existing selection"); content().appendChild(text);
    focusedInput.blur();
    const range = document.createRange(); range.selectNodeContents(text); window.getSelection()!.addRange(range);
    expect(window.getSelection()!.toString()).toBe("existing selection");
    await pointer(content(), "down"); await pointer(content(), "up"); await settleFocus();
    expect(useUiStore.getState().activePaneId).toBe("target-session");
    expect(document.activeElement).toBe(document.body);
    expect(focusController.request).not.toHaveBeenCalled();
  });
});

describe("terminal pane pointer behavior", () => {
  it.each(["button", "a", "input", "textarea", "select", "iframe", "editable", "composer", "transcript", "drag-handle"])(
    "preserves the terminal exclusion for %s", async kind => {
      await renderPane("terminal");
      const target = document.createElement(["editable", "composer", "transcript", "drag-handle"].includes(kind) ? "div" : kind);
      if (kind === "editable") target.setAttribute("contenteditable", "true");
      if (kind === "composer") target.setAttribute("data-composer-session", "target-session");
      if (kind === "transcript") target.setAttribute("data-terminal-transcript-panel", "true");
      if (kind === "drag-handle") target.setAttribute("data-pane-drag-handle", "true");
      content().appendChild(target);
      await pointer(target, "down"); await pointer(target, "up"); await settleFocus();
      expect(useUiStore.getState().activePaneId).toBe(previousSessionId); expect(document.activeElement).toBe(focusedInput);
      expect(focusController.request).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, "terminal"] as const)("keeps pending focus and left-click commit for type %s", async type => {
    await renderPane(type);
    await pointer(content(), "down");
    expect(focusController.request).toHaveBeenCalledWith("pointer", {
      sessionId: "target-session", paneId: "target-pane", action: "pending", pointerId: 7, focus: true,
    });
    expect(useUiStore.getState().activePaneId).toBe(previousSessionId);
    await pointer(content(), "up"); await settleFocus();
    expect(focusController.request).toHaveBeenCalledWith("pointer", { sessionId: "target-session", action: "commit", focus: true });
    expect(useUiStore.getState().activePaneId).toBe("target-session");
    expect(document.activeElement).toBe(content().querySelector("textarea"));
  });

  it("keeps immediate terminal right-click activation", async () => {
    await renderPane("terminal");
    await pointer(content(), "down", { button: 2 }); await settleFocus();
    expect(useUiStore.getState().activePaneId).toBe("target-session");
    expect(document.activeElement).toBe(content().querySelector("textarea"));
  });

  it("keeps terminal drag and cancel aborts", async () => {
    await renderPane("terminal");
    await pointer(content(), "down"); await pointer(content(), "up", { clientY: 36 });
    expect(useUiStore.getState().activePaneId).toBe(previousSessionId);
    expect(focusController.request).toHaveBeenLastCalledWith("pointer", { sessionId: "target-session", action: "abort" });
    await pointer(content(), "down"); await pointer(content(), "cancel");
    expect(focusController.request).toHaveBeenLastCalledWith("pointer", { sessionId: "target-session", action: "abort" });
  });
});

describe("non-terminal tab selection", () => {
  it.each(nonTerminalTypes)("selects a %s tab from the real tab list without moving focus", async type => {
    const sibling = { ...tab(type), id: "sibling-tab", sessionId: "sibling-session" };
    await renderPane("terminal", { sibling });
    await act(async () => container.querySelector<HTMLButtonElement>(".pane-hidden-tabs")!.click());
    await act(async () => container.querySelector<HTMLElement>("[data-menu-tab-id='sibling-tab']")!.click());
    await settleFocus();
    expect(useWorkspaceListStore.getState().workspaces[0].panes[0].activeTabId).toBe("sibling-tab");
    expect(useUiStore.getState().activePaneId).toBe("sibling-session");
    expect(document.activeElement).toBe(focusedInput);
    expect(focusController.request).not.toHaveBeenCalled();
  });

  it.each(nonTerminalTypes)("activates a %s tab by clicking its visible heading", async type => {
    await renderPane(type);
    await act(async () => container.querySelector<HTMLElement>(".pane-active-heading-name")!.click());
    expect(useUiStore.getState().activePaneId).toBe("target-session");
    await settleFocus();
    expect(useUiStore.getState().activePaneId).toBe("target-session");
    expect(document.activeElement).toBe(focusedInput);
    expect(focusController.request).not.toHaveBeenCalled();
  });

  it.each(nonTerminalTypes)("keeps the foreground when a background %s tab is selected", async type => {
    await renderPane(type, { background: true });
    await act(async () => container.querySelector<HTMLElement>(".pane-active-heading")!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    ));
    await settleFocus();
    expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe("other-workspace");
    expect(useUiStore.getState().activePaneId).toBe(previousSessionId);
    expect(document.activeElement).toBe(focusedInput);
    expect(focusController.request).not.toHaveBeenCalled();
  });

  it("activates on the first non-terminal heading click and still starts double-click rename", async () => {
    await renderPane("browser");
    const heading = container.querySelector<HTMLElement>(".pane-active-heading")!;
    await act(async () => {
      heading.dispatchEvent(new MouseEvent("click", { button: 0, detail: 1, bubbles: true }));
      expect(useUiStore.getState().activePaneId).toBe("target-session");
      heading.dispatchEvent(new MouseEvent("click", { button: 0, detail: 2, bubbles: true }));
      heading.dispatchEvent(new MouseEvent("dblclick", { button: 0, detail: 2, bubbles: true }));
    });
    await settleFocus();
    expect(document.querySelector("[data-pane-tab-rename-input]")).not.toBeNull();
    expect(useUiStore.getState().activePaneId).toBe("target-session");
    expect(focusController.request).not.toHaveBeenCalledWith("tab-click", expect.anything());
  });

  it.each(["shiftKey", "altKey", "ctrlKey", "metaKey"] as const)("ignores %s on a non-terminal heading click", async modifier => {
    await renderPane("browser");
    await act(async () => container.querySelector<HTMLElement>(".pane-active-heading")!.dispatchEvent(
      new MouseEvent("click", { button: 0, bubbles: true, [modifier]: true }),
    ));
    await settleFocus();
    expect(useUiStore.getState().activePaneId).toBe(previousSessionId);
  });

  it("preserves the terminal tab-click focus path", async () => {
    const sibling = { ...tab("terminal"), id: "sibling-tab", sessionId: "sibling-session" };
    await renderPane("browser", { sibling });
    await act(async () => container.querySelector<HTMLButtonElement>(".pane-hidden-tabs")!.click());
    await act(async () => container.querySelector<HTMLElement>("[data-menu-tab-id='sibling-tab']")!.click());
    await settleFocus();
    expect(focusController.request).toHaveBeenCalledWith("tab-click", { sessionId: "sibling-session", focus: true });
    expect(useUiStore.getState().activePaneId).toBe("sibling-session");
    expect(document.activeElement).toBe(content().querySelector("textarea"));
  });
});

describe("heading activation before the debounce deadline", () => {
  it("closes the preview through AppShell 50ms after its heading click", async () => {
    await renderPane("browser", { neighbor: true });
    handler = makeAppShellKeydown({ current: { workspaces: useWorkspaceListStore.getState().workspaces,
      activeId: "workspace", activePaneId: previousSessionId, lastActivePaneId: previousSessionId,
      isKeybindingsOpen: false, isCrsmPaletteOpen: false, dashboardOpen: false } }, useWorkspaceListStore, useUiStore,
    useKeybindingStore.getState().getActionsForEvent, isEditableTarget, close, focusController,
    useWorkspaceLayoutStore.getState().setActivePaneTab, () => previousSessionId);
    window.addEventListener("keydown", handler);
    await act(async () => container.querySelector<HTMLElement>(".pane-active-heading")!.click());
    expect(useUiStore.getState().activePaneId).toBe("target-session");
    await act(async () => vi.advanceTimersByTimeAsync(50));
    expect(useUiStore.getState().activePaneId).toBe("target-session");
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "w", code: "KeyW", ctrlKey: true, altKey: true, cancelable: true })));
    expect(close).toHaveBeenCalledExactlyOnceWith({ kind: "pane", workspaceId: "workspace", paneId: "target-pane" }, "ui");
    const result = await close.mock.results[0].value;
    if (result.error) throw result.error;
    expect(result.error).toBeUndefined(); expect(result).toMatchObject({ status: "closed" });
    expect(useWorkspaceListStore.getState().workspaces[0].panes.map(pane => pane.id)).toEqual(["previous-pane"]);
  });

  it.each(nonTerminalTypes)("keeps the terminal active 600ms after a rapid %s heading then terminal click", async type => {
    await renderPane(type, { neighbor: true });
    await act(async () => container.querySelector<HTMLElement>(".pane-active-heading")!.click());
    await act(async () => vi.advanceTimersByTimeAsync(50));
    const target = container.querySelector<HTMLElement>("[data-dnd-pane-id='previous-pane'] [data-test-content]")!;
    await pointer(target, "down"); await pointer(target, "up");
    expect(useUiStore.getState().activePaneId).toBe(previousSessionId);
    await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(useUiStore.getState().activePaneId).toBe(previousSessionId);
    expect(document.activeElement).toBe(target.querySelector("textarea"));
  });

  it.each(["declared", "dormant"] as const)("retains the 250ms %s launch/reselection delay", async state => {
    const launch = vi.spyOn(useWorkspaceLayoutStore.getState(), "launchDeclaredTab").mockImplementation(() => {});
    await renderPane("terminal", { overrides: state === "declared" ? { lifecycle: "declared", agentKind: "codex" }
      : { agentKind: "codex", agentSessionId: "synthetic-resume" } });
    await act(async () => container.querySelector<HTMLElement>(".pane-active-heading")!.click());
    expect(useUiStore.getState().activePaneId).toBe(previousSessionId); expect(launch).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(249));
    expect(useUiStore.getState().activePaneId).toBe(previousSessionId); expect(launch).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(useUiStore.getState().activePaneId).toBe("target-session");
    if (state === "declared") expect(launch).toHaveBeenCalledExactlyOnceWith("workspace", "target-pane", "target-tab");
    else expect(launch).not.toHaveBeenCalled();
  });

  it.each(["pointer", "list", "keyboard"] as const)("cancels a delayed declared launch after newer %s selection", async path => {
    const launch = vi.spyOn(useWorkspaceLayoutStore.getState(), "launchDeclaredTab").mockImplementation(() => {});
    await renderPane("terminal", { neighbor: true, overrides: { lifecycle: "declared", agentKind: "codex" },
      sibling: { ...tab("browser"), id: "sibling-tab", sessionId: "sibling-session" } });
    await act(async () => container.querySelector<HTMLElement>(".pane-active-heading")!.click());
    await act(async () => vi.advanceTimersByTimeAsync(50));
    if (path === "pointer") {
      const target = container.querySelector<HTMLElement>("[data-dnd-pane-id='previous-pane'] [data-test-content]")!;
      await pointer(target, "down"); await pointer(target, "up");
    } else if (path === "list") {
      await act(async () => container.querySelector<HTMLButtonElement>(".pane-hidden-tabs")!.click());
      await act(async () => container.querySelector<HTMLElement>("[data-menu-tab-id='sibling-tab']")!.click());
    } else {
      await act(async () => container.querySelector<HTMLElement>("[data-dnd-pane-id='previous-pane'] .pane-active-heading")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    }
    const expected = path === "list" ? "sibling-session" : previousSessionId;
    expect(useUiStore.getState().activePaneId).toBe(expected);
    await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(useUiStore.getState().activePaneId).toBe(expected); expect(launch).not.toHaveBeenCalled();
  });
});
