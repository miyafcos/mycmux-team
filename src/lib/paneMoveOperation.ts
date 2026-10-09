import type { PaneTab, Workspace } from "../types";
import type { PaneDragItem, PaneDropZone } from "../stores/paneDragStore";
import type { DetachedPaneOrigin } from "./ipc";
import type { Rect } from "./tearout/model";
import type { TearoutRecord } from "./tearout/record";
import { useWorkspaceListStore } from "../stores/workspaceListStore";
import { useWorkspaceLayoutStore } from "../stores/workspaceLayoutStore";
import { useSessionAttentionStore } from "../stores/sessionAttentionStore";
import { windowLabel } from "./windowContext";
import { canTransferTab } from "./paneKindCapabilities";
import { applyLayoutMutation, layoutStructureRevision } from "./layoutMutation";
import { captureLegacyTearoutSource } from "./tearout/legacySource";
import { tearoutOperationBusy } from "./tearout/operation";

export type PaneMoveSource = PaneDragItem | { kind: "workspace"; workspaceId: string; label: string };
export interface SplitMoveDestination {
  kind: "split";
  workspaceId: string;
  paneId: string;
  zone: PaneDropZone;
  /** Minimap commits all selected tabs atomically without selecting or focusing. */
  atomic?: boolean;
}
export interface NativeMoveDestination { kind: "native-window"; gap: Rect; offset: { x: number; y: number } }
export interface WindowMoveDestination { kind: "window"; x?: number; y?: number; detachedFrom?: DetachedPaneOrigin }
export type PaneMoveDestination = SplitMoveDestination | NativeMoveDestination | WindowMoveDestination;
export interface PaneMoveOwner {
  paneId: string;
  tabId: string;
  sessionId: string;
  type: PaneTab["type"];
  lifecycle: PaneTab["lifecycle"];
  /** Absent means no execution generation has been observed; it is not a guarantee. */
  execution?: { serverEpoch: string; sessionEpoch: number };
}
export interface PaneMoveRequest<D extends PaneMoveDestination = PaneMoveDestination> {
  operationId: string;
  source: PaneMoveSource;
  destination: D;
  requestedBy: { kind: "ui" | "api"; windowLabel: string };
  expected: { windowLabel: string; owners: readonly PaneMoveOwner[] };
}
export type PaneMovePhase = "requested" | "committed" | "received" | "cleaned" | "rolled_back";
export type PaneMoveRefusal = "source_missing" | "not_transferable" | "owner_changed" | "execution_changed" | "invalid_destination" | "stale_revision" | "no_change";
export interface PaneMoveResult {
  operationId: string;
  status: "moved" | "returned" | "refused" | "failed";
  phase: PaneMovePhase;
  receipt: "not_expected" | "pending" | "acknowledged";
  destinationWindow?: string;
  reason?: string;
  error?: unknown;
}
export interface PaneMoveOptions { record?: TearoutRecord; restoreSource?: () => void }
export interface PaneMoveExecution {
  assertSource: () => void;
  mark: (phase: PaneMovePhase, destinationWindow?: string) => void;
  result: (status: PaneMoveResult["status"], reason?: string) => PaneMoveResult;
}

function sourceOwners(source: PaneMoveSource, workspaces: readonly Workspace[]) {
  const workspace = workspaces.find(w => w.id === source.workspaceId);
  const panes = source.kind === "workspace" ? workspace?.panes : workspace?.panes.filter(p => p.id === source.paneId);
  return (panes ?? []).flatMap(pane => pane.tabs
    .filter(tab => source.kind === "workspace" || source.kind === "pane"
      || (source.kind === "tab" ? tab.id === source.tabId : source.tabIds.includes(tab.id)))
    .map(tab => ({ pane, tab })));
}

/** All entry points freeze the same ownership and observed execution identity. */
export function createPaneMoveRequest<D extends PaneMoveDestination>(
  source: PaneMoveSource, destination: D, requestedBy: PaneMoveRequest["requestedBy"] = { kind: "ui", windowLabel: windowLabel() },
  operationId: string = crypto.randomUUID(),
): PaneMoveRequest<D> {
  const feed = useSessionAttentionStore.getState();
  return {
    operationId,
    source: source.kind === "tab-bundle" ? { ...source, tabIds: [...source.tabIds] } : { ...source },
    destination,
    requestedBy,
    expected: { windowLabel: windowLabel(), owners: sourceOwners(source, useWorkspaceListStore.getState().workspaces).map(({ pane, tab }) => {
      const epoch = feed.attentionBySession[tab.sessionId]?.sessionEpoch;
      return { paneId: pane.id, tabId: tab.id, sessionId: tab.sessionId, type: tab.type, lifecycle: tab.lifecycle,
        ...(feed.serverEpoch !== null && epoch != null ? { execution: { serverEpoch: feed.serverEpoch, sessionEpoch: epoch } } : {}) };
    }) },
  };
}

