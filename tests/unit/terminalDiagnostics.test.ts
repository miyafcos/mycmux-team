import { afterEach, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke }));
import { makeSessionId } from "../../src/lib/constants";
import { reportTerminalDiagnostic, terminalDiagnosticPayload, TERMINAL_DIAGNOSTIC_WINDOW_MS } from "../../src/lib/terminalDiagnostics";

afterEach(() => { vi.useRealTimers(); invoke.mockClear(); });
it("diagnostics_twoCausesInOneWindowStayAttributable", () => {
  vi.useFakeTimers();
  for (let i = 0; i < 60; i++) {
    for (const [reason, result] of [["paint", "failed"], ["channel", "end"]] as const) {
      reportTerminalDiagnostic("recovery", "start", "abcd1234", {}, { reused: Number(reason === "paint") }, { reason });
      reportTerminalDiagnostic("recovery", result, "abcd1234", {}, { reused: Number(reason === "paint") }, { reason });
    }
  }
  vi.advanceTimersByTime(TERMINAL_DIAGNOSTIC_WINDOW_MS);
  const rows = invoke.mock.calls.map(([, args]) => args.diagnostic);
  expect(rows.slice(0, -1).map(row => [row.reason, row.event])).toEqual([
    ["paint", "start"], ["paint", "failed"], ["channel", "start"], ["channel", "end"],
  ]);
  expect(rows.at(-1)).toMatchObject({ event: "coalesced", numbers: {
    count_paint_start: 59, count_paint_failed: 59, count_channel_start: 59, count_channel_end: 59,
  } });
});

it("diagnostic lines only accept bounded numbers, fixed enums and short IDs", () => {
  const sample = "synthetic title /example/private OSC-value";
  const row = terminalDiagnosticPayload("progress", "stall", sample, { attempt: 2, budget: NaN, [sample]: 42 },
    { actual: sample as "dom", exception: sample as "error", reason: sample as "paint" });
  expect(JSON.stringify(row)).not.toContain(sample);
  expect(row.numbers).toEqual({ attempt: 2 });
  expect(terminalDiagnosticPayload("progress", "stall", "abcdef12-1234", {}).session).toBe("abcdef12");
  const tabA = makeSessionId("aabbccdd-0000", "11110000-1111-4222-8333-444455556666-00000001-8888-4999-8aaa-bbbbbbbbbbbb");
  const tabB = makeSessionId("aabbccdd-0000", "11110000-1111-4222-8333-444455556666-00000002-8888-4999-8aaa-bbbbbbbbbbbb");
  const key = (id: string) => terminalDiagnosticPayload("progress", "stall", id, {}).session;
  expect(key(tabA)).toMatch(/^[a-f0-9]{8}$/);
  expect(key(tabB)).toMatch(/^[a-f0-9]{8}$/);
  expect(key(tabA)).not.toBe(key(tabB));
  expect(key("pty-/private/file/00000001-8888-4999-8aaa-bbbbbbbbbbbb")).toBe("unknown");
});

it("heartbeat counts live parse tickets until both accepted and cancelled callbacks end", async () => {
  const { beginTerminalBufferWrite, liveTerms, terminalHeartbeatCounts } =
    await import("../../src/components/terminal/terminalCache");
  const { ptyReadGeneration } = await import("../../src/lib/ptyReadGeneration");
  const term = {} as import("@xterm/xterm").Terminal;
  const gen = ptyReadGeneration("sample");
  liveTerms.set("sample", term);
  try {
    const a = beginTerminalBufferWrite("sample", term, gen);
    const b = beginTerminalBufferWrite("sample", term, gen);
    expect(terminalHeartbeatCounts().pendingTickets).toBe(2);
    a(false);
    expect(terminalHeartbeatCounts().pendingTickets).toBe(1);
    b(true);
    expect(terminalHeartbeatCounts().pendingTickets).toBe(0);
  } finally { liveTerms.delete("sample"); }
});

it("diagnostic detail stays bounded while every overflow reason/result is counted", () => {
  vi.useFakeTimers();
  const id = "c0ffee21";
  const term = {};
  let events = 0;
  for (let n = 0; n < 3; n++) {
    for (const event of ["context-loss", "budget-evict", "dispose-result", "retry", "exhausted", "fallback-ready"] as const) {
      reportTerminalDiagnostic("renderer", event, id, term); events++;
    }
    for (const reason of ["paint", "channel"] as const) {
      for (const outcome of ["start", "end", "failed", "aborted"] as const) {
        reportTerminalDiagnostic("recovery", outcome, id, term, {}, { reason }); events++;
      }
    }
    reportTerminalDiagnostic("renderer", "dispose-result", id, term, { dispose_ok: 0 }); events++;
    reportTerminalDiagnostic("progress", "stall", id, term, {}, { reason: "channel" }); events++;
    reportTerminalDiagnostic("progress", "stall", id, term, {}, { reason: "paint" }); events++;
  }
  vi.advanceTimersByTime(TERMINAL_DIAGNOSTIC_WINDOW_MS);
  const rows = invoke.mock.calls.map(([, args]) => args.diagnostic);
  expect(rows.length).toBeLessThanOrEqual(17);
  const summary = rows.at(-1);
  expect(summary.numbers.coalesced + rows.length - 1).toBe(events);
  expect(summary.numbers.count_paint_stall).toBe(3);
});
