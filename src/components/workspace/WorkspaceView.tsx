import { useCallback, useEffect, useMemo, memo, useRef, useState } from "react";
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
  const setWorkspaceLayoutMetrics = useWorkspaceListStore((s) => s.setWorkspaceLayoutMetrics);
  const workspace = useWorkspaceListStore((s) => s.getWorkspace(workspaceId));

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
  const rowKeyStateRef = useRef<{
    nextId: number;
    entries: Array<{ key: string; paneIds: string[] }>;
  }>({
    nextId: 0,
    entries: [],
  });

  // Always use splitRows for consistent React tree structure
  // This prevents component remounting when pane count changes
  if (splitRows) {
    // Use splitRows if available, otherwise flat horizontal layout
    const rows: string[][] = splitRows ?? [panes.map((p) => p.id)];
    const rowSizes = workspace?.rowSizes?.length === rows.length ? workspace.rowSizes : undefined;
    const columnSizes = workspace?.columnSizes;
    const nextEntries: Array<{ key: string; paneIds: string[] }> = [];
    const availableEntries = [...rowKeyStateRef.current.entries];

    const keyedRows = rows.map((row) => {
      let bestIdx = -1;
      let bestOverlap = 0;

      for (let idx = 0; idx < availableEntries.length; idx++) {
        const overlap = availableEntries[idx].paneIds.filter((paneId) => row.includes(paneId)).length;
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestIdx = idx;
        }
      }

      const entry = bestIdx >= 0
        ? availableEntries.splice(bestIdx, 1)[0]
        : { key: `row-${workspaceId}-${rowKeyStateRef.current.nextId++}`, paneIds: row };
      const nextEntry = { key: entry.key, paneIds: row };
      nextEntries.push(nextEntry);
      return { row, key: nextEntry.key };
    });

    rowKeyStateRef.current.entries = nextEntries;

    return (
      <Allotment
        vertical
        separator={false}
        defaultSizes={rowSizes}
        onChange={(sizes) => {
          const currentWorkspace = useWorkspaceListStore.getState().getWorkspace(workspaceId);
          setWorkspaceLayoutMetrics(workspaceId, sizes, currentWorkspace?.columnSizes);
        }}
      >
        {keyedRows.map(({ row, key }, rowIdx) => (
          <Allotment.Pane key={key}>
            <Allotment
              key={`columns-${key}`}
              separator={false}
              defaultSizes={columnSizes?.[rowIdx]?.length === row.length ? columnSizes[rowIdx] : undefined}
              onChange={(sizes) => {
                const currentWorkspace = useWorkspaceListStore.getState().getWorkspace(workspaceId);
                const currentColumnSizes = currentWorkspace?.columnSizes;
                const nextColumnSizes = rows.map((currentRow, currentRowIdx) => {
                  if (currentRowIdx === rowIdx) return sizes;
                  return currentColumnSizes?.[currentRowIdx]?.length === currentRow.length
                    ? currentColumnSizes[currentRowIdx]
                    : [];
                });
                setWorkspaceLayoutMetrics(workspaceId, currentWorkspace?.rowSizes, nextColumnSizes);
              }}
            >
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
  const [mountedWorkspaceIds, setMountedWorkspaceIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!activeId) return;
    setMountedWorkspaceIds((prev) => {
      if (prev.has(activeId)) {
        return prev;
      }
      const next = new Set(prev);
      next.add(activeId);
      return next;
    });
  }, [activeId]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      {workspaces
        .filter((ws) => ws.panes.length > 0 && (mountedWorkspaceIds.has(ws.id) || ws.id === activeId))
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
