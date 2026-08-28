import { DEFAULT_LAYOUT_SIZE } from "../../lib/layoutMetrics";
import {
  canonicalize,
  hashCanonical,
  PersistentLayoutValidationError,
  persistentLayoutProjection,
  persistentLayoutSignature,
  sha256Hex,
  type PersistentLayoutProjection,
  type Sha256,
} from "../../lib/persistentLayoutProjection";
import { buildWorkspaceRecord } from "../../stores/workspaceFactory";
import type { GroupingUndoRepository } from "../../stores/groupingRuntimeStore";
import type { GridTemplateId, Pane, PaneTab, Workspace } from "../../types";
import {
  buildApplyReport,
  classifyStale,
  validateEditedPlan,
  type AnalysisBaselineEntry,
  type GroupingApplyReport,
  type GroupingExpectedResult,
  type GroupingPlan,
  type LayoutTransaction,
  type StaleIssue,
} from "./tabGrouping";

export {
  hashCanonical,
  persistentLayoutProjection,
  type PersistentLayoutProjection,
  type PersistentTabProjection,
  type Sha256,
} from "../../lib/persistentLayoutProjection";
export type PreviewId = string & { readonly __brand: "PreviewId" };

export interface NewWorkspaceDefaults {
  status?: Workspace["status"];
  pet?: Workspace["pet"];
  color?: Workspace["color"];
}

export interface GroupingCompileContext {
  baseline: readonly AnalysisBaselineEntry[];
  activeWorkspaceId: string | null;
  activeSessionId: string | null;
  allocationSeed: string;
  /** Fixed preview input; never read from a clock inside the compiler. */
  createdAt: number;
  /** Fixed preview input; Gate 2 will source this from the shared workspace factory. */
  newWorkspaceDefaults?: NewWorkspaceDefaults | Record<string, NewWorkspaceDefaults>;
}

export interface GroupingCommitTicket {
  schemaVersion: 1;
  schemaEpoch: number;
  issuanceId: string;
  previewId: PreviewId;
  planSignature: Sha256;
  inputSignature: Sha256;
  outputSignature: Sha256;
  context: GroupingCompileContext;
  transaction: LayoutTransaction;
}

interface IssuedTicketIdentity {
  previewId: PreviewId;
  schemaEpoch: number;
  transactionIdentity: Sha256;
}

export type GroupingCommitAttempt = object & { readonly __brand: "GroupingCommitAttempt" };

export type PrepareResult =
  | { ok: true; ticket: GroupingCommitTicket }
  | { ok: false; kind?: "schema_incompatible"; stale: StaleIssue[]; errors: string[] };

export type CommitFailureKind =
  | "preview_stale"
  | "plan_changed"
  | "invalid_input"
  | "commit_mismatch"
  | "rollback_failed"
  | "boundary_poisoned"
  | "schema_incompatible"
  | "operation_in_progress";

export type CommitResult =
  | { ok: true; report: GroupingApplyReport; transaction: LayoutTransaction }
  | {
    ok: false;
    kind: CommitFailureKind;
    stale?: StaleIssue[];
    errors: string[];
  };

export interface IdentityIssue {
  kind: "workspace" | "pane" | "tab" | "session" | "layout" | "selection";
  id: string;
  locations: string[];
}

export interface GroupingSelectionState {
  activeWorkspaceId: string | null;
  activeSessionId: string | null;
  /** Values are session ids in the current workspace-list store contract. */
  lastActivePaneByWorkspace: Record<string, string>;
}

export interface GroupingStateSnapshot {
  schemaVersion: 1;
  workspaces: Workspace[];
  selection: GroupingSelectionState;
}

export interface GroupingEngineDependencies {
  /** Stable identity for the underlying store boundary, shared by adapter wrappers. */
  boundaryToken: object;
  getWorkspaces: () => Workspace[];
  getSelection: () => GroupingSelectionState;
  /** The one destructive apply action. */
  replaceWorkspaces: (workspaces: Workspace[]) => void;
  /** Selection/focus adapter; verified after it runs. */
  applySelection: (selection: GroupingSelectionState) => void;
  /** Gate 2 supplies one atomic Zustand action for layout plus selection restore. */
  restoreGroupingState: (snapshot: GroupingStateSnapshot) => void;
  getLayoutRevision: () => number;
  undo: GroupingUndoRepository;
}

export interface GroupingIdAllocator {
  workspaceId(groupId: string): string;
  paneId(groupId: string, columnIndex: number, paneIndex: number): string;
}

type CompileResult =
  | { ok: true; transaction: LayoutTransaction }
  | { ok: false; errors: string[]; stale: StaleIssue[] };

interface CanonicalCompileInput {
  layout: PersistentLayoutProjection;
  baseline: AnalysisBaselineEntry[];
  activeWorkspaceId: string | null;
  activeSessionId: string | null;
  allocationSeed: string;
  createdAt: number;
  newWorkspaceDefaults: NewWorkspaceDefaults | Record<string, NewWorkspaceDefaults>;
}

export type UndoResult =
  | { ok: true }
  | {
      ok: false;
      kind: "post_undo_failed";
      layoutReverted: true;
      persistenceRequested?: false;
      reason: string;
    }
  | {
      ok: false;
      kind:
        | "missing"
        | "expired"
        | "restore_failed"
        | "boundary_poisoned"
        | "schema_incompatible"
        | "operation_in_progress"
        | "invalid_layout"
        | "unexpected_error";
      reason: string;
    };

export function createDeterministicGroupingAllocator(
  seed: string,
  planId: string,
): GroupingIdAllocator {
  const derive = (...parts: Array<string | number>) => (
    `tg-${sha256Hex([seed, planId, ...parts].join("\0")).slice(0, 24)}`
  );
  return {
    workspaceId: (groupId) => derive("workspace", groupId),
    paneId: (groupId, columnIndex, paneIndex) => (
      derive("pane", groupId, columnIndex, paneIndex)
    ),
  };
}

function duplicateIssues(
  kind: IdentityIssue["kind"],
  locationsById: Map<string, string[]>,
): IdentityIssue[] {
  return [...locationsById.entries()]
    .filter(([id, locations]) => Boolean(id) && locations.length > 1)
    .map(([id, locations]) => ({ kind, id, locations }));
}

function note(map: Map<string, string[]>, id: string, location: string): void {
  if (!id) return;
  map.set(id, [...(map.get(id) ?? []), location]);
}

function paneIdentityFieldsAreEmpty(item: Pane): boolean {
  return !item.activeTabId
    && !item.sessionId
    && !item.agentId
    && !item.cwd
    && !item.lastProcess
    && !item.claudeSessionId
    && !item.agentKind
    && !item.agentSessionId
    && (!item.suppressedAgentSessions || item.suppressedAgentSessions.length === 0)
    && (!item.launchEnv || Object.keys(item.launchEnv).length === 0)
    && !item.pinnedTabId;
}

type LayoutIdentityPhase = "input" | "output";

