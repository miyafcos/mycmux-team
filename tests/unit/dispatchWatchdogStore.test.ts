import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claim: vi.fn<() => Promise<boolean>>(),
  scan: vi.fn<() => Promise<unknown[]>>(),
}));

vi.mock("../../src/lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/ipc")>("../../src/lib/ipc");
  return {
    ...actual,
    dispatchClaimWatchdog: mocks.claim,
    dispatchScan: mocks.scan,
  };
});

import { connectDispatchWatchdog, type WatchdogItem, useDispatchWatchdogStore } from "../../src/stores/dispatchWatchdogStore";
import { useSettingsStore } from "../../src/stores/settingsStore";

const NOW = Date.parse("2026-08-14T10:00:00.000Z");
const MINUTE = 60_000;

interface FakeDocument {
  visibilityState: "visible" | "hidden";
  addEventListener: (type: string, handler: () => void) => void;
  removeEventListener: (type: string, handler: () => void) => void;
}

function installBrowserGlobals(): FakeDocument {
  const handlers = new Set<() => void>();
  const fakeDocument: FakeDocument = {
    visibilityState: "visible",
    addEventListener: (type, handler) => { if (type === "visibilitychange") handlers.add(handler); },
    removeEventListener: (type, handler) => { if (type === "visibilitychange") handlers.delete(handler); },
  };
  vi.stubGlobal("document", fakeDocument);
  vi.stubGlobal("window", globalThis);
  return fakeDocument;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

let fakeDocument: FakeDocument;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  fakeDocument = installBrowserGlobals();
  mocks.claim.mockReset().mockResolvedValue(true);
  mocks.scan.mockReset().mockResolvedValue([]);
  useDispatchWatchdogStore.getState().clear();
  useSettingsStore.setState({
    notificationsEnabled: true,
    dispatchWatchdogEnabled: true,
    dispatchWatchdogIntervalMinutes: 5,
    dispatchStallMinutes: 45,
    dispatchWatchdogNotify: false,
  });
});

afterEach(() => {
  useDispatchWatchdogStore.getState().clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("connectDispatchWatchdog telemetry", () => {
  it("timestamps a successful tick at scan start and schedules the next tick from it", async () => {
    let resolveScan: ((entries: unknown[]) => void) | undefined;
    mocks.scan.mockImplementation(() => new Promise((resolve) => { resolveScan = resolve; }));

    const disconnect = connectDispatchWatchdog();
    await settle();
    expect(mocks.scan).toHaveBeenCalledTimes(1);

    vi.setSystemTime(NOW + 30_000);
    resolveScan?.([]);
    await settle();

    expect(useDispatchWatchdogStore.getState().telemetry).toMatchObject({
      running: true,
      lastTickAt: NOW,
      nextTickDueAt: NOW + 5 * MINUTE,
      lastSkipReason: null,
      notifySuppressed: true,
    });
    disconnect();
  });

  it("records a hidden skip without scanning or touching the queue", () => {
    const sentinel: WatchdogItem = {
      key: "sentinel",
      kind: "stalled",
      sessionId: "session-1",
      since: NOW,
      confirmations: 2,
    };
    const queue = [sentinel];
    useDispatchWatchdogStore.setState({ queue });
    fakeDocument.visibilityState = "hidden";

    const disconnect = connectDispatchWatchdog();

    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.scan).not.toHaveBeenCalled();
    expect(useDispatchWatchdogStore.getState().queue).toBe(queue);
    expect(useDispatchWatchdogStore.getState().telemetry).toEqual({
      running: false,
      lastTickAt: null,
      nextTickDueAt: null,
      lastSkipReason: "hidden",
      notifySuppressed: false,
    });
    disconnect();
  });

  it("suppresses delegation-watch notifications when the global notification master is off", async () => {
    useSettingsStore.setState({ notificationsEnabled: false, dispatchWatchdogNotify: true });

    const disconnect = connectDispatchWatchdog();
    await settle();

    expect(useDispatchWatchdogStore.getState().telemetry.notifySuppressed).toBe(true);
    disconnect();
  });

  it("allows a resolved occurrence to notify again when the same condition recurs", () => {
    const item: WatchdogItem = {
      key: "child:ask",
      kind: "ask",
      slug: "child",
      since: NOW,
      confirmations: 2,
    };
    const store = useDispatchWatchdogStore.getState();
    store.replaceQueue([item]);
    store.markNotified([item.key]);
    store.replaceQueue([item]);
    expect(useDispatchWatchdogStore.getState().notifiedKeys.has(item.key)).toBe(true);

    store.replaceQueue([]);
    expect(useDispatchWatchdogStore.getState().notifiedKeys.has(item.key)).toBe(false);
  });

  it("contains telemetry subscriber errors inside the settings restart path", () => {
    fakeDocument.visibilityState = "hidden";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const unsubscribeThrowingListener = useDispatchWatchdogStore.subscribe(() => {
      throw new Error("telemetry listener failed");
    });

    const disconnect = connectDispatchWatchdog();
    expect(() => useSettingsStore.getState().setDispatchWatchdogIntervalMinutes(6)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      "[dispatch-watchdog] Telemetry update failed",
      expect.any(Error),
    );

    unsubscribeThrowingListener();
    disconnect();
  });
});
