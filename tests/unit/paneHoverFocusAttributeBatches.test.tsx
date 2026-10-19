// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useUiStore } from "../../src/stores/uiStore";
import { setup, cleanup, mount, content, textarea, pointer, advance, mocks } from "./paneHoverFocusHarness";

beforeEach(() => setup()); afterEach(cleanup);
const active = () => useUiStore.getState().activePaneId;
async function aim(x = 20) { await act(async () => { pointer(content(), "pointermove", { clientX: x }); }); }
interface Excursion { name: string; initial: Record<string, string>; steps: Array<[string, string | null]> }
const excursions: Excursion[] = [
  { name: "role region-alertdialog-region", initial: { role: "region" }, steps: [["role", "alertdialog"], ["role", "region"]] },
  { name: "role region-dialog-region", initial: { role: "region" }, steps: [["role", "dialog"], ["role", "region"]] },
  { name: "role region-menu-region", initial: { role: "region" }, steps: [["role", "menu"], ["role", "region"]] },
  { name: "popover class", initial: { class: "decorative" }, steps: [["class", "decorative cmux-popover-panel"], ["class", "decorative"]] },
  { name: "backdrop class", initial: { class: "decorative" }, steps: [["class", "cmux-overlay-backdrop decorative"], ["class", "decorative"]] },
  { name: "aria-modal false-true-false", initial: { "aria-modal": "false" }, steps: [["aria-modal", "true"], ["aria-modal", "false"]] },
  { name: "overlay root presence", initial: {}, steps: [["data-cmux-overlay-root", ""], ["data-cmux-overlay-root", null]] },
  { name: "overlay ignore removal", initial: { "data-cmux-overlay-root": "true", "data-pane-hover-focus-ignore": "" },
    steps: [["data-pane-hover-focus-ignore", null], ["data-pane-hover-focus-ignore", ""]] },
  { name: "native webview occluder presence", initial: {}, steps: [["data-cmux-native-webview-occluder", ""], ["data-cmux-native-webview-occluder", null]] },
  { name: "explicit blocker presence", initial: {}, steps: [["data-pane-hover-focus-blocker", ""], ["data-pane-hover-focus-blocker", null]] },
  // Neither the final root attribute nor replaying only one attribute against the final DOM reveals this opening.
  { name: "overlay root and ignore interleaving", initial: { "data-pane-hover-focus-ignore": "true" },
    steps: [["data-cmux-overlay-root", ""], ["data-pane-hover-focus-ignore", null], ["data-cmux-overlay-root", null], ["data-pane-hover-focus-ignore", "true"]] },
  { name: "role and class interleaving", initial: { role: "region" },
    steps: [["role", "alertdialog"], ["class", "cmux-popover-panel"], ["role", "region"], ["class", null]] },
];
function apply(element: Element, [name, value]: [string, string | null]) {
  if (value === null) element.removeAttribute(name); else element.setAttribute(name, value);
}
function connected(initial: Record<string, string>) {
  const element = document.createElement("div");
  for (const entry of Object.entries(initial)) apply(element, entry);
  document.body.append(element); return element;
}

describe("HF-R2-01 attribute history within a real observer batch", () => {
  describe.each(["dwell", "acquisition"])("during %s", (phase) => {
    it.each(excursions)("HF-R2-01 cancels $name even when the final DOM is unchanged", async ({ initial, steps }) => {
      const element = connected(initial), original = element.outerHTML;
      await mount(); await aim(); await advance(phase === "dwell" ? 50 : 100, phase === "dwell");
      expect(active()).toBe("a");
      await act(async () => {
        expect(element.isConnected).toBe(true);
        for (const step of steps) apply(element, step);
        expect(element.outerHTML).toBe(original);
      });
      await advance(200); expect(active()).toBe("a"); expect(mocks.focus.get("b")).not.toHaveBeenCalled();
      await aim(21); await advance(100); expect(active()).toBe("b"); expect(document.activeElement).toBe(textarea());
    });
  });
  it("HF-R2-01 conservatively cancels a hidden blocker's attribute excursion", async () => {
    const element = connected({ role: "region", hidden: "" });
    await mount(); await aim(); await advance(50);
    await act(async () => { element.setAttribute("role", "alertdialog"); element.setAttribute("role", "region"); });
    await advance(100); expect(active()).toBe("a");
    await aim(21); await advance(100); expect(active()).toBe("b");
  });
  it("HF-R2-01 retains dwell when another selector keeps a hidden element a blocker throughout", async () => {
    const element = connected({ role: "alertdialog", hidden: "" });
    await mount(); await aim(); await advance(50);
    await act(async () => {
      element.className = "cmux-popover-panel";
      element.setAttribute("role", "menu");
      element.className = "decorative";
    });
    await advance(49); expect(active()).toBe("a");
    await advance(1); expect(active()).toBe("b");
  });
  it("HF-R2-01 retains dwell when an ignored overlay root is only decorated or its marker values change", async () => {
    const element = connected({ "data-cmux-overlay-root": "true", "data-pane-hover-focus-ignore": "true", role: "region" });
    await mount(); await aim(); await advance(50);
    await act(async () => {
      element.setAttribute("data-cmux-overlay-root", "false");
      element.setAttribute("data-pane-hover-focus-ignore", "false");
      element.className = "decorative-cmux-popover-panel";
      element.setAttribute("role", "article");
    });
    await advance(50); expect(active()).toBe("b");
  });
  it("HF-R2-02 still detects a real popup inside xterm when its ancestor becomes visible", async () => {
    await mount();
    const ancestor = document.createElement("section"), popup = document.createElement("div");
    popup.setAttribute("role", "menu"); ancestor.hidden = true; ancestor.append(popup);
    await act(async () => { textarea().parentElement!.append(ancestor); });
    await aim(); await advance(50);
    await act(async () => { ancestor.hidden = false; });
    await act(async () => { ancestor.hidden = true; });
    await advance(100); expect(active()).toBe("a");
    await aim(21); await advance(100); expect(active()).toBe("b");
  });
  it("HF-R2-02 still detects a leaf becoming a real popup inside xterm", async () => {
    await mount();
    const popup = document.createElement("div"); popup.setAttribute("role", "region");
    await act(async () => { textarea().parentElement!.append(popup); });
    await aim(); await advance(50);
    await act(async () => { popup.setAttribute("role", "menu"); popup.setAttribute("role", "region"); });
    await advance(100); expect(active()).toBe("a");
    await aim(21); await advance(100); expect(active()).toBe("b");
  });
});
