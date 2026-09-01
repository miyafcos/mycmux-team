import type { AttentionCard, PrimaryAction, Severity, Waiting } from "../../lib/attentionBridge";

const WAITING_PRIORITY: Record<Waiting, number> = { human: 0, work: 1, none: 2 };
const SEVERITY_PRIORITY: Record<Severity, number> = { blocking: 0, warning: 1, advisory: 2 };

export function sortAttentionCards(cards: readonly AttentionCard[]): AttentionCard[] {
  return [...cards].sort((left, right) => (
    WAITING_PRIORITY[left.waiting] - WAITING_PRIORITY[right.waiting]
    || SEVERITY_PRIORITY[left.severity] - SEVERITY_PRIORITY[right.severity]
    || left.firstSeenAt - right.firstSeenAt
    || (left.sourceRank ?? Number.MAX_SAFE_INTEGER) - (right.sourceRank ?? Number.MAX_SAFE_INTEGER)
    || left.id.localeCompare(right.id)
  ));
}

export function primaryActionLabel(action: PrimaryAction, label: (kind: PrimaryAction["type"]) => string): string {
  return label(action.type);
}

export function primaryActionIsAcknowledgement(action: PrimaryAction): boolean {
  return action.type === "acknowledgeGoalReached";
}
