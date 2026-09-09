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
} from "../../stores/sessionAttentionStore";
import { resolveTabMark, type TabMark } from "../../lib/tabMark";
import type { Pane, PaneTab, Workspace } from "../../types";
import { noUpdateMinutes } from "./liveTimelineModel";

export type DashboardGroup = "waiting" | "stalled" | "done" | "working" | "idle";
export type DashboardStatus = DashboardGroup | "error" | "unobserved";
export type DashboardAgentKind = "claude" | "codex" | "claude-codex" | "grok" | "none";

/**
 * 画面に出す1本化した状態。カードのグリッド時代の group/section を置き換える。
 * livebrief が生きている間はそちらが正、そうでなければ attention/stall/metadata へ落ちる。
 */
export type DashboardDisplayState = "needsHuman" | "error" | "running" | "noUpdate" | "done" | "acknowledged" | "idle" | "stopped";
export type DashboardStateFilter = "needsHuman" | "running" | "noUpdate" | "done";

/** 「更新なし」と言い切るまでの猶予 (分)。 */
export const NO_UPDATE_THRESHOLD_MINUTES = 5;

export interface DashboardCardModel {
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
  /** 一度も開いていないタブ。telemetry も端末バッファも活動記録も無い状態だけを指す。 */
  neverStarted: boolean;
  // --- livebrief 由来 (telemetryHealth === "live" のときだけ意味がある) ---
  brief?: LiveSessionBrief;
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
  seenAttentionByTab: Map<string, string>;
  doneMarkByTab: Map<string, number>;
  stallsBySession: Record<string, StallEntry | undefined>;
  briefsBySession?: Record<string, LiveSessionBrief | undefined>;
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
 * brief の各時刻は noUpdateMinutes の基準になり得るため、どれも比較対象にする。
 */
export function isManualDoneMarkValid(card: DashboardCardModel, markedAt: number): boolean {
  if (!Number.isFinite(markedAt)) return false;
  const activityTimes = [
    finiteTimestamp(card.lastActivityAt),
    finiteTimestamp(card.attention?.stateSince),
    finiteTimestamp(card.brief?.lastEventAt),
    finiteTimestamp(card.brief?.lastSuccessfulReadAt),
    finiteTimestamp(card.brief?.updatedAt),
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
    if ((card.noUpdateMinutes ?? 0) >= NO_UPDATE_THRESHOLD_MINUTES) return "noUpdate";
    if (card.operationalState === "running") return "running";
    if (card.attentionCategory === "done") return "done";
    return "idle";
  }
  if (card.attentionCategory === "waiting") return "needsHuman";
  if (card.attentionCategory === "error") return "error";
  if (card.attentionCategory === "done") return "done";
  if (card.telemetryHealth === "ended" || card.stall?.reason === "pty_dead") return "stopped";
  // まだ一度も開いていないタブに「更新なし」「作業中」を貼らない (未起動はバッジで出す)。
  if (card.neverStarted) return "idle";
  if (card.stall) return "noUpdate";
  // まだ一度も動いていないタブを「更新なし」と言い切らない。
  if (!card.lastActivityAt) return "idle";
  return card.group === "idle" ? "noUpdate" : "running";
}

export function buildDashboardCards(workspaces: readonly Workspace[], input: DashboardModelInput): DashboardCardModel[] {
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
          volatileMetadata,
          lastLog: input.lastLogBySession[tab.sessionId],
          lastActivityAt,
          label: getTabDisplayLabel(
            tab,
            tab.id === pane.activeTabId,
            input.metadataBySession,
            input.volatileMetadataBySession,
          ),
          agentKind: normalizeAgentKind(metadata?.agentKind ?? tab.agentKind),
          mark: resolveTabMark(tab, metadata?.agentKind),
          unobserved,
          neverStarted: !isWebTab && !brief && unobserved && !lastActivityAt,
          brief,
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

/** 「要対応」セクションの中身。人間入力待ちとエラーだけを古い順に。 */
export function needsHumanCards(cards: readonly DashboardCardModel[]): DashboardCardModel[] {
  return orderDashboardCards(
    cards.filter((card) => {
      const state = resolveDisplayState(card);
      return state === "needsHuman" || state === "error";
    }),
    "attention",
  );
}

/** Count-pill filters map "要対応" to both human-input and error states. */
export function matchesDashboardStateFilter(card: DashboardCardModel, stateFilter: DashboardStateFilter | null | undefined): boolean {
  if (!stateFilter) return true;
  const state = resolveDisplayState(card);
  return stateFilter === "needsHuman"
    ? state === "needsHuman" || state === "error"
    : stateFilter === "done"
      ? state === "done" || state === "acknowledged"
      : state === stateFilter;
}

/** The primary list stays focused; completed, idle, and never-started cards live behind one disclosure. */
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
    if (state === "needsHuman" || state === "error") needsHuman.push(card);
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
      const state = resolveDisplayState(card);
      if (state !== "needsHuman" && state !== "error") return false;
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
