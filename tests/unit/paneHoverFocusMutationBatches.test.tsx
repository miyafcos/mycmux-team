// @vitest-environment jsdom
import { act } from "react";
import { performance as measurementClock } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "../../src/stores/uiStore";
import { setup, cleanup, mount, content, textarea, pointer, advance, mocks } from "./paneHoverFocusHarness";

beforeEach(() => setup()); afterEach(cleanup);
const active = () => useUiStore.getState().activePaneId;
const blockerSelector = (selector: string) => selector.includes("[data-pane-hover-focus-blocker]")
  && selector.includes("[data-cmux-overlay-root]");
async function aim(x = 20) { await act(async () => { pointer(content(), "pointermove", { clientX: x }); }); }
function trace() {
  const NativeMutation = window.MutationObserver;
  const batches: Array<{ records: MutationRecord[]; ms: number }> = [];
  let enabled = false;
  vi.stubGlobal("MutationObserver", class extends NativeMutation {
    constructor(callback: MutationCallback) {
      super((records, observer) => {
        const measured = enabled, start = measurementClock.now();
        try { callback(records, observer); }
        finally { if (measured) batches.push({ records, ms: measurementClock.now() - start }); }
      });
    }
  });
  return { batches, start: () => { enabled = true; }, stop: () => { enabled = false; } };
}
function searches() {
  const subtree = vi.spyOn(Element.prototype, "querySelector"), documentSearch = vi.spyOn(document, "querySelectorAll");
  return {
    subtrees: () => subtree.mock.calls.filter(([selector]) => blockerSelector(selector)).length,
    documents: () => documentSearch.mock.calls.filter(([selector]) => blockerSelector(selector)).length,
  };
}
function branch(parent: Element = document.body, size = 1) {
  const target = document.createElement("section");
  for (let i = 0; i < size; i++) { const child = document.createElement("span"); child.textContent = String(i); target.append(child); }
  parent.append(target); return target;
}

describe("HF-R3-01 bounded attribute relevance and P04", () => {
  it("HF-R4-01 walks blocker ancestors without a blocker-target cross product", async () => {
    const targets = Array.from({ length: 100 }, () => {
      const popup = document.createElement("div"); popup.setAttribute("role", "alertdialog"); popup.style.display = "none";
      document.body.append(popup); return popup;
    });
    await mount(); await aim(); await advance(50);
    const contains = vi.spyOn(Node.prototype, "contains");
    await act(async () => { for (const target of targets) target.style.transform = "translateX(1px)"; });
    expect(contains.mock.calls.length).toBeLessThan(targets.length * 10);
    await advance(50); expect(active()).toBe("b");
  });

  it("P04 reuses one target for 1000 unrelated records in one actual observer batch", async () => {
    const observed = trace(), target = branch(document.body, 100);
    await mount(); await aim(); await advance(50);
    const queries = searches(); observed.start();
    await act(async () => { for (let i = 0; i < 1000; i++) target.style.opacity = String((i % 99 + 1) / 100); });
    observed.stop();
    expect(observed.batches).toHaveLength(1);
    expect(observed.batches[0].records).toHaveLength(1000);
    expect(observed.batches[0].records.every((r) => r.target === target && r.attributeName === "style")).toBe(true);
    const subtreeSearches = queries.subtrees(), documentSearches = queries.documents();
    process.stdout.write(`P04 ${JSON.stringify({ records: 1000, descendants: 100,
      callbackMs: observed.batches[0].ms, subtreeSearches, documentSearches })}\n`);
    expect(subtreeSearches + documentSearches).toBe(1);
    await advance(49); expect(active()).toBe("a"); await advance(1); expect(active()).toBe("b");
  }, 30000);

  it("HF-R3-01 skips all attribute subtree searches when childList already requires a scan", async () => {
    const observed = trace(), target = branch();
    await mount(); await aim(); await advance(50);
    const popup = document.createElement("div"); popup.setAttribute("role", "dialog");
    const queries = searches(); observed.start();
    await act(async () => {
      document.body.append(popup); popup.remove();
      for (let i = 0; i < 1000; i++) target.style.opacity = String((i % 99 + 1) / 100);
    });
    observed.stop();
    expect(observed.batches).toHaveLength(1); expect(observed.batches[0].records).toHaveLength(1002);
    expect(queries.subtrees()).toBe(0); expect(queries.documents()).toBe(1);
    await advance(100); expect(active()).toBe("a"); expect(mocks.focus.get("b")).not.toHaveBeenCalled();
    await aim(21); await advance(100); expect(active()).toBe("b");
  });

  it.each([7, 8])("HF-R3-01 bounds disjoint subtree searches at %i unique non-leaf targets", async (count) => {
    const observed = trace(), targets = Array.from({ length: count }, () => branch());
    await mount(); await aim(); await advance(50);
    const queries = searches(); observed.start();
    await act(async () => { for (const target of targets) target.style.opacity = "0.9"; });
    observed.stop();
    expect(observed.batches).toHaveLength(1); expect(observed.batches[0].records).toHaveLength(count);
    expect(queries.subtrees()).toBe(count < 8 ? count : 0);
    expect(queries.documents()).toBe(count < 8 ? 0 : 1);
    await advance(50); expect(active()).toBe("b");
  });

  it("HF-R3-01 uses one document search for overlapping target subtrees", async () => {
    const observed = trace(), outer = branch(), inner = branch(outer);
    await mount(); await aim(); await advance(50);
    const queries = searches(); observed.start();
    await act(async () => { outer.style.opacity = "0.9"; inner.style.opacity = "0.8"; });
    observed.stop();
    expect(observed.batches).toHaveLength(1); expect(observed.batches[0].records).toHaveLength(2);
    expect(queries.subtrees()).toBe(0); expect(queries.documents()).toBe(1);
    await advance(50); expect(active()).toBe("b");
  });

  it("HF-R3-01 fallback still finds a hidden blocker ancestor's visibility excursion", async () => {
    const observed = trace(), targets = Array.from({ length: 8 }, () => branch());
    const popup = document.createElement("div"); popup.setAttribute("role", "alertdialog");
    targets[0].hidden = true; targets[0].append(popup);
    await mount(); await aim(); await advance(50);
    const queries = searches(); observed.start();
    await act(async () => {
      for (const target of targets) target.style.opacity = "0.9";
      targets[0].hidden = false; targets[0].hidden = true;
    });
    observed.stop();
    expect(observed.batches).toHaveLength(1); expect(queries.subtrees()).toBe(0); expect(queries.documents()).toBe(1);
    await advance(100); expect(active()).toBe("a");
    await aim(21); await advance(100); expect(active()).toBe("b");
  });
});

