// Shared bounds for reading logical lines out of an xterm buffer.
//
// Two call sites depend on these producing identical results:
//   - XTermWrapper.getTerminalBufferLines  (live/cached renderer buffer)
//   - headlessBuffer.getBufferLines        (headless replay for background tabs)
//
// `pane.read` picks whichever path is available for a session, so the two must
// stay in lockstep — a socket client cannot tell which one served its request.
// They live here instead of being duplicated so tuning one cannot silently
// change the shape of the other.

/** How many buffer rows to scan per requested line before giving up. */
export const TERMINAL_SNAPSHOT_SCAN_MULTIPLIER = 4;

/** Cap on rows joined back into a single wrapped logical line. */
export const TERMINAL_SNAPSHOT_MAX_WRAPPED_LINES = 256;
