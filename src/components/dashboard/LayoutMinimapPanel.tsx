import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type UIEvent as ReactUIEvent,
} from "react";
import type { DashboardDisplayState } from "./dashboardModel";
import { dashboardStrings } from "./dashboardStrings";
import { MinimapWorkspaceBlock } from "./MinimapWorkspaceBlock";
import { moveMinimapItemToNewWorkspace } from "./minimapWorkspaceActions";
import { buildGroups } from "../../lib/groupMembership";
import { handleSocketCommand } from "../layout/socketCommands";
import { TabSweepButton } from "../layout/TabSweepButton";
import type { Workspace } from "../../types";
import { paneContainsSession } from "../../stores/workspaceListStore";
import { usePaneDragStore, type PaneDragItem } from "../../stores/paneDragStore";
import { usePaneDragSource } from "../../hooks/usePaneDragSource";
import "./MinimapPanel.css";

const MARQUEE_THRESHOLD_PX = 5;
const GROUP_PULSE_MS = 180;
export const MINIMAP_COLLAPSED_WORKSPACE_IDS_STORAGE_KEY = "mycmux:layoutMinimapPanel:collapsedWorkspaceIds";

interface ContentPoint {
  x: number;
  y: number;
}

interface MarqueePointer {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  start: ContentPoint;
  current: ContentPoint;
  lastClientX: number;
  lastClientY: number;
  additive: boolean;
  selectionBefore: Set<string>;
}

type MinimapPointerState =
  | { phase: "idle" }
  | { phase: "armed-chip"; pointerId: number; startClientX: number; startClientY: number }
  | ({ phase: "armed-marquee" } & MarqueePointer)
  | ({ phase: "dragging"; source: "chip" | "marquee" } & MarqueePointer);

interface CloseConfirmation {
  tabIds: string[];
  labels: string[];
}

function readCollapsedWorkspaceIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(MINIMAP_COLLAPSED_WORKSPACE_IDS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((value): value is string => typeof value === "string")) : new Set();
  } catch {
    return new Set();
  }
}

function persistCollapsedWorkspaceIds(collapsedWorkspaceIds: ReadonlySet<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MINIMAP_COLLAPSED_WORKSPACE_IDS_STORAGE_KEY, JSON.stringify([...collapsedWorkspaceIds]));
  } catch {
    // Client-local layout preferences are best-effort in restricted WebViews.
  }
}

interface LayoutMinimapPanelProps {
  workspaces: readonly Workspace[];
  displayStateByTabId: ReadonlyMap<string, DashboardDisplayState>;
  selectedTabId: string | null;
  openTabIds?: readonly string[];
  activePaneSessionId: string | null;
  onSelect: (tabId: string) => void;
  onJump?: (workspaceId: string, paneId: string, tabId: string) => void;
}

function contentPointFor(root: HTMLElement, clientX: number, clientY: number): ContentPoint {
  const rect = root.getBoundingClientRect();
  return {
    x: clientX - rect.left + root.scrollLeft,
    y: clientY - rect.top + root.scrollTop,
  };
}

function selectionRect(start: ContentPoint, current: ContentPoint) {
  return {
    left: Math.min(start.x, current.x),
    top: Math.min(start.y, current.y),
    right: Math.max(start.x, current.x),
    bottom: Math.max(start.y, current.y),
  };
}

function intersects(left: number, top: number, right: number, bottom: number, candidate: DOMRect): boolean {
  return right >= candidate.left && left <= candidate.right && bottom >= candidate.top && top <= candidate.bottom;
}

