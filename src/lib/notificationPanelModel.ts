import { collectNotificationEntries, type NotificationEntry } from "./notificationEntries";
import { resolveDisplayAgentKind, type DisplayAgentKind } from "./agentDisplayKind";
import { sortAttentionCards } from "../components/dashboard/attentionModel";
import type { AttentionCard } from "./attentionBridge";
import type { SessionAttention } from "../stores/sessionAttentionStore";
import type { PaneMetadata, PaneVolatileMetadata } from "../stores/paneMetadataStore";
import type { Workspace } from "../types";

export interface NotificationPanelRow extends Omit<NotificationEntry, "kind"> {
  kind: "input" | "approval" | "unread";
  agentKind: DisplayAgentKind | null;
}

export function buildNotificationPanelModel(
  workspaces: readonly Workspace[],
  attentionBySession: Record<string, SessionAttention>,
  metadata: Record<string, PaneMetadata>,
  volatileMetadata: Record<string, PaneVolatileMetadata> = {},
) {
  const tabs = new Map(workspaces.flatMap((ws) => ws.panes.flatMap((pane) =>
    pane.tabs.map((tab) => [tab.id, tab] as const),
  )));
  // Adapt eligibility only; the existing collector still owns live-tab traversal
  // and label precedence. Never change the store's unread counters here.
  const eligibleMetadata: Record<string, PaneMetadata> = {};
  for (const tab of tabs.values()) {
    const meta = metadata[tab.sessionId];
    const kind = attentionBySession[tab.sessionId]?.kind;
    const unread = (meta?.notificationCount ?? 0) + (meta?.workDoneCount ?? 0);
    eligibleMetadata[tab.sessionId] = {
      ...meta,
      notificationCount: kind === "input" || kind === "approval" ? Math.max(1, unread) : unread,
    };
  }
  const byTab = new Map<string, NotificationPanelRow>();
  const cards: AttentionCard[] = [];
  const unread: NotificationPanelRow[] = [];
  for (const entry of collectNotificationEntries(workspaces, eligibleMetadata, volatileMetadata)) {
    if (byTab.has(entry.tabId)) continue;
    const tab = tabs.get(entry.tabId)!;
    const state = attentionBySession[entry.sessionId];
    const kind = state?.kind === "input" || state?.kind === "approval" ? state.kind : "unread";
    const meta = metadata[entry.sessionId];
    const row: NotificationPanelRow = {
      ...entry,
      count: (meta?.notificationCount ?? 0) + (meta?.workDoneCount ?? 0),
      kind,
      agentKind: resolveDisplayAgentKind(meta?.agentKind ?? tab.agentKind, tab.commandArgv),
    };
    byTab.set(row.tabId, row);
    if (kind === "unread") {
      unread.push(row);
      continue;
    }
    const session = { type: "pty" as const, pty_session_id: row.sessionId };
    // Input and approval both block work while waiting for a human. ADR 0011
    // then orders by observation time, occurrence order, and stable tab ID.
    cards.push({
      id: row.tabId, fingerprint: state.attentionId ?? row.tabId,
      kind: "agentAsked", waiting: "human", severity: "blocking",
      actor: "human", freshness: "fresh", sourceRank: state.occurrenceOrder,
      workorderId: null, session, whyNow: state.detail ?? "", impact: "",
      evidence: [], primaryAction: { type: "answerQuestion", session },
      replyRoute: { type: "session", session },
      resolutionPredicate: { type: "observationMissing", observation_key: state.attentionId ?? row.tabId },
      state: "open", firstSeenAt: state.stateSince, lastSeenAt: state.stateSince,
      revision: state.sessionRevision, resolvedAt: null,
    });
  }
  const attention = sortAttentionCards(cards).map((card) => byTab.get(card.id)!);
  return {
    attention,
    unread,
    attentionCount: attention.length,
    questionCount: attention.filter((row) => row.kind === "input").length,
    approvalCount: attention.filter((row) => row.kind === "approval").length,
    unreadCount: unread.reduce((sum, row) => sum + row.count, 0),
  };
}
