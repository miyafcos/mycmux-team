// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(async () => true) }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<object>(), invoke: mocks.invoke }));
afterEach(() => { vi.resetModules(); vi.unstubAllGlobals(); });
it("uses the macOS Command shortcut for a synthetic preview event", async () => {
  vi.stubGlobal("navigator", { platform: "MacIntel", userAgent: "Macintosh" });
  vi.resetModules();
  const { useKeybindingStore } = await import("../../src/stores/keybindingStore");
  const { handleDetachedDashboardKey } = await import("../../src/lib/detachedDashboardKeys");
  const { useDashboardViewStore } = await import("../../src/stores/dashboardViewStore");
  const { mountDetachedDashboardHost } = await import("../../src/lib/dashboardHost");
  useKeybindingStore.getState().resetAll();
  useDashboardViewStore.setState({ open: false });
  const event = new KeyboardEvent("keydown", { key: "G", metaKey: true, shiftKey: true, cancelable: true });
  const release = mountDetachedDashboardHost();
  try {
    handleDetachedDashboardKey(event);
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("open_main_dashboard", expect.any(Object)));
    expect(event.defaultPrevented).toBe(true);
    expect(useDashboardViewStore.getState().open).toBe(false);
  } finally { release(); }
});
