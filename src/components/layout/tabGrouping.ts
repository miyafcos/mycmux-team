import { v4 as uuid } from "uuid";

import type { PtyMetadataSnapshot, SessionOutputSnapshot } from "../../lib/ipc";
import { reconcileSplitColumnsForPanes } from "../../lib/layoutColumns";
import type { PaneMetadata } from "../../stores/paneMetadataStore";
import { usePetSettingsStore } from "../../stores/petSettingsStore";
import type { Pane, PaneTab, Workspace } from "../../types";
import { aiProviderDef, type AiProviderId } from "../../lib/aiModels";
import { aiSettingsStrings } from "../settings/settingsStrings";
import {
  isIgnoredPromptDecoration,
  TAB_NAMING_TAIL_LINES,
} from "./tabSweep";
import { processStatusReasonForTab, readPaneTail } from "./socketCommands";

export const TAB_GROUPING_TAIL_LINES = TAB_NAMING_TAIL_LINES;
export const TAB_GROUPING_OPEN_EVENT = "mycmux:tab-grouping-open" as const;
export const TAB_GROUPING_NAME_MAX = 20;
export const TAB_GROUPING_MAX_COLUMNS = 4;
export const TAB_GROUPING_MAX_PANES_PER_COLUMN = 4;
export const TAB_GROUPING_PLAN_MIN = 2;
export const TAB_GROUPING_PLAN_MAX = 3;

export type GroupingStrategy = "project" | "role" | "minimal_move" | "mixed";
export type GroupingDisposition = "reorganize" | "keep";
export type GroupingPaneRole = "mother" | "worker" | "review" | "mixed" | "unspecified";
export type GroupingWarningCode =
  | "LOW_CONFIDENCE"
  | "MIXED_PROJECT"
  | "UNCLEAR_ROLE"
  | "EXISTING_WORKSPACE_CONFLICT";

export type GroupingDestination =
  | { kind: "new_workspace"; proposedName: string }
  | { kind: "existing_workspace"; workspaceId: string }
  | { kind: "current_locations" };

export interface GroupingLayoutPane {
  title: string;
  role: GroupingPaneRole;
  tabIds: string[];
}

export interface GroupingLayoutColumn {
  panes: GroupingLayoutPane[];
}

export interface GroupingLayout {
  columns: GroupingLayoutColumn[];
}

export interface GroupingWarning {
  code: GroupingWarningCode;
  tabIds: string[];
  message: string;
}

export interface GroupingGroup {
  groupId: string;
  title: string;
  disposition: GroupingDisposition;
  destination: GroupingDestination;
  layout: GroupingLayout | null;
  tabIds: string[];
  adopted: boolean;
}

export interface GroupingPlan {
  planId: string;
  title: string;
  rationale: string;
  strategy: GroupingStrategy;
  groups: GroupingGroup[];
  unassignedTabIds: string[];
  warnings: GroupingWarning[];
}

export interface GroupingTab {
  id: string;
  sessionId: string;
  label: string;
  labelSource?: PaneTab["labelSource"];
  cwd: string;
  agentKind: string;
  origin?: PaneTab["origin"];
  workspaceId: string;
  workspaceName: string;
  paneId: string;
  column: number;
  lastOutputAt: number | null;
  tail: string[];
}

export interface GroupingLineageCluster {
  clusterId: string;
  tabIds: string[];
}

export interface AnalysisBaselineEntry {
  tabId: string;
  workspaceId: string;
  paneId: string;
  sessionId: string;
}

export interface GroupingScan {
  scannedAt: number;
  tabs: GroupingTab[];
  lineageClusters: GroupingLineageCluster[];
  baseline: AnalysisBaselineEntry[];
  workspaceIds: string[];
  workspaces: Workspace[];
}

export interface GroupingScanSource {
  workspaces: Workspace[];
  metadata: Record<string, PaneMetadata>;
  processMetadata: PtyMetadataSnapshot;
  processMetadataAvailable: boolean;
  lastOutputBySession: SessionOutputSnapshot;
  readTail: (sessionId: string, lines: number) => Promise<string[]>;
  now: number;
}

export interface ParseIssue {
  scope: "response" | "plan";
  planId?: string;
  reason: string;
}

export type ParseGroupingResult =
  | {
    status: "invalid";
    reason: string;
    issues: ParseIssue[];
    raw: string;
    validPlans: GroupingPlan[];
  }
  | {
    status: "ok";
    plans: GroupingPlan[];
    droppedPlans: ParseIssue[];
    comparisonInsufficient: boolean;
    raw: string;
  };

export type StaleCode = "tab_closed" | "session_mismatch" | "tab_moved" | "workspace_missing";

export interface StaleIssue {
  code: StaleCode;
  tabId?: string;
  workspaceId?: string;
  message: string;
}

export interface TabLocation {
  workspaceId: string;
  paneId: string;
  sessionId: string;
}

export interface GroupingExpectedResult {
  tabs: Record<string, TabLocation>;
  movedTabIds: string[];
  keptTabIds: string[];
  unassignedTabIds: string[];
  emptyWorkspaceIds: string[];
  newWorkspaceIds: string[];
  focusWorkspaceId: string | null;
  focusSessionId: string | null;
  focusTabId: string | null;
  splitColumns: Record<string, string[][]>;
  activeTabs: Record<string, { paneId: string; tabId: string; sessionId: string }>;
}

