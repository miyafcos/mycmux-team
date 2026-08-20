import { describe, expect, it } from "vitest";
import {
  resolveScrollbackRestorePolicy,
  shouldFinalizePersistedInitialReplay,
} from "../../src/components/terminal/scrollbackRestorePolicy";

describe("scrollback restore policy", () => {
  const snapshot = ["plain snapshot"];

  it("prioritizes a cold persisted ring over plain-text replay", () => {
    expect(resolveScrollbackRestorePolicy({
      isSessionAlive: false,
      hasPersistedScrollback: true,
      isAgentTab: false,
      initialReplay: snapshot,
    })).toEqual({ usePersistedScrollback: true, initialReplay: undefined });
  });

  it("falls back to the plain snapshot only for a non-agent tab without a ring", () => {
    expect(resolveScrollbackRestorePolicy({
      isSessionAlive: false,
      hasPersistedScrollback: false,
      isAgentTab: false,
      initialReplay: snapshot,
    })).toEqual({ usePersistedScrollback: false, initialReplay: snapshot });
    expect(resolveScrollbackRestorePolicy({
      isSessionAlive: false,
      hasPersistedScrollback: false,
      isAgentTab: true,
      initialReplay: snapshot,
    })).toEqual({ usePersistedScrollback: false, initialReplay: undefined });
  });

  it("runs persisted restore finalization only for cold initial replay", () => {
    expect(shouldFinalizePersistedInitialReplay(true, "initial-replay")).toBe(true);
    expect(shouldFinalizePersistedInitialReplay(true, "append")).toBe(false);
    expect(shouldFinalizePersistedInitialReplay(false, "initial-replay")).toBe(false);
  });
});
