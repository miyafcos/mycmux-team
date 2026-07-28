import { useCallback, useEffect, useMemo, memo, useRef, useState } from "react";
import { Allotment, type AllotmentHandle } from "allotment";
import "allotment/dist/style.css";
import type { Pane, GridTemplateId } from "../../types";
import { useWorkspaceLayoutStore, usePaneMetadataStore } from "../../stores/workspaceStore";
import { useWorkspaceListStore } from "../../stores/workspaceListStore";
import { killSession } from "../../lib/ipc";
import {
  reconcileSplitColumnsForPanes,
  reconcileStableLayoutColumnIdentities,
  type StableLayoutColumnIdentity,
} from "../../lib/layoutColumns";
import { focusController } from "../../lib/focusController";
import { evictTerminalCache } from "../terminal/XTermWrapper";
import { beforePaneClose } from "../../lib/paneCloseLifecycle";
import { useSavepointDragStore } from "../../stores/savepointDragStore";
import TerminalPane from "./TerminalPane";
import ErrorBoundary from "../common/ErrorBoundary";

const MAX_MOUNTED_WORKSPACES = 1;

interface TerminalGridProps {
  workspaceId: string;
  gridTemplateId: GridTemplateId;
  panes: Pane[];
  splitColumns?: string[][];
}

interface LayoutStructureSnapshot {
  columnSignature: string;
  rowSignatures: Map<string, string>;
}

function positiveLayoutSizes(sizes: number[] | undefined, itemCount: number): number[] | null {
  if (!sizes || sizes.length !== itemCount) return null;
  const cleaned = sizes.map((size) =>
    typeof size === "number" && Number.isFinite(size) && size > 0 ? size : null,
  );
  return cleaned.every((size): size is number => size !== null) ? cleaned : null;
}

function fitLayoutSizes(
  sizes: number[] | undefined,
  availableSize: number,
  itemCount: number,
): number[] | undefined {
  const fitSize = Math.floor(availableSize);
  if (itemCount <= 0 || fitSize <= 0) return undefined;

  const source = positiveLayoutSizes(sizes, itemCount) ?? Array.from({ length: itemCount }, () => 1);
  const total = source.reduce((sum, size) => sum + size, 0);
  if (total <= 0) return undefined;

  const rawSizes = source.map((size) => (size / total) * fitSize);
  const fitted = rawSizes.map((size) => Math.floor(size));
  let remaining = fitSize - fitted.reduce((sum, size) => sum + size, 0);
  const order = rawSizes
    .map((size, index) => ({ index, fraction: size - Math.floor(size) }))
    .sort((a, b) => b.fraction - a.fraction);

  for (let idx = 0; remaining > 0 && order.length > 0; idx = (idx + 1) % order.length) {
    fitted[order[idx].index] += 1;
    remaining -= 1;
  }

  return fitted;
}