describe("HF-R3-03 wrapped popups and terminal render churn", () => {
  it.each(["insert", "remove"])("HF-R3-03 cancels a wrapped xterm dialog %s even within one batch", async (operation) => {
    const observed = trace(); await mount();
    const xterm = textarea().parentElement!, wrapper = document.createElement("div"), popup = document.createElement("div");
    popup.setAttribute("role", "dialog"); wrapper.append(popup);
    if (operation === "remove") { wrapper.hidden = true; await act(async () => { xterm.append(wrapper); }); }
    await aim(); await advance(50);
    observed.start();
    await act(async () => {
      if (operation === "insert") { xterm.append(wrapper); wrapper.remove(); }
      else { wrapper.remove(); xterm.append(wrapper); }
    });
    observed.stop();
    expect(observed.batches).toHaveLength(1); expect(observed.batches[0].records).toHaveLength(2);
    expect(observed.batches[0].records.every((r) => r.type === "childList" && r.target === xterm)).toBe(true);
    await advance(150); expect(active()).toBe("a"); expect(mocks.focus.get("b")).not.toHaveBeenCalled();
    await aim(21); await advance(100); expect(active()).toBe("b");
  });

  it.each(["direct span", "nested wrapper", "canvas fallback"])("HF-R3-03 does not prune a popup disguised as %s rendering", async (shape) => {
    await mount();
    const rows = document.createElement("div"); rows.className = "xterm-rows";
    await act(async () => { textarea().parentElement!.append(rows); });
    await aim(); await advance(50);
    const row = document.createElement(shape === "canvas fallback" ? "canvas" : "div"), popup = document.createElement("span");
    popup.setAttribute("role", "menu");
    const nested = document.createElement("span"); nested.append(popup);
    row.append(shape === "nested wrapper" ? nested : popup);
    await act(async () => { rows.append(row); row.remove(); });
    await advance(100); expect(active()).toBe("a");
    await aim(21); await advance(100); expect(active()).toBe("b");
  });

  it("HF-R3-03 retains dwell through 1000 row/canvas batches with zero document scans", async () => {
    const observed = trace(); await mount();
    const rows = document.createElement("div"), canvas = document.createElement("canvas"); rows.className = "xterm-rows";
    await act(async () => { textarea().parentElement!.append(rows, canvas); });
    await aim(); await advance(50);
    const queries = searches(); observed.start();
    await act(async () => {
      for (let i = 0; i < 1000; i++) {
        const row = document.createElement("div"), cell = document.createElement("span");
        cell.textContent = String(i); row.append(cell); rows.append(row); row.remove(); canvas.style.width = `${i + 1}px`;
        await Promise.resolve();
      }
    });
    observed.stop();
    expect(observed.batches).toHaveLength(1000);
    expect(new Set(observed.batches.map((batch) => batch.records.length))).toEqual(new Set([3]));
    expect(queries.documents()).toBe(0); expect(queries.subtrees()).toBe(0);
    await advance(49); expect(active()).toBe("a"); await advance(1); expect(active()).toBe("b");
  }, 30000);
});
