// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MinimapTabChip, minimapVisibleRowWidth, minimapLabelFits } from "../../src/components/dashboard/MinimapTabChip";

const rect = (left: number, width: number) => ({ left, right: left + width, width, top: 0, bottom: 12, height: 12, x: left, y: 0, toJSON() {} });

describe("minimap visible padding edge", () => {
  it("includes the right padding when the complete label exceeds the content box", () => {
    const available = minimapVisibleRowWidth(40, rect(10, 40), rect(0, 60), rect(0, 70), 1);
    expect(available).toBe(50);
    expect(45 <= available + 0.5).toBe(true);
  });
  it("rejects text extending past the tile padding edge", () => {
    expect(51 <= minimapVisibleRowWidth(40, rect(10, 40), rect(0, 60)) + 0.5).toBe(false);
  });
  it("uses the cell inner border when it clips before the tile edge", () => {
    expect(minimapVisibleRowWidth(40, rect(10, 40), rect(0, 60), rect(0, 55), 1)).toBe(44);
  });
  it("keeps collapsed widths anchored to the tile, even with no right padding deduction", () => {
    expect(minimapVisibleRowWidth(50, rect(0, 60), rect(0, 60), rect(0, 55), 1)).toBe(44);
  });
});

describe("subpixel clipping and rounded content widths", () => {
  it.each([
    [24.25, 24, 23.8125, false],
    [35.25, 34.796875, 34.796875, false],
    [33, 32.6875, 32.6875, false],
    [18, 17.984375, 17.984375, true],
    [24.25, 24, 24.25, true],
    [30.0625, 30, 30, false],
  ] as const)("fits %spx only when both layout and precise clipping edges allow it", (width, available, precise, expected) => {
    expect(minimapLabelFits(width, available, precise)).toBe(expected);
  });
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function withTile(collapsed: boolean, state: "noUpdate" | "needsHuman", ageWidth: number, cellRight: number, context: boolean, check: (tile: HTMLButtonElement, notify: () => Promise<void>) => Promise<void>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const callbacks: ResizeObserverCallback[] = [];
  vi.stubGlobal("ResizeObserver", class { constructor(callback: ResizeObserverCallback) { callbacks.push(callback); } observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("cmux-minimap-cell")) return rect(0, cellRight);
    if (this.classList.contains("cmux-minimap-chip")) return rect(0, 60);
    if (this.classList.contains("cmux-minimap-age")) return rect(200, ageWidth); // Hidden positions are irrelevant.
    if (this.classList.contains("cmux-minimap-ctx")) return rect(200, 20);
    if (this.classList.contains("cmux-dashboard-status-text")) return rect(200, 33);
    return rect(10, 40);
  });
  vi.spyOn(SVGElement.prototype, "getBoundingClientRect").mockReturnValue(rect(10, 12));
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(40);
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("cmux-minimap-ctx") ? 20 : 0; });
  const style = document.createElement("style");
  style.textContent = `.cmux-minimap-cell { border-right: 1px solid; }
    .cmux-minimap-chip { padding: 0 10px; column-gap: 5px; }
    .cmux-minimap-label { display: none; }
    .cmux-dashboard-status-mark { column-gap: 5px; }
    .is-ctx-hidden { visibility: hidden; }`;
  document.head.append(style);
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const now = 1700000000000;
  try {
    await act(async () => root.render(<div className="cmux-minimap-cell"><MinimapTabChip
      chip={{ tabId: "sample", sessionId: "sample-session", index: 0, label: "Sample", typeGlyph: "", mark: null,
        isActiveTab: true, isPinned: false, declared: false, lastOutputAt: now - 7200000, ...(context ? { contextPct: 37 } : {}) }}
      workspaceId="sample-workspace" paneId="sample-pane" selected={false} open={false} selectedTabIds={new Set()}
      groupPulseTabIds={new Set()} displayState={state} collapsed={collapsed} now={now} onSelect={() => {}} onSelectGroup={() => {}} /></div>));
    const notify = async () => { await act(async () => callbacks.slice().forEach(callback => callback([], {} as ResizeObserver))); };
    await notify();
    await check(host.querySelector("button")!, notify);
  } finally { await act(async () => root.unmount()); host.remove(); style.remove(); }
}

describe("whole labels use the actual clipping edge", () => {
  it.each([false, true])("keeps an age inside the right padding and restores it without oscillation (collapsed=%s)", async collapsed => {
    await withTile(collapsed, "noUpdate", 45, 70, false, async (tile, notify) => {
      const age = tile.querySelector(".cmux-minimap-age")!;
      for (let i = 0; i < 3; i++) { await notify(); expect(age.classList.contains("is-age-hidden")).toBe(false); }
    });
  });
  it.each([false, true])("hides an age clipped by the cell inner border (collapsed=%s)", async collapsed => {
    await withTile(collapsed, "noUpdate", 45, 55, false, async tile => {
      expect(tile.querySelector(".cmux-minimap-age")?.classList.contains("is-age-hidden")).toBe(true);
    });
  });
  it.each([false, true])("uses the padding edge for a complete status label (collapsed=%s)", async collapsed => {
    await withTile(collapsed, "needsHuman", 20, 70, false, async tile => {
      expect(tile.classList.contains("is-status-text-hidden")).toBe(false);
    });
  });
  it.each([false, true])("hides subpixel elapsed overflow inside the half-pixel layout allowance (collapsed=%s)", async collapsed => {
    await withTile(collapsed, "noUpdate", 50.25, 70, false, async tile => {
      expect(tile.querySelector(".cmux-minimap-age")?.classList.contains("is-age-hidden")).toBe(true);
    });
  });
  it("does not treat a rounded-up clientWidth as visible padding", async () => {
    await withTile(false, "noUpdate", 50.125, 70, false, async (tile, notify) => {
      const meta = tile.querySelector<HTMLElement>(".cmux-minimap-meta")!;
      meta.getBoundingClientRect = () => rect(10, 40.75);
      Object.defineProperty(meta, "clientWidth", { configurable: true, value: 41 });
      await notify();
      expect(tile.querySelector(".cmux-minimap-age")?.classList.contains("is-age-hidden")).toBe(true);
    });
  });
  it("reserves fractional CTX width before the priority elapsed or status icon", async () => {
    await withTile(true, "noUpdate", 25, 70, true, async (tile, notify) => {
      tile.querySelector<HTMLElement>(".cmux-minimap-ctx")!.getBoundingClientRect = () => rect(200, 20.125);
      await notify();
      expect(tile.querySelector(".cmux-minimap-ctx")?.classList.contains("is-ctx-hidden")).toBe(true);
    });
  });
  it("keeps collapsed CTX when elapsed and CTX fit through the right padding", async () => {
    await withTile(true, "noUpdate", 25, 70, true, async tile => {
      expect(tile.querySelector(".cmux-minimap-ctx")?.classList.contains("is-ctx-hidden")).toBe(false);
    });
  });
});
