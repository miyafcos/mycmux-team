import { invoke } from "@tauri-apps/api/core";
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { flushSync } from "react-dom";
import { create } from "zustand";
import { nativePaneTearoutEnabled, isMacTearoutPlatform } from "./feature";
import type { TearoutMode } from "./mode";
import { afterTearoutFrame } from "./macFrame";
import { sourceLogicalExtent, windowsNativeBand } from "./windowBehavior";
import { startTearoutFrames, finishTearoutFrames, disposeTearoutFrames } from "./frameMetrics";
import { expectTearoutAttachments, rememberTearoutDormantSessions } from "./sessionAttachment";
import { terminalTransferSessions, liveTransferSessions } from "./transferSessions";
import { LocalTearoutRefusal, beginTearoutOperation, restoringTearoutOperation, endTearoutOperation, tearoutOperationBusy, localTearoutRefusal, observeTearoutMove, clearObservedTearoutMoves, finishObservedTearoutMove, reserveIncomingTearout, finishIncomingTearout, setTearoutDisplayActivity, incomingTearoutTokens, subscribeTearoutOperationStart } from "./operation";
import type { TearoutRefusalSource } from "./operation";
import { recoveryProgress, recoveryFinished, recoveryFailed, recoveryBusy } from "./recoveryNotice";
import { recordTearoutRefusal, rejectTearoutStart } from "./refusal";
import { useToastStore } from "../../stores/toastStore";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getAllWindows } from "@tauri-apps/api/window";
import { installMacTearoutPrewarm } from "./macPrewarm";
import { restoreTearoutSource, restoreTearoutGroup, removeTearoutTab, nativeDropAllowed, type Rect } from "./model";
import { detachedOriginForDrag, detachedWorkspaceConfig, isTransferableTab, type DetachedReturnTarget } from "../detachedPane";
import { restoreWorkspaceConfigs } from "../workspaceRestore";
import { windowLabel, isMainWindow } from "../windowContext";
import { isSessionAlive, WINDOW_REGISTRY_CHANGED_EVENT, type WorkspaceConfig } from "../ipc";
import { useWorkspaceListStore } from "../../stores/workspaceListStore";
import { useWorkspaceLayoutStore } from "../../stores/workspaceLayoutStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { applyExternalStoreUpdate } from "../../stores/syncedPersist";
import { useUiStore } from "../../stores/uiStore";
import { evictTerminalCache } from "../../components/terminal/terminalCache";
import { focusController } from "../focusController";
import { detachedDockTarget, useDetachedDockStore, type DockTarget } from "../../stores/detachedDockStore";
import { TearoutReleaseReceiver, afterReleasePaint, type ReleasePoint, type ReleaseFrame, type ReleaseApproval } from "./release";
import { TearoutPreview, sameDockTarget } from "./preview";
import { TearoutRecord, activeTearoutRecords, configureTearoutInputEvidence, mergeDockDiagnostics, type DockDiagnostics, type DockStage,
  type FailureCheckpoint, type ReleaseDecision, type RecordData, type Reveal, type TearoutError, type TearoutResult } from "./record";
import type { PaneDragItem } from "../../stores/paneDragStore";
import { createWorkspaceHover } from "../workspaceHover";
import type { Workspace } from "../../types";
import { capturePaneHandoffSource } from "../paneHandoffRuntime";
import { onlineStrings } from "../../components/online/onlineStrings";
import { installTearoutHandoff, publishTearoutHandoffDrag, requestTearoutHandoff, tearoutHandoffSource } from "./handoff";
import { createPaneMoveRequest, executePaneMove, type PaneMoveRequest, type NativeMoveDestination,
  type PaneMoveExecution, type PaneMoveOptions, type PaneMoveResult } from "../paneMoveOperation";

declare global { interface Window { __MYCMUX_TEAROUT_WINDOW__?: boolean } }
type RestoredWindow = Window & { __MYCMUX_RESTORED_WINDOW__?: boolean };
const isRestoredWindow = (): boolean => (globalThis.window as RestoredWindow | undefined)?.__MYCMUX_RESTORED_WINDOW__ === true;
// A restored child uses the same paint-ready startup gate, then resumes its
// original native/ordinary window behavior without taking foreground focus.
export const isTearoutChild = (): boolean => globalThis.window?.__MYCMUX_TEAROUT_WINDOW__ === true || isRestoredWindow();
export const useTearoutStore = create<{ gap: Rect | null; gapLabel: string }>(() => ({ gap: null, gapLabel: "" }));

const DELIVERY = "mycmux://tearout-delivery";
const RECEIPT = "mycmux://tearout-receipt";
const REVOKE = "mycmux://tearout-revoke";
const PREFERENCE = "mycmux://tearout-preference";
const OUTGOING = "mycmux://tearout-outgoing";
const FINALIZE = "mycmux://tearout-finalize";
const HIGHLIGHT = "mycmux://tearout-highlight";
const PROGRESS = "mycmux://tearout-progress";
type Approval = ReleaseApproval;
interface Delivery { token: string; source: string; configs: WorkspaceConfig[]; placement?: DetachedReturnTarget; approval?: Approval; activeSessionId?: string | null; liveSessions?: string[]; dock?: { requester: string } }
interface DockReservationRefusal { kind: "reservation"; pre_ownership: true; source: string; deliveryToken: string;
  refusalSource?: TearoutRefusalSource; blockerId?: string | null }
interface Receipt extends DockDiagnostics { token: string; ok: boolean; error?: string; reason?: string; failedSessions?: string[]; refusal?: DockReservationRefusal }
interface DockRequest { token: string; deliveryToken: string; requester: string; approval: Approval; record?: RecordData }
export interface NativeSample {
  id: string; readonly mode: TearoutMode; label: string; x: number; y: number; phase: "move" | "end"; at: number; escaped: boolean;
  receiver: string | null; client_x: number; client_y: number; approval: Approval | null;
  native_started_at: number | null; error: string | null; start_alignment?: import("./record").StartAlignment | null;
  native_start_delay_ms?: number | null;
  scale: number; monitor: string | null; focus_stolen: boolean;
  esc_at: number | null; original: { x: number; y: number; width: number; height: number };
  source?: string; region_count?: number; receiver_epoch?: number; moved?: boolean; sequence?: number; release?: ReleasePoint | null;
}
interface Adapter {
  hydrated?: Promise<void>; serialize: (workspace: Workspace) => WorkspaceConfig; publish: () => Promise<void> }
let adapter: Adapter | null = null;
let listenersReady: Promise<void> = Promise.resolve();
export const TEAROUT_SPARE_IDLE_MS = 3000;
const SPARE_REFILL_LIMIT_MS = 30000;
// Backstop for the 30-second deadline, which normally expires first.
const SPARE_REFILL_MAX_ATTEMPTS = 30;
let spareRefill: { request: () => void; activity: () => void } | null = null;
const receipts = new Map<string, (receipt: Receipt) => void>();
interface Incoming { delivery: Delivery; before: Workspace[]; revoked: boolean; workspace: string | null; session: string | null;
  zoom: string | null; remembered: Record<string, string>; settled: Promise<void>; settle: () => void; addedIds: Set<string>;
  failed: boolean; cancel: () => void; receiving: boolean; finalized: boolean; notices: Set<string> }
const incoming = new Map<string, Incoming>();
let incomingCheckTimer: number | null = null;
let incomingCheckEpoch = 0;
let incomingChecksEnabled = false;
const revokedTokens = new Set<string>();
const retiredDeliveries = new Set<string>();
const reasonOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
class TransferFailure extends Error {
  constructor(reason: string, public readonly sessionIds: string[] = [], public readonly recoveryFailed = false) { super(reason); }
}
const failureDiagnostics = new WeakMap<object, DockDiagnostics>();
const diagnosticsOf = (error: unknown): DockDiagnostics => error !== null && typeof error === "object" ? failureDiagnostics.get(error) ?? {} : {};
function annotateFailure(error: unknown, diagnostics: DockDiagnostics): void {
  if (error !== null && typeof error === "object") failureDiagnostics.set(error, diagnostics);
}
function diagnosedFailure(error: unknown, diagnostics: DockDiagnostics): unknown {
  const failure = error !== null && typeof error === "object" ? error : new Error(reasonOf(error));
  annotateFailure(failure, diagnostics); return failure;
}
interface DockTrace { source: string; receiver: string; details: DockDiagnostics; record?: TearoutRecord }
const dockTraces = new Map<string, DockTrace>();
function updateDockTrace(token: string, details: DockDiagnostics): void {
  const trace = dockTraces.get(token);
  if (!trace) return;
  mergeDockDiagnostics(trace.details, details); trace.record?.diagnostics(details);
}
function dockStage(token: string, details: DockDiagnostics, side: DockStage["side"], stage: DockStage["stage"], labels: string[]): void {
  const update = { dock_stages: [{ side, stage, at: Date.now() }] };
  mergeDockDiagnostics(details, update); updateDockTrace(token, update);
  for (const label of new Set(labels)) void emitTo(label, PROGRESS, { token, sender: windowLabel(), ...update }).catch(() => {});
}
function failureCheckpoint(error: unknown, fallback: FailureCheckpoint = "other"): FailureCheckpoint {
  const reason = reasonOf(error);
  return reason === "tearout_receipt_timeout" || reason === "tearout_dock_timeout" ? "receipt_timeout"
    : reason.includes("attachment_timeout") || reason.includes("Terminal IPC timed out: get_session_attachment_contexts") ? "attachment_timeout" : fallback;
}
function releaseFailureDecision(error: unknown): ReleaseDecision | null {
  const reason = reasonOf(error);
  return reason === "tearout_drop_target_changed" ? "layout_changed"
    : reason === "tearout_release_timeout" || reason === "tearout_release_paint_timeout" ? "receiver_timeout"
    : reason === "tearout_release_cancelled" || reason === "tearout_release_disposed" ? "cancelled"
    : reason === "tearout_release_identity_changed" || reason === "tearout_release_receiver_changed" ? "identity_changed"
    : reason === "tearout_release_expired" ? "expired" : null;
}
function releaseDecision(sample: NativeSample, approval: Approval | null): ReleaseDecision {
  return sample.escaped ? "esc_cancelled" : sample.release === null ? "no_release_point"
    : approval ? "approved" : sample.receiver ? "no_hit" : "no_receiver";
}
const approvedDrops = new Map<string, DockTarget>();
let preview: { id: string; label: string; epoch: number; feedback: TearoutPreview; target: DockTarget | null } | null = null;
let pendingSample: NativeSample | null = null;
let cancelSampleFrame: (() => void) | null = null;
let previewRevision = 0;
let workspaceViewRevision = 0;
const nativeModes = new Map<string, TearoutMode>();
let workspaceHoverSample: NativeSample | null = null;
const hoverEndedIds = new Set<string>();
const nativeWorkspaceHover = createWorkspaceHover({
  active: () => workspaceHoverSample !== null && releaseFrameOwner === null && !hoverEndedIds.has(workspaceHoverSample.id),
  switchWorkspace: id => {
    // The workspace subscription clears old paint/approval before the new DOM
    // is committed. Resolve the last point again against that committed view.
    flushSync(() => useWorkspaceListStore.getState().setActiveWorkspace(id));
    if (workspaceHoverSample && !hoverEndedIds.has(workspaceHoverSample.id)) applyNativeSample({ ...workspaceHoverSample, at: Date.now() });
  },
});

function endWorkspaceHover(id: string): void {
  hoverEndedIds.add(id);
  if (hoverEndedIds.size > 64) hoverEndedIds.delete(hoverEndedIds.values().next().value!);
  nativeWorkspaceHover.clear(); workspaceHoverSample = null;
}

function updateNativeWorkspaceHover(sample: NativeSample): void {
  if (workspaceHoverSample && (workspaceHoverSample.id !== sample.id || workspaceHoverSample.label !== sample.label
    || workspaceHoverSample.receiver_epoch !== sample.receiver_epoch)) nativeWorkspaceHover.clear();
  if (sample.phase === "end") { endWorkspaceHover(sample.id); return; }
  if (sample.mode !== "dock" || sample.receiver !== windowLabel() || sample.label === windowLabel()
    || sample.escaped || sample.error || hoverEndedIds.has(sample.id) || releaseFrameOwner !== null) {
    nativeWorkspaceHover.clear(); workspaceHoverSample = null; return;
  }
  workspaceHoverSample = sample;
  nativeWorkspaceHover.update(sample.client_x, sample.client_y);
}

