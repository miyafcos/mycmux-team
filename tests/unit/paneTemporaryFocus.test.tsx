// @vitest-environment jsdom
import { act, useState } from "react";
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
import { invoke } from "@tauri-apps/api/core";
import { cleanupOnlineSavepoints, listOnlineSavepoints, listTrashedOnlineSavepoints } from "../../src/lib/ipc";
import type { OnlineSavepointEntry } from "../../src/components/online/onlineSavepoints";
import { onlineStrings } from "../../src/components/online/onlineStrings";
import { htmlReviewStrings } from "../../src/lib/htmlReviewDraft";
import { HISTORY_MAPPING_POLL_MS, TERMINAL_HISTORY_EVENT } from "../../src/components/terminal/TerminalHistoryEntry";

const mocks = vi.hoisted(() => ({ kill: vi.fn(), reveal: vi.fn(), open: vi.fn() }));
const reviewMocks = vi.hoisted(() => ({ chooseHtmlReviewElement: vi.fn(), cancelHtmlReviewPicker: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/lib/htmlReviewCapture", async original => ({ ...await original<object>(), ...reviewMocks }));
vi.mock("../../src/lib/ipc", async original => ({ ...await original<object>(), killSession: mocks.kill,
  revealInExplorer: mocks.reveal, openWithDefault: mocks.open,
  readEditableArtifact: vi.fn(async () => ({ content: "<p>Read me</p>", sourceKind: "markdown", sourcePath: "/preview.md" })),
  onSavepointPublishProgress: vi.fn().mockResolvedValue(() => {}), crsmListSessions: vi.fn().mockResolvedValue([]),
  listOnlineSavepoints: vi.fn().mockResolvedValue([]), listTrashedOnlineSavepoints: vi.fn().mockResolvedValue([]),
  cleanupOnlineSavepoints: vi.fn().mockResolvedValue({ deleted_count: 0 }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null), isTauri: () => false,
  convertFileSrc: (path: string) => `https://asset.localhost${path}`, Channel: class {} }));
vi.mock("@tauri-apps/api/event", async original => ({ ...await original<object>(), listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("../../src/lib/paneCloseConfirmation", () => ({ confirmPaneClose: vi.fn().mockResolvedValue(true) }));
vi.mock("../../src/hooks/usePaneDragSource", () => ({ usePaneDragSource: () => ({ beginPointerDrag: vi.fn(), shouldSuppressClick: () => false }) }));
vi.mock("../../src/components/composer/PaneComposer", () => ({ PaneComposer: () => null }));
vi.mock("../../src/components/terminal/XTermWrapper", () => ({ default: (props: { onArtifactLinkClick: (uri: string, pos: {x: number; y: number}) => void }) => <div className="xterm"><textarea className="xterm-helper-textarea" /><button data-artifact-trigger onClick={() => props.onArtifactLinkClick("file:///tmp/result.bin", { x: 20, y: 20 })}>Artifact</button></div>, hasTerminalBuffer: () => false }));
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
  tracking = trackAppShellPaneFocus(() => useWorkspaceListStore.getState().workspaces.find(ws => ws.id === useWorkspaceListStore.getState().activeWorkspaceId));
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
  vi.mocked(invoke).mockResolvedValue(null);
  vi.mocked(listOnlineSavepoints).mockResolvedValue([]); vi.mocked(listTrashedOnlineSavepoints).mockResolvedValue([]);
  vi.mocked(cleanupOnlineSavepoints).mockResolvedValue({ deleted_count: 0 });
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


import { TerminalTurnChip } from "../../src/components/terminal/TerminalTurnChip";
import { TerminalTranscriptPanel } from "../../src/components/terminal/TerminalTranscriptPanel";
import { artifactEditorStrings as editorStrings } from "../../src/components/workspace/artifactEditorStrings";
async function key(target: HTMLElement, name: string): Promise<void> {
  await act(async () => target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })));
}
async function mouseClick(target: HTMLElement, modified = false): Promise<void> {
  await act(async () => target.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1, ctrlKey: modified })));
}
async function openKebab(): Promise<HTMLButtonElement> {
  const button = pane().querySelector<HTMLButtonElement>("button[aria-haspopup='menu']:not(.pane-hidden-tabs)")!;
  button.focus(); await mouseClick(button, true); return button;
}
async function publish(): Promise<HTMLButtonElement> {
  await mount("terminal");
  await act(async () => useWorkspaceListStore.setState(state => ({ workspaces: state.workspaces.map(ws => ({ ...ws,
    panes: ws.panes.map(p => p.id !== "preview" ? p : { ...p, tabs: p.tabs.map(t => ({...t, agentKind: "claude" as const, claudeSessionId: "synthetic-session"})) }),
  })) })));
  const trigger = await openKebab();
  const item = pane().querySelector<HTMLButtonElement>("[data-pane-action='publish']")!;
  item.focus(); await mouseClick(item, true);
  expect(pane().querySelector("form input")).not.toBeNull(); return trigger;
}
function OwnedParts({ type }: { type: "turns" | "transcript" }) {
  const [open, setOpen] = useState(true);
  return <div data-dnd-workspace-id="workspace" data-dnd-pane-id="preview" tabIndex={-1}>
    <div className="pane-active-heading" tabIndex={0}>Heading</div>
    {type === "turns" ? <TerminalTurnChip index={0} total={1} label="Prompt" canPrev={false} canNext={false}
      rows={[{ key: "turn", label: "Prompt", markIndex: 0 }]} onPrev={() => {}} onNext={() => {}} onListOpen={() => {}} onJump={() => {}} />
      : open && <TerminalTranscriptPanel sessionId="preview-session" tabId="preview-tab" onClose={() => setOpen(false)} />}
  </div>;
}
describe("temporary pane controls keep an attributable focus after completion", () => {
  it.each(["publish", "artifact", "turns", "transcript", "name-menu", "kebab", "all-tabs", "rename-F2", "rename-list"] as const)("M1 returns after outside focus and re-entry into %s", async part => {
    let focused: HTMLElement; let trigger: HTMLElement; let region: HTMLElement;
    if (part === "publish") {
      trigger = await publish(); focused = pane().querySelector<HTMLInputElement>("form input")!; region = focused.closest("form")!;
    } else if (part === "artifact") {
      await mount("terminal"); trigger = pane().querySelector<HTMLElement>("[data-artifact-trigger]")!;
      trigger.focus(); await mouseClick(trigger); focused = pane().querySelector<HTMLElement>("button[aria-label='既定のアプリで開く']")!; region = focused.parentElement!;
    } else if (part === "turns" || part === "transcript") {
      await mount("terminal"); await act(async () => root.render(<OwnedParts type={part} />));
      if (part === "turns") {
        trigger = pane().querySelector<HTMLElement>(".terminal-turn-chip__label")!; trigger.focus(); await mouseClick(trigger);
        focused = pane().querySelector<HTMLElement>("[role='option']")!; region = pane().querySelector<HTMLElement>("[role='listbox']")!;
      } else {
        trigger = pane().querySelector<HTMLElement>(".pane-active-heading")!; focused = pane().querySelector<HTMLElement>(".terminal-transcript-panel__close")!;
        region = pane().querySelector<HTMLElement>("[data-terminal-transcript-panel]")!;
      }
    } else {
      await mount("browser", part === "all-tabs" || part === "rename-list");
      const heading = pane().querySelector<HTMLElement>(".pane-active-heading")!;
      if (part === "kebab") { trigger = await openKebab(); focused = pane().querySelector<HTMLElement>("[role='menuitem']")!; region = focused.closest<HTMLElement>("[role='menu']")!; }
      else if (part === "all-tabs" || part === "rename-list") {
        trigger = pane().querySelector<HTMLElement>(".pane-hidden-tabs")!; trigger.focus(); await mouseClick(trigger, true);
        const row = pane().querySelector<HTMLElement>("[data-menu-tab-id='sibling-tab']")!;
        if (part === "rename-list") {
          const rename = row.querySelector<HTMLButtonElement>("button")!; rename.focus(); await mouseClick(rename, true);
          focused = document.querySelector<HTMLElement>("[data-pane-tab-rename-input]")!; region = focused.closest<HTMLElement>("[role='dialog']")!;
          trigger = heading; // The list row disappears together with its list.
        } else { focused = row; region = row.closest<HTMLElement>("[role='menu']")!; }
      } else if (part === "rename-F2") {
        trigger = heading; heading.focus(); await key(heading, "F2");
        focused = document.querySelector<HTMLElement>("[data-pane-tab-rename-input]")!; region = focused.closest<HTMLElement>("[role='dialog']")!;
      } else {
        trigger = heading; heading.focus(); await act(async () => heading.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 2, ctrlKey: true })));
        focused = pane().querySelector<HTMLElement>("[role='menuitem']")!; region = focused.closest<HTMLElement>("[role='menu']")!;
      }
    }
    expect(focused).not.toBeNull(); await act(async () => focused.focus());
    const before = useUiStore.getState(); const outside = document.createElement("button"); host.append(outside);
    await act(async () => outside.focus()); expect(region.isConnected).toBe(true);
    await act(async () => focused.focus()); await key(focused, "Escape");
    expect(region.isConnected).toBe(false); expect(document.activeElement).toBe(trigger);
    expect(useUiStore.getState().activePaneId).toBe(before.activePaneId); expect(useUiStore.getState().focusRevision).toBe(before.focusRevision);
  });
  it.each(["Escape", "cancel"])("returns from publish via %s without selecting its terminal", async exit => {
    const trigger = await publish(); const input = pane().querySelector<HTMLInputElement>("form input")!;
    expect(document.activeElement).toBe(input);
    if (exit === "Escape") await key(input, exit);
    else { const button = pane().querySelector<HTMLButtonElement>("form button")!; button.focus(); await mouseClick(button); }
    expect(pane().querySelector("form")).toBeNull(); expect(document.activeElement).toBe(trigger);
    expect(useUiStore.getState().activePaneId).toBe("terminal-session");
  });
  it.each(["escape", "open", "reveal"])("returns from artifact link %s", async exit => {
    await mount("terminal"); const trigger = pane().querySelector<HTMLButtonElement>("[data-artifact-trigger]")!;
    trigger.focus(); await mouseClick(trigger);
    const buttons = pane().querySelectorAll<HTMLButtonElement>("button[aria-label='既定のアプリで開く'],button[aria-label='エクスプローラーで表示']");
    const button = buttons[exit === "reveal" ? 1 : 0]; expect(button).toBeDefined(); button.focus();
    if (exit === "escape") await key(button, "Escape"); else await mouseClick(button);
    expect(document.activeElement).toBe(trigger); expect(trigger.isConnected).toBe(true);
  });
  it.each(["reset-name", "pin"])("returns from a name menu's %s action", async action => {
    await mount();
    await act(async () => useWorkspaceLayoutStore.getState().setTabLabel("workspace", "preview", "preview-tab", "Custom"));
    const heading = pane().querySelector<HTMLElement>(".pane-active-heading")!; heading.focus();
    await act(async () => heading.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 2, ctrlKey: true })));
    const items = pane().querySelectorAll<HTMLButtonElement>("[role='menu'] button"); const item = items[action === "pin" ? 2 : 1];
    item.focus(); await mouseClick(item, true); expect(document.activeElement).toBe(heading);
    expect(useUiStore.getState().activePaneId).toBe("terminal-session");
  });
  it("returns from a kebab reset action", async () => {
    await mount(); await act(async () => useWorkspaceLayoutStore.getState().setTabLabel("workspace", "preview", "preview-tab", "Custom"));
    const trigger = await openKebab(); const item = pane().querySelector<HTMLButtonElement>("[data-pane-action='reset-name']")!;
    item.focus(); await mouseClick(item, true); expect(document.activeElement).toBe(trigger);
  });
  it.each(["Escape", "choose"])("returns from the actual turn list via %s", async exit => {
    await mount("terminal"); await act(async () => root.render(<OwnedParts type="turns" />));
    const trigger = pane().querySelector<HTMLButtonElement>(".terminal-turn-chip__label")!; trigger.focus(); await mouseClick(trigger);
    const row = pane().querySelector<HTMLButtonElement>("[role='option']")!; row.focus();
    if (exit === "Escape") await key(row, exit); else await mouseClick(row);
    expect(pane().querySelector("[role='listbox']")).toBeNull(); expect(document.activeElement).toBe(trigger);
  });
  it.each(["Escape", "close"])("returns from the actual transcript reader via %s", async exit => {
    await mount("terminal"); await act(async () => root.render(<OwnedParts type="transcript" />));
    const button = pane().querySelector<HTMLButtonElement>(".terminal-transcript-panel__close")!;
    expect(document.activeElement).toBe(pane().querySelector("[data-transcript-search-input]"));
    if (exit === "Escape") await key(document.activeElement as HTMLElement, exit); else await mouseClick(button);
    expect(document.activeElement).toBe(pane().querySelector(".pane-active-heading"));
  });
  it("returns from a keyboard-focused editing toolbar button after cancel", async () => {
    await mount(); const edit = pane().querySelector<HTMLButtonElement>(`button[aria-label='${editorStrings.startEdit}']`)!;
    expect(edit).not.toBeNull(); edit.focus(); await mouseClick(edit);
    const cancel = pane().querySelector<HTMLButtonElement>(`button[aria-label='${editorStrings.discardEdits}']`)!;
    expect(cancel).not.toBeNull(); cancel.focus(); await mouseClick(cancel);
    expect(cancel.isConnected).toBe(false); expect(document.activeElement).toBe(pane().querySelector(".pane-active-heading"));
  });
  it.each(["publish", "artifact"])("does not steal an outside focus on %s dismissal", async surface => {
    if (surface === "publish") await publish();
    else { await mount("terminal"); await mouseClick(pane().querySelector("[data-artifact-trigger]")!); }
    const outside = document.createElement("button"); host.append(outside); outside.focus();
    await act(async () => outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(document.activeElement).toBe(outside);
  });
});
it("keeps focus inside the pane when a non-terminal list row is selected", async () => {
  await mount("browser", true); const trigger = pane().querySelector<HTMLButtonElement>(".pane-hidden-tabs")!;
  trigger.focus(); await mouseClick(trigger, true);
  const row = pane().querySelector<HTMLElement>("[data-menu-tab-id='sibling-tab']")!; row.focus(); await mouseClick(row, true);
  expect(useUiStore.getState().activePaneId).toBe("sibling-session"); expect(document.activeElement).toBe(trigger);
});
it("keeps the list open and returns focus when its focused row-close button disappears", async () => {
  await mount("browser", true);
  await act(async () => useWorkspaceListStore.setState(state => ({ workspaces: state.workspaces.map(ws => ({ ...ws,
    panes: ws.panes.map(p => p.id !== "preview" ? p : { ...p, tabs: [...p.tabs, { ...p.tabs[0], id: "third-tab", sessionId: "third-session" }] }),
  })) })));
  const trigger = pane().querySelector<HTMLButtonElement>(".pane-hidden-tabs")!;
  trigger.focus(); await mouseClick(trigger, true);
  const row = pane().querySelector<HTMLElement>("[data-menu-tab-id='sibling-tab']")!;
  const closeButton = row.querySelectorAll<HTMLButtonElement>("button")[2]; closeButton.focus(); await mouseClick(closeButton, true);
  expect(row.isConnected).toBe(false); expect(pane().querySelector("[role='menu']")).not.toBeNull(); expect(document.activeElement).toBe(pane().querySelector(".pane-active-heading"));
});
it.each(["publish", "artifact", "turns", "transcript"])("does not overwrite a newer selection/focus when %s closes", async part => {
  let target: HTMLElement;
  if (part === "publish") { await publish(); target = pane().querySelector("form input")!; }
  else if (part === "artifact") {
    await mount("terminal"); await mouseClick(pane().querySelector("[data-artifact-trigger]")!);
    target = pane().querySelector("button[aria-label='既定のアプリで開く']")!; target.focus();
  } else {
    await mount("terminal"); await act(async () => root.render(<OwnedParts type={part as "turns" | "transcript"} />));
    if (part === "turns") { await mouseClick(pane().querySelector(".terminal-turn-chip__label")!); target = pane().querySelector("[role='option']")!; target.focus(); }
    else target = pane().querySelector(".terminal-transcript-panel__close")!;
  }
  const outside = document.createElement("button"); host.append(outside); outside.focus(); useUiStore.getState().bumpFocusRevision();
  await key(target, "Escape"); expect(document.activeElement).toBe(outside);
});

