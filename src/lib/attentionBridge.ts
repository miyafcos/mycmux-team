import { invoke } from "@tauri-apps/api/core";

export type AttentionKind = "agentAsked" | "workStopped" | "reportsComplete" | "completionWithoutTests"
  | "budgetReached" | "outOfScopeWrite" | "conflictDetected" | "goalReached" | "nextItemReady" | "workOrderStalled"
  | "sessionBoardIncident";
export type Waiting = "human" | "work" | "none";
export type Severity = "blocking" | "warning" | "advisory";
export type AttentionActor = "human" | "lane" | "system";
export type AttentionFreshness = "fresh" | "stale";
export type CardState = "open" | "resolved" | "superseded" | "bundled";

export type SessionRef = { type: "pty"; pty_session_id: string } | { type: "logical"; logical_session_id: string };
export type PrimaryAction =
  | { type: "openSession"; session: SessionRef }
  | { type: "answerQuestion"; session: SessionRef }
  | { type: "retryWorkItem"; workorder_id: string; work_item_id: string }
  | { type: "reviewConflict"; workorder_id: string }
  | { type: "raiseBudget"; workorder_id: string }
  | { type: "acknowledgeGoalReached"; workorder_id: string };
export type ReplyRoute = { type: "session"; session: SessionRef } | { type: "workOrder"; workorder_id: string } | { type: "none" };
export type ResolutionPredicate = { type: "observationMissing"; observation_key: string }
  | { type: "workOrderInactive"; workorder_id: string } | { type: "userAcknowledged" };

export interface EvidenceRef { source: string; kind: string; refId: string; detail: string }
export interface AttentionCard {
  id: string;
  fingerprint: string;
  kind: AttentionKind;
  waiting: Waiting;
  severity: Severity;
  actor: AttentionActor | null;
  freshness: AttentionFreshness | null;
  sourceRank?: number | null;
  workorderId: string | null;
  session: SessionRef | null;
  whyNow: string;
  impact: string;
  evidence: EvidenceRef[];
  primaryAction: PrimaryAction;
  replyRoute: ReplyRoute;
  resolutionPredicate: ResolutionPredicate;
  state: CardState;
  firstSeenAt: number;
  lastSeenAt: number;
  revision: number;
  resolvedAt: number | null;
}

export interface AttentionCardsChanged { cards: AttentionCard[] }

export function attentionListCards(): Promise<AttentionCard[]> {
  return invoke<AttentionCard[]>("attention_list_cards");
}

export function attentionResolveCard(id: string): Promise<void> {
  return invoke<void>("attention_resolve_card", { id });
}

export function attentionSetTracked(ptySessionId: string, tracked: boolean): Promise<void> {
  return invoke<void>("attention_set_tracked", { ptySessionId, tracked });
}

export function attentionListTracked(): Promise<string[]> {
  return invoke<string[]>("attention_list_tracked");
}
