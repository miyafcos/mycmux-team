import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

import type { DashboardDisplayState } from "../components/dashboard/dashboardModel";
import { classifyModelForProvider } from "./aiModels";
import { useAiSettingsStore } from "../stores/aiSettingsStore";
import {
  reportBatchAiContext,
  type ReportDispatchBatch,
  useReportInboxStore,
} from "../stores/reportInboxStore";
import { useSettingsStore } from "../stores/settingsStore";

const DEBOUNCE_MS = 1_500;
const NEXT_ACTION_PROMPT_VERSION = "next-action-v2";
const REPORT_SUMMARY_PROMPT_VERSION = "report-summary-v1";
const NEXT_ACTION_PURPOSE = "next-action";
const REPORT_SUMMARY_PURPOSE = "report-summary";

export interface BackgroundAiAction {
  label: string;
  prompt: string;
}

export interface BackgroundAiSuggestion {
  status: "loading" | "ready" | "failed";
  requestKey: string;
  oneLine: string;
  completionAssessment: string;
  nextActions: BackgroundAiAction[];
  failureCode?: string;
}

export interface ActiveSessionTarget {
  sessionId: string;
  displayState: DashboardDisplayState;
  questionActive: boolean;
  eventSeq: number;
  tabLabel: string | null;
  cwd: string | null;
}

interface BackgroundAiState {
  bySession: Record<string, BackgroundAiSuggestion | undefined>;
  byReportBatch: Record<string, BackgroundAiSuggestion | undefined>;
  set: (sessionId: string, suggestion: BackgroundAiSuggestion) => void;
  clear: (sessionId: string) => void;
  setReportSummary: (batchId: string, suggestion: BackgroundAiSuggestion) => void;
  clearReportSummary: (batchId: string) => void;
  reset: () => void;
}

export const useBackgroundAiSuggestionStore = create<BackgroundAiState>((set) => ({
  bySession: {},
  byReportBatch: {},
  set: (sessionId, suggestion) => set((state) => ({ bySession: { ...state.bySession, [sessionId]: suggestion } })),
  clear: (sessionId) => set((state) => {
    if (!(sessionId in state.bySession)) return state;
    const bySession = { ...state.bySession };
    delete bySession[sessionId];
    return { bySession };
  }),
  setReportSummary: (batchId, suggestion) => set((state) => ({
    byReportBatch: { ...state.byReportBatch, [batchId]: suggestion },
  })),
  clearReportSummary: (batchId) => set((state) => {
    if (!(batchId in state.byReportBatch)) return state;
    const byReportBatch = { ...state.byReportBatch };
    delete byReportBatch[batchId];
    return { byReportBatch };
  }),
  reset: () => set({ bySession: {}, byReportBatch: {} }),
}));

export function useBackgroundAiSuggestion(sessionId: string | null): BackgroundAiSuggestion | undefined {
  return useBackgroundAiSuggestionStore((state) => (sessionId ? state.bySession[sessionId] : undefined));
}

export function useBackgroundAiReportSummary(batchId: string): BackgroundAiSuggestion | undefined {
  return useBackgroundAiSuggestionStore((state) => state.byReportBatch[batchId]);
}

interface PendingRequest {
  requestId: string;
  requestKey: string;
  timer: ReturnType<typeof setTimeout> | null;
  /** Set once the judge process has actually been asked to run. */
  started: boolean;
}

const pendingByTarget = new Map<string, PendingRequest>();

/**
 * Measured on 2026-08-30 from ~/.mycmux/diag.log: of 27 next-action judges,
 * 5 finished and 22 were cancelled, because switching sessions aborted the
 * run 2-3 seconds in. A suggestion that is always thrown away is the same as
 * no suggestion at all, so a started judge now runs to completion and its
 * result is kept per session -- it is there the moment you come back.
 *
 * Letting every visited session start one at once would be the other failure,
 * so at most two run and a short queue holds the rest; the oldest queued entry
 * is dropped first because the newest visit is the one the person is on.
 */
const MAX_INFLIGHT_JUDGES = 2;
const MAX_QUEUED_JUDGES = 4;

