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

import { connectDispatchWatchdog, openWatchdogSession, type WatchdogItem, useDispatchWatchdogStore } from "../../src/stores/dispatchWatchdogStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useToastStore } from "../../src/stores/toastStore";
import { useDashboardViewStore } from "../../src/stores/dashboardViewStore";
import { useUiStore, useWorkspaceLayoutStore, useWorkspaceListStore } from "../../src/stores/workspaceStore";
import { focusController } from "../../src/lib/focusController";
import type { DispatchEntry } from "../../src/lib/ipc";
import type { Workspace } from "../../src/types";

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

function workspaceFixture(): Workspace {
  return {
    id: "ws-dev",
    name: "開発",
    gridTemplateId: "1x1",
    status: "active",
    createdAt: NOW,
    panes: [{
      id: "pane-1",
      agentId: "claude",
      sessionId: "live-ask",
      activeTabId: "tab-ask",
      tabs: [
        { id: "tab-ask", sessionId: "live-ask", agentId: "claude", label: "調査レーン" },
        { id: "tab-long", sessionId: "live-long", agentId: "codex", label: "長時間レーン" },
      ],
    }],
  } as unknown as Workspace;
}

function ledgerEntry(overrides: Partial<DispatchEntry>): DispatchEntry {
  return {
    slug: "child",
    ts: new Date(NOW - 4 * 60 * MINUTE).toISOString(),
    hasDone: false,
    hasAsk: false,
    hasVerdict: false,
    sessionLogAgeMinutes: 0,
    liveState: "RUNNING",
    ...overrides,
  };
}

describe("connectDispatchWatchdog toasts", () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
    useSettingsStore.setState({ dispatchWatchdogNotify: true });
    useWorkspaceListStore.setState({ workspaces: [workspaceFixture()], activeWorkspaceId: "ws-other" });
  });

  it("names the pane in words, offers to open it, and stays quiet about gone panes and timeouts", async () => {
    // The 2026-09-17 stack: slugs of runs that had ended weeks earlier,
    // "timeout", and "30 more" with nowhere to see them.
    mocks.scan.mockResolvedValue([
      ledgerEntry({ slug: "260825-udr-03-grok-bot-260825-ca72f1-03", tabSessionId: "closed-long-ago", hasAsk: true }),
      ledgerEntry({ slug: "260910-lost-run", status: "lost", tabSessionId: "live-long", hasAsk: true }),
      ledgerEntry({ slug: "260917-long-run", tabSessionId: "live-long" }),
      ledgerEntry({ slug: "260917-ask", tabSessionId: "live-ask", hasAsk: true, askMtimeMs: NOW - MINUTE }),
    ]);
    // A finding must be seen on two ticks before it notifies.
    useDispatchWatchdogStore.getState().replaceQueue([
      { key: "260917-ask:ask", kind: "ask", slug: "260917-ask", sessionId: "live-ask", since: NOW - MINUTE, confirmations: 1 },
      { key: "260917-long-run:timeout", kind: "timeout", slug: "260917-long-run", sessionId: "live-long", since: NOW, confirmations: 1 },
    ]);

    const disconnect = connectDispatchWatchdog();
    await settle();

    expect(useDispatchWatchdogStore.getState().queue.map((item) => item.key)).toEqual([
      "260917-long-run:timeout",
      "260917-ask:ask",
    ]);
    const toasts = useToastStore.getState().toasts;
    expect(toasts.map((toast) => toast.message)).toEqual(["開発 の「調査レーン」が判断を待っています"]);
    expect(toasts[0].action?.label).toBe("開く");
    expect(toasts.some((toast) => /ほか|タイムアウト|udr/.test(toast.message))).toBe(false);
    disconnect();
  });

  it("opens the pane the toast is about, closing the dashboard over it", () => {
    const setActiveWorkspace = vi.fn();
    const setActivePaneTab = vi.fn();
    useWorkspaceListStore.setState({ setActiveWorkspace });
    useWorkspaceLayoutStore.setState({ setActivePaneTab });
    useDashboardViewStore.setState({ open: true });
    useUiStore.setState({ zoomedPaneId: null });
    const request = vi.spyOn(focusController, "request").mockImplementation(() => {});

    openWatchdogSession("live-long");

    expect(useDashboardViewStore.getState().open).toBe(false);
    expect(setActiveWorkspace).toHaveBeenCalledWith("ws-dev");
    expect(setActivePaneTab).toHaveBeenCalledWith("ws-dev", "pane-1", "tab-long");
    expect(request).toHaveBeenCalledWith("programmatic", { sessionId: "live-long", focus: true });

    setActiveWorkspace.mockClear();
    openWatchdogSession("closed-long-ago");
    expect(setActiveWorkspace).not.toHaveBeenCalled();
  });
});
