import { emitTo, listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { useDashboardViewStore } from "../stores/dashboardViewStore";
import { useGroupingRuntimeStore } from "../stores/groupingRuntimeStore";
import { usePaneDragStore } from "../stores/paneDragStore";
import { useSavepointDragStore } from "../stores/savepointDragStore";
import { useUiStore } from "../stores/uiStore";
import { useWorkspaceListStore } from "../stores/workspaceListStore";
import { jumpToPaneTab } from "./jumpToPaneTab";
import { isPreparingLayoutQuit } from "./layoutQuit";
import { isPaneTabClosing } from "./paneCloseOperation";
import { focusWindow, getWindowFragments } from "./ipc";
import { windowLabel } from "./windowContext";

export const OPERATOR_FOCUS_EVENT = "mycmux:web-pane-operator-focus";
export const OPERATOR_FOCUS_ACCEPTED_EVENT = "mycmux:web-pane-operator-focus-accepted";
export const OPERATOR_FOCUS_WINDOW_EVENT = "mycmux:web-pane-operator-focus-window";
const OPERATOR_FOCUS_RESULT_EVENT = "mycmux:web-pane-operator-focus-result";
const OPERATOR_FOCUS_RESULT_TIMEOUT_MS = 3_000;
export const OCCLUDER_SELECTOR = [
  ".cmux-overlay-backdrop",
  ".cmux-popover-panel",
  "[aria-modal='true']",
  "[role='menu']",
  "[data-cmux-native-webview-occluder]",
].join(",");

type OperatorFocusRequest =
  | { tabId: string; targetTabId: string; requestId: string }
  | { tabId: string; refused: "automation" };

type TargetRefusal = "missing" | "notTerminal" | "closing";
export type OperatorFocusRefusal = TargetRefusal | "blocked" | "automation" | "timeout";

type WindowFocusResult = Exclude<OperatorFocusRefusal, "automation"> | null;

function isRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
}

function isWindowFocusResult(value: unknown): value is WindowFocusResult {
  return value === null || value === "missing" || value === "notTerminal" || value === "closing" || value === "blocked" || value === "timeout";
}

export const useOperatorFocusNoticeStore = create<{
  notices: ReadonlyMap<string, OperatorFocusRefusal>;
  waitingShortcuts: ReadonlySet<string>;
}>(() => ({ notices: new Map(), waitingShortcuts: new Set() }));

function isTabId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128
    && !/[^A-Za-z0-9_.:-]/.test(value);
}

export function parseOperatorFocusRequest(value: unknown): OperatorFocusRequest | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Record<string, unknown>;
  const fieldCount = Object.keys(payload).length;
  if (!isTabId(payload.tabId)) return null;
  if (fieldCount === 3 && isTabId(payload.targetTabId) && !("refused" in payload)
    && isRequestId(payload.requestId)) {
    return { tabId: payload.tabId, targetTabId: payload.targetTabId, requestId: payload.requestId };
  }
  if (fieldCount === 2 && payload.refused === "automation" && !("targetTabId" in payload)) {
    return { tabId: payload.tabId, refused: "automation" };
  }
  return null;
}

export function jumpToOperatorFocusTab(targetTabId: string): TargetRefusal | null {
  // Each primary webview owns its local store. Tear-out adoption moves the
  // workspace/tab into that store before any of its tab controls can use it.
  for (const workspace of useWorkspaceListStore.getState().workspaces) {
    for (const pane of workspace.panes) {
      const tab = pane.tabs.find(candidate => candidate.id === targetTabId);
      if (!tab) continue;
      if (tab.type !== undefined && tab.type !== "terminal") return "notTerminal";
      if (isPaneTabClosing(tab.id)) return "closing";
      jumpToPaneTab({ workspaceId: workspace.id, paneId: pane.id, tab });
      return null;
    }
  }
  return "missing";
}


