import { useCallback, useMemo, memo } from "react";
import { Allotment } from "allotment";
import "allotment/dist/style.css";
import type { Pane, GridTemplateId } from "../../types";
import { useWorkspaceLayoutStore } from "../../stores/workspaceStore";
import { useWorkspaceListStore } from "../../stores/workspaceListStore";
import { killSession } from "../../lib/ipc";
import TerminalPane from "./TerminalPane";
import { ErrorBoundary } from "../layout/ErrorBoundary";

interface TerminalGridProps {
  workspaceId: string;
  gridTemplateId: GridTemplateId;
  panes: Pane[];
  splitRows?: string[][];
}

export const TerminalGrid = memo(function TerminalGrid({
  workspaceId,
  panes,
  splitRows,
}: TerminalGridProps) {
  const removePaneFromWorkspace = useWorkspaceLayoutStore((s) => s.removePaneFromWorkspace);
  const addPaneToWorkspace = useWorkspaceLayoutStore((s) => s.addPaneToWorkspace);

  const handleClose = useCallback((paneId: string) => {
    // Kill all PTY sessions — read fresh state to avoid stale closure
    const ws = useWorkspaceListStore.getState().getWorkspace(workspaceId);
    const pane = ws?.panes.find((p) => p.id === paneId);
    if (pane) {
      for (const tab of pane.tabs) {
        killSession(tab.sessionId).catch(() => {});
      }
    }
    removePaneFromWorkspace(workspaceId, paneId);
  }, [workspaceId, removePaneFromWorkspace]);

  const handleSplitRight = useCallback((paneId: string) => {
    addPaneToWorkspace(workspaceId, paneId, "right");
  }, [workspaceId, addPaneToWorkspace]);

  const handleSplitDown = useCallback((paneId: string) => {
    addPaneToWorkspace(workspaceId, paneId, "down");
  }, [workspaceId, addPaneToWorkspace]);

  const paneMap = useMemo(() => Object.fromEntries(panes.map((p) => [p.id, p])), [panes]);

  // Always use splitRows for consistent React tree structure
  // This prevents component remounting when pane count changes
  if (splitRows) {
    // Use splitRows if available, otherwise flat horizontal layout
    const rows: string[][] = splitRows ?? [panes.map((p) => p.id)];

    return (
      <Allotment vertical separator={false}>
        {rows.map((row, rowIdx) => (
          <Allotment.Pane key={`row-${rowIdx}`}>
            <Allotment separator={false}>
              {row.map((paneId) => {
                const pane = paneMap[paneId];
                if (!pane) return null;
                return (
                  <Allotment.Pane key={pane.id}>
                    <ErrorBoundary>
                    <TerminalPane
                      pane={pane}
                      workspaceId={workspaceId}
                      onClose={() => handleClose(pane.id)}
                      onSplitRight={() => handleSplitRight(pane.id)}
                      onSplitDown={() => handleSplitDown(pane.id)}
                    />
                    </ErrorBoundary>
                  </Allotment.Pane>
                );
              })}
            </Allotment>
          </Allotment.Pane>
        ))}
      </Allotment>
    );
  }

  // Fallback: no splitRows (should not happen with current store logic)
  // Render a flat horizontal layout
  return (
    <Allotment vertical separator={false}>
      <Allotment.Pane>
        <Allotment separator={false}>
          {panes.map((pane) => (
            <Allotment.Pane key={pane.id}>
              <ErrorBoundary>
                <TerminalPane
                  pane={pane}
                  workspaceId={workspaceId}
                  onClose={() => handleClose(pane.id)}
                  onSplitRight={() => handleSplitRight(pane.id)}
                  onSplitDown={() => handleSplitDown(pane.id)}
                />
              </ErrorBoundary>
            </Allotment.Pane>
          ))}
        </Allotment>
      </Allotment.Pane>
    </Allotment>
  );
});

// Wrapper: renders ALL workspaces simultaneously, hides inactive ones with CSS.
// This prevents xterm.js unmount/remount on workspace switch, keeping sessions alive.
export default function WorkspaceView() {
  const activeId = useWorkspaceListStore((s) => s.activeWorkspaceId);
  const workspaces = useWorkspaceListStore((s) => s.workspaces);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      {workspaces
        .filter((ws) => ws.panes.length > 0)
        .map((ws) => {
          const isActive = ws.id === activeId;
          return (
            <div
              key={ws.id}
              style={{
                position: "absolute",
                inset: 0,
                visibility: isActive ? "visible" : "hidden",
                pointerEvents: isActive ? "auto" : "none",
                zIndex: isActive ? 1 : 0,
              }}
            >
              <TerminalGrid
                workspaceId={ws.id}
                gridTemplateId={ws.gridTemplateId}
                panes={ws.panes}
                splitRows={ws.splitRows}
              />
            </div>
          );
        })}
    </div>
  );
}
