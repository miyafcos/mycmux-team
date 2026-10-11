// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setup, cleanup, mount, workspace, pane, content, textarea, pointer, advance, mocks, root, field } from "./paneHoverFocusHarness";
import { useUiStore } from "../../src/stores/uiStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { applyExternalStoreUpdate } from "../../src/stores/syncedPersist";
import { registerTerminalFocusSync } from "../../src/components/terminal/terminalFocusHelpers";

beforeEach(() => setup()); afterEach(cleanup);
const active = () => useUiStore.getState().activePaneId;
async function acquireB() {
  await mount(workspace([pane("a"), pane("b"), pane("c")]));
  await act(async () => { textarea("a").focus(); pointer(content(), "pointermove"); });
  await advance(); expect(active()).toBe("b");
}
async function typeB() {
  await act(async () => {
    const owner = document.activeElement as HTMLTextAreaElement;
    owner.dispatchEvent(new KeyboardEvent("keydown", { key: "b", bubbles: true }));
    owner.value = "b"; owner.dispatchEvent(new InputEvent("input", { data: "b", bubbles: true }));
  });
  expect(mocks.accepted).toEqual([["b", "b"]]);
}
describe("R1 hover recovery lifetime", () => {
  it.each(["receipt", "setter"])("R1 hover then click via %s restores ordinary DOM reconciliation", async (mode) => {
    await acquireB();
    await act(async () => {
      if (mode === "receipt") applyExternalStoreUpdate(useSettingsStore, { paneFocusMode: "click" });
      else useSettingsStore.getState().setPaneFocusMode("click");
      textarea("a").focus(); // Real registered focus observer, no controller selection.
    });
    await advance(0); expect(active()).toBe("b"); expect(document.activeElement).toBe(textarea());
    await typeB();
  });
  it.each(["key", "layout"])("R1 invalidation by %s cannot taint a later independent focus observation", async (reason) => {
    await acquireB();
    await act(async () => {
      if (reason === "key") textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", bubbles: true }));
      else window.dispatchEvent(new Event("mycmux:terminal-layout-change"));
      textarea("a").focus();
    });
    await advance(0); expect(document.activeElement).toBe(textarea()); await typeB();
  });
  it.each(["key", "exhausted"])("R1 canceled %s acquisition leaves future ordinary reconciliation usable", async (reason) => {
    await mount(workspace([pane("a"), pane("b"), pane("c")]));
    await act(async () => { textarea("a").focus(); pointer(content(), "pointermove"); });
    if (reason === "exhausted") mocks.refused.add("b");
    await advance(100, false);
    if (reason === "key") await act(async () => { textarea("a").dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true })); });
    else { await advance(0); for (let i = 0; i < 9; i++) await advance(50); }
    await advance(0); expect(active()).toBe("a");
    await act(async () => { textarea("c").focus(); });
    await advance(0); expect(active()).toBe("a"); expect(document.activeElement).toBe(textarea("a"));
  });
  it("R1 last unmount disposes ownership while new registered targets retain click arbitration", async () => {
    await acquireB(); await act(async () => { root.render(null); });
    const targets = ["a", "b"].map((id) => {
      const element = document.createElement("div"), input = document.createElement("textarea");
      input.className = "xterm-helper-textarea"; element.append(input); document.body.append(element);
      const dispose = registerTerminalFocusSync({ element, focus: () => input.focus() } as any, id);
      return { input, dispose };
    });
    try {
      await act(async () => { targets[0].input.focus(); }); await advance(0);
      expect(active()).toBe("b"); expect(document.activeElement).toBe(targets[1].input);
    } finally { targets.forEach((t) => t.dispose()); }
  });
  it.each(["editor", "composition"])("R1 already queued recovery retains %s protection after ownership disposal", async (kind) => {
    await acquireB();
    const { focusController } = await import("../../src/lib/focusController");
    let owner: Element;
    await act(async () => {
      expect(focusController.shouldAcceptTerminalInput("a")).toBe(false);
      if (kind === "editor") owner = field();
      else { owner = textarea(); owner.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); }
    });
    const attempts = mocks.focus.get("b")!.mock.calls.length;
    await advance(0); await advance(500);
    expect(document.activeElement).toBe(owner!); expect(mocks.focus.get("b")).toHaveBeenCalledTimes(attempts);
  });
});
