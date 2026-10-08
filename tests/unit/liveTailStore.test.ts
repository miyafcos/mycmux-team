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
  it("reads only working, waiting, or previously working-screen targets", async () => {
    targets = [target("working"), target("waiting", "waiting"), target("idle", "idle")];
    controller.acquireConsumer("sidebar"); await vi.advanceTimersByTimeAsync(0);
    expect(read.mock.calls.map((c) => c[0])).toEqual(["working", "waiting"]);
    targets = targets.map((t) => ({ ...t, status: "idle", waitingForReply: false }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(read.mock.calls.map((c) => c[0])).toEqual(["working", "waiting", "working", "waiting"]);
    read.mockResolvedValue(["* Cooked for 3s \u00b7 done 01:00"]);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(controller.snapshot().tabs).toEqual([]);
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
  it("returns unreadable for failed reads and retries after a previously working screen", async () => {
    controller.acquireConsumer("sidebar"); await vi.advanceTimersByTimeAsync(0);
    targets = [target("working", "idle")]; read.mockRejectedValue(new Error("screen unavailable"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(controller.snapshot().tabs[0]).toMatchObject({ readable: false, fact: { kind: "unreadable" } });
    await vi.advanceTimersByTimeAsync(2_000); expect(read).toHaveBeenCalledTimes(3);
  });
  it("bounds a hung first read, does not accept late data, and does not overlap it", async () => {
    let complete!: (rows: string[]) => void;
    read.mockReturnValue(new Promise<string[]>((resolve) => { complete = resolve; }));
    const result = controller.getForApi();
    await vi.advanceTimersByTimeAsync(LIVE_TAIL_READ_TIMEOUT_MS);
    expect((await result).tabs[0]).toMatchObject({ readable: false, fact: { kind: "unreadable" } });
    await vi.advanceTimersByTimeAsync(4_000); expect(read).toHaveBeenCalledTimes(1);
    complete(["* Cooked for 3s \u00b7 done 01:00"]); await vi.advanceTimersByTimeAsync(0);
    expect(controller.snapshot().tabs[0].readable).toBe(false);
  });
  it("bounds hung target discovery and output snapshots as well as screen reads", async () => {
    const stuck = createLiveTailController({ listTargets: () => new Promise(() => {}), readTail: read, loadOutputs: outputs });
    const result = stuck.getForApi(); await vi.advanceTimersByTimeAsync(LIVE_TAIL_READ_TIMEOUT_MS);
    expect((await result).tabs).toEqual([]); stuck.dispose();
  });
});
