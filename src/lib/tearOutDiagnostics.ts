import { getCurrentSessionEpoch } from "./attachEpoch";
import { TEAR_OUT_EDGE_MARGIN_PX } from "./windowEdge";
import { windowLabel } from "./windowContext";

export const TEAR_OUT_DRAG_THRESHOLD_PX = 9;
export const WORKSPACE_DRAG_VERTICAL_THRESHOLD_PX = 5;
export const WORKSPACE_DRAG_HORIZONTAL_THRESHOLD_PX = 24;
export const TEAR_OUT_DWELL_MS = 0;

export type TearOutItemKind = "workspace" | "pane" | "tab";
export type TearOutState =
  | "idle"
  | "pressed"
  | "dragging"
  | "tearout-armed"
  | "commit-pending"
  | "committed"
  | "cancelled"
  | "capture-lost"
  | "create-failed"
  | "transfer-failed"
  | "rolled-back";

export type TearOutEventKind =
  | "state"
  | "pointermove"
  | "pointerup"
  | "pointercancel"
  | "lostpointercapture"
  | "window-create-requested"
  | "window-label-accepted"
  | "source-detached"
  | "destination-adopted"
  | "destination-attached"
  | "rollback";

export interface TearOutPointerSample {
  clientX: number;
  clientY: number;
  screenX: number;
  screenY: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface TearOutDiagnosticEvent {
  dragId: string;
  sequence: number;
  timestamp: string;
  elapsedMs: number;
  event: TearOutEventKind;
  state: TearOutState;
  itemKind: TearOutItemKind;
  itemId: string;
  sourceWindow: string;
  pointerId: number;
  pointerCaptureSucceeded: boolean | null;
  clientX: number;
  clientY: number;
  screenX: number;
  screenY: number;
  outsideDistancePx: number;
  tearoutArmedAtMs: number | null;
  dwellMs: number;
  candidateDropTarget: string | null;
  workspaceId: string | null;
  destinationWindow: string | null;
  primarySessionId: string | null;
  ptyConnectionState: "source-attached" | "reattach-pending" | "attached" | "unknown";
  ptyOwnerBefore: string | null;
  ptyOwnerAfter: string | null;
  reason?: string;
}

export type TearOutMeasurementSnapshot = TearOutDiagnosticEvent;

interface TearOutTraceInput {
  itemKind: TearOutItemKind;
  itemId: string;
  pointerId: number;
  pointer: TearOutPointerSample;
  sourceWindow?: string;
}

interface TearOutTraceOptions {
  dragId?: string;
  now?: () => number;
  wallClock?: () => Date;
  sink?: (snapshot: TearOutMeasurementSnapshot) => void;
  log?: (event: TearOutDiagnosticEvent) => void;
}

interface PendingTransfer {
  dragId: string;
  itemKind: TearOutItemKind;
  itemId: string;
  sourceWindow: string;
  destinationWindow: string | null;
  workspaceId: string;
  primarySessionId: string | null;
  createdAt: number;
}

const EVENT_STORAGE_KEY = "mycmux-tearout-diagnostics-v1";
const PENDING_STORAGE_KEY = "mycmux-tearout-pending-v1";
const MAX_STORED_EVENTS = 500;
const ATTACH_POLL_INTERVAL_MS = 50;
const ATTACH_POLL_TIMEOUT_MS = 10_000;

let observedWorkspaceIds = new Set<string>();
let storageListenerInstalled = false;
const attachPolls = new Map<string, ReturnType<typeof window.setInterval>>();

function diagnosticsEnabled(): boolean {
  return import.meta.env.DEV;
}

function randomDragId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `drag-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

export function outsideWindowDistancePx(sample: TearOutPointerSample): number {
  return Math.max(
    0,
    -sample.clientX,
    -sample.clientY,
    sample.clientX - sample.viewportWidth,
    sample.clientY - sample.viewportHeight,
  );
}

export function isTearOutDistanceArmed(distancePx: number): boolean {
  return distancePx > TEAR_OUT_EDGE_MARGIN_PX;
}

function readJsonArray<T>(key: string): T[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function writeJsonArray<T>(key: string, values: readonly T[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(values));
  } catch {
    // Diagnostics must never interfere with the drag path.
  }
}

function persistEvent(event: TearOutDiagnosticEvent): void {
  const events = readJsonArray<TearOutDiagnosticEvent>(EVENT_STORAGE_KEY);
  events.push(event);
  writeJsonArray(EVENT_STORAGE_KEY, events.slice(-MAX_STORED_EVENTS));
}

function appendCrossWindowEvent(
  pending: PendingTransfer,
  event: "destination-adopted" | "destination-attached",
  state: TearOutState,
  ptyConnectionState: TearOutDiagnosticEvent["ptyConnectionState"],
): void {
  const timestamp = new Date();
  const diagnostic: TearOutDiagnosticEvent = {
    dragId: pending.dragId,
    sequence: -1,
    timestamp: timestamp.toISOString(),
    elapsedMs: Math.max(0, timestamp.getTime() - pending.createdAt),
    event,
    state,
    itemKind: pending.itemKind,
    itemId: pending.itemId,
    sourceWindow: pending.sourceWindow,
    pointerId: -1,
    pointerCaptureSucceeded: null,
    clientX: 0,
    clientY: 0,
    screenX: 0,
    screenY: 0,
    outsideDistancePx: 0,
    tearoutArmedAtMs: null,
    dwellMs: 0,
    candidateDropTarget: "new-window",
    workspaceId: pending.workspaceId,
    destinationWindow: windowLabel(),
    primarySessionId: pending.primarySessionId,
    ptyConnectionState,
    ptyOwnerBefore: pending.sourceWindow,
    ptyOwnerAfter: windowLabel(),
  };
  persistEvent(diagnostic);
  console.info("[mycmux-diag tearout]", diagnostic);
}

function processPendingTransfers(): void {
  if (!diagnosticsEnabled() || typeof window === "undefined") return;
  const currentLabel = windowLabel();
  const pendingTransfers = readJsonArray<PendingTransfer>(PENDING_STORAGE_KEY);
  for (const pending of pendingTransfers) {
    if (pending.destinationWindow !== currentLabel) continue;
    if (!observedWorkspaceIds.has(pending.workspaceId)) continue;
    const pollKey = `${pending.dragId}:${pending.workspaceId}`;
    if (attachPolls.has(pollKey)) continue;
    appendCrossWindowEvent(pending, "destination-adopted", "commit-pending", "reattach-pending");
    if (!pending.primarySessionId) continue;
    const startedAt = Date.now();
    const poll = window.setInterval(() => {
      if (getCurrentSessionEpoch(pending.primarySessionId!) > 0) {
        window.clearInterval(poll);
        attachPolls.delete(pollKey);
        appendCrossWindowEvent(pending, "destination-attached", "committed", "attached");
        writeJsonArray(
          PENDING_STORAGE_KEY,
          readJsonArray<PendingTransfer>(PENDING_STORAGE_KEY).filter((entry) => entry.dragId !== pending.dragId),
        );
      } else if (Date.now() - startedAt >= ATTACH_POLL_TIMEOUT_MS) {
        window.clearInterval(poll);
        attachPolls.delete(pollKey);
      }
    }, ATTACH_POLL_INTERVAL_MS);
    attachPolls.set(pollKey, poll);
  }
}

function installStorageListener(): void {
  if (storageListenerInstalled || typeof window === "undefined") return;
  storageListenerInstalled = true;
  window.addEventListener("storage", (event) => {
    if (event.key === PENDING_STORAGE_KEY) processPendingTransfers();
  });
}

export function observeTearOutDestination(workspaceIds: readonly string[]): void {
  if (!diagnosticsEnabled() || typeof window === "undefined") return;
  observedWorkspaceIds = new Set(workspaceIds);
  installStorageListener();
  processPendingTransfers();
}

export function getTearOutDiagnosticEvents(): TearOutDiagnosticEvent[] {
  if (!diagnosticsEnabled()) return [];
  return readJsonArray<TearOutDiagnosticEvent>(EVENT_STORAGE_KEY).map((event) => ({ ...event }));
}

export function clearTearOutDiagnosticEvents(): void {
  if (!diagnosticsEnabled() || typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(EVENT_STORAGE_KEY);
    window.localStorage.removeItem(PENDING_STORAGE_KEY);
  } catch {
    // Diagnostics cleanup is best-effort.
  }
}

export class TearOutDragTrace {
  readonly dragId: string;
  private readonly input: TearOutTraceInput;
  private readonly now: () => number;
  private readonly wallClock: () => Date;
  private readonly sink?: (snapshot: TearOutMeasurementSnapshot) => void;
  private readonly log: (event: TearOutDiagnosticEvent) => void;
  private readonly startedAt: number;
  private sequence = 0;
  private state: TearOutState = "idle";
  private pointerCaptureSucceeded: boolean | null = null;
  private pointer: TearOutPointerSample;
  private armedAt: number | null = null;
  private candidateDropTarget: string | null = null;
  private workspaceId: string | null = null;
  private destinationWindow: string | null = null;
  private primarySessionId: string | null = null;
  private ptyConnectionState: TearOutDiagnosticEvent["ptyConnectionState"] = "source-attached";

  constructor(input: TearOutTraceInput, options: TearOutTraceOptions = {}) {
    this.input = { ...input, sourceWindow: input.sourceWindow ?? windowLabel() };
    this.dragId = options.dragId ?? randomDragId();
    this.now = options.now ?? (() => performance.now());
    this.wallClock = options.wallClock ?? (() => new Date());
    this.sink = options.sink;
    this.log = options.log ?? ((event) => console.info("[mycmux-diag tearout]", event));
    this.pointer = { ...input.pointer };
    this.startedAt = this.now();
    this.emit("state");
    this.transition("pressed");
  }

  private event(event: TearOutEventKind, reason?: string): TearOutDiagnosticEvent {
    const now = this.now();
    const elapsedMs = Math.max(0, now - this.startedAt);
    return {
      dragId: this.dragId,
      sequence: this.sequence++,
      timestamp: this.wallClock().toISOString(),
      elapsedMs,
      event,
      state: this.state,
      itemKind: this.input.itemKind,
      itemId: this.input.itemId,
      sourceWindow: this.input.sourceWindow!,
      pointerId: this.input.pointerId,
      pointerCaptureSucceeded: this.pointerCaptureSucceeded,
      clientX: this.pointer.clientX,
      clientY: this.pointer.clientY,
      screenX: this.pointer.screenX,
      screenY: this.pointer.screenY,
      outsideDistancePx: outsideWindowDistancePx(this.pointer),
      tearoutArmedAtMs: this.armedAt === null ? null : Math.max(0, this.armedAt - this.startedAt),
      dwellMs: this.armedAt === null ? 0 : Math.max(0, now - this.armedAt),
      candidateDropTarget: this.candidateDropTarget,
      workspaceId: this.workspaceId,
      destinationWindow: this.destinationWindow,
      primarySessionId: this.primarySessionId,
      ptyConnectionState: this.ptyConnectionState,
      ptyOwnerBefore: this.input.sourceWindow!,
      ptyOwnerAfter: this.destinationWindow,
      ...(reason ? { reason } : {}),
    };
  }

  private emit(event: TearOutEventKind, reason?: string): void {
    const diagnostic = this.event(event, reason);
    persistEvent(diagnostic);
    this.log(diagnostic);
    this.sink?.({ ...diagnostic });
  }

  transition(state: TearOutState, reason?: string): void {
    this.state = state;
    this.emit("state", reason);
  }

  pointerEvent(event: "pointermove" | "pointerup" | "pointercancel" | "lostpointercapture", pointer: TearOutPointerSample, reason?: string): void {
    this.pointer = { ...pointer };
    this.emit(event, reason);
  }

  dragging(pointerCaptureSucceeded: boolean): void {
    this.pointerCaptureSucceeded = pointerCaptureSucceeded;
    this.transition("dragging");
  }

  updateCandidate(pointer: TearOutPointerSample, candidateDropTarget: string | null): void {
    this.pointer = { ...pointer };
    this.candidateDropTarget = candidateDropTarget;
    this.emit("pointermove");
  }

  arm(pointer: TearOutPointerSample): void {
    this.pointer = { ...pointer };
    this.candidateDropTarget = "new-window";
    if (this.state !== "tearout-armed") {
      this.armedAt = this.now();
      this.transition("tearout-armed");
    }
  }

  disarm(pointer: TearOutPointerSample, candidateDropTarget: string | null): void {
    this.pointer = { ...pointer };
    this.candidateDropTarget = candidateDropTarget;
    if (this.state === "tearout-armed") {
      this.armedAt = null;
      this.transition("dragging", "pointer returned inside tear-out boundary");
    }
  }

  commitPending(workspaceId: string, primarySessionId: string | null): void {
    this.workspaceId = workspaceId;
    this.primarySessionId = primarySessionId;
    this.ptyConnectionState = "reattach-pending";
    this.transition("commit-pending");
  }

  windowCreateRequested(): void {
    this.emit("window-create-requested");
    const pending = readJsonArray<PendingTransfer>(PENDING_STORAGE_KEY).filter((entry) => entry.dragId !== this.dragId);
    pending.push({
      dragId: this.dragId,
      itemKind: this.input.itemKind,
      itemId: this.input.itemId,
      sourceWindow: this.input.sourceWindow!,
      destinationWindow: null,
      workspaceId: this.workspaceId!,
      primarySessionId: this.primarySessionId,
      createdAt: Date.now(),
    });
    writeJsonArray(PENDING_STORAGE_KEY, pending);
  }

  windowLabelAccepted(destinationWindow: string): void {
    this.destinationWindow = destinationWindow;
    this.emit("window-label-accepted");
    const pending = readJsonArray<PendingTransfer>(PENDING_STORAGE_KEY).map((entry) => (
      entry.dragId === this.dragId ? { ...entry, destinationWindow } : entry
    ));
    writeJsonArray(PENDING_STORAGE_KEY, pending);
  }

  sourceDetached(): void {
    this.emit("source-detached");
  }

  committed(): void {
    this.transition("committed");
  }

  failed(state: "create-failed" | "transfer-failed", reason: string): void {
    this.ptyConnectionState = "unknown";
    this.transition(state, reason);
  }

  rolledBack(reason: string): void {
    this.emit("rollback", reason);
    this.transition("rolled-back", reason);
  }
}

export function createTearOutDragTrace(
  input: TearOutTraceInput,
  options: TearOutTraceOptions = {},
): TearOutDragTrace | null {
  if (!diagnosticsEnabled()) return null;
  return new TearOutDragTrace(input, options);
}

declare global {
  interface Window {
    __mycmuxTearOutEvents?: typeof getTearOutDiagnosticEvents;
    __mycmuxTearOutEventsClear?: typeof clearTearOutDiagnosticEvents;
  }
}

if (typeof window !== "undefined" && diagnosticsEnabled()) {
  installStorageListener();
  window.__mycmuxTearOutEvents = getTearOutDiagnosticEvents;
  window.__mycmuxTearOutEventsClear = clearTearOutDiagnosticEvents;
}
