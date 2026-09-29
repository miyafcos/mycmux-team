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
  connectLiveBriefStore,
  holdDetailSession,
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

function backendSubscriptionCalls(): string[] {
  return mocks.invoke.mock.calls
    .map((call) => call[0] as string)
    .filter((command) => command === "subscribe_live_briefs" || command === "unsubscribe_live_briefs");
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

  it("keeps every open chat column deep, not just the active one, and drops the slice of a closed column", async () => {
    mocks.invoke.mockImplementation((command: string, args: { ptySessionIds: string[]; limit: number }) => {
      if (command !== "get_live_events") return Promise.resolve([]);
      const count = args.limit === LIVE_EVENT_LIST_LIMIT ? 12 : 200;
      return Promise.resolve(args.ptySessionIds.map((id) => sessionEvents(id, count)));
    });

    // 列 s-1・s-2 が開いていて s-1 がアクティブ。
    syncDashboardEvents({ selectedId: "s-1", visibleIds: ["s-1", "s-2", "s-3"], detailIds: ["s-1", "s-2"] });
    await settle();
    expect(eventCalls()).toContainEqual({ ptySessionIds: ["s-1", "s-2"], limit: LIVE_EVENT_DETAIL_LIMIT });

    // s-2 をアクティブにしても s-1 の詳細は取り続ける (前は選択中 1 本だけだった)。
    mocks.invoke.mockClear();
    syncDashboardEvents({ selectedId: "s-2", visibleIds: ["s-1", "s-2", "s-3"], detailIds: ["s-1", "s-2"] });
    await settle();
    await vi.advanceTimersByTimeAsync(LIVE_EVENT_POLL_MS);
    const deep = eventCalls().filter((call) => call.limit === LIVE_EVENT_DETAIL_LIMIT);
    expect(deep.length).toBeGreaterThan(0);
    for (const call of deep) expect([...call.ptySessionIds].sort()).toEqual(["s-1", "s-2"]);
    expect(useLiveBriefStore.getState().eventsBySession["s-1"]).toHaveLength(200);
    expect(useLiveBriefStore.getState().eventsBySession["s-2"]).toHaveLength(200);
    // 一覧だけのセッションは浅いまま。
    expect(useLiveBriefStore.getState().eventsBySession["s-3"]).toBeUndefined();

    // s-1 の列を閉じたら、その古い詳細スライスは残さない (一覧の最新 12 件に譲る)。
    syncDashboardEvents({ selectedId: "s-2", visibleIds: ["s-1", "s-2", "s-3"], detailIds: ["s-2"] });
    await settle();
    const state = useLiveBriefStore.getState();
    expect(state.eventsBySession["s-1"]).toBeUndefined();
    expect(state.eventsFetchedAtBySession["s-1"]).toBeUndefined();
    expect(state.eventsBySession["s-2"]).toHaveLength(200);
  });

  it("does not let a batch that was in flight resurrect a column closed meanwhile", async () => {
    let release: ((value: unknown) => void) | undefined;
    mocks.invoke.mockImplementation((command: string, args: { ptySessionIds: string[]; limit: number }) => {
      if (command !== "get_live_events") return Promise.resolve([]);
      if (args.limit === LIVE_EVENT_LIST_LIMIT) return Promise.resolve([]);
      return new Promise((resolve) => { release = resolve; });
    });
    syncDashboardEvents({ selectedId: "s-1", visibleIds: ["s-1", "s-2"], detailIds: ["s-1", "s-2"] });
    await settle();
    expect(eventCalls().find((call) => call.limit === LIVE_EVENT_DETAIL_LIMIT)?.ptySessionIds).toContain("s-2");
    // 応答が返る前に s-2 を閉じる。
    syncDashboardEvents({ selectedId: "s-1", visibleIds: ["s-1", "s-2"], detailIds: ["s-1"] });
    release?.([sessionEvents("s-1", 5), sessionEvents("s-2", 5)]);
    await settle();
    expect(useLiveBriefStore.getState().eventsBySession["s-1"]).toHaveLength(5);
    expect(useLiveBriefStore.getState().eventsBySession["s-2"]).toBeUndefined();
  });
});

