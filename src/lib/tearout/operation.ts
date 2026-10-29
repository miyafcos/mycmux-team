type Phase = "idle" | "moving" | "restoring";
let phase: Phase = "idle";
let phaseOwner: string | null = null;
export type TearoutRefusalSource = "band" | "pointer" | "phase" | "observed_move" | "incoming"
  | "backend_pre_ownership" | "backend_release" | "backend_transfer";
const operationStarts = new Set<() => void>();
export function subscribeTearoutOperationStart(listener: () => void): () => void {
  operationStarts.add(listener);
  return () => { operationStarts.delete(listener); };
}
const observedMoves = new Set<string>();
const finishedMoves = new Set<string>();
// A receiver's restored store is provisional until the source completes the
// transaction. Pointer-up and release escrow cleanup cannot unlock it.
const incomingTransfers = new Set<string>();
const displayActivity = new Set<string>();
const displayListeners = new Set<() => void>();
let displayBusy = false;
export const tearoutDisplayBusy = (): boolean => tearoutOperationBusy() || displayActivity.size > 0;
export const tearoutDisplayReasons = () => ({ phase, observedMoves: observedMoves.size,
  incomingTransfers: incomingTransfers.size, displayActivity: [...displayActivity].sort() });
export const incomingTearoutTokens = (): string[] => [...incomingTransfers];
function notifyDisplay(): void {
  const next = tearoutDisplayBusy();
  if (next === displayBusy) return;
  displayBusy = next;
  for (const listener of displayListeners) {
    try { listener(); }
    catch (error) { console.warn("[tearout] display listener failed", error); }
  }
}
export function subscribeTearoutDisplay(listener: () => void): () => void {
  displayListeners.add(listener);
  return () => { displayListeners.delete(listener); };
}
export function setTearoutDisplayActivity(key: string, active: boolean): void {
  if (active) displayActivity.add(key); else displayActivity.delete(key);
  notifyDisplay();
}
export function reserveIncomingTearout(token: string): void { incomingTransfers.add(token); notifyDisplay(); }
export function finishIncomingTearout(token: string): void { incomingTransfers.delete(token); notifyDisplay(); }

/** A local refusal made before this request owns or changes anything. */
export class LocalTearoutRefusal extends Error {
  constructor(public readonly phase: Exclude<Phase, "idle">,
    /** Presentation only; this does not grant or release transfer ownership. */
    public readonly reason: "overlap" | "reservation" = "overlap",
    public readonly source: TearoutRefusalSource = reason === "reservation" ? "incoming" : "phase",
    public readonly blockerId: string | null = null) { super("tearout_move_busy"); this.name = "LocalTearoutRefusal"; }
}
export const tearoutOperationPhase = (): Phase => phase !== "idle" ? phase : observedMoves.size || incomingTransfers.size ? "moving" : "idle";
export const tearoutOperationBusy = (): boolean => tearoutOperationPhase() !== "idle";
export function localTearoutRefusal(): LocalTearoutRefusal | null {
  const current = tearoutOperationPhase();
  return current === "idle" ? null : new LocalTearoutRefusal(current,
    current === "moving" && incomingTransfers.size ? "reservation" : "overlap",
    phase !== "idle" ? "phase" : observedMoves.size ? "observed_move" : "incoming",
    phase !== "idle" ? phaseOwner : (observedMoves.values().next().value ?? incomingTransfers.values().next().value ?? null));
}
// The child also sees moves started by another WebView. Receiver-only samples
// do not lock an unrelated window's local operations.
export function observeTearoutMove(sample: { id: string; label: string; source?: string; phase: "move" | "end"; release?: unknown; receiver?: string | null }, ownLabel: string): void {
  if (finishedMoves.has(sample.id)) return;
  if (sample.phase === "end" && sample.release && sample.receiver && (sample.label === ownLabel || sample.source === ownLabel)) observedMoves.add(sample.id);
  else if (sample.phase === "end") observedMoves.delete(sample.id);
  else if (sample.label === ownLabel || sample.source === ownLabel) observedMoves.add(sample.id);
  notifyDisplay();
}
export function finishObservedTearoutMove(id: string): void {
  observedMoves.delete(id); finishedMoves.add(id);
  if (finishedMoves.size > 64) finishedMoves.delete(finishedMoves.values().next().value!);
  notifyDisplay();
}
export function clearObservedTearoutMoves(): void { observedMoves.clear(); finishedMoves.clear(); notifyDisplay(); }
export function beginTearoutOperation(owner?: string): boolean {
  if (tearoutOperationBusy()) return false;
  phase = "moving";
  phaseOwner = owner ?? null;
  for (const listener of operationStarts) {
    try { listener(); } catch (error) { console.warn("[tearout] operation listener failed", error); }
  }
  notifyDisplay(); return true;
}
export function restoringTearoutOperation(): void { phase = "restoring"; notifyDisplay(); }
export function endTearoutOperation(): void { phase = "idle"; phaseOwner = null; notifyDisplay(); }
