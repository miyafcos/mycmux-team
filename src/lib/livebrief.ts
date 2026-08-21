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
  /** 直近の「私の指示」原文。answer / ack では上書きされない (reducer.rs と同じ約束)。 */
  latestInstruction: string | null;
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

export type UserMessageKind = "taskStart" | "taskChange" | "correction" | "answer" | "ack";

/**
 * Mirrors `SemanticEventKind` in src-tauri/src/livebrief/adapter.rs. That enum
 * carries `#[serde(tag = "type", rename_all = "camelCase")]`, which renames the
 * variants only — the fields inside each variant keep their Rust snake_case
 * names (`call_id`, `prompt_event_id`, …). The exact wire shape is pinned by
 * `semantic_event_json_matches_the_typescript_contract` in livebrief/mod.rs.
 */
export type SemanticEvent =
  | { type: "userMessage"; kind: UserMessageKind; text: string; digest: string }
  | { type: "agentMessage"; text: string }
  | { type: "toolStart"; call_id: string; tool: string; target: string | null }
  | { type: "toolEnd"; call_id: string; tool: string; target: string | null; ok: boolean; summary: string | null }
  | { type: "question"; prompt_event_id: string; provider_call_id: string; prompt: string; kind: PendingInputKind; options: PendingOption[] }
  | { type: "questionResolved"; prompt_event_id: string; provider_call_id: string }
  | { type: "testResult"; pass: number; fail: number }
  | { type: "fileChange"; path: string; change: string }
  | { type: "error"; fingerprint: string; text: string };

export interface SemanticEventEnvelope {
  eventId: string;
  sourceRevision: number;
  occurredAt: number;
  sourceByteStart: number;
  sourceByteEnd: number;
  kind: SemanticEvent;
}

export interface LiveSessionEvents {
  ptySessionId: string;
  briefRevision: number;
  telemetryHealth: string;
  events: SemanticEventEnvelope[];
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

export function subscribeLiveBriefs(): Promise<void> {
  return invoke<void>("subscribe_live_briefs");
}

export function unsubscribeLiveBriefs(): Promise<void> {
  return invoke<void>("unsubscribe_live_briefs");
}

/** Matches `DEFAULT_EVENT_LIMIT` in src-tauri/src/livebrief/mod.rs. */
export const LIVE_EVENT_LIMIT = 50;

/**
 * 一覧行 (表示中の全セッション) に要る本数。連鎖3件+指示が拾えれば足りるので
 * 詳細より小さく取り、可視セッション数ぶんの往復を軽くする。
 */
export const LIVE_EVENT_LIST_LIMIT = 12;

/** 詳細ペイン ([経緯] タブ) が出す行数。1 セッションぶんだけ深く取る。 */
export const LIVE_EVENT_DETAIL_LIMIT = 200;

export function getLiveEvents(ptySessionIds: string[], limit: number = LIVE_EVENT_LIMIT): Promise<LiveSessionEvents[]> {
  return invoke<LiveSessionEvents[]>("get_live_events", { ptySessionIds, limit });
}

/** One prompt the operator typed, straight out of the transcript. */
export interface TranscriptPrompt {
  text: string;
  occurredAt: number;
}

/** Matches `MAX_RESTORED_PROMPTS` in src-tauri/src/livebrief/mod.rs. */
export const TRANSCRIPT_PROMPT_LIMIT = 200;

/**
 * 復元されたペインのターンマークを組み直すためだけの経路。
 * transcript を読むのはこの1本で、パーサは livebrief と同じものを使う。
 */
export function getTranscriptUserPrompts(
  ptySessionId: string,
  limit: number = TRANSCRIPT_PROMPT_LIMIT,
): Promise<TranscriptPrompt[]> {
  return invoke<TranscriptPrompt[]>("get_transcript_user_prompts", { ptySessionId, limit });
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
