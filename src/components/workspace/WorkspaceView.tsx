import { useCallback, useEffect, useLayoutEffect, useMemo, memo, useRef, useState } from "react";
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
import {
  applyAxisDrag,
  balancedAxis,
  fitLayoutSizes,
  normalizeDividerPins,
  type AxisMetrics,
} from "../../lib/layoutMetrics";
import { terminalLayoutSignatureOf } from "../../lib/terminalLayoutSignature";
import { focusController } from "../../lib/focusController";
import { evictTerminalCache } from "../terminal/XTermWrapper";
import { tabHasPty } from "../../lib/tabLifecycle";
import { beforePaneClose } from "../../lib/paneCloseLifecycle";
import { confirmPaneClose } from "../../lib/paneCloseConfirmation";
import { useSavepointDragStore } from "../../stores/savepointDragStore";
import { useUiStore } from "../../stores/uiStore";
import TerminalPane from "./TerminalPane";
import ErrorBoundary from "../common/ErrorBoundary";
import WebPaneController from "./WebPaneController";

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

/**
 * What the reset handlers need to know at the moment they fire.
 *
 * allotment wires the sash double click once, on mount, and never swaps that
 * callback again (it re-assigns onDidChange / onDidDragStart / onDidDragEnd on
 * every render, but there is no onDidReset). A handler that closed over the
 * columns as they were on mount would answer a double click with the wrong
 * lengths after any split or close, and the store would throw the whole axis
 * away. So the handlers stay the same function for the life of the grid and
 * read the current layout from here.
 */
interface LatestLayout {
  cols: string[][];
  columnIds: string[];
  width: number;
  height: number;
}

function sameViewportSize(
  prev: { width: number; height: number },
  next: { width: number; height: number },
): boolean {
  return Math.abs(prev.width - next.width) < 1 && Math.abs(prev.height - next.height) < 1;
}

function totalSize(sizes: readonly number[]): number {
  return sizes.reduce((sum, size) => sum + size, 0);
}

/**
 * Show a settled axis. allotment keeps whatever pixels the drag (or the double
 * click) left behind, so rebalancing the free dividers only becomes visible
 * once it is pushed back through the imperative handle — and only a whole
 * pixel of difference is worth a repaint.
 */
function pushSettledAxis(
  handle: AllotmentHandle | null | undefined,
  settled: AxisMetrics,
  currentSizes: readonly number[],
): void {
  // A drag that shut a pane is left exactly as the pointer left it: the axis
  // was not settled, and fitLayoutSizes cannot express a zero-width pane
  // anyway (it would hand back an even split and undo the drag).
  if (settled.sizes.some((size) => size <= 0)) return;
  const fitted = fitLayoutSizes(settled.sizes, totalSize(currentSizes), settled.sizes.length);
  if (!fitted || fitted.length !== currentSizes.length) return;
  if (!fitted.some((size, index) => Math.abs(size - currentSizes[index]) >= 1)) return;
  handle?.resize(fitted);
}

