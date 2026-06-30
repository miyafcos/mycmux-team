import { useCallback, useEffect, useMemo, memo, useRef, useState } from "react";
import { Allotment } from "allotment";
import "allotment/dist/style.css";
import type { Pane, GridTemplateId, Workspace } from "../../types";
import { useWorkspaceLayoutStore, usePaneMetadataStore, useUiStore } from "../../stores/workspaceStore";
import { useWorkspaceListStore } from "../../stores/workspaceListStore";
import { killSession } from "../../lib/ipc";
import { FIRST_LAUNCH_STORAGE_KEY } from "../../lib/startupSessionGate";
import { reconcileSplitColumnsForPanes } from "../../lib/layoutColumns";
import { evictTerminalCache } from "../terminal/XTermWrapper";
import TerminalPane from "./TerminalPane";
import { ErrorBoundary } from "../layout/ErrorBoundary";

const MAX_MOUNTED_WORKSPACES = 3;
const RESTORE_MOUNT_DELAY_MS = 650;
const FIRST_RESTORE_MOUNT_DELAY_MS = 1200;
const FIT_LAYOUT_MIN_SIZE = 1;

function getRestoreMountDelayMs(): number {
  try {
    return window.localStorage.getItem(FIRST_LAUNCH_STORAGE_KEY)
      ? RESTORE_MOUNT_DELAY_MS
      : FIRST_RESTORE_MOUNT_DELAY_MS;
  } catch {
    return FIRST_RESTORE_MOUNT_DELAY_MS;
  }
}

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
  const setActivePaneId = useUiStore((s) => s.setActivePaneId);
  const workspace = useWorkspaceListStore((s) => s.getWorkspace(workspaceId));
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

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
    const paneIndex = ws.panes.findIndex((p) => p.id === paneId);
    const remainingPanes = ws.panes.filter((p) => p.id !== paneId);
    const nextPane = remainingPanes[Math.min(Math.max(paneIndex, 0), remainingPanes.length - 1)] ?? remainingPanes[0];
    const nextActiveTab = nextPane?.tabs.find((tab) => tab.id === nextPane.activeTabId) ?? nextPane?.tabs[0];
    setActivePaneId(nextActiveTab?.sessionId ?? nextPane?.sessionId ?? null);
    removePaneFromWorkspace(workspaceId, paneId);
  }, [workspaceId, removePaneFromWorkspace, setActivePaneId]);

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
  const terminalLayoutSignature = useMemo(() => {
    const columnSignature = layoutColumns.map((col) => col.join(",")).join("|");
    const paneSignature = panes
      .map((pane) => `${pane.id}:${pane.activeTabId}:${pane.tabs.length}`)
      .join("|");
    return `${workspaceId}:${Math.round(viewportSize.width)}x${Math.round(viewportSize.height)}:${columnSignature}:${paneSignature}`;
  }, [layoutColumns, panes, viewportSize.height, viewportSize.width, workspaceId]);

  useEffect(() => {
    const container = scrollContainerRef.current;
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
    if (viewportSize.width <= 0 || viewportSize.height <= 0) return;
    let cancelled = false;
    let secondRafId: number | null = null;
    const notifyTerminals = () => {
      if (cancelled) return;
      window.dispatchEvent(
        new CustomEvent("mycmux:terminal-layout-change", {
          detail: { workspaceId, layoutSignature: terminalLayoutSignature },
        }),
      );
    };

    notifyTerminals();
    const firstRafId = window.requestAnimationFrame(() => {
      secondRafId = window.requestAnimationFrame(notifyTerminals);
    });

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(firstRafId);
      if (secondRafId !== null) {
        window.cancelAnimationFrame(secondRafId);
      }
    };
  }, [terminalLayoutSignature, viewportSize.height, viewportSize.width, workspaceId]);

  // Column-first layout: outer = horizontal columns, inner = vertical rows within each column
  if (splitColumns) {
    const cols: string[][] = layoutColumns;
    const columnWidths = fitLayoutSizes(workspace?.columnWidths, viewportSize.width, cols.length);
    const rowHeightsPerCol = workspace?.rowHeightsPerCol;
    const hasMeasuredViewport = viewportSize.width > 0 && viewportSize.height > 0;
    const layoutSignature = cols.map((col) => col.join(",")).join("|");

    return (
      <div
        className="cmux-terminal-grid-fit"
        ref={scrollContainerRef}
        style={{
          width: "100%",
          height: "100%",
          overflow: "hidden",
        }}
      >
        {hasMeasuredViewport && <div style={{ width: "100%", height: "100%", minWidth: 0, minHeight: 0 }}>
          <Allotment
            key={`cols-${layoutSignature}`}
            separator={false}
            proportionalLayout
            defaultSizes={columnWidths}
            minSize={FIT_LAYOUT_MIN_SIZE}
            onDragEnd={(sizes) => {
              const currentWorkspace = useWorkspaceListStore.getState().getWorkspace(workspaceId);
              setWorkspaceLayoutMetrics(workspaceId, sizes, currentWorkspace?.rowHeightsPerCol);
            }}
          >
            {cols.map((col, colIdx) => {
              const colSignature = col.join(",");
              const rowHeights = fitLayoutSizes(rowHeightsPerCol?.[colIdx], viewportSize.height, col.length);
              return (
              <Allotment.Pane key={`col-${colSignature}`} minSize={FIT_LAYOUT_MIN_SIZE} preferredSize={columnWidths?.[colIdx]}>
                <Allotment
                  vertical
                  key={`rows-${colSignature}`}
                  separator={false}
                  proportionalLayout
                  defaultSizes={rowHeights}
                  minSize={FIT_LAYOUT_MIN_SIZE}
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
                      <Allotment.Pane key={pane.id} minSize={FIT_LAYOUT_MIN_SIZE} preferredSize={rowHeights?.[rowIdx]}>
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
  const [restoreMountDelayMs] = useState(getRestoreMountDelayMs);
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
    }, restoreMountDelayMs);

    return () => window.clearTimeout(timer);
  }, [activeId, restoreMountDelayMs, restoreWorkspaceIds, startupRestoreMountedIds]);

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
