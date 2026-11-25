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
const EXCEPTION_COUNTERS = {
  "error": "count_exception_error",
  "type-error": "count_exception_type_error",
  "range-error": "count_exception_range_error",
  "unknown": "count_exception_unknown",
} as const;
const COUNT_KEYS = new Set<string>([
  ...Object.values(EVENT_COUNTERS), "count_dispose_failed", "count_budget_protected",
  "count_window_evicted", "count_tool_disclosure_evicted", ...Object.values(EXCEPTION_COUNTERS),
  ...REASONS.flatMap(reason => outcomes.map(event => `count_${reason}_${event}`)),
]);
const MAX_WINDOW_DETAILS = 16;
const MAX_DIAGNOSTIC_WINDOWS = 64;
const MAX_PENDING_DIAGNOSTICS = MAX_DIAGNOSTIC_WINDOWS;
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
let pendingSends = 0;
let overflowCounts: Record<string, number> | undefined;
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
function finishDiagnosticSend(): void {
  pendingSends--;
  if (!overflowCounts) return;
  const counts = overflowCounts;
  overflowCounts = undefined;
  sendDiagnostic(terminalDiagnosticPayload("renderer", "coalesced", "", counts));
}

function sendDiagnostic(diagnostic: ReturnType<typeof terminalDiagnosticPayload>, counter?: string): void {
  if (pendingSends >= MAX_PENDING_DIAGNOSTICS) {
    // Retain fixed counters while IPC is congested, without queuing payloads.
    const counts = overflowCounts ??= {};
    const added = counter === undefined ? diagnostic.numbers : { coalesced: 1, [counter]: 1 };
    const exception = diagnostic.exception;
    if (counter !== undefined && diagnostic.kind === "renderer" && exception && exception !== "none") {
      added[EXCEPTION_COUNTERS[exception]] = 1;
    }
    for (const [key, value] of Object.entries(added)) {
      counts[key] = Math.min(Number.MAX_SAFE_INTEGER, (counts[key] ?? 0) + value);
    }
    return;
  }
  pendingSends++;
  try { void invoke<void>("report_renderer_heartbeat", { diagnostic }).then(finishDiagnosticSend, finishDiagnosticSend); }
  catch { pendingSends--; }
}

function flushDiagnosticWindow(sessionId: string, evicted = false): void {
  const window = windows.get(sessionId);
  if (!window) return;
  clearTimeout(window.timer);
  windows.delete(sessionId);
  if (window.coalesced || evicted) {
    sendDiagnostic(terminalDiagnosticPayload("renderer", "coalesced", sessionId,
      { coalesced: window.coalesced, ...window.counts, ...(evicted ? { count_window_evicted: 1 } : {}) }));
  }
}

export function reportToolDisclosureEvictions(count: number): void {
  sendDiagnostic(terminalDiagnosticPayload("renderer", "coalesced", "", { count_tool_disclosure_evicted: count }));
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    for (const sessionId of windows.keys()) flushDiagnosticWindow(sessionId);
  });
}

export function reportTerminalDiagnostic(kind: DiagnosticKind, event: DiagnosticEvent, sessionId: string, term: object, numbers: Record<string, number> = {}, labels: DiagnosticLabels = {}): void {
  if (!EVENTS.has(event)) return;
  const reason = labels.reason && REASONS.includes(labels.reason) ? labels.reason : undefined;
  let counter: string = EVENT_COUNTERS[event];
  if (reason && outcomes.includes(event)) counter = `count_${reason}_${event}`;
  if (event === "dispose-result" && numbers.dispose_ok === 0) counter = "count_dispose_failed";
  if (event === "budget-denied" && numbers.budget_protected === 1) counter = "count_budget_protected";
  if (reason === "manual") {
    // The menu already rate-limits completed attempts.
    sendDiagnostic(terminalDiagnosticPayload(kind, event, sessionId, { ...numbers, term: terminalDiagnosticId(term) }, labels), counter);
    return;
  }
  const now = Date.now();
  let window = windows.get(sessionId);
  if (window && (now - window.started >= TERMINAL_DIAGNOSTIC_WINDOW_MS || now < window.started)) {
    flushDiagnosticWindow(sessionId);
    window = undefined;
  }
  if (!window) {
    if (windows.size >= MAX_DIAGNOSTIC_WINDOWS) flushDiagnosticWindow(windows.keys().next().value!, true);
    window = {
      started: now, emitted: new Set(), counts: {}, coalesced: 0,
      timer: setTimeout(() => flushDiagnosticWindow(sessionId), TERMINAL_DIAGNOSTIC_WINDOW_MS),
    };
    windows.set(sessionId, window);
  }

  const exception = labels.exception;
  const detailKey = kind === "renderer" && exception && exception !== "none" ? `${counter}:${exception}` : counter;
  if (window.emitted.size < MAX_WINDOW_DETAILS && !window.emitted.has(detailKey)) {
    window.emitted.add(detailKey);
    sendDiagnostic(terminalDiagnosticPayload(kind, event, sessionId, { ...numbers, term: terminalDiagnosticId(term) }, labels), counter);
    return;
  }
  window.counts[counter] = (window.counts[counter] ?? 0) + 1;
  window.coalesced += 1;
}