describe("holdDetailSession", () => {
  it("keeps the deep poll and the backend sweep subscribed for a pane with no dashboard open", async () => {
    mocks.invoke.mockImplementation((command: string, args: { ptySessionIds: string[]; limit: number }) => {
      if (command !== "get_live_events") return Promise.resolve([]);
      return Promise.resolve(args.ptySessionIds.map((id) => sessionEvents(id, 3)));
    });
    const release = holdDetailSession("pane-a");
    await settle();
    // 購読が付く (backend の transcript 読み取りが動く) + 詳細が 1 回目から取れる。
    expect(backendSubscriptionCalls()).toEqual(["subscribe_live_briefs"]);
    expect(eventCalls()).toEqual([{ ptySessionIds: ["pane-a"], limit: LIVE_EVENT_DETAIL_LIMIT }]);
    expect(useLiveBriefStore.getState().eventsBySession["pane-a"]).toHaveLength(3);

    mocks.invoke.mockClear();
    await vi.advanceTimersByTimeAsync(LIVE_EVENT_POLL_MS * 2);
    expect(eventCalls()).toHaveLength(2);

    // 解放したら詳細もスライスも購読も畳む。
    mocks.invoke.mockClear();
    release();
    await settle();
    expect(backendSubscriptionCalls()).toEqual(["unsubscribe_live_briefs"]);
    expect(useLiveBriefStore.getState().eventsBySession["pane-a"]).toBeUndefined();
    await vi.advanceTimersByTimeAsync(LIVE_EVENT_POLL_MS * 2);
    expect(eventCalls()).toEqual([]);
  });

  it("survives the dashboard opening and closing around it", async () => {
    const release = holdDetailSession("pane-a");
    await settle();
    syncDashboardEvents({ selectedId: "s-1", visibleIds: ["s-1"], detailIds: ["s-1"] });
    await settle();
    mocks.invoke.mockClear();
    await vi.advanceTimersByTimeAsync(LIVE_EVENT_POLL_MS);
    const deep = eventCalls().filter((call) => call.limit === LIVE_EVENT_DETAIL_LIMIT);
    expect(deep.some((call) => [...call.ptySessionIds].sort().join(",") === "pane-a,s-1")).toBe(true);

    // ダッシュボードを閉じても pane-a の hold は続き、購読も外れない。
    stopEventPolling();
    mocks.invoke.mockClear();
    await vi.advanceTimersByTimeAsync(LIVE_EVENT_POLL_MS);
    expect(eventCalls()).toEqual([{ ptySessionIds: ["pane-a"], limit: LIVE_EVENT_DETAIL_LIMIT }]);
    expect(backendSubscriptionCalls()).toEqual([]);

    release();
    await settle();
    expect(backendSubscriptionCalls()).toEqual(["unsubscribe_live_briefs"]);
  });

  it("shares one poll between two readers of the same session", async () => {
    const first = holdDetailSession("pane-a");
    const second = holdDetailSession("pane-a");
    await settle();
    mocks.invoke.mockClear();
    await vi.advanceTimersByTimeAsync(LIVE_EVENT_POLL_MS);
    expect(eventCalls()).toEqual([{ ptySessionIds: ["pane-a"], limit: LIVE_EVENT_DETAIL_LIMIT }]);
    first();
    mocks.invoke.mockClear();
    await vi.advanceTimersByTimeAsync(LIVE_EVENT_POLL_MS);
    expect(eventCalls()).toHaveLength(1);
    second();
    mocks.invoke.mockClear();
    await vi.advanceTimersByTimeAsync(LIVE_EVENT_POLL_MS);
    expect(eventCalls()).toEqual([]);
  });
});

