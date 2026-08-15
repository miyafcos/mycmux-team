import { reconcileSplitColumnsForPanes } from "./layoutColumns";
import { reconcileColumnWidths, reconcileRowHeightsPerCol } from "./layoutMetrics";
import {
  applyActiveTabFields,
  clearPinIfMissing,
  resolveMergeActiveTabId,
  withPinnedTabFirst,
} from "./paneTabState";
import type { Pane, PaneTab, Workspace } from "../types/workspace";

export type LayoutMutation =
  | {
    kind: "move-tabs";
    operationId: string;
    tabIds: string[];
    anchorTabId: string;
    to:
      | { workspaceId: string; paneId: string }
      | { workspaceId: string; newPane: { column: number; row: number } }
      | { workspaceId: string; split: { paneId: string; zone: "left" | "right" | "up" | "down" } };
    sourceLayoutRevision: LayoutRevision;
  }
  | { kind: "close-tabs"; operationId: string; tabIds: string[] };

/**
 * A layout revision is an opaque value captured when a drag starts and
 * recomputed immediately before its atomic commit. The string form is used by
 * the minimap because the workspace stores do not otherwise own a revision.
 */
export type LayoutRevision = number | string;

/**
 * Captures only structural layout state. Labels and telemetry may change while
 * a drag is in progress without making its destination stale.
 */
export function layoutStructureRevision(workspaces: readonly Workspace[]): string {
  return JSON.stringify(workspaces.map((workspace) => ({
    id: workspace.id,
    panes: workspace.panes.map((pane) => ({ id: pane.id, tabs: pane.tabs.map((tab) => tab.id) })),
    splitColumns: workspace.splitColumns,
    columnWidths: workspace.columnWidths,
    rowHeightsPerCol: workspace.rowHeightsPerCol,
  })));
}

export interface MutationSummary {
  moved: string[];
  closed: string[];
  skipped: string[];
  ignoredAnchorTabId?: string;
  removedPanes: string[];
  retainedEmptyPanes: string[];
  removedColumns: number;
  affectedWorkspaces: string[];
  staleRevision: boolean;
}

const emptySummary = (): MutationSummary => ({
  moved: [],
  closed: [],
  skipped: [],
  removedPanes: [],
  retainedEmptyPanes: [],
  removedColumns: 0,
  affectedWorkspaces: [],
  staleRevision: false,
});

function cloneWorkspace(workspace: Workspace): Workspace {
  return {
    ...workspace,
    panes: workspace.panes.map((pane) => ({ ...pane, tabs: [...pane.tabs] })),
    splitColumns: workspace.splitColumns?.map((column) => [...column]),
    columnWidths: workspace.columnWidths ? [...workspace.columnWidths] : undefined,
    rowHeightsPerCol: workspace.rowHeightsPerCol?.map((rows) => [...rows]),
  };
}

function visualTabs(workspaces: Workspace[]): PaneTab[] {
  const result: PaneTab[] = [];
  for (const workspace of workspaces) {
    const columns = reconcileSplitColumnsForPanes(
      workspace.splitColumns,
      workspace.panes.map((pane) => pane.id),
    );
    const panesById = new Map(workspace.panes.map((pane) => [pane.id, pane]));
    for (const column of columns) {
      for (const paneId of column) result.push(...(panesById.get(paneId)?.tabs ?? []));
    }
  }
  return result;
}

function appendUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function appendAffected(summary: MutationSummary, workspaceId: string): void {
  appendUnique(summary.affectedWorkspaces, workspaceId);
}

function cleanNonEmptyPane(pane: Pane): Pane {
  const withoutStalePin = clearPinIfMissing(pane);
  const pinned = withoutStalePin.pinnedTabId
    ? withoutStalePin.tabs.find((tab) => tab.id === withoutStalePin.pinnedTabId)
    : undefined;
  const activeTab = pinned
    ?? withoutStalePin.tabs.find((tab) => tab.id === withoutStalePin.activeTabId)
    ?? withoutStalePin.tabs[withoutStalePin.tabs.length - 1];
  return withPinnedTabFirst(applyActiveTabFields(withoutStalePin, activeTab));
}

