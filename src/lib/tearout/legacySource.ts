import { flushSync } from "react-dom";
import type { PaneDragItem } from "../../stores/paneDragStore";
import { useWorkspaceListStore } from "../../stores/workspaceListStore";
import { useUiStore } from "../../stores/uiStore";
import { restoreTearoutGroup, restoreTearoutSource } from "./model";

/** Snapshot before the drag mutates order, pin or active selection. */
export function captureLegacyTearoutSource(item: PaneDragItem): (transferId: string) => void {
  const list = useWorkspaceListStore.getState(), ui = useUiStore.getState();
  const source = list.getWorkspace(item.workspaceId);
  const index = list.workspaces.findIndex(ws => ws.id === item.workspaceId);
  const selection = { workspace: list.activeWorkspaceId, session: ui.activePaneId, zoom: ui.zoomedPaneId,
    remembered: list.lastActivePaneByWorkspace[item.workspaceId] };
  return transferId => {
    if (!source) throw new Error("tearout_source_snapshot_missing");
    const current = useWorkspaceListStore.getState();
    let next = current.workspaces.filter(ws => ws.id !== transferId);
    if (item.kind === "pane") next = restoreTearoutGroup(next, source, [item.paneId], index);
    else for (const id of item.kind === "tab" ? [item.tabId] : item.tabIds) next = restoreTearoutSource(next, source, id, index);
    // A bundle is restored in its original order, not in gesture selection order.
    next = next.map(ws => ws.id !== source.id ? ws : { ...ws, panes: ws.panes.map(pane => {
      const original = source.panes.find(old => old.id === pane.id);
      if (!original || original.tabs.length !== pane.tabs.length || !original.tabs.every(tab => pane.tabs.some(now => now.id === tab.id))) return pane;
      return { ...original, tabs: original.tabs.map(tab => pane.tabs.find(now => now.id === tab.id)!) };
    }) });
    flushSync(() => {
      current._replaceWorkspaces(next);
      useWorkspaceListStore.setState(state => {
        const remembered = { ...state.lastActivePaneByWorkspace }; delete remembered[transferId];
        if (selection.remembered) remembered[source.id] = selection.remembered; else delete remembered[source.id];
        return { activeWorkspaceId: selection.workspace, lastActivePaneByWorkspace: remembered };
      });
      useUiStore.setState({ activePaneId: selection.session, zoomedPaneId: selection.zoom });
    });
  };
}