function nativeTarget(sample: Pick<NativeSample, "id" | "mode" | "label" | "source" | "client_x" | "client_y" | "region_count">, previous = preview?.target): DockTarget | null {
  if (sample.mode !== "dock" || nativeModes.get(sample.id) === "detach") return null;
  const sidebar = document.elementFromPoint(sample.client_x, sample.client_y)?.closest('[data-dnd-workspace-sidebar="true"]');
  const target: DockTarget | null = sidebar ? { kind: "workspace" } : detachedDockTarget({ screenX: sample.client_x, screenY: sample.client_y },
    { x: 0, y: 0, scale: 1 }, document, previous, tearoutHandoffSource(sample.id, sample.label, sample.source));
  const list = useWorkspaceListStore.getState();
  return nativeDropAllowed(sample.region_count ?? 1, target) && target && (target.kind === "workspace" || list.workspaces.some((workspace) => workspace.id === list.activeWorkspaceId && workspace.id === target.workspaceId
    && workspace.panes.some((pane) => pane.id === target.paneId))) ? target : null;
}

const releasedIds = new Set<string>();
let releaseReceiver: TearoutReleaseReceiver | null = null;
let releaseFrameOwner: string | null = null;
const awaitingRelease = new Map<string, number>();
function finishAwaitingRelease(id: string): void {
  const timer = awaitingRelease.get(id);
  if (timer !== undefined) window.clearTimeout(timer);
  awaitingRelease.delete(id); setTearoutDisplayActivity(`release-await:${id}`, false);
}
function holdAwaitingRelease(sample: NativeSample): void {
  if (sample.mode !== "dock" || sample.phase !== "end" || !sample.release || sample.escaped || sample.error
    || sample.receiver !== windowLabel() || sample.label === windowLabel() || awaitingRelease.has(sample.id)) return;
  setTearoutDisplayActivity(`release-await:${sample.id}`, true);
  awaitingRelease.set(sample.id, window.setTimeout(() => finishAwaitingRelease(sample.id), 500));
}

function releaseLayoutRevision(target: DockTarget): string {
  const state = useWorkspaceListStore.getState();
  const pane = target.kind === "workspace" ? null : Array.from(document.querySelectorAll<HTMLElement>("[data-dnd-pane-id][data-dnd-workspace-id]"))
    .find(element => element.dataset.dndPaneId === target.paneId && element.dataset.dndWorkspaceId === target.workspaceId);
  const element = target.kind === "workspace" ? document.querySelector<HTMLElement>('[data-dnd-workspace-sidebar="true"]')
    : target.kind === "tab-index" ? pane?.querySelector<HTMLElement>(".pane-tabbar") : pane;
  // Header text and session metadata can change without moving this target.
  // A missing target remains a different revision, even at zero-sized bounds.
  const rect = element?.getBoundingClientRect();
  const geometry = rect ? [rect.x, rect.y, rect.width, rect.height] : null;
  const tabOrder = target.kind === "tab-index" ? Array.from(element?.querySelectorAll<HTMLElement>("[data-tab-id]") ?? [])
    .map(tab => tab.dataset.tabId) : null;
  return JSON.stringify([window.innerWidth, window.innerHeight, window.devicePixelRatio, useUiStore.getState().zoomedPaneId, state.activeWorkspaceId, workspaceViewRevision,
    state.workspaces.map(ws => [ws.id, ws.splitColumns, ws.columnWidths, ws.rowHeightsPerCol, ws.panes.map(pane => [pane.id, pane.activeTabId, pane.tabs.map(tab => tab.id)])]), geometry, tabOrder]);
}

async function finalReleaseApproval(sample: NativeSample): Promise<Approval | null> {
  if (sample.mode !== "dock") return null;
  // Old synthetic callers retain their hover protocol. Every native end now
  // carries release (including null), so historical approval cannot win there.
  if (sample.release === undefined) return sample.approval;
  if (!sample.release || sample.escaped || sample.error || !sample.receiver) return null;
  return invoke<Approval | null>("tearout_resolve_release", { id: sample.id });
}

function handleNativeSample(sample: NativeSample): void {
  if (releasedIds.has(sample.id) || (sample.mode !== "dock" && sample.mode !== "detach")) return;
  const mode = nativeModes.get(sample.id);
  if (mode && mode !== sample.mode) return;
  nativeModes.set(sample.id, sample.mode);
  if (nativeModes.size > 64) nativeModes.delete(nativeModes.keys().next().value!);
  holdAwaitingRelease(sample);
  observeTearoutMove(sample, windowLabel());
  if (sample.phase === "end") finishTearoutFrames(sample.id);
  else startTearoutFrames(sample.id);
  activeTearoutRecords.get(sample.id)?.native(sample);
  // Cancel/replace row dwell at event arrival, before frame coalescing or IPC
  // can let a departed row's timer win a release/receiver-leave race.
  updateNativeWorkspaceHover(sample);
  if (sample.phase === "end") {
    cancelSampleFrame?.();
    cancelSampleFrame = null; pendingSample = null;
    applyNativeSample(sample);
    return;
  }
  pendingSample = sample;
  if (!cancelSampleFrame) cancelSampleFrame = afterTearoutFrame(() => {
    cancelSampleFrame = null;
    const latest = pendingSample; pendingSample = null;
    if (latest) applyNativeSample(latest);
  });
}

function applyNativeSample(sample: NativeSample): void {
  // A release frame must survive both paint frames. A different native move
  // may resume hover feedback after final acknowledgement or cancellation.
  if (releaseFrameOwner !== null) return;
  if (sample.mode !== "dock" || sample.receiver !== windowLabel() || sample.label === windowLabel()) {
    if (preview?.id === sample.id) { preview.feedback.clear(sample.phase === "end", sample.at); preview = null; }
    return;
  }
  const epoch = sample.receiver_epoch ?? 0;
  if (!preview || preview.id !== sample.id || preview.epoch !== epoch) {
    preview?.feedback.clear(false, sample.at);
    let revision = 0;
    let token: string | null = null;
    const feedback = new TearoutPreview({
      frame: (target) => {
        flushSync(() => useDetachedDockStore.setState({ active: target ? { label: sample.label, workspaceId: "", nativeSingleTab: true } : null, target }));
      },
      // The frame mounts inside rAF, so the next rAF follows its first paint.
      afterPaint: (callback) => { afterTearoutFrame(callback); },
      approve: (value, target) => {
        revision = ++previewRevision; token = value;
        return invoke<boolean>("tearout_preview", { id: sample.id, token: value, target, revision, epoch });
      },
      alpha: (alpha) => invoke("tearout_alpha", { label: sample.label, id: sample.id, alpha, revision, epoch, token }),
      highlighted: (at, _token, _target, hoverAt) => {
        const labels = new Set([sample.source ?? sample.label, sample.label]);
        for (const label of labels) void emitTo(label, HIGHLIGHT, { id: sample.id, at, hoverAt, receiver: windowLabel() }).catch(() => {});
      },
      cleared: (at, afterRelease) => {
        for (const label of new Set([sample.source ?? sample.label, sample.label]))
          void emitTo(label, HIGHLIGHT, { id: sample.id, at, active: false, afterRelease, receiver: windowLabel() }).catch(() => {});
      },
    });
    preview = { id: sample.id, label: sample.label, epoch, feedback, target: null };
  }
  const target = nativeTarget(sample);
  if (sample.phase === "end") {
    const approval = sample.release === undefined ? sample.approval : null;
    if (!sample.escaped && approval && target && sameDockTarget(approval.target, target)
      && preview.feedback.accepts(approval.token, target)) {
      approvedDrops.set(approval.token, target);
      window.setTimeout(() => approvedDrops.delete(approval.token), 6000);
    }
    preview.feedback.clear(true, sample.at);
    preview = null;
    return;
  }
  preview.target = target;
  preview.feedback.sample(target, sample.at);
}

function timeout<T>(promise: Promise<T>, ms: number, code: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(code)), ms);
    promise.then((result) => { window.clearTimeout(timer); resolve(result); },
      (error) => { window.clearTimeout(timer); reject(error); });
  });
}

function sessions(configs: WorkspaceConfig[]): string[] {
  return terminalTransferSessions(configs);
}

function removeReceived(entry: Incoming): void {
  const ids = entry.addedIds;
  const list = useWorkspaceListStore.getState();
  if (!list.workspaces.some((workspace) => workspace.panes.some((pane) => pane.tabs.some((tab) => ids.has(tab.id))))) return;
  const next = list.workspaces.flatMap((workspace) => {
    const panes = workspace.panes.flatMap((pane) => {
      if (!pane.tabs.some((tab) => ids.has(tab.id))) return [pane];
      const tabs = pane.tabs.filter((tab) => !ids.has(tab.id));
      const original = entry.before.find(before => before.id === workspace.id)?.panes.find(before => before.id === pane.id);
      const activeTabId = tabs.some(tab => tab.id === pane.activeTabId) ? pane.activeTabId
        : tabs.some(tab => tab.id === original?.activeTabId) ? original!.activeTabId : tabs[0]?.id;
      return tabs.length ? [{ ...pane, tabs, activeTabId, sessionId: tabs.find(tab => tab.id === activeTabId)?.sessionId ?? tabs[0].sessionId }] : [];
    });
    const before = entry.before.find((before) => before.id === workspace.id);
    return panes.length || workspace.panes.length === 0 ? [{ ...workspace, panes,
      ...(before ? { splitColumns: before.splitColumns, columnWidths: before.columnWidths,
        rowHeightsPerCol: before.rowHeightsPerCol, columnDividerPins: before.columnDividerPins,
        rowDividerPinsPerCol: before.rowDividerPinsPerCol } : {}) }] : [];
  });
  flushSync(() => {
    list._replaceWorkspaces(next);
    if (entry.workspace && next.some((workspace) => workspace.id === entry.workspace)) list.setActiveWorkspace(entry.workspace);
    else useWorkspaceListStore.setState({ activeWorkspaceId: next[0]?.id ?? null });
    useUiStore.getState().setActivePaneId(entry.session);
    useUiStore.getState().setZoomedPaneId(entry.zoom);
    useWorkspaceListStore.setState(state => {
      const remembered = { ...state.lastActivePaneByWorkspace };
      for (const id of Object.keys(remembered)) if (!next.some(workspace => workspace.id === id)) delete remembered[id];
      for (const workspace of entry.before) {
        if (entry.remembered[workspace.id]) remembered[workspace.id] = entry.remembered[workspace.id];
        else delete remembered[workspace.id];
      }
      return { lastActivePaneByWorkspace: remembered };
    });
  });
  for (const sessionId of sessions(entry.delivery.configs)) evictTerminalCache(sessionId);
}