export interface LayoutTransaction {
  workspaces: Workspace[];
  expected: GroupingExpectedResult;
}

export interface GroupingApplyReport {
  moved: Array<{ tabId: string; from: TabLocation; to: TabLocation; label: string }>;
  kept: Array<{ tabId: string; location: TabLocation; label: string }>;
  unassigned: Array<{ tabId: string; location: TabLocation; label: string }>;
  blocked: StaleIssue[];
  errors: string[];
  emptyWorkspaceIds: string[];
  emptyWorkspaceNames: string[];
}


export type TabPreviewKind = "moved" | "kept" | "unassigned" | "untouched";

const STRATEGIES = new Set<GroupingStrategy>(["project", "role", "minimal_move", "mixed"]);
const ROLES = new Set<GroupingPaneRole>(["mother", "worker", "review", "mixed", "unspecified"]);
const WARNING_CODES = new Set<GroupingWarningCode>([
  "LOW_CONFIDENCE",
  "MIXED_PROJECT",
  "UNCLEAR_ROLE",
  "EXISTING_WORKSPACE_CONFLICT",
]);
const GROUPING_NAME = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Za-z0-9０-９ー・々〆〇+\s]+$/u;
const GENERIC_ENGLISH_WORDS = new Set([
  "fix", "build", "review", "server", "worker", "test", "debug", "update",
  "refactor", "implement", "close", "open", "move", "group", "plan", "mixed",
  "project", "role", "mother", "work", "task", "file", "folder",
]);

function isTerminalTab(tab: PaneTab): boolean {
  return tab.type === undefined || tab.type === "terminal";
}

function isDeadReason(reason: string | null): boolean {
  return reason === "no_live_pty_session" || reason === "snapshot_unavailable";
}

function isDeclared(tab: PaneTab): boolean {
  return tab.lifecycle === "declared";
}

export function isJapaneseGroupingName(value: string, maxLength = TAB_GROUPING_NAME_MAX): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if ([...trimmed].length > maxLength) return false;
  if (!GROUPING_NAME.test(trimmed)) return false;
  const tokens = trimmed.split(/[\s+]+/u).filter(Boolean);
  return !tokens.some((token) => (
    /^[A-Za-z]+$/.test(token) && GENERIC_ENGLISH_WORDS.has(token.toLowerCase())
  ));
}

function cleanedTail(lines: readonly string[]): string[] {
  return lines
    .filter((line) => !isIgnoredPromptDecoration(line))
    .slice(-TAB_GROUPING_TAIL_LINES);
}


export function choosePetForNewWorkspace(): string | undefined {
  const petSettings = usePetSettingsStore.getState();
  const enabledPets = petSettings.pets.filter((pet) => !petSettings.petDisabled.includes(pet.id));
  const fallbackPet = enabledPets[0]?.id ?? "clawd";
  if (petSettings.petNewWorkspaceMode === "choose") return undefined;
  if (petSettings.petNewWorkspaceMode === "fixed") {
    return petSettings.petFixedId && enabledPets.some((pet) => pet.id === petSettings.petFixedId)
      ? petSettings.petFixedId
      : fallbackPet;
  }
  return enabledPets[Math.floor(Math.random() * enabledPets.length)]?.id ?? fallbackPet;
}


export function layoutSignature(workspaces: readonly Workspace[]): string {
  return JSON.stringify(workspaces.map((workspace) => ({
    id: workspace.id,
    name: workspace.name,
    splitColumns: workspace.splitColumns ?? [],
    columnWidths: workspace.columnWidths ?? [],
    rowHeightsPerCol: workspace.rowHeightsPerCol ?? [],
    panes: workspace.panes.map((pane) => ({
      id: pane.id,
      tabs: pane.tabs.map((tab) => ({
        id: tab.id,
        sessionId: tab.sessionId,
        label: tab.label ?? "",
      })),
    })),
  })));
}


function tabIndex(workspaces: readonly Workspace[]): Map<string, { workspace: Workspace; pane: Pane; tab: PaneTab }> {
  const result = new Map<string, { workspace: Workspace; pane: Pane; tab: PaneTab }>();
  for (const workspace of workspaces) {
    for (const pane of workspace.panes) {
      for (const tab of pane.tabs) {
        result.set(tab.id, { workspace, pane, tab });
      }
    }
  }
  return result;
}

export function findTabLocation(workspaces: readonly Workspace[], tabId: string): TabLocation | null {
  for (const workspace of workspaces) {
    for (const pane of workspace.panes) {
      const tab = pane.tabs.find((candidate) => candidate.id === tabId);
      if (tab) {
        return { workspaceId: workspace.id, paneId: pane.id, sessionId: tab.sessionId };
      }
    }
  }
  return null;
}


function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function lineageClustersFromTabs(tabs: readonly GroupingTab[]): GroupingLineageCluster[] {
  const parent = new Map<string, string>();
  const ensure = (id: string): string => {
    if (!parent.has(id)) parent.set(id, id);
    return id;
  };
  const find = (id: string): string => {
    ensure(id);
    const current = parent.get(id) ?? id;
    if (current !== id) {
      const root = find(current);
      parent.set(id, root);
      return root;
    }
    return id;
  };
  const union = (left: string, right: string) => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent.set(a, b);
  };

  const liveIds = new Set(tabs.map((tab) => tab.id));
  for (const tab of tabs) {
    ensure(tab.id);
    const parentTabId = tab.origin?.kind === "agent" ? tab.origin.parentTabId : undefined;
    if (parentTabId && liveIds.has(parentTabId)) union(tab.id, parentTabId);
  }

  const groups = new Map<string, string[]>();
  for (const tab of tabs) {
    const root = find(tab.id);
    const list = groups.get(root) ?? [];
    list.push(tab.id);
    groups.set(root, list);
  }

  return [...groups.values()]
    .map((tabIds) => [...tabIds].sort())
    .filter((tabIds) => tabIds.length > 1)
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map((tabIds, index) => ({
      clusterId: `lineage-${index + 1}`,
      tabIds,
    }));
}

