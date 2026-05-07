import { useCallback, useEffect, useMemo, memo, useRef, useState } from "react";
import { Allotment } from "allotment";
import "allotment/dist/style.css";
import type { Pane, GridTemplateId, Workspace } from "../../types";
import { useWorkspaceLayoutStore, usePaneMetadataStore } from "../../stores/workspaceStore";
import { useWorkspaceListStore } from "../../stores/workspaceListStore";
import { killSession } from "../../lib/ipc";
import { evictTerminalCache } from "../terminal/XTermWrapper";
import TerminalPane from "./TerminalPane";
import { ErrorBoundary } from "../layout/ErrorBoundary";

const MAX_MOUNTED_WORKSPACES = 3;
const RESTORE_MOUNT_DELAY_MS = 650;

interface TerminalGridProps {
  workspaceId: string;
  gridTemplateId: GridTemplateId;
  panes: Pane[];
  splitColumns?: string[][];
}

function paneHasRestorableAgentSession(pane: Pane): boolean {
  return Boolean(
    (pane.agentKind && pane.agentSessionId)
    || pane.claudeSessionId
    || pane.tabs.some((tab) =>
      Boolean((tab.agentKind && tab.agentSessionId) || tab.claudeSessionId),
    ),
  );
}

function workspaceHasRestorableAgentSession(workspace: Workspace): boolean {
  return workspace.panes.some(paneHasRestorableAgentSession);
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
        onDragEnd={(sizes) => {
          const currentWorkspace = useWorkspaceListStore.getState().getWorkspace(workspaceId);
          setWorkspaceLayoutMetrics(workspaceId, sizes, currentWorkspace?.rowHeightsPerCol);
        }}
      >
        {keyedCols.map(({ col, key }, colIdx) => (
          <Allotment.Pane key={key}>
            <Allotment
              vertical
              key={`rows-${key}`}
              separator={false}
              defaultSizes={rowHeightsPerCol?.[colIdx]?.length === col.length ? rowHeightsPerCol[colIdx] : undefined}
              onDragEnd={(sizes) => {
                const currentWorkspace = useWorkspaceListStore.getState().getWorkspace(workspaceId);
                const currentRowHeights = currentWorkspace?.rowHeightsPerCol;
                const nextRowHeights = cols.map((currentCol, currentColIdx) => {
                  if (currentColIdx === colIdx) return sizes;
                  return currentRowHeights?.[currentColIdx]?.length === currentCol.length
                    ? currentRowHeights[currentColIdx]
                    : [];
                });
                setWorkspaceLayoutMetrics(workspaceId, currentWorkspace?.columnWidths, nextRowHeights);
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
  const [startupRestoreMountedIds, setStartupRestoreMountedIds] = useState<string[]>([]);
  const restoreWorkspaceIds = useMemo(
    () => workspaces
      .filter(workspaceHasRestorableAgentSession)
      .map((ws) => ws.id),
    [workspaces],
  );
  const restoreWorkspaceIdSet = useMemo(() => new Set(restoreWorkspaceIds), [restoreWorkspaceIds]);
  const visibleWorkspaceIds = useMemo(() => {
    const ids = new Set<string>(mountedWorkspaceIds);
    for (const id of startupRestoreMountedIds) {
      ids.add(id);
    }
    if (activeId) {
      ids.add(activeId);
    }
    return ids;
  }, [activeId, mountedWorkspaceIds, startupRestoreMountedIds]);

  useEffect(() => {
    if (!activeId) return;
    setMountedWorkspaceIds((prev) => {
      const next = prev.filter((id) => id !== activeId);
      next.push(activeId);
      const restoreIds = next.filter((id) => restoreWorkspaceIdSet.has(id));
      const shellOnlyIds = next.filter((id) => !restoreWorkspaceIdSet.has(id));
      const trimmed = [...shellOnlyIds.slice(-MAX_MOUNTED_WORKSPACES), ...restoreIds];
      if (
        trimmed.length === prev.length
        && trimmed.every((id, index) => id === prev[index])
      ) {
        return prev;
      }
      return trimmed;
    });
  }, [activeId, restoreWorkspaceIdSet]);

  useEffect(() => {
    const nextRestoreId = restoreWorkspaceIds.find((id) =>
      id !== activeId && !startupRestoreMountedIds.includes(id),
    );
    if (!nextRestoreId) return;

    const timer = window.setTimeout(() => {
      setStartupRestoreMountedIds((prev) => {
        if (prev.includes(nextRestoreId)) return prev;
        return [...prev, nextRestoreId];
      });
    }, RESTORE_MOUNT_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [activeId, restoreWorkspaceIds, startupRestoreMountedIds]);

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
    setStartupRestoreMountedIds((prev) => {
      const next = prev.filter((id) => currentIds.has(id) && restoreWorkspaceIdSet.has(id));
      if (
        next.length === prev.length
        && next.every((id, index) => id === prev[index])
      ) {
        return prev;
      }
      return next;
    });
  }, [restoreWorkspaceIdSet, workspaces]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      {workspaces
        .filter((ws) => ws.panes.length > 0 && visibleWorkspaceIds.has(ws.id))
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
