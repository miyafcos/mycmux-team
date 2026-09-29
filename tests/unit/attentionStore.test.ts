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
  const axes = kind === "agentAsked" ? { waiting: "human", severity: "blocking" } as const
    : kind === "sessionBoardIncident" ? { waiting: "work", severity: "blocking" } as const
      : kind === "goalReached" ? { waiting: "none", severity: "advisory" } as const
        : { waiting: "work", severity: "blocking" } as const;
  return {
    id, fingerprint: id, kind, ...axes, actor: null, freshness: null, workorderId: null,
    session: { type: "pty", pty_session_id: "pty-a" }, whyNow: "now", impact: "impact",
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
    card("later", "goalReached"),
    { ...card("rank-two", "sessionBoardIncident"), sourceRank: 2 },
    card("first", "agentAsked"),
    { ...card("rank-one", "sessionBoardIncident"), sourceRank: 1 },
    card("middle", "workStopped"),
  ]).map((item) => item.id)).toEqual(["first", "rank-one", "rank-two", "middle", "later"]);
});

it("T3 orders by firstSeenAt before sourceRank without consulting kind", () => {
  const agentAsked = {
    ...card("agent-asked", "agentAsked"),
    waiting: "human" as const,
    severity: "blocking" as const,
    firstSeenAt: 1,
    sourceRank: null,
  };
  const rankedExternal = {
    ...card("ranked-external", "sessionBoardIncident"),
    waiting: "human" as const,
    severity: "blocking" as const,
    firstSeenAt: 2,
    sourceRank: 1,
  };
  const kindMustRemainDisplayOnly = new Proxy(agentAsked, {
    get(target, property, receiver) {
      if (property === "kind") throw new Error("kind must not participate in attention ordering");
      return Reflect.get(target, property, receiver);
    },
  });

  expect(sortAttentionCards([rankedExternal, kindMustRemainDisplayOnly]).map((item) => item.id))
    .toEqual(["agent-asked", "ranked-external"]);
});