export function validateLayoutIdentity(
  workspaces: readonly Workspace[],
  phase: LayoutIdentityPhase = "input",
): IdentityIssue[] {
  const workspaceIds = new Map<string, string[]>();
  const paneIds = new Map<string, string[]>();
  const tabIds = new Map<string, string[]>();
  const sessionIds = new Map<string, string[]>();
  const entityIds = new Map<string, Array<{ kind: "workspace" | "pane"; location: string }>>();
  const issues: IdentityIssue[] = [];

  const requireId = (kind: IdentityIssue["kind"], id: string, location: string) => {
    if (!id) issues.push({ kind, id, locations: [location] });
  };
  const noteEntity = (kind: "workspace" | "pane", id: string, location: string) => {
    if (!id) return;
    entityIds.set(id, [...(entityIds.get(id) ?? []), { kind, location }]);
  };

  workspaces.forEach((workspace, workspaceIndex) => {
    const workspaceLocation = `workspaces[${workspaceIndex}]`;
    requireId("workspace", workspace.id, `${workspaceLocation}.id`);
    note(workspaceIds, workspace.id, workspaceLocation);
    noteEntity("workspace", workspace.id, workspaceLocation);
    if (workspace.status !== "setup" && workspace.status !== "running" && workspace.status !== "stopped") {
      issues.push({ kind: "layout", id: workspace.id, locations: [`${workspaceLocation}.status`] });
    }
    if (workspace.pet !== undefined && typeof workspace.pet !== "string") {
      issues.push({ kind: "layout", id: workspace.id, locations: [`${workspaceLocation}.pet`] });
    }
    if (workspace.color !== undefined && typeof workspace.color !== "string") {
      issues.push({ kind: "layout", id: workspace.id, locations: [`${workspaceLocation}.color`] });
    }
    if (workspace.panes.length === 0) {
      issues.push({ kind: "pane", id: "", locations: [`${workspaceLocation}.panes`] });
    }
    const paneIdSet = new Set(workspace.panes.map((item) => item.id));
    const splitColumns = workspace.splitColumns ?? [];
    if (phase === "output" && workspace.gridTemplateId !== deriveGridTemplateId(splitColumns)) {
      issues.push({
        kind: "layout",
        id: workspace.id,
        locations: [`${workspaceLocation}.gridTemplateId`],
      });
    }
    if (splitColumns.length > 4) {
      issues.push({
        kind: "layout",
        id: workspace.id,
        locations: [`${workspaceLocation}.splitColumns`],
      });
    }
    const splitIds = splitColumns.flat();
    splitColumns.forEach((column, columnIndex) => {
      if (column.length === 0) {
        issues.push({ kind: "pane", id: "", locations: [`${workspaceLocation}.splitColumns[${columnIndex}]`] });
      }
      if (column.length > 4) {
        issues.push({
          kind: "layout",
          id: workspace.id,
          locations: [`${workspaceLocation}.splitColumns[${columnIndex}]`],
        });
      }
    });
    const splitCounts = new Map<string, number>();
    splitIds.forEach((id) => splitCounts.set(id, (splitCounts.get(id) ?? 0) + 1));
    for (const paneId of paneIdSet) {
      if (splitCounts.get(paneId) !== 1) {
        issues.push({ kind: "pane", id: paneId, locations: [`${workspaceLocation}.splitColumns`] });
      }
    }
    for (const paneId of splitIds) {
      if (!paneIdSet.has(paneId) || (splitCounts.get(paneId) ?? 0) > 1) {
        issues.push({ kind: "pane", id: paneId, locations: [`${workspaceLocation}.splitColumns`] });
      }
    }

    workspace.panes.forEach((itemPane, paneIndex) => {
      const paneLocation = `${workspaceLocation}.panes[${paneIndex}]`;
      requireId("pane", itemPane.id, `${paneLocation}.id`);
      note(paneIds, itemPane.id, paneLocation);
      noteEntity("pane", itemPane.id, paneLocation);
      const ownTabIds = new Set(itemPane.tabs.map((item) => item.id));
      if (itemPane.activeTabId && !ownTabIds.has(itemPane.activeTabId)) {
        issues.push({ kind: "tab", id: itemPane.activeTabId, locations: [`${paneLocation}.activeTabId`] });
      }
      if (itemPane.tabs.length === 0 && !paneIdentityFieldsAreEmpty(itemPane)) {
        issues.push({ kind: "pane", id: itemPane.id, locations: [`${paneLocation}.emptyIdentity`] });
      }
      if (itemPane.tabs.length > 0) {
        const active = itemPane.tabs.find((item) => item.id === itemPane.activeTabId);
        if (active && itemPane.sessionId !== active.sessionId) {
          issues.push({ kind: "session", id: itemPane.sessionId, locations: [`${paneLocation}.sessionId`] });
        }
      }
      itemPane.tabs.forEach((itemTab, tabIndex) => {
        const tabLocation = `${paneLocation}.tabs[${tabIndex}]`;
        requireId("tab", itemTab.id, `${tabLocation}.id`);
        note(tabIds, itemTab.id, tabLocation);
        if ((itemTab.type === undefined || itemTab.type === "terminal") && itemTab.lifecycle !== "declared") {
          requireId("session", itemTab.sessionId, `${tabLocation}.sessionId`);
          note(sessionIds, itemTab.sessionId, tabLocation);
        }
      });
    });
  });

  const crossKindIssues = [...entityIds.entries()]
    .filter(([, entries]) => new Set(entries.map((entry) => entry.kind)).size > 1)
    .map(([id, entries]): IdentityIssue => ({
      kind: entries[0].kind,
      id,
      locations: entries.map((entry) => entry.location),
    }));

  return [
    ...duplicateIssues("workspace", workspaceIds),
    ...duplicateIssues("pane", paneIds),
    ...duplicateIssues("tab", tabIds),
    ...duplicateIssues("session", sessionIds),
    ...crossKindIssues,
    ...issues,
  ];
}

export function validateGroupingStateSnapshot(snapshot: GroupingStateSnapshot): IdentityIssue[] {
  const issues = validateLayoutIdentity(snapshot.workspaces);
  const workspaceIds = new Set(snapshot.workspaces.map((workspace) => workspace.id));
  const sessionWorkspaceIds = new Map<string, Set<string>>();
  for (const workspace of snapshot.workspaces) {
    for (const itemPane of workspace.panes) {
      for (const itemTab of itemPane.tabs) {
        if (!itemTab.sessionId) continue;
        const owners = sessionWorkspaceIds.get(itemTab.sessionId) ?? new Set<string>();
        owners.add(workspace.id);
        sessionWorkspaceIds.set(itemTab.sessionId, owners);
      }
    }
  }
  const { selection } = snapshot;
  if (selection.activeWorkspaceId !== null && !workspaceIds.has(selection.activeWorkspaceId)) {
    issues.push({
      kind: "selection",
      id: selection.activeWorkspaceId,
      locations: ["selection.activeWorkspaceId"],
    });
  }
  if (selection.activeSessionId !== null) {
    const owners = sessionWorkspaceIds.get(selection.activeSessionId);
    if (selection.activeWorkspaceId === null || !owners?.has(selection.activeWorkspaceId)) {
      issues.push({
        kind: "selection",
        id: selection.activeSessionId,
        locations: ["selection.activeSessionId"],
      });
    }
  }
  for (const [workspaceId, sessionId] of Object.entries(selection.lastActivePaneByWorkspace)) {
    if (!workspaceIds.has(workspaceId) || !sessionWorkspaceIds.get(sessionId)?.has(workspaceId)) {
      issues.push({
        kind: "selection",
        id: sessionId,
        locations: [`selection.lastActivePaneByWorkspace.${workspaceId}`],
      });
    }
  }
  return issues;
}

export function normalizeGroupingStateSnapshot(
  snapshot: GroupingStateSnapshot,
  scope = "snapshot",
  options: { repairCrossWorkspaceActiveSession?: boolean } = {},
): GroupingStateSnapshot {
  const normalized = structuredClone(snapshot);
  const repairCrossWorkspaceActiveSession = options.repairCrossWorkspaceActiveSession ?? true;
  const sessionsByWorkspace = new Map<string, string[]>();
  for (const workspace of normalized.workspaces) {
    sessionsByWorkspace.set(
      workspace.id,
      workspace.panes.flatMap((itemPane) => itemPane.tabs.map((itemTab) => itemTab.sessionId).filter(Boolean)),
    );
  }
  const allSessions = new Set([...sessionsByWorkspace.values()].flat());
  const changes: Array<Record<string, string | null>> = [];
  for (const [workspaceId, sessionId] of Object.entries(normalized.selection.lastActivePaneByWorkspace)) {
    const sessions = sessionsByWorkspace.get(workspaceId);
    if (sessions?.includes(sessionId)) continue;
    delete normalized.selection.lastActivePaneByWorkspace[workspaceId];
    changes.push({ kind: "lastActivePaneByWorkspace", workspaceId, sessionId, replacement: null });
  }
  const activeWorkspaceId = normalized.selection.activeWorkspaceId;
  if (activeWorkspaceId === null) {
    if (normalized.selection.activeSessionId !== null) {
      changes.push({
        kind: "activeSessionId",
        workspaceId: null,
        sessionId: normalized.selection.activeSessionId,
        replacement: null,
      });
      normalized.selection.activeSessionId = null;
    }
  } else {
    const sessions = sessionsByWorkspace.get(activeWorkspaceId);
    const activeSessionId = normalized.selection.activeSessionId;
    if (sessions
      && activeSessionId !== null
      && !sessions.includes(activeSessionId)
      && (repairCrossWorkspaceActiveSession || !allSessions.has(activeSessionId))) {
      const fallback = normalized.selection.lastActivePaneByWorkspace[activeWorkspaceId]
        || normalized.workspaces.find((workspace) => workspace.id === activeWorkspaceId)?.panes[0]?.sessionId
        || null;
      if (fallback !== activeSessionId) {
        changes.push({
          kind: "activeSessionId",
          workspaceId: activeWorkspaceId,
          sessionId: activeSessionId,
          replacement: fallback,
        });
        normalized.selection.activeSessionId = fallback;
      }
    }
  }
  if (changes.length > 0) {
    console.warn("[mycmux] tab grouping normalized dangling selection", { scope, changes });
  }
  return normalized;
}

