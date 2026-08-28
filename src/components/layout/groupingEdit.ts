import { v4 as uuid } from "uuid";

import {
  clonePlanForEdit,
  defaultLayoutForTabs,
  isJapaneseGroupingName,
  TAB_GROUPING_MAX_COLUMNS,
  TAB_GROUPING_MAX_PANES_PER_COLUMN,
  TAB_GROUPING_NAME_MAX,
  type GroupingDestination,
  type GroupingLayout,
  type GroupingPlan,
} from "./tabGrouping";

/** An edit-transaction-local pane reference. It never identifies a pane by title or DOM order. */
export interface GroupingPaneRef {
  readonly groupId: string;
  readonly columnIndex: number;
  readonly paneIndex: number;
}

export type GroupingEditTarget =
  | ({ readonly kind: "pane" } & GroupingPaneRef)
  | { readonly kind: "group"; readonly groupId: string }
  | { readonly kind: "unassigned" };

export type EditCommand =
  | { readonly kind: "reassign_tabs"; readonly tabIds: readonly string[]; readonly target: GroupingEditTarget }
  | { readonly kind: "keep_current"; readonly tabIds: readonly string[] }
  | { readonly kind: "set_group_adoption"; readonly groupId: string; readonly adopted: boolean }
  | { readonly kind: "set_group_destination"; readonly groupId: string; readonly destination: GroupingDestination }
  | { readonly kind: "create_group"; readonly title: string; readonly tabIds: readonly string[] }
  | { readonly kind: "rename_group"; readonly groupId: string; readonly title: string }
  | { readonly kind: "rename_new_workspace"; readonly groupId: string; readonly proposedName: string }
  | { readonly kind: "rename_pane"; readonly pane: GroupingPaneRef; readonly title: string };

export interface GroupingEditSnapshot {
  readonly plan: GroupingPlan;
  readonly stashedLayouts: Readonly<Record<string, GroupingLayout>>;
}

export interface GroupingEditSession extends GroupingEditSnapshot {
  readonly basePlan: GroupingPlan;
  readonly previous: GroupingEditSnapshot | null;
}

export interface EditCommandOptions {
  readonly existingWorkspaceNames?: readonly string[];
  readonly idFactory?: () => string;
}

type MutableStashes = Record<string, GroupingLayout>;

type ResolvedTarget =
  | { kind: "pane"; groupIndex: number; columnIndex: number; paneIndex: number }
  | { kind: "group"; groupIndex: number }
  | { kind: "unassigned" };

function cloneStashes(stashes: Readonly<Record<string, GroupingLayout>>): MutableStashes {
  return structuredClone(stashes);
}

function planKey(plan: GroupingPlan): string {
  return JSON.stringify(plan);
}

function stashesKey(stashes: Readonly<Record<string, GroupingLayout>>): string {
  return JSON.stringify(stashes);
}

function flattenLayout(layout: GroupingLayout): string[] {
  return layout.columns.flatMap((column) => column.panes.flatMap((pane) => pane.tabIds));
}