export const LayoutMinimapPanel = memo(function LayoutMinimapPanel({ workspaces, displayStateByTabId, selectedTabId, openTabIds = [], activePaneSessionId, onSelect, onJump }: LayoutMinimapPanelProps) {
  const stackRef = useRef<HTMLDivElement>(null);
  const pointerStateRef = useRef<MinimapPointerState>({ phase: "idle" });
  const selectedTabIdRef = useRef(selectedTabId);
  const minimapSelectionIntentRef = useRef<string | null>(null);
  const pulseTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const closeInFlightRef = useRef(false);
  const [pointerState, setPointerState] = useState<MinimapPointerState>({ phase: "idle" });
  const [selectedTabIds, setSelectedTabIds] = useState<Set<string>>(() => selectedTabId ? new Set([selectedTabId]) : new Set());
  const [selectionAnchorTabId, setSelectionAnchorTabId] = useState<string | null>(selectedTabId);
  const [groupPulseTabIds, setGroupPulseTabIds] = useState<Set<string>>(() => new Set());
  const [collapsedWorkspaceIds, setCollapsedWorkspaceIds] = useState<Set<string>>(readCollapsedWorkspaceIds);
  const [closeConfirmation, setCloseConfirmation] = useState<CloseConfirmation | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const { beginPointerDrag } = usePaneDragSource();

  const setPointerMachine = useCallback((next: MinimapPointerState) => {
    pointerStateRef.current = next;
    setPointerState(next);
  }, []);

  const tabIdsInVisualOrder = useMemo(() => workspaces.flatMap((workspace) => workspace.panes.flatMap((pane) => pane.tabs.map((tab) => tab.id))), [workspaces]);
  const knownTabIds = useMemo(() => new Set(tabIdsInVisualOrder), [tabIdsInVisualOrder]);
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
  const groupTabIdsByTabId = useMemo(() => {
    const byTabId = new Map<string, string[]>();
    for (const members of buildGroups([...workspaces]).values()) {
      for (const tabId of members) byTabId.set(tabId, members);
    }
    return byTabId;
  }, [workspaces]);
  const isNewWorkspaceTarget = usePaneDragStore((state) => state.target?.kind === "new-workspace" && state.target.surface === "minimap");
  const isMinimapDragging = usePaneDragStore((state) => state.item?.surface === "minimap");

  useEffect(() => {
    const selectionChangedOutsideMinimap = selectedTabIdRef.current !== selectedTabId;
    const selectionCameFromMinimap = selectionChangedOutsideMinimap
      && minimapSelectionIntentRef.current === selectedTabId;
    selectedTabIdRef.current = selectedTabId;
    minimapSelectionIntentRef.current = null;
    setSelectedTabIds((current) => {
      const next = new Set([...current].filter((tabId) => knownTabIds.has(tabId)));
      if (selectionChangedOutsideMinimap && !selectionCameFromMinimap) {
        // Inbox focus and empty chat columns pass null. Do not wipe a marquee.
        if (selectedTabId && knownTabIds.has(selectedTabId)) return new Set([selectedTabId]);
        return next;
      }
      if (selectedTabId && !next.has(selectedTabId)) next.add(selectedTabId);
      return next;
    });
    setSelectionAnchorTabId((current) => {
      if (selectionChangedOutsideMinimap && !selectionCameFromMinimap) {
        if (selectedTabId && knownTabIds.has(selectedTabId)) return selectedTabId;
        return current && knownTabIds.has(current) ? current : selectedTabId;
      }
      return current && knownTabIds.has(current) ? current : selectedTabId;
    });
  }, [knownTabIds, selectedTabId]);

  useEffect(() => {
    if (!selectedWorkspaceId) return;
    const root = stackRef.current;
    if (!root) return;
    const workspace = Array.from(root.querySelectorAll<HTMLElement>("[data-minimap-workspace]"))
      .find((element) => element.dataset.minimapWorkspace === selectedWorkspaceId);
    if (!workspace) return;
    const rootRect = root.getBoundingClientRect();
    const workspaceRect = workspace.getBoundingClientRect();
    if (workspaceRect.top < rootRect.top) {
      root.scrollTop += workspaceRect.top - rootRect.top;
    } else if (workspaceRect.bottom > rootRect.bottom) {
      root.scrollTop += workspaceRect.bottom - rootRect.bottom;
    }
  }, [selectedWorkspaceId]);
  useEffect(() => () => {
    if (pulseTimerRef.current) window.clearTimeout(pulseTimerRef.current);
  }, []);

  const selectedIdsForMarquee = useCallback((marquee: MarqueePointer) => {
    const root = stackRef.current;
    if (!root) return;
    const rootRect = root.getBoundingClientRect();
    const rect = selectionRect(marquee.start, marquee.current);
    const hitTabIds = Array.from(root.querySelectorAll<HTMLElement>("[data-minimap-tab]")).flatMap((chip) => {
      const tabId = chip.dataset.minimapTab;
      if (!tabId) return [];
      const bounds = chip.getBoundingClientRect();
      const left = bounds.left - rootRect.left + root.scrollLeft;
      const top = bounds.top - rootRect.top + root.scrollTop;
      const right = bounds.right - rootRect.left + root.scrollLeft;
      const bottom = bounds.bottom - rootRect.top + root.scrollTop;
      return intersects(rect.left, rect.top, rect.right, rect.bottom, { left, top, right, bottom } as DOMRect) ? [tabId] : [];
    });
    setSelectedTabIds(marquee.additive
      ? new Set([...marquee.selectionBefore, ...hitTabIds])
      : new Set(hitTabIds));
  }, []);

  const cancelMarquee = useCallback(() => {
    const current = pointerStateRef.current;
    if (current.phase === "armed-marquee" || (current.phase === "dragging" && current.source === "marquee")) {
      setSelectedTabIds(new Set(current.selectionBefore));
      const root = stackRef.current;
      try { root?.releasePointerCapture?.(current.pointerId); } catch { /* Capture may already be released. */ }
    }
    setPointerMachine({ phase: "idle" });
  }, [setPointerMachine]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const current = pointerStateRef.current;
      if (current.phase === "idle") return;
      event.preventDefault();
      cancelMarquee();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", cancelMarquee);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", cancelMarquee);
    };
  }, [cancelMarquee]);

  const selectTab = useCallback((tabId: string, event: ReactMouseEvent<HTMLButtonElement>) => {
    const additive = event.ctrlKey || event.metaKey;
    const visualIndex = tabIdsInVisualOrder.indexOf(tabId);
    const anchorIndex = selectionAnchorTabId ? tabIdsInVisualOrder.indexOf(selectionAnchorTabId) : -1;
    setSelectedTabIds((current) => {
      if (event.shiftKey && visualIndex >= 0 && anchorIndex >= 0) {
        const range = tabIdsInVisualOrder.slice(Math.min(visualIndex, anchorIndex), Math.max(visualIndex, anchorIndex) + 1);
        return additive ? new Set([...current, ...range]) : new Set(range);
      }
      if (additive) {
        const next = new Set(current);
        if (next.has(tabId)) next.delete(tabId);
        else next.add(tabId);
        return next;
      }
      return new Set([tabId]);
    });
    if (!event.shiftKey) setSelectionAnchorTabId(tabId);
    minimapSelectionIntentRef.current = tabId;
    onSelect(tabId);
  }, [onSelect, selectionAnchorTabId, tabIdsInVisualOrder]);

  const selectGroup = useCallback((anchorTabId: string) => {
    const members = groupTabIdsByTabId.get(anchorTabId) ?? [anchorTabId];
    setSelectedTabIds(new Set(members));
    setSelectionAnchorTabId(anchorTabId);
    setGroupPulseTabIds(new Set(members));
    if (pulseTimerRef.current) window.clearTimeout(pulseTimerRef.current);
    pulseTimerRef.current = window.setTimeout(() => setGroupPulseTabIds(new Set()), GROUP_PULSE_MS);
    minimapSelectionIntentRef.current = anchorTabId;
    onSelect(anchorTabId);
  }, [groupTabIdsByTabId, onSelect]);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    const chip = target.closest<HTMLElement>("[data-minimap-tab]");
    if (chip) {
      setPointerMachine({ phase: "armed-chip", pointerId: event.pointerId, startClientX: event.clientX, startClientY: event.clientY });
      return;
    }
    const paneGrip = target.closest<HTMLElement>("[data-minimap-pane-grip]");
    const paneElement = paneGrip?.closest<HTMLElement>("[data-minimap-dnd-workspace-id][data-minimap-dnd-pane-id]");
    const workspaceId = paneElement?.getAttribute("data-minimap-dnd-workspace-id");
    const paneId = paneElement?.getAttribute("data-minimap-dnd-pane-id");
    const sourceWorkspace = workspaceId ? workspaces.find((workspace) => workspace.id === workspaceId) : null;
    const sourcePane = sourceWorkspace?.panes.find((pane) => pane.id === paneId);
    if (sourceWorkspace && sourcePane && sourcePane.tabs.length > 0) {
      const activeTab = sourcePane.tabs.find((tab) => tab.id === sourcePane.activeTabId) ?? sourcePane.tabs[0];
      beginPointerDrag(event, {
        kind: "pane",
        surface: "minimap",
        workspaceId: sourceWorkspace.id,
        paneId: sourcePane.id,
        label: activeTab.label ?? activeTab.sessionId,
        tabCount: sourcePane.tabs.length,
      });
      return;
    }
    if (target.closest("button, input, textarea, select, [data-dnd-ignore='true']")) return;
    const root = event.currentTarget;
    const start = contentPointFor(root, event.clientX, event.clientY);
    const armed: MinimapPointerState = {
      phase: "armed-marquee",
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      start,
      current: start,
      lastClientX: event.clientX,
      lastClientY: event.clientY,
      additive: event.ctrlKey || event.metaKey,
      selectionBefore: new Set(selectedTabIds),
    };
    try { root.setPointerCapture(event.pointerId); } catch { /* Window listeners are unnecessary for a captured marquee. */ }
    setPointerMachine(armed);
  }, [beginPointerDrag, selectedTabIds, setPointerMachine, workspaces]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const current = pointerStateRef.current;
    if (current.phase === "idle" || current.pointerId !== event.pointerId) return;
    if (current.phase === "armed-chip") {
      if (Math.hypot(event.clientX - current.startClientX, event.clientY - current.startClientY) >= MARQUEE_THRESHOLD_PX) {
        const point = contentPointFor(event.currentTarget, event.clientX, event.clientY);
        setPointerMachine({
          phase: "dragging",
          source: "chip",
          pointerId: current.pointerId,
          startClientX: current.startClientX,
          startClientY: current.startClientY,
          start: point,
          current: point,
          lastClientX: event.clientX,
          lastClientY: event.clientY,
          additive: false,
          selectionBefore: new Set(),
        });
      }
      return;
    }
    // A chip that is already being dragged owns the pointer. Without this the
    // next move would fall through and turn the chip drag into a marquee, so a
    // selection rectangle grew out of the chip and over the panes.
    // A chip that is already being dragged owns the pointer. Without this the
    // next move would fall through and turn the chip drag into a marquee, so a
    // selection rectangle grew out of the chip and over the panes.
    if (current.phase === "dragging" && current.source === "chip") return;
    const point = contentPointFor(event.currentTarget, event.clientX, event.clientY);
    const shouldStart = current.phase === "armed-marquee"
      && Math.hypot(event.clientX - current.startClientX, event.clientY - current.startClientY) >= MARQUEE_THRESHOLD_PX;
    if (current.phase === "armed-marquee" && !shouldStart) return;
    const dragging: MinimapPointerState = {
      ...current,
      phase: "dragging",
      source: "marquee",
      current: point,
      lastClientX: event.clientX,
      lastClientY: event.clientY,
    };
    setPointerMachine(dragging);
    selectedIdsForMarquee(dragging);
    event.preventDefault();
  }, [selectedIdsForMarquee, setPointerMachine]);

  const finishPointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const current = pointerStateRef.current;
    if (current.phase === "idle" || current.pointerId !== event.pointerId) return;
    if (current.phase === "armed-marquee" || (current.phase === "dragging" && current.source === "marquee")) {
      try { event.currentTarget.releasePointerCapture?.(event.pointerId); } catch { /* Capture may already be released. */ }
    }
    setPointerMachine({ phase: "idle" });
  }, [setPointerMachine]);

  const handleStackScroll = useCallback((event: ReactUIEvent<HTMLDivElement>) => {
    const current = pointerStateRef.current;
    if (current.phase !== "dragging" || current.source !== "marquee") return;
    const point = contentPointFor(event.currentTarget, current.lastClientX, current.lastClientY);
    const dragging: MinimapPointerState = { ...current, current: point };
    setPointerMachine(dragging);
    selectedIdsForMarquee(dragging);
  }, [selectedIdsForMarquee, setPointerMachine]);

  const openCloseConfirmation = useCallback(() => {
    const tabIds = tabIdsInVisualOrder.filter((tabId) => selectedTabIds.has(tabId));
    if (tabIds.length === 0) return;
    const labels = tabIds.map((tabId) => {
      for (const workspace of workspaces) for (const pane of workspace.panes) {
        const tab = pane.tabs.find((candidate) => candidate.id === tabId);
        if (tab) return tab.label ?? tab.sessionId;
      }
      return tabId;
    });
    setCloseError(null);
    setCloseConfirmation({ tabIds, labels });
  }, [selectedTabIds, tabIdsInVisualOrder, workspaces]);

  const closeSelectedTabs = useCallback(async () => {
    if (!closeConfirmation || closeInFlightRef.current) return;
    closeInFlightRef.current = true;
    setClosing(true);
    setCloseError(null);
    try {
      const result = await handleSocketCommand("pane.close_tabs", { tabIds: closeConfirmation.tabIds }) as { closed?: string[] };
      const closed = new Set(Array.isArray(result.closed) ? result.closed : closeConfirmation.tabIds);
      setSelectedTabIds((current) => new Set([...current].filter((tabId) => !closed.has(tabId))));
      if (selectedTabId && closed.has(selectedTabId)) {
        const fallback = tabIdsInVisualOrder.find((tabId) => !closed.has(tabId));
        if (fallback) {
          minimapSelectionIntentRef.current = fallback;
          onSelect(fallback);
        }
      }
      setCloseConfirmation(null);
    } catch (error) {
      setCloseError(error instanceof Error ? error.message : String(error));
    } finally {
      closeInFlightRef.current = false;
      setClosing(false);
    }
  }, [closeConfirmation, onSelect, selectedTabId, tabIdsInVisualOrder]);

  const marquee = pointerState.phase === "dragging" && pointerState.source === "marquee"
    ? selectionRect(pointerState.start, pointerState.current)
    : null;

  return <section className="cmux-minimap-panel" aria-label={dashboardStrings.layoutMinimapAriaLabel}>
    <div className="cmux-minimap-title">{dashboardStrings.layoutMinimapTitle}</div>
    {selectedTabIds.size > 0 ? <div className="cmux-minimap-selection-summary" aria-live="polite">
      <span key={selectedTabIds.size} className="cmux-minimap-selection-count">{`選択中 ${selectedTabIds.size}本`}</span>
      <button type="button" data-minimap-close-selection="true" onClick={openCloseConfirmation}>選択を閉じる</button>
    </div> : null}
    <div ref={stackRef} className={`cmux-minimap-stack${isMinimapDragging ? " is-minimap-dragging" : ""}`} onPointerDownCapture={handlePointerDown} onPointerMoveCapture={handlePointerMove} onPointerUpCapture={finishPointer} onPointerCancelCapture={cancelMarquee} onScroll={handleStackScroll}>
      {workspaces.map((workspace) => {
        const activePaneId = workspace.panes.find((pane) => paneContainsSession(pane, activePaneSessionId))?.id ?? null;
        return <MinimapWorkspaceBlock key={workspace.id} workspace={workspace} selectedTabId={selectedTabId} selectedTabIds={selectedTabIds} openTabIds={openTabIds} groupPulseTabIds={groupPulseTabIds} displayStateByTabId={displayStateByTabId} expanded={!collapsedWorkspaceIds.has(workspace.id)} activePaneId={activePaneId} onToggle={() => setCollapsedWorkspaceIds((current) => {
          const next = new Set(current);
          if (next.has(workspace.id)) next.delete(workspace.id);
          else next.add(workspace.id);
          persistCollapsedWorkspaceIds(next);
          return next;
        })} onSelect={selectTab} onSelectGroup={selectGroup} onJump={onJump} />;
      })}
      {marquee ? <div className="cmux-minimap-selection-marquee" aria-hidden="true" style={{ left: marquee.left, top: marquee.top, width: marquee.right - marquee.left, height: marquee.bottom - marquee.top }} /> : null}
    </div>
    <div className="cmux-minimap-footer">
      <div className={`cmux-minimap-new-workspace-zone${isNewWorkspaceTarget ? " is-minimap-drop-target" : ""}`} data-minimap-new-workspace-target="true">
        <button type="button" data-minimap-new-workspace-button="true" disabled={!selectedItem} onClick={() => { if (selectedItem) moveMinimapItemToNewWorkspace(selectedItem); }}>
          ＋ 新しいワークスペース
        </button>
      </div>
      <TabSweepButton />
    </div>
    {closeConfirmation ? <section className="cmux-minimap-bundle-confirm" role="dialog" aria-modal="true" aria-label="選択したタブを閉じる確認" data-minimap-close-confirm="true">
      <div>{`${closeConfirmation.tabIds.length}本のタブを閉じます`}</div>
      <ul>{closeConfirmation.labels.map((label, index) => <li key={`${closeConfirmation.tabIds[index]}-${label}`}>{label}</li>)}</ul>
      {closeError ? <div role="alert">{closeError}</div> : null}
      <div className="cmux-minimap-bundle-confirm-actions">
        <button type="button" disabled={closing} onClick={() => { void closeSelectedTabs(); }}>閉じる</button>
        <button type="button" disabled={closing} onClick={() => { setCloseConfirmation(null); setCloseError(null); }}>戻る</button>
      </div>
    </section> : null}
  </section>;
}, areMinimapPropsEqual);

function areMinimapPropsEqual(previous: Readonly<LayoutMinimapPanelProps>, next: Readonly<LayoutMinimapPanelProps>): boolean {
  return previous.workspaces === next.workspaces
    && previous.selectedTabId === next.selectedTabId
    && previous.activePaneSessionId === next.activePaneSessionId
    && previous.onSelect === next.onSelect
    && previous.onJump === next.onJump
    && arraysEqual(previous.openTabIds ?? [], next.openTabIds ?? [])
    && mapsEqual(previous.displayStateByTabId, next.displayStateByTabId);
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function mapsEqual<T>(left: ReadonlyMap<string, T>, right: ReadonlyMap<string, T>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) if (right.get(key) !== value) return false;
  return true;
}