/**
 * Not cancelling made a revisited session instant, but the first visit still
 * waits the 30-80s the judge takes. Sessions already on screen and already
 * idle are the ones worth having ready before they are opened.
 *
 * Each one costs a real judge run, so this is bounded twice: the concurrency
 * cap above, and a per-day count so an idle machine cannot spend the day
 * generating suggestions nobody reads. The active session never draws from the
 * budget -- someone is waiting for that one.
 */
const AHEAD_DAILY_LIMIT = 12;
const AHEAD_STORAGE_KEY = "mycmux.nextAction.aheadBudget.v1";

function localDay(now: number): string {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

let aheadBudget = { day: "", count: 0 };

function readAheadBudget(): { day: string; count: number } {
  const day = localDay(Date.now());
  if (aheadBudget.day !== day) aheadBudget = { day, count: 0 };
  try {
    const parsed = JSON.parse(window.localStorage.getItem(AHEAD_STORAGE_KEY) ?? "null") as { day?: string; count?: number } | null;
    if (parsed?.day === day && Number.isInteger(parsed.count) && (parsed.count ?? -1) >= 0) {
      aheadBudget.count = Math.max(aheadBudget.count, parsed.count as number);
    }
  } catch {
    // A malformed record just starts the day over.
  }
  return { ...aheadBudget };
}

function takeAheadBudget(): boolean {
  const budget = readAheadBudget();
  if (budget.count >= AHEAD_DAILY_LIMIT) return false;
  aheadBudget = { day: budget.day, count: budget.count + 1 };
  try {
    window.localStorage.setItem(AHEAD_STORAGE_KEY, JSON.stringify(aheadBudget));
  } catch {
    // Client-local budgets are best-effort in restricted WebViews.
  }
  return true;
}

interface QueuedJudge {
  targetKey: string;
  requestKey: string;
  start: () => void;
  drop: () => void;
}

let inflightJudges = 0;
let judgeQueue: QueuedJudge[] = [];

function isCurrent(entry: { targetKey: string; requestKey: string }): boolean {
  return pendingByTarget.get(entry.targetKey)?.requestKey === entry.requestKey;
}

function startJudge(entry: QueuedJudge): void {
  const pending = pendingByTarget.get(entry.targetKey);
  if (pending) pending.started = true;
  inflightJudges += 1;
  entry.start();
}

function runOrQueueJudge(entry: QueuedJudge): void {
  if (inflightJudges < MAX_INFLIGHT_JUDGES) {
    startJudge(entry);
    return;
  }
  judgeQueue.push(entry);
  while (judgeQueue.length > MAX_QUEUED_JUDGES) {
    const dropped = judgeQueue.shift();
    if (dropped && isCurrent(dropped)) {
      pendingByTarget.delete(dropped.targetKey);
      dropped.drop();
    }
  }
}

function releaseJudgeSlot(): void {
  inflightJudges = Math.max(0, inflightJudges - 1);
  while (inflightJudges < MAX_INFLIGHT_JUDGES) {
    const next = judgeQueue.shift();
    if (!next) return;
    if (!isCurrent(next)) continue;
    startJudge(next);
  }
}

function dropQueuedJudge(targetKey: string): void {
  judgeQueue = judgeQueue.filter((entry) => entry.targetKey !== targetKey);
}
let requestSequence = 1;
let active: ActiveSessionTarget | null = null;

function isEnabled(): boolean {
  return useSettingsStore.getState().replyDraftSuggestionsEnabled && useAiSettingsStore.getState().aiEnabled;
}

function modelHash(): string {
  const ai = useAiSettingsStore.getState();
  return `${ai.aiProvider}:${ai.aiModel.trim()}`;
}

function isProviderModelMismatch(): boolean {
  const ai = useAiSettingsStore.getState();
  return classifyModelForProvider(ai.aiProvider, ai.aiModel) === "likely-mismatch";
}

function emptySuggestion(status: BackgroundAiSuggestion["status"], requestKey: string, failureCode?: string): BackgroundAiSuggestion {
  return {
    status,
    requestKey,
    oneLine: "",
    completionAssessment: "",
    nextActions: [],
    ...(failureCode ? { failureCode } : {}),
  };
}

function tryParseJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function codeFromUnknown(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const code = (value as Record<string, unknown>).code;
  if (typeof code !== "string") return null;
  const trimmed = code.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function parseNextActionFailureCode(error: unknown): string {
  const candidates: unknown[] = [error];
  if (typeof error === "string") {
    candidates.push(tryParseJson(error));
  }
  if (error instanceof Error) {
    candidates.push(tryParseJson(error.message));
  }
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    candidates.push(record.error, record.payload, record.data);
    if (typeof record.message === "string") candidates.push(tryParseJson(record.message));
  }
  for (const candidate of candidates) {
    const code = codeFromUnknown(candidate);
    if (code) return code;
  }
  return "internal";
}

function normalizeAction(value: unknown): BackgroundAiAction | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const label = typeof record.label === "string" ? record.label.trim().slice(0, 160) : "";
  const prompt = typeof record.prompt === "string" ? record.prompt.trim().slice(0, 400) : "";
  return label && prompt ? { label, prompt } : null;
}

