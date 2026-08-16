import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridgeMocks = vi.hoisted(() => ({
  attentionListCards: vi.fn(),
  attentionResolveCard: vi.fn(),
  attentionSetTracked: vi.fn(),
}));
const eventMocks = vi.hoisted(() => ({ listen: vi.fn() }));

vi.mock("../../src/lib/attentionBridge", async () => ({
  ...(await vi.importActual<object>("../../src/lib/attentionBridge")),
  ...bridgeMocks,
}));
vi.mock("@tauri-apps/api/event", () => eventMocks);

import type { AttentionCard } from "../../src/lib/attentionBridge";
import { sortAttentionCards } from "../../src/components/dashboard/attentionModel";
import { __resetAttentionStoreForTests, connectAttentionStore, useAttentionStore } from "../../src/stores/attentionStore";

function card(id: string, kind: AttentionCard["kind"] = "agentAsked", revision = 1): AttentionCard {
  return {
    id, fingerprint: id, kind, workorderId: null, session: { type: "pty", pty_session_id: "pty-a" }, whyNow: "now", impact: "impact",
    evidence: [{ source: "test", kind: "event", refId: id, detail: "evidence" }],
    primaryAction: { type: "openSession", session: { type: "pty", pty_session_id: "pty-a" } },
    replyRoute: { type: "session", session: { type: "pty", pty_session_id: "pty-a" } },
    resolutionPredicate: { type: "observationMissing", observation_key: id }, state: "open", firstSeenAt: 1, lastSeenAt: revision, revision, resolvedAt: null,
  };
}

beforeEach(() => {
  __resetAttentionStoreForTests();
  vi.clearAllMocks();
  bridgeMocks.attentionListCards.mockResolvedValue([]);
});

afterEach(() => {
  __resetAttentionStoreForTests();
  vi.unstubAllGlobals();
});

describe("attention store event connection", () => {
  it("subscribes once and can release the shared listener", async () => {
    let handler: ((event: { payload: { cards: AttentionCard[] } }) => void) | undefined;
    const unlisten = vi.fn();
    eventMocks.listen.mockImplementation(async (_name, nextHandler) => { handler = nextHandler; return unlisten; });
    const first = await connectAttentionStore();
    const second = await connectAttentionStore();
    expect(eventMocks.listen).toHaveBeenCalledOnce();
    handler?.({ payload: { cards: [card("one")] } });
    expect(useAttentionStore.getState().cardIds).toEqual(["one"]);
    first();
    expect(unlisten).not.toHaveBeenCalled();
    second();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("does not let an earlier hydrate overwrite an event snapshot", async () => {
    let handler: ((event: { payload: { cards: AttentionCard[] } }) => void) | undefined;
    let completeHydrate: ((cards: AttentionCard[]) => void) | undefined;
    eventMocks.listen.mockImplementation(async (_name, nextHandler) => { handler = nextHandler; return vi.fn(); });
    bridgeMocks.attentionListCards.mockImplementation(() => new Promise((resolve) => { completeHydrate = resolve; }));
    const release = await connectAttentionStore();
    handler?.({ payload: { cards: [card("new", "workStopped", 2)] } });
    completeHydrate?.([card("old")]);
    await Promise.resolve();
    expect(useAttentionStore.getState().cardIds).toEqual(["new"]);
    release();
  });

  it("invokes tracking exactly once", async () => {
    await useAttentionStore.getState().setTracked("pty-a", true);
    expect(bridgeMocks.attentionSetTracked).toHaveBeenCalledOnce();
    expect(bridgeMocks.attentionSetTracked).toHaveBeenCalledWith("pty-a", true);
  });
});

it("uses a deterministic card order", () => {
  expect(sortAttentionCards([
    card("later", "goalReached"), card("first", "agentAsked"), card("middle", "workStopped"),
  ]).map((item) => item.id)).toEqual(["first", "middle", "later"]);
});