async function receive(delivery: Delivery): Promise<void> {
  if (incoming.has(delivery.token) || revokedTokens.has(delivery.token)) return;
  spareRefill?.activity();
  let settle = () => {};
  const settled = new Promise<void>((resolve) => { settle = resolve; });
  let cancel = () => {};
  const cancelled = new Promise<never>((_, reject) => { cancel = () => reject(new Error("tearout_receive_cancelled")); });
  void cancelled.catch(() => {});
  const wait = <T,>(promise: Promise<T>) => Promise.race([promise, cancelled]);
  const existingIds = new Set(useWorkspaceListStore.getState().workspaces.flatMap((ws) => ws.panes.flatMap((pane) => pane.tabs.map((tab) => tab.id))));
  const rawDeliveryIds = delivery.configs.flatMap((cfg) => cfg.panes.flatMap((pane) => (pane.tabs ?? []).map((tab) => tab.tab_id)));
  const deliveryIds = rawDeliveryIds.filter((id): id is string => typeof id === "string" && id.length > 0);
  const entry: Incoming = { delivery, before: useWorkspaceListStore.getState().workspaces, revoked: false, settled,
    settle: () => { if (entry.receiving) { entry.receiving = false; settle(); } }, cancel, failed: false, receiving: true, finalized: false, notices: new Set(),
    workspace: useWorkspaceListStore.getState().activeWorkspaceId, session: useUiStore.getState().activePaneId,
    zoom: useUiStore.getState().zoomedPaneId, remembered: useWorkspaceListStore.getState().lastActivePaneByWorkspace,
    addedIds: new Set(deliveryIds.filter((id) => !existingIds.has(id))) };
  incoming.set(delivery.token, entry);
  reserveIncomingTearout(delivery.token);
  queueIncomingCheck();
  const expected = delivery.liveSessions ?? sessions(delivery.configs).filter(id =>
    !delivery.configs.some(config => config.panes.some(pane => pane.tabs?.some(tab => tab.session_id === id && tab.lifecycle === "declared"))));
  rememberTearoutDormantSessions(sessions(delivery.configs), expected);
  let attachment: ReturnType<typeof expectTearoutAttachments> | undefined;
  const details: DockDiagnostics = {};
  const stage = (name: DockStage["stage"]) => {
    if (delivery.dock) dockStage(delivery.token, details, "receiver", name, [delivery.source, delivery.dock.requester]);
  };
  let checkpoint: FailureCheckpoint = "other";
  try {
    attachment = expectTearoutAttachments(expected, "transfer", undefined, delivery.token);
    stage("attachment_prepared_wait");
    await wait(attachment.prepared);
    stage("attachment_prepared");
    if (entry.revoked) return;
    checkpoint = "receiver_validation";
    if (deliveryIds.length !== rawDeliveryIds.length) throw new Error("tearout_adoption_missing_id");
    if (deliveryIds.some((id) => existingIds.has(id))) throw new Error("tearout_adoption_duplicate");
    const existingSessions = new Set(entry.before.flatMap(ws => ws.panes.flatMap(pane => pane.tabs.map(tab => tab.sessionId))));
    if (sessions(delivery.configs).some(id => existingSessions.has(id))) throw new Error("tearout_adoption_duplicate_session");
    const placement = delivery.placement;
    if (placement?.kind === "pane" || placement?.kind === "pane-zone") {
      const pane = useWorkspaceListStore.getState().getWorkspace(placement.workspaceId)?.panes.find((pane) => pane.id === placement.paneId);
      if (!pane || placement.kind === "pane" && (!Number.isSafeInteger(placement.index) || placement.index < 0 || placement.index > pane.tabs.length)) {
        throw new Error("tearout_drop_target_changed");
      }
    }
    if (delivery.approval) {
      const actualPlacement: DockTarget | null = !placement || placement.kind === "recreate-pane" ? null
        : placement.kind === "pane" ? { ...placement, kind: "tab-index" } : placement;
      if (!actualPlacement || !sameDockTarget(actualPlacement, delivery.approval.target)) throw new Error("tearout_drop_target_changed");
      if (delivery.approval.release_id) {
        checkpoint = "consume"; stage("consume_wait");
        const consumed = await wait(Promise.resolve(releaseReceiver?.consume(delivery.approval, delivery.source)));
        if (!consumed?.ok) {
          details.consume_failure_reason = consumed?.reason ?? "not_approved";
          throw new Error(`tearout_consume_${details.consume_failure_reason}`);
        }
        stage("consumed"); checkpoint = "receiver_validation";
      } else {
        const target = approvedDrops.get(delivery.approval.token);
        if (!target || !sameDockTarget(target, delivery.approval.target)) throw new Error("tearout_drop_not_painted");
        approvedDrops.delete(delivery.approval.token);
      }
    }
    stage("session_alive_wait");
    const alive = Promise.all(expected.map((id) => isSessionAlive(id)));
    // A synchronous restore failure can bypass checkAlive; retain its rejection handler.
    void alive.catch(() => {});
    // Mac may render/reattach while this read-only check is in flight. Receipt
    // still requires both live existing PTYs and successful attachments.
    const checkAlive = async () => {
      const state = await wait(alive);
      stage("session_alive");
      const failed = expected.filter((_, index) => !state[index]);
      if (failed.length) throw new TransferFailure("tearout_session_not_alive", failed);
    };
    if (!isMacTearoutPlatform()) await checkAlive();
    if (entry.revoked) return;
    if (delivery.approval?.release_id && delivery.approval.layout_revision !== releaseLayoutRevision(delivery.approval.target)) throw new Error("tearout_drop_target_changed");
    flushSync(() => {
      const configs = delivery.placement?.kind === "workspace"
        ? delivery.configs.map((config) => ({ ...config, detached: false, detached_from: null })) : delivery.configs;
      restoreWorkspaceConfigs(configs, {
        dockDetached: Boolean(delivery.placement),
        placementByWorkspaceId: delivery.placement ? Object.fromEntries(delivery.configs.map((config) => [config.id, delivery.placement!])) : {},
      });
      const transported = delivery.configs.flatMap(config => config.panes.flatMap(pane => pane.tabs ?? []));
      // Launcher identities can be non-PTY strings. Persistence's PTY normalizer
      // must not replace them during an in-process ownership transfer.
      const identities = new Map(transported.filter(tab => tab.tab_id && tab.session_id).map(tab => [tab.tab_id!, tab.session_id!]));
      const current = useWorkspaceListStore.getState();
      current._replaceWorkspaces(current.workspaces.map(workspace => ({ ...workspace, panes: workspace.panes.map(pane => {
        const tabs = pane.tabs.map(tab => identities.has(tab.id) ? { ...tab, sessionId: identities.get(tab.id)! } : tab);
        return { ...pane, tabs, sessionId: tabs.find(tab => tab.id === pane.activeTabId)?.sessionId ?? pane.sessionId };
      }) })));

      const selected = transported.find(tab => tab.session_id === delivery.activeSessionId)
        ?? transported.find(tab => tab.tab_id === delivery.configs[0]?.panes[0]?.active_tab_id) ?? transported[0];
      const firstId = selected?.tab_id;
      const owned = useWorkspaceListStore.getState();
      const workspace = owned.workspaces.find((ws) => ws.panes.some((pane) => pane.tabs.some((tab) => tab.id === firstId)));
      const pane = workspace?.panes.find((pane) => pane.tabs.some((tab) => tab.id === firstId));
      if (!workspace || !pane || !firstId) throw new Error("tearout_adoption_missing");
      owned.setActiveWorkspace(workspace.id);
      useWorkspaceLayoutStore.getState().setActivePaneTab(workspace.id, pane.id, firstId);
      useUiStore.getState().setActivePaneId(selected?.session_id ?? pane.sessionId);
    });
    stage("layout"); stage("attachment_wait");
    if (isMacTearoutPlatform()) {
      await wait(Promise.all([checkAlive(), timeout(attachment.ready, 5000, "tearout_attachment_timeout")]));
    } else {
      await wait(timeout(attachment.ready, 5000, "tearout_attachment_timeout"));
    }
    stage("attached");
    if (entry.revoked) return;
    const ownedIds = useWorkspaceListStore.getState().workspaces.flatMap((ws) => ws.panes.flatMap((pane) => pane.tabs.map((tab) => tab.sessionId)));
    if (!expected.every((id) => ownedIds.includes(id))) throw new Error("tearout_session_identity_changed");
    checkpoint = "other";
    stage("publish_wait"); await wait(adapter!.publish()); stage("published"); stage("receipt");
    await wait(emitTo(delivery.source, RECEIPT, { token: delivery.token, ok: true, ...(delivery.dock ? details : {}) }));
  } catch (error) {
    if (entry.revoked) return;
    entry.failed = true;
    details.failure_checkpoint = failureCheckpoint(error, checkpoint);
    try { removeReceived(entry); await wait(adapter!.publish()); }
    catch (recoveryError) { details.receiver_cleanup_reason = reasonOf(recoveryError); }
    stage("receipt");
    await emitTo(delivery.source, RECEIPT, { token: delivery.token, ok: false, error: "tearout_receive_failed",
      reason: reasonOf(error), ...details,
      ...(delivery.liveSessions ? { failedSessions: error instanceof TransferFailure ? error.sessionIds : expected } : {}) });
  } finally {
    try { attachment?.dispose(); }
    finally {
      entry.settle();
      if (entry.failed || entry.revoked) void clearAbandonedIncoming("settled");
    }
  }
}

function releaseIncomingReservation(token: string, entry: Incoming | undefined, reason: string, log = true): boolean {
  if (incoming.get(token) !== entry || entry?.receiving) return false;
  if (entry && (entry.failed || entry.revoked)) removeReceived(entry);
  incoming.delete(token); finishIncomingTearout(token);
  if (log) console.warn("[tearout] incoming reservation released", { token, reason });
  if (!incoming.size && !incomingTearoutTokens().length && incomingCheckTimer !== null) {
    window.clearTimeout(incomingCheckTimer); incomingCheckTimer = null;
  }
  return true;
}
function queueIncomingCheck(delay = 10_000): void {
  if (!incomingChecksEnabled || incomingCheckTimer !== null || !incoming.size && !incomingTearoutTokens().length) return;
  const epoch = incomingCheckEpoch;
  incomingCheckTimer = window.setTimeout(() => {
    incomingCheckTimer = null;
    void clearAbandonedIncoming("watchdog").finally(() => { if (epoch === incomingCheckEpoch) queueIncomingCheck(5_000); });
  }, delay);
}
function retainIncoming(entry: Incoming, reason: string): void {
  if (entry.notices.has(reason)) return;
  entry.notices.add(reason);
  console.warn("[tearout] incoming reservation retained", { token: entry.delivery.token, reason, receiving: entry.receiving });
}
async function clearAbandonedIncoming(trigger: "settled" | "registry" | "watchdog" | "revoke_failed" = "registry"): Promise<void> {
  const tokens = new Set([...incomingTearoutTokens(), ...incoming.keys()]);
  for (const token of tokens) if (!incoming.has(token)) releaseIncomingReservation(token, undefined, "missing_incoming_entry");
  if (!incoming.size) return;
  try {
    const windows = await getAllWindows();
    let backendClear: boolean | undefined;
    for (const token of tokens) {
      const entry = incoming.get(token);
      if (!entry) continue;
      const senderGone = !windows.some(view => view.label === entry.delivery.source);
      if (entry.receiving) {
        if (trigger === "watchdog" || trigger === "revoke_failed" || senderGone) retainIncoming(entry, "receive_not_settled");
        continue;
      }
      if (entry.finalized) { releaseIncomingReservation(token, entry, "finalized", false); continue; }
      if (senderGone || (trigger === "watchdog" || trigger === "revoke_failed") && (entry.failed || entry.revoked)) {
        releaseIncomingReservation(token, entry, senderGone ? "sender_gone_settled" : "failed_or_revoked_settled");
      } else if (trigger === "watchdog" && !entry.failed && !entry.revoked) {
        if (backendClear === undefined) {
          const id = crypto.randomUUID();
          const proof = await invoke<unknown>("tearout_transfer_refusal", { id });
          if (proof !== null && !isPreOwnershipTearoutRefusal(proof, windowLabel(), id)) {
            retainIncoming(entry, "backend_proof_unverifiable"); continue;
          }
          backendClear = proof === null;
        }
        if (backendClear) releaseIncomingReservation(token, entry, "backend_reservation_absent");
        else retainIncoming(entry, "backend_reservation_active");
      }
    }
  } catch (error) { console.warn("[tearout] abandoned transfer check failed", error); }
}

async function revoke(label: string, token: string): Promise<void> {
  const ack = crypto.randomUUID();
  const receipt = new Promise<Receipt>((resolve) => receipts.set(ack, resolve));
  try {
    await timeout(invoke("tearout_revoke_attachments", { token }), 5000, "tearout_revoke_authority_timeout");
    await emitTo(label, REVOKE, { token, ack, source: windowLabel() });
    const result = await timeout(receipt, 6000, "tearout_revoke_timeout");
    if (!result.ok) throw new Error("tearout_revoke_failed");
  } finally { receipts.delete(ack); }
}

async function receiveRevoke(request: { token: string; ack: string; source: string }): Promise<void> {
  revokedTokens.add(request.token);
  window.setTimeout(() => revokedTokens.delete(request.token), 30000);
  try {
    await timeout(invoke("tearout_revoke_attachments", { token: request.token }), 5000, "tearout_revoke_authority_timeout");
    const entry = incoming.get(request.token);
    if (entry && !entry.revoked) {
      entry.revoked = true;
      entry.cancel();
      removeReceived(entry);
      await timeout(entry.settled, 5500, "tearout_revoke_attachment_timeout");
      for (const sessionId of sessions(entry.delivery.configs)) evictTerminalCache(sessionId);
      await adapter!.publish();
    }
    const finished = incoming.get(request.token);
    if (!releaseIncomingReservation(request.token, finished, "revoked", false)) throw new Error("tearout_revoke_attachment_timeout");
    await emitTo(request.source, RECEIPT, { token: request.ack, ok: true });
  } catch (error) {
    await emitTo(request.source, RECEIPT, { token: request.ack, ok: false, error: "tearout_revoke_failed" });
    console.warn("[tearout] revoke failed", error);
    void clearAbandonedIncoming("revoke_failed"); queueIncomingCheck();
  }
}