it("keeps a live heading focused when the last hidden row and list trigger disappear", async () => {
  await mount("browser", true); const trigger = pane().querySelector<HTMLButtonElement>(".pane-hidden-tabs")!;
  trigger.focus(); await mouseClick(trigger, true); const row = pane().querySelector<HTMLElement>("[data-menu-tab-id='sibling-tab']")!;
  const button = row.querySelectorAll<HTMLButtonElement>("button")[2]; button.focus(); await mouseClick(button, true);
  expect(trigger.isConnected).toBe(false); expect(document.activeElement).toBe(pane().querySelector(".pane-active-heading"));
});

it.each(["reset-name", "pin", "kebab-reset"])("returns focus after a non-terminal keyboard %s completion", async action => {
  await mount(); await act(async () => useWorkspaceLayoutStore.getState().setTabLabel("workspace", "preview", "preview-tab", "Custom"));
  const heading = pane().querySelector<HTMLElement>(".pane-active-heading")!;
  let trigger: HTMLElement; let item: HTMLButtonElement;
  if (action === "kebab-reset") {
    trigger = await openKebab(); item = pane().querySelector("[data-pane-action='reset-name']")!;
  } else {
    trigger = heading; heading.focus();
    await act(async () => heading.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 2, ctrlKey: true })));
    item = pane().querySelectorAll<HTMLButtonElement>("[role='menu'] button")[action === "pin" ? 2 : 1];
  }
  item.focus(); await key(item, "Enter"); await act(async () => item.click());
  expect(item.isConnected).toBe(false); expect(document.activeElement).toBe(trigger);
  expect(useUiStore.getState().activePaneId).toBe("preview-session");
  installShell(); await closeKey(trigger);
  expect(useWorkspaceListStore.getState().workspaces[0].panes.map(p => p.id)).toEqual(["terminal"]);
  expect(mocks.kill).not.toHaveBeenCalled();
});
it("returns after cancelling editing with a keyboard click that reselects the preview", async () => {
  await mount(); const edit = pane().querySelector<HTMLButtonElement>(`button[aria-label='${editorStrings.startEdit}']`)!;
  edit.focus(); await key(edit, "Enter"); await act(async () => edit.click());
  const cancel = pane().querySelector<HTMLButtonElement>(`button[aria-label='${editorStrings.discardEdits}']`)!;
  cancel.focus(); await key(cancel, "Enter"); await act(async () => cancel.click());
  expect(cancel.isConnected).toBe(false); expect(document.activeElement).toBe(pane().querySelector(".pane-active-heading"));
  expect(useUiStore.getState().activePaneId).toBe("preview-session");
});
it("does not overwrite a newer live toolbar focus on editing cancellation", async () => {
  await mount(); const edit = pane().querySelector<HTMLButtonElement>(`button[aria-label='${editorStrings.startEdit}']`)!;
  edit.focus(); await mouseClick(edit);
  const cancel = pane().querySelector<HTMLButtonElement>(`button[aria-label='${editorStrings.discardEdits}']`)!;
  const outsideCancel = pane().querySelector<HTMLButtonElement>(`button[aria-label='${editorStrings.showLocation}']`)!;
  outsideCancel.focus(); await mouseClick(cancel, true);
  expect(cancel.isConnected).toBe(false); expect(document.activeElement).toBe(outsideCancel);
});
it.each(["markdown", "office", "html"] as const)("L3 returns focused %s edit content before normal mousedown cancellation replaces it", async kind => {
  await mount();
  if (kind !== "markdown") await act(async () => useWorkspaceListStore.setState(state => ({ workspaces: state.workspaces.map(ws => ({ ...ws,
    panes: ws.panes.map(p => p.id !== "preview" ? p : { ...p, tabs: p.tabs.map(t => ({ ...t, sourceKind: kind, sourcePath: kind === "office" ? "/preview.docx" : "/preview.html" })) }),
  })) })));
  const edit = pane().querySelector<HTMLButtonElement>(`button[aria-label='${editorStrings.startEdit}']`)!;
  await mouseClick(edit);
  const content = kind === "markdown" ? pane().querySelector<HTMLTextAreaElement>("textarea")! : pane().querySelector<HTMLIFrameElement>("iframe")!;
  if (content instanceof HTMLIFrameElement) {
    content.removeAttribute("srcdoc"); content.src = "about:blank";
    const doc = content.contentDocument!; doc.open(); doc.write("<p contenteditable='true' tabindex='0'>Editor</p>"); doc.close();
    await act(async () => content.dispatchEvent(new Event("load"))); doc.querySelector<HTMLElement>("p")!.focus();
  } else {
    content.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(content, "Dirty edit");
    await act(async () => content.dispatchEvent(new Event("input", { bubbles: true })));
    vi.spyOn(window, "confirm").mockReturnValue(true);
  }
  expect(document.activeElement).toBe(content);
  const cancel = pane().querySelector<HTMLButtonElement>(`button[aria-label='${editorStrings.discardEdits}']`)!;
  await pointer(cancel, "down");
  await act(async () => expect(cancel.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }))).toBe(false));
  expect(document.activeElement).toBe(content); await pointer(cancel, "up"); await mouseClick(cancel);
  expect(content.isConnected).toBe(false); expect(document.activeElement).toBe(pane().querySelector(".pane-active-heading"));
  if (kind !== "markdown") expect(pane().querySelector("iframe")).not.toBe(content);
});
it("L3 returns a focused edit-only tool on cancellation", async () => {
  await mount(); await mouseClick(pane().querySelector(`button[aria-label='${editorStrings.startEdit}']`)!);
  const reload = pane().querySelector<HTMLButtonElement>(`button[aria-label='${editorStrings.reloadFromDisk}']`)!; reload.focus();
  const cancel = pane().querySelector<HTMLButtonElement>(`button[aria-label='${editorStrings.discardEdits}']`)!;
  await act(async () => cancel.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))); await mouseClick(cancel, true);
  expect(reload.isConnected).toBe(false); expect(document.activeElement).toBe(pane().querySelector(".pane-active-heading"));
});
it("L3 preserves a live outside element on normal mousedown cancellation", async () => {
  await mount(); await mouseClick(pane().querySelector(`button[aria-label='${editorStrings.startEdit}']`)!);
  const outside = document.createElement("button"); host.append(outside); outside.focus();
  const cancel = pane().querySelector<HTMLButtonElement>(`button[aria-label='${editorStrings.discardEdits}']`)!;
  await act(async () => cancel.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })));
  await mouseClick(cancel, true); expect(document.activeElement).toBe(outside);
});
it("returns from the actual HTML review bar's keyboard cancel after preview reselection", async () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
  reviewMocks.chooseHtmlReviewElement.mockReturnValue(new Promise(() => {}));
  await mount(); await act(async () => useWorkspaceListStore.setState(state => ({ workspaces: state.workspaces.map(ws => ({ ...ws,
    panes: ws.panes.map(p => p.id !== "preview" ? p : { ...p, tabs: p.tabs.map(t => ({...t, sourceKind: "html" as const})) }),
  })) })));
  const reviewButton = (label: string) => [...pane().querySelectorAll<HTMLButtonElement>(".html-review-draft button")].find(b => b.textContent === label)!;
  await mouseClick(reviewButton(htmlReviewStrings.open), true);
  const pick = reviewButton(htmlReviewStrings.pick); pick.focus(); await mouseClick(pick, true);
  const cancel = reviewButton(htmlReviewStrings.cancelPick); expect(cancel).toBeDefined(); cancel.focus();
  await key(cancel, "Enter"); await act(async () => cancel.click());
  expect(cancel.isConnected).toBe(false); expect(document.activeElement).toBe(reviewButton(htmlReviewStrings.close));
  expect(useUiStore.getState().activePaneId).toBe("preview-session");
});

