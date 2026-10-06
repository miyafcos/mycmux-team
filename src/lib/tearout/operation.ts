let phase: "idle" | "moving" | "restoring" = "idle";
export const tearoutOperationPhase = (): typeof phase => phase;
export const tearoutOperationBusy = (): boolean => phase !== "idle";
export function beginTearoutOperation(): boolean { if (tearoutOperationBusy()) return false; phase = "moving"; return true; }
export function restoringTearoutOperation(): void { phase = "restoring"; }
export function endTearoutOperation(): void { phase = "idle"; }