function normalizeGroupingCompileContext(
  workspaces: readonly Workspace[],
  context: GroupingCompileContext,
  scope: string,
): GroupingCompileContext {
  const normalized = normalizeGroupingStateSnapshot({
    schemaVersion: 1,
    workspaces: structuredClone(workspaces) as Workspace[],
    selection: {
      activeWorkspaceId: context.activeWorkspaceId,
      activeSessionId: context.activeSessionId,
      lastActivePaneByWorkspace: {},
    },
  }, scope);
  return {
    ...structuredClone(context),
    activeWorkspaceId: normalized.selection.activeWorkspaceId,
    activeSessionId: normalized.selection.activeSessionId,
  };
}

function identityIssueError(issue: IdentityIssue): string {
  return `identity ${issue.kind}: ${issue.id} at ${issue.locations.join(", ")}`;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
  const objectValue = value as object;
  if (seen.has(objectValue)) return value;
  seen.add(objectValue);
  for (const key of Reflect.ownKeys(objectValue)) {
    deepFreeze((objectValue as Record<PropertyKey, unknown>)[key], seen);
  }
  return Object.freeze(value);
}

function deriveGridTemplateId(splitColumns: readonly (readonly string[])[]): GridTemplateId {
  const cols = Math.max(1, Math.min(4, splitColumns.length));
  const rows = Math.max(1, Math.min(4, Math.max(1, ...splitColumns.map((column) => column.length))));
  if (cols === 1 && rows === 1) return "1x1";
  if (cols === 1 && rows === 2) return "1x2";
  if (cols === 2 && rows === 1) return "2x1";
  if (cols === 2 && rows === 2) return "2x2";
  if (cols === 3 && rows === 1) return "3x1";
  if (cols === 3 && rows === 2) return "3x2";
  if (cols === 2 && rows === 3) return "2x3";
  if (cols === 3 && rows === 3) return "3x3";
  if (cols === 4 && rows === 1) return "4x1";
  if (cols === 4 && rows === 4) return "4x4";
  return "4x4";
}

function gridTemplateDriftIssues(workspaces: readonly Workspace[]): IdentityIssue[] {
  return workspaces.flatMap((workspace, workspaceIndex) => (
    workspace.gridTemplateId === deriveGridTemplateId(workspace.splitColumns ?? [])
      ? []
      : [{
          kind: "layout" as const,
          id: workspace.id,
          locations: [`workspaces[${workspaceIndex}].gridTemplateId`],
        }]
  ));
}

function equalSizes(count: number): number[] {
  return Array.from({ length: count }, () => DEFAULT_LAYOUT_SIZE);
}

function normalizeColumns(columns: readonly string[][], panes: readonly Pane[]): string[][] {
  const valid = new Set(panes.map((item) => item.id));
  const seen = new Set<string>();
  const result = columns
    .map((column) => column.filter((id) => valid.has(id) && !seen.has(id) && Boolean(seen.add(id))))
    .filter((column) => column.length > 0);
  const missing = panes.map((item) => item.id).filter((id) => !seen.has(id));
  if (missing.length > 0) result.push(...missing.map((id) => [id]));
  return result.length > 0 ? result : [[]];
}

function blankPane(item: Pane): Pane {
  return {
    ...item,
    agentId: "",
    sessionId: "",
    activeTabId: "",
    tabs: [],
    cwd: undefined,
    lastProcess: undefined,
    claudeSessionId: undefined,
    agentKind: undefined,
    agentSessionId: undefined,
    suppressedAgentSessions: undefined,
    launchEnv: undefined,
    pinnedTabId: undefined,
  };
}

function applyActiveTab(item: Pane, active: PaneTab): Pane {
  return {
    ...item,
    agentId: active.agentId,
    sessionId: active.sessionId,
    activeTabId: active.id,
    cwd: active.cwd,
    lastProcess: active.lastProcess,
    claudeSessionId: active.claudeSessionId,
    agentKind: active.agentKind,
    agentSessionId: active.agentSessionId,
    suppressedAgentSessions: active.suppressedAgentSessions,
    launchEnv: active.launchEnv,
  };
}

function paneFromTabs(id: string, tabs: PaneTab[], label: string, preferredTabId: string | null): Pane {
  const active = tabs.find((item) => item.id === preferredTabId) ?? tabs[0];
  if (!active) return blankPane({ id, agentId: "", sessionId: "", activeTabId: "", tabs, label });
  return applyActiveTab({ id, agentId: "", sessionId: "", activeTabId: "", tabs, label }, active);
}

function pruneWorkspace(workspace: Workspace): Workspace {
  const nonEmpty = workspace.panes.filter((item) => item.tabs.length > 0);
  const panes = nonEmpty.length > 0
    ? nonEmpty.map((item) => {
      const active = item.tabs.find((tab) => tab.id === item.activeTabId) ?? item.tabs[0];
      return applyActiveTab({ ...item, pinnedTabId: item.tabs.some((tab) => tab.id === item.pinnedTabId) ? item.pinnedTabId : undefined }, active);
    })
    : workspace.panes.slice(0, 1).map(blankPane);
  return { ...workspace, panes, splitColumns: normalizeColumns(workspace.splitColumns ?? [], panes) };
}

function metricsFor(previous: Workspace | undefined, next: Workspace): Workspace {
  const columns = normalizeColumns(next.splitColumns ?? [], next.panes);
  const previousColumns = previous?.splitColumns ?? [];
  const previousWidths = previous?.columnWidths ?? [];
  const previousRows = previous?.rowHeightsPerCol ?? [];
  const columnWidths = columns.map((column) => {
    const priorIndex = previousColumns.findIndex((candidate) => candidate.some((id) => column.includes(id)));
    return priorIndex >= 0 ? previousWidths[priorIndex] ?? DEFAULT_LAYOUT_SIZE : DEFAULT_LAYOUT_SIZE;
  });
  const rowHeightsPerCol = columns.map((column) => {
    const priorIndex = previousColumns.findIndex((candidate) => candidate.length === column.length
      && candidate.every((id, index) => id === column[index]));
    return priorIndex >= 0 && previousRows[priorIndex]?.length === column.length
      ? [...previousRows[priorIndex]]
      : equalSizes(column.length);
  });
  return {
    ...next,
    splitColumns: columns,
    gridTemplateId: deriveGridTemplateId(columns),
    columnWidths,
    rowHeightsPerCol,
  };
}

function tabIndex(workspaces: readonly Workspace[]): Map<string, { workspace: Workspace; pane: Pane; tab: PaneTab }> {
  const result = new Map<string, { workspace: Workspace; pane: Pane; tab: PaneTab }>();
  for (const workspace of workspaces) {
    for (const itemPane of workspace.panes) {
      for (const itemTab of itemPane.tabs) result.set(itemTab.id, { workspace, pane: itemPane, tab: itemTab });
    }
  }
  return result;
}

