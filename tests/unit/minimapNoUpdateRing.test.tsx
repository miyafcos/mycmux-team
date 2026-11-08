// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import postcss from "postcss";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { MinimapTabChip } from "../../src/components/dashboard/MinimapTabChip";

const css = readFileSync("src/components/dashboard/MinimapPanel.css", "utf8");
const ringRules: postcss.Rule[] = [];
postcss.parse(css).walkRules(rule => { if (rule.selector.includes(".is-noUpdate") && rule.selector.includes("::before")) ringRules.push(rule); });
const ringSelector = ringRules.map(rule => rule.selector.replaceAll("::before", "")).join(", ");
const rect = (width: number) => ({ left: 0, right: width, width, top: 0, bottom: 12, height: 12, x: 0, y: 0, toJSON() {} });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it.each([{ hasTime: false, fits: false }, { hasTime: false, fits: true }, { hasTime: true, fits: false }, { hasTime: true, fits: true }])(
  "draws the no-update ring only for a hidden elapsed value (hasTime=$hasTime, fits=$fits)", async ({ hasTime, fits }) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const width = fits ? 60 : 20;
    const callbacks: ResizeObserverCallback[] = [];
    vi.stubGlobal("ResizeObserver", class { constructor(callback: ResizeObserverCallback) { callbacks.push(callback); } observe() {} disconnect() {} });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) { return rect(this.classList.contains("cmux-minimap-age") ? 30 : width); });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(width);
    const style = document.createElement("style"); style.textContent = ".cmux-minimap-chip { padding: 0px; column-gap: 0px; } .cmux-minimap-label { display: none; }"; document.head.append(style);
    const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
    const now = 1700000000000;
    try {
      for (const collapsed of [false, true]) {
        await act(async () => root.render(<MinimapTabChip chip={{ tabId: "sample", sessionId: "sample-session", index: 0, label: "Sample",
          typeGlyph: "", mark: null, isActiveTab: true, isPinned: false, declared: false, lastOutputAt: hasTime ? now - 7200000 : null }}
          workspaceId="sample-workspace" paneId="sample-pane" selected={false} open={false} selectedTabIds={new Set()}
          groupPulseTabIds={new Set()} displayState="noUpdate" collapsed={collapsed} now={now} onSelect={() => {}} onSelectGroup={() => {}} />));
        await act(async () => callbacks.slice().forEach(callback => callback([], {} as ResizeObserver)));
        expect(Boolean(host.querySelector(ringSelector)), `collapsed=${collapsed}`).toBe(hasTime && !fits);
      }
    } finally { await act(async () => root.unmount()); host.remove(); style.remove(); }
  });


it.each([false, true])("draws a stable no-time ring only when the status text does not fit (fits=%s)", async fits => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const callbacks: ResizeObserverCallback[] = [];
  vi.stubGlobal("ResizeObserver", class { constructor(callback: ResizeObserverCallback) { callbacks.push(callback); } observe() {} disconnect() {} });
  let width = fits ? 40 : 20; // 33px text fits at 40px; text + 12px ring would not.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return rect(this.classList.contains("cmux-dashboard-status-text") ? 33 : width);
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
  const style = document.createElement("style");
  style.textContent = ".cmux-minimap-chip { padding: 0px; column-gap: 0px; } .cmux-dashboard-status-mark { column-gap: 4px; } .cmux-minimap-label { display: none; }";
  document.head.append(style);
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const notify = async () => act(async () => callbacks.slice().forEach(callback => callback([], {} as ResizeObserver)));
  try {
    for (const collapsed of [false, true]) {
      await act(async () => root.render(<MinimapTabChip chip={{ tabId: "sample", sessionId: "sample-session", index: 0,
        label: "Sample", typeGlyph: "", mark: null, isActiveTab: true, isPinned: false, declared: false, lastOutputAt: null }}
        workspaceId="sample-workspace" paneId="sample-pane" selected={false} open={false} selectedTabIds={new Set()}
        groupPulseTabIds={new Set()} displayState="noUpdate" collapsed={collapsed} now={1} onSelect={() => {}} onSelectGroup={() => {}} />));
      const tile = host.querySelector("button")!;
      const title = tile.title, accessible = tile.getAttribute("aria-label");
      for (const nextFits of [fits, !fits, fits]) {
        width = nextFits ? 40 : 20;
        for (let repeat = 0; repeat < 4; repeat++) {
          await notify();
          expect(host.querySelector(".cmux-minimap-age")).toBeNull();
          expect(tile.classList.contains("is-status-text-hidden")).toBe(!nextFits);
          expect(Boolean(host.querySelector(ringSelector)), `collapsed=${collapsed}, width=${width}`).toBe(!nextFits);
          expect(tile.title).toBe(title); expect(tile.getAttribute("aria-label")).toBe(accessible);
        }
      }
    }
  } finally { await act(async () => root.unmount()); host.remove(); style.remove(); }
});