export function validatePaneMoveRequest(request: PaneMoveRequest): PaneMoveRefusal | null {
  if (request.expected.windowLabel !== windowLabel() || request.requestedBy.windowLabel !== windowLabel()) return "owner_changed";
  const workspaces = useWorkspaceListStore.getState().workspaces;
  const current = sourceOwners(request.source, workspaces);
  if (!current.length || !request.expected.owners.length) return "source_missing";
  if (request.source.kind === "tab-bundle" && new Set(request.source.tabIds).size !== current.length) return "source_missing";
  if (current.length !== request.expected.owners.length) return "owner_changed";
  const feed = useSessionAttentionStore.getState();
  for (const expected of request.expected.owners) {
    const owner = current.find(({ pane, tab }) => pane.id === expected.paneId && tab.id === expected.tabId);
    const allOwners = workspaces.flatMap(w => w.panes.flatMap(p => p.tabs.filter(t => t.id === expected.tabId)));
    if (!owner || allOwners.length !== 1) return "owner_changed";
    if (owner.tab.sessionId !== expected.sessionId || owner.tab.type !== expected.type || owner.tab.lifecycle !== expected.lifecycle) return "execution_changed";
    if (!canTransferTab(owner.tab)) return "not_transferable";
    if (expected.execution && (feed.serverEpoch !== expected.execution.serverEpoch
      || feed.attentionBySession[expected.sessionId]?.sessionEpoch !== expected.execution.sessionEpoch)) return "execution_changed";
  }
  if (request.destination.kind === "native-window" && request.source.kind === "tab-bundle") return "invalid_destination";
  if (request.destination.kind === "split") {
    const destination = request.destination;
    if (request.source.kind === "workspace" || !workspaces.some(w => w.id === destination.workspaceId && w.panes.some(p => p.id === destination.paneId))) return "invalid_destination";
  }
  return null;
}

function executeSplitMove(request: PaneMoveRequest<SplitMoveDestination>, execution: PaneMoveExecution): PaneMoveResult {
  const source = request.source;
  if (source.kind === "workspace") return execution.result("refused", "invalid_destination");
  const destination = request.destination;
  const list = useWorkspaceListStore.getState();
  const before = list.workspaces;
  if (destination.atomic || source.kind === "tab-bundle") {
    const currentRevision = layoutStructureRevision(before);
    const tabIds = request.expected.owners.map(owner => owner.tabId);
    const pane = list.getWorkspace(source.workspaceId)?.panes.find(p => p.id === source.paneId);
    const anchorTabId = source.kind === "tab" ? source.tabId : source.kind === "tab-bundle" ? source.anchorTabId
      : pane?.tabs.some(tab => tab.id === pane.activeTabId) ? pane.activeTabId : tabIds[0];
    const mutation = applyLayoutMutation(before, { kind: "move-tabs", operationId: request.operationId, tabIds, anchorTabId,
      to: destination.zone === "center" ? { workspaceId: destination.workspaceId, paneId: destination.paneId }
        : { workspaceId: destination.workspaceId, split: { paneId: destination.paneId, zone: destination.zone } },
      sourceLayoutRevision: source.sourceLayoutRevision ?? currentRevision }, currentRevision);
    if (mutation.summary.staleRevision) return execution.result("refused", "stale_revision");
    if (mutation.summary.moved.length !== tabIds.length) return execution.result("refused", "no_change");
    list._replaceWorkspaces(mutation.workspaces);
  } else {
    const layout = useWorkspaceLayoutStore.getState();
    if (source.kind === "tab") {
      if (destination.zone === "center") layout.moveTabToPane(source.workspaceId, source.paneId, source.tabId, destination.workspaceId, destination.paneId);
      else layout.moveTabToSplit(source.workspaceId, source.paneId, source.tabId, destination.workspaceId, destination.paneId, destination.zone);
    } else {
      if (destination.zone === "center") layout.movePaneToPane(source.workspaceId, source.paneId, destination.workspaceId, destination.paneId);
      else layout.movePaneToSplit(source.workspaceId, source.paneId, destination.workspaceId, destination.paneId, destination.zone);
    }
    if (useWorkspaceListStore.getState().workspaces === before) return execution.result("refused", "no_change");
  }
  execution.mark("committed");
  return execution.result("moved");
}

