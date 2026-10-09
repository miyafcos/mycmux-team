import { getTabDisplayLabel } from "./tabDisplayLabel";
import { canTransferTab, paneTabKind } from "./paneKindCapabilities";
import type { DetachedPaneOrigin, WorkspaceConfig } from "./ipc";
import type { PaneDropZone } from "../stores/paneDragStore";
import type { PaneTab, Workspace } from "../types";

/** Only carry a PTY identity when this window has no other tab using it. */
export function portableSessionId(
  sessionId: string | null | undefined,
  occupiedSessionIds: ReadonlySet<string>,
): string | undefined {
  return typeof sessionId === "string"
    && sessionId.startsWith("pty-")
    && !occupiedSessionIds.has(sessionId)
    ? sessionId
    : undefined;
}


/** Optional schema-1 ownership extension; kept here with the window restore
 * code so the i4 change does not alter unrelated IPC declarations. */
export interface SavedWindowGroup {
  label: string;
  decorated?: boolean;
  native_tearout?: boolean;
  frame?: WorkspaceConfig["window_frame"];
  active_workspace_id?: string | null;
  active_pane_id?: string | null;
  active_tab_id?: string | null;
}
export type SavedWindowWorkspace = WorkspaceConfig & { window_group?: SavedWindowGroup | null };
export interface SavedWindow {
  label?: string;
  configs: SavedWindowWorkspace[];
  group?: SavedWindowGroup;
  frame?: WorkspaceConfig["window_frame"];
}

/** Old unmarked workspaces remain in main; old detached panes stay separate.
 * Repeated partitioning is pure and stable, and duplicate IDs are not revived. */
export function partitionSavedWindows(configs: readonly WorkspaceConfig[]): {
  main: WorkspaceConfig[]; windows: SavedWindow[];
} {
  const main: WorkspaceConfig[] = [], groups = new Map<string, SavedWindow>();
  const legacy: SavedWindow[] = [], seen = new Set<string>();
  for (const config of configs as readonly SavedWindowWorkspace[]) {
    if (seen.has(config.id)) continue;
    seen.add(config.id);
    const group = config.window_group;
    const label = group?.label;
    const validChild = typeof label === "string" && /^mycmux-w[1-9]\d*$/.test(label)
      && Number(label.slice("mycmux-w".length)) <= 0xffffffff;
    if (validChild) {
      let saved = groups.get(label!);
      if (!saved) {
        saved = { label, configs: [], group: group!, frame: group?.frame ?? config.window_frame };
        groups.set(label!, saved);
      }
      saved.configs.push(config);
    } else if (label !== "main" && config.detached) {
      legacy.push({ configs: [config], frame: config.window_frame });
    } else {
      main.push(config);
    }
  }
  // Reserve recorded labels before unnamed legacy windows allocate free ones.
  return { main, windows: [...groups.values(), ...legacy] };
}

export type DetachedWorkspace = Workspace & Pick<WorkspaceConfig, "detached" | "detached_from">;

export function detachedMetadata(source: object | undefined): Pick<WorkspaceConfig, "detached" | "detached_from"> {
  const workspace = source as DetachedWorkspace | undefined;
  return workspace?.detached === true
    ? { detached: true, detached_from: workspace.detached_from }
    : {};
}

export function isDetachableTab(tab: { type?: string | null; ephemeral?: boolean }): boolean {
  return paneTabKind(tab) !== "unknown" && canTransferTab(tab);
}

/** Tabs supported by the live window-transfer serializer. */
export function isTransferableTab(tab: { type?: string | null; ephemeral?: boolean }): boolean {
  return canTransferTab(tab);
}