async function send(label: string, configs: WorkspaceConfig[], placement?: DetachedReturnTarget, approval?: Approval,
  token: string = crypto.randomUUID(), activeSessionId?: string | null, liveSessions?: string[],
  dock?: { requester: string; details: DockDiagnostics }): Promise<string> {
  const receipt = new Promise<Receipt>((resolve) => receipts.set(token, resolve));
  try {
    await emitTo(label, DELIVERY, { token, source: windowLabel(), configs, placement, approval, activeSessionId, liveSessions,
      ...(dock ? { dock: { requester: dock.requester } } : {}) });
    if (dock) {
      dockStage(token, dock.details, "child", "delivery_sent", [dock.requester]);
      dockStage(token, dock.details, "child", "receipt_wait", [dock.requester]);
    }
    const result = await timeout(receipt, 6000, "tearout_receipt_timeout");
    if (dock) {
      mergeDockDiagnostics(dock.details, result); updateDockTrace(token, result);
      dockStage(token, dock.details, "child", "receipt", [dock.requester]);
    }
    if (!result.ok) {
      const error = new TransferFailure(result.reason ?? result.error ?? "tearout_receive_failed", result.failedSessions);
      annotateFailure(error, result); throw error;
    }
    return token;
  } catch (error) {
    const details = dock?.details ?? {};
    mergeDockDiagnostics(details, diagnosticsOf(error));
    details.failure_checkpoint = failureCheckpoint(error, details.failure_checkpoint);
    if (!retiredDeliveries.has(token)) {
      try { await revoke(label, token); }
      catch (revokeError) { details.revoke_reason = reasonOf(revokeError); }
    }
    updateDockTrace(token, details);
    throw diagnosedFailure(error, details);
  } finally { receipts.delete(token); retiredDeliveries.delete(token); }
}


/** Readiness is an addressed handshake; an OS label alone is not adoption. */
export async function waitForTearoutReceiver(label: string): Promise<void> {
  await listenersReady;
  const token = crypto.randomUUID();
  const ready = new Promise<Receipt>(resolve => receipts.set(token, resolve));
  const ping = () => { void emitTo(label, "mycmux://tearout-ready-query", { token, source: windowLabel() }).catch(() => {}); };
  const timer = window.setInterval(ping, 100);
  try { ping(); await timeout(ready, 6000, "tearout_child_boot_timeout"); }
  finally { window.clearInterval(timer); receipts.delete(token); }
}
export async function sendTearoutWorkspaces(label: string, configs: WorkspaceConfig[], liveSessions: string[], activeSessionId?: string | null, token = crypto.randomUUID()): Promise<string> {
  return send(label, configs, undefined, undefined, token, activeSessionId, liveSessions);
}
export function visitTearoutLocation(workspaceId: string, sessionId: string | null, label = windowLabel()): void {
  if (label !== windowLabel()) { void WebviewWindow.getByLabel(label).then(view => view?.setFocus()).catch(() => {}); return; }
  const list = useWorkspaceListStore.getState();
  if (list.workspaces.some(workspace => workspace.id === workspaceId)) list.setActiveWorkspace(workspaceId);
  if (sessionId) {
    const workspace = list.getWorkspace(workspaceId);
    const pane = workspace?.panes.find(pane => pane.tabs.some(tab => tab.sessionId === sessionId));
    const tab = pane?.tabs.find(tab => tab.sessionId === sessionId);
    if (!workspace || !pane || !tab) return;
    useWorkspaceLayoutStore.getState().setActivePaneTab(workspace.id, pane.id, tab.id);
    if (useUiStore.getState().zoomedPaneId !== pane.id) useUiStore.getState().setZoomedPaneId(null);
    focusController.request("drag", { sessionId, focus: true });
  }
}

async function requestDock(label: string, approval: Approval, record?: TearoutRecord): Promise<LocalTearoutRefusal | void> {
  const token = crypto.randomUUID();
  const deliveryToken = crypto.randomUUID();
  const receipt = new Promise<Receipt>((resolve) => receipts.set(token, resolve));
  record?.attempted(approval.target, approval.receiver); record?.decision("approved", approval.target);
  const trace: DockTrace = { source: label, receiver: approval.receiver, details: {}, record };
  dockTraces.set(deliveryToken, trace);
  let preOwnershipRefused = false;
  try {
    await emitTo(label, OUTGOING, { token, deliveryToken, requester: windowLabel(), approval,
      record: label === windowLabel() ? record?.forRetire(approval.target, approval.receiver) : undefined });
    // Allow the child's bounded delivery, revocation and reattachment to finish.
    const result = await timeout(receipt, 20000, "tearout_dock_timeout");
    updateDockTrace(deliveryToken, result);
    if (result.ok === false && result.token === token && result.refusal?.kind === "reservation"
      && result.refusal.pre_ownership === true && result.refusal.source === label && result.refusal.deliveryToken === deliveryToken) {
      // A correlated refusal created no transfer to revoke or roll back. Release
      // cleanup still has to succeed; its failure remains a genuine error.
      preOwnershipRefused = true;
      if (approval.release_id) await invoke("tearout_release_cancel", { id: approval.release_id }).catch(error => {
        trace.details.release_cancel_reason = reasonOf(error); throw diagnosedFailure(error, trace.details);
      });
      return new LocalTearoutRefusal("moving", "reservation", result.refusal.refusalSource ?? "incoming", result.refusal.blockerId ?? null);
    }
    if (!result.ok) {
      const error = new TransferFailure(result.reason ?? result.error ?? "tearout_dock_failed", result.failedSessions, result.restore_unconfirmed === true);
      annotateFailure(error, trace.details); throw error;
    }
    // Keep receiver undo until this live parent has the successful dock receipt.
    // Cleanup failure must not roll back an already acknowledged transfer.
    void invoke("tearout_finalize", { id: deliveryToken, token: deliveryToken })
      .then(() => invoke("tearout_forget", { id: deliveryToken }))
      .catch((error) => console.warn("[tearout] finalize failed", error));
  } catch (error) {
    if (preOwnershipRefused) throw error;
    // A release cleanup error must not skip revocation or transfer rollback.
    let releaseError: unknown;
    if (approval.release_id) {
      try { await invoke("tearout_release_cancel", { id: approval.release_id }); }
      catch (error) { releaseError = error; }
    }
    // Revoke even a late delivery before retiring the child or restoring the source.
    try { await revoke(approval.receiver, deliveryToken); }
    catch (revokeError) {
      if (reasonOf(revokeError) !== "tearout_transfer_missing") trace.details.revoke_reason ??= reasonOf(revokeError);
    }
    try { await invoke("tearout_phase", { id: deliveryToken, phase: "rolled_back" }); }
    catch (phaseError) {
      const code = phaseError instanceof Error ? phaseError.message : String(phaseError);
      if (code !== "tearout_transfer_missing") trace.details.recovery_reason ??= code;
    }
    try { await invoke("tearout_forget", { id: deliveryToken }); }
    catch (forgetError) { trace.details.recovery_reason ??= reasonOf(forgetError); }
    if (releaseError) trace.details.release_cancel_reason = reasonOf(releaseError);
    trace.details.failure_checkpoint = failureCheckpoint(error, trace.details.failure_checkpoint);
    updateDockTrace(deliveryToken, trace.details);
    throw diagnosedFailure(error, trace.details);
  } finally { receipts.delete(token); dockTraces.delete(deliveryToken); }
}

async function refuseOutgoingDock(request: DockRequest, refusal = new LocalTearoutRefusal("moving", "reservation", "incoming",
  incoming.keys().next().value ?? null)): Promise<void> {
  const record = new TearoutRecord(request.deliveryToken, "pending-transfer", windowLabel(), Date.now());
  await recordTearoutRefusal(record, refusal);
  await emitTo(request.requester, RECEIPT, { token: request.token, ok: false, error: "tearout_move_busy",
    refusal: { kind: "reservation", pre_ownership: true, source: windowLabel(), deliveryToken: request.deliveryToken,
      refusalSource: refusal.source, blockerId: refusal.blockerId } });
}