describe("connectLiveBriefStore", () => {
  it("keeps the backend sweep subscribed only while a visible dashboard is connected", async () => {
    const dispose = connectLiveBriefStore();
    await settle();
    expect(backendSubscriptionCalls()).toEqual(["subscribe_live_briefs"]);

    mocks.invoke.mockClear();
    fakeDocument.visibilityState = "hidden";
    fireVisibilityChange();
    await settle();
    expect(backendSubscriptionCalls()).toEqual(["unsubscribe_live_briefs"]);

    mocks.invoke.mockClear();
    fakeDocument.visibilityState = "visible";
    fireVisibilityChange();
    await settle();
    expect(backendSubscriptionCalls()).toEqual(["subscribe_live_briefs"]);

    mocks.invoke.mockClear();
    dispose();
    await settle();
    expect(backendSubscriptionCalls()).toEqual(["unsubscribe_live_briefs"]);
  });
});


describe("connection generations", () => {
  it("disposes a late listener from an already released StrictMode mount", async () => {
    const staleDispose = vi.fn();
    const activeDispose = vi.fn();
    let completeStale!: (dispose: () => void) => void;
    mocks.listen.mockImplementationOnce(() => new Promise((resolve) => { completeStale = resolve; }));
    mocks.listen.mockImplementationOnce(() => Promise.resolve(activeDispose));
    const first = connectLiveBriefStore();
    first();
    const second = connectLiveBriefStore();
    await settle();
    completeStale(staleDispose);
    await settle();
    expect(staleDispose).toHaveBeenCalledTimes(1);
    expect(activeDispose).not.toHaveBeenCalled();
    second();
    await settle();
    expect(activeDispose).toHaveBeenCalledTimes(1);
    expect(staleDispose).toHaveBeenCalledTimes(1);
  });

  it("does not mark an omitted session as loaded while the initial sweep is still running", async () => {
    const release = holdDetailSession("new-pane");
    await settle();
    expect(useLiveBriefStore.getState().eventsBySession["new-pane"]).toBeUndefined();
    expect(useLiveBriefStore.getState().eventsFetchedAtBySession["new-pane"]).toBeUndefined();
    mocks.invoke.mockImplementation((command: string) => (
      Promise.resolve(command === "get_live_events" ? [sessionEvents("new-pane", 0)] : [])
    ));
    await vi.advanceTimersByTimeAsync(LIVE_EVENT_POLL_MS);
    expect(useLiveBriefStore.getState().eventsBySession["new-pane"]).toEqual([]);
    expect(useLiveBriefStore.getState().eventsFetchedAtBySession["new-pane"]).toBeDefined();
    release();
  });

  it("balances the dashboard plus two identical panel holds across StrictMode and visibility", async () => {
    mocks.invoke.mockImplementation((command: string) => (
      Promise.resolve(command === "get_live_events" ? [sessionEvents("pane", 1)] : [])
    ));
    const old = holdDetailSession("pane");
    old();
    const dashboard = connectLiveBriefStore();
    const first = holdDetailSession("pane");
    const second = holdDetailSession("pane");
    syncDashboardEvents({ selectedId: "pane", visibleIds: ["pane"], detailIds: ["pane"] });
    await settle();
    fakeDocument.visibilityState = "hidden";
    fireVisibilityChange();
    await settle();
    fakeDocument.visibilityState = "visible";
    fireVisibilityChange();
    await settle();
    stopEventPolling();
    dashboard();
    first();
    await vi.advanceTimersByTimeAsync(LIVE_EVENT_POLL_MS);
    expect(useLiveBriefStore.getState().eventsBySession.pane).toBeDefined();
    second();
    second();
    await vi.advanceTimersByTimeAsync(LIVE_EVENT_POLL_MS);
    const calls = backendSubscriptionCalls();
    expect(calls.filter((c) => c === "subscribe_live_briefs").length)
      .toBe(calls.filter((c) => c === "unsubscribe_live_briefs").length);
    expect(vi.getTimerCount()).toBe(0);
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

describe("followup subscription and detail regressions", () => {
  it("retries a failed subscribe and event listener on the next detail tick", async () => {
    let attempts = 0;
    mocks.listen.mockRejectedValueOnce(new Error("listen unavailable"));
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "subscribe_live_briefs" && attempts++ === 0) return Promise.reject(new Error("IPC unavailable"));
      return Promise.resolve([]);
    });
    const release = holdDetailSession("pane");
    await vi.advanceTimersByTimeAsync(0);
    expect(backendSubscriptionCalls()).toEqual(["subscribe_live_briefs"]);
    const listenerCalls = mocks.listen.mock.calls.length;
    await vi.advanceTimersByTimeAsync(LIVE_EVENT_POLL_MS);
    expect(backendSubscriptionCalls()).toEqual(["subscribe_live_briefs", "subscribe_live_briefs"]);
    expect(mocks.listen.mock.calls.length).toBe(listenerCalls + 1);
    await vi.advanceTimersByTimeAsync(LIVE_EVENT_POLL_MS);
    expect(backendSubscriptionCalls()).toHaveLength(2);
    release();
  });

  it("cleans up an uncertain subscribe that fails after the last reader closes", async () => {
    let reject!: (reason: Error) => void;
    mocks.invoke.mockImplementation((command: string) => command === "subscribe_live_briefs"
      ? new Promise((_, fail) => { reject = fail; }) : Promise.resolve([]));
    const release = connectLiveBriefStore();
    await settle();
    release();
    reject(new Error("reply lost"));
    await vi.advanceTimersByTimeAsync(0);
    expect(backendSubscriptionCalls()).toEqual(["subscribe_live_briefs", "unsubscribe_live_briefs"]);
  });

  it("retries failed unsubscribe on visibility and resubscribes after an in-flight release", async () => {
    let finish!: (value: unknown) => void;
    const release = connectLiveBriefStore();
    await vi.advanceTimersByTimeAsync(0);
    mocks.invoke.mockImplementationOnce(() => Promise.reject(new Error("unsubscribe lost")));
    fakeDocument.visibilityState = "hidden";
    fireVisibilityChange();
    await vi.advanceTimersByTimeAsync(0);
    fireVisibilityChange();
    await vi.advanceTimersByTimeAsync(0);
    expect(backendSubscriptionCalls()).toEqual(["subscribe_live_briefs", "unsubscribe_live_briefs", "unsubscribe_live_briefs"]);
    fakeDocument.visibilityState = "visible";
    fireVisibilityChange();
    await vi.advanceTimersByTimeAsync(0);
    mocks.invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    release();
    await settle();
    const releaseNext = connectLiveBriefStore();
    finish([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(backendSubscriptionCalls().slice(-2)).toEqual(["unsubscribe_live_briefs", "subscribe_live_briefs"]);
    releaseNext();
  });

  it("polls every detail owner beyond sixty in bounded batches and survives a batch failure", async () => {
    fakeDocument.visibilityState = "hidden";
    const ids = Array.from({ length: 125 }, (_, i) => `detail-${i}`);
    syncDashboardEvents({ selectedId: ids[0], visibleIds: [], detailIds: ids.slice(0, 70) });
    const releases = ids.slice(65).map(holdDetailSession);
    mocks.invoke.mockImplementation((command: string, args: { ptySessionIds: string[] }) => {
      if (command !== "get_live_events") return Promise.resolve([]);
      return Promise.resolve(args.ptySessionIds.map((id) => sessionEvents(id, 1)));
    });
    fakeDocument.visibilityState = "visible";
    fireVisibilityChange();
    await vi.advanceTimersByTimeAsync(0);
    expect(eventCalls().map((call) => call.ptySessionIds.length)).toEqual([60, 60, 5]);
    expect(eventCalls().flatMap((call) => call.ptySessionIds)).toEqual(ids);
    expect(Object.keys(useLiveBriefStore.getState().eventsBySession)).toHaveLength(125);
    mocks.invoke.mockClear();
    mocks.invoke.mockImplementationOnce(() => Promise.reject(new Error("first batch unavailable")));
    await vi.advanceTimersByTimeAsync(LIVE_EVENT_POLL_MS);
    expect(eventCalls().flatMap((call) => call.ptySessionIds)).toEqual(ids);
    stopEventPolling();
    expect(useLiveBriefStore.getState().eventsBySession[ids[124]]).toHaveLength(1);
    releases.forEach((release) => release());
    await vi.advanceTimersByTimeAsync(0);
    expect(useLiveBriefStore.getState().eventsBySession).toEqual({});
  });
});