function selectedTabId(workspaces: readonly Workspace[], activeSessionId: string | null): string | null {
  if (!activeSessionId) return null;
  for (const workspace of workspaces) {
    for (const itemPane of workspace.panes) {
      const found = itemPane.tabs.find((item) => item.sessionId === activeSessionId);
      if (found) return found.id;
    }
  }
  return null;
}

function defaultsFor(context: GroupingCompileContext, groupId: string): NewWorkspaceDefaults {
  const value = context.newWorkspaceDefaults;
  if (!value) return {};
  const hasPerGroupValue = Object.values(value).some((item) => (
    item !== null && typeof item === "object" && !Array.isArray(item)
  ));
  if (!hasPerGroupValue) return value as NewWorkspaceDefaults;
  if (!Object.prototype.hasOwnProperty.call(value, groupId)) return {};
  const defaults = (value as Record<string, NewWorkspaceDefaults>)[groupId];
  return defaults && typeof defaults === "object" && !Array.isArray(defaults) ? defaults : {};
}

function canonicalPlan(plan: GroupingPlan): unknown {
  return canonicalize(plan);
}

function canonicalCompileInput(
  workspaces: readonly Workspace[],
  context: GroupingCompileContext,
): CanonicalCompileInput {
  return {
    layout: persistentLayoutProjection(workspaces),
    baseline: context.baseline.map((entry) => ({
      tabId: entry.tabId,
      sessionId: entry.sessionId,
      workspaceId: entry.workspaceId,
      paneId: entry.paneId,
    })),
    activeWorkspaceId: context.activeWorkspaceId,
    activeSessionId: context.activeSessionId,
    allocationSeed: context.allocationSeed,
    createdAt: context.createdAt,
    newWorkspaceDefaults: context.newWorkspaceDefaults ?? {},
  };
}

function compileGroupingPlanCore(
  plan: GroupingPlan,
  input: CanonicalCompileInput,
): CompileResult {
  const current = structuredClone(input.layout.workspaces) as Workspace[];
  const nonEmptyWorkspaceIds = new Set(current
    .filter((workspace) => workspace.panes.some((item) => item.tabs.length > 0))
    .map((workspace) => workspace.id));
  const context: GroupingCompileContext = {
    baseline: structuredClone(input.baseline),
    activeWorkspaceId: input.activeWorkspaceId,
    activeSessionId: input.activeSessionId,
    allocationSeed: input.allocationSeed,
    createdAt: input.createdAt,
    newWorkspaceDefaults: structuredClone(input.newWorkspaceDefaults),
  };
  const inputIssues = validateLayoutIdentity(current);
  if (inputIssues.length > 0) {
    return { ok: false, errors: inputIssues.map(identityIssueError), stale: [] };
  }
  const adopted = plan.groups.filter((group) => (
    group.adopted
    && group.disposition === "reorganize"
    && group.layout
    && group.destination.kind !== "current_locations"
  ));
  const targetIds = new Set(adopted.flatMap((group) => group.layout!.columns.flatMap((column) => (
    column.panes.flatMap((itemPane) => itemPane.tabIds)
  ))));
  const destinations = new Set(adopted.flatMap((group) => (
    group.destination.kind === "existing_workspace" ? [group.destination.workspaceId] : []
  )));
  const stale = classifyStale(context.baseline, current, targetIds, destinations);
  if (stale.length > 0) return { ok: false, errors: [], stale };
  const errors = validateEditedPlan(
    plan,
    context.baseline.map((entry) => entry.tabId),
    current.map((workspace) => workspace.id),
    current.map((workspace) => workspace.name),
  );
  if (errors.length > 0) return { ok: false, errors, stale: [] };

  const existingEntityIds = new Set([
    ...current.map((workspace) => workspace.id),
    ...current.flatMap((workspace) => workspace.panes.map((item) => item.id)),
  ]);
  const generatedEntityIds = new Set<string>();
  const allocator = createDeterministicGroupingAllocator(context.allocationSeed, plan.planId);
  const noteGeneratedId = (id: string) => {
    if (existingEntityIds.has(id) || generatedEntityIds.has(id)) {
      errors.push(`allocationSeed collision: ${id}`);
    }
    generatedEntityIds.add(id);
  };
  for (const group of adopted) {
    const workspaceId = group.destination.kind === "new_workspace" ? allocator.workspaceId(group.groupId) : null;
    if (workspaceId) noteGeneratedId(workspaceId);
    if (group.layout!.columns.length > 4) errors.push(`グループ ${group.groupId} の列数が4を超えます`);
    group.layout!.columns.forEach((column, columnIndex) => {
      if (column.panes.length > 4) errors.push(`グループ ${group.groupId} の1列あたりペイン数が4を超えます`);
      column.panes.forEach((_itemPane, paneIndex) => {
        noteGeneratedId(allocator.paneId(group.groupId, columnIndex, paneIndex));
      });
    });
  }
  if (errors.length > 0) return { ok: false, errors, stale: [] };

  const sourceIndex = tabIndex(current);
  const moved = new Map<string, PaneTab>();
  for (const id of targetIds) {
    const found = sourceIndex.get(id);
    if (!found) return { ok: false, errors: [`タブ ${id} が見つかりません`], stale: [] };
    moved.set(id, structuredClone(found.tab));
  }
  const preferredTabId = selectedTabId(current, context.activeSessionId);
  const next = current.map((workspace) => pruneWorkspace({
    ...workspace,
    panes: workspace.panes.map((itemPane) => ({
      ...itemPane,
      tabs: itemPane.tabs.filter((item) => !targetIds.has(item.id)),
    })),
  }));
  const modified = new Set<string>();
  const newWorkspaces: Workspace[] = [];

  for (const group of adopted) {
    const columns: string[][] = [];
    const panes: Pane[] = [];
    group.layout!.columns.forEach((column, columnIndex) => {
      const columnIds: string[] = [];
      column.panes.forEach((spec, paneIndex) => {
        const paneId = allocator.paneId(group.groupId, columnIndex, paneIndex);
        const tabs = spec.tabIds.map((id) => moved.get(id)).filter((item): item is PaneTab => Boolean(item));
        panes.push(paneFromTabs(paneId, tabs, spec.title, preferredTabId));
        columnIds.push(paneId);
      });
      columns.push(columnIds);
    });
    if (group.destination.kind === "new_workspace") {
      const defaults = defaultsFor(context, group.groupId);
      const workspaceId = allocator.workspaceId(group.groupId);
      newWorkspaces.push(buildWorkspaceRecord({
        id: workspaceId,
        name: group.destination.proposedName,
        gridTemplateId: deriveGridTemplateId(columns),
        panes,
        splitColumns: columns,
        status: defaults.status ?? "running",
        createdAt: context.createdAt,
        color: defaults.color,
        pet: defaults.pet,
      }));
    } else if (group.destination.kind === "existing_workspace") {
      const destinationWorkspaceId = group.destination.workspaceId;
      const index = next.findIndex((workspace) => workspace.id === destinationWorkspaceId);
      if (index < 0) return { ok: false, errors: [], stale: classifyStale(context.baseline, current, targetIds, destinations) };
      const mergedColumns = [...(next[index].splitColumns ?? []), ...columns];
      if (mergedColumns.length > 4) {
        return { ok: false, errors: [`ワークスペース ${next[index].id} の列数が4を超えます`], stale: [] };
      }
      next[index] = pruneWorkspace({
        ...next[index],
        panes: [...next[index].panes, ...panes],
        splitColumns: mergedColumns,
      });
      modified.add(next[index].id);
    }
  }

  const previousById = new Map(current.map((workspace) => [workspace.id, workspace]));
  for (const workspace of current) {
    const nextWorkspace = next.find((candidate) => candidate.id === workspace.id);
    if (!nextWorkspace) continue;
    const before = workspace.panes.flatMap((item) => item.tabs.map((itemTab) => itemTab.id)).join("\0");
    const after = nextWorkspace.panes.flatMap((item) => item.tabs.map((itemTab) => itemTab.id)).join("\0");
    if (before !== after) modified.add(workspace.id);
  }
  const result = [
    ...next.map((workspace) => modified.has(workspace.id)
      ? metricsFor(previousById.get(workspace.id), workspace)
      : workspace),
    ...newWorkspaces,
  ].map((workspace) => ({
    ...workspace,
    gridTemplateId: deriveGridTemplateId(workspace.splitColumns ?? []),
  }));
  const outputIssues = validateLayoutIdentity(result, "output");
  if (outputIssues.length > 0) {
    return { ok: false, errors: outputIssues.map(identityIssueError), stale: [] };
  }

  const tabs: GroupingExpectedResult["tabs"] = {};
  const activeTabs: GroupingExpectedResult["activeTabs"] = {};
  const splitColumns: GroupingExpectedResult["splitColumns"] = {};
  for (const workspace of result) {
    splitColumns[workspace.id] = structuredClone(workspace.splitColumns ?? []);
    for (const itemPane of workspace.panes) {
      const active = itemPane.tabs.find((item) => item.id === itemPane.activeTabId);
      if (active) activeTabs[itemPane.id] = { paneId: itemPane.id, tabId: active.id, sessionId: active.sessionId };
      for (const itemTab of itemPane.tabs) {
        tabs[itemTab.id] = { workspaceId: workspace.id, paneId: itemPane.id, sessionId: itemTab.sessionId };
      }
    }
  }
  const focus = preferredTabId ? tabs[preferredTabId] : undefined;
  const focusMoved = Boolean(preferredTabId && targetIds.has(preferredTabId));
  const deferred = new Set(plan.groups.filter((group) => !group.adopted || group.disposition === "keep")
    .flatMap((group) => group.tabIds));
  const kept = context.baseline.map((entry) => entry.tabId)
    .filter((id) => !targetIds.has(id) && !plan.unassignedTabIds.includes(id));

  return {
    ok: true,
    transaction: {
      workspaces: result,
      expected: {
        tabs,
        movedTabIds: [...targetIds],
        keptTabIds: [...new Set([...kept, ...deferred])].filter((id) => !targetIds.has(id)),
        unassignedTabIds: [...plan.unassignedTabIds],
        emptyWorkspaceIds: result.filter((workspace) => (
          nonEmptyWorkspaceIds.has(workspace.id)
          && workspace.panes.every((item) => item.tabs.length === 0)
        ))
          .map((workspace) => workspace.id),
        newWorkspaceIds: newWorkspaces.map((workspace) => workspace.id),
        focusWorkspaceId: focusMoved && focus ? focus.workspaceId : context.activeWorkspaceId,
        focusSessionId: focusMoved && focus ? focus.sessionId : context.activeSessionId,
        focusTabId: focusMoved ? preferredTabId : null,
        splitColumns,
        activeTabs,
      },
    },
  };
}

