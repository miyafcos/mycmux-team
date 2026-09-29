// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAttachEpochStateForTests, beginSessionAttach } from "../../src/lib/attachEpoch";
import {
  TearOutDragTrace,
  clearTearOutDiagnosticEvents,
  createTearOutDragTrace,
  getTearOutDiagnosticEvents,
  observeTearOutDestination,
  outsideWindowDistancePx,
  type TearOutDiagnosticEvent,
  type TearOutPointerSample,
} from "../../src/lib/tearOutDiagnostics";

const inside: TearOutPointerSample = {
  clientX: 100,
  clientY: 80,
  screenX: 500,
  screenY: 400,
  viewportWidth: 1_200,
  viewportHeight: 800,
};

const outside: TearOutPointerSample = {
  ...inside,
  clientX: -41,
  screenX: 359,
};

describe("tear-out diagnostic state machine", () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetAttachEpochStateForTests();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("records every normal state with one dragId and the required measurements", () => {
    let now = 1_000;
    const events: TearOutDiagnosticEvent[] = [];
    const trace = new TearOutDragTrace({
      itemKind: "tab",
      itemId: "tab-1",
      pointerId: 7,
      pointer: inside,
      sourceWindow: "main",
    }, {
      dragId: "drag-fixed",
      now: () => now,
      wallClock: () => new Date("2026-08-28T00:00:00.000Z"),
      log: (event) => events.push(event),
    });

    now = 1_009;
    trace.dragging(true);
    trace.updateCandidate(inside, null);
    now = 1_020;
    trace.arm(outside);
    now = 1_037;
    trace.pointerEvent("pointerup", outside);
    trace.commitPending("workspace-new", "session-1");
    trace.windowCreateRequested();
    trace.windowLabelAccepted("mycmux-w1");
    trace.sourceDetached();
    trace.committed();

    expect(events.filter((event) => event.event === "state").map((event) => event.state)).toEqual([
      "idle",
      "pressed",
      "dragging",
      "tearout-armed",
      "commit-pending",
      "committed",
    ]);
    expect(new Set(events.map((event) => event.dragId))).toEqual(new Set(["drag-fixed"]));
    expect(events.find((event) => event.state === "tearout-armed")).toMatchObject({
      itemKind: "tab",
      itemId: "tab-1",
      sourceWindow: "main",
      pointerId: 7,
      pointerCaptureSucceeded: true,
      clientX: -41,
      screenX: 359,
      outsideDistancePx: 41,
      tearoutArmedAtMs: 20,
      dwellMs: 0,
      candidateDropTarget: "new-window",
    });
    expect(events.at(-1)).toMatchObject({
      event: "state",
      state: "committed",
      workspaceId: "workspace-new",
      destinationWindow: "mycmux-w1",
      primarySessionId: "session-1",
      ptyConnectionState: "reattach-pending",
      ptyOwnerBefore: "main",
      ptyOwnerAfter: "mycmux-w1",
    });
  });

  it.each([
    ["cancelled" as const, (trace: TearOutDragTrace) => trace.transition("cancelled", "cancel")],
    ["capture-lost" as const, (trace: TearOutDragTrace) => trace.transition("capture-lost", "lost")],
    ["create-failed" as const, (trace: TearOutDragTrace) => trace.failed("create-failed", "create")],
    ["transfer-failed" as const, (trace: TearOutDragTrace) => trace.failed("transfer-failed", "transfer")],
    ["rolled-back" as const, (trace: TearOutDragTrace) => trace.rolledBack("rollback")],
  ])("records abnormal state %s", (expected, act) => {
    const events: TearOutDiagnosticEvent[] = [];
    const trace = new TearOutDragTrace({
      itemKind: "pane",
      itemId: "pane-1",
      pointerId: 3,
      pointer: inside,
      sourceWindow: "main",
    }, { log: (event) => events.push(event) });

    act(trace);

    expect(events.at(-1)?.state).toBe(expected);
  });

  it("records target adoption and a committed attach epoch in the destination window", () => {
    vi.useFakeTimers();
    const trace = new TearOutDragTrace({
      itemKind: "workspace",
      itemId: "workspace-1",
      pointerId: 11,
      pointer: outside,
      sourceWindow: "source-window",
    }, { dragId: "cross-window", log: () => undefined });
    trace.commitPending("workspace-1", "session-1");
    trace.windowCreateRequested();
    trace.windowLabelAccepted("main");
    beginSessionAttach("session-1", { deliver: () => undefined, ackStale: () => undefined }).commit();

    observeTearOutDestination(["workspace-1"]);
    vi.advanceTimersByTime(50);

    expect(getTearOutDiagnosticEvents().map((event) => event.event)).toEqual(expect.arrayContaining([
      "destination-adopted",
      "destination-attached",
    ]));
  });

  it("is fail-soft and keeps defensive event snapshots", () => {
    const trace = createTearOutDragTrace({
      itemKind: "workspace",
      itemId: "workspace-1",
      pointerId: 1,
      pointer: inside,
      sourceWindow: "main",
    }, { log: () => undefined });
    expect(trace).not.toBeNull();
    expect(outsideWindowDistancePx(outside)).toBe(41);

    const first = getTearOutDiagnosticEvents();
    first[0].state = "create-failed";
    expect(getTearOutDiagnosticEvents()[0].state).toBe("idle");

    clearTearOutDiagnosticEvents();
    expect(getTearOutDiagnosticEvents()).toEqual([]);
  });
});
