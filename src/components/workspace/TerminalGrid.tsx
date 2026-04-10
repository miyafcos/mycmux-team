import { useCallback, useMemo, memo, useRef } from "react";
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

export default memo(function TerminalGrid({
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
      <Allotment vertical separator={false}>
        {keyedRows.map(({ row, key }) => (
          <Allotment.Pane key={key}>
            <Allotment key={`columns-${key}`} separator={false}>
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