function normalizeResult(value: unknown): Pick<BackgroundAiSuggestion, "oneLine" | "completionAssessment" | "nextActions"> | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const oneLine = typeof record.oneLine === "string" ? record.oneLine.trim().slice(0, 360) : "";
  const completionAssessment = typeof record.completionAssessment === "string"
    ? record.completionAssessment.trim().slice(0, 360)
    : "";
  const nextActions = Array.isArray(record.nextActions)
    ? record.nextActions.map(normalizeAction).filter((action): action is BackgroundAiAction => action !== null).slice(0, 3)
    : [];
  return oneLine && completionAssessment ? { oneLine, completionAssessment, nextActions } : null;
}

function cancelPending(targetKey: string): void {
  const pending = pendingByTarget.get(targetKey);
  if (!pending) return;
  if (pending.timer !== null) clearTimeout(pending.timer);
  pendingByTarget.delete(targetKey);
  dropQueuedJudge(targetKey);
  // A judge that never started holds no slot and has nothing to abort.
  if (!pending.started) return;
  void Promise.resolve(invoke<boolean>("abort_next_action_judge", { requestId: pending.requestId })).catch(() => {});
}

function isActiveSessionEligible(target: ActiveSessionTarget): boolean {
  return !target.questionActive && ["done", "acknowledged", "idle", "noUpdate", "error"].includes(target.displayState);
}

function scheduleActiveSession(
  target: ActiveSessionTarget,
  { force = false, ahead = false }: { force?: boolean; ahead?: boolean } = {},
): void {
  const { sessionId } = target;
  if (!isEnabled()) {
    cancelPending(sessionId);
    useBackgroundAiSuggestionStore.getState().clear(sessionId);
    return;
  }
  if (!isActiveSessionEligible(target)) {
    cancelPending(sessionId);
    useBackgroundAiSuggestionStore.getState().clear(sessionId);
    return;
  }
  const requestKey = [sessionId, String(target.eventSeq), target.displayState, NEXT_ACTION_PROMPT_VERSION, modelHash()].join(":");
  const existing = useBackgroundAiSuggestionStore.getState().bySession[sessionId];
  if (!force && existing?.status === "ready" && existing.requestKey === requestKey) return;
  const current = pendingByTarget.get(sessionId);
  if (current?.requestKey === requestKey) return;
  cancelPending(sessionId);
  if (isProviderModelMismatch()) {
    useBackgroundAiSuggestionStore.getState().set(sessionId, emptySuggestion("failed", requestKey, "provider_model_mismatch"));
    return;
  }
  if (ahead && !takeAheadBudget()) return;
  const requestId = `next-action-${Date.now()}-${requestSequence++}`;
  const pending: PendingRequest = { requestId, requestKey, timer: null, started: false };
  pendingByTarget.set(sessionId, pending);
  useBackgroundAiSuggestionStore.getState().set(sessionId, emptySuggestion("loading", requestKey));
  pending.timer = setTimeout(() => {
    pending.timer = null;
    if (pendingByTarget.get(sessionId)?.requestKey !== requestKey || !isEnabled()) return;
    if (isProviderModelMismatch()) {
      pendingByTarget.delete(sessionId);
      useBackgroundAiSuggestionStore.getState().set(sessionId, emptySuggestion("failed", requestKey, "provider_model_mismatch"));
      return;
    }
    runOrQueueJudge({
      targetKey: sessionId,
      requestKey,
      drop: () => useBackgroundAiSuggestionStore.getState().clear(sessionId),
      start: () => {
    void invoke<unknown>("run_next_action_judge", {
      requestId,
      sessionId,
      cycleKey: `active:${sessionId}`,
      promptVersion: NEXT_ACTION_PROMPT_VERSION,
      purpose: NEXT_ACTION_PURPOSE,
      tabLabel: target.tabLabel,
      cwd: target.cwd,
    }).then((value) => {
      if (pendingByTarget.get(sessionId)?.requestKey !== requestKey || !isEnabled()) return;
      pendingByTarget.delete(sessionId);
      const result = normalizeResult(value);
      if (!result) {
        useBackgroundAiSuggestionStore.getState().set(sessionId, emptySuggestion("failed", requestKey, "invalid_output"));
        return;
      }
      useBackgroundAiSuggestionStore.getState().set(sessionId, { status: "ready", requestKey, ...result });
    }).catch((error) => {
      if (pendingByTarget.get(sessionId)?.requestKey !== requestKey) return;
      pendingByTarget.delete(sessionId);
      const failureCode = parseNextActionFailureCode(error);
      if (failureCode === "no_context") {
        useBackgroundAiSuggestionStore.getState().clear(sessionId);
        return;
      }
      useBackgroundAiSuggestionStore.getState().set(sessionId, emptySuggestion("failed", requestKey, failureCode));
    }).finally(() => releaseJudgeSlot());
      },
    });
  }, DEBOUNCE_MS);
}