async function loadDefaultGroupingSource(now = Date.now()): Promise<GroupingScanSource> {
  const [stores, ipc] = await Promise.all([
    import("../../stores/workspaceStore"),
    import("../../lib/ipc"),
  ]);
  let processMetadata: PtyMetadataSnapshot = {};
  let processMetadataAvailable = true;
  try {
    processMetadata = await ipc.getPtyMetadataSnapshot();
  } catch {
    processMetadataAvailable = false;
  }
  let lastOutputBySession: SessionOutputSnapshot = {};
  try {
    lastOutputBySession = await ipc.getSessionOutputSnapshot();
  } catch {
    // Activity timestamps are optional for grouping.
  }
  return {
    workspaces: stores.useWorkspaceListStore.getState().workspaces,
    metadata: stores.usePaneMetadataStore.getState().metadata,
    processMetadata,
    processMetadataAvailable,
    lastOutputBySession,
    readTail: readPaneTail,
    now,
  };
}

export async function scanGroupingContext(
  providedSource?: GroupingScanSource,
): Promise<GroupingScan> {
  const source = providedSource ?? await loadDefaultGroupingSource();
  const tabs: GroupingTab[] = [];

  for (const workspace of source.workspaces) {
    const paneById = new Map(workspace.panes.map((pane) => [pane.id, pane]));
    const columns = reconcileSplitColumnsForPanes(
      workspace.splitColumns,
      workspace.panes.map((pane) => pane.id),
    );
    for (const [columnIndex, paneIds] of columns.entries()) {
      for (const paneId of paneIds) {
        const pane = paneById.get(paneId);
        if (!pane) continue;
        for (const tab of pane.tabs) {
          if (!isTerminalTab(tab) || isDeclared(tab)) continue;
          const reason = processStatusReasonForTab(
            tab.type,
            source.processMetadata[tab.sessionId],
            source.processMetadataAvailable,
          );
          if (isDeadReason(reason)) continue;
          let tail: string[] = [];
          try {
            tail = cleanedTail(await source.readTail(tab.sessionId, TAB_GROUPING_TAIL_LINES));
          } catch {
            tail = [];
          }
          const metadata = source.metadata[tab.sessionId];
          tabs.push({
            id: tab.id,
            sessionId: tab.sessionId,
            label: tab.label ?? "",
            labelSource: tab.labelSource,
            cwd: tab.cwd ?? pane.cwd ?? metadata?.cwd ?? "",
            agentKind: tab.agentKind ?? pane.agentKind ?? metadata?.agentKind ?? "",
            origin: tab.origin,
            workspaceId: workspace.id,
            workspaceName: workspace.name,
            paneId: pane.id,
            column: columnIndex + 1,
            lastOutputAt: source.lastOutputBySession[tab.sessionId] ?? null,
            tail,
          });
        }
      }
    }
  }

  return {
    scannedAt: source.now,
    tabs,
    lineageClusters: lineageClustersFromTabs(tabs),
    baseline: tabs.map((tab) => ({
      tabId: tab.id,
      workspaceId: tab.workspaceId,
      paneId: tab.paneId,
      sessionId: tab.sessionId,
    })),
    workspaceIds: source.workspaces.map((workspace) => workspace.id),
    workspaces: source.workspaces,
  };
}

