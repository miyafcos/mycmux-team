import type { PaneTab, Workspace } from "../types";
import type { WindowFragment, PaneTabConfig } from "./ipc";
import type { SessionAttention } from "../stores/sessionAttentionStore";
import type { SessionStatusSignals } from "./sessionStatusSignals";
import { otherWindowWorkspaces } from "./socketTabWindows";
import { getTabDisplayLabel as tabDisplayLabel } from "./tabDisplayLabel";
import { clipIdentityName, isToolIdentifier, normalizeIdentityText, resolvePaneIdentities, type ProjectRegistration } from "./paneIdentity";
import type { GroupingPlan } from "../components/layout/tabGrouping";

export type OverviewState = "waiting" | "working" | "done" | "idle" | "unknown";
export const OVERVIEW_STATE_LABELS: Record<OverviewState, string> = {
  waiting: "応答待ち", working: "作業中", done: "完了", idle: "待機", unknown: "不明",
};
export interface OverviewCard {
  key: string; windowLabel: string; workspaceId: string; workspaceName: string;
  paneId: string; paneName: string; tab: PaneTab; pinned: boolean;
  state: OverviewState; notificationKey: string | null; lastActivityAt: number | null;
  peer: boolean; peerConfirmedAt: number | null;
}
export interface OverviewSnapshot {
  cards: OverviewCard[];
  counts: Record<OverviewState, number>;
}
export interface OverviewInput {
  workspaces: readonly Workspace[]; ownWindow: string; fragments?: readonly WindowFragment[];
  attention: Readonly<Record<string, SessionAttention>>;
  signals?: Readonly<Record<string, SessionStatusSignals>>;
  peerConfirmedAt?: number | null;
}
export interface FoldSuggestion {
  kind: "fold"; id: string; cardKey: string; notificationKey: string; title: string; reason: string;
}
export interface GatherSuggestion {
  kind: "gather"; id: string; cardKey: string; tabId: string; sessionId: string; windowLabel: string;
  sourceWorkspaceId: string; sourcePaneId: string;
  targetWorkspaceId: string; targetPaneId: string;
  title: string; reason: string; evidence: string[];
}
export type OverviewSuggestion = FoldSuggestion | GatherSuggestion;

export function overviewState(attention?: SessionAttention): OverviewState {
  if (!attention) return "unknown";
  // An idle shell is never an unanswered question.
  if (["input", "approval", "error", "rate_limited"].includes(attention.kind)) return "waiting";
  if (attention.kind === "done" || attention.uiState === "done") return "done";
  return attention.uiState;
}
export function overviewNotificationKey(attention?: SessionAttention): string | null {
  if (!attention || attention.kind === "none" || !attention.attentionId) return null;
  return JSON.stringify([attention.sessionId, attention.sessionEpoch, attention.kind, attention.attentionId]);
}
function peerTab(raw: PaneTabConfig): PaneTab | null {
  if (!raw.tab_id || !raw.session_id) return null;
  return {
    id: raw.tab_id, sessionId: raw.session_id, agentId: raw.agent_id,
    label: raw.label ?? undefined, labelSource: raw.label_source ?? undefined,
    displayName: raw.display_name ?? undefined, type: raw.type ?? undefined,
    cwd: raw.cwd ?? undefined, lifecycle: raw.lifecycle ?? undefined,
    origin: raw.origin ? { kind: raw.origin.kind, parentTabId: raw.origin.parent_tab_id ?? undefined } : undefined,
  };
}
export function buildOverviewSnapshot(input: OverviewInput): OverviewSnapshot {
  const cards: OverviewCard[] = [];
  const seenTabs = new Set<string>();
  const append = (windowLabel: string, workspaceId: string, workspaceName: string,
    paneId: string, paneName: string, tab: PaneTab, pinned: boolean, peer: boolean) => {
    if (seenTabs.has(tab.id)) return;
    seenTabs.add(tab.id);
    const attention = input.attention[tab.sessionId];
    cards.push({
      key: tab.id, windowLabel, workspaceId, workspaceName, paneId, paneName, tab, pinned,
      state: overviewState(attention), notificationKey: overviewNotificationKey(attention),
      lastActivityAt: input.signals?.[tab.sessionId]?.lastOutputAt ?? attention?.stateSince ?? null,
      peer, peerConfirmedAt: peer ? input.peerConfirmedAt ?? null : null,
    });
  };
  for (const workspace of input.workspaces) for (const pane of workspace.panes) {
    const paneName = pane.label || tabDisplayLabel(pane.tabs.find(tab => tab.id === pane.activeTabId) ?? pane.tabs[0] ?? { id: pane.id, sessionId: "", agentId: "" });
    for (const tab of pane.tabs) append(input.ownWindow, workspace.id, workspace.name, pane.id, paneName, tab, pane.pinnedTabId === tab.id, false);
  }
  const peers = otherWindowWorkspaces(input.fragments ?? [], new Set(input.workspaces.map(workspace => workspace.id)), input.ownWindow);
  for (const { windowLabel, workspace } of peers) for (const pane of workspace.panes) {
    for (const raw of pane.tabs ?? []) {
      const tab = peerTab(raw);
      if (tab) append(windowLabel, workspace.id, workspace.name, pane.pane_id ?? "", pane.label || "タブ", tab, pane.pinned_tab_id === tab.id, true);
    }
  }
  const counts: OverviewSnapshot["counts"] = { waiting: 0, working: 0, done: 0, idle: 0, unknown: 0 };
  for (const card of cards) counts[card.state] += 1;
  return { cards, counts };
}

