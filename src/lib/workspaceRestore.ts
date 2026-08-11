import {
  useWorkspaceListStore,
  useWorkspaceLayoutStore,
} from "../stores/workspaceStore";
import type { WorkspaceConfig } from "./ipc";
import type { Workspace } from "../types";

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
