import { useEffect, useMemo, useState } from "react";

import type { AttentionCard, SessionRef } from "../../lib/attentionBridge";
import { connectAttentionStore, useAttentionStore } from "../../stores/attentionStore";
import { dashboardStrings } from "./dashboardStrings";
import { primaryActionLabel, sortAttentionCards } from "./attentionModel";
import "./AttentionCards.css";

export interface AttentionCardActions {
  sessionLabel: (card: AttentionCard) => string;
  openCardSession: (card: AttentionCard) => void | Promise<void>;
  openSession: (session: SessionRef) => void | Promise<void>;
  answerQuestion: (session: SessionRef) => void | Promise<void>;
  retryWorkItem: (workOrderId: string, workItemId: string) => Promise<void>;
  openWorkOrder: (workOrderId: string) => void | Promise<void>;
  resolveCard?: (id: string) => Promise<void>;
}

export function AttentionCards(actions: AttentionCardActions) {
  const cardsById = useAttentionStore((state) => state.cardsById);
  const cardIds = useAttentionStore((state) => state.cardIds);
  const storedResolveCard = useAttentionStore((state) => state.resolveCard);
  const resolveCard = actions.resolveCard ?? storedResolveCard;
  useEffect(() => {
    let dispose: (() => void) | undefined;
    let disposed = false;
    void connectAttentionStore().then((nextDispose) => {
      if (disposed) nextDispose();
      else dispose = nextDispose;
    });
    return () => {
      disposed = true;
      dispose?.();
    };
  }, []);
  const cards = useMemo(() => sortAttentionCards(cardIds.flatMap((id) => cardsById[id] ? [cardsById[id]!] : [])), [cardsById, cardIds]);
  if (cards.length === 0) return null;
  return <section aria-label={dashboardStrings.attentionTitle}>
    {cards.map((card) => <AttentionCardItem key={card.id} card={card} actions={actions} onResolve={resolveCard} />)}
  </section>;
}

function AttentionCardItem({
  card,
  actions,
  onResolve,
}: {
  card: AttentionCard;
  actions: AttentionCardActions;
  onResolve: (id: string) => Promise<void>;
}) {
  const [result, setResult] = useState<"success" | "error" | null>(null);
  const [running, setRunning] = useState(false);
  const actionLabel = primaryActionLabel(card.primaryAction, dashboardStrings.attentionActionLabel);
  const contractGoal = card.evidence.find((item) => item.kind === "contractGoal")?.detail;
  const evidence = card.evidence.filter((item) => item.kind !== "contractGoal");
  const run = (operation: () => void | Promise<void>) => {
    if (running) return;
    setRunning(true);
    setResult(null);
    void Promise.resolve(operation())
      .then(() => setResult("success"))
      .catch(() => setResult("error"))
      .finally(() => setRunning(false));
  };
  const runPrimaryAction = () => run(() => {
    switch (card.primaryAction.type) {
      case "openSession":
        return actions.openSession(card.primaryAction.session);
      case "answerQuestion":
        return actions.answerQuestion(card.primaryAction.session);
      case "retryWorkItem":
        return actions.retryWorkItem(card.primaryAction.workorder_id, card.primaryAction.work_item_id);
      case "reviewConflict":
      case "raiseBudget":
        return actions.openWorkOrder(card.primaryAction.workorder_id);
      case "acknowledgeGoalReached":
        return onResolve(card.id);
    }
  });
  return <article className="cmux-attention-card" data-attention-card={card.id}>
    <div className="cmux-attention-card-head">
      <div className="cmux-attention-card-head-main">
        <button type="button" className="cmux-attention-card-session-chip" onClick={() => run(() => actions.openCardSession(card))}>{actions.sessionLabel(card)}</button>
        <strong>{dashboardStrings.attentionKindLabel(card.kind)}</strong>
      </div>
      <time>{clockLabel(card.lastSeenAt)}</time>
    </div>
    {contractGoal ? <div className="cmux-attention-card-subject" data-attention-contract-goal={card.id}>{contractGoal}</div> : null}
    <dl>
      <dt>{dashboardStrings.attentionWhyNow}</dt><dd>{card.whyNow}</dd>
      <dt>{dashboardStrings.attentionImpact}</dt><dd>{card.impact}</dd>
      <dt>{dashboardStrings.attentionEvidence}</dt><dd>{evidence.map((item) => <div className="cmux-attention-card-evidence" key={`${item.source}:${item.refId}`}><span>{item.detail}</span></div>)}</dd>
      <dt>{dashboardStrings.attentionReplyRoute}</dt><dd>{routeLabel(card)}</dd>
      <dt>{dashboardStrings.attentionResolution}</dt><dd>{resolutionLabel(card)}</dd>
    </dl>
    <div className="cmux-attention-card-action">
      <button type="button" aria-busy={running || undefined} onClick={runPrimaryAction}>{actionLabel}</button>
      {result ? <span className={`cmux-attention-card-action-result is-${result}`} role="status">{result === "success" ? dashboardStrings.attentionActionSucceeded : dashboardStrings.attentionActionFailed}</span> : null}
    </div>
  </article>;
}

function routeLabel(card: AttentionCard): string {
  if (card.replyRoute.type === "none") return dashboardStrings.attentionNoReplyRoute;
  return card.replyRoute.type === "session" ? dashboardStrings.attentionReplyToSession : dashboardStrings.attentionReplyToContract;
}

function resolutionLabel(card: AttentionCard): string {
  if (card.resolutionPredicate.type === "userAcknowledged") return dashboardStrings.attentionResolveByAcknowledgement;
  if (card.resolutionPredicate.type === "workOrderInactive") return dashboardStrings.attentionResolveWhenFinished;
  return dashboardStrings.attentionResolveWhenChanged;
}

function clockLabel(value: number): string {
  const date = new Date(value);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
