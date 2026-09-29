export const PAINT_REASONS = [
  "pty-batch",
  "resync",
  "resize",
  "tab-switch",
  "scroll",
  "scan",
  "settings",
  "focus-change",
] as const;

export type PaintReason = (typeof PAINT_REASONS)[number];
export type TerminalRenderer = "dom" | "webgl";

export interface ValueDistributionSnapshot {
  count: number;
  total: number;
  min: number | null;
  max: number | null;
  avg: number | null;
}

export interface LatencyDistributionSnapshot extends ValueDistributionSnapshot {
  p50: number | null;
  p95: number | null;
  retainedSamples: number;
}

export interface PaintStatsSnapshot {
  startedAt: string;
  counts: Record<PaintReason, number>;
  layers: {
    inputParse: {
      ptyReceivedBytes: number;
      batchBytes: ValueDistributionSnapshot;
      writeCalls: number;
      writeCallbackMs: LatencyDistributionSnapshot;
      pendingBytes: number;
      maxPendingBytes: number;
      onWriteParsedCalls: number;
    };
    render: {
      onRenderCalls: number;
      renderedRows: number;
      fullScreenRenders: number;
      renderer: TerminalRenderer | "mixed" | null;
      rendererCounts: Record<TerminalRenderer, number>;
      webglContextLosses: number;
    };
    surrounding: {
      approvalScanMs: ValueDistributionSnapshot;
      resyncBytes: number;
      resyncMs: ValueDistributionSnapshot;
      reactCommits: number;
      mountedXterms: number;
      cursorBlinkingXterms: number;
      focusedXterms: number;
      documentFocused: boolean | null;
      documentVisibility: DocumentVisibilityState | null;
    };
  };
}

export interface TerminalWriteMeasurement {
  id: number;
  sessionId: string;
  byteLength: number;
  startedAtMs: number;
}

type MutableDistribution = {
  count: number;
  total: number;
  min: number | null;
  max: number | null;
};

const MAX_LATENCY_SAMPLES = 4096;
const textEncoder = new TextEncoder();

function emptyCounts(): Record<PaintReason, number> {
  return Object.fromEntries(PAINT_REASONS.map((reason) => [reason, 0])) as Record<PaintReason, number>;
}

function emptyDistribution(): MutableDistribution {
  return { count: 0, total: 0, min: null, max: null };
}

function addValue(target: MutableDistribution, value: number): void {
  if (!Number.isFinite(value) || value < 0) return;
  target.count += 1;
  target.total += value;
  target.min = target.min === null ? value : Math.min(target.min, value);
  target.max = target.max === null ? value : Math.max(target.max, value);
}

function distributionSnapshot(source: MutableDistribution): ValueDistributionSnapshot {
  return {
    count: source.count,
    total: source.total,
    min: source.min,
    max: source.max,
    avg: source.count > 0 ? source.total / source.count : null,
  };
}

function percentile(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(sorted.length * fraction));
  return sorted[Math.min(sorted.length - 1, rank - 1)];
}

function latencySnapshot(
  source: MutableDistribution,
  samples: readonly number[],
): LatencyDistributionSnapshot {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    ...distributionSnapshot(source),
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    retainedSamples: samples.length,
  };
}

