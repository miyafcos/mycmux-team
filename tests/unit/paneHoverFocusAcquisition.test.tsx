// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setup, cleanup, mount, content, textarea, pointer, advance, mocks } from "./paneHoverFocusHarness";
import { useUiStore } from "../../src/stores/uiStore";
import { focusController } from "../../src/lib/focusController";

beforeEach(() => setup()); afterEach(cleanup);
const active = () => useUiStore.getState().activePaneId;
async function pending(phase: string) {
  await mount(); await act(async () => { textarea("a").focus(); pointer(content(), "pointermove"); });
  if (phase === "retry") mocks.refused.add("b");
  await advance(100, false); if (phase === "retry") await advance(0);
  expect(active()).toBe("a");
}
describe("R2 pending acquisition follows the current surface", () => {
  it.each(["first-frame", "retry"])("R2 return to A during %s cancels B even after stationary dwell", async (phase) => {
    await pending(phase);
    await act(async () => {
      pointer(content(), "pointerleave", { relatedTarget: content("a") });
      pointer(content("a"), "pointerenter", { relatedTarget: content() });
      pointer(content("a"), "pointermove", { clientX: 30 });
    });
    const attempts = mocks.focus.get("b")!.mock.calls.length;
    mocks.refused.delete("b"); await advance(0); await advance(200);
    expect(active()).toBe("a"); expect(document.activeElement).toBe(textarea("a"));
    expect(mocks.focus.get("b")).toHaveBeenCalledTimes(attempts);
  });
  it.each(["first-frame", "retry"])("R2 moving within B during %s preserves one acquisition", async (phase) => {
    const request = vi.spyOn(focusController, "commit");
    await pending(phase);
    // TerminalPane uses request; the harness already observes it without replacing behavior.
    const requests = vi.mocked(focusController.request);
    const before = requests.mock.calls.filter(([source]) => source === "hover").length;
    await act(async () => { for (let x = 21; x < 30; x++) pointer(content().querySelector("[data-line]")!, "pointermove", { clientX: x }); });
    mocks.refused.delete("b"); await advance(phase === "retry" ? 16 : 0);
    expect(active()).toBe("b"); expect(document.activeElement).toBe(textarea());
    await advance(200);
    expect(requests.mock.calls.filter(([source]) => source === "hover")).toHaveLength(before);
    expect(useUiStore.getState().focusRevision).toBe(1); expect(request).not.toHaveBeenCalled();
  });
  it.each(["outside", "excluded"])("R2 pending acquisition cancels on movement to %s", async (where) => {
    await pending("first-frame");
    const target = where === "outside" ? document.body : content().querySelector("[data-line]")!;
    if (where === "excluded") target.setAttribute("contenteditable", "true");
    await act(async () => { pointer(target, "pointermove", { clientX: 30 }); });
    await advance(0); await advance(200); expect(active()).toBe("a"); expect(document.activeElement).toBe(textarea("a"));
  });
  it("R1/R2 control: same-owner explicit cancellation permits a fresh B dwell", async () => {
    useUiStore.setState({ lastActivePaneId: "a" });
    await pending("first-frame");
    await act(async () => { focusController.commit("programmatic", "a", { focus: false }); });
    await advance(0); expect(active()).toBe("a");
    await act(async () => { pointer(content(), "pointermove", { clientX: 31 }); });
    await advance(99); expect(active()).toBe("a");
    await advance(1); expect(active()).toBe("b"); expect(document.activeElement).toBe(textarea());
  });
});
