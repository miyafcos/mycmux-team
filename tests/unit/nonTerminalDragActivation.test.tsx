// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TerminalPane from "../../src/components/workspace/TerminalPane";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useUiStore } from "../../src/stores/uiStore";
import { usePaneDragStore, type PaneDragItem } from "../../src/stores/paneDragStore";
import { usesNativeGroupDrag } from "../../src/lib/tearout/pointerDrag";
import { focusController } from "../../src/lib/focusController";
import type { Workspace } from "../../src/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null), isTauri: () => false, Channel: class {}, convertFileSrc: (path: string) => path }));
vi.mock("../../src/lib/ipc", async original => ({ ...await original<object>(),
  onSavepointPublishProgress: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("../../src/components/workspace/BrowserPane", () => ({ default: () => <div>Preview</div> }));
vi.mock("../../src/components/composer/PaneComposer", () => ({ PaneComposer: () => null }));
vi.mock("../../src/components/terminal/XTermWrapper", () => ({ default: () => <textarea className="xterm-helper-textarea" />, hasTerminalBuffer: () => false }));

let root: Root; let host: HTMLDivElement; let spacer: HTMLElement;
const item: PaneDragItem = { kind: "pane", workspaceId: "workspace", paneId: "preview", tabCount: 1, label: "Preview" };
function pointer(type: string, x: number, id = 7): PointerEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: 30 });
  Object.defineProperties(event, { pointerId: { value: id }, screenX: { value: x + 100 }, screenY: { value: 130 } });
  return event as PointerEvent;
}
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
  useSettingsStore.setState({ paneComposerEnabled: false, showTerminalHistoryButton: false });
  focusController.request("tab-rename", { suppressMs: 0 });
  usePaneDragStore.getState().clearDrag();
  useUiStore.setState({ activePaneId: "terminal-session", lastActivePaneId: "terminal-session", focusRevision: 0, zoomedPaneId: null });
  const workspace: Workspace = { id: "workspace", name: "Synthetic", createdAt: 1, gridTemplateId: "1x2", status: "running",
    panes: ["terminal", "preview"].map(id => ({ id, agentId: "shell-starter", sessionId: `${id}-session`, activeTabId: `${id}-tab`,
      tabs: [{ id: `${id}-tab`, sessionId: `${id}-session`, agentId: "shell-starter", type: id === "terminal" ? "terminal" : "browser" }] })) };
  useWorkspaceListStore.setState({ workspaces: [workspace], activeWorkspaceId: workspace.id });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { window.dispatchEvent(pointer("pointercancel", 20)); root.unmount(); });
  host.remove(); usePaneDragStore.getState().clearDrag(); focusController.clearSession("terminal-session");
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});
async function mount(native: boolean): Promise<void> {
  useSettingsStore.setState({ nativePaneTearoutEnabled: native });
  const workspace = useWorkspaceListStore.getState().workspaces[0];
  await act(async () => root.render(<>{workspace.panes.map(pane => <TerminalPane key={pane.id} pane={pane} workspaceId={workspace.id} />)}</>));
  spacer = host.querySelector<HTMLElement>("[data-dnd-pane-id='preview'] .pane-heading-spacer")!;
  const bar = spacer.closest<HTMLElement>(".pane-tabbar")!;
  vi.spyOn(bar, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 300, bottom: 60, width: 300, height: 60, toJSON() {} });
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => spacer });
  expect(usesNativeGroupDrag(item)).toBe(native);
}

describe("real ordinary and native-strip pane drag versus non-terminal selection", () => {
  it.each([false, true].flatMap(native => ["return", "escape", "cancel"].map(end => [native, end] as const)))
    ("keeps the old selection after native=%s drag and %s", async (native, end) => {
      await mount(native); const focus = vi.spyOn(focusController, "request"); const before = useUiStore.getState();
      await act(async () => spacer.dispatchEvent(pointer("pointerdown", 20)));
      await act(async () => window.dispatchEvent(pointer("pointermove", 40)));
      expect(usePaneDragStore.getState().item).toMatchObject({ kind: "pane", paneId: "preview" });
      await act(async () => {
        window.dispatchEvent(pointer("pointermove", 20));
        if (end === "escape") window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        if (end === "cancel") window.dispatchEvent(pointer("pointercancel", 20));
      });
      if (end !== "return") expect(usePaneDragStore.getState().item).toBeNull();
      await act(async () => spacer.dispatchEvent(pointer("pointerup", 20)));
      await act(async () => spacer.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 })));
      expect(useUiStore.getState().activePaneId).toBe(before.activePaneId);
      expect(useUiStore.getState().focusRevision).toBe(before.focusRevision);
      expect(focus).not.toHaveBeenCalled(); expect(usePaneDragStore.getState().item).toBeNull();
  });

  it("selects normally within 5px and ignores movement from another pointer", async () => {
    await mount(false);
    await act(async () => { spacer.dispatchEvent(pointer("pointerdown", 20)); window.dispatchEvent(pointer("pointermove", 50, 8)); spacer.dispatchEvent(pointer("pointerup", 23)); });
    expect(useUiStore.getState().activePaneId).toBe("preview-session");
  });

  it.each(["move", "store", "escape", "blur"])("does not resurrect pending activation after %s before a drag store remains at release", async reason => {
    await mount(false); const before = useUiStore.getState();
    await act(async () => {
      spacer.dispatchEvent(pointer("pointerdown", 20));
      if (reason === "move") window.dispatchEvent(pointer("pointermove", 26));
      if (reason === "store") { usePaneDragStore.getState().beginDrag(item, { x: 20, y: 30 }); usePaneDragStore.getState().clearDrag(); }
      if (reason === "escape") window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      if (reason === "blur") window.dispatchEvent(new Event("blur"));
      spacer.dispatchEvent(pointer("pointerup", 20));
      spacer.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    });
    expect(useUiStore.getState().activePaneId).toBe(before.activePaneId); expect(useUiStore.getState().focusRevision).toBe(before.focusRevision);
  });
});
