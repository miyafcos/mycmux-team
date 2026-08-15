import type { DashboardDisplayState } from "./dashboardModel";
import { buildMinimapModel } from "./minimapModel";
import { MinimapPaneCell } from "./MinimapPaneCell";
import type { Workspace } from "../../types";
import { resolveWorkspaceColor } from "../../lib/workspaceColors";

export function MinimapWorkspaceBlock({ workspace, selectedTabId, displayStateByTabId, expanded, activePaneId, onToggle, onSelect }: {
  workspace: Workspace;
  selectedTabId: string | null;
  displayStateByTabId: ReadonlyMap<string, DashboardDisplayState>;
  expanded: boolean;
  activePaneId: string | null;
  onToggle: () => void;
  onSelect: (tabId: string) => void;
}) {
  const model = buildMinimapModel(workspace, { activePaneId });
  const needsAnswer = model.columns.flatMap((column) => column.cells).flatMap((cell) => cell.chips)
    .filter((chip) => displayStateByTabId.get(chip.tabId) === "needsHuman").length;
  const tabCount = workspace.panes.reduce((total, pane) => total + pane.tabs.length, 0);
  // 実画面のタブバーと同じ解決 (TabItem 参照): 未設定の WS には色を発明しない。
  const workspaceColor = resolveWorkspaceColor(workspace.color)?.value;
  const cells = model.columns.flatMap((column) => column.cells);
  return <section className={`cmux-minimap-workspace${expanded ? " is-expanded" : ""}`} data-minimap-workspace={workspace.id} style={workspaceColor ? { borderLeftColor: workspaceColor } : undefined}>
    <button type="button" className="cmux-minimap-workspace-header" aria-expanded={expanded} onClick={onToggle} title={workspace.name}>
      <span className="cmux-minimap-workspace-name" title={workspace.name}>{workspace.name}</span>
      <span className="cmux-minimap-workspace-summary">{needsAnswer ? <span className="cmux-minimap-workspace-question">{`❓${needsAnswer}`}</span> : null}<span>{`● ${tabCount}本`}</span></span>
    </button>
    {expanded ? <div className="cmux-minimap-pane-list">
      {cells.map((cell, index) => <MinimapPaneCell key={cell.paneId} cell={cell} workspaceId={workspace.id} selectedTabId={selectedTabId} displayStateByTabId={displayStateByTabId} presentation="list" paneLabel={`P${index + 1}`} onSelect={onSelect} />)}
    </div> : <div className="cmux-minimap-map">
      {model.columns.map((column) => <div key={column.index} className="cmux-minimap-column" style={{ flexGrow: column.widthShare }}>
        {column.cells.map((cell) => <MinimapPaneCell key={cell.paneId} cell={cell} workspaceId={workspace.id} selectedTabId={selectedTabId} displayStateByTabId={displayStateByTabId} presentation="map" onSelect={onSelect} />)}
      </div>)}
    </div>}
  </section>;
}
