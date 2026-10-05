import type { Pane, PaneTab, Workspace } from "../types";

export type PaneCloseTarget =
  | { kind: "tab"; workspaceId: string; paneId: string; tabId: string }
  | { kind: "pane"; workspaceId: string; paneId: string }
  | { kind: "tabs"; tabIds: readonly string[] };

export interface PaneCloseOwner { workspace: Workspace; pane: Pane; tab: PaneTab }
export type PaneClosePreflight =
  | { ok: true; owners: PaneCloseOwner[]; panes: Pane[] }
  | { ok: false; reason: "missing" | "last" };

/** Read-only structural guard. Run before confirmation, kill, cache or undo changes. */
export function preflightPaneClose(workspaces: readonly Workspace[], target: PaneCloseTarget): PaneClosePreflight {
  const selected = target.kind === "tabs" ? new Set(target.tabIds) : null;
  const owners: PaneCloseOwner[] = [];
  const panes: Pane[] = [];
  for (const workspace of workspaces) {
    if (target.kind !== "tabs" && workspace.id !== target.workspaceId) continue;
    for (const pane of workspace.panes) {
      if (target.kind !== "tabs" && pane.id !== target.paneId) continue;
      const tabs = pane.tabs.filter(tab => target.kind === "pane"
        || (target.kind === "tab" ? tab.id === target.tabId : selected!.has(tab.id)));
      if (tabs.length === 0 && target.kind !== "pane") continue;
      if (target.kind === "pane" && workspace.panes.length <= 1) return { ok: false, reason: "last" };
      if (workspace.panes.length <= 1 && tabs.length === pane.tabs.length && tabs.length > 0) return { ok: false, reason: "last" };
      panes.push({ ...pane, tabs });
      for (const tab of tabs) owners.push({ workspace, pane, tab });
    }
  }
  return panes.length > 0 || target.kind === "tabs" ? { ok: true, owners, panes } : { ok: false, reason: "missing" };
}
