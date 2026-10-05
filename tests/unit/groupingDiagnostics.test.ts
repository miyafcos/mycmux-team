import { describe, expect, it, vi } from "vitest";
import { beginGroupingTrace } from "../../src/lib/groupingDiagnostics";
describe("grouping diagnostic privacy and settlement", () => {
  it("emits one record with all stage timestamps and a finite reason", () => {
    let at = 100;
    const sink = vi.fn();
    const trace = beginGroupingTrace(sink, () => at++);
    for (const stage of ["settings", "scan", "jev", "prepare", "apply"] as const) trace.mark(stage);
    trace.finish("applied"); trace.finish("error"); trace.mark("scan");
    expect(sink).toHaveBeenCalledTimes(1);
    const record = sink.mock.calls[0][0];
    expect(record.reason).toBe("applied");
    expect(record.stages).toEqual({ entry: 100, settings: 101, scan: 102, jev: 103, prepare: 104, apply: 105, finish: 106 });
    expect(Object.keys(record).sort()).toEqual(["operationId", "reason", "stages"]);
    expect(JSON.stringify(record)).not.toContain("name");
  });
  it("contains diagnostic failures and records abandonment", () => {
    const sink = vi.fn(() => { throw new Error("unavailable"); });
    const trace = beginGroupingTrace(sink, () => 1);
    expect(() => trace.finish("cancelled")).not.toThrow();
    expect(sink).toHaveBeenCalledTimes(1);
  });
});
