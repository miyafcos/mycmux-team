import { shallow } from "zustand/shallow";
import { printableText } from "../../stores/recentInputStore";
import type { SemanticEventEnvelope } from "../../lib/livebrief";

export function sameTranscriptEvents(
  previous: readonly SemanticEventEnvelope[],
  next: readonly SemanticEventEnvelope[],
): boolean {
  return previous === next || (previous.length === next.length && previous.every((event, index) => {
    const other = next[index];
    return event === other || (
      event.eventId === other.eventId
      && event.sourceRevision === other.sourceRevision
      && event.occurredAt === other.occurredAt
      && event.sourceByteStart === other.sourceByteStart
      && event.sourceByteEnd === other.sourceByteEnd
      && (shallow(event.kind, other.kind) || (
        event.kind.type === "question"
        && other.kind.type === "question"
        && JSON.stringify(event.kind) === JSON.stringify(other.kind)
      ))
    );
  }));
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "question" | "error";
  text: string;
  at: number;
}

export interface ToolTranscriptItem {
  id: string;
  tool: string;
  target: string | null;
  ok: boolean | undefined;
  summary: string | null;
}

export type ChatTranscriptRow =
  | { kind: "message"; message: ChatMessage }
  | { kind: "toolGroup"; id: string; tools: ToolTranscriptItem[] };

/**
 * One bubble per run of adjacent agent messages. Any other event in between
 * (tool work above all) ends the run: an answer written after a tool call must
 * appear after that tool group, not be folded into the bubble above it, or the
 * newest text lands mid-transcript while the tail only shows "ツール実行 N件".
 */
export function toChatMessages(events: readonly SemanticEventEnvelope[], agentKind = "none"): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let previousWasAgentMessage = false;
  for (const envelope of events) {
    const event = envelope.kind;
    if (event.type === "agentMessage") {
      const previous = messages[messages.length - 1];
      if (previousWasAgentMessage && previous?.role === "assistant") {
        previous.text = `${previous.text}${agentKind === "grok" ? "" : "\n\n"}${event.text}`;
        previous.at = envelope.occurredAt;
      } else {
        messages.push({ id: envelope.eventId, role: "assistant", text: event.text, at: envelope.occurredAt });
      }
      previousWasAgentMessage = true;
      continue;
    }
    previousWasAgentMessage = false;
    if (event.type === "userMessage") messages.push({ id: envelope.eventId, role: "user", text: event.text, at: envelope.occurredAt });
    else if (event.type === "question") messages.push({ id: envelope.eventId, role: "question", text: event.prompt, at: envelope.occurredAt });
    else if (event.type === "error") messages.push({ id: envelope.eventId, role: "error", text: event.text, at: envelope.occurredAt });
    else if (event.type === "testResult" && event.fail > 0) messages.push({
      id: envelope.eventId,
      role: "error",
      text: `テスト結果: ${event.fail}件失敗、${event.pass}件成功`,
      at: envelope.occurredAt,
    });
  }
  return messages;
}

/**
 * Keeps content-bearing events in source order while folding adjacent tool work.
 * The first tool event id is deliberately retained as the stable disclosure key.
 */
export function toChatTranscriptRows(events: readonly SemanticEventEnvelope[], agentKind = "none"): ChatTranscriptRow[] {
  const messages = toChatMessages(events, agentKind);
  const messageById = new Map(messages.map((message) => [message.id, message] as const));
  const endByCallId = new Map(events.flatMap((event) => (
    event.kind.type === "toolEnd" ? [[event.kind.call_id, event.kind] as const] : []
  )));
  const rows: ChatTranscriptRow[] = [];
  let pendingTools: ToolTranscriptItem[] = [];

  const flushTools = () => {
    if (!pendingTools.length) return;
    rows.push({ kind: "toolGroup", id: pendingTools[0].id, tools: pendingTools });
    pendingTools = [];
  };

  for (const envelope of events) {
    const message = messageById.get(envelope.eventId);
    if (message) {
      flushTools();
      rows.push({ kind: "message", message });
      continue;
    }
    if (envelope.kind.type !== "toolStart") continue;
    const end = endByCallId.get(envelope.kind.call_id);
    pendingTools.push({
      id: envelope.eventId,
      tool: envelope.kind.tool,
      target: envelope.kind.target,
      ok: end?.ok,
      summary: end?.summary ?? null,
    });
  }
  flushTools();
  return rows;
}

/** A merged assistant bubble still represents every adjacent source event. */
export function chatMessageIdForEvent(events: readonly SemanticEventEnvelope[], eventId: string): string {
  let index = events.findIndex((event) => event.eventId === eventId);
  if (index < 0 || events[index].kind.type !== "agentMessage") return eventId;
  while (index > 0 && events[index - 1].kind.type === "agentMessage") index -= 1;
  return events[index].eventId;
}

export function userTurnLabelFrom(text: string): string {
  return printableText(text).replace(/\s+/g, " ").trim();
}

export function userTurnsFromRows(rows: readonly ChatTranscriptRow[]): ChatMessage[] {
  return rows.flatMap((row) => (
    row.kind === "message" && row.message.role === "user" ? [row.message] : []
  ));
}

/** Picks the current turn from tops ordered by the vertical layout. */
export function userTurnIndexFromTops(
  turnCount: number,
  containerTop: number,
  followingBottom: boolean,
  topAt: (index: number) => number,
): number {
  if (!turnCount) return -1;
  if (followingBottom) return turnCount - 1;
  // Search for the first turn below the top. The first turn is the fallback.
  let low = 1;
  let high = turnCount;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (topAt(middle) <= containerTop) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}