function uniqueInOrder(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function normalizedName(value: string): string | null {
  const trimmed = value.trim();
  return isJapaneseGroupingName(trimmed) ? trimmed : null;
}

function layoutWithinLimits(layout: GroupingLayout): boolean {
  return layout.columns.length <= TAB_GROUPING_MAX_COLUMNS
    && layout.columns.every((column) => column.panes.length <= TAB_GROUPING_MAX_PANES_PER_COLUMN);
}

function knownTabIds(plan: GroupingPlan): Set<string> {
  return new Set([
    ...plan.groups.flatMap((group) => group.tabIds),
    ...plan.groups.flatMap((group) => group.layout ? flattenLayout(group.layout) : []),
    ...plan.unassignedTabIds,
  ]);
}

function commandTabIds(plan: GroupingPlan, tabIds: readonly string[]): string[] {
  const known = knownTabIds(plan);
  return uniqueInOrder(tabIds).filter((tabId) => known.has(tabId));
}

function resolveTarget(plan: GroupingPlan, target: GroupingEditTarget): ResolvedTarget | null {
  if (target.kind === "unassigned") return { kind: "unassigned" };
  const groupIndex = plan.groups.findIndex((group) => group.groupId === target.groupId);
  if (groupIndex < 0) return null;
  if (target.kind === "group") {
    const group = plan.groups[groupIndex];
    if (group.layout?.columns[0]?.panes[0]) {
      return { kind: "pane", groupIndex, columnIndex: 0, paneIndex: 0 };
    }
    return { kind: "group", groupIndex };
  }
  if (!Number.isInteger(target.columnIndex) || target.columnIndex < 0
    || !Number.isInteger(target.paneIndex) || target.paneIndex < 0
    || target.columnIndex >= TAB_GROUPING_MAX_COLUMNS
    || target.paneIndex >= TAB_GROUPING_MAX_PANES_PER_COLUMN) {
    return null;
  }
  const pane = plan.groups[groupIndex].layout?.columns[target.columnIndex]?.panes[target.paneIndex];
  return pane ? { kind: "pane", groupIndex, columnIndex: target.columnIndex, paneIndex: target.paneIndex } : null;
}

function targetLocationKey(target: ResolvedTarget, plan: GroupingPlan): string {
  if (target.kind === "unassigned") return "unassigned";
  const groupId = plan.groups[target.groupIndex].groupId;
  return target.kind === "group"
    ? `group:${groupId}`
    : `pane:${paneRefKey({ groupId, columnIndex: target.columnIndex, paneIndex: target.paneIndex })}`;
}

function tabLocationKeys(plan: GroupingPlan, tabId: string): string[] {
  const locations: string[] = [];
  plan.groups.forEach((group) => {
    if (group.layout) {
      group.layout.columns.forEach((column, columnIndex) => {
        column.panes.forEach((pane, paneIndex) => {
          pane.tabIds.forEach((id) => {
            if (id === tabId) locations.push(`pane:${paneRefKey({ groupId: group.groupId, columnIndex, paneIndex })}`);
          });
        });
      });
    } else {
      group.tabIds.forEach((id) => {
        if (id === tabId) locations.push(`group:${group.groupId}`);
      });
    }
  });
  plan.unassignedTabIds.forEach((id) => {
    if (id === tabId) locations.push("unassigned");
  });
  return locations;
}

function snapshotOf(session: GroupingEditSession): GroupingEditSnapshot {
  return {
    plan: clonePlanForEdit(session.plan),
    stashedLayouts: cloneStashes(session.stashedLayouts),
  };
}

function finalizeChange(
  session: GroupingEditSession,
  candidatePlan: GroupingPlan,
  candidateStashes: MutableStashes,
): GroupingEditSession {
  const normalized = normalizeEditedPlan(candidatePlan);
  if (planKey(normalized) === planKey(session.plan)
    && stashesKey(candidateStashes) === stashesKey(session.stashedLayouts)) {
    return session;
  }
  return {
    plan: normalized,
    stashedLayouts: candidateStashes,
    basePlan: session.basePlan,
    previous: snapshotOf(session),
  };
}

function plannedWorkspaceNames(plan: GroupingPlan, excludedGroupId?: string): string[] {
  return plan.groups.flatMap((group) => (
    group.groupId !== excludedGroupId && group.destination.kind === "new_workspace"
      ? [group.destination.proposedName]
      : []
  ));
}

function stashLayoutsEmptiedByMove(
  before: GroupingPlan,
  afterStrip: GroupingPlan,
  stashes: MutableStashes,
): void {
  before.groups.forEach((group, groupIndex) => {
    if (!group.adopted || group.disposition !== "reorganize" || !group.layout) return;
    const next = afterStrip.groups[groupIndex];
    if (next.layout && flattenLayout(next.layout).length === 0) {
      stashes[group.groupId] = structuredClone(group.layout);
    }
  });
}

function stripTabs(plan: GroupingPlan, moving: ReadonlySet<string>): GroupingPlan {
  const strip = (ids: readonly string[]) => ids.filter((id) => !moving.has(id));
  return {
    ...plan,
    groups: plan.groups.map((group) => ({
      ...group,
      tabIds: strip(group.tabIds),
      layout: group.layout ? {
        columns: group.layout.columns.map((column) => ({
          panes: column.panes.map((pane) => ({ ...pane, tabIds: strip(pane.tabIds) })),
        })),
      } : null,
    })),
    unassignedTabIds: strip(plan.unassignedTabIds),
  };
}

function reassign(
  session: GroupingEditSession,
  tabIds: readonly string[],
  targetSpec: GroupingEditTarget,
): GroupingEditSession {
  const movingIds = commandTabIds(session.plan, tabIds);
  if (movingIds.length === 0) return session;
  const target = resolveTarget(session.plan, targetSpec);
  if (!target) return session;
  const targetKey = targetLocationKey(target, session.plan);
  if (movingIds.every((tabId) => {
    const locations = tabLocationKeys(session.plan, tabId);
    return locations.length === 1 && locations[0] === targetKey;
  })) {
    return session;
  }

  const targetIds = target.kind === "unassigned"
    ? session.plan.unassignedTabIds
    : target.kind === "group"
      ? session.plan.groups[target.groupIndex].tabIds
      : session.plan.groups[target.groupIndex].layout?.columns[target.columnIndex]?.panes[target.paneIndex]?.tabIds ?? [];
  const moving = new Set(movingIds);
  const candidateStashes = cloneStashes(session.stashedLayouts);
  const candidate = stripTabs(clonePlanForEdit(session.plan), moving);
  stashLayoutsEmptiedByMove(session.plan, candidate, candidateStashes);
  const nextTargetIds = uniqueInOrder([
    ...targetIds,
    ...movingIds.filter((tabId) => !targetIds.includes(tabId)),
  ]);

  if (target.kind === "unassigned") {
    candidate.unassignedTabIds = nextTargetIds;
  } else if (target.kind === "group") {
    const group = candidate.groups[target.groupIndex];
    const stashed = candidateStashes[group.groupId];
    if (stashed && nextTargetIds.length > 0) {
      const restored = restoredLayout(stashed, nextTargetIds, group.title);
      const baseDestination = session.basePlan.groups.find((item) => item.groupId === group.groupId)?.destination;
      Object.assign(group, {
        adopted: true,
        disposition: "reorganize" as const,
        destination: baseDestination && baseDestination.kind !== "current_locations"
          ? structuredClone(baseDestination)
          : { kind: "new_workspace" as const, proposedName: group.title },
        layout: restored,
        tabIds: flattenLayout(restored),
      });
      delete candidateStashes[group.groupId];
    } else {
      group.tabIds = nextTargetIds;
    }
  } else {
    const group = candidate.groups[target.groupIndex];
    const pane = group.layout?.columns[target.columnIndex]?.panes[target.paneIndex];
    if (!pane || !group.layout) return session;
    pane.tabIds = nextTargetIds;
    group.tabIds = flattenLayout(group.layout);
  }
  return finalizeChange(session, candidate, candidateStashes);
}

function restoredLayout(layout: GroupingLayout, currentTabIds: readonly string[], title: string): GroupingLayout {
  const allowed = new Set(currentTabIds);
  const placed = new Set<string>();
  const columns = layout.columns.map((column) => ({
    panes: column.panes.map((pane) => ({
      ...pane,
      tabIds: pane.tabIds.filter((tabId) => {
        if (!allowed.has(tabId) || placed.has(tabId)) return false;
        placed.add(tabId);
        return true;
      }),
    })).filter((pane) => pane.tabIds.length > 0),
  })).filter((column) => column.panes.length > 0);
  const missing = currentTabIds.filter((tabId) => !placed.has(tabId));
  if (columns.length === 0) return defaultLayoutForTabs(currentTabIds, title);
  columns[0].panes[0].tabIds.push(...missing);
  return { columns };
}

export function paneRefKey(ref: GroupingPaneRef): string {
  return `${ref.groupId}:${ref.columnIndex}:${ref.paneIndex}`;
}

export function parsePaneRefKey(key: string): GroupingPaneRef | null {
  const match = /^(.*):(\d+):(\d+)$/su.exec(key);
  if (!match || !match[1]) return null;
  const columnIndex = Number(match[2]);
  const paneIndex = Number(match[3]);
  if (!Number.isSafeInteger(columnIndex) || !Number.isSafeInteger(paneIndex)) return null;
  return { groupId: match[1], columnIndex, paneIndex };
}

export function uniqueGroupingName(base: string, taken: Iterable<string>): string {
  const trimmed = base.trim();
  const occupied = new Set(taken);
  if (!occupied.has(trimmed)) return trimmed;
  for (let index = 2; ; index += 1) {
    const suffix = ` ${index}`;
    const available = TAB_GROUPING_NAME_MAX - [...suffix].length;
    const prefix = [...trimmed].slice(0, Math.max(0, available)).join("").trimEnd();
    const candidate = `${prefix}${suffix}`;
    if (!occupied.has(candidate)) return candidate;
  }
}

export function normalizeEditedPlan(plan: GroupingPlan): GroupingPlan {
  const next = clonePlanForEdit(plan);
  const seenTabIds = new Set<string>();
  const takeFirstOccurrence = (tabIds: readonly string[]) => tabIds.filter((tabId) => {
    if (seenTabIds.has(tabId)) return false;
    seenTabIds.add(tabId);
    return true;
  });

  next.groups = next.groups.map((group) => {
    const uniquePaneNames = (layout: GroupingLayout): GroupingLayout => {
      const names = new Set<string>();
      return {
        columns: layout.columns.map((column) => ({
          panes: column.panes.map((pane) => {
            const title = uniqueGroupingName(pane.title, names);
            names.add(title);
            return { ...pane, title };
          }),
        })),
      };
    };

    if (group.adopted && group.disposition === "reorganize" && group.layout) {
      const named = uniquePaneNames(group.layout);
      const columns = named.columns.map((column) => ({
        panes: column.panes.map((pane) => ({
          ...pane,
          tabIds: takeFirstOccurrence(pane.tabIds),
        })).filter((pane) => pane.tabIds.length > 0),
      })).filter((column) => column.panes.length > 0);
      const normalizedLayout = { columns };
      const tabIds = flattenLayout(normalizedLayout);
      if (tabIds.length === 0) {
        return {
          ...group,
          adopted: false,
          disposition: "keep",
          destination: { kind: "current_locations" },
          layout: null,
          tabIds: [],
        };
      }
      return { ...group, layout: normalizedLayout, tabIds };
    }

    const tabIds = takeFirstOccurrence(group.tabIds);
    return {
      ...group,
      tabIds,
      layout: group.layout ? uniquePaneNames(group.layout) : null,
    };
  });
  next.unassignedTabIds = takeFirstOccurrence(next.unassignedTabIds);
  return next;
}

export function beginGroupingEdit(plan: GroupingPlan): GroupingEditSession {
  return {
    plan: clonePlanForEdit(plan),
    basePlan: clonePlanForEdit(plan),
    stashedLayouts: {},
    previous: null,
  };
}

export function applyEditCommand(
  session: GroupingEditSession,
  command: EditCommand,
  options: EditCommandOptions = {},
): GroupingEditSession {
  if (command.kind === "reassign_tabs") return reassign(session, command.tabIds, command.target);
  if (command.kind === "keep_current") {
    return reassign(session, command.tabIds, { kind: "unassigned" });
  }

  const groupIndex = "groupId" in command
    ? session.plan.groups.findIndex((group) => group.groupId === command.groupId)
    : -1;

  if (command.kind === "set_group_adoption") {
    if (groupIndex < 0 || session.plan.groups[groupIndex].adopted === command.adopted) return session;
    const candidate = clonePlanForEdit(session.plan);
    candidate.groups[groupIndex].adopted = command.adopted;
    return finalizeChange(session, candidate, cloneStashes(session.stashedLayouts));
  }

  if (command.kind === "set_group_destination") {
    if (groupIndex < 0) return session;
    const sourceGroup = session.plan.groups[groupIndex];
    const candidate = clonePlanForEdit(session.plan);
    const group = candidate.groups[groupIndex];
    const stashes = cloneStashes(session.stashedLayouts);
    if (command.destination.kind === "current_locations") {
      if (group.destination.kind === "current_locations" && group.disposition === "keep"
        && group.layout === null && group.adopted) return session;
      if (sourceGroup.layout) stashes[sourceGroup.groupId] = structuredClone(sourceGroup.layout);
      Object.assign(group, {
        disposition: "keep" as const,
        destination: { kind: "current_locations" as const },
        layout: null,
        adopted: true,
      });
      return finalizeChange(session, candidate, stashes);
    }
    if (group.tabIds.length === 0) return session;
    let destination = command.destination;
    if (destination.kind === "new_workspace") {
      const requested = normalizedName(destination.proposedName);
      if (!requested) return session;
      const taken = [
        ...plannedWorkspaceNames(session.plan, sourceGroup.groupId),
        ...(options.existingWorkspaceNames ?? []),
      ];
      destination = { kind: "new_workspace", proposedName: uniqueGroupingName(requested, taken) };
    }
    const stored = stashes[sourceGroup.groupId];
    const sourceLayout = group.layout ?? stored;
    if (sourceLayout && !layoutWithinLimits(sourceLayout)) return session;
    const nextLayout = sourceLayout
      ? restoredLayout(sourceLayout, group.tabIds, group.title)
      : defaultLayoutForTabs(group.tabIds, group.title);
    Object.assign(group, {
      disposition: "reorganize" as const,
      destination,
      layout: nextLayout,
      tabIds: flattenLayout(nextLayout),
      adopted: true,
    });
    delete stashes[sourceGroup.groupId];
    return finalizeChange(session, candidate, stashes);
  }

  if (command.kind === "create_group") {
    const requested = normalizedName(command.title);
    const movingIds = commandTabIds(session.plan, command.tabIds);
    if (!requested || movingIds.length === 0) return session;
    const groupId = (options.idFactory ?? uuid)();
    if (!groupId || session.plan.groups.some((group) => group.groupId === groupId)) return session;
    const taken = [
      ...session.plan.groups.map((group) => group.title),
      ...plannedWorkspaceNames(session.plan),
      ...(options.existingWorkspaceNames ?? []),
    ];
    const title = uniqueGroupingName(requested, taken);
    const candidatePlan = clonePlanForEdit(session.plan);
    candidatePlan.groups.push({
      groupId,
      title,
      disposition: "reorganize",
      destination: { kind: "new_workspace", proposedName: title },
      layout: defaultLayoutForTabs([], title),
      tabIds: [],
      adopted: true,
    });
    const temporary: GroupingEditSession = {
      ...session,
      plan: candidatePlan,
      stashedLayouts: cloneStashes(session.stashedLayouts),
    };
    const moved = reassign(temporary, movingIds, {
      kind: "pane",
      groupId,
      columnIndex: 0,
      paneIndex: 0,
    });
    if (moved === temporary) return session;
    return {
      ...moved,
      basePlan: session.basePlan,
      previous: snapshotOf(session),
    };
  }

  if (command.kind === "rename_group") {
    if (groupIndex < 0) return session;
    const requested = normalizedName(command.title);
    if (!requested || requested === session.plan.groups[groupIndex].title) return session;
    const title = uniqueGroupingName(
      requested,
      session.plan.groups.filter((_, index) => index !== groupIndex).map((group) => group.title),
    );
    const candidate = clonePlanForEdit(session.plan);
    candidate.groups[groupIndex].title = title;
    return finalizeChange(session, candidate, cloneStashes(session.stashedLayouts));
  }

  if (command.kind === "rename_new_workspace") {
    if (groupIndex < 0 || session.plan.groups[groupIndex].destination.kind !== "new_workspace") return session;
    const requested = normalizedName(command.proposedName);
    const currentName = session.plan.groups[groupIndex].destination.proposedName;
    if (!requested || requested === currentName) return session;
    const proposedName = uniqueGroupingName(requested, [
      ...plannedWorkspaceNames(session.plan, session.plan.groups[groupIndex].groupId),
      ...(options.existingWorkspaceNames ?? []),
    ]);
    const candidate = clonePlanForEdit(session.plan);
    candidate.groups[groupIndex].destination = { kind: "new_workspace", proposedName };
    return finalizeChange(session, candidate, cloneStashes(session.stashedLayouts));
  }

  const requested = normalizedName(command.title);
  const target = resolveTarget(session.plan, { kind: "pane", ...command.pane });
  if (!requested || !target || target.kind !== "pane") return session;
  const currentPane = session.plan.groups[target.groupIndex].layout
    ?.columns[target.columnIndex]?.panes[target.paneIndex];
  if (!currentPane || currentPane.title === requested) return session;
  const layout = session.plan.groups[target.groupIndex].layout;
  if (!layout) return session;
  const taken = layout.columns.flatMap((column) => column.panes)
    .filter((pane) => pane !== currentPane)
    .map((pane) => pane.title);
  const title = uniqueGroupingName(requested, taken);
  const candidate = clonePlanForEdit(session.plan);
  const pane = candidate.groups[target.groupIndex].layout
    ?.columns[target.columnIndex]?.panes[target.paneIndex];
  if (!pane) return session;
  pane.title = title;
  return finalizeChange(session, candidate, cloneStashes(session.stashedLayouts));
}

export function undoGroupingEdit(session: GroupingEditSession): GroupingEditSession {
  if (!session.previous) return session;
  return {
    plan: clonePlanForEdit(session.previous.plan),
    stashedLayouts: cloneStashes(session.previous.stashedLayouts),
    basePlan: session.basePlan,
    previous: null,
  };
}

export function resetGroupingEditToAi(session: GroupingEditSession): GroupingEditSession {
  if (!isGroupingEditDirty(session)) return session;
  return {
    plan: clonePlanForEdit(session.basePlan),
    stashedLayouts: {},
    basePlan: session.basePlan,
    previous: snapshotOf(session),
  };
}

export function canUndoGroupingEdit(session: GroupingEditSession): boolean {
  return session.previous !== null;
}

export function isGroupingEditDirty(session: GroupingEditSession): boolean {
  return planKey(session.plan) !== planKey(session.basePlan)
    || Object.keys(session.stashedLayouts).length > 0;
}
