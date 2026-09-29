/** Opt-in single-session flow diagnostics; never retains terminal/DOM objects. */
const SAMPLE_CAP = 1024;
const encoder = new TextEncoder();
let epoch = 0;
let current: ReturnType<typeof createTrace> | null = null;

function createTrace(sessionId: string) {
  return {
    sessionId, active: true, receivedBytes: 0, receivedBatches: 0, resyncBatches: 0,
    writeCalls: 0, writeInputBytes: 0, completedWrites: 0, pendingWrites: 0, pendingWriteBytes: 0,
    renderCalls: 0, firstReceiveAtMs: 0, lastReceiveAtMs: 0,
    firstWriteAtMs: 0, lastWriteCallbackAtMs: 0, lastRenderAtMs: 0,
    callbackTotalMs: 0, callbackMaxMs: 0, samples: [] as number[],
  };
}

const clock = () => performance.timeOrigin + performance.now();
const accepts = (sessionId: string) => current?.active && current.sessionId === sessionId;

export function setTerminalFlowTrace(sessionId: string | null): void {
  epoch += 1;
  if (sessionId === null) { if (current) current.active = false; return; }
  current = createTrace(sessionId);
}

export function recordTerminalFlowReceive(sessionId: string, bytes: number, resync: boolean): void {
  if (!accepts(sessionId)) return;
  const trace = current!;
  const at = clock();
  trace.receivedBytes += bytes;
  trace.receivedBatches += 1;
  if (resync) trace.resyncBatches += 1;
  if (!trace.firstReceiveAtMs) trace.firstReceiveAtMs = at;
  trace.lastReceiveAtMs = at;
}

interface WriteToken { epoch: number; atMs: number; bytes: number }
export function startTerminalFlowWrite(sessionId: string, output: string | Uint8Array): WriteToken | null {
  if (!accepts(sessionId)) return null;
  const trace = current!;
  const bytes = typeof output === "string" ? encoder.encode(output).byteLength : output.byteLength;
  const atMs = clock();
  trace.writeCalls += 1;
  trace.writeInputBytes += bytes;
  trace.pendingWrites += 1;
  trace.pendingWriteBytes += bytes;
  if (!trace.firstWriteAtMs) trace.firstWriteAtMs = atMs;
  return { epoch, atMs, bytes };
}

export function finishTerminalFlowWrite(token: WriteToken | null): void {
  if (!token || !current?.active || token.epoch !== epoch) return;
  // Finish is called once by writeTerminalOutput's existing callback guard.
  const at = clock(), duration = Math.max(0, at - token.atMs);
  current.completedWrites += 1;
  current.pendingWrites = Math.max(0, current.pendingWrites - 1);
  current.pendingWriteBytes = Math.max(0, current.pendingWriteBytes - token.bytes);
  current.lastWriteCallbackAtMs = at;
  current.callbackTotalMs += duration;
  current.callbackMaxMs = Math.max(current.callbackMaxMs, duration);
  const index = (current.completedWrites - 1) % SAMPLE_CAP;
  current.samples[index] = duration;
}

export function recordTerminalFlowRender(sessionId: string): void {
  if (!accepts(sessionId)) return;
  current!.renderCalls += 1;
  current!.lastRenderAtMs = clock();
}

export function readTerminalFlowTrace() {
  if (!current) return null;
  const { samples, ...trace } = current;
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (p: number) => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null;
  return { ...trace, retainedCallbackSamples: sorted.length,
    callbackMedianMs: percentile(0.5), callbackP90Ms: percentile(0.9) };
}
