import type { AgentTelemetry, LiveSessionBrief } from "../../lib/livebrief";
import { deriveDisplayStatus } from "../../lib/notificationStatus";
import { getTabDisplayLabel } from "../../lib/tabDisplayLabel";
import type { PaneMetadata, PaneVolatileMetadata } from "../../stores/paneMetadataStore";
import type { StallEntry } from "../../stores/stallStore";
import {
  attentionCategory,
  attentionDetail,
  type AttentionCategory,
  type SessionAttention,
  type DormantCompletionRecord,
} from "../../stores/sessionAttentionStore";
import { resolveTabMark, type TabMark } from "../../lib/tabMark";
import type { Pane, PaneTab, Workspace } from "../../types";
import { noUpdateMinutes } from "./liveTimelineModel";
import { resolveDelegationState, localParentState, mergeDelegationParent, type DelegationParent } from "./delegationModel";

export type DashboardGroup = "waiting" | "stalled" | "done" | "working" | "idle";
export type DashboardStatus = DashboardGroup | "error" | "unobserved";
export type DashboardAgentKind = "claude" | "codex" | "claude-codex" | "grok" | "none";

/**
 * 画面に出す1本化した状態。カードのグリッド時代の group/section を置き換える。
 * livebrief が生きている間はそちらが正、そうでなければ attention/stall/metadata へ落ちる。
 */
export type DashboardDisplayState = "needsHuman" | "error" | "running" | "noUpdate" | "done" | "acknowledged" | "idle" | "stopped" | "delegated" | "delegationUnknown";
export type DashboardStateFilter = "needsHuman" | "running" | "noUpdate" | "done";

/** 「更新なし」と言い切るまでの猶予 (分)。 */
export const NO_UPDATE_THRESHOLD_MINUTES = 5;

export interface DashboardCardModel {
  now?: number;
  workspace: Workspace;
  workspaceId: string;
  workspaceIndex: number;
  pane: Pane;
  paneId: string;
  paneIndex: number;
  tab: PaneTab;
  tabIndex: number;
  /** 同じタブの非アクティブペインかどうか。並びの内部判断だけに使い、表示には出さない。 */
  background: boolean;
  attention?: SessionAttention;
  dormantCompletion?: boolean;
  attentionCategory: AttentionCategory | null;
  /** 手動の完了マーク。新しい活動が確認できたカードには載せない。 */
  manualDoneAt?: number;
  group: DashboardGroup;
  status: DashboardStatus;
  stall?: StallEntry;
  metadata?: PaneMetadata;
  volatileMetadata?: PaneVolatileMetadata;
  lastLog?: string;
  lastActivityAt: number;
  label: string;
  agentKind: DashboardAgentKind;
  /** Vendor mark for the row. A Web tab has no agentKind but still has one. */
  mark: TabMark | null;
  /** xterm のバッファを持っていないだけの状態。表示には出さない (断定できないため)。 */
  unobserved: boolean;
  /** 一度も開いていないペイン。telemetry も端末バッファも活動記録も無い状態だけを指す。 */
  neverStarted: boolean;
  // --- livebrief 由来 (telemetryHealth === "live" のときだけ意味がある) ---
  brief?: LiveSessionBrief;
  delegationParent?: DelegationParent;
  operationalState?: string;
  telemetryHealth?: string;
  task?: string | null;
  /** 直近の「私の指示」。brief 直結なので一覧行はイベント取得を待たずに出せる。 */
  latestInstruction?: string | null;
  activityText?: string | null;
  checkpoint?: string | null;
  /** 最後に何かが起きてからの経過分。基準が取れなければ null。 */
  noUpdateMinutes: number | null;
  /** livebrief が組み立てた計器情報。無いときは計器行を出さない。 */
  telemetry?: AgentTelemetry | null;
}

