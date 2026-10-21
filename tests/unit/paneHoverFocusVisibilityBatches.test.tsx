// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "../../src/stores/uiStore";
import { setup, cleanup, mount, content, textarea, pointer, advance, mocks } from "./paneHoverFocusHarness";

beforeEach(() => setup()); afterEach(cleanup);
const active = () => useUiStore.getState().activePaneId;
async function aim(x = 20) { await act(async () => { pointer(content(), "pointermove", { clientX: x }); }); }
const excursions = [
  { name: "hidden", attribute: "hidden", hidden: "", shown: null },
  { name: "inert", attribute: "inert", hidden: "", shown: null },
  { name: "aria-hidden", attribute: "aria-hidden", hidden: "true", shown: "false" },
  { name: "display:none", attribute: "style", hidden: "display: none;", shown: "display: block;" },
  { name: "visibility:hidden", attribute: "style", hidden: "visibility: hidden;", shown: "visibility: visible;" },
  { name: "stylesheet class", attribute: "class", hidden: "hf-r3-hidden", shown: "hf-r3-shown" },
];
function apply(element: Element, attribute: string, value: string | null) {
  if (value === null) element.removeAttribute(attribute); else element.setAttribute(attribute, value);
}
function fixture(attribute: string, value: string) {
  const ancestor = document.createElement("section"), popup = document.createElement("div");
  popup.setAttribute("role", "alertdialog"); ancestor.setAttribute(attribute, value); ancestor.append(popup);
  document.body.append(ancestor); return { ancestor, popup };
}

describe("HF-R3-02 visibility history within a native observer batch", () => {
  it("HF-R4-02 keeps declaration order when logical and physical dimensions compete", async () => {
    const hidden = "inline-size:20px; width:0px; height:20px; padding:0; border:0";
    const shown = "width:0px; inline-size:20px; height:20px; padding:0; border:0";
    const { ancestor, popup } = fixture("style", hidden);
    const dimensions = () => {
      const declarations = Array.from({ length: ancestor.style.length }, (_, index) => ancestor.style.item(index));
      const width = declarations.indexOf("width") > declarations.indexOf("inline-size") ? 0 : 20;
      return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: 20, width, height: 20, toJSON() {} };
    };
    Object.defineProperty(popup, "getBoundingClientRect", { value: dimensions, configurable: true });
    Object.defineProperty(popup, "getClientRects", { value: () => [dimensions()], configurable: true });
    await mount(); await aim(); await advance(50);
    const original = ancestor.outerHTML;
    await act(async () => {
      expect(popup.getBoundingClientRect().width).toBe(0);
      ancestor.setAttribute("style", shown); expect(popup.getBoundingClientRect().width).toBe(20);
      ancestor.setAttribute("style", hidden); expect(popup.getBoundingClientRect().width).toBe(0);
      expect(ancestor.outerHTML).toBe(original);
    });
    await advance(100); expect(active()).toBe("a");
    await aim(21); await advance(100); expect(active()).toBe("b");
  });

  describe.each(["dwell", "acquisition"])("during %s", (phase) => {
    it.each(excursions)("HF-R3-02 cancels $name hidden-shown-hidden on an alertdialog ancestor", async ({ attribute, hidden, shown }) => {
      const style = document.createElement("style"); style.textContent = ".hf-r3-hidden { display: none; }"; document.head.append(style);
      const { ancestor, popup } = fixture(attribute, hidden), original = ancestor.outerHTML;
      const NativeMutation = window.MutationObserver, batches: MutationRecord[][] = [];
      let measure = false;
      vi.stubGlobal("MutationObserver", class extends NativeMutation {
        constructor(callback: MutationCallback) { super((records, observer) => { if (measure) batches.push(records); callback(records, observer); }); }
      });
      await mount(); await aim(); await advance(phase === "dwell" ? 50 : 100, phase === "dwell");
      expect(active()).toBe("a"); measure = true;
      await act(async () => {
        expect(popup.isConnected).toBe(true); apply(ancestor, attribute, shown); apply(ancestor, attribute, hidden);
        expect(ancestor.outerHTML).toBe(original);
      });
      measure = false;
      expect(batches).toHaveLength(1); expect(batches[0]).toHaveLength(2);
      expect(batches[0].map((r) => [r.target === ancestor, r.attributeName, r.oldValue])).toEqual([
        [true, attribute, hidden], [true, attribute, shown],
      ]);
      await advance(200); expect(active()).toBe("a"); expect(mocks.focus.get("b")).not.toHaveBeenCalled();
      await aim(21); await advance(100); expect(active()).toBe("b"); expect(document.activeElement).toBe(textarea());
      style.remove();
    });
  });

  it("HF-R3-02 cancels interleaved visibility changes across two ancestors", async () => {
    const { ancestor, popup } = fixture("hidden", ""), inner = document.createElement("div");
    popup.replaceWith(inner); inner.append(popup);
    await mount(); await aim(); await advance(50);
    await act(async () => { ancestor.hidden = false; inner.style.display = "none"; });
    await advance(100); expect(active()).toBe("a");
    await aim(21); await advance(100); expect(active()).toBe("b");
  });

  it.each(["hidden", "inert", "aria-hidden"])("HF-02 retains dwell when an unchanged %s descendant conceals a class excursion", async (attribute) => {
    const { ancestor, popup } = fixture("class", "original"); popup.setAttribute(attribute, attribute === "aria-hidden" ? "true" : "");
    await mount(); await aim(); await advance(50);
    await act(async () => { ancestor.className = "decorative"; ancestor.className = "original"; });
    await advance(49); expect(active()).toBe("a"); await advance(1); expect(active()).toBe("b");
  });

  it("HF-02 retains dwell through repeated opacity decoration around a CSS-hidden popup", async () => {
    const { ancestor, popup } = fixture("class", "original"); popup.style.display = "none";
    await mount(); await aim(); await advance(50);
    await act(async () => { for (let i = 0; i < 1000; i++) ancestor.style.opacity = String((i % 99 + 1) / 100); });
    await advance(49); expect(active()).toBe("a"); await advance(1); expect(active()).toBe("b");
  });

  it.each(["hidden", "inert", "aria-hidden", "style", "class"])("HF-R3-02 ignores repeated semantic no-op writes of %s", async (attribute) => {
    const value = attribute === "style" ? "display: none;" : attribute === "aria-hidden" ? "true" : "";
    const { ancestor, popup } = fixture(attribute, value); popup.hidden = true;
    await mount(); await aim(); await advance(50);
    await act(async () => { ancestor.setAttribute(attribute, value); ancestor.setAttribute(attribute, value); });
    await advance(50); expect(active()).toBe("b");
  });
});
