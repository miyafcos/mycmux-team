import { describe, expect, it } from "vitest";
import {
  confirmAgentSessionClear,
  confirmShellObservation,
  resetShellObservation,
} from "../../src/lib/agentSessionClearGuard";

describe("confirmShellObservation", () => {
  it("never confirms on the first shell observation", () => {
    expect(confirmShellObservation("s1", true, 0)).toBe(false);
    resetShellObservation("s1");
  });

  it("does not confirm while the shell state is younger than one polling window", () => {
    expect(confirmShellObservation("s2", true, 0)).toBe(false);
    expect(confirmShellObservation("s2", true, 5_000)).toBe(false);
    resetShellObservation("s2");
  });

  it("confirms once the shell state has persisted across polling ticks", () => {
    expect(confirmShellObservation("s3", true, 0)).toBe(false);
    expect(confirmShellObservation("s3", true, 10_000)).toBe(true);
    resetShellObservation("s3");
  });

  it("is idempotent for same-tick duplicate observers (listener + snapshot flush)", () => {
    expect(confirmShellObservation("s4", true, 0)).toBe(false);
    // The pre-save snapshot flush re-reports the exact same tick.
    expect(confirmShellObservation("s4", true, 0)).toBe(false);
    expect(confirmShellObservation("s4", true, 1)).toBe(false);
    resetShellObservation("s4");
  });

  it("resets when the agent is observed again (flap does not accumulate)", () => {
    expect(confirmShellObservation("s5", true, 0)).toBe(false);
    expect(confirmShellObservation("s5", false, 5_000)).toBe(false);
    // Shell again — the previous streak must not carry over.
    expect(confirmShellObservation("s5", true, 10_000)).toBe(false);
    expect(confirmShellObservation("s5", true, 20_000)).toBe(true);
    resetShellObservation("s5");
  });

  it("tracks sessions independently", () => {
    expect(confirmShellObservation("s6", true, 0)).toBe(false);
    expect(confirmShellObservation("s7", true, 10_000)).toBe(false);
    expect(confirmShellObservation("s6", true, 10_000)).toBe(true);
    resetShellObservation("s6");
    resetShellObservation("s7");
  });

  it("suppresses clearing while waiting and restarts the confirmation window", () => {
    expect(confirmAgentSessionClear("s8", true, false, false, 0)).toBe(false);

    // Waiting is positive evidence that the agent is still alive. It must
    // suppress clearing and discard the pre-wait shell streak.
    expect(confirmAgentSessionClear("s8", true, false, true, 10_000)).toBe(false);

    // Once waiting ends, confirmation starts over from the next observation.
    expect(confirmAgentSessionClear("s8", true, false, false, 10_001)).toBe(false);
    expect(confirmAgentSessionClear("s8", true, false, false, 20_001)).toBe(true);
    resetShellObservation("s8");
  });
});