function sameViewportSize(
  prev: { width: number; height: number },
  next: { width: number; height: number },
): boolean {
  return Math.abs(prev.width - next.width) < 1 && Math.abs(prev.height - next.height) < 1;
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
  const gridContainerRef = useRef<HTMLDivElement | null>(null);
  const outerAllotmentRef = useRef<AllotmentHandle | null>(null);
  const innerAllotmentRefs = useRef(new Map<string, AllotmentHandle>());
  const previousLayoutStructureRef = useRef<LayoutStructureSnapshot | null>(null);

  const handleClose = useCallback((paneId: string) => {
    // Kill all PTY sessions — read fresh state to avoid stale closure
    const ws = useWorkspaceListStore.getState().getWorkspace(workspaceId);
    if (!ws || ws.panes.length <= 1) return;
    const pane = ws.panes.find((p) => p.id === paneId);
    if (pane) {
      beforePaneClose(pane);
      for (const tab of pane.tabs) {
        evictTerminalCache(tab.sessionId);
        killSession(tab.sessionId).catch((err) =>
          console.warn("[mycmux] killSession failed", tab.sessionId, err),
        );
        usePaneMetadataStore.getState().removeMetadata(tab.sessionId);
      }
    }
    const paneIndex = ws.panes.findIndex((p) => p.id === paneId);
    const remainingPanes = ws.panes.filter((p) => p.id !== paneId);
    const nextPane = remainingPanes[Math.min(Math.max(paneIndex, 0), remainingPanes.length - 1)] ?? remainingPanes[0];
    const nextActiveTab = nextPane?.tabs.find((tab) => tab.id === nextPane.activeTabId) ?? nextPane?.tabs[0];
    focusController.request("programmatic", {
      sessionId: nextActiveTab?.sessionId ?? nextPane?.sessionId ?? null,
      focus: false,
    });
    removePaneFromWorkspace(workspaceId, paneId);
  }, [workspaceId, removePaneFromWorkspace]);

  const handleSplitRight = useCallback((paneId: string) => {
    addPaneToWorkspace(workspaceId, paneId, "right");
  }, [workspaceId, addPaneToWorkspace]);

  const handleSplitDown = useCallback((paneId: string) => {
    addPaneToWorkspace(workspaceId, paneId, "down");
  }, [workspaceId, addPaneToWorkspace]);

  const paneMap = useMemo(() => Object.fromEntries(panes.map((p) => [p.id, p])), [panes]);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const layoutColumns = useMemo(
    () => reconcileSplitColumnsForPanes(splitColumns, panes.map((pane) => pane.id)),
    [splitColumns, panes],
  );
  const columnIdentitiesRef = useRef<StableLayoutColumnIdentity[]>([]);
  const columnIdentities = reconcileStableLayoutColumnIdentities(
    columnIdentitiesRef.current,
    layoutColumns,
  );
  columnIdentitiesRef.current = columnIdentities;
  const layoutStructureSignature = useMemo(
    () => layoutColumns.map((col) => col.join(",")).join("|"),
    [layoutColumns],
  );
  const terminalLayoutSignature = useMemo(() => {
    const columnSignature = layoutColumns.map((col) => col.join(",")).join("|");
    const paneSignature = panes
      .map((pane) => `${pane.id}:${pane.activeTabId}:${pane.tabs.length}`)
      .join("|");
    return `${workspaceId}:${Math.round(viewportSize.width)}x${Math.round(viewportSize.height)}:${columnSignature}:${paneSignature}`;
  }, [layoutColumns, panes, viewportSize.height, viewportSize.width, workspaceId]);

  useEffect(() => {
    const container = gridContainerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;

    const updateSize = () => {
      const rect = container.getBoundingClientRect();
      const nextSize = { width: rect.width, height: rect.height };
      setViewportSize((prev) => sameViewportSize(prev, nextSize) ? prev : nextSize);
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!splitColumns) {
      previousLayoutStructureRef.current = null;
      return;
    }

    const rowSignatures = new Map(
      layoutColumns.map((col, colIdx) => [
        columnIdentities[colIdx]?.id ?? `column-${colIdx}`,
        col.join(","),
      ]),
    );
    const previousStructure = previousLayoutStructureRef.current;
    if (!previousStructure) {
      previousLayoutStructureRef.current = {
        columnSignature: layoutStructureSignature,
        rowSignatures,
      };
      return;
    }
    if (previousStructure.columnSignature === layoutStructureSignature) return;
    if (viewportSize.width <= 0 || viewportSize.height <= 0) return;

    const columnWidths = fitLayoutSizes(
      workspace?.columnWidths,
      viewportSize.width,
      layoutColumns.length,
    );
    if (columnWidths?.length === layoutColumns.length) {
      outerAllotmentRef.current?.resize(columnWidths);
    }

    layoutColumns.forEach((col, colIdx) => {
      const columnId = columnIdentities[colIdx]?.id ?? `column-${colIdx}`;
      if (previousStructure.rowSignatures.get(columnId) === rowSignatures.get(columnId)) return;
      const rowHeights = fitLayoutSizes(
        workspace?.rowHeightsPerCol?.[colIdx],
        viewportSize.height,
        col.length,
      );
      if (rowHeights?.length === col.length) {
        innerAllotmentRefs.current.get(columnId)?.resize(rowHeights);
      }
    });

    previousLayoutStructureRef.current = {
      columnSignature: layoutStructureSignature,
      rowSignatures,
    };
  }, [
    columnIdentities,
    layoutColumns,
    layoutStructureSignature,
    splitColumns,
    viewportSize.height,
    viewportSize.width,
    workspace?.columnWidths,
    workspace?.rowHeightsPerCol,
  ]);

  useEffect(() => {
    if (viewportSize.width <= 0 || viewportSize.height <= 0) return;
    let cancelled = false;
    const notifyTerminals = () => {
      if (cancelled) return;
      window.dispatchEvent(
        new CustomEvent("mycmux:terminal-layout-change", {
          detail: { workspaceId, layoutSignature: terminalLayoutSignature },
        }),
      );
    };

    // ResizeObserver handles intermediate Allotment geometry. Notify once on
    // the next frame after React commits instead of repainting every terminal
    // both immediately and again two frames later.
    const rafId = window.requestAnimationFrame(notifyTerminals);

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(rafId);
    };
  }, [terminalLayoutSignature, viewportSize.height, viewportSize.width, workspaceId]);

  // Column-first layout: outer = horizontal columns, inner = vertical rows within each column
  if (splitColumns) {
    const cols: string[][] = layoutColumns;
    const layoutWidth = viewportSize.width;
    const layoutHeight = viewportSize.height;
    const columnWidths = fitLayoutSizes(workspace?.columnWidths, layoutWidth, cols.length);
    const rowHeightsPerCol = workspace?.rowHeightsPerCol;
    const hasMeasuredViewport = viewportSize.width > 0 && viewportSize.height > 0;

    return (
      <div
        className="cmux-terminal-grid-fit"
        ref={gridContainerRef}
        style={{
          width: "100%",
          height: "100%",
          overflow: "hidden",
        }}
      >
        {hasMeasuredViewport && <div style={{ width: "100%", height: "100%", minWidth: 0, minHeight: 0 }}>
          <Allotment
            ref={outerAllotmentRef}
            separator={false}
            proportionalLayout
            defaultSizes={columnWidths}
            minSize={0}
            onDragEnd={(sizes) => {
              const currentWorkspace = useWorkspaceListStore.getState().getWorkspace(workspaceId);
              setWorkspaceLayoutMetrics(workspaceId, sizes, currentWorkspace?.rowHeightsPerCol);
            }}
          >
            {cols.map((col, colIdx) => {
              const columnId = columnIdentities[colIdx]?.id ?? `column-${colIdx}`;
              const rowHeights = fitLayoutSizes(rowHeightsPerCol?.[colIdx], layoutHeight, col.length);
              return (
              <Allotment.Pane key={`col-${columnId}`} minSize={0} preferredSize={columnWidths?.[colIdx]}>
                <Allotment
                  ref={(handle) => {
                    if (handle) innerAllotmentRefs.current.set(columnId, handle);
                    else innerAllotmentRefs.current.delete(columnId);
                  }}
                  vertical
                  separator={false}
                  proportionalLayout
                  defaultSizes={rowHeights}
                  minSize={0}
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
                  {col.map((paneId, rowIdx) => {
                    const pane = paneMap[paneId];
                    if (!pane) return null;
                    return (
                      <Allotment.Pane key={pane.id} minSize={0} preferredSize={rowHeights?.[rowIdx]}>
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
              );
            })}
          </Allotment>
        </div>}
      </div>
    );
  }

  // Fallback: no splitColumns (should not happen with current store logic)
  // Render a single-column vertical layout
  return (
    <Allotment separator={false} minSize={0}>
      <Allotment.Pane minSize={0}>
        <Allotment vertical separator={false} minSize={0}>
          {panes.map((pane) => (
            <Allotment.Pane key={pane.id} minSize={0}>
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
  const dragSourceWorkspaceId = useSavepointDragStore((s) => s.item?.sourceWorkspaceId ?? null);
  const [mountedWorkspaceIds, setMountedWorkspaceIds] = useState<string[]>([]);
  const visibleWorkspaceIds = useMemo(() => {
    const ids = new Set<string>(mountedWorkspaceIds);
    if (activeId) {
      ids.add(activeId);
    }
    if (dragSourceWorkspaceId) {
      ids.add(dragSourceWorkspaceId);
    }
    return ids;
  }, [activeId, dragSourceWorkspaceId, mountedWorkspaceIds]);
  const visibleWorkspaceSignature = useMemo(
    () => Array.from(visibleWorkspaceIds).sort().join("|"),
    [visibleWorkspaceIds],
  );

  useEffect(() => {
    let cancelled = false;
    const notifyTerminals = () => {
      if (cancelled) return;
      window.dispatchEvent(
        new CustomEvent("mycmux:workspace-visibility-change", {
          detail: { activeWorkspaceId: activeId, visibleWorkspaceIds: Array.from(visibleWorkspaceIds) },
        }),
      );
    };

    notifyTerminals();
    const rafId = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(notifyTerminals);
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(rafId);
    };
  }, [activeId, visibleWorkspaceSignature, visibleWorkspaceIds]);

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