export function buildGroupingPrompt(scan: GroupingScan): string {
  const payload = {
    tabs: scan.tabs.map((tab) => ({
      id: tab.id,
      sessionId: tab.sessionId,
      label: tab.label,
      labelSource: tab.labelSource ?? "user",
      cwd: tab.cwd,
      agentKind: tab.agentKind,
      origin: tab.origin ?? { kind: "human" },
      workspaceId: tab.workspaceId,
      workspaceName: tab.workspaceName,
      paneId: tab.paneId,
      column: tab.column,
      lastOutputAt: tab.lastOutputAt,
      tail: tab.tail.slice(-TAB_GROUPING_TAIL_LINES),
    })),
    workspaces: scan.workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      paneIds: workspace.panes.map((pane) => pane.id),
    })),
    lineageClusters: scan.lineageClusters,
  };
  return [
    "次の全ワークスペースの生きているターミナルタブを、案件・役割ごとに再配置するプランを2〜3件作ってください。",
    "切り口の異なる案を並べてください。strategy は project / role / minimal_move / mixed のいずれかです。",
    "タブは閉じません。PTY も殺しません。配置（ワークスペース・ペイン）だけを設計してください。",
    "origin.parentTabId でつながる系譜クラスタは、特別な理由がなければ同じグループに残してください。",
    "ワークスペースは案件の厳密な境界ではなく、見渡す場所です。1案件=1ワークスペースに機械的に割らないでください。",
    "目安は1ワークスペースあたり3〜8タブです。小さな案件は最大3件まで同じワークスペースにまとめ、列で分け、グループ名は「国語課+雑務」のように両方を書いてください。大きな案件だけ独立したワークスペースにしてください。",
    "どの strategy の案も、この見やすいサイズを守ってください。",
    "名前は日本語が基本です。固有名詞（mycmux / Claude / Codex など）はアルファベットのままで構いません。fix / build / review / server のような一般英単語は日本語にしてください。ツール名をカタカナへ無理に直さないでください。短く（目安20文字以内）。",
    "pane.role は mother / worker / review / mixed / unspecified のみです。warnings は {code, tabIds, message} の配列で、code は LOW_CONFIDENCE / MIXED_PROJECT / UNCLEAR_ROLE / EXISTING_WORKSPACE_CONFLICT のみです。",
    "各プランで、渡した全タブが groups または unassignedTabIds のどこかに正確に1回だけ現れるようにしてください。",
    "disposition=keep のグループは destination.kind を current_locations、layout を null にし、残すタブを tabIds に列挙してください。",
    "disposition=reorganize のグループは layout を必須にし、空の列・空のペインは禁止です。列は最大4、1列あたりペインは最大4です。",
    "既存ワークスペースへの合流は、既存タブを動かさず末尾に新しい列を足す前提で書いてください。",
    "出力は JSON オブジェクトのみです。コードフェンス、説明文、末尾の感想は禁止です。",
    '形式: {"schemaVersion":1,"plans":[{"planId":"...","title":"...","rationale":"...","strategy":"project","groups":[{"groupId":"...","title":"...","disposition":"reorganize","destination":{"kind":"new_workspace","proposedName":"..."},"layout":{"columns":[{"panes":[{"title":"...","role":"mother","tabIds":["..."]}]}]},"tabIds":["..."]}],"unassignedTabIds":[],"warnings":[]}]}',
    JSON.stringify(payload),
  ].join("\n");
}

export function formatGroupingAiNote(provider: AiProviderId, model: string, enabled: boolean): string {
  if (!enabled) return aiSettingsStrings.disabledReason;
  const target = `${aiProviderDef(provider).label} (${model})`;
  return `全ワークスペースの画面末尾${TAB_GROUPING_TAIL_LINES}行・作業フォルダ・系譜を ${target} に送って再配置案を作ります（適用前に編集できます）`;
}

function uniqueStrings(values: readonly string[], label: string): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    if (!value.trim()) return `${label}が空です`;
    if (seen.has(value)) return `${label}が重複しています: ${value}`;
    seen.add(value);
  }
  return null;
}

function flattenLayoutTabIds(layout: GroupingLayout): string[] {
  return layout.columns.flatMap((column) => column.panes.flatMap((pane) => pane.tabIds));
}

function parseDestination(value: unknown): GroupingDestination | string {
  if (!isObject(value) || typeof value.kind !== "string") return "destination が不正です";
  if (value.kind === "new_workspace") {
    const proposedName = asString(value.proposedName)?.trim() ?? "";
    if (!isJapaneseGroupingName(proposedName)) return "新ワークスペース名が不正です";
    return { kind: "new_workspace", proposedName };
  }
  if (value.kind === "existing_workspace") {
    const workspaceId = asString(value.workspaceId)?.trim() ?? "";
    if (!workspaceId) return "existing_workspace の workspaceId が空です";
    return { kind: "existing_workspace", workspaceId };
  }
  if (value.kind === "current_locations") return { kind: "current_locations" };
  return `未知の destination.kind: ${value.kind}`;
}

function parseLayout(value: unknown): GroupingLayout | string {
  if (!isObject(value) || !Array.isArray(value.columns)) return "layout.columns が配列ではありません";
  if (value.columns.length === 0) return "空の列は禁止です";
  if (value.columns.length > TAB_GROUPING_MAX_COLUMNS) return "列数が上限を超えています";
  const columns: GroupingLayoutColumn[] = [];
  for (const columnValue of value.columns) {
    if (!isObject(columnValue) || !Array.isArray(columnValue.panes)) return "layout の列が不正です";
    if (columnValue.panes.length === 0) return "空の列は禁止です";
    if (columnValue.panes.length > TAB_GROUPING_MAX_PANES_PER_COLUMN) return "1列あたりのペイン数が上限を超えています";
    const panes: GroupingLayoutPane[] = [];
    for (const paneValue of columnValue.panes) {
      if (!isObject(paneValue)) return "layout のペインが不正です";
      const title = asString(paneValue.title)?.trim() ?? "";
      if (!isJapaneseGroupingName(title)) return "ペイン名が不正です";
      if (typeof paneValue.role !== "string" || !ROLES.has(paneValue.role as GroupingPaneRole)) {
        return "pane.role が不正です";
      }
      if (!Array.isArray(paneValue.tabIds) || paneValue.tabIds.length === 0) return "空のペインは禁止です";
      if (paneValue.tabIds.some((id) => typeof id !== "string" || !id.trim())) return "pane.tabIds が不正です";
      panes.push({
        title,
        role: paneValue.role as GroupingPaneRole,
        tabIds: paneValue.tabIds.map((id) => String(id).trim()),
      });
    }
    columns.push({ panes });
  }
  return { columns };
}