export function isOperatorFocusBlocked(dragBlocked = usePaneDragStore.getState().item !== null
  || useSavepointDragStore.getState().item !== null): boolean {
  const grouping = useGroupingRuntimeStore.getState();
  return useDashboardViewStore.getState().open
    || useUiStore.getState().isKeybindingsOpen
    || dragBlocked || grouping.operation !== null || grouping.transitionDepth > 0
    || document.querySelector(OCCLUDER_SELECTOR + ",#tab-sweep-panel") !== null;
}

export async function findOperatorFocusWindow(targetTabId: string): Promise<string | null> {
  const ownLabel = windowLabel();
  const fragments = await getWindowFragments();
  return fragments.find(fragment => !fragment.pending && fragment.window_label !== ownLabel
    && fragment.workspaces.some(workspace => workspace.panes.some(pane =>
      pane.tabs?.some(tab => tab.tab_id === targetTabId))))?.window_label ?? null;
}


/** The source awaits a result from the named peer for this request only. */
export function requestOperatorFocusInWindow(targetWindow: string, targetTabId: string, requestId: string): Promise<WindowFocusResult> {
  const sourceWindow = windowLabel();
  const expiresAt = Date.now() + OPERATOR_FOCUS_RESULT_TIMEOUT_MS;
  return new Promise(resolve => {
    let settled = false;
    let stop: (() => void) | undefined;
    const finish = (reason: WindowFocusResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop?.();
      resolve(reason);
    };
    const timer = setTimeout(() => finish("timeout"), OPERATOR_FOCUS_RESULT_TIMEOUT_MS);
    void listen<unknown>(OPERATOR_FOCUS_RESULT_EVENT, ({ payload }) => {
      if (!payload || typeof payload !== "object" || Object.keys(payload).length !== 3) return;
      const result = payload as Record<string, unknown>;
      if (result.requestId === requestId && result.fromWindow === targetWindow && isWindowFocusResult(result.reason)) {
        finish(result.reason);
      }
    }, { target: { kind: "Webview", label: sourceWindow } }).then(unlisten => {
      if (settled) {
        unlisten();
        return;
      }
      stop = unlisten;
      void emitTo(targetWindow, OPERATOR_FOCUS_WINDOW_EVENT, { targetTabId, sourceWindow, requestId, expiresAt })
        .catch(() => finish("missing"));
    }).catch(() => finish("missing"));
  });
}

export function connectOperatorFocusWindowNavigation(): () => void {
  const label = windowLabel();
  let alive = true;
  let unlisten: (() => void) | undefined;
  void listen<unknown>(OPERATOR_FOCUS_WINDOW_EVENT, async ({ payload }) => {
    if (!alive || !payload || typeof payload !== "object" || Object.keys(payload).length !== 4) return;
    const request = payload as Record<string, unknown>;
    if (!isTabId(request.targetTabId) || !isTabId(request.sourceWindow)
      || request.sourceWindow === label || !isRequestId(request.requestId)
      || typeof request.expiresAt !== "number" || !Number.isSafeInteger(request.expiresAt)
      || request.expiresAt > Date.now() + OPERATOR_FOCUS_RESULT_TIMEOUT_MS) return;
    let reason: WindowFocusResult = request.expiresAt <= Date.now() ? "timeout"
      : isPreparingLayoutQuit() || isOperatorFocusBlocked() ? "blocked" : jumpToOperatorFocusTab(request.targetTabId);
    if (reason === null) {
      try { await focusWindow(label, { focusPrimary: true, expiresAt: request.expiresAt }); }
      catch (error) { reason = error === "focus_request_expired" ? "timeout" : "missing"; }
    }
    if (alive) void emitTo(request.sourceWindow, OPERATOR_FOCUS_RESULT_EVENT, {
      requestId: request.requestId, fromWindow: label, reason,
    }).catch(() => undefined);
  }, { target: { kind: "Webview", label } }).then(stop => {
    if (alive) unlisten = stop;
    else stop();
  }).catch(() => undefined);
  return () => { alive = false; unlisten?.(); };
}
