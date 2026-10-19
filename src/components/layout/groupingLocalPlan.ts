import { fallbackAttributeGrouping } from "./attributeGrouping";
import { paneRegistry } from "../../lib/paneEvidence";
import { useAiSettingsStore } from "../../stores/aiSettingsStore";
import { evidenceAnalysis, evidenceRole } from "./evidenceGrouping";
import { cachedEvidenceScan } from "../../lib/paneEvidence";
import { reconcileSplitColumnsForPanes } from "../../lib/layoutColumns";
import { TAB_SWEEP_IDLE_MS } from "./tabSweep";
import type { SessionOutputSnapshot } from "../../lib/ipc";
import type { PaneMetadata } from "../../stores/paneMetadataStore";
import type { Workspace } from "../../types";
import {
  TAB_GROUPING_MAX_COLUMNS,
  TAB_GROUPING_MAX_PANES_PER_COLUMN,
  TAB_GROUPING_PLAN_MAX,
  TAB_GROUPING_PLAN_MIN,
  sanitizeGroupingName,
  uniqueGroupingName,
  scanGroupingContext,
  validateEditedPlan,
  type GroupingAnalysisResult,
  type GroupingGroup,
  type GroupingLayout,
  type GroupingLayoutPane,
  type GroupingPaneRole,
  type GroupingPlan,
  type GroupingPresetStrategy,
  type GroupingScanSource,
  type GroupingScan,
  type GroupingTab,
} from "./tabGrouping";

/**
 * The instant local plan (便C, 2026-08-30).
 *
 * v0.60.1 pinned the judge's reasoning effort and stopped throwing the cached
 * plan away, but a cold open still waits ~100s for the model. That wait is the
 * model's generation time, so the only way to make the panel feel immediate is
 * to have something real to show before the model is asked at all.
 *
 * This module derives a plan from the stores alone -- no IPC, no LLM, no
 * heuristic dictionary. It is a genuine, applicable plan, not a placeholder:
 * the layout rules are the same ones the prompt asks the model for (split by
 * column, never add rows, stack related tabs as back tabs, keep a lineage
 * together, isolate tabs that need attention).
 */

export const LOCAL_GROUPING_PLAN_ID = "local-instant";
export const LOCAL_GROUPING_MIN_TABS = 4;
export const LOCAL_GROUPING_MIN_GROUP_SIZE = 2;
export const LOCAL_GROUPING_ATTENTION_TITLE = "要対応";
export const LOCAL_GROUPING_FALLBACK_TITLE = "その他";
export const LOCAL_GROUPING_PLAN_TITLE = "いますぐの案";
export const MAIN_SESSIONS_MAX = 3;
export const ACTIVE_WATCH_MAX = TAB_GROUPING_MAX_COLUMNS * TAB_GROUPING_MAX_PANES_PER_COLUMN;

export type LocalGroupingAttention = "waiting" | "error" | "done" | null | undefined;

export interface LocalGroupingSource {
  workspaces: Workspace[];
  metadata: Record<string, PaneMetadata>;
  attentionByTabId: Readonly<Record<string, LocalGroupingAttention>>;
  now: number;
  lastOutputBySession?: SessionOutputSnapshot;
  attentionBySession?: GroupingScanSource["attentionBySession"];
  questionsBySession?: GroupingScanSource["questionsBySession"];
  seenAttentionByTab?: GroupingScanSource["seenAttentionByTab"];
}

/**
 * A scan built from the stores with no IPC at all: no PTY snapshot and no
 * per-tab tail reads (the tails are what make the real scan cost
 * one round trip per tab). Grouping never displays the tail, so an empty one
 * costs nothing here. Presets reuse cached output timestamps and attention.
 */
export async function buildLocalGroupingScan(source: LocalGroupingSource): Promise<GroupingScan> {
  return scanGroupingContext({
    workspaces: source.workspaces,
    metadata: source.metadata,
    processMetadata: {},
    processMetadataAvailable: false,
    lastOutputBySession: source.lastOutputBySession ?? {},
    attentionBySession: source.attentionBySession,
    questionsBySession: source.questionsBySession,
    seenAttentionByTab: source.seenAttentionByTab,
    readTail: async () => [],
    now: source.now,
    skipLivenessFilter: true,
  });
}