export function observeActiveSession(target: ActiveSessionTarget | null): void {
  const previous = active;
  if (!target || target.sessionId !== previous?.sessionId) {
    // Leaving a session no longer cancels its judge. The result is keyed by
    // session, so finishing it turns the next visit into an instant one; the
    // in-flight cap, not the switch, is what bounds the work.
    active = target;
    if (!target) return;
  } else {
    active = target;
  }
  scheduleActiveSession(target);
}

/**
 * Sessions the reader can see but has not opened. Anything already ready,
 * loading or ineligible is skipped, so this only ever adds work for a session
 * that would otherwise make them wait on arrival.
 */
export function observeAheadSessions(targets: readonly ActiveSessionTarget[]): void {
  if (!isEnabled()) return;
  for (const target of targets) {
    if (target.sessionId === active?.sessionId) continue;
    if (!isActiveSessionEligible(target)) continue;
    if (pendingByTarget.has(target.sessionId)) continue;
    if (useBackgroundAiSuggestionStore.getState().bySession[target.sessionId]) continue;
    scheduleActiveSession(target, { ahead: true });
  }
}

export function retryActiveSession(): void {
  if (!active || !isEnabled() || !isActiveSessionEligible(active)) return;
  cancelPending(active.sessionId);
  useBackgroundAiSuggestionStore.getState().clear(active.sessionId);
  scheduleActiveSession(active, { force: true });
}

