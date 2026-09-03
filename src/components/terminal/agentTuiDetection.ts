/**
 * Which panes start life inside a full-screen TUI that owns the mouse.
 *
 * The wheel path needs this before the terminal has produced any output: an
 * agent pane must forward wheel events to the application, and stay eligible
 * for TUI redraw recovery, instead of scrolling its own scrollback.
 */
import { LAUNCHABLE_AGENTS } from "../../lib/agentCatalog";

/**
 * Every agent kind mycmux launches runs such a TUI. Kept as one list so a new
 * kind cannot be wired into the launcher while the wheel path keeps treating
 * its pane as a plain shell - which is what happened to grok between its
 * 2026-08-15 registration and 2026-08-23, and to agy until 2026-09-03.
 *
 * agy is absent because it is not an `AgentSessionKind` yet; it is recognised
 * through its command name and its launcher target below.
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
  "agy",
]);

/**
 * Launcher targets that land in an agent TUI, derived from the catalog rather
 * than restated, so a new row cannot reach the launcher while the wheel path
 * still sees a shell. Web rows are excluded by `LAUNCHABLE_AGENTS` (they open a
 * webview, not a PTY) and "shell" is not in the catalog at all.
 *
 * This is the signal that covers a pane started from the launcher menu or the
 * New Workspace dialog: those spawn a shell that dispatches on the target, so
 * neither the command name nor `MYCMUX_AGENT_KIND` identifies the agent.
 */
export const AGENT_TUI_LAUNCH_TARGETS: ReadonlySet<string> = new Set(
  LAUNCHABLE_AGENTS.map((entry) => entry.target),
);

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
  const launchTarget = launchEnv?.MYCMUX_LAUNCH_TARGET;
  if (launchKind !== undefined && AGENT_TUI_KINDS.has(launchKind)) return true;
  if (launchResume !== undefined && AGENT_TUI_KINDS.has(launchResume)) return true;
  if (launchTarget !== undefined && AGENT_TUI_LAUNCH_TARGETS.has(launchTarget)) return true;
  if (AGENT_TUI_COMMAND_NAMES.has(getCommandName(command))) return true;
  return args.some((arg) => AGENT_TUI_COMMAND_NAMES.has(getCommandName(arg)));
}
