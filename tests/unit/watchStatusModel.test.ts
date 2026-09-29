import { describe, expect, it } from "vitest";
import { watchStatusModel } from "../../src/components/dashboard/watchStatusModel";

describe("watchStatusModel", () => {
  it("uses tick telemetry exactly and preserves the next scheduled check", () => {
    expect(watchStatusModel({ isMainWindow: true, running: true, lastTickAt: 100, nextTickDueAt: 160, lastSkipReason: null, notifySuppressed: false }))
      .toMatchObject({ state: "running", lastTickAt: 100, nextTickDueAt: 160 });
  });

  it("records a hidden skip without inventing queue state", () => {
    expect(watchStatusModel({ isMainWindow: true, running: false, lastTickAt: null, nextTickDueAt: null, lastSkipReason: "hidden", notifySuppressed: false }))
      .toMatchObject({ state: "stopped", skipReason: "hidden" });
  });

  it("keeps null telemetry explicitly unmeasured and surfaces notification suppression", () => {
    expect(watchStatusModel({ isMainWindow: true, running: false, lastTickAt: null, nextTickDueAt: null, lastSkipReason: null, notifySuppressed: true }))
      .toMatchObject({ state: "unmeasured", notifySuppressed: true });
  });

  it("marks a child window as intentionally stopped without reading stale telemetry", () => {
    expect(watchStatusModel({ isMainWindow: false, running: true, lastTickAt: 100, nextTickDueAt: 160, lastSkipReason: null, notifySuppressed: false }))
      .toMatchObject({ state: "stopped", skipReason: "not-main-window", lastTickAt: null });
  });
});
