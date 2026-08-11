import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type PendingInputKind = "yesNo" | "choice" | "permission" | "freeText" | "blocker";

export interface PendingOption { id: string; label: string }

export interface LiveBinding {
  ptySessionId: string;
  agentSessionId: string;
  agentKind: string;
  ptyInstanceId: string;
  ptyGeneration: number;
  sourceRevision: number;
  ptyInputRevision: number;
}

export interface LiveSessionBrief extends LiveBinding {
  task: string | null;
  taskSourceEventIds: string[];
  activityKind: string | null;
  activityText: string | null;
  activitySourceEventId: string | null;
  checkpoint: string | null;
  checkpointEvidenceEventIds: string[];
  pendingInputKind: PendingInputKind | null;
  pendingPrompt: string | null;
  pendingOptions: PendingOption[];
  promptEventId: string | null;
  promptHash: string | null;
  eventSeq: number;
  operationalState: string;
  telemetryHealth: string;
  lastEventAt: number | null;
  lastSuccessfulReadAt: number | null;
  updatedAt: number;
  serviceEpoch: string;
  briefRevision: number;
}

export interface InterventionExpectation {
  interventionId: string;
  ptySessionId: string;
  agentSessionId: string;
  ptyInstanceId: string;
  ptyGeneration: number;
  sourceRevision: number;
  ptyInputRevision: number;
  promptEventId: string;
  promptHash: string;
}

export type InterventionAction = { type: "replyText"; text: string } | { type: "choose"; optionId: string };
export type InterventionResult =
  | { type: "conflict"; reason: string; latestBrief: LiveSessionBrief | null }
  | { type: "busy" }
  | { type: "rejectedBeforeWrite"; reason: string }
  | { type: "writtenAwaitingEvidence" }
  | { type: "confirmed"; matchedEventId: string }
  | { type: "writtenUnconfirmed" }
  | { type: "indeterminatePartial" };

export function getLiveBriefs(): Promise<LiveSessionBrief[]> {
  return invoke<LiveSessionBrief[]>("get_live_briefs");
}

export function sendIntervention(expectation: InterventionExpectation, action: InterventionAction): Promise<InterventionResult> {
  return invoke<InterventionResult>("send_intervention", { expectation, action });
}

export async function onLiveBriefUpdate(handler: (brief: LiveSessionBrief) => void): Promise<UnlistenFn> {
  return listen<{ brief: LiveSessionBrief }>("livebrief://update", (event) => handler(event.payload.brief));
}

export function targetKey(brief: LiveBinding): string {
  return `${brief.ptySessionId}:${brief.ptyInstanceId}:${brief.ptyGeneration}:${brief.agentSessionId}`;
}

export function freezeExpectation(brief: LiveSessionBrief): InterventionExpectation | null {
  if (!brief.promptEventId || !brief.promptHash) return null;
  return {
    interventionId: crypto.randomUUID(),
    ptySessionId: brief.ptySessionId,
    agentSessionId: brief.agentSessionId,
    ptyInstanceId: brief.ptyInstanceId,
    ptyGeneration: brief.ptyGeneration,
    sourceRevision: brief.sourceRevision,
    ptyInputRevision: brief.ptyInputRevision,
    promptEventId: brief.promptEventId,
    promptHash: brief.promptHash,
  };
}
