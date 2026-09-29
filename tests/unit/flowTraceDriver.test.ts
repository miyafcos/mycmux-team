import { expect, it, vi } from "vitest";
import { nativeFlowValues, startFlowTrace, finishFlowTrace } from "../../scripts/perf/flow-trace.mjs";

it("keeps only the selected session's native flow counters", () => {
  expect(nativeFlowValues([
    { name: "pty.flow.read.bytes", id: "one", value: 4096 },
    { name: "pty.flow.read.bytes", id: "other", value: 8192 },
    { name: "pty.spawn.end", id: "one", value: 12 },
    { name: "pty.flow.active", id: "one", value: 0 },
  ], "one")).toEqual({ "read.bytes": 4096, active: 0 });
});

it("refuses an old binary before enabling native diagnostics", async () => {
  const cdp = { eval: vi.fn().mockResolvedValue(false), invoke: vi.fn() };
  await expect(startFlowTrace(cdp, "one")).rejects.toThrow("does not support");
  expect(cdp.invoke).not.toHaveBeenCalled();
});

it("drains outstanding parser work before the frame fence and freezes both traces", async () => {
  const marks = [{ name: "pty.flow.channel.bytes", id: "one", value: 32 }];
  let polls = 0;
  const cdp = {
    invoke: vi.fn().mockResolvedValue(marks),
    eval: vi.fn(async (expression: string) => {
      if (expression.startsWith("new Promise")) return { painted: true, atMs: 500 };
      if (expression.includes("setTerminalFlowTrace(null)")) return { sessionId: "one", active: false, pendingWrites: 0, completedWrites: 1, receivedBytes: 32 };
      return { sessionId: "one", pendingWrites: polls++ === 0 ? 1 : 0, receivedBytes: 32 };
    }),
  };
  const result = await finishFlowTrace(cdp, "one");
  expect(polls).toBe(2);
  expect(cdp.invoke).toHaveBeenLastCalledWith("perf_timeline_read", { stopFlowTrace: true });
  expect(result).toMatchObject({ native: { "channel.bytes": 32 }, frontend: { active: false }, frameFence: { painted: true }, integrity: { pass: true, issues: [] } });
});

it("preserves evidence but rejects a missed frame or a hidden auto-consume sample", async () => {
  const marks = [{ name: "pty.flow.auto_consume.calls", id: "one", value: 1 }];
  const cdp = {
    invoke: vi.fn().mockResolvedValue(marks),
    eval: vi.fn(async (expression: string) => expression.startsWith("new Promise")
      ? { painted: false } : { sessionId: "one", receivedBytes: 0, pendingWrites: 0, completedWrites: 0 }),
  };
  const result = await finishFlowTrace(cdp, "one");
  expect(result.integrity.pass).toBe(false);
  expect(result.integrity.issues).toContain("frame deadline expired");
  expect(result.integrity.issues).toContain("auto_consume");
});
