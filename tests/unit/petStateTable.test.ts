import { beforeEach, describe, expect, it } from "vitest";
import { classifyPetTier, type PetTier, type PetTierInput } from "../../src/lib/petState";
import { isAttentionUnseen, summarizeUnseenAttention, useSessionAttentionStore } from "../../src/stores/sessionAttentionStore";
import { aggregatePetTier } from "../../src/lib/petState";
import { PET_TEST_NOW, petFeedSession, type PetFeedOptions } from "../fixtures/petFeed";

beforeEach(() => useSessionAttentionStore.getState().resetForTests());

interface TableRow {
  name: string;
  feed?: PetFeedOptions;
  screen?: Partial<PetTierInput>;
  seen?: boolean;
  tier: PetTier;
}

const rows: TableRow[] = [
  ...(["web", "browser", "online"] as const).map((tabType) => ({
    name: `R0: ${tabType} ignores the feed`, feed: { kind: "input" as const },
    screen: { tabType, observed: true, agentStatus: "waiting" as const }, tier: "resting" as const,
  })),
  { name: "R1: observed waiting wins over backend error", feed: { kind: "error" }, screen: { observed: true, agentStatus: "waiting" }, tier: "calling" },
  { name: "R2: background input calls", feed: { kind: "input" }, tier: "calling" },
  { name: "R2: background approval calls even when seen", feed: { kind: "approval" }, seen: true, tier: "calling" },
  { name: "R3: background rate limit stays stuck when seen", feed: { kind: "rate_limited" }, seen: true, tier: "stuck" },
  { name: "R3: background error stays stuck when seen", feed: { kind: "error" }, seen: true, tier: "stuck" },
  { name: "R4: queued input outranks unread done", feed: { kind: "done" }, screen: { stallReason: "queued_input" }, tier: "calling" },
  { name: "R5: unread background done outranks prompt redraws", feed: { kind: "done", activity: "streaming", lastOutputAt: PET_TEST_NOW - 1_000 }, tier: "ready" },
  { name: "R5: seen background done rests despite prompt redraws", feed: { kind: "done", activity: "streaming", lastOutputAt: PET_TEST_NOW - 1_000 }, seen: true, tier: "resting" },
  ...(["no_output", "silent", "pty_dead"] as const).map((stallReason) => ({
    name: `R6: background ${stallReason} rests`, feed: { activity: "running_silent" as const }, screen: { stallReason }, tier: "resting" as const,
  })),
  { name: "R7: observed spinner outranks done per the audit decision", feed: { kind: "done" }, screen: { observed: true, workingPatternVisible: true }, tier: "working" },
  { name: "R8: observed output is active", screen: { observed: true, outputActive: true }, tier: "working" },
  { name: "R8: background backend output is active through 15 seconds", feed: { lastOutputAt: PET_TEST_NOW - 15_000 }, tier: "working" },
  { name: "R9: background silent work lasts beyond 15 seconds", feed: { activity: "running_silent", uiState: "working", lastOutputAt: PET_TEST_NOW - 120_000 }, tier: "working" },
  { name: "R10: background idle ignores frozen waiting and spinner", screen: { agentStatus: "waiting", workingPatternVisible: true }, tier: "resting" },
  { name: "R10: unknown activity and expired backend output rest", feed: { activity: "unknown", uiState: "unknown", lastOutputAt: PET_TEST_NOW - 15_001 }, tier: "resting" },
  { name: "audit resume: recent clear starts background work before output", feed: { stateSince: PET_TEST_NOW - 1_000, activity: "unknown" }, screen: { stallReason: "silent" }, tier: "working" },
];

describe("pet R0-R10 table through the session feed", () => {
  it.each(rows)("$name", ({ feed, screen, seen, tier }) => {
    const session = petFeedSession("session", 1, feed);
    const store = useSessionAttentionStore.getState();
    store.applySnapshot({ server_epoch: "pet-test-server", seq: 1, sessions: [session] });
    if (seen) store.markSeen("tab", session.status.attention.attention_id!);
    const state = useSessionAttentionStore.getState();
    const attention = state.attentionBySession.session;
    const signals = state.statusSignalsBySession.session;
    expect(classifyPetTier({
      observed: false,
      now: PET_TEST_NOW,
      attentionKind: attention.kind,
      attentionStateSince: attention.stateSince,
      attentionUnseen: isAttentionUnseen("tab", attention, state.seenAttentionByTab),
      activity: signals.activity,
      backendLastOutputAt: signals.lastOutputAt ?? undefined,
      ...screen,
    })).toBe(tier);
  });
});

describe("evidence limits for the pet design review", () => {
  it("uiState working alone cannot prove work without activity or output", () => {
    const session = petFeedSession("session", 1, { uiState: "working", activity: "unknown" });
    useSessionAttentionStore.getState().applySnapshot({ server_epoch: "review", seq: 1, sessions: [session] });
    expect(useSessionAttentionStore.getState().attentionBySession.session.uiState).toBe("working");
    expect(classifyPetTier({ observed: false, now: PET_TEST_NOW, attentionUnseen: false, activity: "unknown" })).toBe("resting");
  });

  it("without done evidence an idle prompt redraw can still look like work", () => {
    expect(classifyPetTier({
      observed: false, now: PET_TEST_NOW, attentionUnseen: false, attentionKind: "none",
      activity: "idle", backendLastOutputAt: PET_TEST_NOW - 1_000,
    })).toBe("working");
  });

  it("an unresolved background input does not expire by wall clock", () => {
    expect(classifyPetTier({
      observed: false, now: PET_TEST_NOW, attentionUnseen: false, attentionKind: "input",
      attentionStateSince: PET_TEST_NOW - 86_400_000, activity: "idle",
    })).toBe("calling");
  });

  it("one unresolved question outranks thirty working sessions", () => {
    expect(aggregatePetTier(["calling", ...Array<PetTier>(30).fill("working")])).toBe("calling");
  });

  it("unread done is shown by the pet but is absent from the blocking ring", () => {
    useSessionAttentionStore.getState().applySnapshot({
      server_epoch: "review", seq: 1, sessions: [petFeedSession("session", 1, { kind: "done" })],
    });
    const state = useSessionAttentionStore.getState();
    const attention = state.attentionBySession.session;
    expect(isAttentionUnseen("tab", attention, state.seenAttentionByTab)).toBe(true);
    expect(summarizeUnseenAttention([{ id: "tab", sessionId: "session" }], state.attentionBySession, state.seenAttentionByTab)).toEqual({ count: 0, category: null });
    expect(classifyPetTier({ observed: false, now: PET_TEST_NOW, attentionKind: attention.kind, attentionUnseen: true })).toBe("ready");
  });
});
