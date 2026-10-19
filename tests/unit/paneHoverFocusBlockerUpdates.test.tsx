// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useUiStore } from "../../src/stores/uiStore";
import { setup, cleanup, mount, content, textarea, pointer, advance } from "./paneHoverFocusHarness";

beforeEach(() => setup()); afterEach(cleanup);
const active = () => useUiStore.getState().activePaneId;
async function aim(x = 20) { await act(async () => { pointer(content(), "pointermove", { clientX: x }); }); }
const hiddenModes = ["hidden", "display:none", "visibility:hidden", "ancestor hidden", "ancestor display:none", "aria-hidden", "inert"] as const;
function confirmation(mode: typeof hiddenModes[number]) {
  const ancestor = document.createElement("div"), blocker = document.createElement("div");
  blocker.setAttribute("role", "alertdialog"); ancestor.append(blocker); document.body.append(ancestor);
  const hidden = mode.startsWith("ancestor") ? ancestor : blocker;
  const show = () => {
    hidden.hidden = false; hidden.style.display = ""; hidden.style.visibility = "";
    hidden.removeAttribute("aria-hidden"); hidden.removeAttribute("inert");
  };
  switch (mode) {
    case "hidden": case "ancestor hidden": hidden.hidden = true; break;
    case "display:none": case "ancestor display:none": hidden.style.display = "none"; break;
    case "visibility:hidden": hidden.style.visibility = "hidden"; break;
    case "aria-hidden": hidden.setAttribute("aria-hidden", "true"); break;
    case "inert": hidden.setAttribute("inert", ""); break;
  }
  return { ancestor, blocker, show };
}

describe("HF-02 visible blocker membership", () => {
  describe.each(["class", "style"])("ancestor %s changes", (attribute) => {
    it.each(hiddenModes)("HF02 preserves dwell with a %s confirmation descendant", async (mode) => {
      const { ancestor } = confirmation(mode);
      await mount(); await aim(); await advance(50);
      await act(async () => {
        if (attribute === "class") ancestor.className = "decorated";
        else ancestor.style.opacity = "0.99";
      });
      await advance(49); expect(active()).toBe("a");
      await advance(1); expect(active()).toBe("b"); expect(document.activeElement).toBe(textarea());
    });
  });
  it.each(hiddenModes)("HF02 cancels when a %s confirmation becomes visible, even if hidden again", async (mode) => {
    const { blocker, show } = confirmation(mode);
    await mount(); await aim(); await advance(50);
    await act(async () => { show(); });
    await act(async () => { blocker.hidden = true; });
    await advance(50); await advance(100); expect(active()).toBe("a");
    await aim(21); await advance(100); expect(active()).toBe("b");
  });
  it("HF02 sees visibility transitions caused by an ancestor class", async () => {
    const { ancestor } = confirmation("hidden");
    ancestor.firstElementChild!.removeAttribute("hidden");
    const style = document.createElement("style"); style.textContent = ".confirmation-hidden { display: none; }";
    document.head.append(style); ancestor.className = "confirmation-hidden";
    try {
      await mount(); await aim(); await advance(50);
      await act(async () => { ancestor.className = "confirmation-visible"; });
      await act(async () => { ancestor.className = "confirmation-hidden"; });
      await advance(50); expect(active()).toBe("a");
      await aim(21); await advance(100); expect(active()).toBe("b");
    } finally { style.remove(); }
  });
  it.each(["visible", "hidden", "nested hidden"])("HF02 cancels a brief %s blocker insertion and removal in one observer batch", async (mode) => {
    await mount(); await aim(); await advance(50);
    await act(async () => {
      const blocker = document.createElement("div"); blocker.setAttribute("role", "alertdialog");
      blocker.hidden = mode !== "visible";
      const added = mode === "nested hidden" ? document.createElement("section") : blocker;
      if (added !== blocker) added.append(blocker);
      document.body.append(added); added.remove();
    });
    await advance(50); expect(active()).toBe("a");
    await aim(21); await advance(100); expect(active()).toBe("b");
  });
  it.each(["is-closing", "inert", "aria-hidden"])("HF02 connected overlay root still blocks while %s", async (state) => {
    await mount(); await aim(); await advance(50);
    const overlay = document.createElement("div"); overlay.setAttribute("data-cmux-overlay-root", "true");
    overlay.style.display = "none";
    if (state === "is-closing") overlay.className = "is-closing";
    else overlay.setAttribute(state, state === "aria-hidden" ? "true" : "");
    await act(async () => { document.body.append(overlay); });
    await advance(50); expect(active()).toBe("a");
    await aim(21); await advance(100); expect(active()).toBe("a");
    await act(async () => { overlay.remove(); });
    await advance(100); expect(active()).toBe("a");
    await aim(22); await advance(100); expect(active()).toBe("b");
  });
});