function cleanWorkspace(current: Workspace, previous: Workspace, summary: MutationSummary): Workspace {
  const nonEmpty = current.panes.filter((pane) => pane.tabs.length > 0);
  let panes: Pane[];
  if (nonEmpty.length > 0) {
    const survivingIds = new Set(nonEmpty.map((pane) => pane.id));
    for (const pane of current.panes) {
      if (!survivingIds.has(pane.id)) appendUnique(summary.removedPanes, pane.id);
    }
    panes = nonEmpty.map(cleanNonEmptyPane);
  } else if (current.panes.length > 0) {
    const retained = current.panes[current.panes.length - 1];
    for (const pane of current.panes.slice(0, -1)) appendUnique(summary.removedPanes, pane.id);
    appendUnique(summary.retainedEmptyPanes, retained.id);
    panes = [{ ...retained, tabs: [], activeTabId: "", pinnedTabId: undefined }];
  } else {
    panes = [];
  }

  const splitColumns = reconcileSplitColumnsForPanes(
    current.splitColumns,
    panes.map((pane) => pane.id),
  );
  const previousColumns = reconcileSplitColumnsForPanes(
    previous.splitColumns,
    previous.panes.map((pane) => pane.id),
  );
  const beforeColumnCount = previous.splitColumns?.filter((column) => column.length > 0).length ?? 0;
  summary.removedColumns += Math.max(0, beforeColumnCount - splitColumns.length);
  return {
    ...current,
    panes,
    splitColumns,
    columnWidths: reconcileColumnWidths(previousColumns, previous.columnWidths, splitColumns),
    rowHeightsPerCol: reconcileRowHeightsPerCol(
      previousColumns,
      previous.rowHeightsPerCol,
      splitColumns,
    ),
  };
}

function makePaneFromTabs(id: string, tabs: PaneTab[], activeTabId: string): Pane {
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  return applyActiveTabFields({
    id,
    agentId: activeTab.agentId,
    sessionId: activeTab.sessionId,
    tabs,
    activeTabId: activeTab.id,
  }, activeTab);
}