export interface DashboardModelInput {
  metadataBySession: Record<string, PaneMetadata | undefined>;
  volatileMetadataBySession: Record<string, PaneVolatileMetadata | undefined>;
  lastLogBySession: Record<string, string | undefined>;
  lastLogAtBySession: Record<string, number | undefined>;
  attentionBySession: Record<string, SessionAttention | undefined>;
  dormantCompletionsBySession?: Record<string, DormantCompletionRecord | undefined>;
  seenAttentionByTab: Map<string, string>;
  doneMarkByTab: Map<string, number>;
  stallsBySession: Record<string, StallEntry | undefined>;
  briefsBySession?: Record<string, LiveSessionBrief | undefined>;
  delegationParents?: Record<string, DelegationParent | undefined>;
  now: number;
  hasTerminalBuffer: (sessionId: string) => boolean;
}

export interface DashboardFilters {
  query: string;
  workspaceId: string | null;
  needsHumanOnly: boolean;
  agentKind: string | null;
  stateFilter?: DashboardStateFilter | null;
}

/** 一本化した並び順: 人間入力待ち > エラー > 実行中 > 更新なし > 待機 > 完了 > 確認済み。 */
const STATE_ORDER: Record<DashboardDisplayState, number> = {
  needsHuman: 0,
  error: 1,
  running: 2,
  noUpdate: 3,
  idle: 4,
  done: 5,
  acknowledged: 6,
  stopped: 7,
  delegated: 8,
  delegationUnknown: 9,
};

function tieBreak(left: DashboardCardModel, right: DashboardCardModel): number {
  return left.workspaceIndex - right.workspaceIndex
    || left.paneIndex - right.paneIndex
    || left.tabIndex - right.tabIndex;
}

function normalizeAgentKind(kind: string | undefined): DashboardAgentKind {
  return kind === "claude" || kind === "codex" || kind === "claude-codex" || kind === "grok" ? kind : "none";
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
  if (now - lastActivityAt <= NO_UPDATE_THRESHOLD_MINUTES * 60_000) return "working";
  return "idle";
}

