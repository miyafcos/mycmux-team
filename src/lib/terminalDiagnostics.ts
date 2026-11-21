import { invoke } from "@tauri-apps/api/core";

export type DiagnosticKind = "renderer" | "progress" | "recovery";
const EVENT_COUNTERS = {
  "context-loss": "count_context_loss",
  "budget-evict": "count_budget_evict",
  "budget-denied": "count_budget_dispose_failed",
  "dispose-result": "count_dispose_result",
  retry: "count_retry",
  exhausted: "count_exhausted",
  "fallback-ready": "count_fallback_ready",
  stall: "count_stall",
  start: "count_start",
  end: "count_end",
  failed: "count_failed",
  aborted: "count_aborted",
} as const;
export type DiagnosticEvent = keyof typeof EVENT_COUNTERS;
const REASONS = ["paint", "manual", "channel"] as const;
export type RecoveryReason = typeof REASONS[number];
const outcomes = ["start", "end", "failed", "aborted", "stall"];
const COUNT_KEYS = new Set<string>([
  ...Object.values(EVENT_COUNTERS), "count_dispose_failed", "count_budget_protected",
  ...REASONS.flatMap(reason => outcomes.map(event => `count_${reason}_${event}`)),
]);
const MAX_WINDOW_DETAILS = 16;
export type RendererKind = "auto" | "webgl" | "dom" | "unknown";
const METRICS = new Set(["term", "visible", "focused", "budget", "victim", "requester", "attempt", "dom_ready", "dispose_ok",
  "budget_protected", "generation", "received_end", "parsed_end", "reused", "observed_at_ms", "coalesced"]);
const EVENTS = new Set(Object.keys(EVENT_COUNTERS));
const RENDERERS = new Set<RendererKind>(["auto", "webgl", "dom", "unknown"]);
export type DiagnosticLabels = { requested?: RendererKind; actual?: RendererKind; reason?: RecoveryReason; exception?: "none" | "error" | "type-error" | "range-error" | "unknown" };
const ids = new WeakMap<object, number>();
export const TERMINAL_DIAGNOSTIC_WINDOW_MS = 120_000;
type DiagnosticWindow = {
  started: number;
  emitted: Set<string>;
  counts: Record<string, number>;
  coalesced: number;
  timer: ReturnType<typeof setTimeout>;
};
// Remounting a display does not reset its diagnostic allowance.
const windows = new Map<string, DiagnosticWindow>();
let nextId = 0;
export function terminalDiagnosticId(term: object): number {
  let id = ids.get(term);
  if (id === undefined) { id = ++nextId; ids.set(term, id); }
  return id;
}
export function diagnosticException(error: unknown): NonNullable<DiagnosticLabels["exception"]> {
  if (error instanceof TypeError) return "type-error";
  if (error instanceof RangeError) return "range-error";
  if (error instanceof Error) return "error";
  return "unknown";
}
/** Copy only fixed enums and bounded numeric metadata, never terminal content. */
export function terminalDiagnosticPayload(kind: DiagnosticKind, event: DiagnosticEvent | "coalesced", sessionId: string, numbers: Record<string, number>, labels: DiagnosticLabels = {}) {
  const safeNumbers: Record<string, number> = {};
  for (const [key, value] of Object.entries(numbers)) {
    const allowed = event === "coalesced" ? key === "coalesced" || COUNT_KEYS.has(key) : METRICS.has(key);
    if (allowed && Number.isSafeInteger(value) && value >= 0) safeNumbers[key] = value;
  }
  const tab = /^pty-[a-z0-9-]+-([a-f0-9]{8})-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.exec(sessionId);
  const short = tab?.[1] ?? (/^[a-f0-9-]{8,}$/i.test(sessionId) ? sessionId.replaceAll("-", "").slice(0, 8) : "");
  return {
    kind, event: event === "coalesced" || EVENTS.has(event) ? event : "failed",
    session: short.length === 8 ? short.toLowerCase() : "unknown",
    numbers: safeNumbers,
    requested: labels.requested && RENDERERS.has(labels.requested) ? labels.requested : "unknown",
    actual: labels.actual && RENDERERS.has(labels.actual) ? labels.actual : "unknown",
    reason: labels.reason && REASONS.includes(labels.reason) ? labels.reason : undefined,
    exception: ["none", "error", "type-error", "range-error", "unknown"].includes(labels.exception ?? "") ? labels.exception : "none",
  };
}
function sendDiagnostic(diagnostic: ReturnType<typeof terminalDiagnosticPayload>): void {
  try { void invoke<void>("report_renderer_heartbeat", { diagnostic }).catch(() => {}); }
  catch { /* Optional diagnostics cannot interfere with output. */ }
}

function flushDiagnosticWindow(sessionId: string): void {
  const window = windows.get(sessionId);
  if (!window) return;
  clearTimeout(window.timer);
  windows.delete(sessionId);
  if (window.coalesced) {
    sendDiagnostic(terminalDiagnosticPayload("renderer", "coalesced", sessionId,
      { coalesced: window.coalesced, ...window.counts }));
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    for (const sessionId of windows.keys()) flushDiagnosticWindow(sessionId);
  });
}

export function reportTerminalDiagnostic(kind: DiagnosticKind, event: DiagnosticEvent, sessionId: string, term: object, numbers: Record<string, number> = {}, labels: DiagnosticLabels = {}): void {
  if (!EVENTS.has(event)) return;
  if (labels.reason === "manual") {
    // The menu rate-limits completed attempts, each of which gets one line.
    sendDiagnostic(terminalDiagnosticPayload(kind, event, sessionId, { ...numbers, term: terminalDiagnosticId(term) }, labels));
    return;
  }
  const now = Date.now();
  let window = windows.get(sessionId);
  if (window && (now - window.started >= TERMINAL_DIAGNOSTIC_WINDOW_MS || now < window.started)) {
    flushDiagnosticWindow(sessionId);
    window = undefined;
  }
  if (!window) {
    window = {
      started: now, emitted: new Set(), counts: {}, coalesced: 0,
      timer: setTimeout(() => flushDiagnosticWindow(sessionId), TERMINAL_DIAGNOSTIC_WINDOW_MS),
    };
    windows.set(sessionId, window);
  }

  const reason = labels.reason && REASONS.includes(labels.reason) ? labels.reason : undefined;
  let counter: string = EVENT_COUNTERS[event];
  if (reason && outcomes.includes(event)) counter = `count_${reason}_${event}`;
  if (event === "dispose-result" && numbers.dispose_ok === 0) counter = "count_dispose_failed";
  if (event === "budget-denied" && numbers.budget_protected === 1) counter = "count_budget_protected";
  if (window.emitted.size < MAX_WINDOW_DETAILS && !window.emitted.has(counter)) {
    window.emitted.add(counter);
    sendDiagnostic(terminalDiagnosticPayload(kind, event, sessionId, { ...numbers, term: terminalDiagnosticId(term) }, labels));
    return;
  }
  window.counts[counter] = (window.counts[counter] ?? 0) + 1;
  window.coalesced += 1;
}
