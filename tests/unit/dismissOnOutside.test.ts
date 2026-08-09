import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isOutsideDismiss } from "../../src/hooks/useDismissOnOutside";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

/**
 * Minimal stand-in for an element: `contains` is the only DOM API the outside
 * test uses, and vitest runs these files without a DOM.
 */
function container(...owned: object[]) {
  return { contains: (node: unknown) => owned.includes(node as object) };
}

describe("isOutsideDismiss", () => {
  it("dismisses only for targets outside every mounted container", () => {
    const inside = {};
    const outside = {};
    const panel = container(inside);

    expect(isOutsideDismiss(outside as EventTarget, [panel])).toBe(true);
    expect(isOutsideDismiss(inside as EventTarget, [panel])).toBe(false);
  });

  it("treats every listed container as inside, so a trigger outside the panel is excluded", () => {
    const panelChild = {};
    const triggerChild = {};
    const elsewhere = {};
    const refs = [container(panelChild), container(triggerChild)];

    expect(isOutsideDismiss(panelChild as EventTarget, refs)).toBe(false);
    expect(isOutsideDismiss(triggerChild as EventTarget, refs)).toBe(false);
    expect(isOutsideDismiss(elsewhere as EventTarget, refs)).toBe(true);
  });

  it("never dismisses while no container is mounted", () => {
    expect(isOutsideDismiss({} as EventTarget, [])).toBe(false);
    expect(isOutsideDismiss({} as EventTarget, [null])).toBe(false);
    expect(isOutsideDismiss({} as EventTarget, [null, undefined])).toBe(false);
  });

  it("ignores a partially unmounted ref list but still honours the mounted one", () => {
    const inside = {};
    const refs = [null, container(inside), undefined];

    expect(isOutsideDismiss(inside as EventTarget, refs)).toBe(false);
    expect(isOutsideDismiss({} as EventTarget, refs)).toBe(true);
  });

  it("treats a null target (no element under the pointer) as outside", () => {
    expect(isOutsideDismiss(null, [container({})])).toBe(true);
  });
});

describe("useDismissOnOutside wiring", () => {
  const hook = source("src/hooks/useDismissOnOutside.ts");

  it("registers mousedown, contextmenu and Escape together, in capture, with symmetric cleanup", () => {
    expect(hook).toContain('if (!active) return;');
    expect(hook.match(/window\.addEventListener\(/g)).toHaveLength(3);
    expect(hook.match(/window\.removeEventListener\(/g)).toHaveLength(3);
    expect(hook).toContain('window.addEventListener("mousedown", onMouseDown, true)');
    // Right-click does not reliably deliver a mousedown, and with the native
    // context menu suppressed it would otherwise leave popovers stranded open.
    expect(hook).toContain('window.addEventListener("contextmenu", onMouseDown, true)');
    expect(hook).toContain('window.addEventListener("keydown", onKeyDown, true)');
    expect(hook).toContain('if (event.key !== "Escape") return;');
    // The effect must not re-attach when the caller passes a fresh callback or
    // ref array; only `active` may retear the listeners.
    expect(hook).toContain("}, [active]);");
  });

  it("leaves preventDefault opt-in so terminal popovers still pass Escape through", () => {
    expect(hook.match(/event\.preventDefault\(\)/g)).toHaveLength(1);
    expect(hook).toContain("preventDefaultOnEscape");
  });
});

describe("popover dismiss call sites", () => {
  const callSites = [
    "src/components/layout/AccountsButton.tsx",
    "src/components/layout/NotificationPanel.tsx",
    "src/components/workspace/PaneTabBar.tsx",
    "src/components/workspace/TerminalPane.tsx",
  ];

  it("uses the shared hook instead of hand-rolled listeners", () => {
    for (const path of callSites) {
      const text = source(path);
      expect(text).toContain("useDismissOnOutside");
      expect(text).not.toContain('addEventListener("mousedown"');
      expect(text).not.toContain('addEventListener("keydown"');
    }
  });

  it("covers all seven popovers", () => {
    const total = callSites.reduce(
      (count, path) => count + (source(path).match(/useDismissOnOutside\(/g)?.length ?? 0),
      0,
    );
    // AccountsButton 1, NotificationPanel 1, PaneTabBar 4, TerminalPane 1.
    expect(total).toBe(7);
  });
});
