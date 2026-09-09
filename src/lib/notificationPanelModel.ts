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
  /** Null on unread rows; the id the bell dismisses through `markSeen`. */
  attentionId: string | null;
}

/** Which arrivals the bell is allowed to report, straight from the settings. */
export interface NotificationBellFilter {
  question: boolean;
  approval: boolean;
  workDone: boolean;
  unread: boolean;
}

export const ALL_BELL_NOTIFICATIONS: NotificationBellFilter = {
  question: true,
  approval: true,
  workDone: true,
  unread: true,
};

export interface NotificationPanelOptions {
  /**
   * Tab -> attention id the person already dealt with. A question stays in the
   * session's live state until the agent moves on, so without this the bell
   * would keep reporting one the owner has explicitly dismissed. Pane tab pills
   * already read the same map, which is what keeps bell and pill in step.
   */
  seenAttentionByTab?: ReadonlyMap<string, string>;
  filter?: NotificationBellFilter;
}

/** The kind this tab blocks on, or null when it is not (or no longer) blocking. */
function blockingKind(
  tabId: string,
  attention: SessionAttention | undefined,
  seenAttentionByTab: ReadonlyMap<string, string>,
  filter: NotificationBellFilter,
): "input" | "approval" | null {
  if (attention?.kind !== "input" && attention?.kind !== "approval") return null;
  if (!(attention.kind === "input" ? filter.question : filter.approval)) return null;
  // No id means nothing can mark it seen — the row would sit here forever. The
  // pane pills and the dashboard already skip those, so the bell does too and
  // lets the plain unread counters carry the seat instead.
  if (!attention.attentionId) return null;
  if (seenAttentionByTab.get(tabId) === attention.attentionId) return null;
  return attention.kind;
}

export function buildNotificationPanelModel(
  workspaces: readonly Workspace[],
  attentionBySession: Record<string, SessionAttention>,
  metadata: Record<string, PaneMetadata>,
  volatileMetadata: Record<string, PaneVolatileMetadata> = {},
  options: NotificationPanelOptions = {},
) {
  const seenAttentionByTab = options.seenAttentionByTab ?? new Map<string, string>();
  const filter = options.filter ?? ALL_BELL_NOTIFICATIONS;
  const tabs = new Map(workspaces.flatMap((ws) => ws.panes.flatMap((pane) =>
    pane.tabs.map((tab) => [tab.id, tab] as const),
  )));
  const unreadCountFor = (meta: PaneMetadata | undefined): number =>
    (filter.unread ? meta?.notificationCount ?? 0 : 0)
    + (filter.workDone ? meta?.workDoneCount ?? 0 : 0);
  // Adapt eligibility only; the existing collector still owns live-tab traversal
  // and label precedence. Never change the store's unread counters here.
  const eligibleMetadata: Record<string, PaneMetadata> = {};
  const blockingByTab = new Map<string, "input" | "approval">();
  for (const tab of tabs.values()) {
    const meta = metadata[tab.sessionId];
    const blocking = blockingKind(tab.id, attentionBySession[tab.sessionId], seenAttentionByTab, filter);
    if (blocking) blockingByTab.set(tab.id, blocking);
    const unread = unreadCountFor(meta);
    eligibleMetadata[tab.sessionId] = {
      ...meta,
      notificationCount: blocking ? Math.max(1, unread) : unread,
    };
  }
  const byTab = new Map<string, NotificationPanelRow>();
  const cards: AttentionCard[] = [];
  const unread: NotificationPanelRow[] = [];
  for (const entry of collectNotificationEntries(workspaces, eligibleMetadata, volatileMetadata)) {
    if (byTab.has(entry.tabId)) continue;
    const tab = tabs.get(entry.tabId)!;
    const state = attentionBySession[entry.sessionId];
    const kind = blockingByTab.get(entry.tabId) ?? "unread";
    const meta = metadata[entry.sessionId];
    const row: NotificationPanelRow = {
      ...entry,
      count: unreadCountFor(meta),
      kind,
      agentKind: resolveDisplayAgentKind(
        meta?.agentKind ?? tab.agentKind,
        tab.commandArgv,
        tab.launchEnv?.MYCMUX_LAUNCH_TARGET,
      ),
      attentionId: kind === "unread" ? null : state.attentionId,
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
