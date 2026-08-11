import { deriveDisplayStatus } from "../../lib/notificationStatus";
import { getTabDisplayLabel } from "../../lib/tabDisplayLabel";
import type { PaneMetadata } from "../../stores/paneMetadataStore";
import type { StallEntry } from "../../stores/stallStore";
import {
  attentionCategory,
  attentionDetail,
  type AttentionCategory,
  type SessionAttention,
} from "../../stores/sessionAttentionStore";
import type { Pane, PaneTab, Workspace } from "../../types";

export type DashboardGroup = "waiting" | "stalled" | "done" | "working" | "idle";
export type DashboardStatus = DashboardGroup | "error" | "unobserved";
export type DashboardAgentKind = "claude" | "codex" | "claude-codex" | "none";

export interface DashboardCardModel {
  workspace: Workspace;
  workspaceId: string;
  workspaceIndex: number;
  pane: Pane;
  paneId: string;
  paneIndex: number;
  tab: PaneTab;
  tabIndex: number;
  background: boolean;
  attention?: SessionAttention;
  attentionCategory: AttentionCategory | null;
  group: DashboardGroup;
  status: DashboardStatus;
  stall?: StallEntry;
  metadata?: PaneMetadata;
  lastLog?: string;
  lastActivityAt: number;
  label: string;
  agentKind: DashboardAgentKind;
  unobserved: boolean;
}

export interface DashboardModelInput {
  metadataBySession: Record<string, PaneMetadata | undefined>;
  lastLogBySession: Record<string, string | undefined>;
  lastLogAtBySession: Record<string, number | undefined>;
  attentionBySession: Record<string, SessionAttention | undefined>;
  seenAttentionByTab: Map<string, string>;
  stallsBySession: Record<string, StallEntry | undefined>;
  now: number;
  hasTerminalBuffer: (sessionId: string) => boolean;
}

export interface DashboardFilters {
  query: string;
  workspaceId: string | null;
  attentionOnly: boolean;
  stalledOnly: boolean;
  backgroundOnly: boolean;
  unobservedOnly: boolean;
  agentKind: string | null;
}

export interface DashboardSection {
  id: string;
  cards: DashboardCardModel[];
}

export const DASHBOARD_GROUP_ORDER: readonly DashboardGroup[] = ["waiting", "stalled", "done", "working", "idle"];
const STALL_REASON_ORDER: Record<StallEntry["reason"], number> = {
  pty_dead: 0,
  queued_input: 1,
  no_output: 2,
};
const GROUP_ORDER: Record<DashboardGroup, number> = {
  waiting: 0,
  stalled: 1,
  done: 2,
  working: 3,
  idle: 4,
};

function tieBreak(left: DashboardCardModel, right: DashboardCardModel): number {
  return left.workspaceIndex - right.workspaceIndex
    || left.paneIndex - right.paneIndex
    || left.tabIndex - right.tabIndex;
}

function normalizeAgentKind(kind: string | undefined): DashboardAgentKind {
  return kind === "claude" || kind === "codex" || kind === "claude-codex" ? kind : "none";
}

export function groupDashboardCard(
  category: AttentionCategory | null,
  stall: StallEntry | undefined,
  lastActivityAt: number,
  now: number,
): DashboardGroup {
  if (category === "waiting" || category === "error") return "waiting";
  if (stall) return "stalled";
  if (category === "done") return "done";
  if (now - lastActivityAt <= 5 * 60_000) return "working";
  return "idle";
}

export function buildDashboardCards(workspaces: readonly Workspace[], input: DashboardModelInput): DashboardCardModel[] {
  const cards: DashboardCardModel[] = [];
  for (const [workspaceIndex, workspace] of workspaces.entries()) {
    for (const [paneIndex, pane] of workspace.panes.entries()) {
      for (const [tabIndex, tab] of pane.tabs.entries()) {
        const metadata = input.metadataBySession[tab.sessionId];
        const attention = input.attentionBySession[tab.sessionId];
        const category = attentionCategory(tab.id, attention, input.seenAttentionByTab);
        const stall = input.stallsBySession[tab.sessionId];
        const lastActivityAt = Math.max(
          input.lastLogAtBySession[tab.sessionId] ?? 0,
          metadata?.screenStatusAt ?? 0,
          metadata?.agentStatusAt ?? 0,
        );
        const unobserved = !input.hasTerminalBuffer(tab.sessionId);
        const group = groupDashboardCard(category, stall, lastActivityAt, input.now);
        const status: DashboardStatus = category === "error"
          ? "error"
          : category ?? (stall ? "stalled" : (unobserved ? "unobserved" : deriveDisplayStatus(metadata)));
        cards.push({
          workspace,
          workspaceId: workspace.id,
          workspaceIndex,
          pane,
          paneId: pane.id,
          paneIndex,
          tab,
          tabIndex,
          background: tab.id !== pane.activeTabId,
          attention,
          attentionCategory: category,
          group,
          status,
          stall,
          metadata,
          lastLog: input.lastLogBySession[tab.sessionId],
          lastActivityAt,
          label: getTabDisplayLabel(tab, tab.id === pane.activeTabId, input.metadataBySession),
          agentKind: normalizeAgentKind(metadata?.agentKind ?? tab.agentKind),
          unobserved,
        });
      }
    }
  }
  return cards;
}

