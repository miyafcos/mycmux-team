import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLiveTailController, LIVE_TAIL_HISTORY_LIMIT, LIVE_TAIL_READ_TIMEOUT_MS, type LiveTailTarget } from "../../src/stores/liveTailStore";

const start = 1_800_000_000_000;
const target = (id: string, status: LiveTailTarget["status"] = "working"): LiveTailTarget => ({
  sessionId: id, workspaceId: "workspace", workspaceName: "Sample Workspace", paneId: "pane", tabId: `tab-${id}`,
  name: `Seat ${id}`, agentKind: "claude", status, waitingForReply: status === "waiting",
});
let targets: LiveTailTarget[];
const read = vi.fn();
const outputs = vi.fn();
let controller: ReturnType<typeof createLiveTailController>;

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(start);
  targets = [target("working")];
  read.mockReset().mockResolvedValue(["* Thinking\u2026 (1s \u00b7 \u2193 10 tokens)"]);
  outputs.mockReset().mockImplementation(async () => Object.fromEntries(targets.map((t) => [t.sessionId, Date.now()])));
  controller = createLiveTailController({ listTargets: async () => targets, readTail: read, loadOutputs: outputs });
});
afterEach(() => { controller.dispose(); vi.useRealTimers(); });

describe("live-tail demand and bounded observations", () => {
  it("does not read without a consumer and ticks at 2s with a sidebar consumer", async () => {
    await vi.advanceTimersByTimeAsync(20_000); expect(read).not.toHaveBeenCalled();
    const release = controller.acquireConsumer("sidebar");
    await vi.advanceTimersByTimeAsync(0); expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_999); expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(read).toHaveBeenCalledTimes(2);
    release(); release();
    await vi.advanceTimersByTimeAsync(10_000); expect(read).toHaveBeenCalledTimes(2);
  });
  it("reference-counts consumers with the same name", async () => {
    const a = controller.acquireConsumer("sidebar"), b = controller.acquireConsumer("sidebar");
    await vi.advanceTimersByTimeAsync(0); a();
    await vi.advanceTimersByTimeAsync(2_000); expect(read).toHaveBeenCalledTimes(2);
    b(); await vi.advanceTimersByTimeAsync(2_000); expect(read).toHaveBeenCalledTimes(2);
  });
  it("expires API demand 10s after the latest call", async () => {
    await controller.getForApi(); expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9_000);
    const before = read.mock.calls.length;
    await controller.getForApi();
    await vi.advanceTimersByTimeAsync(9_000); expect(read.mock.calls.length).toBeGreaterThan(before);
    await vi.advanceTimersByTimeAsync(1_000);
    const after = read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000); expect(read).toHaveBeenCalledTimes(after);
  });
  it("stops reading when trusted idle supersedes a previously working screen", async () => {
    targets = [target("working"), target("waiting", "waiting"), target("idle", "idle")];
    controller.acquireConsumer("sidebar"); await vi.advanceTimersByTimeAsync(0);
    expect(read.mock.calls.map((c) => c[0])).toEqual(["working", "waiting"]);
    targets = targets.map((t) => ({ ...t, status: "idle", waitingForReply: false }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(read.mock.calls.map((c) => c[0])).toEqual(["working", "waiting"]);
    read.mockResolvedValue(["* Cooked for 3s \u00b7 done 01:00"]);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    // Both projections retain neutral idle presentation; polling still stops.
    expect(controller.snapshot().tabs.map(tab => ({ id: tab.sessionId, kind: tab.fact.kind, readable: tab.readable })))
      .toEqual([{ id: "working", kind: "idle", readable: true }, { id: "waiting", kind: "idle", readable: true }, { id: "idle", kind: "idle", readable: false }]);
  });
  it("keeps waiting attention independent of the screen fact", async () => {
    targets = [target("waiting", "waiting")];
    read.mockResolvedValue(["* Cooked for 3s \u00b7 done 01:00"]);
    expect((await controller.getForApi()).tabs[0]).toMatchObject({ waitingForReply: true, fact: { kind: "idle" } });
  });
  it("bounds histories and removes closed sessions", async () => {
    controller.acquireConsumer("sidebar");
    await vi.advanceTimersByTimeAsync((LIVE_TAIL_HISTORY_LIMIT + 10) * 2_000);
    expect(controller.store.getState().entries.working.history).toHaveLength(LIVE_TAIL_HISTORY_LIMIT);
    targets = []; await vi.advanceTimersByTimeAsync(2_000);
    expect(controller.store.getState().entries).toEqual({});
  });
  it("isolates a throwing subscriber and continues reads and other subscribers", async () => {
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    const healthy = vi.fn();
    controller.store.subscribe(() => { throw new Error("subscriber failure"); });
    controller.store.subscribe(healthy);
    controller.acquireConsumer("sidebar"); await vi.advanceTimersByTimeAsync(4_000);
    expect(read).toHaveBeenCalledTimes(3); expect(healthy).toHaveBeenCalled();
    logger.mockRestore();
  });
  it("retains one failed sample with its age, then returns unreadable after repeated failures", async () => {
    controller.acquireConsumer("sidebar"); await vi.advanceTimersByTimeAsync(0);
    targets = [target("working")]; read.mockRejectedValue(new Error("screen unavailable"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(controller.snapshot().tabs[0]).toMatchObject({ readable: true, observedAt: start });
    expect(controller.store.getState().entries.working.history).toHaveLength(1);
    expect(controller.store.getState().entries.working.retained).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000); expect(read).toHaveBeenCalledTimes(3);
    expect(controller.snapshot().tabs[0]).toMatchObject({ readable: false, fact: { kind: "unreadable" } });
  });
  it("bounds a hung first read, accepts valid late data, and does not overlap it", async () => {
    let complete!: (rows: string[]) => void;
    read.mockReturnValue(new Promise<string[]>((resolve) => { complete = resolve; }));
    const result = controller.getForApi();
    await vi.advanceTimersByTimeAsync(LIVE_TAIL_READ_TIMEOUT_MS);
    expect((await result).tabs[0]).toMatchObject({ readable: false, fact: { kind: "alive" } });
    await vi.advanceTimersByTimeAsync(4_000); expect(read).toHaveBeenCalledTimes(1);
    complete(["* Cooked for 3s \u00b7 done 01:00"]); await vi.advanceTimersByTimeAsync(0);
    expect(controller.snapshot().tabs[0]).toMatchObject({ readable: true, fact: { kind: "idle" } });
    read.mockReturnValue(new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(controller.snapshot().tabs[0]).toMatchObject({ readable: true, rows: ["* Cooked for 3s \u00b7 done 01:00"] });
  });
  it("bounds hung target discovery and output snapshots as well as screen reads", async () => {
    const stuck = createLiveTailController({ listTargets: () => new Promise(() => {}), readTail: read, loadOutputs: outputs });
    const result = stuck.getForApi(); await vi.advanceTimersByTimeAsync(LIVE_TAIL_READ_TIMEOUT_MS);
    expect((await result).tabs).toEqual([]); stuck.dispose();
  });
  it("bounds read starts per observation and actual concurrency and fairly visits overflow", async () => {
    targets = Array.from({ length: 25 }, (_, index) => target(`seat-${index}`));
    let active = 0, peak = 0;
    read.mockImplementation(() => new Promise<string[]>(resolve => {
      active += 1; peak = Math.max(peak, active);
      setTimeout(() => { active -= 1; resolve(["* Thinking… (1s · ↓ 10 tokens)"]); }, 20);
    }));
    const first = controller.getForApi(); await vi.advanceTimersByTimeAsync(1_500); await first;
    expect(peak).toBeLessThanOrEqual(2); expect(read).toHaveBeenCalledTimes(12);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(new Set(read.mock.calls.map(call => call[0])).size).toBe(25);
  });
  it("keeps timed-out reads occupying the global concurrency budget across ticks", async () => {
    targets = Array.from({ length: 25 }, (_, index) => target(`seat-${index}`));
    read.mockReturnValue(new Promise(() => {}));
    const result = controller.getForApi(); await vi.advanceTimersByTimeAsync(LIVE_TAIL_READ_TIMEOUT_MS); await result;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("uses one shared deadline for discovery and reads, then accepts the same late screen", async () => {
    controller.dispose();
    controller = createLiveTailController({
      listTargets: () => new Promise(resolve => setTimeout(() => resolve(targets), 1_200)),
      readTail: () => new Promise(resolve => setTimeout(() => resolve(["resumed final answer"]), 400)),
      loadOutputs: outputs,
    });
    let returned = false;
    const first = controller.getForApi().then(value => { returned = true; return value; });
    await vi.advanceTimersByTimeAsync(1_500); expect(returned).toBe(true); await first;
    await vi.advanceTimersByTimeAsync(100);
    expect(controller.snapshot().tabs[0]).toMatchObject({ readable: true, rows: ["resumed final answer"] });
  });
  it.each(["closed", "replaced", "released", "disposed"] as const)("ignores a late read after the target is %s", async reason => {
    let complete!: (rows: string[]) => void;
    read.mockReturnValueOnce(new Promise<string[]>(resolve => { complete = resolve; }));
    const release = controller.acquireConsumer("sidebar");
    await vi.advanceTimersByTimeAsync(1_500);
    if (reason === "closed") targets = [];
    if (reason === "replaced") targets = [{ ...target("working"), tabId: "replacement-tab" }];
    if (reason === "released") release();
    if (reason === "disposed") controller.dispose();
    await vi.advanceTimersByTimeAsync(500);
    complete(["obsolete late screen"]); await vi.advanceTimersByTimeAsync(0);
    expect(controller.store.getState().entries.working?.evidence.observation.rawRows ?? []).not.toContain("obsolete late screen");
  });
  it("does not renew observation history or timestamps during discovery failure", async () => {
    controller.dispose();
    const list = vi.fn(async () => targets);
    controller = createLiveTailController({ listTargets: list, readTail: read, loadOutputs: outputs });
    controller.acquireConsumer("sidebar"); await vi.advanceTimersByTimeAsync(0);
    list.mockRejectedValue(new Error("snapshot unavailable"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(controller.snapshot().tabs[0]).toMatchObject({ readable: true, observedAt: start });
    expect(controller.store.getState().entries.working.history).toHaveLength(1);
  });
  it("keeps the same output timestamp in the first response when it arrives after the screen", async () => {
    outputs.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve({ working: start }), 100)));
    const result = controller.getForApi(); await vi.advanceTimersByTimeAsync(100);
    expect((await result).tabs[0]).toMatchObject({ lastOutputAt: start, observedAt: start });
    expect(controller.store.getState().entries.working.history).toHaveLength(1);
  });
  it("limits repeated API calls within one polling interval and preserves the full target list", async () => {
    targets = Array.from({ length: 25 }, (_, index) => target(`seat-${index}`));
    const first = await controller.getForApi();
    expect(first.tabs).toHaveLength(25);
    await controller.getForApi(); await controller.getForApi();
    expect(read).toHaveBeenCalledTimes(12);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(read).toHaveBeenCalledTimes(24);
  });
  it("preserves cached screens without counting skipped work as new observations", async () => {
    controller.acquireConsumer("sidebar"); await vi.advanceTimersByTimeAsync(0);
    let complete!: (rows: string[]) => void;
    read.mockReturnValueOnce(new Promise<string[]>(resolve => { complete = resolve; }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(controller.snapshot().tabs[0]).toMatchObject({ readable: true, observedAt: start });
    expect(controller.store.getState().entries.working.history).toHaveLength(1);
    complete(["* Thinking… (2s · ↓ 11 tokens)"]); await vi.advanceTimersByTimeAsync(0);
    expect(controller.store.getState().entries.working.history).toHaveLength(2);
  });
  it("marks a readable overflow screen as retained when its turn is skipped", async () => {
    targets = Array.from({ length: 13 }, (_, index) => target(`seat-${index}`));
    controller.acquireConsumer("sidebar"); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(controller.store.getState().entries["seat-11"]).toMatchObject({ retained: true, history: [expect.anything()] });
    expect(controller.snapshot().tabs.find(tab => tab.sessionId === "seat-11")).toMatchObject({ readable: true, observedAt: start });
  });
});
