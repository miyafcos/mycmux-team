import { describe, expect, it } from "vitest";

import {
  classifyStallCandidate,
  observeScreenActivity,
  selectStallCandidates,
  type StallStageOneSession,
} from "../../src/stores/stallStore";
import { TAB_SWEEP_IDLE_MS } from "../../src/components/layout/tabSweep";

const NOW = 1_000_000;

function session(overrides: Partial<StallStageOneSession> = {}): StallStageOneSession {
  return {
    sessionId: "session",
    type: "terminal",
    attentionKind: "none",
    attentionUiState: "idle",
    lastLogAt: NOW - TAB_SWEEP_IDLE_MS,
    processStatusReason: null,
    hasLivePty: true,
    hasTerminalBuffer: false,
    ...overrides,
  };
}

describe("selectStallCandidates", () => {
  it("uses the newest activity timestamp and includes the exact idle boundary", () => {
    const candidates = selectStallCandidates([
      session({ sessionId: "boundary" }),
      session({ sessionId: "fresh-status", screenStatusAt: NOW - TAB_SWEEP_IDLE_MS + 1 }),
      session({ sessionId: "fresh-agent", agentStatusAt: NOW - TAB_SWEEP_IDLE_MS + 1 }),
    ], NOW);

    expect(candidates).toEqual([{ sessionId: "boundary", since: NOW - TAB_SWEEP_IDLE_MS, ptyDead: false, processActivity: "unknown" }]);
  });

  it("excludes attention and accepts a terminal buffer without a live PTY snapshot", () => {
    const candidates = selectStallCandidates([
      session({ sessionId: "attention", attentionKind: "input" }),
      session({ sessionId: "working", attentionUiState: "working" }),
      session({ sessionId: "buffer", hasLivePty: false, hasTerminalBuffer: true, processStatusReason: "snapshot_unavailable" }),
      session({ sessionId: "not-terminal", type: "browser" }),
    ], NOW);

    expect(candidates).toEqual([{ sessionId: "buffer", since: NOW - TAB_SWEEP_IDLE_MS, ptyDead: false, processActivity: "unknown" }]);
  });

  it("adds a confirmed dead PTY without waiting for an idle interval", () => {
    expect(selectStallCandidates([
      session({ sessionId: "dead", lastLogAt: NOW, processStatusReason: "no_live_pty_session", hasLivePty: false }),
    ], NOW)).toEqual([{ sessionId: "dead", since: NOW, ptyDead: true, processActivity: "unknown" }]);
  });
});

describe("classifyStallCandidate", () => {
  it("classifies a dead PTY without using a tail", () => {
    expect(classifyStallCandidate({ sessionId: "dead", since: 10, ptyDead: true }, [])).toEqual({
      sessionId: "dead", reason: "pty_dead", since: 10,
    });
  });

  it("keeps an idle prompt waiting while retaining queued-input detection", () => {
    expect(classifyStallCandidate({ sessionId: "idle", since: 10, ptyDead: false }, ["❯"])).toBeNull();
    expect(classifyStallCandidate({ sessionId: "queued", since: 10, ptyDead: false }, ["❯ typed text"])).toEqual({
      sessionId: "queued", reason: "queued_input", since: 10, detail: "typed text",
    });
  });

  it("clips a queued preview and avoids a finding without a prompt", () => {
    const input = "x".repeat(140);
    expect(classifyStallCandidate({ sessionId: "queued", since: 10, ptyDead: false }, [`❯ ${input}`])).toEqual({
      sessionId: "queued", reason: "queued_input", since: 10, detail: "x".repeat(120),
    });
    expect(classifyStallCandidate({ sessionId: "unknown", since: 10, ptyDead: false }, ["still working"])).toBeNull();
  });
});

describe("observeScreenActivity", () => {
  it("does not reset the silent clock for cosmetic raw screen churn", () => {
    const first = observeScreenActivity(undefined, 10, "same", 100);
    const cosmeticChurn = observeScreenActivity(first, 20, "same", 200);
    expect(cosmeticChurn.lastActivityAt).toBe(100);
    expect(classifyStallCandidate(
      { sessionId: "silent", since: 10, ptyDead: false, processActivity: "running_silent" },
      [],
      false,
      TAB_SWEEP_IDLE_MS,
    )).toEqual({ sessionId: "silent", reason: "silent", since: 10 });
  });

  it("treats raw offset progress as activity only when a fingerprint is unavailable", () => {
    const first = observeScreenActivity(undefined, 10, null, 100);
    const rawAdvance = observeScreenActivity(first, 20, null, 200);
    expect(rawAdvance.lastActivityAt).toBe(200);
  });
});