/** Capture the source position before moving a single tab into its transfer workspace. */
export function detachedOriginForDrag(
  workspace: Workspace | undefined,
  item: { kind: string; paneId: string; tabId?: string },
): DetachedPaneOrigin | undefined {
  if (!workspace || item.kind !== "tab") return undefined;
  const pane = workspace.panes.find((candidate) => candidate.id === item.paneId);
  const index = pane?.tabs.findIndex((tab) => tab.id === item.tabId) ?? -1;
  const tab = pane?.tabs[index];
  if (!tab || !isDetachableTab(tab)) return undefined;
  const columns = workspace.splitColumns?.length ? workspace.splitColumns : [workspace.panes.map((pane) => pane.id)];
  const column = columns.findIndex((ids) => ids.includes(pane!.id));
  const position = column < 0 ? {} : { column, row: columns[column].indexOf(pane!.id), column_size: columns[column].length };
  return { workspace_id: workspace.id, pane_id: pane!.id, tab_id: tab.id, index, ...position };
}

/** Normalize an already moved, single-tab workspace for a content-only child. */
export function detachedWorkspaceConfig(
  config: WorkspaceConfig,
  origin: DetachedPaneOrigin,
): WorkspaceConfig | null {
  const pane = config.panes[0];
  const tab = pane?.tabs?.[0];
  if (config.panes.length !== 1 || pane.tabs?.length !== 1 || !tab || !isDetachableTab(tab)) return null;
  return {
    ...config,
    name: getTabDisplayLabel({ label: tab.label ?? undefined, labelSource: tab.label_source ?? undefined, displayName: tab.display_name ?? undefined, agentId: tab.agent_id, cwd: tab.cwd ?? undefined }),
    grid_template_id: "1x1",
    panes: [{ ...pane, active_tab_id: tab.tab_id, tabs: [tab] }],
    split_columns: [[0]],
    column_widths: [1],
    row_heights_per_col: [[1]],
    // One pane in one column: there is no divider to have dragged.
    column_divider_pins: [],
    row_divider_pins_per_col: [[]],
    detached: true,
    detached_from: { ...origin },
  };
}

/** Only a single supported pane in a child window opts out of the normal shell. */
export function detachedWorkspaceForWindow(
  workspaces: readonly Workspace[],
  isMain: boolean,
): DetachedWorkspace | null {
  if (isMain || workspaces.length !== 1) return null;
  const workspace = workspaces[0] as DetachedWorkspace;
  const pane = workspace.panes[0];
  const tab: PaneTab | undefined = pane?.tabs[0];
  return workspace.detached === true && workspace.panes.length === 1
    && pane.tabs.length === 1 && tab && isDetachableTab(tab)
    ? workspace : null;
}


export type DetachedReturnTarget =
  | { kind: "pane-zone"; workspaceId: string; paneId: string; zone: PaneDropZone }
  | { kind: "pane"; workspaceId: string; paneId: string; index: number }
  | { kind: "recreate-pane"; workspaceId: string; paneId: string; column: number; row: number; newColumn: boolean }
  | { kind: "workspace" };

/** Resolve against the current layout: the original pane may have been closed. */
export function resolveDetachedReturnTarget(
  config: WorkspaceConfig,
  workspaces: readonly Workspace[],
): DetachedReturnTarget {
  const origin = config.detached_from;
  const incoming = config.panes[0]?.tabs;
  if (!origin || config.panes.length !== 1 || incoming?.length !== 1
    || !Number.isSafeInteger(origin.index)) return { kind: "workspace" };
  const workspace = workspaces.find((candidate) => candidate.id === origin.workspace_id);
  const pane = workspace?.panes.find((candidate) => candidate.id === origin.pane_id);
  // A repeated tab identity cannot be inserted twice into the same pane.
  if (!workspace) return { kind: "workspace" };
  if (!pane) {
    if (!Number.isSafeInteger(origin.column) || origin.column! < 0
      || !Number.isSafeInteger(origin.row) || origin.row! < 0
      || workspace.panes.some((candidate) => candidate.tabs.some((tab) => tab.id === incoming[0].tab_id))) {
      return { kind: "workspace" };
    }
    return { kind: "recreate-pane", workspaceId: workspace.id, paneId: origin.pane_id,
      column: origin.column!, row: origin.row!, newColumn: origin.column_size === 1 };
  }
  if (pane.tabs.some((tab) => tab.id === incoming[0].tab_id)) return { kind: "workspace" };
  return { kind: "pane", workspaceId: workspace.id, paneId: pane.id,
    index: Math.max(0, Math.min(origin.index, pane.tabs.length)) };
}
