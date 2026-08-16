import type { AttentionCard, AttentionKind, PrimaryAction } from "../../lib/attentionBridge";

const KIND_PRIORITY: Record<AttentionKind, number> = {
  agentAsked: 0,
  workStopped: 1,
  outOfScopeWrite: 2,
  conflictDetected: 3,
  completionWithoutTests: 4,
  budgetReached: 5,
  workOrderStalled: 6,
  nextItemReady: 7,
  reportsComplete: 8,
  goalReached: 9,
};

export function sortAttentionCards(cards: readonly AttentionCard[]): AttentionCard[] {
  return [...cards].sort((left, right) => (
    KIND_PRIORITY[left.kind] - KIND_PRIORITY[right.kind]
    || left.firstSeenAt - right.firstSeenAt
    || left.id.localeCompare(right.id)
  ));
}

export function primaryActionLabel(action: PrimaryAction, label: (kind: PrimaryAction["type"]) => string): string {
  return label(action.type);
}

export function primaryActionIsAcknowledgement(action: PrimaryAction): boolean {
  return action.type === "acknowledgeGoalReached";
}
