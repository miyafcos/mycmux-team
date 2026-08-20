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
}

const pendingByTarget = new Map<string, PendingRequest>();
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
  void Promise.resolve(invoke<boolean>("abort_next_action_judge", { requestId: pending.requestId })).catch(() => {});
}

function isActiveSessionEligible(target: ActiveSessionTarget): boolean {
  return !target.questionActive && ["done", "acknowledged", "idle", "noUpdate", "error"].includes(target.displayState);
}

function scheduleActiveSession(target: ActiveSessionTarget, { force = false }: { force?: boolean } = {}): void {
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
  const requestId = `next-action-${Date.now()}-${requestSequence++}`;
  const pending: PendingRequest = { requestId, requestKey, timer: null };
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
    });
  }, DEBOUNCE_MS);
}

export function observeActiveSession(target: ActiveSessionTarget | null): void {
  const previous = active;
  if (!target || target.sessionId !== previous?.sessionId) {
    if (previous) {
      cancelPending(previous.sessionId);
      if (useBackgroundAiSuggestionStore.getState().bySession[previous.sessionId]?.status === "loading") {
        useBackgroundAiSuggestionStore.getState().clear(previous.sessionId);
      }
    }
    active = target;
    if (!target) return;
  } else {
    active = target;
  }
  scheduleActiveSession(target);
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
  const pending: PendingRequest = { requestId, requestKey, timer: null };
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
  knownReportSummaryRevisions = new Map(
    Object.values(useReportInboxStore.getState().dispatchBatchesById)
      .filter((report): report is ReportDispatchBatch => report !== undefined)
      .map((report) => [report.batch.id, report.batch.publishedSummaryRevision]),
  );
  requestSequence = 1;
  active = null;
  useBackgroundAiSuggestionStore.getState().reset();
}
