// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

import { AttentionCards, type AttentionCardActions } from "../../src/components/dashboard/AttentionCards";
import { dashboardStrings } from "../../src/components/dashboard/dashboardStrings";
import type { AttentionCard, PrimaryAction } from "../../src/lib/attentionBridge";
import { __resetAttentionStoreForTests } from "../../src/stores/attentionStore";
import { ingestAskQuestionLines, useAskQuestionStore } from "../../src/stores/askQuestionStore";

const askFixtures = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../fixtures/askQuestionScreens.json"), "utf8"),
) as Record<"single", string[]>;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function actionCard(id: string, primaryAction: PrimaryAction): AttentionCard {
  return {
    id,
    fingerprint: id,
    kind: "workStopped",
    waiting: "work",
    severity: "blocking",
    actor: null,
    freshness: null,
    workorderId: "order-a",
    session: { type: "pty", pty_session_id: "pty-a" },
    whyNow: "now",
    impact: "impact",
    evidence: [
      { source: "workorder", kind: "contractGoal", refId: "goal", detail: "契約ゴール: 確認する" },
      { source: "test", kind: "detail", refId: id, detail: "根拠" },
    ],
    primaryAction,
    replyRoute: { type: "session", session: { type: "pty", pty_session_id: "pty-a" } },
    resolutionPredicate: { type: "observationMissing", observation_key: id },
    state: "open",
    firstSeenAt: 1,
    lastSeenAt: 1,
    revision: 1,
    resolvedAt: null,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  __resetAttentionStoreForTests();
  useAskQuestionStore.getState().resetForTests();
  vi.clearAllMocks();
  eventMocks.listen.mockResolvedValue(vi.fn());
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  __resetAttentionStoreForTests();
  useAskQuestionStore.getState().resetForTests();
});

describe("AttentionCards", () => {
  it("renders a session chip and routes its click to the dashboard callback", async () => {
    const openCardSession = vi.fn();
    const cards = [actionCard("open", { type: "openSession", session: { type: "pty", pty_session_id: "pty-a" } })];
    bridgeMocks.attentionListCards.mockResolvedValue(cards);
    const actions = actionHandlers({ openCardSession });
    await act(async () => {
      root.render(<AttentionCards {...actions.actions} />);
      await Promise.resolve();
    });
    const chip = container.querySelector<HTMLButtonElement>(".cmux-attention-card-session-chip");
    expect(chip?.textContent).toBe("セッションA");
    await act(async () => { chip?.click(); await Promise.resolve(); });
    expect(openCardSession).toHaveBeenCalledOnce();
    expect(container.querySelector("[data-attention-contract-goal='open']")?.textContent).toContain("契約ゴール");
  });

  it("renders a session-board incident through the existing card surface", async () => {
    const card = {
      ...actionCard("session-board", {
        type: "openSession",
        session: { type: "pty", pty_session_id: "pty-a" },
      }),
      kind: "sessionBoardIncident" as const,
      sourceRank: 1,
    };
    bridgeMocks.attentionListCards.mockResolvedValue([card]);
    await act(async () => {
      root.render(<AttentionCards {...actionHandlers().actions} />);
      await Promise.resolve();
    });
    expect(container.textContent).toContain(dashboardStrings.attentionKindLabel("sessionBoardIncident"));
    expect(container.querySelectorAll("[data-attention-card]")).toHaveLength(1);
  });

  it("keeps every attention action enabled and routes all six actions once", async () => {
    const cards = [
      actionCard("open", { type: "openSession", session: { type: "pty", pty_session_id: "pty-a" } }),
      actionCard("answer", { type: "answerQuestion", session: { type: "pty", pty_session_id: "pty-a" } }),
      actionCard("retry", { type: "retryWorkItem", workorder_id: "order-a", work_item_id: "item-a" }),
      actionCard("review", { type: "reviewConflict", workorder_id: "order-a" }),
      actionCard("budget", { type: "raiseBudget", workorder_id: "order-a" }),
      actionCard("ack", { type: "acknowledgeGoalReached", workorder_id: "order-a" }),
    ];
    bridgeMocks.attentionListCards.mockResolvedValue(cards);
    const handlers = actionHandlers();
    await act(async () => {
      root.render(<AttentionCards {...handlers.actions} />);
      await Promise.resolve();
    });
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("[data-attention-card] button"));
    expect(buttons.every((button) => !button.hasAttribute("disabled"))).toBe(true);
    for (const id of ["open", "answer", "retry", "review", "budget", "ack"]) {
      const card = container.querySelector<HTMLElement>(`[data-attention-card='${id}']`)!;
      const button = Array.from(card.querySelectorAll<HTMLButtonElement>("button")).find((entry) => !entry.classList.contains("cmux-attention-card-session-chip"));
      await act(async () => { button?.click(); await Promise.resolve(); });
    }
    expect(handlers.openSession).toHaveBeenCalledOnce();
    expect(handlers.answerQuestion).toHaveBeenCalledOnce();
    expect(handlers.retryWorkItem).toHaveBeenCalledWith("order-a", "item-a");
    expect(handlers.openWorkOrder).toHaveBeenCalledTimes(2);
    expect(handlers.resolveCard).toHaveBeenCalledWith("ack");
  });

  it("renders scanner content inline and suppresses the generic open-and-answer card", async () => {
    const card = {
      ...actionCard("ask", {
        type: "answerQuestion",
        session: { type: "pty", pty_session_id: "pty-a" },
      }),
      kind: "agentAsked" as const,
    };
    bridgeMocks.attentionListCards.mockResolvedValue([card]);
    ingestAskQuestionLines("pty-a", askFixtures.single, 1, 7);
    const handlers = actionHandlers();

    await act(async () => {
      root.render(<AttentionCards {...handlers.actions} />);
      await Promise.resolve();
    });

    expect(container.querySelector("[data-ask-question-session='pty-a']")).not.toBeNull();
    expect(container.querySelector("[data-ask-question-option='1']")).not.toBeNull();
    expect(container.querySelector("[data-attention-card='ask']")).toBeNull();
    expect(handlers.answerQuestion).not.toHaveBeenCalled();
  });

  it("does not create a contentless card from an agentAsked signal alone", async () => {
    bridgeMocks.attentionListCards.mockResolvedValue([{
      ...actionCard("ask-only", {
        type: "answerQuestion",
        session: { type: "pty", pty_session_id: "pty-a" },
      }),
      kind: "agentAsked" as const,
    }]);

    await act(async () => {
      root.render(<AttentionCards {...actionHandlers().actions} />);
      await Promise.resolve();
    });

    expect(container.textContent).toBe("");
  });
});

function actionHandlers(overrides: Partial<AttentionCardActions> = {}) {
  const openCardSession = vi.fn();
  const openSession = vi.fn();
  const answerQuestion = vi.fn();
  const retryWorkItem = vi.fn().mockResolvedValue(undefined);
  const openWorkOrder = vi.fn();
  const resolveCard = vi.fn().mockResolvedValue(undefined);
  return {
    openCardSession,
    openSession,
    answerQuestion,
    retryWorkItem,
    openWorkOrder,
    resolveCard,
    actions: {
      sessionLabel: () => "セッションA",
      openCardSession,
      openSession,
      answerQuestion,
      retryWorkItem,
      openWorkOrder,
      resolveCard,
      ...overrides,
    },
  };
}
