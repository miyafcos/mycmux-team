import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Separate read-only archive transport; operational events are never merged. */
export type ArchiveAgentKind = "claude" | "claude-codex" | "codex";
export interface TranscriptDescriptor {
  ptySessionId: string;
  tabId: string;
  expectedAgentKind: ArchiveAgentKind;
  expectedAgentSessionId: string;
}
export interface ArchiveItem {
  occurrenceId: string;
  sourceStart: string;
  sourceEnd: string;
  slot: number;
  kind: "user" | "assistant" | "toolCall" | "toolResult" | "question" | "boundary" | "attachment" | "diagnostic" | "source";
  timestamp: number | null;
  text: string;
  bodyRef: string | null;
  callId: string | null;
  tool: string | null;
  target: string | null;
  aliases: string[];
}
export interface TranscriptPage {
  readerId: string;
  sourceGeneration: string;
  snapshotEnd: string;
  items: ArchiveItem[];
  olderCursor: string | null;
  newerCursor: string | null;
  latestCursor: string | null;
  scanContinuation: string | null;
  reachedStart: boolean;
  reachedFence: boolean;
  diagnostics: { reason: string; sourceStart: string; sourceEnd: string }[];
}
export interface TranscriptBodyPage { text: string; cursor: string | null; sourceText: boolean; validationPending?: boolean }
export const openTranscriptHistory = (request: TranscriptDescriptor): Promise<TranscriptPage> => invoke("open_transcript_history", { request });
export const readTranscriptHistoryPage = (readerId: string, cursor: string, limit = 100): Promise<TranscriptPage> => invoke("read_transcript_history_page", { request: { readerId, cursor, limit } });
export const refreshTranscriptHistoryTail = (readerId: string, afterCursor: string): Promise<TranscriptPage> => invoke("refresh_transcript_history_tail", { readerId, afterCursor });
export const readTranscriptHistoryBody = (readerId: string, bodyRef: string, cursor: string | null = null): Promise<TranscriptBodyPage> => invoke("read_transcript_history_body", { readerId, bodyRef, cursor });
export const closeTranscriptHistory = (readerId: string): Promise<void> => invoke("close_transcript_history", { readerId });
export const heartbeatTranscriptHistory = (readerId: string): Promise<{hasNewBytes:boolean}> => invoke("heartbeat_transcript_history", { readerId });

/** Success evidence is independent of semantic revisions and contains no text. */
export interface LiveReadObservation {
  ptySessionId:string; agentKind:string; agentSessionId:string; ptyInstanceId:string;
  ptyGeneration:number; serviceEpoch:string; lastSuccessfulReadAt:number;
}
export const getLiveReadObservations=(ptySessionIds:readonly string[]):Promise<LiveReadObservation[]> => invoke("get_live_read_observations",{ptySessionIds:ptySessionIds.slice(0,60)});

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

export interface AgentTelemetryModel {
  name: string;
  effort?: string;
}

export interface AgentTelemetryContext {
  pct?: number;
  tokens?: number;
}

export interface AgentTelemetryCost {
  usd: number;
  source: "computed";
  partial?: boolean;
}

export interface AgentTelemetryTurns {
  count: number;
  compacts: number;
}

/** Mirrors `AgentTelemetry` in src-tauri/src/livebrief/telemetry.rs. */
export interface AgentTelemetry {
  model?: AgentTelemetryModel;
  context?: AgentTelemetryContext;
  cost?: AgentTelemetryCost;
  turns?: AgentTelemetryTurns;
}

export interface LiveSessionBrief extends LiveBinding {
  task: string | null;
  /** 直近の「私の指示」原文。answer / ack では上書きされない (reducer.rs と同じ約束)。 */
  latestInstruction: string | null;
  taskSourceEventIds: string[];
  /** 命名専用の直近4件。一般の task / latestInstruction の回答分類は変えない。 */
  namingSourceEventIds?: string[];
  namingPlan?: NamingPlan | null;
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
  /** Transcript turn boundaries and work that can resume without human input. */
  autonomy?: { turnState: "unknown" | "idle" | "active" | "complete"; openToolCount: number; armedBackgroundCount: number;
    backgroundState?: "known" | "unknown"; pendingNotificationCount?: number; turnStartedAt?: number | null } | null;
  telemetryHealth: string;
  lastEventAt: number | null;
  lastSuccessfulReadAt: number | null;
  updatedAt: number;
  serviceEpoch: string;
  briefRevision: number;
  telemetry?: AgentTelemetry | null;
}

export type UserMessageKind = "taskStart" | "taskChange" | "correction" | "answer" | "ack";

/** Bounded, runtime-only proof from the native naming selector. */
export interface NamingInputMark {
  eventId: string; order: number; sourceByteStart: number; sourceByteEnd: number;
  kind: UserMessageKind; choice: boolean; complete: boolean;
}
export interface NamingAllocation {
  eventId: string; order: number; sourceRevision: number; sourceByteStart: number; sourceByteEnd: number;
  role: "user" | "agent" | "read" | "write"; chars: number; complete: boolean; hash: string;
}
export interface NamingPlan {
  latestInput: NamingInputMark | null; latestAgent: NamingAllocation | null; entries: NamingAllocation[];
  coverage: { readStart: number; readEnd: number; sourceUnknown: boolean; countLoss: number | null; characterLoss: number | null };
}

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

/** Native receipt; the same frozen identity is used for text, Enter and proof. */
export interface MessageSendGuard {
  sessionId: string;
  sessionEpoch: number;
  sessionRevision: number;
  strictRevision: boolean;
  attentionId: string | null;
  inputRevision: number;
  agentKind: string | null;
  agentSessionId: string | null;
  agentPid: number | null;
  agentStartedAt: number | null;
  agentMessage: boolean;
  source: unknown | null;
}

export const preparePaneMessage = (sessionId: string, agentMessage: boolean, strictRevision = false): Promise<{ guard: MessageSendGuard | null; reason: string | null }> =>
  invoke("prepare_pane_message", { sessionId, agentMessage, strictRevision });
export const writePaneMessage = (guard: MessageSendGuard, data: string, submit: boolean): Promise<{ sent: boolean; reason: string | null }> =>
  invoke("write_pane_message", { guard, data, submit });
export const verifyPaneMessage = (guard: MessageSendGuard, text: string): Promise<{ confirmed: boolean; matchedEventId: string | null }> =>
  invoke("verify_pane_message", { guard, text });

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