function cwdSegments(cwd: string): string[] {
  return cwd
    .replace(/\\/gu, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== ".");
}

function prefixKey(segments: readonly string[], depth: number): string {
  return segments.slice(0, depth).join("/");
}

/**
 * Group tabs by the deepest folder that at least two of them share.
 *
 * Every cwd goes into a trie; a tab's key is the deepest node on its own path
 * whose subtree holds two or more tabs. Tabs under one project folder collapse
 * onto that folder, and a tab that shares nothing lands on the common root
 * (usually the home directory) where it is treated as unassigned. No depth
 * threshold and no folder-name dictionary, so it does not rot as the machine's
 * folder layout changes.
 */
export function localProjectKeys(tabs: readonly GroupingTab[]): Map<string, string> {
  const counts = new Map<string, number>();
  const segmentsByTab = new Map<string, string[]>();
  for (const tab of tabs) {
    const segments = cwdSegments(tab.cwd);
    segmentsByTab.set(tab.id, segments);
    for (let depth = 1; depth <= segments.length; depth += 1) {
      const key = prefixKey(segments, depth);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const keys = new Map<string, string>();
  for (const tab of tabs) {
    const segments = segmentsByTab.get(tab.id) ?? [];
    let key = "";
    for (let depth = 1; depth <= segments.length; depth += 1) {
      const candidate = prefixKey(segments, depth);
      if ((counts.get(candidate) ?? 0) >= 2) key = candidate;
    }
    keys.set(tab.id, key);
  }
  return keys;
}

function lineageParentInSet(tab: GroupingTab, ids: ReadonlySet<string>): string | null {
  const parentTabId = tab.origin?.kind === "agent" ? tab.origin.parentTabId : undefined;
  return parentTabId && ids.has(parentTabId) ? parentTabId : null;
}

/** Union-find over origin.parentTabId so a lineage never splits across groups. */
function lineageClusterKeys(tabs: readonly GroupingTab[]): Map<string, string> {
  const parent = new Map<string, string>(tabs.map((tab) => [tab.id, tab.id]));
  const find = (id: string): string => {
    let root = id;
    while ((parent.get(root) ?? root) !== root) root = parent.get(root) ?? root;
    let cursor = id;
    while ((parent.get(cursor) ?? cursor) !== cursor) {
      const next = parent.get(cursor) ?? cursor;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const ids = new Set(tabs.map((tab) => tab.id));
  for (const tab of tabs) {
    const parentTabId = lineageParentInSet(tab, ids);
    if (!parentTabId) continue;
    const left = find(tab.id);
    const right = find(parentTabId);
    if (left !== right) parent.set(left, right);
  }
  return new Map(tabs.map((tab) => [tab.id, find(tab.id)]));
}

interface LocalBucket {
  key: string;
  tabs: GroupingTab[];
  attention: boolean;
}

/**
 * Assign every tab to exactly one bucket: attention tabs are pulled out first
 * (a failing tab does not belong next to healthy work, even when its lineage
 * sits elsewhere), then whole lineage clusters go to the project key their
 * members agree on.
 */
export function localBuckets(
  tabs: readonly GroupingTab[],
  attentionByTabId: Readonly<Record<string, LocalGroupingAttention>>,
): LocalBucket[] {
  const attentionTabs = tabs.filter((tab) => attentionByTabId[tab.id] === "error");
  const attentionIds = new Set(attentionTabs.map((tab) => tab.id));
  const rest = tabs.filter((tab) => !attentionIds.has(tab.id));

  const projectKeys = localProjectKeys(rest);
  const clusterKeys = lineageClusterKeys(rest);
  const clusterVotes = new Map<string, Map<string, number>>();
  for (const tab of rest) {
    const cluster = clusterKeys.get(tab.id) ?? tab.id;
    const votes = clusterVotes.get(cluster) ?? new Map<string, number>();
    const key = projectKeys.get(tab.id) ?? "";
    votes.set(key, (votes.get(key) ?? 0) + 1);
    clusterVotes.set(cluster, votes);
  }
  const clusterKey = new Map<string, string>();
  for (const [cluster, votes] of clusterVotes) {
    // Deepest path wins a tie so a lineage follows its most specific folder.
    const best = [...votes.entries()].sort((left, right) => (
      right[1] - left[1] || right[0].length - left[0].length || left[0].localeCompare(right[0])
    ))[0];
    clusterKey.set(cluster, best?.[0] ?? "");
  }

  const byKey = new Map<string, GroupingTab[]>();
  for (const tab of rest) {
    const key = clusterKey.get(clusterKeys.get(tab.id) ?? tab.id) ?? "";
    const bucket = byKey.get(key);
    if (bucket) bucket.push(tab);
    else byKey.set(key, [tab]);
  }

  const buckets: LocalBucket[] = [...byKey.entries()]
    .map(([key, bucketTabs]) => ({ key, tabs: bucketTabs, attention: false }))
    .sort((left, right) => right.tabs.length - left.tabs.length || left.key.localeCompare(right.key));
  if (attentionTabs.length > 0) {
    buckets.unshift({ key: "\u0000attention", tabs: attentionTabs, attention: true });
  }
  return buckets;
}

function uniqueTitle(candidate: string, taken: Set<string>): string {
  const name = uniqueGroupingName(candidate, taken);
  taken.add(name);
  return name;
}

function bucketTitle(bucket: LocalBucket, taken: Set<string>): string {
  if (bucket.attention) return uniqueTitle(LOCAL_GROUPING_ATTENTION_TITLE, taken);
  const segments = bucket.key.split("/").filter(Boolean);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const name = sanitizeGroupingName(segments[index]);
    if (name) return uniqueTitle(name, taken);
  }
  return uniqueTitle(LOCAL_GROUPING_FALLBACK_TITLE, taken);
}

/** Roots first, each root immediately followed by its descendants. */
function lineageUnits(tabs: readonly GroupingTab[]): GroupingTab[][] {
  const ids = new Set(tabs.map((tab) => tab.id));
  const childrenOf = new Map<string, GroupingTab[]>();
  const roots: GroupingTab[] = [];
  for (const tab of tabs) {
    const parentTabId = lineageParentInSet(tab, ids);
    if (!parentTabId) {
      roots.push(tab);
      continue;
    }
    const siblings = childrenOf.get(parentTabId) ?? [];
    siblings.push(tab);
    childrenOf.set(parentTabId, siblings);
  }
  const collect = (root: GroupingTab): GroupingTab[] => {
    const unit = [root];
    for (let index = 0; index < unit.length; index += 1) {
      unit.push(...(childrenOf.get(unit[index].id) ?? []));
    }
    return unit;
  };
  return roots.map(collect);
}

function paneRole(unit: readonly GroupingTab[], hasChildren: boolean): GroupingPaneRole {
  if (hasChildren) return "mother";
  return unit[0]?.origin?.kind === "agent" ? "worker" : "unspecified";
}

/**
 * Columns only, one pane per column: extra tabs stack as back tabs instead of
 * adding rows, which is exactly the doctrine the prompt states ("split by
 * column, stack the rest behind one tab, never grow rows").
 */
export function localLayout(tabs: readonly GroupingTab[], groupTitle: string): GroupingLayout | null {
  const units = lineageUnits(tabs);
  if (units.length === 0) return null;
  const columnCount = Math.min(TAB_GROUPING_MAX_COLUMNS, units.length);
  const columns: GroupingTab[][][] = Array.from({ length: columnCount }, () => []);
  units.forEach((unit, index) => {
    // Sequential chunks keep a lineage and its neighbours side by side.
    const column = Math.min(columnCount - 1, Math.floor(index * columnCount / units.length));
    columns[column].push(unit);
  });
  const panes: GroupingLayout["columns"] = [];
  for (const [index, columnUnits] of columns.entries()) {
    if (columnUnits.length === 0) return null;
    const flat = columnUnits.flat();
    const title = sanitizeGroupingName(flat[0].label)
      ?? sanitizeGroupingName(`${groupTitle} ${index + 1}`)
      ?? `${LOCAL_GROUPING_FALLBACK_TITLE} ${index + 1}`;
    const pane: GroupingLayoutPane = {
      title,
      role: paneRole(columnUnits[0], columnUnits[0].length > 1),
      tabIds: flat.map((tab) => tab.id),
    };
    panes.push({ panes: [pane] });
  }
  return { columns: panes };
}

function alreadySettled(bucket: LocalBucket, scan: GroupingScan): boolean {
  const workspaceIds = new Set(bucket.tabs.map((tab) => tab.workspaceId));
  if (workspaceIds.size !== 1) return false;
  const [workspaceId] = [...workspaceIds];
  const residents = scan.tabs.filter((tab) => tab.workspaceId === workspaceId);
  return residents.length === bucket.tabs.length;
}

export interface LocalGroupingPlanOptions {
  existingWorkspaceNames?: readonly string[];
  minTabs?: number;
  requestedStrategy?: GroupingPresetStrategy;
}


function waitsForReply(tab: GroupingTab): boolean {
  const waiting = tab.attention?.waiting;
  return waiting === "input" || waiting === "approval" || waiting === "question";
}

function activeWatchPriority(tab: GroupingTab): number {
  if (waitsForReply(tab)) return 0;
  if (tab.attention?.working) return 1;
  if (tab.attention?.waiting === "error" || tab.attention?.waiting === "rate_limited") return 2;
  return 3;
}

function outputTimestamp(tab: GroupingTab): number {
  return typeof tab.lastOutputAt === "number" && Number.isFinite(tab.lastOutputAt) ? tab.lastOutputAt : -Infinity;
}

function presetColumns(
  destination: Workspace | undefined,
  selected: readonly GroupingTab[],
): (GroupingLayout["columns"][number] & { residentRows: number })[] {
  const selectedIds = new Set(selected.map(tab => tab.id));
  const residents = destination?.panes.filter(pane => pane.tabs.some(tab => !selectedIds.has(tab.id))) ?? [];
  const residentColumns = destination ? reconcileSplitColumnsForPanes(destination.splitColumns, residents.map(pane => pane.id))
    : [];
  return Array.from({ length: TAB_GROUPING_MAX_COLUMNS }, (_, index) => ({
    ...(residentColumns[index]?.length ? { existingColumnPaneId: residentColumns[index][0] } : {}),
    residentRows: residentColumns[index]?.length ?? 0,
    panes: [],
  }));
}

function presetLayout(
  destination: Workspace | undefined,
  selected: readonly GroupingTab[],
  title: string,
  roles: ReadonlyMap<string, GroupingPaneRole>,
): GroupingLayout {
  const columns = presetColumns(destination, selected);
  selected.forEach((tab, index) => {
    const column = columns.filter(column => column.residentRows + column.panes.length < TAB_GROUPING_MAX_PANES_PER_COLUMN)
      .sort((left, right) => left.residentRows + left.panes.length - right.residentRows - right.panes.length)[0];
    column.panes.push({
      title: sanitizeGroupingName(tab.displayName ?? tab.label) ?? `${title} ${index + 1}`,
      role: roles.get(tab.id) ?? "unspecified", tabIds: [tab.id],
    });
  });
  return { columns: columns.filter(column => column.panes.length > 0).map(({ residentRows: _rows, ...column }) => column) };
}

/** Practical presets select sessions without pulling idle lineage members along. */
export function buildPresetGroupingPlan(scan: GroupingScan, strategy: GroupingPresetStrategy): GroupingPlan {
  if (strategy === "attribute") return fallbackAttributeGrouping(scan, paneRegistry(), useAiSettingsStore.getState().aiEnabled ? "判定待ち" : "AI がオフ").plan;
  const roles = new Map(scan.tabs.map((tab, index) => [tab.id, evidenceRole(scan, index)]));
  const workspaceOrder = new Map(scan.workspaces.map((workspace, index) => [workspace.id, index]));
  const scanOrder = new Map(scan.tabs.map((tab, index) => [tab.id, index]));
  const locationOrder = (left: GroupingTab, right: GroupingTab) => (
    (workspaceOrder.get(left.workspaceId) ?? Infinity) - (workspaceOrder.get(right.workspaceId) ?? Infinity)
    || left.column - right.column
    || (scanOrder.get(left.id) ?? 0) - (scanOrder.get(right.id) ?? 0)
  );
  const candidates = strategy === "active_watch" ? scan.tabs.filter(tab => (
    tab.attention?.working || tab.attention?.waiting != null || tab.attention?.unreadCompletion
    || outputTimestamp(tab) >= scan.scannedAt - TAB_SWEEP_IDLE_MS
  )) : [...scan.tabs];
  candidates.sort((left, right) => strategy === "active_watch"
    ? activeWatchPriority(left) - activeWatchPriority(right) || outputTimestamp(right) - outputTimestamp(left) || locationOrder(left, right)
    : Number(waitsForReply(right)) - Number(waitsForReply(left))
      || Number(right.origin?.kind === "human") - Number(left.origin?.kind === "human")
      || Number(roles.get(right.id) === "mother") - Number(roles.get(left.id) === "mother")
      || outputTimestamp(right) - outputTimestamp(left) || locationOrder(left, right));
  const limit = strategy === "active_watch" ? ACTIVE_WATCH_MAX : MAIN_SESSIONS_MAX;
  const selected = candidates.slice(0, limit);
  const title = strategy === "active_watch" ? "稼働中" : "メイン";
  const destination = scan.workspaces.find(workspace => workspace.name === title);
  // Recompute after each excluded candidate: a kept destination tab can keep
  // its entire resident pane/column occupied. Only admit a prefix that fits.
  while (selected.length > 0 && selected.length > presetColumns(destination, selected)
    .reduce((count, column) => count + Math.max(0, TAB_GROUPING_MAX_PANES_PER_COLUMN - column.residentRows), 0)) selected.pop();
  const base: GroupingPlan = {
    planId: `local-${strategy}`,
    title: strategy === "active_watch" ? "稼働中だけ" : "メインだけ",
    rationale: strategy === "active_watch" ? "次の返事待ちが出るまで見張るタブだけをまとめます。"
      : "返事待ち・人が起動したタブ・母艦・出力の新しさの順で、主なセッションをまとめます。",
    strategy, groups: [], unassignedTabIds: [], warnings: [],
  };
  if (candidates.length === 0) {
    return { ...base, rationale: `いま該当なし。${strategy === "active_watch" ? "作業中・返事待ち・未読の完了・直近5分の出力があるタブはありません。" : "対象のターミナルタブはありません。"}`,
      unassignedTabIds: scan.tabs.map(tab => tab.id) };
  }
  if (selected.length === 0) {
    return { ...base, rationale: `合流先「${title}」は表示場所がいっぱいです。対象は今の場所に残します。`,
      unassignedTabIds: scan.tabs.map(tab => tab.id) };
  }
  const selectedIds = new Set(selected.map(tab => tab.id));
  const kept = scan.tabs.filter(tab => !selectedIds.has(tab.id)).map(tab => tab.id);
  const groups: GroupingGroup[] = [{
    groupId: `local-${strategy}-selected`, title, disposition: "reorganize", adopted: true,
    destination: destination ? { kind: "existing_workspace", workspaceId: destination.id,
      ...(destination.nameSource === "auto" ? { nameEdited: true as const, proposedName: title } : {}) }
      : { kind: "new_workspace", proposedName: title, nameEdited: true },
    layout: presetLayout(destination, selected, title, roles), tabIds: selected.map(tab => tab.id),
  }];
  if (kept.length > 0) groups.push({
    groupId: `local-${strategy}-keep`, title: "今のまま", disposition: "keep", adopted: true,
    destination: { kind: "current_locations" }, layout: null, tabIds: kept,
  });
  const overflow = Math.max(0, candidates.length - limit);
  const capacityOverflow = Math.min(candidates.length, limit) - selected.length;
  return { ...base, groups,
    rationale: base.rationale + (strategy === "active_watch" && overflow > 0 ? ` 上限のため ${overflow} 本は残しました。` : "")
      + (capacityOverflow > 0 ? ` 合流先の表示容量のため ${capacityOverflow} 本は残しました。` : ""),
  };
}

/** Keep the preset first, followed by the judge's role plan and a local alternative. */
export function withRequestedGroupingPlan(
  analysis: GroupingAnalysisResult,
  requestedStrategy?: GroupingPresetStrategy,
  attributePlan?: GroupingPlan,
): GroupingAnalysisResult {
  if (!requestedStrategy || analysis.parsed.status !== "ok") return analysis;
  const requested = requestedStrategy === "attribute"
    ? attributePlan ?? analysis.parsed.plans.find(plan => plan.strategy === "attribute") ?? buildPresetGroupingPlan(analysis.scan, requestedStrategy)
    : buildPresetGroupingPlan(analysis.scan, requestedStrategy);
  const alternatives = analysis.parsed.plans.filter(plan => plan.strategy !== requestedStrategy);
  const role = alternatives.find(plan => plan.strategy === "role");
  const plans = [requested, ...(role ? [role] : []), ...alternatives.filter(plan => plan.strategy !== "role")].slice(0, TAB_GROUPING_PLAN_MAX);
  return { ...analysis, parsed: { ...analysis.parsed, plans, comparisonInsufficient: plans.length < TAB_GROUPING_PLAN_MIN } };
}

/**
 * Returns null whenever there is nothing worth showing -- too few tabs, no
 * group that would actually move, or a plan the shared validator rejects. A
 * missing instant plan just means the panel behaves as it did before; a wrong
 * one would be worse than waiting.
 */
/** Legacy single-plan helper; the product uses buildLocalGroupingAnalysis below. */
export function buildLocalGroupingPlan(
  scan: GroupingScan,
  attentionByTabId: Readonly<Record<string, LocalGroupingAttention>>,
  options: LocalGroupingPlanOptions = {},
): GroupingPlan | null {
  if (options.requestedStrategy) return buildPresetGroupingPlan(scan, options.requestedStrategy);
  const minTabs = options.minTabs ?? LOCAL_GROUPING_MIN_TABS;
  if (scan.tabs.length < minTabs) return null;

  const existingNames = new Set(options.existingWorkspaceNames ?? scan.workspaces.map((w) => w.name));
  const taken = new Set<string>(existingNames);
  const groups: GroupingGroup[] = [];
  const unassignedTabIds: string[] = [];

  for (const bucket of localBuckets(scan.tabs, attentionByTabId)) {
    if (!bucket.attention && bucket.tabs.length < LOCAL_GROUPING_MIN_GROUP_SIZE) {
      unassignedTabIds.push(...bucket.tabs.map((tab) => tab.id));
      continue;
    }
    const title = bucketTitle(bucket, taken);
    const tabIds = bucket.tabs.map((tab) => tab.id);
    if (!bucket.attention && alreadySettled(bucket, scan)) {
      groups.push({
        groupId: `local-${groups.length + 1}`,
        title,
        disposition: "keep",
        destination: { kind: "current_locations" },
        layout: null,
        tabIds,
        adopted: true,
      });
      continue;
    }
    const layout = localLayout(bucket.tabs, title);
    if (!layout) {
      unassignedTabIds.push(...tabIds);
      continue;
    }
    groups.push({
      groupId: `local-${groups.length + 1}`,
      title,
      disposition: "reorganize",
      destination: { kind: "new_workspace", proposedName: title },
      layout,
      tabIds,
      adopted: true,
    });
  }

  if (!groups.some((group) => group.disposition === "reorganize")) return null;

  const plan: GroupingPlan = {
    planId: LOCAL_GROUPING_PLAN_ID,
    title: LOCAL_GROUPING_PLAN_TITLE,
    rationale: "作業フォルダと系譜だけで組んだ案です。AI の案を待たずに適用できます。",
    strategy: "project",
    groups,
    unassignedTabIds,
    warnings: [],
  };
  const errors = validateEditedPlan(
    plan,
    scan.tabs.map((tab) => tab.id),
    scan.workspaceIds,
    existingNames,
  );
  return errors.length === 0 ? plan : null;
}

/** Wraps the plan as an analysis so the panel hydrates it through one path. */
export function buildLocalGroupingAnalysis(
  scan: GroupingScan,
  attentionByTabId: Readonly<Record<string, LocalGroupingAttention>>,
  options: LocalGroupingPlanOptions = {},
): GroupingAnalysisResult | null {
  void attentionByTabId;
  return scan.tabs.length || options.requestedStrategy
    ? withRequestedGroupingPlan(evidenceAnalysis(cachedEvidenceScan(scan)), options.requestedStrategy) : null;
}