function selectionSignature(selection: GroupingSelectionState): Sha256 {
  return hashCanonical(selection);
}

function structuralTabProjection(tab: PaneTab) {
  // lifecycle is structural: a declared tab has no live terminal yet, so a
  // launch must move the signature or undo would roll a live tab back to
  // "declared" (G3-1c closure audit NEW-HIGH-01).
  return { id: tab.id, sessionId: tab.sessionId, type: tab.type, lifecycle: tab.lifecycle ?? null };
}

function structuralUndoProjection(workspaces: readonly Workspace[]): unknown {
  return workspaces.map((workspace) => ({
    id: workspace.id,
    name: workspace.name,
    gridTemplateId: workspace.gridTemplateId,
    status: workspace.status,
    createdAt: workspace.createdAt,
    color: workspace.color,
    pet: workspace.pet,
    splitColumns: workspace.splitColumns ?? [],
    columnWidths: workspace.columnWidths ?? [],
    rowHeightsPerCol: workspace.rowHeightsPerCol ?? [],
    panes: workspace.panes.map((itemPane) => ({
      id: itemPane.id,
      label: itemPane.label,
      pinnedTabId: itemPane.pinnedTabId,
      tabs: itemPane.tabs.map(structuralTabProjection),
    })),
  }));
}

export function structuralUndoSignature(workspaces: readonly Workspace[]): Sha256 {
  return hashCanonical(structuralUndoProjection(workspaces));
}

function targetTabIds(plan: GroupingPlan): Set<string> {
  return new Set(plan.groups.filter((group) => group.adopted && group.disposition === "reorganize" && group.layout)
    .flatMap((group) => group.layout!.columns.flatMap((column) => column.panes.flatMap((item) => item.tabIds))));
}

function destinationWorkspaceIds(plan: GroupingPlan): Set<string> {
  return new Set(plan.groups.filter((group) => group.adopted && group.destination.kind === "existing_workspace")
    .map((group) => group.destination.kind === "existing_workspace" ? group.destination.workspaceId : "")
    .filter(Boolean));
}

function expectedSelection(
  before: GroupingSelectionState,
  expected: GroupingExpectedResult,
  workspaces: readonly Workspace[],
): GroupingSelectionState {
  const sessionExists = (workspaceId: string, sessionId: string) => workspaces.some((workspace) => (
    workspace.id === workspaceId
    && workspace.panes.some((pane) => pane.tabs.some((tab) => tab.sessionId === sessionId))
  ));
  const lastActivePaneByWorkspace = Object.fromEntries(
    Object.entries(before.lastActivePaneByWorkspace)
      .filter(([workspaceId, sessionId]) => sessionExists(workspaceId, sessionId)),
  );
  const result: GroupingSelectionState = {
    activeWorkspaceId: expected.focusWorkspaceId,
    activeSessionId: expected.focusSessionId,
    lastActivePaneByWorkspace,
  };
  if (expected.focusWorkspaceId && expected.focusSessionId) {
    result.lastActivePaneByWorkspace[expected.focusWorkspaceId] = expected.focusSessionId;
  }
  return result;
}

function expectedResultErrors(
  plan: GroupingPlan,
  before: readonly Workspace[],
  transaction: LayoutTransaction,
  context: GroupingCompileContext,
): string[] {
  const errors: string[] = [];
  const targetIds = targetTabIds(plan);
  const actualTabs: GroupingExpectedResult["tabs"] = {};
  const actualActiveTabs: GroupingExpectedResult["activeTabs"] = {};
  const actualSplitColumns: GroupingExpectedResult["splitColumns"] = {};
  for (const workspace of transaction.workspaces) {
    actualSplitColumns[workspace.id] = structuredClone(workspace.splitColumns ?? []);
    for (const pane of workspace.panes) {
      const active = pane.tabs.find((tab) => tab.id === pane.activeTabId);
      if (active) actualActiveTabs[pane.id] = { paneId: pane.id, tabId: active.id, sessionId: active.sessionId };
      for (const tab of pane.tabs) {
        actualTabs[tab.id] = { workspaceId: workspace.id, paneId: pane.id, sessionId: tab.sessionId };
      }
    }
  }
  const same = (left: unknown, right: unknown) => hashCanonical(left) === hashCanonical(right);
  const sameIds = (left: readonly string[], right: readonly string[]) => (
    [...left].sort().join("\0") === [...right].sort().join("\0")
  );
  if (!same(transaction.expected.tabs, actualTabs)) errors.push("expected tabs metricsが実レイアウトと一致しません");
  if (!same(transaction.expected.splitColumns, actualSplitColumns)) errors.push("expected splitColumnsが実レイアウトと一致しません");
  if (!same(transaction.expected.activeTabs, actualActiveTabs)) errors.push("expected activeTabsが実レイアウトと一致しません");
  if (!sameIds(transaction.expected.movedTabIds, [...targetIds])) errors.push("moved metricsが再計算値と一致しません");
  if (!sameIds(transaction.expected.unassignedTabIds, plan.unassignedTabIds)) errors.push("unassigned metricsが再計算値と一致しません");
  const deferred = new Set(plan.groups.filter((group) => !group.adopted || group.disposition === "keep")
    .flatMap((group) => group.tabIds));
  const expectedKept = [...new Set([
    ...context.baseline.map((entry) => entry.tabId)
      .filter((id) => !targetIds.has(id) && !plan.unassignedTabIds.includes(id)),
    ...deferred,
  ])].filter((id) => !targetIds.has(id));
  if (!sameIds(transaction.expected.keptTabIds, expectedKept)) errors.push("kept metricsが再計算値と一致しません");
  const nonEmptyBeforeWorkspaceIds = new Set(before
    .filter((workspace) => workspace.panes.some((pane) => pane.tabs.length > 0))
    .map((workspace) => workspace.id));
  const expectedEmpty = transaction.workspaces
    .filter((workspace) => (
      nonEmptyBeforeWorkspaceIds.has(workspace.id)
      && workspace.panes.every((pane) => pane.tabs.length === 0)
    ))
    .map((workspace) => workspace.id);
  if (!sameIds(transaction.expected.emptyWorkspaceIds, expectedEmpty)) errors.push("empty workspace metricsが再計算値と一致しません");
  const beforeIds = new Set(before.map((workspace) => workspace.id));
  const expectedNew = transaction.workspaces.filter((workspace) => !beforeIds.has(workspace.id)).map((workspace) => workspace.id);
  if (!sameIds(transaction.expected.newWorkspaceIds, expectedNew)) errors.push("new workspace metricsが再計算値と一致しません");

  const activeTabId = selectedTabId(before, context.activeSessionId);
  const activeWasMoved = Boolean(activeTabId && targetIds.has(activeTabId));
  const activeLocation = activeTabId ? actualTabs[activeTabId] : undefined;
  const expectedFocus = {
    workspaceId: activeWasMoved && activeLocation ? activeLocation.workspaceId : context.activeWorkspaceId,
    sessionId: activeWasMoved && activeLocation ? activeLocation.sessionId : context.activeSessionId,
    tabId: activeWasMoved ? activeTabId : null,
  };
  if (transaction.expected.focusWorkspaceId !== expectedFocus.workspaceId
    || transaction.expected.focusSessionId !== expectedFocus.sessionId
    || transaction.expected.focusTabId !== expectedFocus.tabId) {
    errors.push("focus metricsが再計算値と一致しません");
  }
  return errors;
}

