import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn((): Promise<unknown> => Promise.resolve([])),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

import {
  LIVE_EVENT_DETAIL_LIMIT,
  LIVE_EVENT_LIST_LIMIT,
  type LiveSessionEvents,
  type SemanticEventEnvelope,
} from "../../src/lib/livebrief";
import {
  __resetLiveBriefStoreForTests,
  LIVE_EVENT_LIST_POLL_MS,
  LIVE_EVENT_POLL_MS,
  stopEventPolling,
  syncDashboardEvents,
  useLiveBriefStore,
} from "../../src/stores/liveBriefStore";

/** node 環境には document が無いので、visibilitychange を撃てる最小の代役を置く。 */
interface FakeDocument {
  visibilityState: "visible" | "hidden";
  addEventListener: (type: string, handler: () => void) => void;
  removeEventListener: (type: string, handler: () => void) => void;
}

function installFakeDocument(): FakeDocument {
  const handlers = new Set<() => void>();
  const fake: FakeDocument = {
    visibilityState: "visible",
    addEventListener: (type, handler) => { if (type === "visibilitychange") handlers.add(handler); },
    removeEventListener: (type, handler) => { if (type === "visibilitychange") handlers.delete(handler); },
  };
  (globalThis as { document?: unknown }).document = fake;
  (globalThis as { __fireVisibility?: () => void }).__fireVisibility = () => {
    for (const handler of [...handlers]) handler();
  };
  return fake;
}

function fireVisibilityChange(): void {
  (globalThis as { __fireVisibility?: () => void }).__fireVisibility?.();
}

function envelope(id: string): SemanticEventEnvelope {
  return {
    eventId: id,
    sourceRevision: 1,
    occurredAt: 1,
    sourceByteStart: 0,
    sourceByteEnd: 1,
    kind: { type: "agentMessage", text: id },
  };
}

function sessionEvents(sessionId: string, count: number, briefRevision = 1): LiveSessionEvents {
  return {
    ptySessionId: sessionId,
    briefRevision,
    telemetryHealth: "live",
    events: Array.from({ length: count }, (_, index) => envelope(`${sessionId}-${index}`)),
  };
}

/** invoke("get_live_events", …) の呼び出し引数だけを取り出す。 */
function eventCalls(): Array<{ ptySessionIds: string[]; limit: number }> {
  return mocks.invoke.mock.calls
    .filter((call) => call[0] === "get_live_events")
    .map((call) => call[1] as { ptySessionIds: string[]; limit: number });
}

/** 発火済みの取得 Promise をすべて解決させる。 */
async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
}

let fakeDocument: FakeDocument;

beforeEach(() => {
  vi.useFakeTimers();
  mocks.invoke.mockClear();
  mocks.invoke.mockImplementation(() => Promise.resolve([]));
  fakeDocument = installFakeDocument();
});

afterEach(() => {
  __resetLiveBriefStoreForTests();
  vi.useRealTimers();
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { __fireVisibility?: () => void }).__fireVisibility;
});