async function dockOutgoing(request: DockRequest): Promise<void> {
  // An outgoing event must obey the same provisional-owner gate as pointer
  // entry. The operation's own moving phase is valid here; incoming is not.
  if (incoming.size) {
    await refuseOutgoingDock(request);
    return;
  }
  const before = useWorkspaceListStore.getState().workspaces;
  const selection = { workspace: useWorkspaceListStore.getState().activeWorkspaceId,
    session: useUiStore.getState().activePaneId, zoom: useUiStore.getState().zoomedPaneId };
  let configs: WorkspaceConfig[] = [];
  let liveSessions: string[] = [];
  const id = request.deliveryToken;
  const phaseOwner = request.record?.drag_id ?? id;
  spareRefill?.activity();
  const ownsOperation = beginTearoutOperation(phaseOwner);
  setTearoutDisplayActivity(`outgoing:${id}`, true);
  const previousTrace = dockTraces.get(id);
  const details = previousTrace?.details ?? {};
  if (!previousTrace) dockTraces.set(id, { source: windowLabel(), receiver: request.approval.receiver, details });
  const stage = (name: DockStage["stage"]) => dockStage(id, details, "child", name, [request.requester]);
  let prepared = false;
  let preOwnershipRefused = false;
  let removed = false;
  let delivered: string | undefined;
  let recoveryError: unknown;
  try {
    stage("prepare_wait");
    configs = before.map(workspace => adapter!.serialize(workspace));
    liveSessions = await liveTransferSessions(configs);
    details.transferred_session_ids = sessions(configs);
    if (request.approval.target.kind === "handoff") throw new Error("tearout_handoff_is_not_docking");
    if (configs.length !== 1 || !nativeDropAllowed(configs[0].panes.length, request.approval.target)) throw new Error("tearout_dock_shape_unsupported");
    const refused = await invoke("tearout_prepare", { id, receiver: request.approval.receiver, configs,
      deliveryToken: id, finalizer: request.requester });
    if (isPreOwnershipTearoutRefusal(refused, windowLabel(), id)) {
      preOwnershipRefused = true;
      // Finish the existing cleanup before acknowledging a successful refusal.
      await invoke("tearout_forget", { id });
      await refuseOutgoingDock(request, new LocalTearoutRefusal("moving", "reservation", "backend_transfer", refused.owner_id));
      return;
    }
    if (refused != null) throw new Error("tearout_prepare_result_invalid");
    prepared = true;
    stage("prepared");
    await invoke("tearout_phase", { id, phase: "shown" });
    stage("phase_shown");
    await invoke("tearout_phase", { id, phase: "committed" });
    stage("phase_committed");
    removed = true;
    flushSync(() => {
      useWorkspaceListStore.getState()._replaceWorkspaces([]);
      useWorkspaceListStore.setState({ activeWorkspaceId: null });
      useUiStore.setState({ activePaneId: null, zoomedPaneId: null });
    });
    for (const sessionId of sessions(configs)) { evictTerminalCache(sessionId); focusController.clearSession(sessionId); }
    stage("publish_wait"); await adapter!.publish(); stage("published");
    const target = request.approval.target;
    const placement: DetachedReturnTarget = target.kind === "tab-index" ? { ...target, kind: "pane" } : target;
    delivered = await send(request.approval.receiver, configs, placement, request.approval, request.deliveryToken, selection.session, liveSessions,
      { requester: request.requester, details });
    await invoke("tearout_phase", { id, phase: "received" });
    await invoke("tearout_phase", { id, phase: "cleaned" });
    const selfRequested = request.requester === windowLabel();
    await invoke("tearout_retire", { label: windowLabel(), receiptLabel: request.requester,
      receiptToken: request.token, transferId: id,
      finalizeLabel: selfRequested ? request.approval.receiver : undefined,
      finalizeToken: selfRequested ? delivered : undefined,
      record: request.record ? { ...request.record, ...activeTearoutRecords.get(request.record.drag_id)?.forRetire(target, request.approval.receiver),
        dock_stages: details.dock_stages ?? [], transferred_session_ids: details.transferred_session_ids ?? [],
        receiver_window: request.approval.receiver } : null });
  } catch (error) {
    mergeDockDiagnostics(details, diagnosticsOf(error));
    details.failure_checkpoint = failureCheckpoint(error, details.failure_checkpoint);
    if (delivered) {
      try { await revoke(request.approval.receiver, delivered); }
      catch (revokeError) { details.revoke_reason = reasonOf(revokeError); details.restore_unconfirmed = true; }
    }
    if (prepared) {
      try { await invoke("tearout_phase", { id, phase: "rolled_back" }); }
      catch (phaseError) { recoveryError = phaseError; }
    }
    if (removed) {
      if (ownsOperation || request.requester === windowLabel()) restoringTearoutOperation();
      const name = before.flatMap(workspace => workspace.panes.flatMap(pane => pane.tabs))
        .map(tab => tab.label || tab.displayName || "\u540d\u524d\u306e\u306a\u3044\u30bf\u30d6").join("\u3001") || "\u30bf\u30d6";
      const location = "\u5207\u308a\u96e2\u3057\u5148\u306e\u7a93";
      const progress = recoveryProgress(name, location);
      rememberTearoutDormantSessions(sessions(configs), liveSessions);
      let attachments: ReturnType<typeof expectTearoutAttachments> | undefined;
      try {
        attachments = expectTearoutAttachments(liveSessions);
        await attachments.prepared;
        flushSync(() => {
          useWorkspaceListStore.getState()._replaceWorkspaces(before);
          useWorkspaceListStore.setState({ activeWorkspaceId: selection.workspace });
          useUiStore.setState({ activePaneId: selection.session, zoomedPaneId: selection.zoom });
        });
        await timeout(attachments.ready, 5000, "tearout_restore_attachment_timeout");
        const alive = await Promise.all(liveSessions.map(isSessionAlive));
        if (!alive.every(Boolean)) throw new TransferFailure("tearout_restore_session_not_alive", liveSessions.filter((_, index) => !alive[index]));
        await adapter!.publish();
        recoveryFinished(name, location, reasonOf(error), undefined, () => visitTearoutLocation(before[0]?.id ?? "", selection.session));
      } catch (restoreError) {
        recoveryError = restoreError;
        const failed = (retryError: unknown): void => recoveryFailed(name, location, reasonOf(retryError), () => {
          if (!beginTearoutOperation(phaseOwner)) { recoveryBusy(); return; }
          void (async () => {
            restoringTearoutOperation();
            const retryProgress = recoveryProgress(name, location);
            let retry: ReturnType<typeof expectTearoutAttachments> | undefined;
            try {
              for (const sessionId of liveSessions) evictTerminalCache(sessionId);
              retry = expectTearoutAttachments(liveSessions);
              await retry.prepared;
              await timeout(retry.ready, 5000, "tearout_restore_attachment_timeout");
              const alive = await Promise.all(liveSessions.map(isSessionAlive));
              if (!alive.every(Boolean)) throw new TransferFailure("tearout_restore_session_not_alive", liveSessions.filter((_, index) => !alive[index]));
              await adapter!.publish();
              recoveryFinished(name, location);
            } catch (error) { failed(error); }
            finally { retry?.dispose(); useToastStore.getState().dismissToast(retryProgress); endTearoutOperation(); }
          })();
        }, () => visitTearoutLocation(before[0]?.id ?? "", selection.session));
        failed(restoreError);
      } finally { attachments?.dispose(); useToastStore.getState().dismissToast(progress); }
    }
    if (recoveryError) { details.recovery_reason = reasonOf(recoveryError); details.restore_unconfirmed = true; }
    updateDockTrace(id, details);
    await emitTo(request.requester, RECEIPT, { token: request.token, ok: false, error: "tearout_dock_failed",
      reason: reasonOf(error), ...details,
      ...(recoveryError ? { failedSessions: recoveryError instanceof TransferFailure ? recoveryError.sessionIds : liveSessions } : {}) });
  } finally {
    setTearoutDisplayActivity(`outgoing:${id}`, false);
    if (ownsOperation) endTearoutOperation();
    if (!previousTrace) dockTraces.delete(id);
    if (!preOwnershipRefused) await invoke("tearout_forget", { id }).catch(error => console.warn("[tearout] forget failed", error));
  }
}

function finalizeIncoming(payload: { token: string; source: string }): void {
  const entry = incoming.get(payload.token);
  if (entry && payload.source === entry.delivery.source) {
    entry.finalized = true;
    if (!releaseIncomingReservation(payload.token, entry, "finalized", false)) {
      void entry.settled.then(() => releaseIncomingReservation(payload.token, entry, "finalized", false));
    }
  }
}

export function installTearoutRuntime(value: Adapter): () => void {
  let live = true, hydrated = value.hydrated === undefined;
  const checkEpoch = ++incomingCheckEpoch;
  if (incomingCheckTimer !== null) window.clearTimeout(incomingCheckTimer);
  incomingCheckTimer = null; incomingChecksEnabled = true; queueIncomingCheck();
  adapter = value;
  configureTearoutInputEvidence(false);
  void invoke<boolean>("tearout_input_evidence_enabled").then(enabled => {
    if (live) configureTearoutInputEvidence(enabled === true);
  }).catch(() => {});
  // The default Any target also hears emitTo for other windows. Transfers and
  // their acknowledgements must stay with the addressed window's store.
  const ownWindow = { target: { kind: "Window" as const, label: windowLabel() } };
  releaseReceiver = new TearoutReleaseReceiver({
    receiver: windowLabel(),
    begin: (id, epoch) => invoke<ReleaseFrame>("tearout_release_begin", { id, epoch }),
    decide: decision => invoke<boolean>("tearout_release_decision", { ...decision }),
    consume: approval => invoke<boolean>("tearout_release_consume", { id: approval.release_id, token: approval.token,
      target: approval.target, layoutRevision: approval.layout_revision }),
    freeze: id => {
      endWorkspaceHover(id);
      releasedIds.add(id); finishTearoutFrames(id);
      if (releasedIds.size > 64) releasedIds.delete(releasedIds.values().next().value!);
      if (pendingSample?.id === id) { cancelSampleFrame?.(); cancelSampleFrame = null; pendingSample = null; }
      // Invalidate even another drag's pending hover paint/clear callbacks.
      preview?.feedback.clear(true); preview = null;
    },
    target: frame => nativeTarget(frame, null), revision: releaseLayoutRevision,
    activity: setTearoutDisplayActivity,
    frame: (target, frame) => {
      if (target && releaseFrameOwner !== null && releaseFrameOwner !== frame.id) throw new Error("tearout_release_receiver_busy");
      if (target) releaseFrameOwner = frame.id;
      if (releaseFrameOwner !== frame.id) return;
      if (target || useDetachedDockStore.getState().active?.label === frame.label) {
        flushSync(() => useDetachedDockStore.setState({ active: target ? { label: frame.label, workspaceId: "", nativeSingleTab: true } : null, target }));
      }
      if (!target) releaseFrameOwner = null;
    },
    isFrameCurrent: (target, frame) => releaseFrameOwner === frame.id && useDetachedDockStore.getState().active?.label === frame.label
      && sameDockTarget(useDetachedDockStore.getState().target, target),
    afterPaint: afterReleasePaint,
  });
  const ownReleaseReceiver = releaseReceiver;
  const handoff = installTearoutHandoff(async (token, target, approval, sender) => {
    if (approval.release_id) return (await ownReleaseReceiver.consume(approval, sender)).ok;
    const approved = approvedDrops.get(token);
    if (!approved || !sameDockTarget(approved, target)) return false;
    approvedDrops.delete(token);
    return true;
  });
  const registered = [
    listen<Delivery>(DELIVERY, ({ payload }) => { void receive(payload); }, ownWindow),
    listen<{ token: string; source: string }>("mycmux://tearout-ready-query", ({ payload }) => {
      void Promise.resolve(value.hydrated).then(() => listenersReady).then(() => {
        if (live) return emitTo(payload.source, RECEIPT, { token: payload.token, ok: true });
      }).catch(() => {});
    }, ownWindow),
    listen<Receipt>(RECEIPT, ({ payload }) => receipts.get(payload.token)?.(payload), ownWindow),
    listen<DockDiagnostics & { token: string; sender: string }>(PROGRESS, ({ payload }) => {
      const trace = dockTraces.get(payload.token);
      if (trace && (payload.sender === trace.source || payload.sender === trace.receiver)) updateDockTrace(payload.token, payload);
    }, ownWindow),
    listen<{ id: string }>("mycmux://tearout-release-finished", ({ payload }) => {
      endWorkspaceHover(payload.id); finishObservedTearoutMove(payload.id); finishAwaitingRelease(payload.id);
    }, ownWindow),
    listen<{ id: string; epoch: number }>("mycmux://tearout-release", ({ payload }) => {
      endWorkspaceHover(payload.id);
      void ownReleaseReceiver.resolve(payload).catch(error => console.warn("[tearout] release cleanup failed", error))
        .finally(() => finishAwaitingRelease(payload.id));
    }, ownWindow),
    listen<NativeSample>("mycmux://tearout-native", ({ payload }) => handleNativeSample(payload), ownWindow),
    listen<DockRequest>(OUTGOING, ({ payload }) => { void dockOutgoing(payload).catch((error) => console.warn("[tearout] dock recovery failed", error)); }, ownWindow),
    listen<{ id: string; at: number; hoverAt: number; receiver: string; active?: boolean; afterRelease?: boolean }>(HIGHLIGHT, ({ payload }) => {
      const record = activeTearoutRecords.get(payload.id);
      if (payload.active === false) record?.clearedHighlight(payload.at, payload.afterRelease);
      else record?.highlighted(payload.at, payload.hoverAt, payload.receiver);
    }, ownWindow),
    listen<{ token: string; ack: string; source: string }>(REVOKE, ({ payload }) => { void receiveRevoke(payload); }, ownWindow),
    listen<{ token: string; source: string }>(FINALIZE, ({ payload }) => finalizeIncoming(payload), ownWindow),
    listen(WINDOW_REGISTRY_CHANGED_EVENT, () => { void clearAbandonedIncoming(); }),
    listen<boolean | { mac: true; enabled: boolean }>(PREFERENCE, ({ payload }) => {
      if (typeof payload === "boolean") {
        if (useSettingsStore.getState().nativePaneTearoutEnabled !== payload)
          applyExternalStoreUpdate(useSettingsStore, { nativePaneTearoutEnabled: payload });
      } else if (isMacTearoutPlatform()) {
        applyExternalStoreUpdate(useSettingsStore, { nativePaneTearoutEnabled: payload.enabled, macNativePaneTearoutEnabled: payload.enabled });
      }
    }),
  ];
  listenersReady = Promise.all([...registered, handoff.ready]).then(() => {});
  const stopPrewarm = isTearoutChild() ? () => {} : installMacTearoutPrewarm(() => tearoutOperationBusy() || incoming.size > 0);
  let preference = nativePaneTearoutEnabled(useSettingsStore.getState().nativePaneTearoutEnabled);
  let refillTimer: number | null = null, refillStarted: number | null = null;
  let refillIdleUntil = 0, refillAttempts = 0, refillEpoch = 0, refillPending = false;
  const refillEligible = () => live && hydrated
    && nativePaneTearoutEnabled(useSettingsStore.getState().nativePaneTearoutEnabled);
  const cancelRefill = () => {
    if (refillTimer !== null) window.clearTimeout(refillTimer);
    refillTimer = null; refillStarted = null; refillAttempts = 0; refillPending = false; refillEpoch++;
  };
  const giveUpRefill = (reason: unknown) => {
    console.warn("[tearout] refill abandoned", reason);
    cancelRefill();
  };
  const armRefill = (delay: number) => {
    if (refillTimer !== null) window.clearTimeout(refillTimer);
    if (refillStarted === null || refillPending) return;
    const remaining = refillStarted + SPARE_REFILL_LIMIT_MS - Date.now();
    refillTimer = window.setTimeout(runRefill, Math.max(0, Math.min(delay, remaining)));
  };
  const runRefill = () => {
    refillTimer = null;
    if (refillStarted === null || !refillEligible()) { cancelRefill(); return; }
    if (Date.now() >= refillStarted + SPARE_REFILL_LIMIT_MS || refillAttempts >= SPARE_REFILL_MAX_ATTEMPTS) {
      giveUpRefill("tearout_warm_deferred: idle deadline or attempt limit"); return;
    }
    if (Date.now() < refillIdleUntil) { armRefill(refillIdleUntil - Date.now()); return; }
    const epoch = refillEpoch;
    refillAttempts++; refillPending = true;
    void invoke("tearout_warm", { idleOnly: true }).then(() => {
      if (epoch === refillEpoch) cancelRefill();
    }).catch(error => {
      if (epoch !== refillEpoch) return;
      refillPending = false;
      if (!refillEligible()) { cancelRefill(); return; }
      if (reasonOf(error) !== "tearout_warm_deferred" || refillAttempts >= SPARE_REFILL_MAX_ATTEMPTS
        || Date.now() >= refillStarted! + SPARE_REFILL_LIMIT_MS) { giveUpRefill(error); return; }
      armRefill(Math.max(1000, refillIdleUntil - Date.now()));
    });
  };
  const ownRefill = {
    request: () => {
      if (!refillEligible()) return;
      refillStarted ??= Date.now();
      refillIdleUntil = Date.now() + TEAROUT_SPARE_IDLE_MS;
      armRefill(TEAROUT_SPARE_IDLE_MS);
    },
    activity: () => {
      if (refillStarted === null) return;
      refillIdleUntil = Date.now() + TEAROUT_SPARE_IDLE_MS;
      armRefill(TEAROUT_SPARE_IDLE_MS);
    },
  };
  spareRefill = ownRefill;
  const stopRefillActivity = subscribeTearoutOperationStart(ownRefill.activity);
  window.addEventListener("pagehide", cancelRefill);
  window.addEventListener("beforeunload", cancelRefill);
  const warm = () => {
    if (!hydrated) return;
    if (nativePaneTearoutEnabled(preference) && !isMainWindow()) return;
    void invoke(nativePaneTearoutEnabled(preference) ? "tearout_warm" : "tearout_release_spare")
      .catch((error) => console.warn("[tearout] spare maintenance failed", error));
  };
  if (nativePaneTearoutEnabled(preference)) warm();
  void value.hydrated?.then(() => {
    if (!live) return;
    hydrated = true;
    if (nativePaneTearoutEnabled(preference)) warm();
  });
  const stop = useSettingsStore.subscribe((state) => {
    const enabled = nativePaneTearoutEnabled(state.nativePaneTearoutEnabled);
    if (enabled === preference) return;
    preference = enabled;
    if (!enabled) cancelRefill();
    void emit(PREFERENCE, isMacTearoutPlatform() ? { mac: true, enabled: preference } : preference).catch((error) => console.warn("[tearout] preference failed", error));
    warm();
  });
  const stopWorkspace = useWorkspaceListStore.subscribe((state, previous) => {
    if (state.activeWorkspaceId === previous.activeWorkspaceId) return;
    // A -> B -> A is still a new view: old final approvals must not revive.
    workspaceViewRevision++;
    nativeWorkspaceHover.clear();
    preview?.feedback.clear(); preview = null; approvedDrops.clear();
  });
  return () => {
    live = false; configureTearoutInputEvidence(false);
    cancelRefill();
    stopRefillActivity();
    if (spareRefill === ownRefill) spareRefill = null;
    window.removeEventListener("pagehide", cancelRefill);
    window.removeEventListener("beforeunload", cancelRefill);
    if (checkEpoch === incomingCheckEpoch) {
      incomingChecksEnabled = false; incomingCheckEpoch++;
      if (incomingCheckTimer !== null) window.clearTimeout(incomingCheckTimer);
      incomingCheckTimer = null;
    }
    clearObservedTearoutMoves();
    ownReleaseReceiver.dispose(); releaseReceiver = null; releasedIds.clear(); nativeModes.clear();
    releaseFrameOwner = null;
    for (const id of awaitingRelease.keys()) finishAwaitingRelease(id);
    for (const [token, entry] of incoming) {
      entry.revoked = true; entry.cancel();
      if (!entry.receiving) releaseIncomingReservation(token, entry, "runtime_disposed", false);
      else void entry.settled.then(() => releaseIncomingReservation(token, entry, "runtime_disposed", false));
    }
    for (const token of dockTraces.keys()) setTearoutDisplayActivity(`outgoing:${token}`, false);
    dockTraces.clear(); endTearoutOperation();
    stop(); stopWorkspace(); stopPrewarm(); handoff.dispose();
    nativeWorkspaceHover.clear(); workspaceHoverSample = null; hoverEndedIds.clear();
    disposeTearoutFrames();
    cancelSampleFrame?.();
    cancelSampleFrame = null; pendingSample = null;
    preview?.feedback.clear();
    preview = null;
    for (const result of registered) void result.then((unlisten) => unlisten()).catch(() => {});
  };
}

