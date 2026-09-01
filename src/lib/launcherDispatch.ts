/**
 * A tab can identify as an agent while its first PTY process is the launcher.
 * The launcher owns session IDs and pane-session mappings, so target, handoff,
 * and resume environments must not be started by the agent executable directly.
 */
export function requiresLauncherDispatch(
  launchEnv: Record<string, string> | undefined,
): boolean {
  return Boolean(
    launchEnv?.MYCMUX_LAUNCH_TARGET
    || launchEnv?.MYCMUX_RESUME
    || launchEnv?.MYCMUX_HANDOFF,
  );
}
