// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
const mocks = vi.hoisted(() => ({ mark: vi.fn(), start: vi.fn(), invoke: vi.fn() }));
vi.mock("../../src/lib/groupingPrecompute", () => ({
  markGroupingInterest: mocks.mark, startGroupingPrecomputeIfInterested: mocks.start,
}));
vi.mock("../../src/components/layout/tabGrouping", () => ({ TAB_GROUPING_OPEN_EVENT: "mycmux:tab-grouping-open" }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../../src/components/layout/TabGroupingPanel", () => ({
  TabGroupingPanel: ({ open, intent, onClose }: { open: boolean; intent: string | null; onClose: () => void }) =>
    <section id="tab-grouping-panel" data-open={open} data-intent={intent ?? "compare"}><button onClick={onClose}>close panel</button></section>,
}));
import { TabGroupingButton } from "../../src/components/layout/TabGroupingButton";
import { tabGroupingStrings } from "../../src/components/dashboard/dashboardStrings";
let root: Root, host: HTMLDivElement;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers(); vi.clearAllMocks();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<TabGroupingButton />));
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals();
});
describe("RV-T1 rearrange entry", () => {
  it("opens the three-plan panel immediately and closes/reopens it", async () => {
    const entry = host.querySelector("button")!;
    expect(entry.textContent).toBe(tabGroupingStrings.title);
    expect(entry.getAttribute("aria-controls")).toBe("tab-grouping-panel");
    await act(async () => entry.click());
    expect(host.querySelector("#tab-grouping-panel")?.getAttribute("data-open")).toBe("true");
    expect(mocks.mark).toHaveBeenCalledOnce();
    await act(async () => (host.querySelector("#tab-grouping-panel button") as HTMLButtonElement).click());
    expect(entry.getAttribute("aria-expanded")).toBe("false");
    await act(async () => vi.advanceTimersByTimeAsync(121));
    expect(host.querySelector("#tab-grouping-panel")).toBeNull();
    await act(async () => entry.click());
    expect(host.querySelector("#tab-grouping-panel")?.getAttribute("data-intent")).toBe("compare");
  });
  it("preserves applied-change review intent and normal comparison events", async () => {
    await act(async () => window.dispatchEvent(new CustomEvent("mycmux:tab-grouping-open", { detail: { intent: "review" } })));
    expect(host.querySelector("#tab-grouping-panel")?.getAttribute("data-intent")).toBe("review");
    await act(async () => window.dispatchEvent(new Event("mycmux:tab-grouping-open")));
    expect(host.querySelector("#tab-grouping-panel")?.getAttribute("data-intent")).toBe("compare");
  });
  it("never mounts an overview or schedules its peer inventory polling", async () => {
    await act(async () => host.querySelector("button")!.click());
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(host.querySelector("[data-work-overview]")).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    for (const path of ["src/components/layout/TabGroupingButton.tsx", "src/components/layout/SocketListener.tsx"]) {
      expect(readFileSync(path, "utf8")).not.toMatch(/WorkOverview|workOverview|unlistenPeerOverview/);
    }
  });
});
