type Phase = "idle" | "moving" | "restoring";
let phase: Phase = "idle";
const observedMoves = new Set<string>();
const finishedMoves = new Set<string>();
// A receiver's restored store is provisional until the source completes the
// transaction. Pointer-up and release escrow cleanup cannot unlock it.
const incomingTransfers = new Set<string>();
export function reserveIncomingTearout(token: string): void { incomingTransfers.add(token); }
export function finishIncomingTearout(token: string): void { incomingTransfers.delete(token); }

/** A local refusal made before this request owns or changes anything. */
export class LocalTearoutRefusal extends Error {
  constructor(public readonly phase: Exclude<Phase, "idle">,
    /** Presentation only; this does not grant or release transfer ownership. */
    public readonly reason: "overlap" | "reservation" = "overlap") { super("tearout_move_busy"); this.name = "LocalTearoutRefusal"; }
}
export const tearoutOperationPhase = (): Phase => phase !== "idle" ? phase : observedMoves.size || incomingTransfers.size ? "moving" : "idle";
export const tearoutOperationBusy = (): boolean => tearoutOperationPhase() !== "idle";
export function localTearoutRefusal(): LocalTearoutRefusal | null {
  const current = tearoutOperationPhase();
  return current === "idle" ? null : new LocalTearoutRefusal(current,
    current === "moving" && incomingTransfers.size ? "reservation" : "overlap");
}
// The child also sees moves started by another WebView. Receiver-only samples
// do not lock an unrelated window's local operations.
export function observeTearoutMove(sample: { id: string; label: string; source?: string; phase: "move" | "end"; release?: unknown; receiver?: string | null }, ownLabel: string): void {
  if (finishedMoves.has(sample.id)) return;
  if (sample.phase === "end" && sample.release && sample.receiver && (sample.label === ownLabel || sample.source === ownLabel)) observedMoves.add(sample.id);
  else if (sample.phase === "end") observedMoves.delete(sample.id);
  else if (sample.label === ownLabel || sample.source === ownLabel) observedMoves.add(sample.id);
}
export function finishObservedTearoutMove(id: string): void {
  observedMoves.delete(id); finishedMoves.add(id);
  if (finishedMoves.size > 64) finishedMoves.delete(finishedMoves.values().next().value!);
}
export function clearObservedTearoutMoves(): void { observedMoves.clear(); finishedMoves.clear(); }
export function beginTearoutOperation(): boolean { if (tearoutOperationBusy()) return false; phase = "moving"; return true; }
export function restoringTearoutOperation(): void { phase = "restoring"; }
export function endTearoutOperation(): void { phase = "idle"; }
