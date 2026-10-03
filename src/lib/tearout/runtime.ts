import { invoke } from "@tauri-apps/api/core";
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { flushSync } from "react-dom";
import { create } from "zustand";
import { nativePaneTearoutEnabled, isMacTearoutPlatform } from "./feature";
import { afterTearoutFrame } from "./macFrame";
import { startTearoutFrames, finishTearoutFrames, disposeTearoutFrames } from "./frameMetrics";
import { expectTearoutAttachments } from "./sessionAttachment";
import { installMacTearoutPrewarm } from "./macPrewarm";
import { restoreTearoutSource, restoreTearoutGroup, removeTearoutTab, nativeDropAllowed, type Rect } from "./model";
import { detachedOriginForDrag, detachedWorkspaceConfig, isTransferableTab, type DetachedReturnTarget } from "../detachedPane";
import { restoreWorkspaceConfigs } from "../workspaceRestore";
import { windowLabel, isMainWindow } from "../windowContext";
import { isSessionAlive, type WorkspaceConfig } from "../ipc";
import { useWorkspaceListStore } from "../../stores/workspaceListStore";
import { useWorkspaceLayoutStore } from "../../stores/workspaceLayoutStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useUiStore } from "../../stores/uiStore";
import { evictTerminalCache } from "../../components/terminal/terminalCache";
import { focusController } from "../focusController";
import { detachedDockTarget, useDetachedDockStore, type DockTarget } from "../../stores/detachedDockStore";
import { TearoutPreview, sameDockTarget } from "./preview";
import { TearoutRecord, activeTearoutRecords, type RecordData, type Reveal, type TearoutError, type TearoutResult } from "./record";
import type { PaneDragItem } from "../../stores/paneDragStore";
import type { Workspace } from "../../types";

declare global { interface Window { __MYCMUX_TEAROUT_WINDOW__?: boolean } }
export const isTearoutChild = (): boolean => globalThis.window?.__MYCMUX_TEAROUT_WINDOW__ === true;
export const useTearoutStore = create<{ gap: Rect | null; gapLabel: string }>(() => ({ gap: null, gapLabel: "" }));

const DELIVERY = "mycmux://tearout-delivery";
const RECEIPT = "mycmux://tearout-receipt";
const REVOKE = "mycmux://tearout-revoke";
const PREFERENCE = "mycmux://tearout-preference";
const OUTGOING = "mycmux://tearout-outgoing";
const FINALIZE = "mycmux://tearout-finalize";
const HIGHLIGHT = "mycmux://tearout-highlight";
interface Approval { receiver: string; token: string; target: DockTarget }
interface Delivery { token: string; source: string; configs: WorkspaceConfig[]; placement?: DetachedReturnTarget; approval?: Approval; activeSessionId?: string | null }
interface Receipt { token: string; ok: boolean; error?: string }
interface DockRequest { token: string; deliveryToken: string; requester: string; approval: Approval; record?: RecordData }
export interface NativeSample {
  id: string; label: string; x: number; y: number; phase: "move" | "end"; at: number; escaped: boolean;
  receiver: string | null; client_x: number; client_y: number; approval: Approval | null;
  native_started_at: number | null; error: string | null;
  scale: number; monitor: string | null; focus_stolen: boolean;
  esc_at: number | null; original: { x: number; y: number; width: number; height: number };
  source?: string; region_count?: number; receiver_epoch?: number;
}
interface Adapter { serialize: (workspace: Workspace) => WorkspaceConfig; publish: () => Promise<void> }
let adapter: Adapter | null = null;
let listenersReady: Promise<void> = Promise.resolve();
const receipts = new Map<string, (receipt: Receipt) => void>();
interface Incoming { delivery: Delivery; before: Workspace[]; revoked: boolean; workspace: string | null; session: string | null;
  zoom: string | null; remembered: Record<string, string>; settled: Promise<void>; settle: () => void; addedIds: Set<string> }
const incoming = new Map<string, Incoming>();
const revokedTokens = new Set<string>();
let localMoving = false;
const approvedDrops = new Map<string, DockTarget>();
let preview: { id: string; label: string; epoch: number; feedback: TearoutPreview; target: DockTarget | null } | null = null;
let pendingSample: NativeSample | null = null;
let cancelSampleFrame: (() => void) | null = null;
let previewRevision = 0;