function parseWarnings(value: unknown, allowedTabIds: ReadonlySet<string>): GroupingWarning[] | string {
  if (!Array.isArray(value)) return "warnings が配列ではありません";
  const warnings: GroupingWarning[] = [];
  for (const entry of value) {
    if (!isObject(entry)) return "warning が不正です";
    if (typeof entry.code !== "string" || !WARNING_CODES.has(entry.code as GroupingWarningCode)) {
      return "warning.code が不正です";
    }
    if (typeof entry.message !== "string") return "warning.message が不正です";
    if (!Array.isArray(entry.tabIds) || entry.tabIds.some((id) => typeof id !== "string")) {
      return "warning.tabIds が不正です";
    }
    const tabIds = entry.tabIds.map((id) => id.trim());
    if (tabIds.some((id) => !allowedTabIds.has(id))) return "warning が未知のタブを参照しています";
    warnings.push({
      code: entry.code as GroupingWarningCode,
      tabIds,
      message: entry.message,
    });
  }
  return warnings;
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function parseGroup(
  value: unknown,
  allowedTabIds: ReadonlySet<string>,
  existingWorkspaceIds: ReadonlySet<string>,
): GroupingGroup | string {
  if (!isObject(value)) return "group が不正です";
  const groupId = asString(value.groupId)?.trim() ?? "";
  const title = asString(value.title)?.trim() ?? "";
  if (!groupId) return "groupId が空です";
  if (!isWellFormedUnicode(groupId)) return "groupId の Unicode が不正です";
  if (!isJapaneseGroupingName(title)) return "グループ名が不正です";
  if (value.disposition !== "reorganize" && value.disposition !== "keep") return "disposition が不正です";
  const destination = parseDestination(value.destination);
  if (typeof destination === "string") return destination;

  if (value.disposition === "keep") {
    if (destination.kind !== "current_locations") return "keep グループは current_locations である必要があります";
    if (value.layout !== null) return "keep グループの layout は null である必要があります";
    if (!Array.isArray(value.tabIds) || value.tabIds.length === 0) return "keep グループの tabIds が空です";
    if (value.tabIds.some((id) => typeof id !== "string" || !id.trim())) return "keep グループの tabIds が不正です";
    const tabIds = value.tabIds.map((id) => id.trim());
    if (tabIds.some((id) => !allowedTabIds.has(id))) return "keep グループが未知のタブを含みます";
    return {
      groupId,
      title,
      disposition: "keep",
      destination,
      layout: null,
      tabIds,
      adopted: true,
    };
  }

  if (destination.kind === "current_locations") return "reorganize グループに current_locations は使えません";
  if (destination.kind === "existing_workspace" && !existingWorkspaceIds.has(destination.workspaceId)) {
    return "存在しないワークスペースへの合流です";
  }
  const layout = parseLayout(value.layout);
  if (typeof layout === "string") return layout;
  const tabIds = flattenLayoutTabIds(layout);
  if (tabIds.some((id) => !allowedTabIds.has(id))) return "layout が未知のタブを含みます";
  if (value.tabIds !== undefined) {
    if (!Array.isArray(value.tabIds) || value.tabIds.some((id) => typeof id !== "string" || !id.trim())) {
      return "group.tabIds が不正です";
    }
    const explicit = value.tabIds.map((id) => id.trim());
    if ([...explicit].sort().join("\0") !== [...tabIds].sort().join("\0")) {
      return "group.tabIds と layout のタブが一致しません";
    }
  }
  return {
    groupId,
    title,
    disposition: "reorganize",
    destination,
    layout,
    tabIds,
    adopted: true,
  };
}

function parsePlan(
  value: unknown,
  allowedTabIds: ReadonlySet<string>,
  existingWorkspaceIds: ReadonlySet<string>,
  existingWorkspaceNames: ReadonlySet<string>,
): GroupingPlan | string {
  if (!isObject(value)) return "plan が不正です";
  const planId = asString(value.planId)?.trim() ?? "";
  const title = asString(value.title)?.trim() ?? "";
  if (typeof value.rationale !== "string") return "rationale が不正です";
  const rationale = value.rationale;
  if (!planId) return "planId が空です";
  if (!isJapaneseGroupingName(title)) return "プラン名が不正です";
  if (typeof value.strategy !== "string" || !STRATEGIES.has(value.strategy as GroupingStrategy)) {
    return "strategy が不正です";
  }
  if (!Array.isArray(value.groups) || value.groups.length === 0) return "groups が空です";
  const groups: GroupingGroup[] = [];
  for (const groupValue of value.groups) {
    const group = parseGroup(groupValue, allowedTabIds, existingWorkspaceIds);
    if (typeof group === "string") return group;
    groups.push(group);
  }
  const groupIdError = uniqueStrings(groups.map((group) => group.groupId), "groupId");
  if (groupIdError) return groupIdError;
  const newNames = groups.flatMap((group) => (
    group.destination.kind === "new_workspace" ? [group.destination.proposedName] : []
  ));
  const nameError = uniqueStrings(newNames, "新ワークスペース名");
  if (nameError) return nameError;
  const conflict = newNames.find((name) => existingWorkspaceNames.has(name));
  if (conflict) return `新ワークスペース名が既存名と衝突しています: ${conflict}`;

  if (!Array.isArray(value.unassignedTabIds)) return "unassignedTabIds が配列ではありません";
  if (value.unassignedTabIds.some((id) => typeof id !== "string" || !id.trim())) {
    return "unassignedTabIds が不正です";
  }
  const unassignedTabIds = value.unassignedTabIds.map((id) => id.trim());
  if (unassignedTabIds.some((id) => !allowedTabIds.has(id))) return "unassignedTabIds が未知のタブを含みます";

  const appearances = new Map<string, number>();
  const note = (id: string) => appearances.set(id, (appearances.get(id) ?? 0) + 1);
  for (const group of groups) group.tabIds.forEach(note);
  unassignedTabIds.forEach(note);
  for (const id of allowedTabIds) {
    if ((appearances.get(id) ?? 0) !== 1) return `タブ ${id} の出現回数が1ではありません`;
  }
  for (const id of appearances.keys()) {
    if (!allowedTabIds.has(id)) return `未知のタブ ${id}`;
  }

  const warnings = parseWarnings(value.warnings, allowedTabIds);
  if (typeof warnings === "string") return warnings;

  return {
    planId,
    title,
    rationale,
    strategy: value.strategy as GroupingStrategy,
    groups,
    unassignedTabIds,
    warnings,
  };
}

export function parseGroupingOutput(
  raw: string,
  allowedTabIds: Iterable<string>,
  existingWorkspaceIds: Iterable<string>,
  existingWorkspaceNames: Iterable<string> = [],
): ParseGroupingResult {
  const trimmed = raw.trim();
  const allowed = new Set([...allowedTabIds]);
  const workspaceIds = new Set([...existingWorkspaceIds]);
  const workspaceNames = new Set([...existingWorkspaceNames]);
  const issues: ParseIssue[] = [];
  const fail = (reason: string, extra: ParseIssue[] = []): ParseGroupingResult => ({
    status: "invalid",
    reason,
    issues: [{ scope: "response", reason }, ...extra],
    raw,
    validPlans: [],
  });

  if (!trimmed) return fail("空の応答です");
  if (trimmed.startsWith("```") || trimmed.includes("\n```")) return fail("コードフェンスは禁止です");

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return fail("JSON として解釈できません");
  }
  if (!isObject(parsed)) return fail("トップレベルがオブジェクトではありません");
  if (parsed.schemaVersion !== 1) return fail("schemaVersion が 1 ではありません");
  if (!Array.isArray(parsed.plans)) return fail("plans が配列ではありません");
  if (parsed.plans.length < 1 || parsed.plans.length > TAB_GROUPING_PLAN_MAX) {
    return fail(`plans は1〜${TAB_GROUPING_PLAN_MAX}件である必要があります`);
  }

  const validPlans: GroupingPlan[] = [];
  const seenPlanIds = new Set<string>();
  for (const planValue of parsed.plans) {
    const plan = parsePlan(planValue, allowed, workspaceIds, workspaceNames);
    if (typeof plan === "string") {
      issues.push({
        scope: "plan",
        planId: isObject(planValue) ? asString(planValue.planId) ?? undefined : undefined,
        reason: plan,
      });
      continue;
    }
    if (seenPlanIds.has(plan.planId)) {
      issues.push({ scope: "plan", planId: plan.planId, reason: "planId が重複しています" });
      continue;
    }
    seenPlanIds.add(plan.planId);
    validPlans.push(plan);
  }

  if (validPlans.length === 0) {
    return fail("有効なプランがありません", issues);
  }
  return {
    status: "ok",
    plans: validPlans,
    droppedPlans: issues,
    comparisonInsufficient: validPlans.length < TAB_GROUPING_PLAN_MIN,
    raw,
  };
}