function persistentSignature(workspaces: readonly Workspace[]): Sha256 {
  return persistentLayoutSignature(workspaces);
}

function previewIdFor(
  planSignature: Sha256,
  inputSignature: Sha256,
  allocationSeed: string,
): PreviewId {
  return `preview-${sha256Hex([planSignature, inputSignature, allocationSeed].join("\0")).slice(0, 24)}` as PreviewId;
}

function snapshotFrom(deps: GroupingEngineDependencies): GroupingStateSnapshot {
  return {
    schemaVersion: 1,
    workspaces: structuredClone(deps.getWorkspaces()),
    selection: structuredClone(deps.getSelection()),
  };
}

function sameState(actual: GroupingStateSnapshot, expected: GroupingStateSnapshot): boolean {
  return persistentSignature(actual.workspaces) === persistentSignature(expected.workspaces)
    && selectionSignature(actual.selection) === selectionSignature(expected.selection);
}

function selectionPreservingSnapshot(
  snapshot: GroupingStateSnapshot,
  live: GroupingSelectionState,
  liveWorkspaces: readonly Workspace[],
): GroupingStateSnapshot {
  const workspaces = structuredClone(snapshot.workspaces);
  const findSession = (sessionId: string | null) => {
    if (!sessionId) return null;
    for (const workspace of workspaces) {
      for (const itemPane of workspace.panes) {
        const itemTab = itemPane.tabs.find((tab) => tab.sessionId === sessionId);
        if (itemTab) return { workspace, pane: itemPane, tab: itemTab };
      }
    }
    return null;
  };
  const findLiveTab = (tabId: string) => liveWorkspaces
    .flatMap((workspace) => workspace.panes.flatMap((pane) => pane.tabs))
    .find((tab) => tab.id === tabId);
  for (const workspace of workspaces) {
    for (const itemPane of workspace.panes) {
      itemPane.tabs = itemPane.tabs.map((tab) => {
        const liveTab = findLiveTab(tab.id);
        if (!liveTab) return tab;
        if (tab.type === "browser" || tab.type === "online") return structuredClone(liveTab);
        return {
          ...structuredClone(liveTab),
          id: tab.id,
          sessionId: tab.sessionId,
          type: tab.type,
          lifecycle: tab.lifecycle,
        };
      });
    }
  }
  const selectedSessions = liveWorkspaces.flatMap((workspace) => workspace.panes.flatMap((pane) => {
    const activeTab = pane.tabs.find((tab) => tab.id === pane.activeTabId);
    return activeTab ? [activeTab.sessionId] : [];
  }));
  for (const sessionId of [...selectedSessions, ...Object.values(live.lastActivePaneByWorkspace)]) {
    const selected = findSession(sessionId);
    if (selected) Object.assign(selected.pane, applyActiveTab(selected.pane, selected.tab));
  }
  const active = findSession(live.activeSessionId);
  const restoredActive = active ?? findSession(snapshot.selection.activeSessionId);
  if (restoredActive) Object.assign(restoredActive.pane, applyActiveTab(restoredActive.pane, restoredActive.tab));
  const lastActivePaneByWorkspace: Record<string, string> = {};
  for (const sessionId of Object.values(live.lastActivePaneByWorkspace)) {
    const found = findSession(sessionId);
    if (found) lastActivePaneByWorkspace[found.workspace.id] = sessionId;
  }
  for (const [workspaceId, sessionId] of Object.entries(snapshot.selection.lastActivePaneByWorkspace)) {
    if (lastActivePaneByWorkspace[workspaceId]) continue;
    const found = findSession(sessionId);
    if (found?.workspace.id === workspaceId) lastActivePaneByWorkspace[workspaceId] = sessionId;
  }
  if (restoredActive) {
    lastActivePaneByWorkspace[restoredActive.workspace.id] = restoredActive.tab.sessionId;
  }
  const activeWorkspaceExists = workspaces.some((workspace) => workspace.id === live.activeWorkspaceId);
  return {
    schemaVersion: 1,
    workspaces,
    selection: {
      activeWorkspaceId: restoredActive?.workspace.id
        ?? (activeWorkspaceExists ? live.activeWorkspaceId : snapshot.selection.activeWorkspaceId),
      activeSessionId: restoredActive?.tab.sessionId ?? null,
      lastActivePaneByWorkspace,
    },
  };
}

export interface GroupingEngine {
  compileGroupingPlan(plan: GroupingPlan, current: readonly Workspace[], context: GroupingCompileContext): CompileResult;
  prepareGroupingCommit(
    plan: GroupingPlan,
    current: readonly Workspace[],
    context: GroupingCompileContext,
    schemaEpoch?: number,
  ): PrepareResult;
  claimPreparedGroupingCommit(ticket: GroupingCommitTicket):
    | { ok: true; attempt: GroupingCommitAttempt }
    | Extract<CommitResult, { ok: false }>;
  commitClaimedGrouping(
    plan: GroupingPlan,
    attempt: GroupingCommitAttempt,
    deps: GroupingEngineDependencies,
  ): CommitResult;
  commitPreparedGrouping(plan: GroupingPlan, ticket: GroupingCommitTicket, deps: GroupingEngineDependencies): CommitResult;
  restoreGroupingUndo(deps: GroupingEngineDependencies): UndoResult;
  hasGroupingUndo(deps: GroupingEngineDependencies): boolean;
}

const poisonedBoundaries = new WeakSet<object>();
let groupingUndoRecordSequence = 0;
const MAX_OUTSTANDING_GROUPING_TICKETS = 256;