describe("syncDashboardEvents", () => {
  it("polls the visible list shallow and the selected session deep", async () => {
    syncDashboardEvents({ selectedId: "s-1", visibleIds: ["s-1", "s-2", "s-3"] });
    await settle();

    expect(eventCalls()).toEqual([
      { ptySessionIds: ["s-1", "s-2", "s-3"], limit: LIVE_EVENT_LIST_LIMIT },
      { ptySessionIds: ["s-1"], limit: LIVE_EVENT_DETAIL_LIMIT },
    ]);
    expect(LIVE_EVENT_LIST_LIMIT).toBe(12);
    expect(LIVE_EVENT_DETAIL_LIMIT).toBe(200);
  });

  it("keeps the two timers on their own intervals", async () => {
    syncDashboardEvents({ selectedId: "s-1", visibleIds: ["s-1", "s-2"] });
    await settle();
    mocks.invoke.mockClear();

    // 詳細だけが回る 1.5s。
    await vi.advanceTimersByTimeAsync(LIVE_EVENT_POLL_MS);
    expect(eventCalls()).toEqual([{ ptySessionIds: ["s-1"], limit: LIVE_EVENT_DETAIL_LIMIT }]);

    // 3s で一覧も 1 回来る (詳細は 2 回目)。
    mocks.invoke.mockClear();
    await vi.advanceTimersByTimeAsync(LIVE_EVENT_LIST_POLL_MS - LIVE_EVENT_POLL_MS);
    const limits = eventCalls().map((call) => call.limit).sort((a, b) => a - b);
    expect(limits).toEqual([LIVE_EVENT_LIST_LIMIT, LIVE_EVENT_DETAIL_LIMIT]);
  });

  it("clamps the visible ids to the batch limit and drops duplicates", async () => {
    const ids = Array.from({ length: 80 }, (_, index) => `s-${index}`);
    syncDashboardEvents({ selectedId: null, visibleIds: [...ids, "s-0"] });
    await settle();

    const [batch] = eventCalls();
    expect(batch.ptySessionIds).toHaveLength(60);
    expect(batch.ptySessionIds[0]).toBe("s-0");
    expect(new Set(batch.ptySessionIds).size).toBe(60);
  });

  it("stops both pollers while the document is hidden and resumes on return", async () => {
    syncDashboardEvents({ selectedId: "s-1", visibleIds: ["s-1", "s-2"] });
    await settle();
    mocks.invoke.mockClear();

    fakeDocument.visibilityState = "hidden";
    fireVisibilityChange();
    await vi.advanceTimersByTimeAsync(LIVE_EVENT_LIST_POLL_MS * 3);
    expect(eventCalls()).toEqual([]);

    fakeDocument.visibilityState = "visible";
    fireVisibilityChange();
    await settle();
    const limits = eventCalls().map((call) => call.limit).sort((a, b) => a - b);
    expect(limits).toEqual([LIVE_EVENT_LIST_LIMIT, LIVE_EVENT_DETAIL_LIMIT]);
  });

  it("backs off the list interval after two unchanged responses and recovers on a change", async () => {
    mocks.invoke.mockImplementation((command: string, args: { ptySessionIds: string[]; limit: number }) => {
      if (command !== "get_live_events") return Promise.resolve([]);
      if (args.limit === LIVE_EVENT_LIST_LIMIT) return Promise.resolve([sessionEvents("s-1", 1, 7)]);
      return Promise.resolve([sessionEvents("s-1", 1, 7)]);
    });
    syncDashboardEvents({ selectedId: null, visibleIds: ["s-1"] });
    await settle();

    // 1 回目・2 回目とも briefRevision 不変 → 3s から 6s へ。
    await vi.advanceTimersByTimeAsync(LIVE_EVENT_LIST_POLL_MS);
    await vi.advanceTimersByTimeAsync(LIVE_EVENT_LIST_POLL_MS);
    mocks.invoke.mockClear();
    await vi.advanceTimersByTimeAsync(LIVE_EVENT_LIST_POLL_MS);
    expect(eventCalls()).toEqual([]);
    await vi.advanceTimersByTimeAsync(LIVE_EVENT_LIST_POLL_MS);
    expect(eventCalls()).toHaveLength(1);

    // 変化を見つけたら 3s へ戻る。
    mocks.invoke.mockImplementation(() => Promise.resolve([sessionEvents("s-1", 1, 8)]));
    await vi.advanceTimersByTimeAsync(6_000);
    mocks.invoke.mockClear();
    await vi.advanceTimersByTimeAsync(LIVE_EVENT_LIST_POLL_MS);
    expect(eventCalls()).toHaveLength(1);
  });

  it("never lets the shallow list overwrite the deep detail slice", async () => {
    mocks.invoke.mockImplementation((command: string, args: { ptySessionIds: string[]; limit: number }) => {
      if (command !== "get_live_events") return Promise.resolve([]);
      const count = args.limit === LIVE_EVENT_LIST_LIMIT ? 12 : 200;
      return Promise.resolve(args.ptySessionIds.map((id) => sessionEvents(id, count)));
    });

    syncDashboardEvents({ selectedId: "s-1", visibleIds: ["s-1", "s-2"] });
    await settle();
    // 一覧の打ち直しを何度重ねても詳細スライスは 200 件のまま。
    await vi.advanceTimersByTimeAsync(LIVE_EVENT_LIST_POLL_MS * 2);

    const state = useLiveBriefStore.getState();
    expect(state.eventsBySession["s-1"]).toHaveLength(200);
    expect(state.listEventsBySession["s-1"]).toHaveLength(12);
    expect(state.listEventsBySession["s-2"]).toHaveLength(12);
    expect(state.eventsBySession["s-2"]).toBeUndefined();
  });

  it("stops every timer once the dashboard closes", async () => {
    syncDashboardEvents({ selectedId: "s-1", visibleIds: ["s-1"] });
    await settle();
    stopEventPolling();
    mocks.invoke.mockClear();
    await vi.advanceTimersByTimeAsync(LIVE_EVENT_LIST_POLL_MS * 4);
    expect(eventCalls()).toEqual([]);
  });
});

describe("applyEventsBatch", () => {
  it("writes every session in a single store update", () => {
    const updates = vi.fn();
    const unsubscribe = useLiveBriefStore.subscribe(updates);
    useLiveBriefStore.getState().applyEventsBatch(
      [sessionEvents("s-1", 2), sessionEvents("s-2", 3)],
      1_234,
    );
    unsubscribe();

    const state = useLiveBriefStore.getState();
    expect(updates).toHaveBeenCalledTimes(1);
    expect(state.listEventsBySession["s-1"]).toHaveLength(2);
    expect(state.listEventsBySession["s-2"]).toHaveLength(3);
    expect(state.listEventsFetchedAtBySession).toEqual({ "s-1": 1_234, "s-2": 1_234 });
    // 詳細スライスは触らない。
    expect(state.eventsBySession).toEqual({});
  });
});