export function clonePlanForEdit(plan: GroupingPlan): GroupingPlan {
  return structuredClone(plan);
}

export function setGroupAdopted(plan: GroupingPlan, groupId: string, adopted: boolean): GroupingPlan {
  return {
    ...plan,
    groups: plan.groups.map((group) => group.groupId === groupId ? { ...group, adopted } : group),
  };
}

export function setGroupDestination(
  plan: GroupingPlan,
  groupId: string,
  destination: GroupingDestination,
): GroupingPlan {
  return {
    ...plan,
    groups: plan.groups.map((group) => {
      if (group.groupId !== groupId) return group;
      if (destination.kind === "current_locations") {
        return {
          ...group,
          disposition: "keep",
          destination,
          layout: null,
          adopted: true,
        };
      }
      const layout = group.layout ?? defaultLayoutForTabs(group.tabIds, group.title);
      return {
        ...group,
        disposition: "reorganize",
        destination,
        layout,
        tabIds: flattenLayoutTabIds(layout),
        adopted: true,
      };
    }),
  };
}

export function defaultLayoutForTabs(tabIds: readonly string[], title: string): GroupingLayout {
  return {
    columns: [{
      panes: [{
        title,
        role: "unspecified",
        tabIds: [...tabIds],
      }],
    }],
  };
}

export function addGroup(
  plan: GroupingPlan,
  title: string,
  idFactory: () => string = uuid,
): GroupingPlan {
  const groupId = idFactory();
  return {
    ...plan,
    groups: [
      ...plan.groups,
      {
        groupId,
        title,
        disposition: "reorganize",
        destination: { kind: "new_workspace", proposedName: title },
        layout: defaultLayoutForTabs([], title),
        tabIds: [],
        adopted: true,
      },
    ],
  };
}