export function createGroupingEngine(): GroupingEngine {
  const issuedTickets = new Map<string, IssuedTicketIdentity>();
  const claimedTickets = new WeakMap<GroupingCommitAttempt, {
    ticket: GroupingCommitTicket;
    issuedIdentity: IssuedTicketIdentity;
  }>();
  let ticketIssuanceSequence = 0;
  let poisoned = false;

  const poison = (deps: GroupingEngineDependencies): void => {
    poisoned = true;
    poisonedBoundaries.add(deps.boundaryToken);
    try {
      deps.undo.clear();
    } catch {
      // Poison is already latched; repository notification errors cannot reopen the boundary.
    }
  };

  const validationFailure = (error: unknown): Extract<CompileResult, { ok: false }> | null => (
    error instanceof PersistentLayoutValidationError
      ? { ok: false, stale: [], errors: [error.message] }
      : null
  );

  const compileGroupingPlan = (
    plan: GroupingPlan,
    current: readonly Workspace[],
    context: GroupingCompileContext,
  ): CompileResult => {
    try {
      const normalizedContext = normalizeGroupingCompileContext(current, context, "compile input");
      return compileGroupingPlanCore(plan, canonicalCompileInput(current, normalizedContext));
    } catch (error) {
      const failure = validationFailure(error);
      if (failure) return failure;
      throw error;
    }
  };

  const prepareGroupingCommit = (
    plan: GroupingPlan,
    current: readonly Workspace[],
    context: GroupingCompileContext,
    schemaEpoch = 0,
  ): PrepareResult => {
    const normalizedContext = normalizeGroupingCompileContext(current, context, "prepare input");
    const compiled = compileGroupingPlan(plan, current, normalizedContext);
    if (!compiled.ok) return compiled;
    try {
      const planSignature = hashCanonical(canonicalPlan(plan));
      const inputSignature = hashCanonical(canonicalCompileInput(current, normalizedContext));
      const outputSignature = persistentSignature(compiled.transaction.workspaces);
      const previewId = previewIdFor(planSignature, inputSignature, normalizedContext.allocationSeed);
      const issuanceId = sha256Hex([
        previewId,
        schemaEpoch,
        ++ticketIssuanceSequence,
      ].join("\0"));
      const ticket = deepFreeze<GroupingCommitTicket>({
        schemaVersion: 1,
        schemaEpoch,
        issuanceId,
        previewId,
        planSignature,
        inputSignature,
        outputSignature,
        context: structuredClone(normalizedContext),
        transaction: structuredClone(compiled.transaction),
      });
      issuedTickets.set(issuanceId, {
        previewId,
        schemaEpoch,
        transactionIdentity: hashCanonical(ticket.transaction),
      });
      while (issuedTickets.size > MAX_OUTSTANDING_GROUPING_TICKETS) {
        const oldestIssuanceId = issuedTickets.keys().next().value;
        if (oldestIssuanceId === undefined) break;
        issuedTickets.delete(oldestIssuanceId);
      }
      return {
        ok: true,
        ticket,
      };
    } catch (error) {
      const failure = validationFailure(error);
      if (failure) return failure;
      throw error;
    }
  };

  const claimPreparedGroupingCommit: GroupingEngine["claimPreparedGroupingCommit"] = (ticket) => {
    let issuedIdentity: IssuedTicketIdentity | undefined;
    try {
      if (ticket && typeof ticket === "object") issuedIdentity = issuedTickets.get(ticket.issuanceId);
    } catch {
      issuedIdentity = undefined;
    }
    if (!issuedIdentity) {
      return { ok: false, kind: "invalid_input", errors: ["このエンジンが発行した適用チケットではありません"] };
    }
    issuedTickets.delete(ticket.issuanceId);
    const attempt = Object.freeze({}) as GroupingCommitAttempt;
    claimedTickets.set(attempt, { ticket, issuedIdentity });
    return { ok: true, attempt };
  };

  const commitClaimedCore = (
    plan: GroupingPlan,
    ticket: GroupingCommitTicket,
    issuedIdentity: IssuedTicketIdentity,
    deps: GroupingEngineDependencies,
  ): CommitResult => {
    if (poisoned || poisonedBoundaries.has(deps.boundaryToken)) {
      return { ok: false, kind: "boundary_poisoned", errors: ["rollback_failed 後は再適用できません"] };
    }

    let latest: Workspace[];
    let liveSelection: GroupingSelectionState;
    let liveContext: GroupingCompileContext;
    let recompiled: Extract<CompileResult, { ok: true }>;
    try {
      if (ticket.schemaVersion !== 1
        || !Number.isSafeInteger(ticket.schemaEpoch)
        || ticket.schemaEpoch < 0
        || !Array.isArray(ticket.context.baseline)
        || !Array.isArray(ticket.transaction.workspaces)
        || !ticket.transaction.expected
        || typeof ticket.context.allocationSeed !== "string"
        || typeof ticket.context.createdAt !== "number") {
        return { ok: false, kind: "invalid_input", errors: ["適用チケットの構造が不正です"] };
      }
      const expectedPreviewId = previewIdFor(ticket.planSignature, ticket.inputSignature, ticket.context.allocationSeed);
      if (ticket.previewId !== expectedPreviewId
        || issuedIdentity.previewId !== ticket.previewId
        || issuedIdentity.schemaEpoch !== ticket.schemaEpoch
        || issuedIdentity.transactionIdentity !== hashCanonical(ticket.transaction)) {
        return { ok: false, kind: "invalid_input", errors: ["適用チケットのidentityが一致しません"] };
      }
      if (hashCanonical(canonicalPlan(plan)) !== ticket.planSignature) {
        return { ok: false, kind: "plan_changed", errors: ["確認後に再配置案が変更されています"] };
      }
      latest = structuredClone(deps.getWorkspaces()) as Workspace[];
      liveSelection = structuredClone(deps.getSelection());
      liveContext = normalizeGroupingCompileContext(latest, {
        ...structuredClone(ticket.context),
        activeWorkspaceId: liveSelection.activeWorkspaceId,
        activeSessionId: liveSelection.activeSessionId,
      }, "commit input");
      if (hashCanonical(canonicalCompileInput(latest, liveContext)) !== ticket.inputSignature) {
        return {
          ok: false,
          kind: "preview_stale",
          stale: classifyStale(ticket.context.baseline, latest, targetTabIds(plan), destinationWorkspaceIds(plan)),
          errors: ["確認後にレイアウトが変わりました。適用内容を再確認してください"],
        };
      }
      if (persistentSignature(ticket.transaction.workspaces) !== ticket.outputSignature) {
        return { ok: false, kind: "invalid_input", errors: ["適用チケットの内容が一致しません"] };
      }
      const compiled = compileGroupingPlan(plan, latest, liveContext);
      if (!compiled.ok) {
        return { ok: false, kind: "invalid_input", stale: compiled.stale, errors: compiled.errors };
      }
      if (persistentSignature(compiled.transaction.workspaces) !== ticket.outputSignature) {
        return { ok: false, kind: "invalid_input", errors: ["確認時と適用時のコンパイル結果が一致しません"] };
      }
      const metricErrors = expectedResultErrors(plan, latest, compiled.transaction, liveContext);
      if (metricErrors.length > 0) {
        return { ok: false, kind: "invalid_input", errors: metricErrors };
      }
      recompiled = compiled;
    } catch (error) {
      return {
        ok: false,
        kind: "invalid_input",
        errors: [error instanceof Error ? error.message : String(error)],
      };
    }

    let before: GroupingStateSnapshot;
    let intendedSelection: GroupingSelectionState;
    let intendedState: GroupingStateSnapshot;
    try {
      before = normalizeGroupingStateSnapshot(snapshotFrom(deps), "commit before");
      const beforeIssues = validateGroupingStateSnapshot(before);
      if (beforeIssues.length > 0) {
        return { ok: false, kind: "invalid_input", errors: beforeIssues.map(identityIssueError) };
      }
      intendedSelection = expectedSelection(
        before.selection,
        recompiled.transaction.expected,
        recompiled.transaction.workspaces,
      );
      const rawIntendedState: GroupingStateSnapshot = {
        schemaVersion: 1,
        workspaces: structuredClone(recompiled.transaction.workspaces),
        selection: intendedSelection,
      };
      intendedState = normalizeGroupingStateSnapshot(rawIntendedState, "commit intended");
      if (selectionSignature(rawIntendedState.selection) !== selectionSignature(intendedState.selection)) {
        return {
          ok: false,
          kind: "invalid_input",
          errors: ["engine output selection required normalization"],
        };
      }
      intendedSelection = intendedState.selection;
      const intendedIssues = validateGroupingStateSnapshot(intendedState);
      if (intendedIssues.length > 0) {
        return { ok: false, kind: "invalid_input", errors: intendedIssues.map(identityIssueError) };
      }
    } catch (error) {
      return {
        ok: false,
        kind: "invalid_input",
        errors: [error instanceof Error ? error.message : String(error)],
      };
    }
    const rollback = (errors: string[]): CommitResult => {
      try {
        deps.restoreGroupingState(structuredClone(before));
        const restored = snapshotFrom(deps);
        if (!sameState(restored, before)) {
          poison(deps);
          return { ok: false, kind: "rollback_failed", errors: [...errors, "レイアウトの復旧を確認できませんでした"] };
        }
        return { ok: false, kind: "commit_mismatch", errors };
      } catch (error) {
        poison(deps);
        return {
          ok: false,
          kind: "rollback_failed",
          errors: [...errors, error instanceof Error ? error.message : String(error)],
        };
      }
    };

    try {
      deps.replaceWorkspaces(structuredClone(recompiled.transaction.workspaces));
      const actualLayout = deps.getWorkspaces();
      const identityIssues = validateLayoutIdentity(actualLayout, "output");
      if (identityIssues.length > 0) {
        return rollback(identityIssues.map(identityIssueError));
      }
      if (persistentSignature(actualLayout) !== persistentSignature(intendedState.workspaces)) {
        return rollback(["永続レイアウトがexpectedResultと一致しません"]);
      }
      deps.applySelection(structuredClone(intendedSelection));
      if (!sameState(snapshotFrom(deps), intendedState)) {
        return rollback(["focusまたはselectionがexpectedResultと一致しません"]);
      }
      const report = buildApplyReport(before.workspaces, recompiled.transaction.expected);
      const appliedAt = Date.now();
      const appliedWorkspaces = deps.getWorkspaces();
      const affectedWorkspaceIds = [...new Set(report.moved.flatMap((movement) => [
        movement.from.workspaceId,
        movement.to.workspaceId,
      ]).filter(Boolean))].sort();
      deps.undo.set({
        recordId: `grouping-undo-${++groupingUndoRecordSequence}-${ticket.previewId}`,
        schemaVersion: 1,
        snapshot: before,
        report: {
          movedTabCount: report.moved.length,
          affectedWorkspaceIds,
          emptyWorkspaceIds: [...report.emptyWorkspaceIds],
          appliedAt,
        },
        appliedLayoutSignature: persistentLayoutSignature(appliedWorkspaces),
        expectedStructuralSignature: structuralUndoSignature(appliedWorkspaces),
        committedLayoutRevision: deps.getLayoutRevision(),
        createdAt: appliedAt,
        status: "available",
        expireReason: null,
      });
      return { ok: true, report, transaction: recompiled.transaction };
    } catch (error) {
      return rollback([error instanceof Error ? error.message : String(error)]);
    }
  };

  const commitClaimedGrouping: GroupingEngine["commitClaimedGrouping"] = (plan, attempt, deps) => {
    const claimed = claimedTickets.get(attempt);
    if (!claimed) {
      return { ok: false, kind: "invalid_input", errors: ["適用試行が無効または既に使用されています"] };
    }
    claimedTickets.delete(attempt);
    return commitClaimedCore(plan, claimed.ticket, claimed.issuedIdentity, deps);
  };

  const commitPreparedGrouping: GroupingEngine["commitPreparedGrouping"] = (plan, ticket, deps) => {
    if (poisoned || poisonedBoundaries.has(deps.boundaryToken)) {
      return { ok: false, kind: "boundary_poisoned", errors: ["rollback_failed 後は再適用できません"] };
    }
    const claimed = claimPreparedGroupingCommit(ticket);
    if (!claimed.ok) return claimed;
    return commitClaimedGrouping(plan, claimed.attempt, deps);
  };

  const hasGroupingUndo = (deps: GroupingEngineDependencies): boolean => {
    if (poisoned || poisonedBoundaries.has(deps.boundaryToken)) return false;
    const undo = deps.undo.get();
    if (!undo || undo.status === "expired") return false;
    if (structuralUndoSignature(deps.getWorkspaces()) !== undo.expectedStructuralSignature) {
      deps.undo.expire("その後レイアウトが変更されたため元に戻せません");
      return false;
    }
    return true;
  };

  const restoreGroupingUndo = (deps: GroupingEngineDependencies): UndoResult => {
    if (poisoned || poisonedBoundaries.has(deps.boundaryToken)) {
      return { ok: false, kind: "boundary_poisoned", reason: "rollback_failed 後は元に戻せません" };
    }
    let undo = deps.undo.get();
    if (!undo) return { ok: false, kind: "missing", reason: "戻せる再配置がありません" };
    if (!hasGroupingUndo(deps)) {
      undo = deps.undo.get() ?? undo;
      return {
        ok: false,
        kind: "expired",
        reason: undo.expireReason ?? "その後レイアウトが変更されたため元に戻せません",
      };
    }
    try {
      const live = snapshotFrom(deps);
      const undoSnapshot = normalizeGroupingStateSnapshot(
        undo.snapshot,
        "undo snapshot",
        { repairCrossWorkspaceActiveSession: false },
      );
      const storedIssues = validateGroupingStateSnapshot(undoSnapshot);
      // Live selection may legitimately point at a just-closed tab; the undo
      // projection below falls back to the validated saved selection.
      const liveIssues = validateLayoutIdentity(live.workspaces);
      const gridDrift = [
        ...gridTemplateDriftIssues(undoSnapshot.workspaces),
        ...gridTemplateDriftIssues(live.workspaces),
      ];
      if (gridDrift.length > 0) {
        console.warn(
          "[mycmux] tab grouping undo gridTemplateId drift",
          gridDrift.map(identityIssueError),
        );
      }
      if (storedIssues.length > 0 || liveIssues.length > 0) {
        const reason = [...storedIssues, ...liveIssues].map(identityIssueError).join("; ");
        poison(deps);
        return { ok: false, kind: "restore_failed", reason };
      }
      const expected = selectionPreservingSnapshot(
        undoSnapshot,
        live.selection,
        live.workspaces,
      );
      const expectedIssues = validateGroupingStateSnapshot(expected);
      if (expectedIssues.length > 0) {
        const reason = expectedIssues.map(identityIssueError).join("; ");
        poison(deps);
        return { ok: false, kind: "restore_failed", reason };
      }
      deps.restoreGroupingState(structuredClone(expected));
      if (!sameState(snapshotFrom(deps), expected)) {
        poison(deps);
        return { ok: false, kind: "restore_failed", reason: "undo後の状態を確認できませんでした" };
      }
    } catch (error) {
      poison(deps);
      return {
        ok: false,
        kind: "restore_failed",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    try {
      deps.undo.clear();
    } catch (error) {
      return {
        ok: false,
        kind: "post_undo_failed",
        layoutReverted: true,
        persistenceRequested: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    return { ok: true };
  };

  return {
    compileGroupingPlan,
    prepareGroupingCommit,
    claimPreparedGroupingCommit,
    commitClaimedGrouping,
    commitPreparedGrouping,
    restoreGroupingUndo,
    hasGroupingUndo,
  };
}

const defaultEngine = createGroupingEngine();

export const compileGroupingPlan = defaultEngine.compileGroupingPlan;
export const prepareGroupingCommit = defaultEngine.prepareGroupingCommit;
export const claimPreparedGroupingCommit = defaultEngine.claimPreparedGroupingCommit;
export const commitClaimedGrouping = defaultEngine.commitClaimedGrouping;
export const commitPreparedGrouping = defaultEngine.commitPreparedGrouping;
export const restoreGroupingUndo = defaultEngine.restoreGroupingUndo;
export const hasGroupingUndo = defaultEngine.hasGroupingUndo;