/** Double clicking a divider forgets every pin on its axis and evens it out. */
function resetAxis(
  handle: AllotmentHandle | null | undefined,
  itemCount: number,
  availableSize: number,
): AxisMetrics {
  const settled = balancedAxis(itemCount);
  const fitted = fitLayoutSizes(settled.sizes, availableSize, itemCount);
  if (fitted) handle?.resize(fitted);
  return settled;
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
  // Where each axis stood when the drag began, so the dividers the pointer
  // actually moved can be told apart from the ones it left alone.
  const columnDragStartRef = useRef<number[] | null>(null);
  const rowDragStartRefs = useRef(new Map<string, number[]>());
  const latestLayoutRef = useRef<LatestLayout>({ cols: [], columnIds: [], width: 0, height: 0 });
  const rowResetHandlersRef = useRef(new Map<string, () => void>());

  const handleClose = useCallback(async (paneId: string) => {
    // Kill all PTY sessions — read fresh state to avoid stale closure
    const ws = useWorkspaceListStore.getState().getWorkspace(workspaceId);
    if (!ws || ws.panes.length <= 1) return;
    const pane = ws.panes.find((p) => p.id === paneId);
    if (!pane || !await confirmPaneClose([pane], "pane")) return;

    // Re-read after the asynchronous confirmation so tabs added while it was
    // open are not silently killed without being included in the warning.
    const currentWorkspace = useWorkspaceListStore.getState().getWorkspace(workspaceId);
    const currentPane = currentWorkspace?.panes.find((p) => p.id === paneId);
    if (!currentWorkspace || !currentPane || currentWorkspace.panes.length <= 1) return;
    if (currentPane.tabs.map((tab) => tab.sessionId).join("\0") !== pane.tabs.map((tab) => tab.sessionId).join("\0")
      && !await confirmPaneClose([currentPane], "pane")) return;
    {
      beforePaneClose(currentPane);
      for (const tab of currentPane.tabs) {
        if (!tabHasPty(tab)) continue;
        evictTerminalCache(tab.sessionId);
        killSession(tab.sessionId).catch((err) =>
          console.warn("[mycmux] killSession failed", tab.sessionId, err),
        );
        usePaneMetadataStore.getState().removeMetadata(tab.sessionId);
      }
    }
    const paneIndex = currentWorkspace.panes.findIndex((p) => p.id === paneId);
    const remainingPanes = currentWorkspace.panes.filter((p) => p.id !== paneId);
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
  const columnIds = layoutColumns.map(
    (_column, index) => columnIdentities[index]?.id ?? `column-${index}`,
  );
  const layoutStructureSignature = useMemo(
    () => layoutColumns.map((col) => col.join(",")).join("|"),
    [layoutColumns],
  );
  // Zooming resizes panes without touching the grid container, the column
  // layout or the pane list, so leaving it out of the signature meant no
  // layout-change event fired on zoom or restore. The terminal's own
  // ResizeObserver drops its pending refit while the container is briefly
  // unpaintable, and nothing brought it back -- the pane stayed mis-sized
  // until some unrelated change (dragging the sidebar) moved the viewport and
  // finally fired the event.
  const zoomedPaneId = useUiStore((state) => state.zoomedPaneId);
  const terminalLayoutSignature = useMemo(
    () => terminalLayoutSignatureOf({
      workspaceId,
      viewportSize,
      layoutColumns,
      panes,
      zoomedPaneId,
    }),
    [layoutColumns, panes, viewportSize, workspaceId, zoomedPaneId],
  );

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

  // Refreshed before the browser paints the commit, so a double click can
  // never reach a handler that is still describing the layout before it.
  useLayoutEffect(() => {
    latestLayoutRef.current = {
      cols: layoutColumns,
      columnIds,
      width: viewportSize.width,
      height: viewportSize.height,
    };
  });

  // Row metrics are stored for the whole workspace, so one column's drag has
  // to hand back a full description of every column: a partial one fails the
  // store's length check and the drag would be dropped on the floor.
  const saveRowAxis = useCallback((columnIndex: number, settled: AxisMetrics) => {
    const { cols } = latestLayoutRef.current;
    if (columnIndex < 0 || columnIndex >= cols.length) return;
    const currentWorkspace = useWorkspaceListStore.getState().getWorkspace(workspaceId);
    const currentRowHeights = currentWorkspace?.rowHeightsPerCol;
    const currentRowPins = currentWorkspace?.rowDividerPinsPerCol;
    setWorkspaceLayoutMetrics(
      workspaceId,
      currentWorkspace?.columnWidths,
      cols.map((column, index) => {
        if (index === columnIndex) return settled.sizes;
        return currentRowHeights?.[index]?.length === column.length
          ? currentRowHeights[index]
          : balancedAxis(column.length).sizes;
      }),
      currentWorkspace?.columnDividerPins,
      cols.map((column, index) => (
        index === columnIndex
          ? settled.pins
          : normalizeDividerPins(currentRowPins?.[index], column.length)
      )),
    );
  }, [setWorkspaceLayoutMetrics, workspaceId]);

  const handleColumnsReset = useCallback(() => {
    const { cols, width } = latestLayoutRef.current;
    if (cols.length === 0 || width <= 0) return;
    const currentWorkspace = useWorkspaceListStore.getState().getWorkspace(workspaceId);
    const settled = resetAxis(outerAllotmentRef.current, cols.length, width);
    setWorkspaceLayoutMetrics(
      workspaceId,
      settled.sizes,
      currentWorkspace?.rowHeightsPerCol,
      settled.pins,
      currentWorkspace?.rowDividerPinsPerCol,
    );
  }, [setWorkspaceLayoutMetrics, workspaceId]);

  // One handler per column identity, kept for as long as the grid lives. The
  // column's position can change underneath it, so it is looked up again from
  // the identity every time the handler runs.
  const rowsResetHandlerFor = useCallback((columnId: string) => {
    const existing = rowResetHandlersRef.current.get(columnId);
    if (existing) return existing;
    const handler = () => {
      const { cols, columnIds: currentColumnIds, height } = latestLayoutRef.current;
      const columnIndex = currentColumnIds.indexOf(columnId);
      const column = cols[columnIndex];
      if (!column || height <= 0) return;
      saveRowAxis(columnIndex, resetAxis(
        innerAllotmentRefs.current.get(columnId),
        column.length,
        height,
      ));
    };
    rowResetHandlersRef.current.set(columnId, handler);
    return handler;
  }, [saveRowAxis]);

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
            onDragStart={(sizes) => {
              columnDragStartRef.current = sizes;
            }}
            onDragEnd={(sizes) => {
              const currentWorkspace = useWorkspaceListStore.getState().getWorkspace(workspaceId);
              const dragStart = columnDragStartRef.current ?? sizes;
              columnDragStartRef.current = null;
              const settled = applyAxisDrag(
                dragStart,
                sizes,
                normalizeDividerPins(currentWorkspace?.columnDividerPins, sizes.length),
              );
              pushSettledAxis(outerAllotmentRef.current, settled, sizes);
              setWorkspaceLayoutMetrics(
                workspaceId,
                settled.sizes,
                currentWorkspace?.rowHeightsPerCol,
                settled.pins,
                currentWorkspace?.rowDividerPinsPerCol,
              );
            }}
            onReset={handleColumnsReset}
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
                  onDragStart={(sizes) => {
                    rowDragStartRefs.current.set(columnId, sizes);
                  }}
                  onDragEnd={(sizes) => {
                    const currentWorkspace = useWorkspaceListStore.getState().getWorkspace(workspaceId);
                    const dragStart = rowDragStartRefs.current.get(columnId) ?? sizes;
                    rowDragStartRefs.current.delete(columnId);
                    const columnIndex = latestLayoutRef.current.columnIds.indexOf(columnId);
                    const settled = applyAxisDrag(
                      dragStart,
                      sizes,
                      normalizeDividerPins(
                        currentWorkspace?.rowDividerPinsPerCol?.[columnIndex],
                        sizes.length,
                      ),
                    );
                    pushSettledAxis(innerAllotmentRefs.current.get(columnId), settled, sizes);
                    saveRowAxis(columnIndex, settled);
                  }}
                  onReset={rowsResetHandlerFor(columnId)}
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
      <WebPaneController />
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
                visibility: isActive ? "inherit" : "hidden",
                pointerEvents: isActive ? "inherit" : "none",
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