export function reassignTabs(
  plan: GroupingPlan,
  tabIds: readonly string[],
  target: { kind: "group"; groupId: string; paneTitle?: string } | { kind: "unassigned" },
): GroupingPlan {
  const moving = new Set(tabIds);
  const strip = (ids: string[]) => ids.filter((id) => !moving.has(id));
  const groups = plan.groups.map((group) => {
    const nextTabIds = strip(group.tabIds);
    if (!group.layout) return { ...group, tabIds: nextTabIds };
    return {
      ...group,
      tabIds: nextTabIds,
      layout: {
        columns: group.layout.columns.map((column) => ({
          panes: column.panes.map((pane) => ({ ...pane, tabIds: strip(pane.tabIds) })),
        })),
      },
    };
  });
  let unassignedTabIds = strip(plan.unassignedTabIds);
  if (target.kind === "unassigned") {
    unassignedTabIds = [...unassignedTabIds, ...tabIds];
  } else {
    const nextGroups = groups.map((group) => {
      if (group.groupId !== target.groupId) return group;
      if (group.disposition === "keep" || !group.layout) {
        return { ...group, tabIds: [...group.tabIds, ...tabIds] };
      }
      const paneTitle = target.paneTitle;
      const columns = group.layout.columns.map((column, columnIndex) => ({
        panes: column.panes.map((pane, paneIndex) => {
          const isDefault = columnIndex === 0 && paneIndex === 0;
          const matches = paneTitle ? pane.title === paneTitle : isDefault;
          return matches ? { ...pane, tabIds: [...pane.tabIds, ...tabIds] } : pane;
        }),
      }));
      const layout = { columns };
      return { ...group, layout, tabIds: flattenLayoutTabIds(layout), disposition: "reorganize" as const };
    });
    return { ...plan, groups: nextGroups, unassignedTabIds };
  }
  return { ...plan, groups, unassignedTabIds };
}

export function validateEditedPlan(
  plan: GroupingPlan,
  allowedTabIds: Iterable<string>,
  _existingWorkspaceIds: Iterable<string>,
  existingWorkspaceNames: Iterable<string> = [],
): string[] {
  const allowed = new Set([...allowedTabIds]);
  const existingNames = new Set([...existingWorkspaceNames]);
  const errors: string[] = [];
  const appearances = new Map<string, number>();
  const note = (id: string) => appearances.set(id, (appearances.get(id) ?? 0) + 1);

  if (!isJapaneseGroupingName(plan.title)) errors.push("プラン名が不正です");
  const groupIds = plan.groups.map((group) => group.groupId);
  const groupIdError = uniqueStrings(groupIds, "groupId");
  if (groupIdError) errors.push(groupIdError);

  const adoptedNewNames: string[] = [];
  for (const group of plan.groups) {
    if (!isJapaneseGroupingName(group.title)) errors.push(`グループ「${group.groupId}」の名前が不正です`);
    if (group.disposition === "keep") {
      if (group.destination.kind !== "current_locations") {
        errors.push(`グループ「${group.title}」の keep は current_locations である必要があります`);
      }
      if (group.layout !== null) errors.push(`グループ「${group.title}」の keep は layout null である必要があります`);
    }
    if (group.adopted && group.disposition === "reorganize") {
      if (group.destination.kind === "current_locations") {
        errors.push(`グループ「${group.title}」の reorganize に current_locations は使えません`);
      }
      if (!group.layout) {
        errors.push(`グループ「${group.title}」の layout がありません`);
        continue;
      }
      if (group.layout.columns.length === 0) errors.push(`グループ「${group.title}」に空の列があります`);
      for (const column of group.layout.columns) {
        if (column.panes.length === 0) errors.push(`グループ「${group.title}」に空の列があります`);
        for (const pane of column.panes) {
          if (pane.tabIds.length === 0) errors.push(`グループ「${group.title}」に空のペインがあります`);
        }
      }
      const layoutIds = flattenLayoutTabIds(group.layout);
      if ([...group.tabIds].sort().join("\0") !== [...layoutIds].sort().join("\0")) {
        errors.push(`グループ「${group.title}」の tabIds と layout が一致しません`);
      }
      if (group.destination.kind === "new_workspace") {
        if (!isJapaneseGroupingName(group.destination.proposedName)) {
          errors.push(`グループ「${group.title}」の新ワークスペース名が不正です`);
        } else {
          adoptedNewNames.push(group.destination.proposedName);
        }
      }
      layoutIds.forEach(note);
    } else {
      group.tabIds.forEach(note);
    }
  }
  const adoptedNameError = uniqueStrings(adoptedNewNames, "新ワークスペース名");
  if (adoptedNameError) errors.push(adoptedNameError);
  for (const name of adoptedNewNames) {
    if (existingNames.has(name)) errors.push(`新ワークスペース名が既存名と衝突しています: ${name}`);
  }
  plan.unassignedTabIds.forEach(note);
  for (const id of allowed) {
    if ((appearances.get(id) ?? 0) !== 1) errors.push(`タブ ${id} の出現回数が1ではありません`);
  }
  return errors;
}


