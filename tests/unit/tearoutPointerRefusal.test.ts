// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke }));
vi.mock("../../src/lib/tearout/runtime", () => ({
  tearoutTab: vi.fn(), tearoutPane: vi.fn(), tearoutWorkspace: vi.fn(),
  canRegrabTearoutTab: () => false, canRegrabTearoutPane: () => false, regrabTearoutWindow: vi.fn(),
}));
vi.mock("../../src/lib/windowContext", () => ({ windowLabel: () => "main" }));
import { beginNativePaneDrag, beginNativeWorkspaceDrag } from "../../src/lib/tearout/pointerDrag";
import { clearObservedTearoutMoves, endTearoutOperation } from "../../src/lib/tearout/operation";
import { usePaneDragStore } from "../../src/stores/paneDragStore";

function pointer(type: string, pointerId: number, x = 10): PointerEvent {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { pointerId, clientX: x, clientY: 10 });
  return event as PointerEvent;
}
const callbacks = () => ({ suppress: vi.fn(), resolve: vi.fn(), commit: vi.fn() });
const records = () => mocks.invoke.mock.calls.filter(([command, args]) => command === "tearout_log_record" && args.record.result)
  .map(([, args]) => args.record);
beforeEach(() => {
  vi.useFakeTimers(); mocks.invoke.mockReset().mockResolvedValue(undefined);
  endTearoutOperation(); clearObservedTearoutMoves();
  window.__MYCMUX_TEAROUT_PERF__ = false;
});
afterEach(async () => {
  window.dispatchEvent(new Event("blur"));
  await vi.runOnlyPendingTimersAsync();
  usePaneDragStore.getState().clearDrag();
  document.body.replaceChildren(); delete window.__MYCMUX_TEAROUT_PERF__;
  vi.useRealTimers();
});

it.each(["strip", "sidebar"] as const)("records the %s pointer owner's ID only after its record exists", async surface => {
  const region = document.createElement("div");
  region.className = "pane-tabbar"; region.dataset.dndWorkspaceSidebar = "true";
  region.getBoundingClientRect = () => new DOMRect(0, 0, 300, 300);
  const source = document.createElement("span"); region.append(source); document.body.append(region);
  source.getBoundingClientRect = () => new DOMRect(0, 0, 90, 36);
  Object.assign(source, { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() });
  const begin = (id: number, actions = callbacks()) => surface === "strip"
    ? beginNativePaneDrag(pointer("pointerdown", id), source,
      { kind: "tab", workspaceId: "source", paneId: "pane", tabId: "tab", label: "Terminal" }, actions)
    : beginNativeWorkspaceDrag(pointer("pointerdown", id), source, "source", actions);

  // The first owner has not crossed the reorder threshold and has no record.
  begin(1); begin(2);
  expect(records().at(-1)).toMatchObject({ refusal_source: "pointer", blocker_id: null, blocker_phase: "moving", result: "rejected_busy" });
  window.dispatchEvent(pointer("pointerup", 1));

  // The next owner creates its real record while still reordering locally.
  begin(3);
  window.dispatchEvent(pointer("pointermove", 3, 30));
  const refusedCallbacks = callbacks(); begin(4, refusedCallbacks);
  const refused = records().at(-1);
  window.dispatchEvent(pointer("pointerup", 3, 30));
  const owner = records().find(record => record.result === "reordered");
  expect(owner?.drag_id).toEqual(expect.any(String));
  expect(refused).toMatchObject({ refusal_source: "pointer", blocker_id: owner.drag_id, blocker_phase: "moving", result: "rejected_busy" });
  expect(refusedCallbacks.suppress).not.toHaveBeenCalled();

  // Cleanup clears both the pointer owner and its previous record identity.
  begin(5); begin(6);
  expect(records().at(-1)).toMatchObject({ refusal_source: "pointer", blocker_id: null });
  window.dispatchEvent(pointer("pointerup", 5));
});
