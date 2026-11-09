import type { LiveSessionBrief, SemanticEventEnvelope, TranscriptDescriptor } from "../../lib/livebrief";
import { descriptorKey, type HistoryState } from "../../stores/transcriptHistoryStore";

export function isAgentConversationKind(kind: string | null | undefined): boolean {
  return kind === "claude" || kind === "codex" || kind === "claude-codex" || kind === "grok";
}

export type ConversationFallback = "empty" | "missing" | "unsupported" | "unreadable" | "partial" | "loading";
export function conversationFallback({ agentKind, brief, events, archiveEnabled, descriptor, history }: {
  agentKind: string;
  brief?: LiveSessionBrief;
  events: readonly SemanticEventEnvelope[];
  archiveEnabled: boolean;
  descriptor: TranscriptDescriptor | null;
  history: HistoryState | null;
}): ConversationFallback | null {
  if (!isAgentConversationKind(agentKind)) return "unsupported";
  if (brief && !["live", "ended"].includes(brief.telemetryHealth)) {
    return brief.telemetryHealth === "unlinked"
      || brief.telemetryHealth === "unavailable" && brief.telemetryDetail === "recordNotFound" ? "empty" : "unreadable";
  }
  if (archiveEnabled) {
    if (!descriptor) return "missing";
    if (!history) return "loading";
    if (descriptorKey(history.descriptor) !== descriptorKey(descriptor)) return "loading";
    if (history.error === "unsupportedAgent") return "unsupported";
    if (history.error === "recordMissing" || history.error === "unlinked") return "missing";
    if (history.error || history.status === "frozen" || history.status === "closed") return "unreadable";
    if (history.status !== "ready") return "loading";
    // Tool calls, results, attachments and boundaries are drawable conversation
    // too: a long tool-only stretch must not send the tab back to the terminal.
    if (history.items.some(item => item.kind !== "diagnostic" && item.kind !== "source")) return null;
    if (history.pages.some(page => page.diagnostics.length > 0)
      || history.items.some(item => item.kind === "diagnostic" || item.kind === "source")) return "partial";
    return "empty";
  }
  const hasConversation = events.some(event => event.kind.type === "userMessage" || event.kind.type === "agentMessage" || event.kind.type === "question");
  if (brief?.namingPlan?.coverage.sourceUnknown && !hasConversation) return "partial";
  if (!brief || !hasConversation) return "empty";
  return null;
}