export function executePaneMove(request: PaneMoveRequest<SplitMoveDestination>, options?: PaneMoveOptions): PaneMoveResult;
export function executePaneMove(request: PaneMoveRequest<NativeMoveDestination | WindowMoveDestination>, options?: PaneMoveOptions): Promise<PaneMoveResult>;
export function executePaneMove(request: PaneMoveRequest, options?: PaneMoveOptions): PaneMoveResult | Promise<PaneMoveResult>;
/** Common executor; gesture code owns only presentation and logical selection. */
export function executePaneMove(request: PaneMoveRequest, options: PaneMoveOptions = {}): PaneMoveResult | Promise<PaneMoveResult> {
  let guardRequest = request;
  let phase: PaneMovePhase = "requested";
  let receipt: PaneMoveResult["receipt"] = request.destination.kind === "split" ? "not_expected" : "pending";
  let destinationWindow: string | undefined;
  const execution: PaneMoveExecution = {
    assertSource: () => {
      const reason = validatePaneMoveRequest(guardRequest);
      if (reason) throw new Error(`tearout_source_changed: ${reason}`);
    },
    mark: (next, receiver) => {
      phase = next;
      if (receiver) destinationWindow = receiver;
      if (next === "received" || next === "cleaned") receipt = "acknowledged";
    },
    result: (status, reason) => ({ operationId: request.operationId, status, phase, receipt, destinationWindow, ...(reason ? { reason } : {}) }),
  };
  const reason = validatePaneMoveRequest(request);
  if (reason) {
    const result = execution.result("refused", reason);
    return request.destination.kind === "split" ? result : Promise.resolve(result);
  }
  if (request.destination.kind === "split") return executeSplitMove(request as PaneMoveRequest<SplitMoveDestination>, execution);
  return (async () => {
    let restoreStagedSource: (() => void) | undefined;
    let restored = false;
    try {
      if (request.destination.kind === "native-window") {
        const { performNativePaneMove } = await import("./tearout/runtime");
        execution.assertSource();
        return await performNativePaneMove(request as PaneMoveRequest<NativeMoveDestination>, execution, options);
      }
      const { performWorkspaceWindowMove } = await import("./workspaceTearOut");
      execution.assertSource();
      if (tearoutOperationBusy()) throw new Error("tearout_move_busy");
      // Ordinary windows use the existing temporary workspace. Preparing it is
      // part of execution, so every entry captures its original owner first.
      if (request.source.kind !== "workspace") {
        const source = request.source;
        const restore = captureLegacyTearoutSource(source);
        const workspaceId = crypto.randomUUID();
        const workspaceName = `Workspace ${useWorkspaceListStore.getState().workspaces.length + 1}`;
        const layout = useWorkspaceLayoutStore.getState();
        const moved = source.kind === "tab"
          ? layout.moveTabToNewWorkspace(source.workspaceId, source.paneId, source.tabId, workspaceId, workspaceName, { activate: false })
          : source.kind === "tab-bundle"
            ? layout.moveTabsToNewWorkspace(source.workspaceId, source.paneId, source.tabIds, source.anchorTabId, workspaceId, workspaceName, { activate: false })
            : layout.movePaneToNewWorkspace(source.workspaceId, source.paneId, workspaceId, workspaceName, { activate: false });
        if (!moved) return execution.result("refused", "source_missing");
        restoreStagedSource = () => { restore(workspaceId); restored = true; execution.mark("rolled_back"); };
        guardRequest = createPaneMoveRequest({ kind: "workspace", workspaceId, label: workspaceName }, request.destination,
          request.requestedBy, request.operationId);
        // Keep the original observed generation across our own layout change.
        guardRequest.expected.owners = guardRequest.expected.owners.map(owner => ({ ...owner,
          execution: request.expected.owners.find(original => original.tabId === owner.tabId)?.execution }));
      }
      execution.assertSource();
      const result = await performWorkspaceWindowMove(guardRequest as PaneMoveRequest<WindowMoveDestination>, execution,
        { ...options, restoreSource: restoreStagedSource ?? options.restoreSource });
      if (result.status === "refused") restoreStagedSource?.();
      return result;
    } catch (error) {
      if (restoreStagedSource && !restored && !(error as { notified?: boolean })?.notified) restoreStagedSource();
      return { ...execution.result("failed", error instanceof Error ? error.message : String(error)), error };
    }
  })();
}
