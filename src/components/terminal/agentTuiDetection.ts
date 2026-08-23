/**
 * Which panes start life inside a full-screen TUI that owns the mouse.
 *
 * The wheel path needs this before the terminal has produced any output: an
 * agent pane must forward wheel events to the application, and stay eligible
 * for TUI redraw recovery, instead of scrolling its own scrollback.
 */

/**
 * Every agent kind mycmux launches runs such a TUI. Kept as one list so a new
 * kind cannot be wired into the launcher while the wheel path keeps treating
 * its pane as a plain shell - which is what happened to grok between its
 * 2026-08-15 registration and 2026-08-23.
 */
export const AGENT_TUI_KINDS: ReadonlySet<string> = new Set([
  "claude",
  "codex",
  "claude-codex",
  "grok",
]);

/**
 * "claude-codex" is a launcher target, never a binary on disk, so command and
 * argument names are matched against the executables only.
 */
export const AGENT_TUI_COMMAND_NAMES: ReadonlySet<string> = new Set([
  "claude",
  "codex",
  "grok",
]);

export function getCommandName(command: string): string {
  return command
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.(exe|cmd|bat|com)$/i, "")
    .toLowerCase() ?? "";
}

export function startsAsAgentTui(
  command: string,
  args: string[],
  agentId?: string,
  agentKind?: string,
  launchEnv?: Record<string, string>,
): boolean {
  if (agentKind !== undefined && AGENT_TUI_KINDS.has(agentKind)) return true;
  if (agentId !== undefined && AGENT_TUI_KINDS.has(agentId)) return true;
  const launchKind = launchEnv?.MYCMUX_AGENT_KIND;
  const launchResume = launchEnv?.MYCMUX_RESUME;
  if (launchKind !== undefined && AGENT_TUI_KINDS.has(launchKind)) return true;
  if (launchResume !== undefined && AGENT_TUI_KINDS.has(launchResume)) return true;
  if (AGENT_TUI_COMMAND_NAMES.has(getCommandName(command))) return true;
  return args.some((arg) => AGENT_TUI_COMMAND_NAMES.has(getCommandName(arg)));
}
