// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { setup, cleanup, mount, content, pointer, advance } from "./paneHoverFocusHarness";
import { GroupingFlightHost } from "../../src/components/layout/GroupingFlightHost";
import { useUiStore } from "../../src/stores/uiStore";

let flightRoot: Root | null = null;
let flightContainer: HTMLElement | null = null;
beforeEach(() => setup());
afterEach(async () => {
  if (flightRoot) await act(async () => { flightRoot!.unmount(); });
  flightRoot = null; flightContainer = null;
  await cleanup();
});
const active = () => useUiStore.getState().activePaneId;
async function aim(patch = {}) { await act(async () => { pointer(content(), "pointermove", patch); }); }

// AppShell keeps GroupingFlightHost mounted for the whole session, idle between applies.
async function mountResidentFlightHost() {
  flightContainer = document.createElement("div");
  document.body.append(flightContainer);
  flightRoot = createRoot(flightContainer);
  await act(async () => { flightRoot!.render(<GroupingFlightHost />); });
  expect(flightContainer.querySelectorAll("[data-cmux-overlay-root]")).toHaveLength(2);
}

describe("resident overlay roots", () => {
  it("R01 the idle GroupingFlightHost does not block hover focus", async () => {
    await mountResidentFlightHost();
    await mount(); await aim(); await advance(99); expect(active()).toBe("a");
    await advance(1); await advance(0);
    expect(active()).toBe("b");
  });
  it("R02 attribute changes around the resident host do not cancel a pending dwell", async () => {
    await mountResidentFlightHost();
    await mount(); await aim(); await advance(50);
    await act(async () => { flightContainer!.style.opacity = "0.99"; flightContainer!.className = "themed-root"; });
    await advance(50); await advance(0);
    expect(active()).toBe("b");
  });
  it("R03 an overlay root without the ignore marker still blocks", async () => {
    await mountResidentFlightHost();
    const overlay = document.createElement("div"); overlay.setAttribute("data-cmux-overlay-root", "true"); document.body.append(overlay);
    await mount(); await aim(); await advance(200); await advance(0);
    expect(active()).toBe("a");
  });
});