export async function markTearoutChildReady(): Promise<void> {
  const restored = isRestoredWindow();
  // Clear before the first await: App's pending paint must use the original
  // shell kind as soon as its startup mask is removed.
  if (restored) delete (window as RestoredWindow).__MYCMUX_RESTORED_WINDOW__;
  try {
    await listenersReady;
    if (restored && /^Win/i.test(navigator.platform) && window.__MYCMUX_TEAROUT_WINDOW__ === true) {
      // The backend reveals a saved native child directly in its saved state.
      await invoke("tearout_child_ready");
    } else {
      if (restored) await invoke("plugin:window|show");
      await invoke("tearout_child_ready");
    }
  } catch (error) {
    if (restored) (window as RestoredWindow).__MYCMUX_RESTORED_WINDOW__ = true;
    throw error;
  }
}

export function canRegrabTearoutTab(item: Extract<PaneDragItem, { kind: "tab" }>): boolean {
  if (!isTearoutChild()) return false;
  const tabs = useWorkspaceListStore.getState().workspaces.flatMap((workspace) => workspace.panes.flatMap((pane) => pane.tabs));
  return tabs.length === 1 && tabs[0].id === item.tabId;
}

export function canRegrabTearoutPane(item: Extract<PaneDragItem, { kind: "pane" }>): boolean {
  const workspaces = useWorkspaceListStore.getState().workspaces;
  return isTearoutChild() && workspaces.length === 1 && workspaces[0].id === item.workspaceId
    && workspaces[0].panes.length === 1 && workspaces[0].panes[0].id === item.paneId;
}

interface NativeStartRefusal {
  kind: "rejected_busy"; pre_ownership: true; phase: "moving";
  owner_id: string; source: string; label: string;
  refusal_source?: "backend_pre_ownership" | "backend_release" | "backend_transfer";
}
export function isPreOwnershipTearoutRefusal(value: unknown, label: string, id: string): value is NativeStartRefusal {
  if (!value || typeof value !== "object") return false;
  const proof = value as Partial<NativeStartRefusal>;
  return proof.kind === "rejected_busy" && proof.pre_ownership === true && proof.phase === "moving"
    && proof.label === label && typeof proof.owner_id === "string" && !!proof.owner_id && proof.owner_id !== id
    && typeof proof.source === "string" && !!proof.source;
}

/** Backend proof is authenticated to this WebView and precedes any ownership. */
export async function checkTearoutTransferReservation(id: string): Promise<LocalTearoutRefusal | null> {
  const proof = await invoke<unknown>("tearout_transfer_refusal", { id });
  if (isPreOwnershipTearoutRefusal(proof, windowLabel(), id)) return new LocalTearoutRefusal("moving", "reservation", "backend_transfer", proof.owner_id);
  if (proof != null) throw new Error("tearout_start_result_invalid");
  return null;
}

