// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
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
import type { AttentionCard, PrimaryAction } from "../../src/lib/attentionBridge";
import { __resetAttentionStoreForTests } from "../../src/stores/attentionStore";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function actionCard(id: string, primaryAction: PrimaryAction): AttentionCard {
  return {
    id,
    fingerprint: id,
    kind: "agentAsked",
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
