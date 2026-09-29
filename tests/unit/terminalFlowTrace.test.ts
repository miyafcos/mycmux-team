import { afterEach, expect, it, vi } from "vitest";
import {
  setTerminalFlowTrace, recordTerminalFlowReceive, startTerminalFlowWrite,
  finishTerminalFlowWrite, recordTerminalFlowRender, readTerminalFlowTrace,
} from "../../src/lib/terminalFlowTrace";

afterEach(() => { setTerminalFlowTrace(null); vi.restoreAllMocks(); });

it("counts receive, parser callback and draw separately for only the selected session", () => {
  let now = 1;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  setTerminalFlowTrace("one");
  recordTerminalFlowReceive("other", 100, false);
  expect(startTerminalFlowWrite("other", "abc")).toBeNull();
  recordTerminalFlowReceive("one", 3, false);
  const write = startTerminalFlowWrite("one", "\u3042");
  expect(readTerminalFlowTrace()).toMatchObject({ receivedBytes: 3, pendingWrites: 1, pendingWriteBytes: 3, renderCalls: 0 });
  now += 2; finishTerminalFlowWrite(write);
  now += 1; recordTerminalFlowRender("one");
  expect(readTerminalFlowTrace()).toMatchObject({ writeInputBytes: 3, completedWrites: 1, pendingWrites: 0, pendingWriteBytes: 0, renderCalls: 1, callbackTotalMs: 2 });
});

it("ignores callbacks from a previous measurement and freezes on stop", () => {
  setTerminalFlowTrace("one"); const previous = startTerminalFlowWrite("one", "before");
  setTerminalFlowTrace("one"); finishTerminalFlowWrite(previous);
  expect(readTerminalFlowTrace()).toMatchObject({ completedWrites: 0, pendingWrites: 0 });
  setTerminalFlowTrace(null); recordTerminalFlowReceive("one", 500, true);
  expect(startTerminalFlowWrite("one", "after")).toBeNull();
  expect(readTerminalFlowTrace()).toMatchObject({ active: false, receivedBytes: 0 });
});

it("bounds latency samples while keeping full counters", () => {
  setTerminalFlowTrace("one");
  for (let i = 0; i < 5000; i++) finishTerminalFlowWrite(startTerminalFlowWrite("one", new Uint8Array(4)));
  expect(readTerminalFlowTrace()).toMatchObject({ writeCalls: 5000, completedWrites: 5000, writeInputBytes: 20000, pendingWrites: 0, retainedCallbackSamples: 1024 });
});
