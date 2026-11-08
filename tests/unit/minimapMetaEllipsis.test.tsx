// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { MinimapTabChip } from "../../src/components/dashboard/MinimapTabChip";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("remeasures the ellipsis when only the metadata row height changes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const observers: { callback: ResizeObserverCallback; nodes: Set<Element> }[] = [];
  vi.stubGlobal("ResizeObserver", class {
    nodes = new Set<Element>();
    constructor(public callback: ResizeObserverCallback) { observers.push(this); }
    observe(node: Element) { this.nodes.add(node); }
    disconnect() { this.nodes.clear(); }
  });
  let metaHeight = 10;
  const rect = (width: number, height: number, top = 0, left = 0) => ({ width, height, top, left,
    right: left + width, bottom: top + height, x: left, y: top, toJSON() {} });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("cmux-minimap-meta")) return rect(40, metaHeight, 4);
    if (this.classList.contains("cmux-minimap-label")) return rect(40, 32, 7 + metaHeight);
    return rect(40, 53);
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(40);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(32);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(48);
  const createRange = document.createRange.bind(document);
  vi.spyOn(document, "createRange").mockImplementation(() => {
    const range = createRange();
    let offset = 0;
    const setStart = range.setStart.bind(range);
    range.setStart = (node, next) => { offset = next; setStart(node, next); };
    range.getClientRects = () => [rect(6, 16, 7 + metaHeight + Math.floor(offset / 6) * 16, offset % 6 * 6)] as unknown as DOMRectList;
    return range;
  });
  const style = document.createElement("style");
  style.textContent = ".cmux-minimap-chip { font-size: 12px; padding: 0px; } .cmux-minimap-label { line-height: 16px; }";
  document.head.append(style);
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<MinimapTabChip chip={{ tabId: "sample", sessionId: "sample-session", index: 0,
      label: "Sample label", typeGlyph: "", mark: null, isActiveTab: true, isPinned: false, declared: false, lastOutputAt: null }}
      workspaceId="sample-workspace" paneId="sample-pane" selected={false} open={false} selectedTabIds={new Set()}
      groupPulseTabIds={new Set()} displayState="noUpdate" collapsed={false} now={1} onSelect={() => {}} onSelectGroup={() => {}} />));
    const tile = host.querySelector("button")!;
    const meta = host.querySelector(".cmux-minimap-meta")!;
    const label = host.querySelector(".cmux-minimap-label")!;
    const initialSize = [label.clientWidth, label.clientHeight];
    expect(tile.style.getPropertyValue("--minimap-label-ellipsis-top")).toBe("33px");
    for (const height of [6, 10, 6, 10]) {
      metaHeight = height;
      await act(async () => observers.filter(observer => observer.nodes.has(meta))
        .forEach(observer => observer.callback([], {} as ResizeObserver)));
      expect([label.clientWidth, label.clientHeight]).toEqual(initialSize);
      expect(tile.style.getPropertyValue("--minimap-label-ellipsis-top")).toBe(`${23 + height}px`);
    }
  } finally { await act(async () => root.unmount()); host.remove(); style.remove(); }
});
