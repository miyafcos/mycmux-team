import { create } from "zustand";

interface TerminalObservationState {
  observed: ReadonlySet<string>;
  markObserved: (id: string) => void;
  markUnobserved: (id: string) => void;
}

export const useTerminalObservationStore = create<TerminalObservationState>((set) => ({
  observed: new Set<string>(),
  markObserved: (id) => set((state) => {
    if (state.observed.has(id)) return state;
    return { observed: new Set(state.observed).add(id) };
  }),
  markUnobserved: (id) => set((state) => {
    if (!state.observed.has(id)) return state;
    const observed = new Set(state.observed);
    observed.delete(id);
    return { observed };
  }),
}));

/** Already received output; consumers never run in the PTY delivery callback. */
export interface TerminalOutputObservation {
  sessionId: string;
  epoch: number;
  startOffset: number;
  endOffset: number;
  data: Uint8Array | ArrayBuffer | readonly number[];
  baseline?: boolean;
  source?: "live" | "snapshot";
}
export type ObservedTerminalOutput = Omit<TerminalOutputObservation, "data"> & { data: Uint8Array; frameEndOffset: number };
const outputObservers = new Set<(output: ObservedTerminalOutput) => void>();
const pendingOutput: { event: TerminalOutputObservation; offset: number; bytes?: Uint8Array }[] = [];
const OUTPUT_QUEUE_BYTES = 512 * 1024;
const OUTPUT_CHUNK_BYTES = 32 * 1024;
let pendingBytes = 0;
let outputTimer: ReturnType<typeof setTimeout> | undefined;

function flushOutputObservations(): void {
  outputTimer = undefined;
  const started = performance.now();
  // Keep work away from transport/ACK and yield between chunks on busy terminals.
  while (pendingOutput.length && outputObservers.size && performance.now() - started < 3) {
    const pending = pendingOutput[0], event = pending.event;
    pending.bytes ??= event.baseline ? new Uint8Array() : event.data instanceof Uint8Array ? event.data
      : event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : Uint8Array.from(event.data);
    const end = Math.min(pending.bytes.length, pending.offset + OUTPUT_CHUNK_BYTES);
    const output: ObservedTerminalOutput = { ...event, frameEndOffset: event.endOffset,
      startOffset: event.baseline ? event.endOffset : event.startOffset + pending.offset,
      endOffset: event.baseline ? event.endOffset : event.startOffset + end,
      data: pending.bytes.subarray(pending.offset, end) };
    pendingBytes -= end - pending.offset;
    pending.offset = end;
    if (end === pending.bytes.length) pendingOutput.shift();
    for (const observer of outputObservers) {
      try { observer(output); } catch { /* An optional visual must not disrupt terminal delivery. */ }
    }
  }
  if (pendingOutput.length && outputObservers.size) outputTimer = setTimeout(flushOutputObservations, 0);
}

export function queueTerminalOutputObservation(event: TerminalOutputObservation): void {
  if (!outputObservers.size) return;
  const size = event.baseline ? 0 : event.data instanceof ArrayBuffer ? event.data.byteLength : event.data.length;
  pendingOutput.push({ event, offset: 0 });
  pendingBytes += size;
  while (pendingOutput.length > 1 && (pendingOutput.length > 64 || pendingBytes > OUTPUT_QUEUE_BYTES)) {
    const removed = pendingOutput.shift()!;
    const length = removed.event.baseline ? 0 : removed.event.data instanceof ArrayBuffer
      ? removed.event.data.byteLength : removed.event.data.length;
    pendingBytes -= length - removed.offset;
  }
  if (outputTimer === undefined) outputTimer = setTimeout(flushOutputObservations, 32);
}

export function subscribeTerminalOutputObservations(observer: (output: ObservedTerminalOutput) => void): () => void {
  outputObservers.add(observer);
  return () => {
    outputObservers.delete(observer);
    if (!outputObservers.size) {
      if (outputTimer !== undefined) clearTimeout(outputTimer);
      outputTimer = undefined; pendingOutput.length = 0; pendingBytes = 0;
    }
  };
}
