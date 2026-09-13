import {
  useWorkspaceListStore,
  useWorkspaceLayoutStore,
} from "../stores/workspaceStore";
import type { WorkspaceConfig } from "./ipc";
import type { Workspace } from "../types";
import { detachedMetadata, resolveDetachedReturnTarget, type DetachedReturnTarget } from "./detachedPane";

/**
 * Turning a persisted `WorkspaceConfig[]` into live workspaces.
 *
 * Extracted from the leader restore path in `SocketListener.tsx` so the
 * multi-window adoption paths (child boot after a tear-out, main after a
 * merge-back) go through the **same** `restorePanes` → `createWorkspace`
 * sequence instead of a second, subtly different implementation. A forked
 * restore is how a moved workspace would come back with the wrong session ids
 * — and a wrong session id means a respawned agent instead of a reattach.
 */

/** Transpose row-major split indices to column-major for legacy data migration */
export function transposeSplitRowsToCols(splitRows: number[][]): number[][] {
  if (!splitRows.length) return [];
  const maxCols = Math.max(...splitRows.map((r) => r.length));
  const cols: number[][] = [];
  for (let c = 0; c < maxCols; c++) {
    const col: number[] = [];
    for (const row of splitRows) {
      if (c < row.length) col.push(row[c]);
    }
    if (col.length > 0) cols.push(col);
  }
  return cols;
}

export interface RestoreSelection {
  /** Main-window adoption docks returned panes; child boot keeps them isolated. */
  dockDetached?: boolean;
  placementByWorkspaceId?: Record<string, DetachedReturnTarget>;
  activeWorkspaceId?: string | null;
  activePaneId?: string | null;
  activeTabId?: string | null;
}

export interface RestoreResult {
  restoredWorkspaceIds: string[];
  /** Session id of the pane the selection pointed at, if it was restored. */
  activePaneSessionId: string | null;
}

/**
 * Restore configs into the list/layout stores. Nothing is activated here —
 * both call sites decide the selection themselves (startup restores the
 * persisted one; adoption keeps whatever the window was already looking at).
 */
