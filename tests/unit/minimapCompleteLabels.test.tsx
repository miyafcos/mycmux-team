// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MinimapTabChip, minimapLabelEllipsis } from "../../src/components/dashboard/MinimapTabChip";
import { useThemeStore } from "../../src/stores/themeStore";

describe("complete second-line glyphs before the minimap ellipsis", () => {
  const row = (widths: number[], top = 16) => {
    let left = 0;
    return widths.map(width => { const r = { left, right: left + width, top }; left += width; return r; });
  };
  it.each([
    [29.4, 12, [12, 12], 12], // Japanese: omit the partial second glyph.
    [14.4, 13, [13], 0],      // No complete second-line glyph plus ellipsis fits.
    [40, 12, [6, 7, 5, 8, 7], 26], // Latin proportional advances.
    [32, 12, [6, 12, 6], 18], // Mixed Latin and Japanese.
    [24, 12, [12, 12], 12],  // Exact fit.
    [23.9, 12, [12], 0],     // Even a small partial glyph must be removed.
    [8, 12, [12], 0],
  ] as const)("places the marker after complete glyphs in a %spx label", (width, ellipsis, advances, cut) => {
    const result = minimapLabelEllipsis([...row([12], 0), ...row([...advances]), ...row([12], 32)], width, ellipsis, 16);
    expect(result).toEqual({ cut, ellipsisLeft: cut, line2Top: 16, ellipsisTop: 16 });
  });
  it("keeps outward-rounded neighbouring glyph rectangles behind the cutoff", () => {
    const glyphs = [{ left: 0, right: 12, top: 0 }, { left: 0, right: 12, top: 16 }, { left: 11.984375, right: 24, top: 16 }];
    expect(minimapLabelEllipsis(glyphs, 29.4, 12, 16).cut).toBe(11.984375);
  });
  it("never mistakes the third line for the second, and handles empty layout", () => {
    expect(minimapLabelEllipsis([], 40, 12, 16).cut).toBe(0);
    expect(minimapLabelEllipsis([...row([12], 1.2), ...row([12], 17.2), ...row([6, 6], 33.2)], 40, 12, 16).cut).toBe(12);
  });
});

afterEach(() => { vi.unstubAllGlobals(); useThemeStore.setState({ uiDensity: "standard", uiFontScale: 1 }); });

describe("minimap elapsed and status text are complete or hidden", () => {
  it.each([false, true])("restores a visible no-update mark and reopens elapsed text without oscillation (collapsed=%s)", async collapsed => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const callbacks: ResizeObserverCallback[] = [];
    vi.stubGlobal("ResizeObserver", class { constructor(callback: ResizeObserverCallback) { callbacks.push(callback); } observe() {} disconnect() {} });
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    const now = 1700000000000;
    try {
      await act(async () => root.render(<MinimapTabChip chip={{ tabId: "sample", sessionId: "sample-session", index: 0,
        label: "Sample mixed name", typeGlyph: "", mark: null, isActiveTab: true, isPinned: false, declared: false, lastOutputAt: now - 7200000 }}
        workspaceId="sample-workspace" paneId="sample-pane" selected={false} open={false} selectedTabIds={new Set()}
        groupPulseTabIds={new Set()} displayState="noUpdate" collapsed={collapsed} now={now} onSelect={() => {}} onSelectGroup={() => {}} />));
      const tile = host.querySelector("button")!;
      tile.style.padding = "0px"; tile.style.columnGap = "0px";
      const available = collapsed ? tile : host.querySelector(".cmux-minimap-meta")!;
      let width = 15;
      const rect = (value: number) => ({ width: value, height: 12, left: 0, right: value, top: 0, bottom: 12, x: 0, y: 0, toJSON() {} });
      available.getBoundingClientRect = () => rect(width);
      tile.getBoundingClientRect = () => rect(width);
      Object.defineProperty(available, "clientWidth", { configurable: true, get: () => width });
      const age = host.querySelector<HTMLElement>(".cmux-minimap-age")!;
      age.getBoundingClientRect = () => rect(31.2); // Intrinsic width survives visibility changes.
      const notify = async () => act(async () => callbacks.slice().forEach(callback => callback([], {} as ResizeObserver)));
      const title = tile.title, accessible = tile.getAttribute("aria-label");
      for (let i = 0; i < 4; i++) {
        await notify();
        expect(age.classList.contains("is-age-hidden")).toBe(true);
        expect(host.querySelector('[data-dashboard-status="noUpdate"]')?.classList.contains("cmux-dashboard-sr-only")).toBe(false);
      }
      width = 100;
      await notify();
      expect(age.classList.contains("is-age-hidden")).toBe(false);
      if (!collapsed) expect(host.querySelector('[data-dashboard-status="noUpdate"]')?.classList.contains("cmux-dashboard-sr-only")).toBe(true);
      expect(tile.title).toBe(title); expect(tile.getAttribute("aria-label")).toBe(accessible);
    } finally { await act(async () => root.unmount()); host.remove(); }
  });

  it("hides an entire status label and keeps the icon when the complete text cannot fit", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const callbacks: ResizeObserverCallback[] = [];
    vi.stubGlobal("ResizeObserver", class { constructor(callback: ResizeObserverCallback) { callbacks.push(callback); } observe() {} disconnect() {} });
    const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
    try {
      await act(async () => root.render(<MinimapTabChip chip={{ tabId: "sample", sessionId: "sample-session", index: 0,
        label: "Sample", typeGlyph: "", mark: null, isActiveTab: true, isPinned: false, declared: false }}
        workspaceId="sample-workspace" paneId="sample-pane" selected={false} open={false} selectedTabIds={new Set()}
        groupPulseTabIds={new Set()} displayState="needsHuman" collapsed={false} now={1} onSelect={() => {}} onSelectGroup={() => {}} />));
      let width = 20;
      const rect = (value: number) => ({ width: value, height: 12, left: 0, right: value, top: 0, bottom: 12, x: 0, y: 0, toJSON() {} });
      host.querySelector<HTMLElement>(".cmux-minimap-status-line")!.getBoundingClientRect = () => rect(width);
      host.querySelector<HTMLElement>("button")!.getBoundingClientRect = () => rect(width);
      host.querySelector<HTMLElement>(".cmux-dashboard-status-text")!.getBoundingClientRect = () => rect(33);
      host.querySelector<SVGSVGElement>("svg")!.getBoundingClientRect = () => rect(12);
      const notify = async () => act(async () => callbacks.forEach(callback => callback([], {} as ResizeObserver)));
      await notify(); expect(host.querySelector("button")!.classList.contains("is-status-text-hidden")).toBe(true);
      expect(host.querySelector("svg")).not.toBeNull();
      width = 100; await notify(); expect(host.querySelector("button")!.classList.contains("is-status-text-hidden")).toBe(false);
    } finally { await act(async () => root.unmount()); host.remove(); }
  });
});