function nativeTarget(sample: NativeSample): DockTarget | null {
  const previous = preview?.target;
  const sidebar = document.elementFromPoint(sample.client_x, sample.client_y)?.closest('[data-dnd-workspace-sidebar="true"]');
  const target: DockTarget | null = sidebar ? { kind: "workspace" } : detachedDockTarget({ screenX: sample.client_x, screenY: sample.client_y },
    { x: 0, y: 0, scale: 1 }, document, previous);
  const owned = useWorkspaceListStore.getState().workspaces;
  return nativeDropAllowed(sample.region_count ?? 1, target) && target && (target.kind === "workspace" || owned.some((workspace) => workspace.id === target.workspaceId
    && workspace.panes.some((pane) => pane.id === target.paneId))) ? target : null;
}

function handleNativeSample(sample: NativeSample): void {
  if (sample.phase === "end") finishTearoutFrames(sample.id);
  else startTearoutFrames(sample.id);
  activeTearoutRecords.get(sample.id)?.native(sample);
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
  if (sample.receiver !== windowLabel() || sample.label === windowLabel()) {
    if (preview?.id === sample.id) { preview.feedback.clear(); preview = null; }
    return;
  }
  const epoch = sample.receiver_epoch ?? 0;
  if (!preview || preview.id !== sample.id || preview.epoch !== epoch) {
    preview?.feedback.clear();
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
    });
    preview = { id: sample.id, label: sample.label, epoch, feedback, target: null };
  }
  const target = nativeTarget(sample);
  if (sample.phase === "end") {
    const approval = sample.approval;
    if (!sample.escaped && approval && target && sameDockTarget(approval.target, target)
      && preview.feedback.accepts(approval.token, target)) {
      approvedDrops.set(approval.token, target);
      window.setTimeout(() => approvedDrops.delete(approval.token), 6000);
    }
    preview.feedback.clear();
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
  return configs.flatMap((config) => config.panes.flatMap((pane) => (pane.tabs ?? [])
    .filter((tab) => (tab.type == null || tab.type === "terminal") && tab.session_id?.startsWith("pty-"))
    .map((tab) => tab.session_id!)));
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
  let settle = () => {};
  const settled = new Promise<void>((resolve) => { settle = resolve; });
  const existingIds = new Set(useWorkspaceListStore.getState().workspaces.flatMap((ws) => ws.panes.flatMap((pane) => pane.tabs.map((tab) => tab.id))));
  const rawDeliveryIds = delivery.configs.flatMap((cfg) => cfg.panes.flatMap((pane) => (pane.tabs ?? []).map((tab) => tab.tab_id)));
  const deliveryIds = rawDeliveryIds.filter((id): id is string => typeof id === "string" && id.length > 0);
  const entry = { delivery, before: useWorkspaceListStore.getState().workspaces, revoked: false, settled, settle,
    workspace: useWorkspaceListStore.getState().activeWorkspaceId, session: useUiStore.getState().activePaneId,
    zoom: useUiStore.getState().zoomedPaneId, remembered: useWorkspaceListStore.getState().lastActivePaneByWorkspace,
    addedIds: new Set(deliveryIds.filter((id) => !existingIds.has(id))) };
  incoming.set(delivery.token, entry);
  const attachment = expectTearoutAttachments(sessions(delivery.configs));
  try {
    if (deliveryIds.length !== rawDeliveryIds.length) throw new Error("tearout_adoption_missing_id");
    if (deliveryIds.some((id) => existingIds.has(id))) throw new Error("tearout_adoption_duplicate");
    const placement = delivery.placement;
    if (placement?.kind === "pane" || placement?.kind === "pane-zone") {
      const pane = useWorkspaceListStore.getState().getWorkspace(placement.workspaceId)?.panes.find((pane) => pane.id === placement.paneId);
      if (!pane || placement.kind === "pane" && (!Number.isSafeInteger(placement.index) || placement.index < 0 || placement.index > pane.tabs.length)) {
        throw new Error("tearout_drop_target_changed");
      }
    }
    if (delivery.approval) {
      const target = approvedDrops.get(delivery.approval.token);
      if (!target || !sameDockTarget(target, delivery.approval.target)) throw new Error("tearout_drop_not_painted");
      approvedDrops.delete(delivery.approval.token);
    }
    const expected = sessions(delivery.configs);
    const alive = Promise.all(expected.map((id) => isSessionAlive(id)));
    // A synchronous restore failure can bypass checkAlive; retain its rejection handler.
    void alive.catch(() => {});
    // Mac may render/reattach while this read-only check is in flight. Receipt
    // still requires both live existing PTYs and successful attachments.
    const checkAlive = async () => {
      if (!(await alive).every(Boolean)) throw new Error("tearout_session_not_alive");
    };
    if (!isMacTearoutPlatform()) await checkAlive();
    if (entry.revoked) return;
    flushSync(() => {
      const configs = delivery.placement?.kind === "workspace"
        ? delivery.configs.map((config) => ({ ...config, detached: false, detached_from: null })) : delivery.configs;
      restoreWorkspaceConfigs(configs, {
        dockDetached: Boolean(delivery.placement),
        placementByWorkspaceId: delivery.placement ? Object.fromEntries(delivery.configs.map((config) => [config.id, delivery.placement!])) : {},
      });
      const transported = delivery.configs.flatMap(config => config.panes.flatMap(pane => pane.tabs ?? []));
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
    if (isMacTearoutPlatform()) {
      await Promise.all([checkAlive(), timeout(attachment.ready, 5000, "tearout_attachment_timeout")]);
    } else {
      await timeout(attachment.ready, 5000, "tearout_attachment_timeout");
    }
    if (entry.revoked) return;
    const ownedIds = useWorkspaceListStore.getState().workspaces.flatMap((ws) => ws.panes.flatMap((pane) => pane.tabs.map((tab) => tab.sessionId)));
    if (!expected.every((id) => ownedIds.includes(id))) throw new Error("tearout_session_identity_changed");
    await adapter!.publish();
    await emitTo(delivery.source, RECEIPT, { token: delivery.token, ok: true });
  } catch (error) {
    if (!entry.revoked) removeReceived(entry);
    await adapter!.publish();
    await emitTo(delivery.source, RECEIPT, { token: delivery.token, ok: false, error: "tearout_receive_failed" });
    console.warn("[tearout] receive failed", error);
  } finally { attachment.dispose(); entry.settle(); }
}

async function revoke(label: string, token: string): Promise<void> {
  const ack = crypto.randomUUID();
  const receipt = new Promise<Receipt>((resolve) => receipts.set(ack, resolve));
  try {
    await emitTo(label, REVOKE, { token, ack, source: windowLabel() });
    const result = await timeout(receipt, 6000, "tearout_revoke_timeout");
    if (!result.ok) throw new Error("tearout_revoke_failed");
  } finally { receipts.delete(ack); }
}

async function receiveRevoke(request: { token: string; ack: string; source: string }): Promise<void> {
  revokedTokens.add(request.token);
  window.setTimeout(() => revokedTokens.delete(request.token), 30000);
  try {
    const entry = incoming.get(request.token);
    if (entry && !entry.revoked) {
      entry.revoked = true;
      removeReceived(entry);
      await timeout(entry.settled, 5500, "tearout_revoke_attachment_timeout");
      for (const sessionId of sessions(entry.delivery.configs)) evictTerminalCache(sessionId);
      await adapter!.publish();
    }
    incoming.delete(request.token);
    await emitTo(request.source, RECEIPT, { token: request.ack, ok: true });
  } catch (error) {
    await emitTo(request.source, RECEIPT, { token: request.ack, ok: false, error: "tearout_revoke_failed" });
    console.warn("[tearout] revoke failed", error);
  }
}

async function send(label: string, configs: WorkspaceConfig[], placement?: DetachedReturnTarget, approval?: Approval,
  token: string = crypto.randomUUID(), activeSessionId?: string | null): Promise<string> {
  const receipt = new Promise<Receipt>((resolve) => receipts.set(token, resolve));
  try {
    await emitTo(label, DELIVERY, { token, source: windowLabel(), configs, placement, approval, activeSessionId });
    const result = await timeout(receipt, 6000, "tearout_receipt_timeout");
    if (!result.ok) throw new Error(result.error ?? "tearout_receive_failed");
    return token;
  } catch (error) {
    await revoke(label, token);
    throw error;
  } finally { receipts.delete(token); }
}

async function requestDock(label: string, approval: Approval, record?: TearoutRecord): Promise<void> {
  const token = crypto.randomUUID();
  const deliveryToken = crypto.randomUUID();
  const receipt = new Promise<Receipt>((resolve) => receipts.set(token, resolve));
  try {
    await emitTo(label, OUTGOING, { token, deliveryToken, requester: windowLabel(), approval,
      record: label === windowLabel() ? record?.forRetire(approval.target) : undefined });
    // Allow the child's bounded delivery, revocation and reattachment to finish.
    const result = await timeout(receipt, 20000, "tearout_dock_timeout");
    if (!result.ok) throw new Error(result.error ?? "tearout_dock_failed");
    // Keep receiver undo until this live parent has the successful dock receipt.
    // Cleanup failure must not roll back an already acknowledged transfer.
    void emitTo(approval.receiver, FINALIZE, { token: deliveryToken })
      .catch((error) => console.warn("[tearout] finalize failed", error));
  } catch (error) {
    // Revoke even a late delivery before retiring the child or restoring the source.
    await revoke(approval.receiver, deliveryToken);
    try { await invoke("tearout_phase", { id: deliveryToken, phase: "rolled_back" }); }
    catch (phaseError) {
      const code = phaseError instanceof Error ? phaseError.message : String(phaseError);
      if (code !== "tearout_transfer_missing") throw phaseError;
    }
    await invoke("tearout_forget", { id: deliveryToken });
    throw error;
  } finally { receipts.delete(token); }
}

async function dockOutgoing(request: DockRequest): Promise<void> {
  const before = useWorkspaceListStore.getState().workspaces;
  const selection = { workspace: useWorkspaceListStore.getState().activeWorkspaceId,
    session: useUiStore.getState().activePaneId, zoom: useUiStore.getState().zoomedPaneId };
  const configs = before.map((workspace) => adapter!.serialize(workspace));
  const id = request.deliveryToken;
  let prepared = false;
  let removed = false;
  let delivered: string | undefined;
  try {
    if (configs.length !== 1 || !nativeDropAllowed(configs[0].panes.length, request.approval.target)) throw new Error("tearout_dock_shape_unsupported");
    await invoke("tearout_prepare", { id, receiver: request.approval.receiver, configs });
    prepared = true;
    await invoke("tearout_phase", { id, phase: "shown" });
    await invoke("tearout_phase", { id, phase: "committed" });
    removed = true;
    flushSync(() => {
      useWorkspaceListStore.getState()._replaceWorkspaces([]);
      useWorkspaceListStore.setState({ activeWorkspaceId: null });
      useUiStore.setState({ activePaneId: null, zoomedPaneId: null });
    });
    for (const sessionId of sessions(configs)) { evictTerminalCache(sessionId); focusController.clearSession(sessionId); }
    await adapter!.publish();
    const target = request.approval.target;
    const placement: DetachedReturnTarget = target.kind === "tab-index" ? { ...target, kind: "pane" } : target;
    delivered = await send(request.approval.receiver, configs, placement, request.approval, request.deliveryToken, selection.session);
    await invoke("tearout_phase", { id, phase: "received" });
    await invoke("tearout_phase", { id, phase: "cleaned" });
    const selfRequested = request.requester === windowLabel();
    await invoke("tearout_retire", { label: windowLabel(), receiptLabel: request.requester,
      receiptToken: request.token, transferId: id,
      finalizeLabel: selfRequested ? request.approval.receiver : undefined,
      finalizeToken: selfRequested ? delivered : undefined,
      record: request.record ?? null });
  } catch (error) {
    if (delivered) await revoke(request.approval.receiver, delivered);
    if (prepared) await invoke("tearout_phase", { id, phase: "rolled_back" });
    if (removed) {
      const attachments = expectTearoutAttachments(sessions(configs));
      try {
        flushSync(() => {
          useWorkspaceListStore.getState()._replaceWorkspaces(before);
          useWorkspaceListStore.setState({ activeWorkspaceId: selection.workspace });
          useUiStore.setState({ activePaneId: selection.session, zoomedPaneId: selection.zoom });
        });
        await timeout(attachments.ready, 5000, "tearout_restore_attachment_timeout");
        await adapter!.publish();
      } finally { attachments.dispose(); }
    }
    await emitTo(request.requester, RECEIPT, { token: request.token, ok: false, error: "tearout_dock_failed" });
    console.warn("[tearout] dock failed", error);
  } finally { await invoke("tearout_forget", { id }); }
}

export function installTearoutRuntime(value: Adapter): () => void {
  adapter = value;
  // The default Any target also hears emitTo for other windows. Transfers and
  // their acknowledgements must stay with the addressed window's store.
  const ownWindow = { target: { kind: "Window" as const, label: windowLabel() } };
  const registered = [
    listen<Delivery>(DELIVERY, ({ payload }) => { void receive(payload); }, ownWindow),
    listen<Receipt>(RECEIPT, ({ payload }) => receipts.get(payload.token)?.(payload), ownWindow),
    listen<NativeSample>("mycmux://tearout-native", ({ payload }) => handleNativeSample(payload), ownWindow),
    listen<DockRequest>(OUTGOING, ({ payload }) => { void dockOutgoing(payload).catch((error) => console.warn("[tearout] dock recovery failed", error)); }, ownWindow),
    listen<{ id: string; at: number; hoverAt: number; receiver: string }>(HIGHLIGHT, ({ payload }) => {
      activeTearoutRecords.get(payload.id)?.highlighted(payload.at, payload.hoverAt, payload.receiver);
    }, ownWindow),
    listen<{ token: string; ack: string; source: string }>(REVOKE, ({ payload }) => { void receiveRevoke(payload); }, ownWindow),
    listen<{ token: string }>(FINALIZE, ({ payload }) => incoming.delete(payload.token), ownWindow),
    listen<boolean | { mac: true; enabled: boolean }>(PREFERENCE, ({ payload }) => {
      if (typeof payload === "boolean") {
        if (useSettingsStore.getState().nativePaneTearoutEnabled !== payload)
          useSettingsStore.setState({ nativePaneTearoutEnabled: payload });
      } else if (isMacTearoutPlatform()) {
        useSettingsStore.setState({ nativePaneTearoutEnabled: payload.enabled, macNativePaneTearoutEnabled: payload.enabled });
      }
    }),
  ];
  listenersReady = Promise.all(registered).then(() => {});
  const stopPrewarm = isTearoutChild() ? () => {} : installMacTearoutPrewarm(() => localMoving || incoming.size > 0);
  let preference = nativePaneTearoutEnabled(useSettingsStore.getState().nativePaneTearoutEnabled);
  const warm = () => {
    if (nativePaneTearoutEnabled(preference) && !isMainWindow()) return;
    void invoke(nativePaneTearoutEnabled(preference) ? "tearout_warm" : "tearout_release_spare")
      .catch((error) => console.warn("[tearout] spare maintenance failed", error));
  };
  if (nativePaneTearoutEnabled(preference)) warm();
  const stop = useSettingsStore.subscribe((state) => {
    const enabled = nativePaneTearoutEnabled(state.nativePaneTearoutEnabled);
    if (enabled === preference) return;
    preference = enabled;
    void emit(PREFERENCE, isMacTearoutPlatform() ? { mac: true, enabled: preference } : preference).catch((error) => console.warn("[tearout] preference failed", error));
    warm();
  });
  return () => {
    stop(); stopPrewarm();
    disposeTearoutFrames();
    cancelSampleFrame?.();
    cancelSampleFrame = null; pendingSample = null;
    preview?.feedback.clear();
    preview = null;
    for (const result of registered) void result.then((unlisten) => unlisten()).catch(() => {});
  };
}

export async function markTearoutChildReady(): Promise<void> {
  await listenersReady;
  await invoke("tearout_child_ready");
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

/** A complete native child moves itself; it never consumes another spare. */
export async function regrabTearoutWindow(record?: TearoutRecord): Promise<void> {
  const label = windowLabel();
  const workspaces = useWorkspaceListStore.getState().workspaces;
  if (workspaces.length !== 1) throw new Error("tearout_regrab_shape_unsupported");
  const panes = workspaces[0].panes;
  const paneCount = panes.reduce((count, pane) => count + pane.tabs.length, 0);
  const grabbedKind = panes.length > 1 ? "workspace" : paneCount > 1 ? "tab" : "pane";
  record ??= new TearoutRecord(crypto.randomUUID(), panes[0]?.tabs[0]?.id ?? "missing", label, Date.now(), grabbedKind, paneCount);
  record.transport(grabbedKind, paneCount);
  record.identity(useWorkspaceListStore.getState().workspaces.some((ws) => ws.panes.some((pane) => pane.tabs.some((tab) => tab.sessionId.startsWith("pty-")))) ? true : null);
  const id = record.id;
  activeTearoutRecords.set(id, record);
  let ended = false;
  let stop = () => {};
  stop = await listen<NativeSample>("mycmux://tearout-native", ({ payload }) => {
    if (payload.id !== id || payload.phase !== "end" || ended) return;
    ended = true;
    record!.native(payload);
    void (async () => {
      if (!payload.escaped && !payload.error && payload.approval) await requestDock(label, payload.approval, record);
      else {
        if (payload.escaped || payload.error) await invoke("tearout_restore_geometry", { label, geometry: payload.original });
        else await invoke("tearout_settle", { label });
        if (payload.error) record!.error("native_move_failed");
        await record!.finish(payload.escaped ? "esc_cancelled" : payload.error ? "failed_restored" : "kept_window");
      }
    })().catch(async (error) => {
      record!.error("dock_failed");
      await invoke("tearout_restore_geometry", { label, geometry: payload.original });
      await record!.finish("failed_restored");
      console.warn("[tearout] regrab failed", error);
    }).finally(() => { stop(); activeTearoutRecords.delete(id); });
  }, { target: { kind: "Window", label: windowLabel() } });
  try { await invoke("tearout_start_move", { label, id, regionCount: panes.length }); }
  catch (error) {
    stop(); activeTearoutRecords.delete(id); record.error("native_move_failed");
    await invoke("tearout_settle", { label }); await record.finish("failed_restored"); throw error;
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
  if (!adapter) throw new Error("tearout_runtime_not_ready");
  if (localMoving) throw new Error("tearout_move_busy");
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
    ?? movedTabs.find(tab => tab.sessionId === sourceSelection.lastActive)?.sessionId ?? pane.sessionId;
  const transfer = item.kind === "workspace" ? source : item.kind === "pane"
    ? { ...source, id: crypto.randomUUID(), panes: [pane], splitColumns: [[pane.id]],
      columnWidths: [1], rowHeightsPerCol: [[1]], columnDividerPins: [], rowDividerPinsPerCol: [[]] }
    : { ...source, id: crypto.randomUUID(), panes: [{ ...pane, id: crypto.randomUUID(), tabs: [tab!],
      activeTabId: tab!.id, sessionId: tab!.sessionId }], splitColumns: undefined };
  const serialized = adapter.serialize(transfer);
  const origin = item.kind === "tab" ? detachedOriginForDrag(source, item) : undefined;
  const config = item.kind === "tab" ? origin && detachedWorkspaceConfig(serialized, origin)
    : { ...serialized, detached: false, detached_from: null };
  if (!config) throw new Error("tearout_config_invalid");
  record ??= new TearoutRecord(crypto.randomUUID(), item.kind === "tab" ? item.tabId : item.kind === "pane" ? pane.id : source.id,
    windowLabel(), Date.now(), item.kind === "tab" ? "pane" : item.kind === "pane" ? "tab" : "workspace", movedTabs.length);
  record.transport(item.kind === "tab" ? "pane" : item.kind === "pane" ? "tab" : "workspace", movedTabs.length);
  record.outside(Date.now());
  const id = record.id;
  activeTearoutRecords.set(id, record);
  let result: TearoutResult = "failed_restored";
  let destination: DockTarget | null = null;
  let identity: boolean | null = sessions([config]).length ? true : null;
  let failure: TearoutError = "prepare_failed";
  const deliveryToken = crypto.randomUUID();
  let label: string | undefined;
  let removed = false;
  let prepared = false;
  let transferFailed = false;
  let cancelled = false;
  let restore: Promise<void> | null = null;
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
  localMoving = true;
  window.addEventListener("keydown", escape, true);
  const rollback = (): Promise<void> => {
    if (restore) return restore;
    restore = (async () => {
      // Destroy this new child's webview before the original channel reattaches.
      if (isMacTearoutPlatform()) {
        await Promise.all([
          label ? invoke("tearout_retire", { label }) : Promise.resolve(),
          prepared ? invoke("tearout_phase", { id, phase: "rolled_back" }) : Promise.resolve(),
        ]);
      } else {
        if (label) await invoke("tearout_retire", { label });
        if (prepared) await invoke("tearout_phase", { id, phase: "rolled_back" });
      }
      if (removed) {
        const attachment = expectTearoutAttachments(sessions([config]));
        try {
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
          await adapter!.publish();
        } finally { attachment.dispose(); }
      }
    })();
    void restore.catch(() => { record!.error("rollback_failed"); identity = false; });
    return restore;
  };
  let complete = () => {};
  const finished = new Promise<void>((resolve) => { complete = resolve; });
  const finish = async (payload: NativeSample) => {
    if (ended) return;
    ended = true;
    record!.native(payload);
    try {
      if (payload.escaped || cancelled || payload.error) {
        result = (payload.escaped && !transferFailed && !payload.error) || cancelled ? "esc_cancelled" : "failed_restored";
        if (payload.error) record!.error("native_move_failed");
        await rollback();
      }
      else {
        await delivery;
        await published;
        if (payload.approval) {
          failure = "dock_failed";
          await requestDock(label!, payload.approval);
          result = "docked"; destination = payload.approval.target;
        }
        else {
          await invoke("tearout_settle", { label });
          await emitTo(label!, FINALIZE, { token: deliveryToken });
          result = "kept_window";
        }
      }
    } catch (error) {
      result = "failed_restored"; record!.error(failure);
      await rollback();
      console.warn("[tearout] finish restored source", error);
    } finally { complete(); }
  };
  try {
    label = await takeSpare();
    checkCancelled();
    await invoke("tearout_prepare", { id, receiver: label, configs: [config] });
    prepared = true;
    checkCancelled();
    stopNative = await listen<NativeSample>("mycmux://tearout-native", ({ payload }) => {
      if (payload.id !== id || payload.phase !== "end" || ended) return;
      void finish(payload).catch((error) => console.warn("[tearout] rollback failed", error));
    }, { target: { kind: "Window", label: windowLabel() } });
    failure = "show_failed";
    record.revealed(await invoke<Reveal>("tearout_show", { label, offsetX: offset.x, offsetY: offset.y }));
    await invoke("tearout_phase", { id, phase: "shown" });
    checkCancelled();
    await invoke("tearout_phase", { id, phase: "committed" });
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
    for (const tab of movedTabs) {
      if (!isMacTearoutPlatform()) evictTerminalCache(tab.sessionId);
      focusController.clearSession(tab.sessionId);
    }
    published = adapter.publish();
    delivery = send(label, [config], undefined, undefined, deliveryToken, selectedSession).then(async (token) => {
      if (!restore) {
        await invoke("tearout_phase", { id, phase: "received" });
        await invoke("tearout_phase", { id, phase: "cleaned" });
      }
      return token;
    });
    void delivery.catch(() => { transferFailed = true; record!.error("receive_failed"); void invoke("tearout_cancel_move", { id, label }).catch(() => {}); });
    void published.catch(() => { transferFailed = true; record!.error("prepare_failed"); void invoke("tearout_cancel_move", { id, label }).catch(() => {}); });
    checkCancelled();
    failure = "native_move_failed";
    await invoke("tearout_start_move", { label, id, regionCount: transfer.panes.length });
    await finished;
  } catch (error) {
    ended = true;
    result = cancelled ? "esc_cancelled" : "failed_restored";
    if (!cancelled) record.error(failure);
    await rollback();
    throw error;
  } finally {
    window.removeEventListener("keydown", escape, true);
    stopNative();
    useTearoutStore.setState({ gap: null });
    localMoving = false;
    activeTearoutRecords.delete(id);
    // Mac also reuses its parked renderer after a kept window is regrabbed.
    // The normal cache LRU (12) and session-close eviction still bound its life;
    // cached renderers own no workspace and have no mounted input listeners.
    // Windows retains its original eager eviction above.
    await record.finish(result, destination, identity).catch((error) => console.warn("[tearout] log failed", error));
    if (prepared) await invoke("tearout_forget", { id });
    if (nativePaneTearoutEnabled(useSettingsStore.getState().nativePaneTearoutEnabled)) {
      void invoke("tearout_warm").catch((error) => console.warn("[tearout] refill failed", error));
    }
  }
}
