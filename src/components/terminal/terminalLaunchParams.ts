/**
 * PTY launch parameters for a terminal session, plus the pure mapping onto the
 * createSession() argument shape.
 *
 * Why this exists (B-1 stale closure):
 * XTermWrapper's terminal effect is deliberately keyed on [sessionId] only — it
 * must NOT re-run when launch parameters change, because re-running disposes and
 * respawns the terminal. But the effect attaches the PTY asynchronously, and
 * TerminalPane recomputes `launchEnv` / `args` when the saved agent session for
 * the tab resolves after mount (the agent-session-mapping IPC in App.tsx races
 * the first render of the pane). Reading the props straight out of the effect
 * closure freezes them at mount time, so a resume that resolves during the
 * attach window silently degrades `claude --resume` to a fresh session.
 *
 * The fix is a latest-value ref: the effect keeps its [sessionId] deps, but the
 * launch-time reads go through a ref that every render refreshes, so the values
 * handed to the backend are the freshest ones that exist at the moment the PTY
 * is actually spawned.
 */
export interface TerminalLaunchParams {
  command: string;
  args: string[];
  cwd?: string;
  launchEnv?: Record<string, string>;
  restoreFallbackSessionIds?: string[];
}

export interface TerminalLaunchRequest {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  restoreFallbackSessionIds?: string[];
}

/**
 * Map the current launch parameters onto the createSession() arguments.
 * Pure by design so the "uses the latest values" behavior is unit-testable
 * without mounting a terminal.
 */
export function buildLaunchRequest(params: TerminalLaunchParams): TerminalLaunchRequest {
  return {
    command: params.command,
    args: params.args ?? [],
    cwd: params.cwd,
    // Historical behavior: an absent env is sent as undefined (backend treats it
    // as "no frontend env"); an empty object is still forwarded as-is.
    env: params.launchEnv || undefined,
    restoreFallbackSessionIds: params.restoreFallbackSessionIds,
  };
}
