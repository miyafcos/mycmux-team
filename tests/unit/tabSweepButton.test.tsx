// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runAutoSweep: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock("../../src/components/layout/tabSweepAuto", () => ({ runAutoSweep: mocks.runAutoSweep }));
vi.mock("../../src/components/layout/TabSweepPanel", () => ({
  TabSweepPanel: ({ open, visible }: { open: boolean; visible: boolean }) => (
    <div data-tab-sweep-panel-mock="true" data-open={String(open)} data-visible={String(visible)} />
  ),
}));

import { TabSweepButton } from "../../src/components/layout/TabSweepButton";
import { TAB_SWEEP_OPEN_EVENT, openTabSweepInDashboard } from "../../src/components/layout/tabSweep";
import { useDashboardViewStore } from "../../src/stores/dashboardViewStore";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.runAutoSweep.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  useDashboardViewStore.setState({ open: false });
});

function DashboardSweepHost() {
  const dashboardOpen = useDashboardViewStore((state) => state.open);
  return dashboardOpen ? <TabSweepButton /> : null;
}

describe("TabSweepButton", () => {
  it("starts the sweep from the minimap footer control and opens details from the event", async () => {
    await act(async () => root.render(<TabSweepButton />));
    const button = container.querySelector<HTMLButtonElement>("[aria-label='タブ掃除']")!;
    expect(button.classList.contains("cmux-minimap-tab-sweep-button")).toBe(true);

    await act(async () => button.click());
    expect(mocks.runAutoSweep).toHaveBeenCalledTimes(1);

    await act(async () => window.dispatchEvent(new Event(TAB_SWEEP_OPEN_EVENT)));
    expect(container.querySelector("[data-tab-sweep-panel-mock='true']")?.getAttribute("data-open")).toBe("true");
  });

  it("opens the dashboard before delivering the sweep event when it was closed", async () => {
    vi.useFakeTimers();
    await act(async () => root.render(<DashboardSweepHost />));
    expect(container.querySelector("[data-tab-sweep-panel-mock='true']")).toBeNull();

    await act(async () => openTabSweepInDashboard());
    expect(useDashboardViewStore.getState().open).toBe(true);

    await act(async () => { await vi.runAllTimersAsync(); });
    expect(container.querySelector("[data-tab-sweep-panel-mock='true']")?.getAttribute("data-open")).toBe("true");
  });

  it("keeps an open dashboard open while delivering the sweep event", async () => {
    vi.useFakeTimers();
    useDashboardViewStore.setState({ open: true });
    await act(async () => root.render(<DashboardSweepHost />));

    await act(async () => openTabSweepInDashboard());
    await act(async () => { await vi.runAllTimersAsync(); });

    expect(useDashboardViewStore.getState().open).toBe(true);
    expect(container.querySelector("[data-tab-sweep-panel-mock='true']")?.getAttribute("data-open")).toBe("true");
  });
});
