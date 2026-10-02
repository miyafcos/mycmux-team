// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ transfer: vi.fn(async () => {}), regrab: vi.fn(async () => {}), canRegrab: vi.fn(() => false) }));
vi.mock("../../src/lib/tearout/runtime", () => ({
  tearoutTab: mocks.transfer, installTearoutRuntime: () => () => {},
  canRegrabTearoutTab: mocks.canRegrab, regrabTearoutWindow: mocks.regrab,
}));
vi.mock("../../src/lib/tearout/record", () => ({ TearoutRecord: class {
  outside() {} error() {} async finish() {}
} }));
import { usePaneDragSource } from "../../src/hooks/usePaneDragSource";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { usePaneDragStore } from "../../src/stores/paneDragStore";
import { outsideTearoutStrip } from "../../src/lib/tearout/model";
import type { Workspace } from "../../src/types";

const item = { kind: "tab" as const, workspaceId: "source", paneId: "pane", tabId: "tab", label: "Terminal" };
function Harness() {
  const { beginPointerDrag } = usePaneDragSource();
  return <div className="pane-tabbar"><span data-source="true" onPointerDown={(e) => beginPointerDrag(e, item)} /></div>;
}
function pointer(type: string, x: number, y: number): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, Object.fromEntries(Object.entries({ button: 0, pointerId: 1,
    clientX: x, clientY: y, screenX: x, screenY: y }).map(([key, value]) => [key, { value }])));
  return event;
}
let root: Root;
let container: HTMLDivElement;
let source: HTMLElement;
let captured = false;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
  vi.clearAllMocks();
  mocks.canRegrab.mockReturnValue(false);
  captured = false;
  useSettingsStore.setState({ nativePaneTearoutEnabled: false });
  useWorkspaceListStore.setState({ workspaces: [{ id: "source", name: "source", createdAt: 1,
    gridTemplateId: "1x1", status: "running", splitColumns: [["pane"]], panes: [{ id: "pane", agentId: "shell",
      sessionId: "pty-test", activeTabId: "tab", tabs: [{ id: "tab", sessionId: "pty-test", agentId: "shell", type: "terminal" }] }],
  } as Workspace], activeWorkspaceId: "source" });
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
  source = container.querySelector<HTMLElement>("[data-source]")!;
  Object.assign(source, { setPointerCapture: () => { captured = true; }, hasPointerCapture: () => captured,
    releasePointerCapture: () => { captured = false; }, getBoundingClientRect: () => new DOMRect(0, 0, 90, 36) });
  source.parentElement!.getBoundingClientRect = () => new DOMRect(0, 0, 300, 36);
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => null });
});
afterEach(async () => {
  await act(async () => {
    window.dispatchEvent(pointer("pointerup", 30, 20));
    root.unmount();
    usePaneDragStore.getState().clearDrag();
  });
  container.remove();
  useSettingsStore.setState({ nativePaneTearoutEnabled: false });
  vi.unstubAllGlobals();
});
describe("real drag entry routing", () => {
  it("regrabs an existing one-pane window after 9px without taking a spare", async () => {
    useSettingsStore.setState({ nativePaneTearoutEnabled: true });
    mocks.canRegrab.mockReturnValue(true);
    await act(async () => {
      source.dispatchEvent(pointer("pointerdown", 10, 10));
      window.dispatchEvent(pointer("pointermove", 18, 10));
    });
    expect(mocks.regrab).not.toHaveBeenCalled();
    await act(async () => window.dispatchEvent(pointer("pointermove", 19, 10)));
    expect(mocks.regrab).toHaveBeenCalledOnce();
    expect(mocks.transfer).not.toHaveBeenCalled();
    expect(captured).toBe(false);
  });
  it("OFF enters the legacy drag store and never starts the native transfer", async () => {
    await act(async () => {
      source.dispatchEvent(pointer("pointerdown", 10, 10));
      window.dispatchEvent(pointer("pointermove", 10, 60));
    });
    expect(usePaneDragStore.getState().item).toMatchObject(item);
    expect(mocks.transfer).not.toHaveBeenCalled();
  });
  it("ON reorders within the strip and releases capture before transfer at 12px", async () => {
    useSettingsStore.setState({ nativePaneTearoutEnabled: true });
    mocks.transfer.mockImplementationOnce(async () => { expect(captured).toBe(false); });
    await act(async () => {
      source.dispatchEvent(pointer("pointerdown", 10, 10));
      window.dispatchEvent(pointer("pointermove", 20, 10));
      window.dispatchEvent(pointer("pointermove", 20, 48));
    });
    expect(mocks.transfer).not.toHaveBeenCalled();
    await act(async () => window.dispatchEvent(pointer("pointermove", 20, 48.1)));
    expect(mocks.transfer).toHaveBeenCalledOnce();
    expect(usePaneDragStore.getState().item).toBeNull();
  });
  it("the strip margin is strict on each edge", () => {
    const r = { x: 100, y: 100, width: 300, height: 36 };
    for (const [x, y] of [[88, 120], [412, 120], [200, 88], [200, 148]]) expect(outsideTearoutStrip(x, y, r)).toBe(false);
    for (const [x, y] of [[87.9, 120], [412.1, 120], [200, 87.9], [200, 148.1]]) expect(outsideTearoutStrip(x, y, r)).toBe(true);
  });
});