function compareCardsWithinGroup(left: DashboardCardModel, right: DashboardCardModel, group: DashboardGroup): number {
  if (group === "waiting") {
    return (left.attention?.occurrenceOrder ?? Number.MAX_SAFE_INTEGER) - (right.attention?.occurrenceOrder ?? Number.MAX_SAFE_INTEGER)
      || tieBreak(left, right);
  }
  if (group === "stalled") {
    return STALL_REASON_ORDER[left.stall?.reason ?? "no_output"] - STALL_REASON_ORDER[right.stall?.reason ?? "no_output"]
      || (left.stall?.since ?? 0) - (right.stall?.since ?? 0)
      || tieBreak(left, right);
  }
  if (group === "done") {
    return (right.attention?.occurrenceOrder ?? 0) - (left.attention?.occurrenceOrder ?? 0)
      || tieBreak(left, right);
  }
  return right.lastActivityAt - left.lastActivityAt || tieBreak(left, right);
}

export function sortCardsWithinGroup(cards: readonly DashboardCardModel[], group: DashboardGroup): DashboardCardModel[] {
  return [...cards].sort((left, right) => compareCardsWithinGroup(left, right, group));
}

function compareCardsByGroup(left: DashboardCardModel, right: DashboardCardModel): number {
  return GROUP_ORDER[left.group] - GROUP_ORDER[right.group]
    || compareCardsWithinGroup(left, right, left.group);
}

export function applyDashboardFilters(cards: readonly DashboardCardModel[], filters: DashboardFilters): DashboardCardModel[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return cards.filter((card) => {
    if (filters.workspaceId && card.workspaceId !== filters.workspaceId) return false;
    if (filters.attentionOnly && card.group !== "waiting") return false;
    if (filters.stalledOnly && card.group !== "stalled") return false;
    if (filters.backgroundOnly && !card.background) return false;
    if (filters.unobservedOnly && !card.unobserved) return false;
    if (filters.agentKind && card.agentKind !== filters.agentKind) return false;
    if (!query) return true;
    const searchable = [
      card.workspace.name,
      card.label,
      card.metadata?.cwd ?? "",
      card.lastLog ?? "",
      attentionDetail(card.attention) ?? "",
    ].join("\n").toLocaleLowerCase();
    return searchable.includes(query);
  });
}

export function groupSections(
  cards: readonly DashboardCardModel[],
  sortMode: "attention" | "workspace" | "agent",
): DashboardSection[] {
  if (sortMode === "attention") {
    return DASHBOARD_GROUP_ORDER.map((group) => ({
      id: group,
      cards: sortCardsWithinGroup(cards.filter((card) => card.group === group), group),
    })).filter((section) => section.cards.length > 0);
  }
  if (sortMode === "workspace") {
    const workspaceIds = [...new Set(cards.map((card) => card.workspaceId))];
    return workspaceIds.map((workspaceId) => {
      const workspaceCards = cards.filter((card) => card.workspaceId === workspaceId);
      return {
        id: workspaceId,
        cards: [...workspaceCards].sort(compareCardsByGroup),
      };
    });
  }
  const kinds: DashboardAgentKind[] = ["claude", "codex", "claude-codex", "none"];
  return kinds.map((kind) => ({
    id: kind,
    cards: cards.filter((card) => card.agentKind === kind).sort(compareCardsByGroup),
  })).filter((section) => section.cards.length > 0);
}

export function urgentRibbon(cards: readonly DashboardCardModel[]): DashboardCardModel[] {
  return sortCardsWithinGroup(cards.filter((card) => card.group === "waiting"), "waiting").slice(0, 3);
}
