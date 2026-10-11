// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setup, cleanup, mount, workspace, pane, content, textarea, pointer, advance, field, mocks } from "./paneHoverFocusHarness";
import { focusController } from "../../src/lib/focusController";
import { useUiStore } from "../../src/stores/uiStore";

beforeEach(() => setup());
afterEach(cleanup);
const active = () => useUiStore.getState().activePaneId;

async function startHandoff() {
  await act(async () => { textarea("a").focus(); pointer(content(), "pointermove"); });
  await advance(100, false); // Hold every B focus frame, with A actually focused.
}

function keyAndInput(key: string) {
  const owner = document.activeElement as HTMLTextAreaElement;
  owner.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey: key === "Shift", bubbles: true }));
  if (key !== "Shift") {
    owner.value = key;
    owner.dispatchEvent(new InputEvent("input", { data: key, inputType: "insertText", bubbles: true }));
  }
  return owner;
}

describe("F1 coherent hover handoff with real terminal focus observation", () => {
  it.each(["x", "Shift"])("F1 current focused A owns %s before B's first frame", async (key) => {
    await mount(); await startHandoff();
    let owner: Element;
    await act(async () => { owner = keyAndInput(key); });
    await advance(0);
    expect(owner!).toBe(textarea("a"));
    expect(mocks.accepted).toEqual(key === "Shift" ? [] : [["a", key]]);
    expect(active()).toBe("a"); expect(document.activeElement).toBe(textarea("a"));
    expect(mocks.focus.get("b")).not.toHaveBeenCalled();
  });

  it.each(["editor", "composition"])("F1 typing then %s cannot start unguarded recovery", async (protection) => {
    await mount(); await startHandoff();
    let protectedElement: Element;
    await act(async () => {
      keyAndInput("x");
      if (protection === "editor") protectedElement = field();
      else {
        protectedElement = document.activeElement!;
        protectedElement.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      }
    });
    await advance(0); await advance(500);
    expect(document.activeElement).toBe(protectedElement!);
    expect(mocks.accepted).toEqual([["a", "x"]]); expect(active()).toBe("a");
    expect(mocks.focus.get("b")).not.toHaveBeenCalled();
  });

  it("F1 no selection is committed until focus acquisition succeeds", async () => {
    await mount(); mocks.refused.add("b"); await startHandoff(); await advance(0);
    expect(mocks.focus.get("b")).toHaveBeenCalledOnce();
    expect(active()).toBe("a"); expect(document.activeElement).toBe(textarea("a"));
    mocks.refused.delete("b"); await advance(16);
    expect(active()).toBe("b"); expect(document.activeElement).toBe(textarea());
    expect(useUiStore.getState().focusRevision).toBe(1);
    await advance(500);
    expect(document.activeElement).toBe(textarea()); // Real focusin must not reconcile back to A.
    await act(async () => { keyAndInput("b"); });
    expect(mocks.accepted).toEqual([["b", "b"]]);
  });

  it("F1 exhausted focus attempts leave A as input owner", async () => {
    await mount(); mocks.refused.add("b"); await startHandoff();
    await advance(0); for (let i = 0; i < 10; i++) await advance(50);
    expect(mocks.focus.get("b")).toHaveBeenCalledTimes(8);
    await act(async () => { keyAndInput("x"); });
    expect(active()).toBe("a"); expect(document.activeElement).toBe(textarea("a"));
    expect(mocks.accepted).toEqual([["a", "x"]]);
  });

  it("F1 a new C candidate cannot leave B active with A's caret", async () => {
    await mount(workspace([pane("a"), pane("b"), pane("c")])); await startHandoff();
    await act(async () => { pointer(content("c"), "pointermove", { clientX: 30 }); });
    await advance(0);
    expect(active()).toBe("a"); expect(document.activeElement).toBe(textarea("a"));
    await advance(100); await advance(0);
    expect(active()).toBe("c"); expect(document.activeElement).toBe(textarea("c"));
  });

  it("F1 a newer explicit selection is never rolled back", async () => {
    await mount(workspace([pane("a"), pane("b"), pane("c")])); await startHandoff();
    await act(async () => { focusController.commit("keyboard", "c"); });
    await advance(0); await advance(500);
    expect(active()).toBe("c"); expect(document.activeElement).toBe(textarea("c"));
  });

  it.each(["editor", "composition"])("F1 input recovery after acquired hover retains the %s guard", async (protection) => {
    await mount(); await startHandoff(); await advance(0);
    expect(active()).toBe("b"); expect(document.activeElement).toBe(textarea());
    let protectedElement: Element;
    await act(async () => {
      // A late old-renderer input is rejected, but its recovery must retain hover provenance.
      expect(focusController.shouldAcceptTerminalInput("a")).toBe(false);
      if (protection === "editor") protectedElement = field();
      else {
        protectedElement = document.activeElement!;
        protectedElement.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      }
    });
    const before = mocks.focus.get("b")!.mock.calls.length;
    await advance(0); await advance(500);
    expect(document.activeElement).toBe(protectedElement!);
    expect(mocks.focus.get("b")).toHaveBeenCalledTimes(before);
    expect(active()).toBe("b"); expect(mocks.accepted).toEqual([]);
  });
});
