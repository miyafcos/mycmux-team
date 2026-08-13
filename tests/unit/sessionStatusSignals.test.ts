import { describe, expect, it } from "vitest";

import { readSessionStatusSignals } from "../../src/lib/sessionStatusSignals";

describe("readSessionStatusSignals", () => {
  it("reads the current Rust snake_case status feed values", () => {
    expect(readSessionStatusSignals({
      activity: "running_silent",
      health: "fresh",
      last_output_at: 10,
      last_monitor_at: 11,
      last_evidence_at: 12,
      process: { started_at: 13 },
    })).toEqual({
      activity: "running_silent",
      health: "fresh",
      lastOutputAt: 10,
      lastMonitorAt: 11,
      lastEvidenceAt: 12,
      processStartedAt: 13,
    });
  });

  it("accepts explicitly supported enum spellings from older feed versions", () => {
    expect(readSessionStatusSignals({ activity: "RunningSilent", health: "Degraded" }))
      .toMatchObject({ activity: "running_silent", health: "degraded" });
  });

  it("fails closed for missing or malformed values", () => {
    expect(readSessionStatusSignals({})).toEqual({
      activity: "unknown", health: "unknown", lastOutputAt: null,
      lastMonitorAt: null, lastEvidenceAt: null, processStartedAt: null,
    });
    expect(readSessionStatusSignals({
      activity: "unexpected",
      health: [],
      last_output_at: -1,
      last_monitor_at: "12",
      last_evidence_at: Number.NaN,
      process: null,
    })).toEqual({
      activity: "unknown", health: "unknown", lastOutputAt: null,
      lastMonitorAt: null, lastEvidenceAt: null, processStartedAt: null,
    });
  });
});
