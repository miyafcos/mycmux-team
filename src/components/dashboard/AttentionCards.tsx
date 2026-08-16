import { useEffect, useMemo } from "react";

import type { AttentionCard } from "../../lib/attentionBridge";
import { connectAttentionStore, useAttentionStore } from "../../stores/attentionStore";
import { dashboardStrings } from "./dashboardStrings";
import { primaryActionIsAcknowledgement, primaryActionLabel, sortAttentionCards } from "./attentionModel";
import "./AttentionCards.css";

export function AttentionCards() {
  const cardsById = useAttentionStore((state) => state.cardsById);
  const cardIds = useAttentionStore((state) => state.cardIds);
  const resolveCard = useAttentionStore((state) => state.resolveCard);
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
    {cards.map((card) => <AttentionCardItem key={card.id} card={card} onResolve={resolveCard} />)}
  </section>;
}

function AttentionCardItem({ card, onResolve }: { card: AttentionCard; onResolve: (id: string) => Promise<void> }) {
  const acknowledgement = primaryActionIsAcknowledgement(card.primaryAction);
  const actionLabel = primaryActionLabel(card.primaryAction, dashboardStrings.attentionActionLabel);
  return <article className="cmux-attention-card" data-attention-card={card.id}>
    <div className="cmux-attention-card-head">
      <strong>{dashboardStrings.attentionKindLabel(card.kind)}</strong>
      <time>{clockLabel(card.lastSeenAt)}</time>
    </div>
    <dl>
      <dt>{dashboardStrings.attentionWhyNow}</dt><dd>{card.whyNow}</dd>
      <dt>{dashboardStrings.attentionImpact}</dt><dd>{card.impact}</dd>
      <dt>{dashboardStrings.attentionEvidence}</dt><dd>{card.evidence.map((item) => <div className="cmux-attention-card-evidence" key={`${item.source}:${item.refId}`}><span>{item.detail}</span></div>)}</dd>
      <dt>{dashboardStrings.attentionReplyRoute}</dt><dd>{routeLabel(card)}</dd>
      <dt>{dashboardStrings.attentionResolution}</dt><dd>{resolutionLabel(card)}</dd>
    </dl>
    <div className="cmux-attention-card-action">
      <button type="button" disabled={!acknowledgement} title={acknowledgement ? undefined : dashboardStrings.attentionActionUnavailable} onClick={() => {
        if (acknowledgement) void onResolve(card.id);
      }}>{actionLabel}</button>
      {!acknowledgement ? <span className="cmux-attention-card-unavailable">{dashboardStrings.attentionActionUnavailable}</span> : null}
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
