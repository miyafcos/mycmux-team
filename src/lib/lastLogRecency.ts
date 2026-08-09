// Picking the one log line a multi-session row gets to show.
//
// The sidebar workspace row has room for a single last-log preview but a
// workspace holds many tabs. Scanning the tabs and keeping "whichever came last
// in iteration order" showed the line of the last tab in the layout, not the
// line that was actually written most recently — a background tab that had been
// silent for an hour could out-rank the agent that just spoke.

export interface LastLogCandidate {
  /** The session's current last log line, if it has one. */
  line: string | undefined;
  /** `paneMetadataStore.lastLogAt` for that session, if it has been recorded. */
  at: number | undefined;
}

/**
 * The most recently written line among `candidates`, or undefined when none of
 * them has a line.
 *
 * Candidates without a timestamp rank below every timestamped one (a session
 * whose line predates the timestamp slice cannot claim to be the newest), and
 * ties keep the later candidate, which preserves the previous last-wins
 * behaviour for the untimestamped case.
 */
export function pickMostRecentLastLog(
  candidates: readonly LastLogCandidate[],
): string | undefined {
  let best: string | undefined;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    if (!candidate.line) continue;
    const at = candidate.at ?? Number.NEGATIVE_INFINITY;
    if (best !== undefined && at < bestAt) continue;
    best = candidate.line;
    bestAt = at;
  }
  return best;
}
