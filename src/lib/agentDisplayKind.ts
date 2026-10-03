export type DisplayAgentKind = "claude" | "codex" | "claude-codex" | "grok" | "antigravity" | "hermes" | "omp";

export const COMMAND_DISPLAY_KINDS: Record<string, DisplayAgentKind> = {
  agy: "antigravity",
  claude: "claude",
  codex: "codex",
  grok: "grok",
  // Hermes is launched by full path (hermes.exe), so the basename is what
  // identifies it here -- the launchers set no MYCMUX_AGENT_KIND for it.
  hermes: "hermes",
  omp: "omp",
};

/**
 * Launch targets whose catalog row carries no `agentKind`, so a pane started
 * from the launcher menu has nothing else to identify it by: the PTY's own
 * command is the launcher shell, and Rust's process detection only knows the
 * four session kinds. `MYCMUX_LAUNCH_TARGET` is what the launcher dispatched
 * on, and the tab keeps it in `launchEnv`.
 */
export const LAUNCH_TARGET_DISPLAY_KINDS: Record<string, DisplayAgentKind> = {
  agy: "antigravity",
  hermes: "hermes",
  omp: "omp",
};

/** Recognize only display kinds; unknown persisted strings are not evidence. */
export function normalizeDisplayAgentKind(kind: string | null | undefined): DisplayAgentKind | null {
  if (kind === "agy") return "antigravity";
  return kind === "claude" || kind === "codex" || kind === "claude-codex"
    || kind === "grok" || kind === "antigravity" || kind === "hermes" || kind === "omp"
    ? kind : null;
}

export function resolveDisplayAgentKind(
  agentKind: string | null | undefined,
  commandArgv?: readonly string[] | null,
  launchTarget?: string | null,
): DisplayAgentKind | null {
  const knownKind = normalizeDisplayAgentKind(agentKind);
  if (knownKind) return knownKind;

  const command = commandArgv?.[0]
    ?.replace(/^.*[\\/]/, "")
    .replace(/\.exe$/i, "")
    .toLowerCase();
  const fromCommand = command && Object.prototype.hasOwnProperty.call(COMMAND_DISPLAY_KINDS, command)
    ? COMMAND_DISPLAY_KINDS[command] : null;
  if (fromCommand) return fromCommand;
  return launchTarget && Object.prototype.hasOwnProperty.call(LAUNCH_TARGET_DISPLAY_KINDS, launchTarget)
    ? LAUNCH_TARGET_DISPLAY_KINDS[launchTarget] : null;
}