/** A complete native child moves itself; it never consumes another spare. */
export async function regrabTearoutWindow(record?: TearoutRecord, onEnd?: (sample: NativeSample) => void): Promise<void> {
  const mode: TearoutMode = "dock";
  const label = windowLabel();
  const workspaces = useWorkspaceListStore.getState().workspaces;
  if (workspaces.length !== 1) throw new Error("tearout_regrab_shape_unsupported");
  const panes = workspaces[0].panes;
  const paneCount = panes.reduce((count, pane) => count + pane.tabs.length, 0);
  const grabbedKind = panes.length > 1 ? "workspace" : paneCount > 1 ? "tab" : "pane";
  record ??= new TearoutRecord(crypto.randomUUID(), panes[0]?.tabs[0]?.id ?? "missing", label, Date.now(), grabbedKind, paneCount);
  record.transport(grabbedKind, paneCount);
  record.identity(useWorkspaceListStore.getState().workspaces.some((ws) => ws.panes.some((pane) => pane.tabs.some((tab) => tab.sessionId.startsWith("pty-")))) ? true : null);
  const refusal = localTearoutRefusal();
  if (refusal) return rejectTearoutStart(record, refusal);
  beginTearoutOperation(record.id);
  const id = record.id;
  activeTearoutRecords.set(id, record);
  let ended = false;
  let stop = () => {};
  let stage = "preparing";
  let clearHandoff = async () => {};
  let handoffCleanup: Promise<void> | null = null;
  const clearContext = () => handoffCleanup ??= clearHandoff().catch(error => console.warn("[tearout] handoff cleanup failed", error));
  const capturedHandoffSource = panes.length === 1 && panes[0].tabs.length === 1
    ? capturePaneHandoffSource({ kind: "tab", workspaceId: workspaces[0].id, paneId: panes[0].id,
      tabId: panes[0].tabs[0].id, label: workspaces[0].name }) : null;
  // A fresh child already received these identities with its real sessions.
  // Before its first metadata event, use that receipt's tab fields. Once live
  // metadata exists (including cleared agent fields), it remains authoritative.
  const receivedTab = panes[0]?.tabs[0];
  const handoffSource = capturedHandoffSource && !capturedHandoffSource.metadata
    ? { ...capturedHandoffSource, metadata: { agentKind: receivedTab?.agentKind,
      agentSessionId: receivedTab?.agentSessionId, cwd: receivedTab?.cwd } }
    : capturedHandoffSource;
  const canHandoff = handoffSource?.metadata?.agentKind && handoffSource.metadata.agentKind !== "grok"
    && handoffSource.metadata.agentSessionId && handoffSource.metadata.cwd;
  try {
    const pending = await checkTearoutTransferReservation(id);
    if (pending) {
      activeTearoutRecords.delete(id); endTearoutOperation();
      return rejectTearoutStart(record, pending);
    }
    stop = await listen<NativeSample>("mycmux://tearout-native", ({ payload }) => {
    if (payload.id !== id || payload.phase !== "end" || ended) return;
    ended = true;
    onEnd?.(payload);
    record!.native(payload);
    void (async () => {
      stage = "resolving_release";
      if (payload.mode !== mode) throw new Error("tearout_move_mode_changed");
      if (payload.error) { record!.error("native_move_failed"); throw new Error(payload.error); }
      const approval = await finalReleaseApproval(payload);
      record!.decision(releaseDecision(payload, approval), approval?.target);
      if (approval) record!.attempted(approval.target, approval.receiver);
      stage = approval ? "docking" : "settling";
      if (!payload.escaped && approval?.target.kind === "handoff") {
        stage = "handoff";
        if (!canHandoff) throw new Error("tearout_handoff_source_invalid");
        let handedOff = false;
        let handoffError: unknown;
        try { handedOff = await requestTearoutHandoff(id, { ...approval, target: approval.target }); }
        catch (error) {
          handoffError = error;
          record!.failure(reasonOf(error), stage);
          useToastStore.getState().pushToast(onlineStrings.dragDropErrorPrefix + reasonOf(error), "error");
        } finally {
          if (approval.release_id) await invoke("tearout_release_cancel", { id: approval.release_id }).catch(error => {
            throw diagnosedFailure(error, { release_cancel_reason: reasonOf(error) });
          });
        }
        if (!handedOff && !handoffError) record!.failure("tearout_handoff_failed", stage);
        // Handoff sends a savepoint; the child keeps its workspace and sessions.
        await invoke("tearout_restore_geometry", { label, geometry: payload.original });
        await record!.finish(handedOff ? "handed_off" : "handoff_failed", approval.target);
      }
      else if (!payload.escaped && approval) {
        const refusal = await requestDock(label, approval, record);
        if (refusal) {
          await invoke("tearout_restore_geometry", { label, geometry: payload.original });
          await recordTearoutRefusal(record!, refusal);
        }
      }
      else {
        if (payload.escaped) await invoke("tearout_restore_geometry", { label, geometry: payload.original });
        else await invoke("tearout_settle", { label });
        await record!.finish(payload.escaped ? "esc_cancelled" : "kept_window");
      }
    })().catch(async (error) => {
      record!.error("dock_failed");
      const details = diagnosticsOf(error);
      record!.diagnostics({ ...details, ...(stage === "docking" ? { failure_checkpoint: failureCheckpoint(error, details.failure_checkpoint) } : {}) });
      const reason = reasonOf(error);
      const decision = stage === "resolving_release" ? releaseFailureDecision(error) : null;
      if (decision) record!.decision(decision);
      const name = workspaces[0].name;
      const location = "\u5207\u308a\u96e2\u3057\u5148\u306e\u7a93";
      const visit = () => visitTearoutLocation(workspaces[0].id, useUiStore.getState().activePaneId);
      const restoreGeometry = () => invoke("tearout_restore_geometry", { label, geometry: payload.original });
      const failedRestore = (restoreError: unknown): void => recoveryFailed(name, location, reasonOf(restoreError), () => {
        if (!beginTearoutOperation(id)) { recoveryBusy(); return; }
        restoringTearoutOperation();
        const progress = recoveryProgress(name, location);
        void restoreGeometry().then(() => recoveryFinished(name, location)).catch(failedRestore)
          .finally(() => { useToastStore.getState().dismissToast(progress); endTearoutOperation(); });
      }, visit);
      restoringTearoutOperation();
      try { await restoreGeometry(); }
      catch (restoreError) {
        record!.error("rollback_failed"); record!.failure(reason, "restoring", [], stage);
        record!.diagnostics({ recovery_reason: reasonOf(restoreError), restore_unconfirmed: true });
        failedRestore(restoreError);
        await record!.finish("restore_failed").catch(logError => console.warn("[tearout] log failed", logError));
        return;
      }
      const unconfirmed = error instanceof TransferFailure && error.recoveryFailed;
      record!.failure(reasonOf(error), unconfirmed ? "restoring" : stage, unconfirmed && error instanceof TransferFailure ? error.sessionIds : [], unconfirmed ? stage : undefined);
      if (!unconfirmed) recoveryFinished(name, location, reasonOf(error), undefined, visit);
      await record!.finish(unconfirmed ? "restore_failed" : "failed_restored", null, unconfirmed ? false : undefined)
        .catch(logError => console.warn("[tearout] log failed", logError));
    }).finally(async () => {
      try { await clearContext(); }
      finally { stop(); activeTearoutRecords.delete(id); finishObservedTearoutMove(id); endTearoutOperation(); }
    });
  }, { target: { kind: "Window", label: windowLabel() } });
    await listenersReady;
    if (canHandoff) clearHandoff = await publishTearoutHandoffDrag({ id, mode, label, sourceWindow: label, endpoint: handoffSource });
    stage = "moving";
    const refused = await invoke<unknown>("tearout_start_move", { label, id, mode, regionCount: panes.length, regrab: true });
    if (isPreOwnershipTearoutRefusal(refused, label, id)) {
      await clearContext();
      stop(); activeTearoutRecords.delete(id); endTearoutOperation();
      // No native/store ownership was acquired. Returning the refusal promise
      // keeps it outside the genuine native-start recovery catch below.
      // Native start can refuse either an overlapping pointer or a reservation
      // acquired after preflight. A read-only proof selects the latter's notice;
      // a failed notice lookup must not turn an authentic refusal into a failure.
      const pending = await checkTearoutTransferReservation(id).catch(error => {
        console.warn("[tearout] reservation notice check failed", error); return null;
      });
      return rejectTearoutStart(record, new LocalTearoutRefusal("moving", pending?.reason ?? "overlap",
        refused.refusal_source ?? "backend_pre_ownership", refused.owner_id));
    }
    if (refused != null) throw new Error("tearout_start_result_invalid");
  }
  catch (error) {
    await clearContext();
    stop(); activeTearoutRecords.delete(id); finishObservedTearoutMove(id); endTearoutOperation(); record.error("native_move_failed");
    record.failure(reasonOf(error), stage);
    try { await invoke("tearout_settle", { label }); }
    finally { await record.finish("failed_restored"); }
    recoveryFinished(panes.flatMap(pane => pane.tabs).map(tab => tab.label || tab.displayName || "\u540d\u524d\u306e\u306a\u3044\u30bf\u30d6").join("\u3001"),
      "\u5207\u308a\u96e2\u3057\u5148\u306e\u7a93", reasonOf(error), undefined,
      () => visitTearoutLocation(workspaces[0].id, useUiStore.getState().activePaneId));
    throw error;
  }
}

async function takeSpare(): Promise<string> {
  const ready = await invoke<string | null>("tearout_take_spare");
  if (ready) return ready;
  await invoke("tearout_warm");
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const label = await invoke<string | null>("tearout_take_spare");
    if (label) return label;
    await new Promise<void>((resolve) => window.setTimeout(resolve, 16));
  }
  throw new Error("tearout_spare_not_ready");
}

type TransferItem = Extract<PaneDragItem, { kind: "tab" | "pane" }>
  | { kind: "workspace"; workspaceId: string; label: string };
export function tearoutTab(item: Extract<PaneDragItem, { kind: "tab" }>, gap: Rect, offset: { x: number; y: number }, record?: TearoutRecord): Promise<void> {
  return tearoutGroup(item, gap, offset, record);
}
export function tearoutPane(item: Extract<PaneDragItem, { kind: "pane" }>, gap: Rect, offset: { x: number; y: number }, record?: TearoutRecord): Promise<void> {
  return tearoutGroup(item, gap, offset, record);
}
export function tearoutWorkspace(workspaceId: string, gap: Rect, offset: { x: number; y: number }, record?: TearoutRecord): Promise<void> {
  const source = useWorkspaceListStore.getState().getWorkspace(workspaceId);
  return tearoutGroup({ kind: "workspace", workspaceId, label: source?.name ?? "" }, gap, offset, record);
}

async function tearoutGroup(item: TransferItem, gap: Rect, offset: { x: number; y: number }, record?: TearoutRecord): Promise<void> {
  const request = createPaneMoveRequest(item, { kind: "native-window", gap, offset }, undefined, record?.id);
  const result = await executePaneMove(request, { record });
  if (result.error !== undefined) throw result.error;
  if (result.status === "refused") throw new Error(`tearout_${result.reason === "not_transferable" ? "source_unsupported" : result.reason}`);
}