/** Retain row membership/order until the person explicitly refreshes a filter. */
export function overviewVisibleKeys(cards: readonly OverviewCard[], filter: OverviewState | "all",
  folded: Readonly<Record<string, string>>, previous?: readonly string[]): string[] {
  const byKey = new Map(cards.map(card => [card.key, card]));
  const eligible = (card: OverviewCard) => !(card.state === "done" && card.notificationKey && folded[card.key] === card.notificationKey);
  if (previous) return previous.filter(key => byKey.has(key) && eligible(byKey.get(key)!));
  return cards.filter(card => eligible(card) && (filter === "all" || card.state === filter)).map(card => card.key);
}
export function activityAge(at: number | null, now: number): string {
  if (!at || at <= 0) return "時刻不明";
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return seconds + "秒前";
  if (seconds < 3600) return Math.floor(seconds / 60) + "分前";
  return Math.floor(seconds / 3600) + "時間前";
}
const pathKey = (path?: string) => (path ?? "").normalize("NFKC").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
function usefulFolder(path?: string): string | null {
  const key = pathKey(path);
  if (!key || /^[a-z]:$/i.test(key) || /^[a-z]:\/users\/[^/]+$/i.test(key)
    || /^\/(?:home\/[^/]+|users\/[^/]+|tmp)$/i.test(key)) return null;
  return key;
}
function toolHead(tab: PaneTab): string | null {
  if (!isToolIdentifier(tab)) return null;
  const words = normalizeIdentityText(tab.label ?? "").split(/[-_]/).filter(word => !/^\d+$/.test(word));
  // A project name alone is not a task; the shared head includes a second word.
  return words.length >= 3 && words.slice(0, 2).every(word => /[a-z]/.test(word) && word.length >= 3)
    ? words.slice(0, 2).join("-") : null;
}
function protectedCard(card: OverviewCard): boolean {
  return card.pinned || card.tab.labelSource === "user"
    || Boolean(card.tab.label && card.tab.labelSource !== "ai" && !isToolIdentifier(card.tab));
}
export function buildOverviewSuggestions(cards: readonly OverviewCard[], registry: readonly ProjectRegistration[],
  folded: Readonly<Record<string, string>> = {}): OverviewSuggestion[] {
  const suggestions: Array<{ suggestion: OverviewSuggestion; strength: number }> = [];
  for (const card of cards) {
    if (card.state === "done" && card.notificationKey && folded[card.key] !== card.notificationKey) {
      suggestions.push({ strength: 10, suggestion: {
        kind: "fold", id: "fold:" + card.notificationKey, cardKey: card.key, notificationKey: card.notificationKey,
        title: "「" + tabDisplayLabel(card.tab) + "」を確認して畳む",
        reason: card.workspaceName + " / " + card.paneName + " の完了通知。確認した通知だけを畳みます。",
      } });
    }
  }
  const local = cards.filter(card => !card.peer && card.tab.type !== "launcher" && (!card.tab.type || card.tab.type === "terminal") && card.tab.lifecycle !== "declared");
  const identities = resolvePaneIdentities({
    registry, workspaces: [...new Map(local.map(card => [card.workspaceId, { id: card.workspaceId, name: card.workspaceName }])).values()],
    tabs: local.map(card => ({ id: card.key, workspaceId: card.workspaceId, label: card.tab.label,
      labelSource: card.tab.labelSource, cwd: card.tab.cwd ?? "", parentTabId: card.tab.origin?.parentTabId })),
  }).tabs;
  const byId = new Map(local.map(card => [card.key, card]));
  const lineage = (card: OverviewCard) => {
    const visited = new Set<string>();
    let key = card.key;
    while (byId.get(key)?.tab.origin?.parentTabId) {
      if (visited.has(key)) return null;
      visited.add(key);
      const parent = byId.get(key)!.tab.origin!.parentTabId!;
      if (!byId.has(parent)) return parent;
      key = parent;
    }
    return visited.size ? key : local.some(other => other.tab.origin?.parentTabId === key) ? key : null;
  };
  const facts = new Map(local.map(card => {
    const identity = identities.get(card.key);
    return [card.key, { folder: usefulFolder(card.tab.cwd), lineage: lineage(card), head: toolHead(card.tab),
      project: identity?.project && identity.projectReason !== "workspace_name" ? identity.project.key : null }];
  }));
  const matches = (left: OverviewCard, right: OverviewCard) => {
    const a = facts.get(left.key)!, b = facts.get(right.key)!;
    const reasons: string[] = [];
    if (a.folder && a.folder === b.folder) reasons.push("同じ作業フォルダ");
    if (a.lineage && a.lineage === b.lineage) reasons.push("同じ親子のまとまり");
    if (a.head && a.head === b.head) reasons.push("道具の名前の共通の頭「" + a.head + "」");
    if (a.project && a.project === b.project) reasons.push("同じ案件登録「" + identities.get(left.key)!.project!.display + "」");
    return reasons;
  };
  for (const source of local) {
    if (protectedCard(source)) continue;
    const candidates = new Map<string, { cards: OverviewCard[]; reasons: string[] }>();
    const siblings = local.filter(card => card.windowLabel === source.windowLabel && matches(source, card).length >= 2);
    const sourceCount = siblings.filter(card => card.paneId === source.paneId).length;
    for (const target of siblings) {
      if (target.paneId === source.paneId || target.windowLabel !== source.windowLabel) continue;
      const candidate = candidates.get(target.paneId) ?? { cards: [], reasons: matches(source, target) };
      candidate.cards.push(target);
      candidates.set(target.paneId, candidate);
    }
    const ranked = [...candidates.values()].sort((a, b) => b.cards.length - a.cards.length || b.reasons.length - a.reasons.length);
    const best = ranked[0];
    if (!best || best.cards.length <= sourceCount || (ranked[1] && ranked[1].cards.length === best.cards.length)) continue;
    const target = best.cards[0];
    // Pairwise agreement prevents broad project matches from mixing separate tasks.
    if (!best.cards.every(card => best.cards.every(other => matches(card, other).length >= 2))) continue;
    const title = "「" + tabDisplayLabel(source.tab) + "」を " + source.workspaceName + " / " + source.paneName
      + " から " + target.workspaceName + " / " + target.paneName + " へ寄せる";
    suggestions.push({ strength: best.reasons.length + best.cards.length / 100, suggestion: {
      kind: "gather", id: "gather:" + source.key + ":" + target.paneId,
      cardKey: source.key, tabId: source.key, sessionId: source.tab.sessionId, windowLabel: source.windowLabel,
      sourceWorkspaceId: source.workspaceId, sourcePaneId: source.paneId,
      targetWorkspaceId: target.workspaceId, targetPaneId: target.paneId, title,
      reason: best.reasons.join("・") + " が一致。今いる仲間 " + best.cards.length + " ペインのタブへ。", evidence: best.reasons,
    } });
  }
  return suggestions.sort((a, b) => b.strength - a.strength || a.suggestion.id.localeCompare(b.suggestion.id))
    .slice(0, 5).map(item => item.suggestion);
}
export function overviewGatherPlan(suggestion: GatherSuggestion, workspaces: readonly Workspace[]): GroupingPlan | null {
  const source = workspaces.find(workspace => workspace.id === suggestion.sourceWorkspaceId)?.panes.find(pane => pane.id === suggestion.sourcePaneId);
  const tab = source?.tabs.find(tab => tab.id === suggestion.tabId && tab.sessionId === suggestion.sessionId);
  const destination = workspaces.find(workspace => workspace.id === suggestion.targetWorkspaceId)?.panes.find(pane => pane.id === suggestion.targetPaneId);
  if (!source || !tab || !destination || source.id === destination.id || source.pinnedTabId === tab.id || tab.labelSource === "user") return null;
  const all = workspaces.flatMap(workspace => workspace.panes.flatMap(pane => pane.tabs.map(tab => tab.id)));
  return {
    nameSource: "evidence", planId: suggestion.id, title: "このペインを寄せる", rationale: suggestion.reason, strategy: "minimal_move",
    groups: [{
      groupId: suggestion.id, title: clipIdentityName(tabDisplayLabel(tab)), disposition: "reorganize",
      destination: { kind: "existing_workspace", workspaceId: suggestion.targetWorkspaceId },
      layout: { columns: [{ panes: [{ existingPaneId: suggestion.targetPaneId, title: destination.label ?? "タブ", role: "unspecified", tabIds: [tab.id] }] }] },
      tabIds: [tab.id], adopted: true,
    }, {
      groupId: "keep", title: "今の場所を保つ", disposition: "keep", destination: { kind: "current_locations" },
      layout: null, tabIds: all.filter(id => id !== tab.id), adopted: false,
    }], unassignedTabIds: [], warnings: [],
  };
}
