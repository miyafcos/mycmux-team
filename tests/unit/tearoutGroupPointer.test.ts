// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ pane: vi.fn(async () => {}), workspace: vi.fn(async () => {}),
  regrab: vi.fn(async () => {}), canRegrab: vi.fn(() => false) }));
vi.mock("../../src/lib/tearout/runtime", () => ({ tearoutTab: vi.fn(), canRegrabTearoutTab: () => false,
  tearoutPane: mocks.pane, tearoutWorkspace: mocks.workspace, canRegrabTearoutPane: mocks.canRegrab, regrabTearoutWindow: mocks.regrab }));
vi.mock("../../src/lib/tearout/record", () => ({ TearoutRecord: class { outside() {} error() {} async finish() {} } }));
import { beginNativeGroupDrag, beginNativeWorkspaceDrag, usesNativeGroupDrag, usesNativeWorkspaceDrag } from "../../src/lib/tearout/pointerDrag";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { usePaneDragStore } from "../../src/stores/paneDragStore";
import type { Workspace } from "../../src/types";

const item = { kind: "pane" as const, workspaceId: "source", paneId: "region", label: "group", tabCount: 2 };
let strip: HTMLDivElement, grip: HTMLSpanElement, sidebar: HTMLDivElement, row: HTMLDivElement;
let captured = false;
const callbacks = { suppress: vi.fn(), resolve: vi.fn(), commit: vi.fn() };
function pointer(type: string, x: number, y: number): PointerEvent {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, Object.fromEntries(Object.entries({ button: 0, pointerId: 1, clientX: x, clientY: y }).map(([key, value]) => [key, { value }])));
  return event as PointerEvent;
}
function capture(element: HTMLElement) {
  Object.assign(element, { setPointerCapture: () => { captured = true; }, hasPointerCapture: () => captured,
    releasePointerCapture: () => { captured = false; } });
}
beforeEach(() => {
  vi.clearAllMocks(); captured = false; mocks.canRegrab.mockReturnValue(false);
  Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
  useSettingsStore.setState({ nativePaneTearoutEnabled: true });
  useWorkspaceListStore.setState({ workspaces: [{ id: "source", name: "source", createdAt: 1, status: "running", gridTemplateId: "1x1",
    panes: [{ id: "region", agentId: "shell", sessionId: "pty-a", tabs: ["a", "b"].map(id => ({ id, agentId: "shell", sessionId: `pty-${id}`, type: "terminal" })) }],
  } as Workspace], activeWorkspaceId: "source" });
  strip = document.createElement("div"); strip.className = "pane-tabbar";
  grip = document.createElement("span"); strip.append(grip); document.body.append(strip);
  sidebar = document.createElement("div"); sidebar.dataset.dndWorkspaceSidebar = "true";
  row = document.createElement("div"); sidebar.append(row); document.body.append(sidebar);
  strip.getBoundingClientRect = () => new DOMRect(0, 0, 300, 36);
  grip.getBoundingClientRect = () => new DOMRect(10, 0, 80, 36);
  sidebar.getBoundingClientRect = () => new DOMRect(0, 0, 200, 500);
  row.getBoundingClientRect = () => new DOMRect(0, 30, 200, 40);
  capture(grip); capture(row);
});
afterEach(() => {
  window.dispatchEvent(pointer("pointercancel", 0, 0));
  strip.remove(); sidebar.remove(); usePaneDragStore.getState().clearDrag();
  useSettingsStore.setState({ nativePaneTearoutEnabled: false });
});

describe("native group entry boundaries", () => {
  it("OFF, macOS and an ineligible session retain the original entry", () => {
    useSettingsStore.setState({ nativePaneTearoutEnabled: false });
    expect(usesNativeGroupDrag(item)).toBe(false); expect(usesNativeWorkspaceDrag("source")).toBe(false);
    // macOS with its own switch off (the Mac default is on since 0.83.0).
    useSettingsStore.setState({ nativePaneTearoutEnabled: true, macNativePaneTearoutEnabled: false });
    Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
    expect(usesNativeGroupDrag(item)).toBe(false); expect(usesNativeWorkspaceDrag("source")).toBe(false);
    Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
    const ws = useWorkspaceListStore.getState().workspaces[0];
    useWorkspaceListStore.setState({ workspaces: [{ ...ws, panes: [{ ...ws.panes[0], tabs: [{ ...ws.panes[0].tabs[0], ephemeral: true }] }] }] });
    expect(usesNativeGroupDrag(item)).toBe(false); expect(usesNativeWorkspaceDrag("source")).toBe(false);
  });
  it("region whitespace keeps the 9px start and strict 12px exit, releasing capture before one transfer", async () => {
    expect(usesNativeGroupDrag(item)).toBe(true);
    mocks.pane.mockImplementationOnce(async () => { expect(captured).toBe(false); });
    beginNativeGroupDrag(pointer("pointerdown", 20, 10), grip, item, callbacks);
    window.dispatchEvent(pointer("pointermove", 28, 10)); expect(usePaneDragStore.getState().item).toBeNull();
    window.dispatchEvent(pointer("pointermove", 29, 10)); expect(usePaneDragStore.getState().item).toMatchObject(item);
    window.dispatchEvent(pointer("pointermove", 29, 48)); expect(mocks.pane).not.toHaveBeenCalled();
    window.dispatchEvent(pointer("pointermove", 29, 48.1));
    window.dispatchEvent(pointer("pointermove", 29, 90)); await Promise.resolve();
    expect(mocks.pane).toHaveBeenCalledOnce(); expect(usePaneDragStore.getState().item).toBeNull();
  });
  it("an existing whole-region child regrabs after 9px without a new spare", () => {
    mocks.canRegrab.mockReturnValue(true);
    beginNativeGroupDrag(pointer("pointerdown", 20, 10), grip, item, callbacks);
    window.dispatchEvent(pointer("pointermove", 29, 10));
    expect(mocks.regrab).toHaveBeenCalledOnce(); expect(mocks.pane).not.toHaveBeenCalled(); expect(captured).toBe(false);
  });
  it("workspace vertical movement stays reorderable inside the sidebar; horizontal exit moves it once", async () => {
    expect(usesNativeWorkspaceDrag("source")).toBe(true);
    mocks.workspace.mockImplementationOnce(async () => { expect(captured).toBe(false); });
    beginNativeWorkspaceDrag(pointer("pointerdown", 50, 50), row, "source", callbacks);
    window.dispatchEvent(pointer("pointermove", 50, 150));
    await vi.waitFor(() => expect(callbacks.resolve).toHaveBeenCalledWith(50, 150), { timeout: 1000 });
    expect(mocks.workspace).not.toHaveBeenCalled();
    window.dispatchEvent(pointer("pointermove", 212, 150)); expect(mocks.workspace).not.toHaveBeenCalled();
    window.dispatchEvent(pointer("pointermove", 212.1, 150));
    window.dispatchEvent(pointer("pointermove", 240, 150)); await Promise.resolve();
    expect(mocks.workspace).toHaveBeenCalledOnce(); expect(captured).toBe(false);
  });
  it("Esc before exit cancels group and workspace entries without detaching", () => {
    for (const workspace of [false, true]) {
      if (workspace) beginNativeWorkspaceDrag(pointer("pointerdown", 50, 50), row, "source", callbacks);
      else beginNativeGroupDrag(pointer("pointerdown", 20, 10), grip, item, callbacks);
      window.dispatchEvent(pointer("pointermove", 40, 20));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    }
    expect(mocks.pane).not.toHaveBeenCalled(); expect(mocks.workspace).not.toHaveBeenCalled(); expect(captured).toBe(false);
  });
});
