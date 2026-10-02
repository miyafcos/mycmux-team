import type { Workspace } from "../../types";
import type { DockTarget } from "../../stores/detachedDockStore";

export type Rect = { x: number; y: number; width: number; height: number };
export function outsideTearoutStrip(x: number, y: number, r: Rect): boolean {
  return Math.max(r.x - x, x - r.x - r.width, r.y - y, y - r.y - r.height) > 12;
}

/** Restore only the moved tab and its source geometry, preserving other workspaces. */
export function restoreTearoutSource(current: Workspace[], before: Workspace, tabId: string, workspaceIndex = current.length): Workspace[] {
  const originalPane = before.panes.find((pane) => pane.tabs.some((tab) => tab.id === tabId));
  const tab = originalPane?.tabs.find((tab) => tab.id === tabId);
  if (!originalPane || !tab) throw new Error("tearout_source_snapshot_missing");
  if (current.some((workspace) => workspace.panes.some((pane) => pane.tabs.some((t) => t.id === tabId)))) return current;
  const existing = current.find((workspace) => workspace.id === before.id);
  if (!existing) {
    const next = [...current];
    next.splice(Math.min(workspaceIndex, next.length), 0, before);
    return next;
  }
  const pane = existing.panes.find((pane) => pane.id === originalPane.id);
  const index = originalPane.tabs.findIndex((tab) => tab.id === tabId);
  const tabs = pane ? [...pane.tabs.slice(0, index), tab, ...pane.tabs.slice(index)] : originalPane.tabs;
  const sameTabs = tabs.length === originalPane.tabs.length && tabs.every(tab => originalPane.tabs.some(original => original.id === tab.id));
  const restored = pane ? {
    ...(sameTabs ? originalPane : pane), activeTabId: originalPane.activeTabId, sessionId: originalPane.sessionId, tabs,
  } : originalPane;
  const panes = pane ? existing.panes.map((p) => p.id === pane.id ? restored : p)
    : before.panes.flatMap((p) => p.id === originalPane.id ? [restored]
      : existing.panes.filter((candidate) => candidate.id === p.id))
      .concat(existing.panes.filter((candidate) => !before.panes.some((old) => old.id === candidate.id)));
  const columns = (before.splitColumns ?? [before.panes.map((pane) => pane.id)]).map((col) =>
    col.filter((id) => panes.some((pane) => pane.id === id))).filter((col) => col.length);
  for (const newPane of panes) if (!columns.some((col) => col.includes(newPane.id))) columns.push([newPane.id]);
  const sameGeometry = panes.length === before.panes.length && panes.every((pane) => before.panes.some((old) => old.id === pane.id));
  const next = { ...existing, panes,
    splitColumns: sameGeometry ? before.splitColumns : columns, columnWidths: sameGeometry ? before.columnWidths : undefined,
    rowHeightsPerCol: sameGeometry ? before.rowHeightsPerCol : undefined,
    columnDividerPins: sameGeometry ? before.columnDividerPins : undefined,
    rowDividerPinsPerCol: sameGeometry ? before.rowDividerPinsPerCol : undefined };
  return current.map((workspace) => workspace.id === next.id ? next : workspace);
}

/** The ordinary tab close helper intentionally refuses the last tab. */
export function removeTearoutTab(workspaceId: string, paneId: string, tabId: string,
  current: Workspace[]): Workspace[] | null {
  const workspace = current.find((workspace) => workspace.id === workspaceId);
  if (!workspace || workspace.panes.length !== 1 || workspace.panes[0].id !== paneId
    || workspace.panes[0].tabs.length !== 1 || workspace.panes[0].tabs[0].id !== tabId) return null;
  return current.filter((workspace) => workspace.id !== workspaceId);
}

export function nativeDropAllowed(regionCount: number, target: DockTarget | null): boolean {
  return target !== null && (regionCount === 1 || target.kind === "workspace");
}

/** Restore moved regions with their original geometry, retaining unrelated additions. */
export function restoreTearoutGroup(current: Workspace[], before: Workspace, paneIds: string[], workspaceIndex: number): Workspace[] {
  const moved = new Set(paneIds);
  const existing = current.find(workspace => workspace.id === before.id);
  if (!existing) {
    const next = [...current];
    next.splice(Math.min(workspaceIndex, next.length), 0, before);
    return next;
  }
  const panes = before.panes.flatMap(pane => moved.has(pane.id) ? [pane] : existing.panes.filter(p => p.id === pane.id))
    .concat(existing.panes.filter(pane => !before.panes.some(original => original.id === pane.id)));
  const columns = (before.splitColumns ?? [before.panes.map(pane => pane.id)])
    .map(column => column.filter(id => panes.some(pane => pane.id === id))).filter(column => column.length);
  for (const pane of panes) if (!columns.some(column => column.includes(pane.id))) columns.push([pane.id]);
  const sameGeometry = panes.length === before.panes.length && panes.every(pane => before.panes.some(original => original.id === pane.id));
  const restored = { ...existing, panes, splitColumns: sameGeometry ? before.splitColumns : columns,
    columnWidths: sameGeometry ? before.columnWidths : undefined,
    rowHeightsPerCol: sameGeometry ? before.rowHeightsPerCol : undefined,
    columnDividerPins: sameGeometry ? before.columnDividerPins : undefined,
    rowDividerPinsPerCol: sameGeometry ? before.rowDividerPinsPerCol : undefined };
  return current.map(workspace => workspace.id === before.id ? restored : workspace);
}
