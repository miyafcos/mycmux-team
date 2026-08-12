import type { LiveSessionBrief } from "../../lib/livebrief";
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
import { noUpdateMinutes } from "./liveTimelineModel";

export type DashboardGroup = "waiting" | "stalled" | "done" | "working" | "idle";
export type DashboardStatus = DashboardGroup | "error" | "unobserved";
export type DashboardAgentKind = "claude" | "codex" | "claude-codex" | "none";

/**
 * 画面に出す1本化した状態。カードのグリッド時代の group/section を置き換える。
 * livebrief が生きている間はそちらが正、そうでなければ attention/stall/metadata へ落ちる。
 */
export type DashboardDisplayState = "needsHuman" | "error" | "running" | "noUpdate" | "done" | "idle";

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
  group: DashboardGroup;
  status: DashboardStatus;
  stall?: StallEntry;
  metadata?: PaneMetadata;
  lastLog?: string;
  lastActivityAt: number;
  label: string;
  agentKind: DashboardAgentKind;
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
}

export interface DashboardModelInput {
  metadataBySession: Record<string, PaneMetadata | undefined>;
  lastLogBySession: Record<string, string | undefined>;
  lastLogAtBySession: Record<string, number | undefined>;
  attentionBySession: Record<string, SessionAttention | undefined>;
  seenAttentionByTab: Map<string, string>;
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
}

/** 一本化した並び順: 人間入力待ち > エラー > 実行中 > 更新なし > 待機 > 完了。 */
const STATE_ORDER: Record<DashboardDisplayState, number> = {
  needsHuman: 0,
  error: 1,
  running: 2,
  noUpdate: 3,
  idle: 4,
  done: 5,
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
  if (now - lastActivityAt <= NO_UPDATE_THRESHOLD_MINUTES * 60_000) return "working";
  return "idle";
}

/**
 * livebrief が「生きている」と言える間はそれを正とし、そうでなければ
 * 従来の attention / stall / metadata 判定へ落とす。断定できないものは idle。
 */
export function resolveDisplayState(card: DashboardCardModel): DashboardDisplayState {
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
  // まだ一度も開いていないタブに「更新なし」「作業中」を貼らない (未起動はバッジで出す)。
  if (card.neverStarted) return "idle";
  if (card.stall) return "noUpdate";
  if (card.attentionCategory === "done") return "done";
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
        const attention = input.attentionBySession[tab.sessionId];
        const category = attentionCategory(tab.id, attention, input.seenAttentionByTab);
        const stall = input.stallsBySession[tab.sessionId];
        const brief = input.briefsBySession?.[tab.sessionId];
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
        const activityMinutes = lastActivityAt
          ? Math.max(0, Math.floor((input.now - lastActivityAt) / 60_000))
          : null;
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
          neverStarted: !brief && unobserved && !lastActivityAt,
          brief,
          operationalState: brief?.operationalState,
          telemetryHealth: brief?.telemetryHealth,
          task: brief?.task ?? null,
          latestInstruction: brief?.latestInstruction ?? null,
          activityText: brief?.activityText ?? null,
          checkpoint: brief?.checkpoint ?? null,
          noUpdateMinutes: noUpdateMinutes(brief, input.now) ?? activityMinutes,
        });
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
  if (state === "done") {
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

/** カウントチップ用の内訳。要対応にはエラーも数える (どちらも人間の手が要る)。 */
export function countByDisplayState(cards: readonly DashboardCardModel[]): Record<DashboardDisplayState, number> {
  const counts: Record<DashboardDisplayState, number> = {
    needsHuman: 0,
    error: 0,
    running: 0,
    noUpdate: 0,
    idle: 0,
    done: 0,
  };
  for (const card of cards) counts[resolveDisplayState(card)] += 1;
  return counts;
}

/** ヘッダの visinfo 1本目 (`Nペイン · Mタブ · Kワークスペース`) の内訳。 */
export interface DashboardStructureCounts {
  panes: number;
  tabs: number;
  workspaces: number;
}

/**
 * 表示用の総数。ペイン = レイアウト上の区画、タブ = その中のセッション。
 * カード1枚 = タブ1本なので、tabs はカード総数と一致する。
 */
export function countWorkspaceStructure(workspaces: readonly Workspace[]): DashboardStructureCounts {
  let panes = 0;
  let tabs = 0;
  for (const workspace of workspaces) {
    panes += workspace.panes.length;
    for (const pane of workspace.panes) tabs += pane.tabs.length;
  }
  return { panes, tabs, workspaces: workspaces.length };
}

/** ヘッダの visinfo 2本目 (`表示中 N / 裏で稼働 M`)。端末バッファを持つ数が「表示中」。 */
export function countVisibility(cards: readonly DashboardCardModel[]): { visible: number; background: number } {
  const visible = cards.reduce((total, card) => total + (card.unobserved ? 0 : 1), 0);
  return { visible, background: cards.length - visible };
}

export function applyDashboardFilters(cards: readonly DashboardCardModel[], filters: DashboardFilters): DashboardCardModel[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return cards.filter((card) => {
    if (filters.workspaceId && card.workspaceId !== filters.workspaceId) return false;
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