export function classifyStale(
  baseline: readonly AnalysisBaselineEntry[],
  current: readonly Workspace[],
  targetTabIds: ReadonlySet<string>,
  destinationWorkspaceIds: ReadonlySet<string>,
): StaleIssue[] {
  const issues: StaleIssue[] = [];
  const currentIndex = tabIndex(current);
  const currentWorkspaceIds = new Set(current.map((workspace) => workspace.id));

  for (const workspaceId of destinationWorkspaceIds) {
    if (!currentWorkspaceIds.has(workspaceId)) {
      issues.push({
        code: "workspace_missing",
        workspaceId,
        message: `合流先ワークスペース ${workspaceId} が消えています`,
      });
    }
  }

  for (const entry of baseline) {
    if (!targetTabIds.has(entry.tabId)) continue;
    const live = currentIndex.get(entry.tabId);
    if (!live) {
      issues.push({
        code: "tab_closed",
        tabId: entry.tabId,
        message: `タブ ${entry.tabId} が閉じられています`,
      });
      continue;
    }
    if (live.tab.sessionId !== entry.sessionId) {
      issues.push({
        code: "session_mismatch",
        tabId: entry.tabId,
        message: `タブ ${entry.tabId} の sessionId が分析時と違います`,
      });
    }
    if (live.workspace.id !== entry.workspaceId || live.pane.id !== entry.paneId) {
      issues.push({
        code: "tab_moved",
        tabId: entry.tabId,
        message: `タブ ${entry.tabId} が分析後に手動で移動されています`,
      });
    }
  }
  return issues;
}


function tabLabel(workspaces: readonly Workspace[], tabId: string): string {
  const found = tabIndex(workspaces).get(tabId);
  return found?.tab.label?.trim() || "無名タブ";
}

export function buildApplyReport(
  before: readonly Workspace[],
  expected: GroupingExpectedResult,
): GroupingApplyReport {
  const nameById = new Map(before.map((workspace) => [workspace.id, workspace.name]));
  return {
    moved: expected.movedTabIds.map((tabId) => ({
      tabId,
      from: findTabLocation(before, tabId) ?? { workspaceId: "", paneId: "", sessionId: "" },
      to: expected.tabs[tabId],
      label: tabLabel(before, tabId),
    })),
    kept: expected.keptTabIds.map((tabId) => ({
      tabId,
      location: expected.tabs[tabId] ?? findTabLocation(before, tabId) ?? { workspaceId: "", paneId: "", sessionId: "" },
      label: tabLabel(before, tabId),
    })),
    unassigned: expected.unassignedTabIds.map((tabId) => ({
      tabId,
      location: expected.tabs[tabId] ?? findTabLocation(before, tabId) ?? { workspaceId: "", paneId: "", sessionId: "" },
      label: tabLabel(before, tabId),
    })),
    blocked: [],
    errors: [],
    emptyWorkspaceIds: expected.emptyWorkspaceIds,
    emptyWorkspaceNames: expected.emptyWorkspaceIds.map((id) => nameById.get(id) ?? id),
  };
}


export function previewKindForTab(plan: GroupingPlan, tabId: string): TabPreviewKind {
  if (plan.unassignedTabIds.includes(tabId)) return "unassigned";
  const group = plan.groups.find((item) => item.tabIds.includes(tabId));
  if (!group) return "untouched";
  if (!group.adopted || group.disposition === "keep") return "kept";
  return "moved";
}

export function planCardStats(plan: GroupingPlan, baseline: readonly AnalysisBaselineEntry[]): {
  moved: number;
  newWorkspaces: number;
  kept: number;
  warnings: number;
} {
  const adopted = plan.groups.filter((group) => group.adopted && group.disposition === "reorganize");
  return {
    moved: adopted.reduce((sum, group) => sum + group.tabIds.length, 0),
    newWorkspaces: adopted.filter((group) => group.destination.kind === "new_workspace").length,
    kept: baseline.length - adopted.reduce((sum, group) => sum + group.tabIds.length, 0),
    warnings: plan.warnings.length,
  };
}


export interface GroupingAnalysisDependencies {
  scan: () => Promise<GroupingScan>;
  judge: (prompt: string, requestId: string) => Promise<string>;
  requestId: () => string;
}

export async function runGroupingAnalysis(
  deps: GroupingAnalysisDependencies,
): Promise<{
  scan: GroupingScan;
  parsed: ParseGroupingResult;
  retried: boolean;
  raw: string;
}> {
  const scan = await deps.scan();
  if (scan.tabs.length === 0) {
    return {
      scan,
      parsed: {
        status: "invalid",
        reason: "再配置できる生きたターミナルがありません",
        issues: [{ scope: "response", reason: "再配置できる生きたターミナルがありません" }],
        raw: "",
        validPlans: [],
      },
      retried: false,
      raw: "",
    };
  }
  const allowed = scan.tabs.map((tab) => tab.id);
  const workspaceIds = scan.workspaceIds;
  const firstId = deps.requestId();
  const names = scan.workspaces.map((workspace) => workspace.name);
  const firstRaw = await deps.judge(buildGroupingPrompt(scan), firstId);
  let parsed = parseGroupingOutput(firstRaw, allowed, workspaceIds, names);
  if (parsed.status === "ok" && !parsed.comparisonInsufficient) {
    return { scan, parsed, retried: false, raw: firstRaw };
  }
  const secondId = deps.requestId();
  const secondRaw = await deps.judge(buildGroupingPrompt(scan), secondId);
  parsed = parseGroupingOutput(secondRaw, allowed, workspaceIds, names);
  return { scan, parsed, retried: true, raw: secondRaw };
}

export function openTabGroupingInDashboard(): void {
  if (typeof window === "undefined") return;
  void import("../../stores/dashboardViewStore").then(({ useDashboardViewStore }) => {
    useDashboardViewStore.getState().openView();
    window.setTimeout(() => window.dispatchEvent(new Event(TAB_GROUPING_OPEN_EVENT)), 0);
  });
}
