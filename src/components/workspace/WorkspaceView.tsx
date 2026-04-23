import { useCallback, useEffect, useMemo, memo, useRef, useState } from "react";
import { Allotment } from "allotment";
import "allotment/dist/style.css";
import type { Pane, GridTemplateId } from "../../types";
import { useWorkspaceLayoutStore, usePaneMetadataStore } from "../../stores/workspaceStore";
import { useWorkspaceListStore } from "../../stores/workspaceListStore";
import { killSession } from "../../lib/ipc";
import { evictTerminalCache } from "../terminal/XTermWrapper";
import TerminalPane from "./TerminalPane";
import { ErrorBoundary } from "../layout/ErrorBoundary";

const MAX_MOUNTED_WORKSPACES = 3;

interface TerminalGridProps {
  workspaceId: string;
  gridTemplateId: GridTemplateId;
  panes: Pane[];
  splitColumns?: string[][];
}

export const TerminalGrid = memo(function TerminalGrid({
  workspaceId,
  panes,
  splitColumns,
}: TerminalGridProps) {
  const removePaneFromWorkspace = useWorkspaceLayoutStore((s) => s.removePaneFromWorkspace);
  const addPaneToWorkspace = useWorkspaceLayoutStore((s) => s.addPaneToWorkspace);
  const setWorkspaceLayoutMetrics = useWorkspaceListStore((s) => s.setWorkspaceLayoutMetrics);
  const workspace = useWorkspaceListStore((s) => s.getWorkspace(workspaceId));

  const handleClose = useCallback((paneId: string) => {
    // Kill all PTY sessions — read fresh state to avoid stale closure
    const ws = useWorkspaceListStore.getState().getWorkspace(workspaceId);
    if (!ws || ws.panes.length <= 1) return;
    const pane = ws.panes.find((p) => p.id === paneId);
    if (pane) {
      for (const tab of pane.tabs) {
        evictTerminalCache(tab.sessionId);
        killSession(tab.sessionId).catch(() => {});
        usePaneMetadataStore.getState().removeMetadata(tab.sessionId);
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
  const colKeyStateRef = useRef<{
    nextId: number;
    entries: Array<{ key: string; paneIds: string[] }>;
  }>({
    nextId: 0,
    entries: [],
  });
  const colResizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rowResizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Column-first layout: outer = horizontal columns, inner = vertical rows within each column
  if (splitColumns) {
    const cols: string[][] = splitColumns ?? [panes.map((p) => p.id)];
    const columnWidths = workspace?.columnWidths?.length === cols.length ? workspace.columnWidths : undefined;
    const rowHeightsPerCol = workspace?.rowHeightsPerCol;
    const nextEntries: Array<{ key: string; paneIds: string[] }> = [];
    const availableEntries = [...colKeyStateRef.current.entries];

    const keyedCols = cols.map((col) => {
      let bestIdx = -1;
      let bestOverlap = 0;

      for (let idx = 0; idx < availableEntries.length; idx++) {
        const overlap = availableEntries[idx].paneIds.filter((paneId) => col.includes(paneId)).length;
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestIdx = idx;
        }
      }

      const entry = bestIdx >= 0
        ? availableEntries.splice(bestIdx, 1)[0]
        : { key: `col-${workspaceId}-${colKeyStateRef.current.nextId++}`, paneIds: col };
      const nextEntry = { key: entry.key, paneIds: col };
      nextEntries.push(nextEntry);
      return { col, key: nextEntry.key };
    });

    colKeyStateRef.current.entries = nextEntries;

    return (
      <Allotment
        separator={false}
        defaultSizes={columnWidths}
        onChange={(sizes) => {
          if (colResizeTimerRef.current) clearTimeout(colResizeTimerRef.current);
          colResizeTimerRef.current = setTimeout(() => {
            const currentWorkspace = useWorkspaceListStore.getState().getWorkspace(workspaceId);
            setWorkspaceLayoutMetrics(workspaceId, sizes, currentWorkspace?.rowHeightsPerCol);
          }, 200);
        }}
      >
        {keyedCols.map(({ col, key }, colIdx) => (
          <Allotment.Pane key={key}>
            <Allotment
              vertical
              key={`rows-${key}`}
              separator={false}
              defaultSizes={rowHeightsPerCol?.[colIdx]?.length === col.length ? rowHeightsPerCol[colIdx] : undefined}
              onChange={(sizes) => {
                if (rowResizeTimerRef.current) clearTimeout(rowResizeTimerRef.current);
                rowResizeTimerRef.current = setTimeout(() => {
                  const currentWorkspace = useWorkspaceListStore.getState().getWorkspace(workspaceId);
                  const currentRowHeights = currentWorkspace?.rowHeightsPerCol;
                  const nextRowHeights = cols.map((currentCol, currentColIdx) => {
                    if (currentColIdx === colIdx) return sizes;
                    return currentRowHeights?.[currentColIdx]?.length === currentCol.length
                      ? currentRowHeights[currentColIdx]
                      : [];
                  });
                  setWorkspaceLayoutMetrics(workspaceId, currentWorkspace?.columnWidths, nextRowHeights);
                }, 200);
              }}
            >
              {col.map((paneId) => {
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

  // Fallback: no splitColumns (should not happen with current store logic)
  // Render a single-column vertical layout
  return (
    <Allotment separator={false}>
      <Allotment.Pane>
        <Allotment vertical separator={false}>
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

// Wrapper: keeps only a small LRU of workspaces mounted at once.
export default memo(function WorkspaceView() {
  const activeId = useWorkspaceListStore((s) => s.activeWorkspaceId);
  const workspaces = useWorkspaceListStore((s) => s.workspaces);
  const [mountedWorkspaceIds, setMountedWorkspaceIds] = useState<string[]>([]);

  useEffect(() => {
    if (!activeId) return;
    setMountedWorkspaceIds((prev) => {
      const next = prev.filter((id) => id !== activeId);
      next.push(activeId);
      const trimmed = next.slice(-MAX_MOUNTED_WORKSPACES);
      if (
        trimmed.length === prev.length
        && trimmed.every((id, index) => id === prev[index])
      ) {
        return prev;
      }
      return trimmed;
    });
  }, [activeId]);

  // Prune mounted IDs for deleted workspaces
  useEffect(() => {
    const currentIds = new Set(workspaces.map((ws) => ws.id));
    setMountedWorkspaceIds((prev) => {
      const next = prev.filter((id) => currentIds.has(id));
      if (next.length === prev.length) {
        let changed = false;
        for (let i = 0; i < prev.length; i++) {
          if (next[i] !== prev[i]) {
            changed = true;
            break;
          }
        }
        if (!changed) {
          return prev;
        }
      }
      return next;
    });
  }, [workspaces]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      {workspaces
        .filter((ws) => ws.panes.length > 0 && (mountedWorkspaceIds.includes(ws.id) || ws.id === activeId))
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
                splitColumns={ws.splitColumns}
              />
            </div>
          );
        })}
    </div>
  );
});