export function restoreWorkspaceConfigs(
  configs: WorkspaceConfig[],
  selection: RestoreSelection = {},
): RestoreResult {
  const listStore = useWorkspaceListStore.getState();
  const layoutStore = useWorkspaceLayoutStore.getState();
  const restoredWorkspaceIds: string[] = [];
  let activePaneSessionId: string | null = null;

  for (const cfg of configs) {
    const currentWorkspaces = useWorkspaceListStore.getState().workspaces;
    const placement = selection.placementByWorkspaceId?.[cfg.id];
    const placementWorkspace = placement?.kind === "pane" || placement?.kind === "pane-zone"
      ? currentWorkspaces.find((workspace) => workspace.id === placement.workspaceId) : undefined;
    const destination = placementWorkspace && (placement?.kind === "pane" || placement?.kind === "pane-zone")
      ? placementWorkspace.panes.find((pane) => pane.id === placement.paneId) : undefined;
    const incomingTabs = cfg.panes.length === 1 ? cfg.panes[0].tabs : undefined;
    const canPlace = destination && incomingTabs?.length
      && !placementWorkspace!.panes.some((pane) => pane.tabs.some((tab) => incomingTabs.some((incoming) => incoming.tab_id === tab.id)));
    const validPlacement = canPlace && placement?.kind === "pane" && Number.isSafeInteger(placement.index)
      ? { ...placement, index: Math.max(0, Math.min(placement.index, destination.tabs.length)) }
      : canPlace && placement?.kind === "pane-zone"
        ? placement.zone === "center"
          ? { kind: "pane" as const, workspaceId: placement.workspaceId, paneId: placement.paneId, index: destination.tabs.length }
          : placement
        : undefined;
    const target = validPlacement ?? (selection.dockDetached
      ? resolveDetachedReturnTarget(cfg, currentWorkspaces)
      : { kind: "workspace" as const });
    if (target.kind === "pane-zone" && target.zone !== "center") {
      const workspace = useWorkspaceListStore.getState().getWorkspace(target.workspaceId)!;
      const paneConfig = cfg.panes[0];
      const paneId = workspace.panes.some((pane) => pane.id === paneConfig.pane_id) ? undefined : paneConfig.pane_id;
      const returnedPane = layoutStore.restorePanes(workspace.id,
        [{ ...paneConfig, pane_id: paneId }], [[0]], "1x1").panes[0];
      if (returnedPane?.tabs.length && layoutStore.insertRestoredPaneToSplit(workspace.id, target.paneId, returnedPane, target.zone)) {
        restoredWorkspaceIds.push(workspace.id);
        if (cfg.id === selection.activeWorkspaceId) activePaneSessionId = returnedPane.sessionId;
        continue;
      }
    }
    if (target.kind === "recreate-pane") {
      const workspace = useWorkspaceListStore.getState().getWorkspace(target.workspaceId)!;
      const restored = layoutStore.restorePanes(workspace.id,
        [{ ...cfg.panes[0], pane_id: target.paneId }], [[0]], "1x1");
      const returnedPane = restored.panes[0];
      if (!returnedPane?.tabs.length) continue;
      const columns = (workspace.splitColumns?.length
        ? workspace.splitColumns : [workspace.panes.map((pane) => pane.id)])
        .map((column) => [...column]).filter((column) => column.length > 0);
      const column = Math.min(target.column, columns.length);
      if (target.newColumn || column === columns.length) columns.splice(column, 0, [returnedPane.id]);
      else columns[column].splice(Math.min(target.row, columns[column].length), 0, returnedPane.id);
      listStore._updateWorkspacePanes(workspace.id, [...workspace.panes, returnedPane], columns, true);
      restoredWorkspaceIds.push(workspace.id);
      if (cfg.id === selection.activeWorkspaceId) activePaneSessionId = returnedPane.tabs[0].sessionId;
      continue;
    }
    if (target.kind === "pane") {
      const workspace = useWorkspaceListStore.getState().getWorkspace(target.workspaceId)!;
      const pane = workspace.panes.find((candidate) => candidate.id === target.paneId)!;
      const restored = layoutStore.restorePanes(
        workspace.id,
        [{ ...cfg.panes[0], pane_id: pane.id }],
        [[0]],
        "1x1",
      );
      const tabs = restored.panes[0]?.tabs ?? [];
      if (tabs.length === 0) continue;
      const returnedPane = {
        ...pane,
        tabs: [...pane.tabs.slice(0, target.index), ...tabs, ...pane.tabs.slice(target.index)],
      };
      listStore._updateWorkspacePanes(workspace.id, workspace.panes.map((candidate) =>
        candidate.id === pane.id ? returnedPane : candidate));
      restoredWorkspaceIds.push(workspace.id);
      if (cfg.id === selection.activeWorkspaceId) activePaneSessionId = tabs[0].sessionId;
      continue;
    }
    // Use split_columns if available; fall back to transposed split_rows for old data
    const splitData = cfg.split_columns
      ?? (cfg.split_rows ? transposeSplitRowsToCols(cfg.split_rows) : null);
    const { panes, splitColumns } = layoutStore.restorePanes(
      cfg.id,
      cfg.panes,
      splitData,
      cfg.grid_template_id as Workspace["gridTemplateId"],
    );

    listStore.createWorkspace(
      cfg.name,
      cfg.grid_template_id as Workspace["gridTemplateId"],
      panes,
      splitColumns,
      {
        id: cfg.id,
        createdAt: cfg.created_at,
        color: cfg.color ?? undefined,
        pet: cfg.pet ?? undefined,
        columnWidths: cfg.column_widths ?? undefined,
        rowHeightsPerCol: cfg.row_heights_per_col ?? undefined,
        activate: false,
      },
    );
    if (cfg.detached && !selection.dockDetached) {
      const current = useWorkspaceListStore.getState();
      current._replaceWorkspaces(current.workspaces.map((workspace) =>
        workspace.id === cfg.id ? { ...workspace, ...detachedMetadata(cfg) } : workspace));
    }
    restoredWorkspaceIds.push(cfg.id);

    if (cfg.id === selection.activeWorkspaceId) {
      const activePane = selection.activePaneId
        ? panes.find((pane) => pane.id === selection.activePaneId)
        : panes.find((pane) => pane.tabs.some((tab) => tab.id === selection.activeTabId));
      const activeTab = activePane?.tabs.find((tab) => tab.id === selection.activeTabId);
      activePaneSessionId = activeTab?.sessionId ?? activePane?.sessionId ?? null;
    }
  }

  return { restoredWorkspaceIds, activePaneSessionId };
}

/**
 * Workspaces already in the store must never be restored a second time: a
 * duplicate `createWorkspace` would mount a second XTermWrapper for the same
 * session id, and `create_session` streams a session to exactly one webview
 * (`pty/manager.rs::replace_data_channel`) — the two copies would fight over
 * the channel.
 */
export function filterAlreadyRestoredConfigs(configs: WorkspaceConfig[]): WorkspaceConfig[] {
  const known = new Set(useWorkspaceListStore.getState().workspaces.map((ws) => ws.id));
  const seen = new Set<string>();
  return configs.filter((cfg) => {
    if (!cfg.id || known.has(cfg.id) || seen.has(cfg.id)) return false;
    seen.add(cfg.id);
    return true;
  });
}