function finiteTimestamp(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 手動完了マーク後に届いた活動だけを無効化の根拠にする。
 * ターン状態のある brief は意味イベントの時刻を使い、定期的な読取では解除しない。
 * 旧 brief の時刻の扱いは維持する。
 */
export function isManualDoneMarkValid(card: DashboardCardModel, markedAt: number): boolean {
  if (!Number.isFinite(markedAt)) return false;
  const autonomy = card.brief?.autonomy;
  if (autonomy && Object.prototype.hasOwnProperty.call(autonomy, "turnStartedAt") && autonomy.turnState !== "active"
    && !autonomy.openToolCount && !autonomy.armedBackgroundCount && !autonomy.pendingNotificationCount) {
    // A delayed completion envelope belongs to the same turn, even if the PTY
    // output or attention clock moved after the user marked it complete.
    const startedAt = finiteTimestamp(autonomy.turnStartedAt);
    if (startedAt !== null && startedAt > markedAt) return false;
    if ((card.operationalState === "needsHuman" || card.attentionCategory === "error")
      && Math.max(card.brief?.lastEventAt ?? 0, card.attention?.stateSince ?? 0) > markedAt) return false;
    return !(card.stall?.reason === "queued_input" && card.stall.since > markedAt);
  }
  const activityTimes = [
    finiteTimestamp(card.lastActivityAt),
    finiteTimestamp(card.attention?.stateSince),
    finiteTimestamp(card.brief?.lastEventAt),
    finiteTimestamp(card.brief?.autonomy ? null : card.brief?.lastSuccessfulReadAt),
    finiteTimestamp(card.brief?.autonomy ? null : card.brief?.updatedAt),
  ].filter((value): value is number => value !== null);
  return !activityTimes.some((activityAt) => activityAt > markedAt);
}

/**
 * livebrief が「生きている」と言える間はそれを正とし、そうでなければ
 * 従来の attention / stall / metadata 判定へ落とす。断定できないものは idle。
 */
export function resolveDisplayState(card: DashboardCardModel): DashboardDisplayState {
  if (card.manualDoneAt !== undefined) return "acknowledged";
  if (card.telemetryHealth === "live") {
    if (card.operationalState === "needsHuman") return "needsHuman";
    if (card.attentionCategory === "error") return "error";
    if (card.brief?.autonomy) {
      if (card.stall?.reason === "pty_dead" || card.volatileMetadata?.ptyAlive === false) return "stopped";
      if (card.stall?.reason === "queued_input") return "noUpdate";
      if (isSelfDriving(card.brief, card.now)) return "running";
      if (card.brief.autonomy.turnState === "complete") return completedDisplayState(card);
      if (card.brief.autonomy.turnState === "idle") return "idle";
    }
    // Without turn boundaries use the baseline rule, including quiet Grok turns.
    if ((card.noUpdateMinutes ?? 0) >= NO_UPDATE_THRESHOLD_MINUTES) return "noUpdate";
    if (card.operationalState === "running") return "running";
    if (card.attentionCategory === "done") return completedDisplayState(card);
    return "idle";
  }
  if (card.attentionCategory === "waiting") return "needsHuman";
  if (card.attentionCategory === "error") return "error";
  if (card.tab.delegatedByTabId && !card.dormantCompletion && (card.telemetryHealth === "ended" || card.stall?.reason === "pty_dead"
    || card.volatileMetadata?.ptyAlive === false)) return "stopped";
  if (card.attentionCategory === "done") return completedDisplayState(card);
  if (card.telemetryHealth === "ended" || card.stall?.reason === "pty_dead") return "stopped";
  // まだ一度も開いていないペインに「更新なし」「作業中」を貼らない (未起動はバッジで出す)。
  if (card.neverStarted) return "idle";
  if (card.stall) return "noUpdate";
  // まだ一度も動いていないペインを「更新なし」と言い切らない。
  if (!card.lastActivityAt) return "idle";
  return card.group === "idle" ? "noUpdate" : "running";
}

// Claude Monitor lasts at most 30 minutes. A renewal within the tail window
// is known work, so omitted history alone need not keep a completed seat busy.
// Claude immediately resumes a completed turn for a delivered notice. A pending
// count left after the same window is bookkeeping uncertainty, not live work.
export const UNKNOWN_AUTONOMY_TTL_MS = 30 * 60_000;
export function isSelfDriving(brief: LiveSessionBrief | undefined, now = Date.now()): boolean {
  if (brief?.telemetryHealth !== "live") return false;
  const autonomy = brief.autonomy;
  const unknownIsRecent = brief.lastEventAt !== null && now - brief.lastEventAt < UNKNOWN_AUTONOMY_TTL_MS;
  const notificationIsPending = (autonomy?.pendingNotificationCount ?? 0) > 0
    && (autonomy?.turnState !== "complete" || brief.lastEventAt === null || unknownIsRecent);
  return Boolean(autonomy && (autonomy.turnState === "active"
    || (unknownIsRecent && (autonomy.turnState === "unknown" || autonomy.backgroundState === "unknown"))
    || autonomy.openToolCount > 0 || autonomy.armedBackgroundCount > 0 || notificationIsPending));
}

function completedDisplayState(card: DashboardCardModel): DashboardDisplayState {
  const state = resolveDelegationState(card.tab, card.delegationParent, card.now ?? card.brief?.updatedAt ?? Date.now());
  return state === "alive" ? "delegated" : state === "unknown" ? "delegationUnknown" : "done";
}

/** Urgent navigation retains the baseline answer/error scope. */
export function needsDashboardAttention(card: DashboardCardModel): boolean {
  const state = resolveDisplayState(card);
  return state === "needsHuman" || state === "error";
}

export function buildDashboardCards(workspaces: readonly Workspace[], input: DashboardModelInput): DashboardCardModel[] {
  const parentById = new Map<string, DelegationParent>();
  for (const workspace of workspaces) for (const pane of workspace.panes) for (const tab of pane.tabs) {
    const observation = input.volatileMetadataBySession[tab.sessionId];
    const state = localParentState(observation);
    const local: DelegationParent = {
      tabId: tab.id, sessionId: tab.sessionId,
      label: getTabDisplayLabel(tab, tab.id === pane.activeTabId, input.metadataBySession, input.volatileMetadataBySession),
      state, alive: state === "alive",
      checkedAt: state === "unknown" ? undefined : observation?.liveAgentObservedAt ?? input.now,
      firstObservedAt: observation?.liveAgentChangedAt,
      agentSessionId: observation?.liveAgentSessionId,
      processStartedAt: observation?.liveAgentStartedAt,
      identityUnknownSince: observation?.liveAgentIdentityUnknownSince,
      startUnknownSince: observation?.liveAgentStartUnknownSince,
    };
    const parent = mergeDelegationParent(input.delegationParents?.[tab.id], local, input.now);
    parentById.set(tab.id, parent);
  }
  const cards: DashboardCardModel[] = [];
  for (const [workspaceIndex, workspace] of workspaces.entries()) {
    for (const [paneIndex, pane] of workspace.panes.entries()) {
      for (const [tabIndex, tab] of pane.tabs.entries()) {
        const metadata = input.metadataBySession[tab.sessionId];
        const volatileMetadata = input.volatileMetadataBySession[tab.sessionId];
        const attention = input.attentionBySession[tab.sessionId];
        const category = attentionCategory(tab.id, attention, input.seenAttentionByTab);
        const stall = input.stallsBySession[tab.sessionId];
        const brief = input.briefsBySession?.[tab.sessionId];
        const lastActivityAt = Math.max(
          input.lastLogAtBySession[tab.sessionId] ?? 0,
          metadata?.screenStatusAt ?? 0,
          metadata?.agentStatusAt ?? 0,
        );
        // A Web tab has no terminal buffer and never will: judging it by one
        // labelled every ChatGPT tab "未観測・未起動" while the page was open
        // and readable. Its conversation is read from the pane instead.
        const isWebTab = tab.type === "web";
        const unobserved = !isWebTab && !input.hasTerminalBuffer(tab.sessionId);
        const group = groupDashboardCard(category, stall, lastActivityAt, input.now);
        const status: DashboardStatus = category === "error"
          ? "error"
          : category ?? (stall ? "stalled" : (unobserved ? "unobserved" : deriveDisplayStatus(metadata, volatileMetadata)));
        const activityMinutes = lastActivityAt
          ? Math.max(0, Math.floor((input.now - lastActivityAt) / 60_000))
          : null;
        const card: DashboardCardModel = {
          now: input.now,
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
          dormantCompletion: Boolean(input.dormantCompletionsBySession?.[tab.sessionId]),
          attentionCategory: category,
          group,
          status,
          stall,
          metadata,
          volatileMetadata,
          lastLog: input.lastLogBySession[tab.sessionId],
          lastActivityAt,
          label: getTabDisplayLabel(
            tab,
            tab.id === pane.activeTabId,
            input.metadataBySession,
            input.volatileMetadataBySession,
          ),
          agentKind: normalizeAgentKind(resolveTabMark(tab, volatileMetadata?.liveAgentKind, volatileMetadata?.ptyAlive === true)?.kind),
          mark: resolveTabMark(tab, volatileMetadata?.liveAgentKind, volatileMetadata?.ptyAlive === true),
          unobserved,
          neverStarted: !isWebTab && !brief && unobserved && !lastActivityAt && !attention?.attentionId,
          brief,
          delegationParent: tab.delegatedByTabId
            ? parentById.get(tab.delegatedByTabId) ?? input.delegationParents?.[tab.delegatedByTabId]
            : undefined,
          operationalState: brief?.operationalState,
          telemetryHealth: brief?.telemetryHealth,
          task: brief?.task ?? null,
          latestInstruction: brief?.latestInstruction ?? null,
          activityText: brief?.activityText ?? null,
          checkpoint: brief?.checkpoint ?? null,
          noUpdateMinutes: noUpdateMinutes(brief, input.now) ?? activityMinutes,
          telemetry: brief?.telemetry ?? null,
        };
        const markedAt = input.doneMarkByTab.get(tab.id);
        if (markedAt !== undefined && isManualDoneMarkValid(card, markedAt)) {
          card.manualDoneAt = markedAt;
        }
        cards.push(card);
      }
    }
  }
  return cards;
}

function compareWithinState(
  left: DashboardCardModel,
  right: DashboardCardModel,
  state: DashboardDisplayState,
): number {
  if (state === "needsHuman" || state === "error") {
    // 古いものから。待たせている時間が長いものほど先に人間の手が要る。
    return (left.attention?.occurrenceOrder ?? Number.MAX_SAFE_INTEGER) - (right.attention?.occurrenceOrder ?? Number.MAX_SAFE_INTEGER)
      || (right.noUpdateMinutes ?? 0) - (left.noUpdateMinutes ?? 0)
      || tieBreak(left, right);
  }
  if (state === "noUpdate") {
    return (right.noUpdateMinutes ?? 0) - (left.noUpdateMinutes ?? 0) || tieBreak(left, right);
  }
  if (state === "done" || state === "acknowledged") {
    return (right.attention?.occurrenceOrder ?? 0) - (left.attention?.occurrenceOrder ?? 0) || tieBreak(left, right);
  }
  return right.lastActivityAt - left.lastActivityAt || tieBreak(left, right);
}

/** 一本化順 (要対応順) / ワークスペース順のどちらかで並べ切った1本のリストを返す。 */
export function orderDashboardCards(
  cards: readonly DashboardCardModel[],
  sortMode: "attention" | "workspace",
): DashboardCardModel[] {
  const stateByTab = new Map(cards.map((card) => [card.tab.id, resolveDisplayState(card)] as const));
  const stateOf = (card: DashboardCardModel): DashboardDisplayState => stateByTab.get(card.tab.id) ?? "idle";
  return [...cards].sort((left, right) => {
    if (sortMode === "workspace" && left.workspaceIndex !== right.workspaceIndex) {
      return left.workspaceIndex - right.workspaceIndex;
    }
    const leftState = stateOf(left);
    const rightState = stateOf(right);
    return STATE_ORDER[leftState] - STATE_ORDER[rightState]
      || compareWithinState(left, right, leftState);
  });
}

/** 「次の要対応」は起点と同じ要回答・エラーを対象にする。 */
export function needsHumanCards(cards: readonly DashboardCardModel[]): DashboardCardModel[] {
  return orderDashboardCards(
    cards.filter(needsDashboardAttention),
    "attention",
  );
}

/** Count-pill urgency filters use the same targets as keyboard navigation. */
export function matchesDashboardStateFilter(card: DashboardCardModel, stateFilter: DashboardStateFilter | null | undefined): boolean {
  if (!stateFilter) return true;
  const state = resolveDisplayState(card);
  return stateFilter === "needsHuman"
    ? needsDashboardAttention(card)
    : stateFilter === "done"
      ? state === "done" || state === "acknowledged"
      : state === stateFilter;
}

/** Attention targets, working sessions, and deferred sessions stay disjoint. */
export function partitionDashboardCards(cards: readonly DashboardCardModel[]): {
  needsHuman: DashboardCardModel[];
  active: DashboardCardModel[];
  deferred: DashboardCardModel[];
} {
  const needsHuman: DashboardCardModel[] = [];
  const active: DashboardCardModel[] = [];
  const deferred: DashboardCardModel[] = [];
  for (const card of cards) {
    const state = resolveDisplayState(card);
    if (needsDashboardAttention(card)) needsHuman.push(card);
    else if (state === "running" || state === "noUpdate") active.push(card);
    else deferred.push(card);
  }
  return { needsHuman, active, deferred };
}

/** ヘッダの visinfo 1本目 (`Nペイン · Mタブ · Kワークスペース`) の内訳。 */
export function applyDashboardFilters(cards: readonly DashboardCardModel[], filters: DashboardFilters): DashboardCardModel[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return cards.filter((card) => {
    if (filters.workspaceId && card.workspaceId !== filters.workspaceId) return false;
    if (!matchesDashboardStateFilter(card, filters.stateFilter)) return false;
    if (filters.needsHumanOnly) {
      if (!needsDashboardAttention(card)) return false;
    }
    if (filters.agentKind && card.agentKind !== filters.agentKind) return false;
    if (!query) return true;
    const searchable = [
      card.workspace.name,
      card.label,
      card.metadata?.cwd ?? "",
      card.lastLog ?? "",
      card.task ?? "",
      card.latestInstruction ?? "",
      card.activityText ?? "",
      attentionDetail(card.attention) ?? "",
    ].join("\n").toLocaleLowerCase();
    return searchable.includes(query);
  });
}
