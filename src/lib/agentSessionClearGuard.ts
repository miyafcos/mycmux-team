// Guards the clearing of persisted agent-session markers (claudeSessionId /
// agentKind / agentSessionId) against transient misdetection.
//
// The Rust monitor's deepest-child heuristic can report a plain shell while
// an agent is merely running a tool subprocess; a single such observation
// used to permanently delete the persisted markers, which broke session
// restore and hid the publish button. Markers may only be cleared once the
// plain-shell state has persisted for a full polling window (the monitor
// polls every 5s), i.e. at least two consecutive ticks.
//
// Time-based (not count-based) so that multiple observers of the same tick
// (the live pty_metadata listener and the pre-save metadata snapshot flush)
// cannot double-count one observation into a spurious clear.
const SHELL_CONFIRM_MS = 8_000;

const shellSince = new Map<string, number>();

/**
 * Record one metadata observation for a session. Returns true only when the
 * pane has been observed as a plain shell (no agent detected) continuously
 * for at least SHELL_CONFIRM_MS — the caller may then clear agent markers.
 */
export function confirmShellObservation(
  sessionId: string,
  isPlainShell: boolean,
  now: number = Date.now(),
): boolean {
  if (!isPlainShell) {
    shellSince.delete(sessionId);
    return false;
  }
  const since = shellSince.get(sessionId);
  if (since === undefined) {
    shellSince.set(sessionId, now);
    return false;
  }
  return now - since >= SHELL_CONFIRM_MS;
}

/**
 * Apply the full marker-clear policy for one PTY metadata observation.
 * Suppressed observations are deliberately recorded as "not a plain shell"
 * so an old confirmation window cannot survive a known-live waiting state.
 */
export function confirmAgentSessionClear(
  sessionId: string,
  processIsShell: boolean | undefined,
  agentActive: boolean,
  clearSuppressed: boolean,
  now: number = Date.now(),
): boolean {
  return confirmShellObservation(
    sessionId,
    Boolean(processIsShell) && !agentActive && !clearSuppressed,
    now,
  );
}

/** Drop tracking state for a closed session. */
export function resetShellObservation(sessionId: string): void {
  shellSince.delete(sessionId);
}
