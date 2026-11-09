import { describe, expect, it } from "vitest";
import { conversationFallback, isAgentConversationKind } from "../../src/components/terminal/agentTabConversationModel";
import type { LiveSessionBrief, SemanticEventEnvelope, TranscriptDescriptor } from "../../src/lib/livebrief";
import type { HistoryState } from "../../src/stores/transcriptHistoryStore";
const descriptor: TranscriptDescriptor = { ptySessionId: "s", tabId: "t", expectedAgentKind: "claude", expectedAgentSessionId: "agent" };
const events = [{ kind: { type: "userMessage", text: "start" } }] as SemanticEventEnvelope[];
const brief = { telemetryHealth: "live" } as LiveSessionBrief;
const history = { descriptor, status: "ready", error: null, items: [{ kind: "user" }], pages: [{ diagnostics: [] }] } as unknown as HistoryState;
const input = { agentKind: "claude", brief, events, archiveEnabled: true, descriptor, history };
describe("conversation availability uses existing read evidence", () => {
  it.each(["claude", "codex", "claude-codex", "grok"])("accepts supported %s with readable live events", agentKind => {
    expect(isAgentConversationKind(agentKind)).toBe(true);
    expect(conversationFallback({ ...input, agentKind, archiveEnabled: false })).toBeNull();
  });
  it.each(["none", "shell", "future-agent"])("leaves unsupported %s on the terminal", agentKind => {
    expect(conversationFallback({ ...input, agentKind })).toBe("unsupported");
  });
  it("requires an exact archive binding and a readable, complete conversation", () => {
    expect(conversationFallback(input)).toBeNull();
    expect(conversationFallback({ ...input, descriptor: null })).toBe("missing");
    expect(conversationFallback({ ...input, history: null })).toBe("loading");
    expect(conversationFallback({ ...input, history: { ...history, descriptor: { ...descriptor, expectedAgentSessionId: "other" } } })).toBe("loading");
    expect(conversationFallback({ ...input, history: { ...history, status: "opening" } })).toBe("loading");
    expect(conversationFallback({ ...input, history: { ...history, items: [] } })).toBe("empty");
    expect(conversationFallback({ ...input, history: { ...history, pages: [{ diagnostics: [{ reason: "incompleteRecord" }] }] } as never })).toBeNull();
    expect(conversationFallback({ ...input, history: { ...history, items: [{ kind: "source" }] } as never })).toBe("partial");
  });
  it("uses empty for a slash-only Claude archive projected without items or diagnostics", () => {
    const slashOnly = { ...history, items: [], pages: [{ diagnostics: [] }],
      reachedStart: true, reachedFence: true, loading: null } as unknown as HistoryState;
    expect(conversationFallback({ ...input, events: [], history: slashOnly })).toBe("empty");
  });
  it("reads Claude conversations with many metadata diagnostics, a large source record and pending page context", () => {
    const diagnostics = Array.from({ length: 1000 }, (_, index) => ({ kind: "diagnostic", text: `metadata ${index}` }));
    const mixed = { ...history, items: [{ kind: "user" }, ...diagnostics.slice(0, 500), { kind: "source" },
      { kind: "assistant" }, ...diagnostics.slice(500), { kind: "question" }],
      pages: [{ diagnostics: [{ reason: "incompleteRecord" }, { reason: "contextPending" }] }] } as unknown as HistoryState;
    expect(conversationFallback({ ...input, history: mixed })).toBeNull();
  });
  it("keeps a loaded window of only tool calls, results and diagnostics on the conversation", () => {
    const toolsOnly = { ...history, items: [{ kind: "toolCall" }, { kind: "diagnostic" }, { kind: "toolResult" }, { kind: "attachment" }, { kind: "boundary" }] } as unknown as HistoryState;
    expect(conversationFallback({ ...input, history: toolsOnly })).toBeNull();
  });
  it.each([
    { ...history, items: [{ kind: "diagnostic" }] },
    { ...history, items: [{ kind: "source" }] },
    { ...history, items: [], pages: [{ diagnostics: [{ reason: "incompleteRecord" }] }] },
  ])("returns partial only when the archive has diagnostics without conversation items", state => {
    expect(conversationFallback({ ...input, history: state as unknown as HistoryState })).toBe("partial");
  });
  it.each([["recordMissing", "missing"], ["unlinked", "missing"], ["unsupportedAgent", "unsupported"], ["permissionDenied", "unreadable"], ["identityMismatch", "unreadable"], ["sourceChanged", "unreadable"]])("routes %s to the terminal with %s reason", (error, reason) => {
    expect(conversationFallback({ ...input, history: { ...history, status: "error", error } })).toBe(reason);
  });
  it.each(["unavailable", "readError"])("does not show stale events while health is %s", telemetryHealth => {
    expect(conversationFallback({ ...input, brief: { ...brief, telemetryHealth } })).toBe("unreadable");
  });
  it.each([true, false])("distinguishes an absent record from a failed read (archive: %s)", archiveEnabled => {
    const missing = { ...brief, telemetryHealth: "unavailable", telemetryDetail: "recordNotFound" };
    expect(conversationFallback({ ...input, archiveEnabled, brief: missing })).toBe("empty");
    expect(conversationFallback({ ...input, archiveEnabled, brief: { ...brief, telemetryHealth: "unavailable" } })).toBe("unreadable");
    expect(conversationFallback({ ...input, archiveEnabled, brief: { ...missing, telemetryDetail: "other" } })).toBe("unreadable");
    expect(conversationFallback({ ...input, archiveEnabled, brief: { ...missing, telemetryHealth: "readError" } })).toBe("unreadable");
    expect(conversationFallback({ ...input, archiveEnabled, brief: { ...brief, telemetryHealth: "unlinked" } })).toBe("empty");
    expect(conversationFallback({ ...input, archiveEnabled, brief })).toBeNull();
    expect(conversationFallback({ ...input, archiveEnabled, brief: { ...brief, telemetryHealth: "ended" } })).toBeNull();
  });
  it("handles startup, empty events, partial semantic coverage and recovery", () => {
    expect(conversationFallback({ ...input, brief: { ...brief, telemetryHealth: "unlinked" } })).toBe("empty");
    expect(conversationFallback({ ...input, archiveEnabled: false, events: [] })).toBe("empty");
    const sourceUnknown = { ...brief, namingPlan: { coverage: { sourceUnknown: true } } } as LiveSessionBrief;
    expect(conversationFallback({ ...input, archiveEnabled: false, brief: sourceUnknown })).toBeNull();
    expect(conversationFallback({ ...input, archiveEnabled: false, brief: sourceUnknown, events: [] })).toBe("partial");
    expect(conversationFallback(input)).toBeNull();
  });
});
