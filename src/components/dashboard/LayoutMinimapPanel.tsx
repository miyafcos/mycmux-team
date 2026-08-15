import { memo, useEffect, useMemo, useState } from "react";
import type { DashboardDisplayState } from "./dashboardModel";
import { dashboardStrings } from "./dashboardStrings";
import { MinimapWorkspaceBlock } from "./MinimapWorkspaceBlock";
import { moveMinimapItemToNewWorkspace } from "./minimapWorkspaceActions";
import type { Workspace } from "../../types";
import { paneContainsSession } from "../../stores/workspaceListStore";
import { usePaneDragStore, type PaneDragItem } from "../../stores/paneDragStore";
import "./MinimapPanel.css";

interface LayoutMinimapPanelProps {
  workspaces: readonly Workspace[];
  displayStateByTabId: ReadonlyMap<string, DashboardDisplayState>;
  selectedTabId: string | null;
  activePaneSessionId: string | null;
  onSelect: (tabId: string) => void;
}

export const LayoutMinimapPanel = memo(function LayoutMinimapPanel({ workspaces, displayStateByTabId, selectedTabId, activePaneSessionId, onSelect }: LayoutMinimapPanelProps) {
  const selectedWorkspaceId = useMemo(() => workspaces.find((workspace) => workspace.panes.some((pane) => pane.tabs.some((tab) => tab.id === selectedTabId)))?.id ?? null, [workspaces, selectedTabId]);
  const selectedItem = useMemo<PaneDragItem | null>(() => {
    if (!selectedTabId) return null;
    for (const workspace of workspaces) {
      for (const pane of workspace.panes) {
        const tab = pane.tabs.find((candidate) => candidate.id === selectedTabId);
        if (tab) return {
          kind: "tab",
          surface: "minimap",
          workspaceId: workspace.id,
          paneId: pane.id,
          tabId: tab.id,
          label: tab.label ?? tab.sessionId,
        };
      }
    }
    return null;
  }, [selectedTabId, workspaces]);
  const [expandedWorkspaceId, setExpandedWorkspaceId] = useState<string | null>(selectedWorkspaceId);
  const isNewWorkspaceTarget = usePaneDragStore((state) => state.target?.kind === "new-workspace" && state.target.surface === "minimap");
  useEffect(() => { if (selectedWorkspaceId) setExpandedWorkspaceId(selectedWorkspaceId); }, [selectedWorkspaceId]);
  return <section className="cmux-minimap-panel" aria-label={dashboardStrings.layoutMinimapAriaLabel}>
    <div className="cmux-minimap-title">{dashboardStrings.layoutMinimapTitle}</div>
    <div className="cmux-minimap-stack">
      {workspaces.map((workspace) => {
        const activePaneId = workspace.panes.find((pane) => paneContainsSession(pane, activePaneSessionId))?.id ?? null;
        return <MinimapWorkspaceBlock key={workspace.id} workspace={workspace} selectedTabId={selectedTabId} displayStateByTabId={displayStateByTabId} expanded={expandedWorkspaceId === workspace.id} activePaneId={activePaneId} onToggle={() => setExpandedWorkspaceId((current) => current === workspace.id ? null : workspace.id)} onSelect={onSelect} />;
      })}
    </div>
    <div className={`cmux-minimap-new-workspace-zone${isNewWorkspaceTarget ? " is-minimap-drop-target" : ""}`} data-minimap-new-workspace-target="true">
      <button type="button" data-minimap-new-workspace-button="true" disabled={!selectedItem} onClick={() => { if (selectedItem) moveMinimapItemToNewWorkspace(selectedItem); }}>
        ＋ 新しいワークスペース
      </button>
    </div>
  </section>;
}, areMinimapPropsEqual);

function areMinimapPropsEqual(previous: Readonly<LayoutMinimapPanelProps>, next: Readonly<LayoutMinimapPanelProps>): boolean {
  return previous.workspaces === next.workspaces
    && previous.selectedTabId === next.selectedTabId
    && previous.activePaneSessionId === next.activePaneSessionId
    && previous.onSelect === next.onSelect
    && mapsEqual(previous.displayStateByTabId, next.displayStateByTabId);
}

function mapsEqual<T>(left: ReadonlyMap<string, T>, right: ReadonlyMap<string, T>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) if (right.get(key) !== value) return false;
  return true;
}
