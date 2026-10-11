import type { Pane, PaneTab, Workspace } from "../types";
import { namingBinding } from "./autoNameMaterial";
import { isAutomaticNameTarget } from "./autoNamePolicy";

export interface TabNamePatch {
  id: string; owner: string; label?: string;
  expectedSource: PaneTab["labelSource"];
  labelSource: PaneTab["labelSource"];
  displayName?: string; displayNameSource?: "auto";
  recovery?: boolean;
}
export interface WorkspaceNamePatch {
  id: string; expectedName: string; expectedSource?: "auto";
  name: string; nameSource?: "auto";
}
export interface NamingPatches { tabs: TabNamePatch[]; workspaces: WorkspaceNamePatch[] }
export interface NamingRecoveryRecord {
  beforeTabs: Array<Pick<PaneTab, "id" | "label" | "labelSource" | "displayName" | "displayNameSource"> & { owner: string; namingOwner?: string; expectedSource: PaneTab["labelSource"] }>;
  beforeWorkspaces: Array<{ id: string; name: string; nameSource?: "auto"; members: string }>;
}
const members = (workspace: Workspace) => JSON.stringify(workspace.panes.flatMap(p => p.tabs.map(namingBinding)).sort());
export function beginNamingRecovery(workspaces: readonly Workspace[], workspaceId?: string, effectiveOwner: (tab: PaneTab, pane: Pane) => string = namingBinding): { record: NamingRecoveryRecord; patches: NamingPatches } {
  const record: NamingRecoveryRecord = { beforeTabs: [], beforeWorkspaces: [] };
  const patches: NamingPatches = { tabs: [], workspaces: [] };
  for (const workspace of workspaces) {
    if (workspaceId && workspace.id !== workspaceId) continue;
    record.beforeWorkspaces.push({ id: workspace.id, name: workspace.name, nameSource: workspace.nameSource, members: members(workspace) });
    patches.workspaces.push({ id: workspace.id, expectedName: workspace.name, expectedSource: workspace.nameSource, name: workspace.name, nameSource: "auto" });
    for (const pane of workspace.panes) for (const tab of pane.tabs) {
      if (tab.labelSource === "user") continue;
      const source = tab.labelSource === "ai" ? "ai" : "launch";
      record.beforeTabs.push({ id: tab.id, label: tab.label, labelSource: tab.labelSource, displayName: tab.displayName, displayNameSource: tab.displayNameSource, owner: namingBinding(tab), namingOwner: effectiveOwner(tab, pane), expectedSource: source });
      patches.tabs.push({ id: tab.id, owner: namingBinding(tab), label: tab.label, expectedSource: tab.labelSource,
        labelSource: source, displayName: tab.displayName, displayNameSource: tab.displayName ? "auto" : undefined, recovery: true });
    }
  }
  return { record, patches };
}
export function undoNamingRecovery(workspaces: readonly Workspace[], record: NamingRecoveryRecord): NamingPatches {
  const tabs = workspaces.flatMap(w => w.panes.flatMap(p => p.tabs));
  return {
    tabs: record.beforeTabs.flatMap(before => {
      const tab = tabs.find(t => t.id === before.id);
      if (!tab || tab.labelSource === "user" || tab.labelSource !== before.expectedSource || namingBinding(tab) !== before.owner || tab.label !== before.label || (tab.displayName && tab.displayNameSource !== "auto")) return [];
      return [{ ...before, labelSource: before.labelSource, expectedSource: tab.labelSource, recovery: true }];
    }),
    workspaces: record.beforeWorkspaces.flatMap(before => {
      const workspace = workspaces.find(w => w.id === before.id);
      if (!workspace || workspace.nameSource !== "auto" || members(workspace) !== before.members) return [];
      return [{ id: before.id, expectedName: workspace.name, expectedSource: "auto" as const, name: before.name, nameSource: before.nameSource }];
    }),
  };
}
/** One synchronous compare-and-set; callers can only write name metadata. */
export function applyNamingPatches(workspaces: readonly Workspace[], patches: NamingPatches): Workspace[] {
  const workspacePatches = new Map(patches.workspaces.map(p => [p.id, p]));
  const tabPatches = new Map(patches.tabs.map(p => [p.id, p]));
  return workspaces.map(workspace => {
    const update = workspacePatches.get(workspace.id);
    const ownerMatches = update && workspace.name === update.expectedName && workspace.nameSource === update.expectedSource;
    let changed = Boolean(ownerMatches && (workspace.name !== update.name || workspace.nameSource !== update.nameSource));
    const panes = workspace.panes.map(pane => {
      let changedPane = false;
      const tabs = pane.tabs.map(tab => {
        const patch = tabPatches.get(tab.id);
        if (!patch || tab.labelSource === "user" || tab.labelSource !== patch.expectedSource || tab.label !== patch.label || namingBinding(tab) !== patch.owner
          || (!patch.recovery && !isAutomaticNameTarget(tab))) return tab;
        if (tab.labelSource === patch.labelSource && tab.displayName === patch.displayName && tab.displayNameSource === patch.displayNameSource) return tab;
        changed = changedPane = true;
        return { ...tab, labelSource: patch.labelSource, displayName: patch.displayName, displayNameSource: patch.displayNameSource };
      });
      return changedPane ? { ...pane, tabs } : pane;
    });
    return changed ? { ...workspace, panes, ...(ownerMatches ? { name: update.name, nameSource: update.nameSource } : {}) } : workspace;
  });
}
