// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { MinimapTabChip } from "../../src/components/dashboard/MinimapTabChip";

const rect = (left: number, width: number) => ({ left, right: left + width, width, top: 0, bottom: 12, height: 12, x: left, y: 0, toJSON() {} });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const states = ["needsHuman", "error", "running", "noUpdate", "done", "acknowledged", "idle", "stopped", "delegated", "delegationUnknown"] as const;
it.each(states.flatMap(state => [false, true].map(collapsed => ({ state, collapsed }))))("shows the complete $state icon using existing padding (collapsed=$collapsed)", async ({ state, collapsed }) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const callbacks: ResizeObserverCallback[] = [];
  vi.stubGlobal("ResizeObserver", class { constructor(callback: ResizeObserverCallback) { callbacks.push(callback); } observe() {} disconnect() {} });
  let width = 20;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("cmux-minimap-chip") ? rect(10, width)
      : this.classList.contains("cmux-minimap-age") ? rect(20, 40)
        : this.classList.contains("cmux-minimap-meta") || this.classList.contains("cmux-minimap-status-line") ? rect(20, Math.max(0, width - 20)) : rect(20, 12);
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => Math.max(0, width - 20));
  vi.spyOn(SVGElement.prototype, "getBoundingClientRect").mockReturnValue(rect(20, 12));
  const style = document.createElement("style"); style.textContent = ".cmux-minimap-chip { padding: 0px 10px; column-gap: 5px; } .cmux-minimap-label { display: none; }"; document.head.append(style);
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const now = 1700000000000;
  try {
    await act(async () => root.render(<MinimapTabChip chip={{ tabId: "sample", sessionId: "sample-session", index: 0, label: "Sample",
      typeGlyph: "", mark: null, isActiveTab: true, isPinned: false, declared: false, lastOutputAt: now - 7200000 }}
      workspaceId="sample-workspace" paneId="sample-pane" selected={false} open={false} selectedTabIds={new Set()}
      groupPulseTabIds={new Set()} displayState={state} collapsed={collapsed} now={now} onSelect={() => {}} onSelectGroup={() => {}} />));
    const tile = host.querySelector("button")!;
    for (let i = 0; i < 3; i++) {
      await act(async () => callbacks.slice().forEach(callback => callback([], {} as ResizeObserver)));
      expect(tile.style.getPropertyValue("--minimap-status-offset")).toBe("-4px");
    }
    const originalMarks = [...tile.querySelectorAll(".cmux-dashboard-status-mark")].map(mark => mark.getAttribute("data-dashboard-status"));
    width = 100;
    await act(async () => callbacks.slice().forEach(callback => callback([], {} as ResizeObserver)));
    expect(tile.style.getPropertyValue("--minimap-status-offset")).toBe("");
    if (state !== "noUpdate") expect([...tile.querySelectorAll(".cmux-dashboard-status-mark")].map(mark => mark.getAttribute("data-dashboard-status"))).toEqual(originalMarks);
  } finally { await act(async () => root.unmount()); host.remove(); style.remove(); }
});