const onlineEntry: OnlineSavepointEntry = { bundle_dir: "/synthetic/entry", author: "author", machine: "machine",
  summary_line: "Saved conversation", cwd: "/synthetic", created_at: "2026-10-11T00:00:00Z", updated_at: "2026-10-11T00:00:00Z",
  expires_at: "2099-01-01T00:00:00Z", pinned: false, warnings_count: 0, files_written_count: 0, handoff_path: "/synthetic/entry/handoff.md" };
async function pendingOnlineRemoval(action: "delete" | "restore" | "purge", modified = false) {
  const trashed = { ...onlineEntry, trash_id: "trash-id", deleted_at: "2026-10-11T00:00:00Z" };
  vi.mocked(listOnlineSavepoints).mockResolvedValue(action === "delete" ? [onlineEntry] : []);
  vi.mocked(listTrashedOnlineSavepoints).mockResolvedValue(action === "delete" ? [] : [trashed]);
  await mount("online");
  if (action !== "delete") {
    const view = [...pane().querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === onlineStrings.trashView(1))!;
    await mouseClick(view, true);
    await mouseClick(pane().querySelector(".online-sp-card-disclosure")!, true);
  }
  const button = action === "delete" ? pane().querySelector<HTMLButtonElement>(`button[aria-label='${onlineStrings.moveToTrash}']`)!
    : [...pane().querySelectorAll<HTMLButtonElement>(".online-action-button")].find(b => b.textContent === (action === "restore" ? onlineStrings.restore : onlineStrings.deletePermanently))!;
  expect(button).toBeDefined(); button.focus();
  if (action === "purge") { if (modified) await mouseClick(button, true); else await act(async () => button.click()); expect(button.textContent).toBe(onlineStrings.deletePermanentlyConfirm); }
  let release!: () => void;
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === `${action === "delete" ? "delete" : action === "restore" ? "restore" : "purge"}_online_savepoint`) {
      return new Promise<void>(resolve => { release = resolve; });
    }
    return null;
  });
  if (modified) await mouseClick(button, true); else await act(async () => button.click()); expect(release).toBeTypeOf("function");
  vi.mocked(listOnlineSavepoints).mockResolvedValue([]); vi.mocked(listTrashedOnlineSavepoints).mockResolvedValue([]);
  return { button, release };
}
it.each(["delete", "restore", "purge"] as const)("returns from a successfully disappearing online %s control", async action => {
  const { button, release } = await pendingOnlineRemoval(action);
  await act(async () => release());
  expect(button.isConnected).toBe(false); expect(document.activeElement).toBe(pane().querySelector(".pane-active-heading"));
});
it.each(["revision", "focus"])("does not overwrite a newer %s while an online deletion is pending", async decision => {
  const { button, release } = await pendingOnlineRemoval("delete");
  const search = pane().querySelector<HTMLInputElement>(".online-panel input")!;
  if (decision === "revision") useUiStore.getState().bumpFocusRevision(); else search.focus();
  await act(async () => release()); expect(button.isConnected).toBe(false);
  expect(document.activeElement).toBe(decision === "revision" ? document.body : search);
});
it.each(["delete", "restore", "purge"] as const)("L2 leaves outside body/H2 clear and permits terminal close after online %s", async action => {
  installShell(); const { button, release } = await pendingOnlineRemoval(action, true);
  expect(useUiStore.getState().activePaneId).toBe("terminal-session"); expect(tracking!.memory.current?.paneId).toBe("preview");
  const outside = document.createElement("div"); host.append(outside);
  await act(async () => {
    outside.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    // jsdom's blur() on the now-disabled operation button does not emulate the native outside click.
    document.body.tabIndex = -1; document.body.focus(); document.body.removeAttribute("tabindex");
  });
  expect(document.activeElement).toBe(document.body); expect(tracking!.memory.current).toBeNull();
  await act(async () => release());
  expect.soft(button.isConnected).toBe(false); expect.soft(document.activeElement).toBe(document.body); expect.soft(tracking!.memory.current).toBeNull();
  await closeKey(document.activeElement as HTMLElement);
  expect(mocks.kill).toHaveBeenCalledExactlyOnceWith("terminal-session");
  expect(useWorkspaceListStore.getState().workspaces[0].panes.map(p => p.id)).toEqual(["preview"]);
});
it.each(["missing", "failed"])("L5 keeps a focused history item in the actual kebab menu through a %s mapping poll", async result => {
  useSettingsStore.setState({ showTerminalHistoryButton: true });
  let available = true;
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "read_agent_session_mappings") {
      if (!available && result === "failed") throw new Error("Transient mapping read");
      return available ? { "preview-session": { agent_kind: "claude", session_id: "exact-menu-session" } } : {};
    }
    return null;
  });
  await mount("terminal"); await openKebab();
  const button = pane().querySelector<HTMLButtonElement>(".pane-actions-menu [data-terminal-magnifier]")!; expect(button).not.toBeNull();
  await act(async () => button.focus()); available = false;
  await act(async () => vi.advanceTimersByTimeAsync(HISTORY_MAPPING_POLL_MS));
  expect.soft(button.isConnected).toBe(true); expect.soft(document.activeElement).toBe(button);
  expect.soft(button.getAttribute("aria-disabled")).toBe("true");
  const requested = vi.fn(); window.addEventListener(TERMINAL_HISTORY_EVENT, requested);
  try { await act(async () => button.click()); expect(requested).not.toHaveBeenCalled(); }
  finally { window.removeEventListener(TERMINAL_HISTORY_EVENT, requested); }
  expect(pane().querySelector(".pane-actions-menu")).not.toBeNull();
  available = true; await act(async () => vi.advanceTimersByTimeAsync(HISTORY_MAPPING_POLL_MS));
  expect(pane().querySelector(".pane-actions-menu [data-terminal-magnifier]")).toBe(button); expect(document.activeElement).toBe(button);
});