function scheduleReportSummary(report: ReportDispatchBatch): void {
  const batchId = report.batch.id;
  const targetKey = `report:${batchId}`;
  if (!isEnabled()) {
    cancelPending(targetKey);
    useBackgroundAiSuggestionStore.getState().clearReportSummary(batchId);
    return;
  }
  const cycleKey = `batch:${batchId}`;
  const revision = `${report.batch.transitionRevision}:${report.batch.publishedSummaryRevision}`;
  const requestKey = [batchId, cycleKey, revision, REPORT_SUMMARY_PURPOSE, REPORT_SUMMARY_PROMPT_VERSION, modelHash()].join(":");
  const current = pendingByTarget.get(targetKey);
  if (current?.requestKey === requestKey) return;
  cancelPending(targetKey);
  if (isProviderModelMismatch()) {
    useBackgroundAiSuggestionStore.getState().setReportSummary(batchId, emptySuggestion("failed", requestKey, "provider_model_mismatch"));
    return;
  }
  const requestId = `report-summary-${Date.now()}-${requestSequence++}`;
  const pending: PendingRequest = { requestId, requestKey, timer: null, started: false };
  pendingByTarget.set(targetKey, pending);
  useBackgroundAiSuggestionStore.getState().setReportSummary(batchId, emptySuggestion("loading", requestKey));
  pending.timer = setTimeout(() => {
    pending.timer = null;
    if (pendingByTarget.get(targetKey)?.requestKey !== requestKey || !isEnabled()) return;
    if (isProviderModelMismatch()) {
      pendingByTarget.delete(targetKey);
      useBackgroundAiSuggestionStore.getState().setReportSummary(batchId, emptySuggestion("failed", requestKey, "provider_model_mismatch"));
      return;
    }
    runOrQueueJudge({
      targetKey,
      requestKey,
      drop: () => useBackgroundAiSuggestionStore.getState().clearReportSummary(batchId),
      start: () => {
    void invoke<unknown>("run_next_action_judge", {
      requestId,
      sessionId: batchId,
      cycleKey,
      promptVersion: REPORT_SUMMARY_PROMPT_VERSION,
      purpose: REPORT_SUMMARY_PURPOSE,
      conversationExcerpt: reportBatchAiContext(report),
    }).then((value) => {
      if (pendingByTarget.get(targetKey)?.requestKey !== requestKey || !isEnabled()) return;
      pendingByTarget.delete(targetKey);
      const result = normalizeResult(value);
      if (!result) {
        useBackgroundAiSuggestionStore.getState().setReportSummary(batchId, emptySuggestion("failed", requestKey, "invalid_output"));
        return;
      }
      useBackgroundAiSuggestionStore.getState().setReportSummary(batchId, { status: "ready", requestKey, ...result });
    }).catch((error) => {
      if (pendingByTarget.get(targetKey)?.requestKey !== requestKey) return;
      pendingByTarget.delete(targetKey);
      useBackgroundAiSuggestionStore.getState().setReportSummary(batchId, emptySuggestion("failed", requestKey, parseNextActionFailureCode(error)));
    }).finally(() => releaseJudgeSlot());
      },
    });
  }, DEBOUNCE_MS);
}

let knownReportSummaryRevisions = new Map<string, number>(
  Object.values(useReportInboxStore.getState().dispatchBatchesById)
    .filter((report): report is ReportDispatchBatch => report !== undefined)
    .map((report) => [report.batch.id, report.batch.publishedSummaryRevision]),
);

useReportInboxStore.subscribe((state) => {
  // card.source !== "status": status cards no longer schedule next-action judges.
  for (const report of Object.values(state.dispatchBatchesById)) {
    if (!report) continue;
    const revision = report.batch.publishedSummaryRevision;
    if (knownReportSummaryRevisions.get(report.batch.id) === revision) continue;
    knownReportSummaryRevisions.set(report.batch.id, revision);
    if (revision > 0) scheduleReportSummary(report);
  }
});

useSettingsStore.subscribe((state, previous) => {
  if (state.replyDraftSuggestionsEnabled || !previous.replyDraftSuggestionsEnabled) return;
  for (const targetKey of pendingByTarget.keys()) cancelPending(targetKey);
  useBackgroundAiSuggestionStore.getState().reset();
});

useAiSettingsStore.subscribe((state, previous) => {
  if (state.aiEnabled || !previous.aiEnabled) return;
  for (const targetKey of pendingByTarget.keys()) cancelPending(targetKey);
  useBackgroundAiSuggestionStore.getState().reset();
});

export function __resetBackgroundAiSchedulerForTests(): void {
  for (const targetKey of [...pendingByTarget.keys()]) cancelPending(targetKey);
  judgeQueue = [];
  inflightJudges = 0;
  aheadBudget = { day: "", count: 0 };
  try {
    window.localStorage.removeItem(AHEAD_STORAGE_KEY);
  } catch {
    // Nothing to clean up when storage is unavailable.
  }
  knownReportSummaryRevisions = new Map(
    Object.values(useReportInboxStore.getState().dispatchBatchesById)
      .filter((report): report is ReportDispatchBatch => report !== undefined)
      .map((report) => [report.batch.id, report.batch.publishedSummaryRevision]),
  );
  requestSequence = 1;
  active = null;
  useBackgroundAiSuggestionStore.getState().reset();
}