export function applyLayoutMutation(
  workspaces: Workspace[],
  mutation: LayoutMutation,
  currentLayoutRevision: LayoutRevision,
): { workspaces: Workspace[]; summary: MutationSummary } {
  const summary = emptySummary();
  const requested = [...new Set(mutation.tabIds)];
  if (mutation.kind === "move-tabs" && mutation.sourceLayoutRevision !== currentLayoutRevision) {
    summary.skipped.push(...requested);
    summary.staleRevision = true;
    return { workspaces: workspaces.map(cloneWorkspace), summary };
  }
  if (requested.length === 0) return { workspaces: workspaces.map(cloneWorkspace), summary };

  const requestedSet = new Set(requested);
  const seenSelected = new Set<string>();
  const selectedTabs = visualTabs(workspaces).filter((tab) => {
    if (!requestedSet.has(tab.id) || seenSelected.has(tab.id)) return false;
    seenSelected.add(tab.id);
    return true;
  });
  const selectedIds = selectedTabs.map((tab) => tab.id);
  const selectedSet = new Set(selectedIds);
  summary.skipped.push(...requested.filter((id) => !selectedSet.has(id)));
  if (selectedTabs.length === 0) return { workspaces: workspaces.map(cloneWorkspace), summary };

  const originalsById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const result = workspaces.map(cloneWorkspace);

  if (mutation.kind === "close-tabs") {
    for (const workspace of result) {
      const changed = workspace.panes.some((pane) => pane.tabs.some((tab) => selectedSet.has(tab.id)));
      if (!changed) continue;
      workspace.panes = workspace.panes.map((pane) => ({
        ...pane,
        tabs: pane.tabs.filter((tab) => !selectedSet.has(tab.id)),
      }));
      appendAffected(summary, workspace.id);
    }
    summary.closed.push(...selectedIds);
    return {
      workspaces: result.map((workspace) => {
        if (!summary.affectedWorkspaces.includes(workspace.id)) return workspace;
        const previous = originalsById.get(workspace.id);
        return previous ? cleanWorkspace(workspace, previous, summary) : workspace;
      }),
      summary,
    };
  }

  if (!selectedSet.has(mutation.anchorTabId)) summary.ignoredAnchorTabId = mutation.anchorTabId;
  const destination = result.find((workspace) => workspace.id === mutation.to.workspaceId);
  if (!destination) {
    summary.skipped.push(...selectedIds);
    return { workspaces: workspaces.map(cloneWorkspace), summary };
  }
  const targetPaneId = "paneId" in mutation.to ? mutation.to.paneId : undefined;
  const destinationPaneId = targetPaneId ?? ("split" in mutation.to ? mutation.to.split.paneId : undefined);
  const newPanePosition = "newPane" in mutation.to ? mutation.to.newPane : undefined;
  if (destinationPaneId !== undefined && !destination.panes.some((pane) => pane.id === destinationPaneId)) {
    summary.skipped.push(...selectedIds);
    return { workspaces: workspaces.map(cloneWorkspace), summary };
  }

  for (const workspace of result) {
    const changed = workspace.panes.some((pane) => pane.tabs.some((tab) => selectedSet.has(tab.id)));
    if (!changed) continue;
    workspace.panes = workspace.panes.map((pane) => ({
      ...pane,
      tabs: pane.tabs.filter((tab) => !selectedSet.has(tab.id)),
    }));
    appendAffected(summary, workspace.id);
  }

  const targetWorkspace = result.find((workspace) => workspace.id === mutation.to.workspaceId);
  if (!targetWorkspace) {
    summary.skipped.push(...selectedIds);
    return { workspaces: workspaces.map(cloneWorkspace), summary };
  }
  appendAffected(summary, targetWorkspace.id);

  if (targetPaneId !== undefined) {
    const targetPaneIndex = targetWorkspace.panes.findIndex((pane) => pane.id === targetPaneId);
    if (targetPaneIndex < 0) {
      summary.skipped.push(...selectedIds);
      return { workspaces: workspaces.map(cloneWorkspace), summary };
    }
    const targetPane = targetWorkspace.panes[targetPaneIndex];
    const tabs = [...targetPane.tabs, ...selectedTabs];
    const requestedActiveId = selectedSet.has(mutation.anchorTabId)
      ? mutation.anchorTabId
      : targetPane.activeTabId;
    const activeTabId = resolveMergeActiveTabId({ ...targetPane, tabs }, requestedActiveId);
    targetWorkspace.panes[targetPaneIndex] = { ...targetPane, tabs, activeTabId };
  } else if ("split" in mutation.to) {
    const split = mutation.to.split;
    const targetPane = targetWorkspace.panes.find((pane) => pane.id === split.paneId);
    if (!targetPane) {
      summary.skipped.push(...selectedIds);
      return { workspaces: workspaces.map(cloneWorkspace), summary };
    }
    const baseId = `pane-${mutation.operationId}`;
    let paneId = baseId;
    let suffix = 2;
    while (targetWorkspace.panes.some((pane) => pane.id === paneId)) {
      paneId = `${baseId}-${suffix}`;
      suffix += 1;
    }
    const activeTabId = selectedSet.has(mutation.anchorTabId)
      ? mutation.anchorTabId
      : selectedTabs[0].id;
    const pane = makePaneFromTabs(paneId, selectedTabs, activeTabId);
    const columns = reconcileSplitColumnsForPanes(
      targetWorkspace.splitColumns,
      targetWorkspace.panes.map((candidate) => candidate.id),
    );
    const columnIndex = columns.findIndex((column) => column.includes(targetPane.id));
    const rowIndex = columnIndex < 0 ? -1 : columns[columnIndex].indexOf(targetPane.id);
    if (columnIndex < 0 || rowIndex < 0) {
      summary.skipped.push(...selectedIds);
      return { workspaces: workspaces.map(cloneWorkspace), summary };
    }
    if (split.zone === "left" || split.zone === "right") {
      columns.splice(columnIndex + (split.zone === "right" ? 1 : 0), 0, [paneId]);
    } else {
      columns[columnIndex].splice(rowIndex + (split.zone === "down" ? 1 : 0), 0, paneId);
    }
    targetWorkspace.panes.push(pane);
    targetWorkspace.splitColumns = columns;
  } else if (newPanePosition !== undefined) {
    const position = newPanePosition;
    const baseId = `pane-${mutation.operationId}`;
    let paneId = baseId;
    let suffix = 2;
    while (targetWorkspace.panes.some((pane) => pane.id === paneId)) {
      paneId = `${baseId}-${suffix}`;
      suffix += 1;
    }
    const activeTabId = selectedSet.has(mutation.anchorTabId)
      ? mutation.anchorTabId
      : selectedTabs[0].id;
    const pane = makePaneFromTabs(paneId, selectedTabs, activeTabId);
    const postCleanupPaneIds = targetWorkspace.panes
      .filter((candidate) => candidate.tabs.length > 0)
      .map((candidate) => candidate.id);
    const columns = reconcileSplitColumnsForPanes(targetWorkspace.splitColumns, postCleanupPaneIds);
    const column = Math.max(0, Math.min(position.column, columns.length));
    if (column === columns.length) {
      columns.push([paneId]);
    } else {
      const row = Math.max(0, Math.min(position.row, columns[column].length));
      columns[column].splice(row, 0, paneId);
    }
    targetWorkspace.panes.push(pane);
    targetWorkspace.splitColumns = columns;
  } else {
    summary.skipped.push(...selectedIds);
    return { workspaces: workspaces.map(cloneWorkspace), summary };
  }
  summary.moved.push(...selectedIds);

  return {
    workspaces: result.map((workspace) => {
      if (!summary.affectedWorkspaces.includes(workspace.id)) return workspace;
      const previous = originalsById.get(workspace.id);
      return previous ? cleanWorkspace(workspace, previous, summary) : workspace;
    }),
    summary,
  };
}