function validByteLength(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

let startedAt = new Date().toISOString();
let counts = emptyCounts();
let ptyReceivedBytes = 0;
let batchBytes = emptyDistribution();
let writeCalls = 0;
let pendingBytes = 0;
let maxPendingBytes = 0;
let writeCallbackMs = emptyDistribution();
let writeCallbackSamples: number[] = [];
let writeCallbackSampleCursor = 0;
let onWriteParsedCalls = 0;
let onRenderCalls = 0;
let renderedRows = 0;
let fullScreenRenders = 0;
let webglContextLosses = 0;
let approvalScanMs = emptyDistribution();
let resyncBytes = 0;
let resyncMs = emptyDistribution();
let reactCommits = 0;
let measurementSessionScope: string | null = null;
let nextWriteMeasurementId = 1;
const activeWriteMeasurements = new Map<number, TerminalWriteMeasurement>();

// Gauges intentionally survive reset: resetting a measurement window must not
// make already-mounted terminals or their current renderer disappear.
const mountedXterms = new Set<string>();
const rendererBySession = new Map<string, TerminalRenderer>();
const focusedXterms = new Set<string>();
const cursorBlinkBySession = new Map<string, boolean>();

function acceptsSession(sessionId?: string): boolean {
  return measurementSessionScope === null || sessionId === measurementSessionScope;
}

export function setPaintStatsSessionScope(sessionId: string | null): void {
  if (!import.meta.env.DEV) return;
  measurementSessionScope = sessionId;
}

export function bump(reason: PaintReason, sessionId?: string): void {
  if (!import.meta.env.DEV || !acceptsSession(sessionId)) return;
  counts[reason] += 1;
}

export function recordPtyBatch(byteLength: number, sessionId?: string): void {
  if (!import.meta.env.DEV || !acceptsSession(sessionId)) return;
  const bytes = validByteLength(byteLength);
  ptyReceivedBytes += bytes;
  addValue(batchBytes, bytes);
}

export function terminalWriteByteLength(data: string | Uint8Array): number {
  if (!import.meta.env.DEV) return 0;
  return typeof data === "string" ? textEncoder.encode(data).byteLength : data.byteLength;
}

export function recordTerminalWriteStart(
  sessionId: string,
  byteLength: number,
): TerminalWriteMeasurement | null {
  if (!import.meta.env.DEV || !acceptsSession(sessionId)) return null;
  const bytes = validByteLength(byteLength);
  writeCalls += 1;
  pendingBytes += bytes;
  maxPendingBytes = Math.max(maxPendingBytes, pendingBytes);
  const measurement = {
    id: nextWriteMeasurementId,
    sessionId,
    byteLength: bytes,
    startedAtMs: performance.now(),
  };
  nextWriteMeasurementId += 1;
  activeWriteMeasurements.set(measurement.id, measurement);
  return measurement;
}

export function recordTerminalWriteCallback(measurement: TerminalWriteMeasurement | null): void {
  if (!import.meta.env.DEV || measurement === null) return;
  if (activeWriteMeasurements.get(measurement.id) !== measurement) return;
  activeWriteMeasurements.delete(measurement.id);
  pendingBytes = Math.max(0, pendingBytes - measurement.byteLength);
  const duration = performance.now() - measurement.startedAtMs;
  if (!Number.isFinite(duration) || duration < 0) return;
  addValue(writeCallbackMs, duration);
  if (writeCallbackSamples.length < MAX_LATENCY_SAMPLES) {
    writeCallbackSamples.push(duration);
  } else {
    writeCallbackSamples[writeCallbackSampleCursor] = duration;
    writeCallbackSampleCursor = (writeCallbackSampleCursor + 1) % MAX_LATENCY_SAMPLES;
  }
}

export function recordWriteParsed(sessionId?: string): void {
  if (!import.meta.env.DEV || !acceptsSession(sessionId)) return;
  onWriteParsedCalls += 1;
}

export function recordRender(
  startRow: number,
  endRow: number,
  terminalRows: number,
  sessionId?: string,
): void {
  if (!import.meta.env.DEV || !acceptsSession(sessionId)) return;
  const rows = Math.max(0, Math.floor(endRow) - Math.floor(startRow) + 1);
  onRenderCalls += 1;
  renderedRows += rows;
  if (startRow === 0 && terminalRows > 0 && endRow >= terminalRows - 1) {
    fullScreenRenders += 1;
  }
}

export function recordRenderer(sessionId: string, renderer: TerminalRenderer): void {
  if (!import.meta.env.DEV || !sessionId) return;
  rendererBySession.set(sessionId, renderer);
}

export function recordWebglContextLoss(sessionId?: string): void {
  if (!import.meta.env.DEV || !acceptsSession(sessionId)) return;
  webglContextLosses += 1;
}

export function recordApprovalScan(durationMs: number, sessionId?: string): void {
  if (!import.meta.env.DEV || !acceptsSession(sessionId)) return;
  addValue(approvalScanMs, durationMs);
}

export function recordResync(byteLength: number, durationMs: number, sessionId?: string): void {
  if (!import.meta.env.DEV || !acceptsSession(sessionId)) return;
  resyncBytes += validByteLength(byteLength);
  addValue(resyncMs, durationMs);
}

export function recordReactCommit(): void {
  if (!import.meta.env.DEV || measurementSessionScope !== null) return;
  reactCommits += 1;
}

export function recordXtermMounted(sessionId: string): void {
  if (!import.meta.env.DEV || !sessionId) return;
  mountedXterms.add(sessionId);
}

export function recordXtermUnmounted(sessionId: string): void {
  if (!import.meta.env.DEV || !sessionId) return;
  mountedXterms.delete(sessionId);
  rendererBySession.delete(sessionId);
  focusedXterms.delete(sessionId);
  cursorBlinkBySession.delete(sessionId);
  for (const [id, measurement] of activeWriteMeasurements) {
    if (measurement.sessionId !== sessionId) continue;
    pendingBytes = Math.max(0, pendingBytes - measurement.byteLength);
    activeWriteMeasurements.delete(id);
  }
}

export function recordXtermFocus(sessionId: string, focused: boolean): void {
  if (!import.meta.env.DEV || !sessionId) return;
  if (focused) focusedXterms.add(sessionId);
  else focusedXterms.delete(sessionId);
}

export function recordCursorBlink(sessionId: string, enabled: boolean): void {
  if (!import.meta.env.DEV || !sessionId) return;
  cursorBlinkBySession.set(sessionId, enabled);
}

export function snapshot(): PaintStatsSnapshot {
  const rendererCounts: Record<TerminalRenderer, number> = { dom: 0, webgl: 0 };
  for (const renderer of rendererBySession.values()) rendererCounts[renderer] += 1;
  const renderer = rendererCounts.dom > 0 && rendererCounts.webgl > 0
    ? "mixed"
    : rendererCounts.webgl > 0
      ? "webgl"
      : rendererCounts.dom > 0
        ? "dom"
        : null;

  return {
    startedAt,
    counts: { ...counts },
    layers: {
      inputParse: {
        ptyReceivedBytes,
        batchBytes: distributionSnapshot(batchBytes),
        writeCalls,
        writeCallbackMs: latencySnapshot(writeCallbackMs, writeCallbackSamples),
        pendingBytes,
        maxPendingBytes,
        onWriteParsedCalls,
      },
      render: {
        onRenderCalls,
        renderedRows,
        fullScreenRenders,
        renderer,
        rendererCounts: { ...rendererCounts },
        webglContextLosses,
      },
      surrounding: {
        approvalScanMs: distributionSnapshot(approvalScanMs),
        resyncBytes,
        resyncMs: distributionSnapshot(resyncMs),
        reactCommits,
        mountedXterms: mountedXterms.size,
        cursorBlinkingXterms: [...cursorBlinkBySession.values()].filter(Boolean).length,
        focusedXterms: focusedXterms.size,
        documentFocused: typeof document === "undefined" ? null : document.hasFocus(),
        documentVisibility: typeof document === "undefined" ? null : document.visibilityState,
      },
    },
  };
}

export function reset(): void {
  startedAt = new Date().toISOString();
  counts = emptyCounts();
  ptyReceivedBytes = 0;
  batchBytes = emptyDistribution();
  writeCalls = 0;
  pendingBytes = 0;
  activeWriteMeasurements.clear();
  maxPendingBytes = 0;
  writeCallbackMs = emptyDistribution();
  writeCallbackSamples = [];
  writeCallbackSampleCursor = 0;
  onWriteParsedCalls = 0;
  onRenderCalls = 0;
  renderedRows = 0;
  fullScreenRenders = 0;
  webglContextLosses = 0;
  approvalScanMs = emptyDistribution();
  resyncBytes = 0;
  resyncMs = emptyDistribution();
  reactCommits = 0;
}

declare global {
  interface Window {
    __mycmuxPaintStats?: typeof snapshot;
    __mycmuxPaintStatsReset?: typeof reset;
  }
}

if (typeof window !== "undefined" && import.meta.env.DEV) {
  window.__mycmuxPaintStats = snapshot;
  window.__mycmuxPaintStatsReset = reset;
}
