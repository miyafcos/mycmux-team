// Wall-clock corrections of at least a minute start a new observation series.
// Smaller differences can be ordinary delayed responses; retain their ordering guard.
export const OBSERVATION_CLOCK_ROLLBACK_MS = 60_000;
export function observationClockRolledBack(observedAt: number | undefined, now: number): boolean {
  return observedAt !== undefined && observedAt - now >= OBSERVATION_CLOCK_ROLLBACK_MS;
}