/** Native transport; ownership checks and result shape belong to the executor. */
export async function performNativePaneMove(
  request: PaneMoveRequest<NativeMoveDestination>, execution: PaneMoveExecution, options: PaneMoveOptions,
): Promise<PaneMoveResult> {
  const mode: TearoutMode = "detach";
  const item = request.source;
  if (item.kind === "tab-bundle") return execution.result("refused", "invalid_destination");
  const { gap, offset } = request.destination;
  let record = options.record;
  if (!adapter) throw new Error("tearout_runtime_not_ready");
  const refusal = localTearoutRefusal();
  if (refusal) {
    record ??= new TearoutRecord(request.operationId, item.kind === "tab" ? item.tabId : item.workspaceId, windowLabel(), Date.now());
    return rejectTearoutStart(record, refusal);
  }
  const source = useWorkspaceListStore.getState().getWorkspace(item.workspaceId);
  const sourceIndex = useWorkspaceListStore.getState().workspaces.findIndex((workspace) => workspace.id === item.workspaceId);
  const pane = item.kind === "workspace" ? source?.panes[0] : source?.panes.find(pane => pane.id === item.paneId);
  const tab = item.kind === "tab" ? pane?.tabs.find(tab => tab.id === item.tabId) : null;
  if (!source || !pane || item.kind === "tab" && !tab) throw new Error("tearout_source_missing");
  const movedPanes = item.kind === "workspace" ? source.panes : [pane];
  const movedTabs = item.kind === "tab" ? [tab!] : movedPanes.flatMap(pane => pane.tabs);
  if (!movedTabs.length || movedTabs.some(tab => !isTransferableTab(tab))) throw new Error("tearout_source_unsupported");
  const sourceSelection = { workspace: useWorkspaceListStore.getState().activeWorkspaceId, session: useUiStore.getState().activePaneId,
    zoom: useUiStore.getState().zoomedPaneId, lastActive: useWorkspaceListStore.getState().lastActivePaneByWorkspace[source.id] };
  const selectedSession = movedTabs.find(tab => tab.sessionId === sourceSelection.session)?.sessionId
    ?? movedTabs.find(tab => tab.sessionId === sourceSelection.lastActive)?.sessionId ?? movedTabs[0].sessionId;
  const transfer = item.kind === "workspace" ? source : item.kind === "pane"
    ? { ...source, id: crypto.randomUUID(), panes: [pane], splitColumns: [[pane.id]],
      columnWidths: [1], rowHeightsPerCol: [[1]], columnDividerPins: [], rowDividerPinsPerCol: [[]] }
    : { ...source, id: crypto.randomUUID(), panes: [{ ...pane, id: crypto.randomUUID(), tabs: [tab!],
      activeTabId: tab!.id, sessionId: tab!.sessionId }], splitColumns: undefined };
  const sourceElement = Array.from(document.querySelectorAll<HTMLElement>("[data-dnd-pane-id]"))
    .find(element => element.dataset.dndPaneId === pane.id && element.dataset.dndWorkspaceId === source.id);
  const logicalExtent = sourceLogicalExtent(item.kind, sourceElement?.getBoundingClientRect() ?? null,
    { width: window.innerWidth, height: window.innerHeight });
  const serialized = adapter.serialize(transfer);
  const origin = item.kind === "tab" ? detachedOriginForDrag(source, item) : undefined;
  const config = item.kind === "tab" ? origin && detachedWorkspaceConfig(serialized, origin)
    : { ...serialized, detached: false, detached_from: null };
  if (!config) throw new Error("tearout_config_invalid");
  record ??= new TearoutRecord(request.operationId, item.kind === "tab" ? item.tabId : item.kind === "pane" ? pane.id : source.id,
    windowLabel(), Date.now(), item.kind === "tab" ? "pane" : item.kind === "pane" ? "tab" : "workspace", movedTabs.length);
  record.transport(item.kind === "tab" ? "pane" : item.kind === "pane" ? "tab" : "workspace", movedTabs.length);
  record.outside(Date.now());
  const id = record.id;
  activeTearoutRecords.set(id, record);
  let result: TearoutResult = "failed_restored";
  let liveSessions: string[] = [];
  let identity: boolean | null = null;
  let failureReason: string | undefined;
  let stage = "preparing";
  const paneNames = (ids?: string[]) => movedTabs.filter(tab => !ids?.length || ids.includes(tab.sessionId))
    .map(tab => tab.label || tab.displayName || "\u540d\u524d\u306e\u306a\u3044\u30bf\u30d6").join("\u3001");
  const name = paneNames() || item.label || "\u30bf\u30d6";
  const location = `\u300c${source.name}\u300d\u306e\u5143\u306e\u8868\u793a\u5834\u6240`;
  let progress: string | undefined;
  let failure: TearoutError = "prepare_failed";
  const deliveryToken = crypto.randomUUID();
  let label: string | undefined;
  let removed = false;
  let prepared = false;
  let refusedBeforeOwnership = false;
  let spareTaken = false;
  let transferFailed = false;
  let cancelled = false;
  let restore: Promise<void> | null = null;
  let retrying = false;
  let ended = false;
  let stopNative = () => {};
  let delivery: Promise<string> | null = null;
  let published: Promise<void> = Promise.resolve();
  const checkCancelled = () => { if (cancelled) throw new Error("tearout_esc_cancelled"); };
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    cancelled = true;
    record!.escaped(Date.now());
    if (label) void invoke("tearout_cancel_move", { id, label }).catch(() => {});
  };
  beginTearoutOperation(id);
  window.addEventListener("keydown", escape, true);
  const rollback = (notify = true): Promise<void> => {
    if (restore) return restore;
    restoringTearoutOperation(); stage = "restoring";
    if (notify) progress ??= recoveryProgress(name, location);
    restore = (async () => {
      // Destroy this new child's webview before the original channel reattaches.
      if (isMacTearoutPlatform()) {
        await Promise.all([
          label ? invoke("tearout_retire", { label }) : Promise.resolve(),
          prepared && !retrying ? invoke("tearout_phase", { id, phase: "rolled_back" }) : Promise.resolve(),
        ]);
      } else {
        if (label) await invoke("tearout_retire", { label });
        if (prepared && !retrying) await invoke("tearout_phase", { id, phase: "rolled_back" });
      }
      if (delivery && !retrying) retiredDeliveries.add(deliveryToken);
      receipts.get(deliveryToken)?.({ token: deliveryToken, ok: false, error: "tearout_cancelled" });
      if (removed) {
        rememberTearoutDormantSessions(sessions([config]), liveSessions);
        const attachment = expectTearoutAttachments(liveSessions);
        try {
          await attachment.prepared;
          if (retrying) for (const sessionId of liveSessions) evictTerminalCache(sessionId);
          flushSync(() => {
            const list = useWorkspaceListStore.getState();
            // Mac's temporary fallback workspace must not gain a remembered
            // selection merely because rollback activates the source again.
            const macRemembered = isMacTearoutPlatform() ? { ...list.lastActivePaneByWorkspace } : null;
            list._replaceWorkspaces(item.kind === "tab" ? restoreTearoutSource(list.workspaces, source, tab!.id, sourceIndex)
              : restoreTearoutGroup(list.workspaces, source, movedPanes.map(pane => pane.id), sourceIndex));
            if (sourceSelection.workspace) list.setActiveWorkspace(sourceSelection.workspace);
            useUiStore.getState().setActivePaneId(sourceSelection.session);
            useUiStore.getState().setZoomedPaneId(sourceSelection.zoom);
            useWorkspaceListStore.setState(state => {
              const lastActivePaneByWorkspace = { ...(macRemembered ?? state.lastActivePaneByWorkspace) };
              if (sourceSelection.lastActive) lastActivePaneByWorkspace[source.id] = sourceSelection.lastActive;
              else delete lastActivePaneByWorkspace[source.id];
              return { lastActivePaneByWorkspace };
            });
          });
          await timeout(attachment.ready, 5000, "tearout_restore_attachment_timeout");
          const alive = await Promise.all(liveSessions.map(isSessionAlive));
          if (!alive.every(Boolean)) throw new TransferFailure("tearout_restore_session_not_alive", liveSessions.filter((_, i) => !alive[i]));
          await adapter!.publish();
        } finally { attachment.dispose(); }
      }
      execution.mark("rolled_back");
    })();
    void restore.then(() => {
      if (progress) useToastStore.getState().dismissToast(progress);
      if (notify) recoveryFinished(name, location, failureReason,
        () => { void tearoutGroup(item, gap, offset).catch(() => {}); }, () => visitTearoutLocation(source.id, selectedSession));
    }, error => {
      if (progress) useToastStore.getState().dismissToast(progress);
      record!.error("rollback_failed"); identity = false; result = "restore_failed";
      record!.failure(reasonOf(error), stage, error instanceof TransferFailure ? error.sessionIds : liveSessions);
      const failedSessionIds = error instanceof TransferFailure ? error.sessionIds : liveSessions;
      const failedSession = movedTabs.find(tab => failedSessionIds.includes(tab.sessionId))?.sessionId ?? selectedSession;
      recoveryFailed(paneNames(failedSessionIds) || name, removed && useWorkspaceListStore.getState().workspaces.some(ws => ws.id === source.id) ? location : "\u5207\u308a\u96e2\u3057\u5148\u306e\u7a93",
        reasonOf(error), () => {
          if (removed && useWorkspaceListStore.getState().workspaces.some(ws => ws.id === source.id)
            && !movedTabs.every(tab => useWorkspaceListStore.getState().workspaces.some(ws => ws.id === source.id && ws.panes.some(pane => pane.tabs.some(now => now.id === tab.id))))) {
            visitTearoutLocation(source.id, failedSession); return;
          }
          if (!beginTearoutOperation(id)) { recoveryBusy(); return; }
          retrying = true; restore = null; progress = undefined;
          void rollback().catch(() => {}).finally(endTearoutOperation);
        },
        () => visitTearoutLocation(source.id, failedSession, useWorkspaceListStore.getState().workspaces.some(ws => ws.id === source.id) ? windowLabel() : label));
    });
    return restore;
  };
  let complete = () => {};
  const finished = new Promise<void>((resolve) => { complete = resolve; });
  const finish = async (payload: NativeSample) => {
    if (ended) return;
    ended = true;
    record!.native(payload);
    try {
      if (payload.mode !== mode) throw new Error("tearout_move_mode_changed");
      if (payload.escaped || cancelled || payload.error) {
        result = (payload.escaped && !transferFailed && !payload.error) || cancelled ? "esc_cancelled" : "failed_restored";
        if (payload.error && !transferFailed) {
          record!.error("native_move_failed"); failureReason = payload.error; record!.failure(payload.error, "moving", liveSessions);
        }
        await rollback();
      }
      else {
        stage = "settling";
        // First release completes the real transfer even over an app receiver.
        // Detach never resolves or promises a dock/handoff target.
        await delivery;
        await published;
        await invoke("tearout_settle", { label });
        await invoke("tearout_finalize", { id, token: deliveryToken });
        result = "kept_window";
      }
    } catch (error) {
      result = "failed_restored";
      if (!transferFailed) { record!.error(failure); failureReason = reasonOf(error); record!.failure(failureReason, stage, liveSessions); }
      await rollback().catch(() => {});
    } finally { complete(); }
  };
  try {
    const pending = await checkTearoutTransferReservation(id);
    if (pending) {
      refusedBeforeOwnership = true;
      return rejectTearoutStart(record, pending);
    }
    liveSessions = await liveTransferSessions([config]);
    identity = liveSessions.length ? true : null;
    label = await takeSpare(); spareTaken = true;
    checkCancelled();
    const refused = await invoke("tearout_prepare", { id, receiver: label, configs: [config], deliveryToken });
    if (isPreOwnershipTearoutRefusal(refused, windowLabel(), id)) {
      // This spare has not been shown, restored or attached to any session.
      await invoke("tearout_retire", { label }); label = undefined;
      refusedBeforeOwnership = true;
      return rejectTearoutStart(record, new LocalTearoutRefusal("moving", "reservation", "backend_transfer", refused.owner_id));
    }
    if (refused != null) throw new Error("tearout_prepare_result_invalid");
    prepared = true;
    checkCancelled();
    stopNative = await listen<NativeSample>("mycmux://tearout-native", ({ payload }) => {
      if (payload.id !== id || payload.phase !== "end" || ended) return;
      void finish(payload).catch(() => {});
    }, { target: { kind: "Window", label: windowLabel() } });
    failure = "show_failed";
    record.revealed(await invoke<Reveal>("tearout_show", { label, offsetX: offset.x, offsetY: offset.y,
      ...(windowsNativeBand(useSettingsStore.getState().nativePaneTearoutEnabled)
        ? { logicalWidth: logicalExtent.width, logicalHeight: logicalExtent.height } : {}) }));
    await invoke("tearout_phase", { id, phase: "shown" });
    checkCancelled();
    const currentSource = useWorkspaceListStore.getState().getWorkspace(source.id);
    const currentTabs = item.kind === "workspace" ? currentSource?.panes.flatMap(pane => pane.tabs)
      : currentSource?.panes.find(current => current.id === pane.id)?.tabs;
    if (!currentTabs || !movedTabs.every(tab => currentTabs.some(current => current.id === tab.id && current.sessionId === tab.sessionId && current.lifecycle === tab.lifecycle))
      || item.kind !== "tab" && currentTabs.length !== movedTabs.length) throw new Error("tearout_source_changed");
    await invoke("tearout_phase", { id, phase: "committed" });
    execution.assertSource();
    flushSync(() => {
      removed = true;
      const list = useWorkspaceListStore.getState();
      if (item.kind === "tab") {
        const withoutLast = removeTearoutTab(source.id, pane.id, tab!.id, list.workspaces);
        if (withoutLast) {
          list._replaceWorkspaces(withoutLast);
          useWorkspaceListStore.setState({ activeWorkspaceId: withoutLast[0]?.id ?? null });
          useUiStore.getState().setActivePaneId(withoutLast[0]?.panes[0]?.sessionId ?? null);
        } else useWorkspaceLayoutStore.getState().removeTabFromPane(source.id, pane.id, tab!.id);
      } else {
        if (item.kind === "workspace" || source.panes.length === 1) list.removeWorkspace(source.id);
        else useWorkspaceLayoutStore.getState().removePaneFromWorkspace(source.id, pane.id);
        const owned = useWorkspaceListStore.getState();
        const remaining = owned.workspaces.find(workspace => workspace.id === owned.activeWorkspaceId);
        if (movedTabs.some(tab => tab.sessionId === useUiStore.getState().activePaneId)) {
          useUiStore.getState().setActivePaneId(remaining?.panes[0]?.sessionId ?? null);
        }
        if (movedPanes.some(pane => pane.id === useUiStore.getState().zoomedPaneId)) useUiStore.getState().setZoomedPaneId(null);
      }
      useTearoutStore.setState({ gap, gapLabel: item.label });
    });
    execution.mark("committed", label);
    for (const tab of movedTabs) {
      if (!isMacTearoutPlatform()) evictTerminalCache(tab.sessionId);
      focusController.clearSession(tab.sessionId);
    }
    published = adapter.publish();
    delivery = send(label, [config], undefined, undefined, deliveryToken, selectedSession, liveSessions).then(async (token) => {
      if (!restore) {
        await invoke("tearout_phase", { id, phase: "received" });
        execution.mark("received", label);
        await invoke("tearout_phase", { id, phase: "cleaned" });
        execution.mark("cleaned", label);
      }
      return token;
    });
    void delivery.catch(error => {
      if (restore || cancelled) return;
      transferFailed = true; record!.error("receive_failed"); failureReason = reasonOf(error);
      record!.diagnostics(diagnosticsOf(error));
      record!.failure(failureReason, "receiving", error instanceof TransferFailure ? error.sessionIds : liveSessions);
      void invoke("tearout_cancel_move", { id, label }).catch(() => {});
    });
    void published.catch(() => { transferFailed = true; record!.error("prepare_failed"); void invoke("tearout_cancel_move", { id, label }).catch(() => {}); });
    checkCancelled();
    failure = "native_move_failed"; stage = "moving";
    await invoke("tearout_start_move", { label, id, mode, regionCount: transfer.panes.length, offsetX: offset.x, offsetY: offset.y });
    await finished;
  } catch (error) {
    ended = true;
    result = cancelled ? "esc_cancelled" : "failed_restored";
    if (!cancelled) { record.error(failure); failureReason = reasonOf(error); record.failure(failureReason, stage, liveSessions); }
    await rollback().catch(() => {});
    throw error;
  } finally {
    window.removeEventListener("keydown", escape, true);
    stopNative();
    useTearoutStore.setState({ gap: null });
    endTearoutOperation(); finishObservedTearoutMove(id);
    activeTearoutRecords.delete(id);
    // Mac also reuses its parked renderer after a kept window is regrabbed.
    // The normal cache LRU (12) and session-close eviction still bound its life;
    // cached renderers own no workspace and have no mounted input listeners.
    // Windows retains its original eager eviction above.
    // Recovery callbacks update identity; control-flow narrowing cannot see those writes.
    const finalIdentity = identity as boolean | null;
    if (!refusedBeforeOwnership) await record.finish(finalIdentity === false ? "restore_failed" : result, null, finalIdentity).catch((error) => console.warn("[tearout] log failed", error));
    if (prepared) await invoke("tearout_forget", { id });
    if ((!refusedBeforeOwnership || spareTaken) && nativePaneTearoutEnabled(useSettingsStore.getState().nativePaneTearoutEnabled)) {
      spareRefill?.request();
    }
  }
  const outcome = result as TearoutResult;
  return execution.result(outcome === "kept_window" ? "moved" : outcome === "esc_cancelled" ? "returned" : "failed",
    failureReason ?? (outcome === "kept_window" ? undefined : outcome));
}
