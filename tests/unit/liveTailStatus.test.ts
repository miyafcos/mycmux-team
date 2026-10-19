import { afterEach, beforeEach, expect, it } from "vitest";
import { trustedLiveTailAttention } from "../../src/lib/liveTail/status";
import { __resetPtyReadGenerationsForTests, invalidatePtyReads, observePtyEpoch, replacePtyReadOwners } from "../../src/lib/ptyReadGeneration";
import { useSessionAttentionStore } from "../../src/stores/sessionAttentionStore";

const owner = Symbol("trusted-attention-test");
beforeEach(() => {
  __resetPtyReadGenerationsForTests(); useSessionAttentionStore.getState().resetForTests();
  replacePtyReadOwners(owner, new Set(["session"]));
  useSessionAttentionStore.setState({ attentionBySession: { session: {
    sessionId: "session", sessionEpoch: 17, sessionRevision: 1, attentionId: "attention", kind: "input",
    detail: null, uiState: "waiting", stateSince: 1_800_000_000_000, occurrenceOrder: 1,
  } } });
});
afterEach(() => { useSessionAttentionStore.getState().resetForTests(); __resetPtyReadGenerationsForTests(); });
it("returns only kind and stateSince from matching accepted attention", () => {
  observePtyEpoch("session", 17);
  expect(trustedLiveTailAttention("session")).toEqual({ kind: "input", stateSince: 1_800_000_000_000 });
});
it("does not trust attention before a conversation epoch is known", () => {
  __resetPtyReadGenerationsForTests(); replacePtyReadOwners(owner, new Set(["session"]));
  expect(trustedLiveTailAttention("session")).toBeUndefined();
});
it("does not trust attention from a different conversation epoch", () => {
  observePtyEpoch("session", 18);
  expect(trustedLiveTailAttention("session")).toBeUndefined();
});
it("does not trust attention when the read generation is unavailable", () => {
  observePtyEpoch("session", 17); invalidatePtyReads("session");
  expect(trustedLiveTailAttention("session")).toBeUndefined();
});
it("returns undefined when accepted attention is absent", () => {
  observePtyEpoch("session", 17); useSessionAttentionStore.setState({ attentionBySession: {} });
  expect(trustedLiveTailAttention("session")).toBeUndefined();
});
